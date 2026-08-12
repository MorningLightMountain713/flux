'use strict';

const config = require('config');
const serviceHelper = require('../serviceHelper');
const generalService = require('../generalService');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const networkStateService = require('../networkStateService');
const registryManager = require('../appDatabase/registryManager');
const { selectCommittee } = require('../utils/committeeSelector');
const { extractIp, extractPort } = require('../utils/socketAddressUtils');
const { nowMs } = require('../utils/monotonicClock');
const messageStore = require('../appMessaging/messageStore');
const signedEnvelope = require('./signedEnvelope');
const rosterOverlay = require('./rosterOverlay');
const core = require('./grantClientCore');
const masterleasePublisher = require('./masterleasePublisher');
const log = require('../../lib/log');

// The candidate's half of the grant plane: acquire a grant, hold it by
// renewal, and answer for it to the peers whose own safety arithmetic
// depends on this node telling the truth.
//
// Three §7 rules shape everything here beyond the two-phase form itself:
//
//   RENEWALS ARE TRANSPORT-AGNOSTIC. A renewal is a signed monotonic
//   assertion, so ANY holder of the app may carry it and bring back the
//   acks. The master's own path to the committee is load-bearing for
//   nothing: direct asks first, and every member that did not answer is
//   retried through each standby until someone delivers.
//
//   COMMITTEE-DOWN ALONE NEVER STOPS THE APP. When no renewal path exists
//   at all, the holder coasts — but only on the unanimous word of every
//   standby that no takeover is possible (they cannot reach quorum, they
//   hold nothing, they are acquiring nothing). One silent standby is a
//   possible challenger and the coast ends.
//
//   THE DEADLINE IS ARITHMETIC, NOT A GUESS. A challenger's earliest grant
//   is the grantor-side expiry plus the lock-delay, and the grantor's expiry
//   for each ack is never earlier than this node's send instant for it. So
//   demotion at safeUntil + slack, with slack strictly less than the
//   lock-delay, stops the container before any challenger can be seated —
//   with the gap between them exceeding the real container stop time.
//
// The Holder takes an injectable clock and scheduler so every timing rule
// above is testable as arithmetic; production passes nothing and gets the
// monotonic clock and setTimeout.

function renewIntervalMs() {
  return config.fluxapps.quorumGrantRenewIntervalMs ?? 20_000;
}

function defaultTtlMs() {
  return config.fluxapps.quorumGrantHeldTtlMs ?? 150_000;
}

function demotionSlackMs() {
  // must stay below the grantors' lock-delay by more than the container stop
  // time; both sides of that inequality are config, so the build-time values
  // are asserted together here rather than hoped about
  return config.fluxapps.quorumGrantDemotionSlackMs ?? 15_000;
}

function askTimeoutMs() {
  return config.fluxapps.quorumGrantAskTimeoutMs ?? 5_000;
}

function maxTtlMs() {
  return config.fluxapps.quorumGrantMaxTtlMs ?? 300_000;
}

function committeeSizeFor(mode) {
  if (mode === 'oneshot') return config.fluxapps.quorumGrantOneshotCommitteeSize ?? 9;
  // nine referees, majority five — the grantor side derives the same size
  return config.fluxapps.quorumGrantHeldCommitteeSize ?? 9;
}

/** Full jitter, the §7 mandate: dueling proposers are the expected case. */
function jitteredMs(baseMs) {
  return Math.floor(baseMs / 2 + Math.random() * baseMs);
}

function outpointOf(node) {
  return `${node.txhash}:${node.outidx}`;
}

function grantorUrl(node, path) {
  return `http://${extractIp(node.ip)}:${extractPort(node.ip)}${path}`;
}

// ---------------------------------------------------------------------------
// identity and committee resolution

async function selfIdentity() {
  const collateral = await generalService.obtainNodeCollateralInformation();
  const wif = await fluxNetworkHelper.getFluxNodePrivateKey();
  if (!collateral?.txhash || !wif) return null;
  return { outpoint: `${collateral.txhash}:${collateral.txindex}`, wif };
}

/**
 * The committee for a key at a fingerprint — the same walk the grantors run,
 * over the same named membership, or null when this node cannot rebuild it.
 *
 * Held committees are one deal of a generation-salted walk — the generation
 * is the owner's re-roll counter, resolved from the newest owner-signed
 * record this node has synced — read through the roster overlay: the
 * published record for the key may carry a chain of quorum-signed seat
 * changes, and after full verification against the named membership it
 * reshapes the walk's answer. This is how a challenger that never held the
 * grant still asks the HEALED committee rather than the dark seats the base
 * walk would hand it. The generation and chain ride along in the return so
 * every ask can carry them.
 */
async function committeeFor(key, mode, fingerprint) {
  const membership = networkStateService.membershipAt(fingerprint);
  if (!membership) return null;

  const generation = mode === 'held' ? await currentGeneration(key) : 0;
  const walkKey = mode === 'held'
    ? rosterOverlay.walkKeyFor(key, generation)
    : `quorumgrant|${key}`;
  const committee = selectCommittee(membership, walkKey, { size: committeeSizeFor(mode) });
  if (committee.refusal) return null;

  let { members } = committee;
  let chain = [];
  if (mode === 'held') {
    const appName = key.slice(0, key.indexOf('/'));
    const role = key.slice(key.indexOf('/') + 1);
    const published = await readMasterleaseRoster(appName, role);
    if (published
      && published.fingerprint === fingerprint
      && published.generation === generation
      && published.chain.length) {
      const verified = rosterOverlay.verifyChain(
        membership, key, fingerprint, generation, committeeSizeFor(mode), published.chain,
      );
      if (verified) {
        ({ members } = verified);
        ({ chain } = published);
      }
    }
  }

  return {
    members, quorum: committee.quorum, fingerprint, generation, chain,
  };
}

/**
 * The current generation for a key: the newest owner-signed record on the
 * event plane as this node has synced it, 0 when the owner never re-rolled.
 */
async function currentGeneration(key) {
  try {
    const slash = key.indexOf('/');
    const record = await messageStore.getGrantGenerationRecord(key.slice(0, slash), key.slice(slash + 1));
    return record?.data?.generation ?? 0;
  } catch (error) {
    return 0;
  }
}

/**
 * The roster chain the published record carries for a key, with the basis it
 * binds to — or null. A read, never a verification: the caller verifies
 * against the membership it resolved.
 */
async function readMasterleaseRoster(appName, role) {
  try {
    const record = await messageStore.getMasterleaseRecord(appName, role);
    const data = record?.data;
    if (!data || typeof data.fingerprint !== 'string') return null;
    if (!Array.isArray(data.roster?.chain)) return null;
    return {
      fingerprint: data.fingerprint,
      generation: data.generation ?? 0,
      chain: data.roster.chain,
    };
  } catch (error) {
    return null;
  }
}

/**
 * The app's other holders — the relay carriers and the witness set — from
 * this node's own locations view.
 */
async function standbysFor(key, selfOutpoint) {
  const appName = key.slice(0, key.indexOf('/'));
  const rows = await registryManager.appLocation(appName);
  const membership = networkStateService.membershipAt(networkStateService.membershipFingerprint()) ?? [];
  const byHost = new Map();
  membership.forEach((node) => byHost.set(extractIp(node.ip), node));

  const standbys = [];
  (rows || []).forEach((row) => {
    const node = byHost.get(extractIp(row.ip));
    if (node && outpointOf(node) !== selfOutpoint) standbys.push(node);
  });
  return standbys;
}

// ---------------------------------------------------------------------------
// transport

/**
 * One signed ask to one grantor. Null when the member did not answer — the
 * caller's quorum arithmetic treats silence as silence, never as a no.
 */
async function askGrantor(member, type, ask, signature) {
  try {
    const response = await serviceHelper.axiosPost(
      grantorUrl(member, `/flux/quorumgrant/${type}`),
      { ...ask, signature },
      { timeout: askTimeoutMs() },
    );
    return response?.data?.data ?? null;
  } catch (error) {
    return null;
  }
}

/**
 * Ask every committee member directly. One signature serves all of them —
 * the payload never names the member.
 * @returns {Map<string, object>} outpoint -> reply, silent members absent
 */
async function askCommittee(members, type, ask, signature) {
  const asks = members.map(async (member) => {
    const reply = await askGrantor(member, type, ask, signature);
    return { member, reply };
  });
  const settled = await Promise.all(asks);
  const replies = new Map();
  settled.forEach(({ member, reply }) => {
    if (reply) replies.set(outpointOf(member), reply);
  });
  return replies;
}

/**
 * Carry a signed ask to the members that did not answer directly, through
 * each standby in turn until every member has answered or the carriers are
 * exhausted. The standby cannot alter what it carries — the envelope is
 * end-to-end — so the worst a carrier can do is not deliver.
 */
async function relayThroughStandbys(standbys, members, type, ask, signature, have) {
  const replies = new Map(have);
  for (let i = 0; i < standbys.length; i += 1) {
    const missing = members.filter((member) => !replies.has(outpointOf(member)));
    if (!missing.length) return replies;
    try {
      // eslint-disable-next-line no-await-in-loop -- carriers are tried in
      // sequence on purpose: each round shrinks the missing set, and asking
      // every standby to flood every member is the amplification this path
      // must not become
      const response = await serviceHelper.axiosPost(
        grantorUrl(standbys[i], '/flux/quorumgrant/relay'),
        { type, ask, signature },
        { timeout: askTimeoutMs() * 2 },
      );
      const carried = response?.data?.data?.replies ?? [];
      carried.forEach((entry) => {
        if (entry?.member && entry?.reply && !replies.has(entry.member)) {
          replies.set(entry.member, entry.reply);
        }
      });
    } catch (error) {
      // a carrier that failed is just a carrier that failed
    }
  }
  return replies;
}

async function signedAskFor(type, key, mode, epoch, identity, basis, extras = {}) {
  const ask = {
    key,
    mode,
    epoch,
    candidate: identity.outpoint,
    generation: basis.generation ?? 0,
    fingerprint: basis.fingerprint,
    at: Date.now(),
    ...extras,
  };
  const fields = signedEnvelope.fieldsFor(type, ask);
  const signed = signedEnvelope.sign(type, fields, identity.wif);
  if (!signed) return null;
  return { ask, signature: signed.signature };
}

// ---------------------------------------------------------------------------
// the registries the witness answers from

const held = new Map(); // key -> Holder
const acquiring = new Set(); // keys with an acquisition in flight

// ---------------------------------------------------------------------------
// acquisition

/**
 * One acquisition pass: probe (held mode), prepare, adopt, accept. Retry
 * policy belongs to the CONSUMER — this returns a rich outcome and never
 * loops on its own, so a caller cannot be surprised by how long it took.
 *
 * @param {string} key resource key
 * @param {object} options {mode, ttlMs, fingerprint, onDemoted, clock, schedule}
 * @returns {Promise<object>} one of:
 *   {granted: true, holder}                       — held and renewing (held mode)
 *   {granted: true, founder}                      — this node founded (oneshot)
 *   {granted: false, founder}                     — founded by another (oneshot)
 *   {granted: false, incumbent}                   — a live term shields (held)
 *   {granted: false, retryAfterMs}                — lock-delay taught a wait
 *   {granted: false, reason}                      — anything else, named
 */
async function acquire(key, options = {}) {
  const mode = options.mode ?? 'held';
  const ttlMs = options.ttlMs ?? defaultTtlMs();

  if (held.has(key)) return { granted: true, holder: held.get(key) };
  if (acquiring.has(key)) return { granted: false, reason: 'acquisition already in flight' };

  const identity = await selfIdentity();
  if (!identity) return { granted: false, reason: 'node identity unavailable' };

  const fingerprint = options.fingerprint ?? networkStateService.membershipFingerprint();
  const committee = await committeeFor(key, mode, fingerprint);
  if (!committee) return { granted: false, reason: 'committee unavailable for fingerprint' };

  acquiring.add(key);
  try {
    return await acquireOnce(key, mode, ttlMs, identity, committee, options);
  } finally {
    acquiring.delete(key);
  }
}

async function acquireOnce(key, mode, ttlMs, identity, committee, options) {
  const { members, quorum } = committee;
  // a healed committee's chain rides every ask, so a grantor seated by it —
  // whose register may be empty — can prove to itself that it belongs
  const chainExtras = committee.chain?.length ? { chain: committee.chain } : {};

  // Pre-vote: learn without burning an epoch. A live incumbent means the
  // answer is "not you, not now" and a correct challenger walks away.
  const probeSigned = await signedAskFor('probe', key, mode, 1, identity, committee, chainExtras);
  if (!probeSigned) return { granted: false, reason: 'could not sign ask' };
  const probeReplies = await askCommittee(members, 'probe', probeSigned.ask, probeSigned.signature);

  const shield = [...probeReplies.values()].find(
    (reply) => reply?.code === 'incumbent_active' && reply?.accepted?.grantee !== identity.outpoint,
  );
  if (mode === 'held' && shield) {
    return { granted: false, incumbent: shield.accepted };
  }

  const probeOutcome = core.prepareOutcome([...probeReplies.values()], quorum);
  if (probeOutcome.retryAfterMs > 0) {
    return { granted: false, retryAfterMs: probeOutcome.retryAfterMs };
  }

  // Prepare at one past everything the probe taught.
  const epoch = core.nextEpoch(probeOutcome.highestEpoch);
  const prepareSigned = await signedAskFor('prepare', key, mode, epoch, identity, committee, chainExtras);
  const prepareReplies = await askCommittee(members, 'prepare', prepareSigned.ask, prepareSigned.signature);
  const prepared = core.prepareOutcome([...prepareReplies.values()], quorum);

  if (!prepared.promised) {
    if (prepared.retryAfterMs > 0) return { granted: false, retryAfterMs: prepared.retryAfterMs };
    return { granted: false, reason: 'no prepare quorum', highestEpoch: prepared.highestEpoch };
  }

  // Adoption: a recorded value is the answer, not an opponent.
  if (mode === 'oneshot' && prepared.adopt) {
    if (prepared.adopt.grantee !== identity.outpoint) {
      return { granted: false, founder: prepared.adopt.grantee };
    }
    // our own earlier founding, learned again — fall through and re-accept
  }

  const acceptSigned = await signedAskFor('accept', key, mode, epoch, identity, committee, {
    ttlMs: mode === 'held' ? ttlMs : undefined,
    ...chainExtras,
  });
  const sentMs = (options.clock ?? nowMs)();
  const acceptReplies = await askCommittee(members, 'accept', acceptSigned.ask, acceptSigned.signature);
  const accepted = core.acceptOutcome([...acceptReplies.values()], quorum);

  if (!accepted.granted) {
    return { granted: false, reason: 'no accept quorum', highestEpoch: accepted.highestEpoch };
  }

  if (mode === 'oneshot') {
    // §4 step 4: the winner publishes. For a founding this record is what a
    // re-pinned committee adopts months later — durable, no expiry.
    await masterleasePublisher.publishMasterlease({
      key,
      grantee: identity.outpoint,
      epoch,
      mode,
      fingerprint: committee.fingerprint,
      generation: committee.generation,
    });
    return { granted: true, founder: identity.outpoint };
  }

  const holder = new Holder({
    key,
    epoch,
    ttlMs,
    identity,
    committee,
    onDemoted: options.onDemoted,
    clock: options.clock,
    schedule: options.schedule,
  });
  acceptReplies.forEach((reply, outpoint) => {
    if (reply?.ok) holder.recordAck(outpoint, sentMs);
  });
  held.set(key, holder);
  await holder.publishRecord();
  holder.start();
  // Who this grant superseded, when it superseded anyone: the recorded
  // grantee the prepare round taught. The consumer's peer fence is built
  // from exactly this name — never from a guess about who used to run.
  const deposed = prepared.adopt && prepared.adopt.grantee !== identity.outpoint
    ? prepared.adopt.grantee
    : null;
  return { granted: true, holder, deposed };
}

// ---------------------------------------------------------------------------
// the holder

class Holder {
  #key;

  #epoch;

  #ttlMs;

  #identity;

  #committee;

  #acks = new Map(); // grantor outpoint -> sentMs of its latest ack

  #lastAnswerMs = new Map(); // grantor outpoint -> last instant it answered anything

  #lastHealMs = null;

  #state = 'held';

  #coasting = false;

  #stopped = false;

  #timer = null;

  #onDemoted;

  #clock;

  #schedule;

  #cancel;

  #lastPublishMs = null;

  constructor(options) {
    this.#key = options.key;
    this.#epoch = options.epoch;
    this.#ttlMs = options.ttlMs;
    this.#identity = options.identity;
    this.#committee = options.committee;
    this.#committee.chain = this.#committee.chain ?? [];
    this.#committee.generation = this.#committee.generation ?? 0;
    this.#onDemoted = options.onDemoted ?? null;
    this.#clock = options.clock ?? nowMs;
    this.#schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.#cancel = options.cancel ?? ((handle) => clearTimeout(handle));
    // every referee starts with a full term of grace before it can be judged
    // dark — a committee is never reshaped on the strength of a fresh start
    this.#committee.members.forEach(
      (member) => this.#lastAnswerMs.set(outpointOf(member), this.#clock()),
    );
  }

  get key() {
    return this.#key;
  }

  get epoch() {
    return this.#epoch;
  }

  get state() {
    return this.#state;
  }

  get coasting() {
    return this.#coasting;
  }

  recordAck(grantorOutpoint, sentMs) {
    this.#acks.set(grantorOutpoint, sentMs);
  }

  /** The median rule over the latest ack per grantor. */
  safeUntil() {
    const acks = [...this.#acks.values()].map((sentMs) => ({ sentMs, ttlMs: this.#ttlMs }));
    return core.safeUntilMs(acks, this.#committee.quorum);
  }

  /**
   * Publish this term's record. The row expires at the grant duration, so a
   * live holder re-publishes at half of it — an abandoned term's record ages
   * out on its own, and readers never see a master nobody is renewing. The
   * roster chain rides the record: it is how everyone who never saw a heal
   * happen — challengers, standbys, freshly seated grantors — learns the
   * committee as it now stands.
   */
  async publishRecord() {
    this.#lastPublishMs = this.#clock();
    await masterleasePublisher.publishMasterlease({
      key: this.#key,
      grantee: this.#identity.outpoint,
      epoch: this.#epoch,
      mode: 'held',
      fingerprint: this.#committee.fingerprint,
      generation: this.#committee.generation,
      ttlMs: this.#ttlMs,
      ...(this.#committee.chain.length ? { roster: { chain: this.#committee.chain } } : {}),
    });
  }

  start() {
    this.#loop();
  }

  #loop() {
    if (this.#stopped) return;
    this.#timer = this.#schedule(async () => {
      try {
        await this.renewOnce();
      } catch (error) {
        log.error(`quorumGrant holder ${this.#key}: ${error.message}`);
      }
      this.#loop();
    }, jitteredMs(renewIntervalMs()));
  }

  /**
   * One renewal pass: direct asks, relay for the silent members, then the
   * safety arithmetic — and when the arithmetic says jeopardy, the witness
   * poll decides between coasting and the deadline.
   */
  async renewOnce() {
    if (this.#stopped) return;

    const signed = await signedAskFor(
      'renew',
      this.#key,
      'held',
      this.#epoch,
      this.#identity,
      this.#committee,
      {
        ttlMs: this.#ttlMs,
        ...(this.#committee.chain.length ? { chain: this.#committee.chain } : {}),
      },
    );
    if (!signed) return;

    const sentMs = this.#clock();
    const direct = await askCommittee(this.#committee.members, 'renew', signed.ask, signed.signature);

    let replies = direct;
    if (direct.size < this.#committee.members.length) {
      const standbys = await standbysFor(this.#key, this.#identity.outpoint);
      replies = await relayThroughStandbys(
        standbys,
        this.#committee.members,
        'renew',
        signed.ask,
        signed.signature,
        direct,
      );
    }

    let renewed = 0;
    replies.forEach((reply, outpoint) => {
      // any reply at all — a grant, a refusal — is a referee that answers;
      // dark means answering nobody, directly or through any carrier
      this.#lastAnswerMs.set(outpoint, sentMs);
      if (reply?.ok && reply.renewed) {
        this.recordAck(outpoint, sentMs);
        renewed += 1;
      } else if (reply?.code === 'not_grantee' || reply?.code === 'no_grant' || reply?.code === 'lapsed') {
        // this grantor no longer counts toward safety; its old ack must not
        // linger as if it did
        this.#acks.delete(outpoint);
      }
    });

    // A reply teaching a higher epoch than ours means a successor exists:
    // not jeopardy — deposed. Stop immediately.
    const taught = core.highestEpochSeen([...replies.values()]);
    if (taught > this.#epoch) {
      this.#demote(`a grant at epoch ${taught} supersedes ours at ${this.#epoch}`);
      return;
    }

    await this.#assess(renewed >= this.#committee.quorum);

    if (this.#state === 'held' && this.#clock() - this.#lastPublishMs > this.#ttlMs / 2) {
      await this.publishRecord();
    }

    await this.#maybeHeal();
  }

  /**
   * One heal attempt per rate window: when a referee has answered nothing —
   * grant or refusal, direct or relayed — for a full term, propose replacing
   * it with the walk's forced next seat, to the committee as it stands. A
   * quorum of signed acceptances installs the entry; anything less changes
   * nothing and waits out the window. Healing runs only from a held,
   * non-coasting term: reshaping a committee is a healthy holder's chore,
   * never a crisis measure.
   */
  async #maybeHeal() {
    if (this.#stopped || this.#state !== 'held' || this.#coasting) return;
    const now = this.#clock();
    if (this.#lastHealMs !== null && now - this.#lastHealMs < maxTtlMs()) return;

    const dark = this.#committee.members.filter(
      (member) => now - (this.#lastAnswerMs.get(outpointOf(member)) ?? now) > this.#ttlMs,
    );
    if (!dark.length) return;
    this.#lastHealMs = now;

    const membership = networkStateService.membershipAt(this.#committee.fingerprint);
    if (!membership) return;

    const target = dark[0];
    const targetOutpoint = outpointOf(target);
    const survivors = this.#committee.members.filter((member) => member !== target);
    const excluded = new Set(this.#committee.chain.map((entry) => entry.remove));
    excluded.add(targetOutpoint);
    const expected = rosterOverlay.nextReplacement(
      membership, rosterOverlay.walkKeyFor(this.#key, this.#committee.generation), survivors, excluded,
    );
    if (!expected) return;

    const seq = this.#committee.chain.length + 1;
    const signed = await signedAskFor(
      'roster',
      this.#key,
      'held',
      this.#epoch,
      this.#identity,
      this.#committee,
      {
        remove: targetOutpoint,
        add: outpointOf(expected),
        seq,
        ...(this.#committee.chain.length ? { chain: this.#committee.chain } : {}),
      },
    );
    if (!signed) return;

    const direct = await askCommittee(this.#committee.members, 'roster', signed.ask, signed.signature);
    let replies = direct;
    if (direct.size < this.#committee.members.length) {
      const standbys = await standbysFor(this.#key, this.#identity.outpoint);
      replies = await relayThroughStandbys(
        standbys, this.#committee.members, 'roster', signed.ask, signed.signature, direct,
      );
    }

    // Count only acceptances that verify against the signer's registered
    // key and come from the committee being asked — the assembled entry is
    // published as proof, and proof assembled from unchecked claims is not.
    const entry = {
      seq, remove: targetOutpoint, add: outpointOf(expected), at: signed.ask.at, acceptances: [],
    };
    const preChange = new Map(this.#committee.members.map((member) => [outpointOf(member), member]));
    replies.forEach((reply, outpoint) => {
      const acceptance = reply?.ok ? reply.acceptance : null;
      if (!acceptance || acceptance.grantor !== outpoint) return;
      const signer = preChange.get(acceptance.grantor);
      if (!signer) return;
      const fields = signedEnvelope.fieldsFor('rosteraccept', {
        key: this.#key,
        fingerprint: this.#committee.fingerprint,
        generation: this.#committee.generation,
        seq,
        remove: entry.remove,
        add: entry.add,
      });
      if (!signedEnvelope.verify('rosteraccept', fields, acceptance.signature, signer.pubkey)) return;
      entry.acceptances.push({ grantor: acceptance.grantor, signature: acceptance.signature });
    });
    if (entry.acceptances.length < this.#committee.quorum) return;

    this.#committee.chain.push(entry);
    this.#committee.members = [...survivors, expected];
    this.#acks.delete(targetOutpoint);
    this.#lastAnswerMs.delete(targetOutpoint);
    this.#lastAnswerMs.set(entry.add, now);
    log.info(`quorumGrant holder ${this.#key}: roster healed — ${targetOutpoint} out, ${entry.add} in`);

    await this.publishRecord();
    await this.#seedAddedGrantor(expected);
  }

  /**
   * Hand the freshly seated grantor the grant it now referees: an accept at
   * the current epoch, carrying the chain that seats it. Until this lands
   * (or a later renewal does the same job) the new seat answers refusals,
   * which the safety arithmetic already treats as absence.
   */
  async #seedAddedGrantor(added) {
    const signed = await signedAskFor(
      'accept',
      this.#key,
      'held',
      this.#epoch,
      this.#identity,
      this.#committee,
      { ttlMs: this.#ttlMs, chain: this.#committee.chain },
    );
    if (!signed) return;
    const sentMs = this.#clock();
    const reply = await askGrantor(added, 'accept', signed.ask, signed.signature);
    if (reply?.ok && reply.accepted) this.recordAck(outpointOf(added), sentMs);
  }

  async #assess(quorumRenewed) {
    const now = this.#clock();
    const safeUntil = this.safeUntil();

    if (quorumRenewed) {
      this.#state = 'held';
      this.#coasting = false;
      return;
    }

    // No quorum this pass. Safe while the median says so; past it, the
    // witness rule decides.
    if (safeUntil !== null && now <= safeUntil) {
      this.#state = 'jeopardy';
      return;
    }

    const standbys = await standbysFor(this.#key, this.#identity.outpoint);
    const witnessReplies = await pollWitnesses(standbys, this.#key);
    const verdict = core.coastVerdict(standbys.map(outpointOf), witnessReplies);

    if (verdict.coast) {
      this.#state = 'jeopardy';
      this.#coasting = true;
      return;
    }

    const demotionAt = (safeUntil ?? now) + demotionSlackMs();
    if (now > demotionAt) {
      this.#demote(verdict.reason ?? 'renewal quorum lost past the deadline');
    } else {
      this.#state = 'jeopardy';
      this.#coasting = false;
    }
  }

  #demote(reason) {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#state = 'lost';
    this.#coasting = false;
    if (this.#timer !== null) this.#cancel(this.#timer);
    held.delete(this.#key);
    log.warn(`quorumGrant holder ${this.#key}: demoted — ${reason}`);
    if (this.#onDemoted) this.#onDemoted(reason);
  }

  /** Stop locally: end the loop and the registry entry, no wire traffic. */
  stop() {
    this.#stopped = true;
    if (this.#timer !== null) this.#cancel(this.#timer);
    held.delete(this.#key);
    this.#state = 'lost';
  }

  /** Voluntary release: end the term everywhere, no lock-delay for successors. */
  async release() {
    this.stop();
    const signed = await signedAskFor(
      'release',
      this.#key,
      'held',
      this.#epoch,
      this.#identity,
      this.#committee,
    );
    if (signed) {
      await askCommittee(this.#committee.members, 'release', signed.ask, signed.signature);
    }
  }
}

// ---------------------------------------------------------------------------
// what this node answers its peers

/**
 * The witness answer for a key: what THIS node is doing about it, plus a
 * live reachability check toward the key's committee — record reads, cheap
 * and unauthenticated, because the question is "could you be granted", and
 * reaching a quorum of grantors is its observable half.
 */
async function witnessAnswer(key, mode = 'held') {
  const holding = held.has(key);
  const isAcquiring = acquiring.has(key);

  let quorumReachable = false;
  const fingerprint = networkStateService.membershipFingerprint();
  const committee = fingerprint ? await committeeFor(key, mode, fingerprint) : null;
  if (committee) {
    const probes = committee.members.map(async (member) => {
      try {
        const response = await serviceHelper.axiosGet(
          grantorUrl(member, `/flux/quorumgrant/record?key=${encodeURIComponent(key)}`),
          { timeout: askTimeoutMs() },
        );
        return response?.data?.status === 'success';
      } catch (error) {
        return false;
      }
    });
    const answers = await Promise.all(probes);
    quorumReachable = answers.filter(Boolean).length >= committee.quorum;
  }

  return { holding, acquiring: isAcquiring, quorumReachable };
}

/**
 * Carry one signed ask to the committee for its key — the relay's service
 * half. The carrier computes the committee ITSELF from the ask it carries;
 * a caller-supplied target list would make this an open proxy, and there is
 * no reason a legitimate holder would ever need to name one.
 */
async function carryAsk(type, ask, signature) {
  if (!signedEnvelope.TYPES.includes(type)) return { replies: [] };
  const committee = await committeeFor(ask.key, ask.mode ?? 'held', ask.fingerprint);
  if (!committee) return { replies: [] };

  // The ask may carry a chain newer than anything this carrier has seen
  // published — a heal that just happened. It is self-verifying, so honor
  // it: otherwise a freshly seated grantor reachable only through relays
  // would never hear a word.
  let { members } = committee;
  if (Array.isArray(ask.chain)
    && ask.chain.length > committee.chain.length
    && rosterOverlay.chainWellFormed(ask.chain)) {
    const membership = networkStateService.membershipAt(ask.fingerprint);
    const verified = membership
      ? rosterOverlay.verifyChain(
        membership, ask.key, ask.fingerprint, ask.generation ?? 0, committeeSizeFor(ask.mode ?? 'held'), ask.chain,
      )
      : null;
    if (verified) ({ members } = verified);
  }

  const replies = await askCommittee(members, type, ask, signature);
  const carried = [];
  replies.forEach((reply, member) => carried.push({ member, reply }));
  return { replies: carried };
}

/** Test seam: local teardown only — a reset must never reach the wire. */
function resetForTests() {
  [...held.values()].forEach(stopHolder);
  held.clear();
  acquiring.clear();
}

function stopHolder(holder) {
  holder.stop();
}

async function pollWitnesses(standbys, key) {
  const polls = standbys.map(async (standby) => {
    try {
      const response = await serviceHelper.axiosPost(
        grantorUrl(standby, '/flux/quorumgrant/witness'),
        { key },
        { timeout: askTimeoutMs() },
      );
      return { outpoint: outpointOf(standby), reply: response?.data?.data ?? null };
    } catch (error) {
      return { outpoint: outpointOf(standby), reply: null };
    }
  });
  const settled = await Promise.all(polls);
  const replies = new Map();
  settled.forEach(({ outpoint, reply }) => {
    if (reply) replies.set(outpoint, reply);
  });
  return replies;
}

/** The live Holder for a key on this node, or null. */
function holderFor(key) {
  return held.get(key) ?? null;
}

/** Whether an acquisition for the key is currently in flight. */
function isAcquiring(key) {
  return acquiring.has(key);
}

module.exports = {
  acquire,
  holderFor,
  isAcquiring,
  witnessAnswer,
  carryAsk,
  Holder,
  resetForTests,
};
