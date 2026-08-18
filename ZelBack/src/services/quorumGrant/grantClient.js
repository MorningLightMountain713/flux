'use strict';

const config = require('config');
const http = require('http');
const serviceHelper = require('../serviceHelper');
const generalService = require('../generalService');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const networkStateService = require('../networkStateService');
const registryManager = require('../appDatabase/registryManager');
const { selectCommittee } = require('../utils/committeeSelector');
const { extractIp, extractPort } = require('../utils/socketAddressUtils');
const { nowMs } = require('../utils/monotonicClock');
const fluxEventBus = require('../utils/fluxEventBus');
const messageStore = require('../appMessaging/messageStore');
const foundingCommittee = require('../appMesh/foundingCommittee');
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

// Consecutive renewal refusals from one cell before the repair chore treats
// it as answering-empty rather than transiently confused.
const REPAIR_AFTER_REFUSALS = 3;

function outpointOf(node) {
  return `${node.txhash}:${node.outidx}`;
}

function grantorUrl(node, path) {
  return `http://${extractIp(node.ip)}:${extractPort(node.ip)}${path}`;
}

// One warm socket per referee, shared by every ask type and every app on this
// node, lifecycle owned entirely by the HTTP layer. Free sockets are dropped
// at 60s idle — strictly below the API server's 65s keepAliveTimeout — so this
// side never reuses a socket the far side already closed. Renewals then cost a
// request/response on an open socket instead of a TCP handshake per round.
const askAgent = new http.Agent({ keepAlive: true, timeout: 60_000, maxFreeSockets: 64 });

// ---------------------------------------------------------------------------
// identity and committee resolution

async function selfIdentity() {
  const collateral = await generalService.obtainNodeCollateralInformation();
  const wif = await fluxNetworkHelper.getFluxNodePrivateKey();
  if (!collateral?.txhash || !wif) return null;
  return { outpoint: `${collateral.txhash}:${collateral.txindex}`, wif };
}

/**
 * The committee for a key at a fingerprint, or null when this node cannot
 * honestly resolve one at that basis.
 *
 * Oneshot keys are founder registers: their committee is the app's founding
 * committee, read from the materialized record with the same arithmetic the
 * grantors run — never a fresh walk over a membership list. The record is
 * the basis authority there, so the caller's fingerprint pins nothing: the
 * return names the basis the asks must carry, which is usually older than
 * the current list — the photo, not the album.
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
  if (mode === 'oneshot') {
    const role = key.slice(key.indexOf('/') + 1);
    const founderRole = /^founder-([a-f0-9]{16})@(\d{1,10})$/.exec(role);
    if (!founderRole) return null;
    // Component-blind, like the grantors: the committee keys on the anchor
    // the register names, and the token stays opaque.
    const founding = await foundingCommittee.refereeCommittee(
      key.slice(0, key.indexOf('/')), Number(founderRole[2]),
    );
    if (!founding) return null;
    return {
      members: founding.members,
      quorum: founding.quorum,
      fingerprint: founding.fingerprint,
      generation: founding.generation,
      anchor: founding.anchor,
      chain: [],
    };
  }

  const membership = networkStateService.membershipAt(fingerprint);
  if (!membership) return null;

  const generation = await currentGeneration(key);
  const walkKey = rosterOverlay.walkKeyFor(key, generation);
  const committee = selectCommittee(membership, walkKey, { size: committeeSizeFor('held') });
  if (committee.refusal) return null;

  let { members } = committee;
  let chain = [];
  const appName = key.slice(0, key.indexOf('/'));
  const role = key.slice(key.indexOf('/') + 1);
  const published = await readMasterleaseRoster(appName, role);
  if (published
    && published.fingerprint === fingerprint
    && published.generation === generation
    && published.chain.length) {
    const verified = rosterOverlay.verifyChain(
      membership, key, fingerprint, generation, committeeSizeFor('held'), published.chain,
    );
    if (verified) {
      ({ members } = verified);
      ({ chain } = published);
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
  // An empty answer has three distinct causes - no rows, no membership, or a
  // join that matched nothing - and the witness rule treats them all as "no
  // standbys", so say which one this was. publish() is a no-op outside the
  // harness.
  fluxEventBus.publish('quorumGrant:standbys', {
    key,
    rows: rows ? rows.length : null,
    membership: membership.length,
    matched: standbys.length,
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
      { timeout: askTimeoutMs(), httpAgent: askAgent },
    );
    return response?.data?.data ?? null;
  } catch (error) {
    // The grantor names why it refused and the reason dies in this catch —
    // outside the harness nothing observes it (publish() is a no-op), and a
    // refused ask and an unreachable grantor both come back null on purpose:
    // the quorum arithmetic treats silence as silence either way.
    fluxEventBus.publish('quorumGrant:askRefused', {
      type,
      member: outpointOf(member),
      status: error.response?.status ?? null,
      reason: error.response?.data?.data?.message ?? error.message ?? null,
    });
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
        { timeout: askTimeoutMs() * 2, httpAgent: askAgent },
      );
      const carried = response?.data?.data?.replies ?? [];
      carried.forEach((entry) => {
        if (entry?.member && entry?.reply && !replies.has(entry.member)) {
          replies.set(entry.member, entry.reply);
        }
      });
    } catch (error) {
      // a carrier that failed is just a carrier that failed — but say so:
      // the 1205 fight's relay leg was unreadable because this catch and
      // carryAsk's early-outs were both silent. publish() is a no-op
      // outside the harness.
      fluxEventBus.publish('quorumGrant:relayFailed', {
        type,
        carrier: outpointOf(standbys[i]),
        status: error.response?.status ?? null,
        reason: error.response?.data?.data?.message ?? error.message ?? null,
      });
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
 * @param {object} options {mode, ttlMs, fingerprint, committee, onDemoted,
 *   clock, schedule} — `committee` is an already-resolved
 *   {members, quorum, fingerprint, generation} basis used as given: the
 *   founding service resolves the committee ONCE to decide whether to ask
 *   at all, and handing that resolution in keeps the decision basis and the
 *   ask basis the same object — resolving twice could straddle an arriving
 *   generation record and ask a committee the decision never saw
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

  const committee = options.committee
    ?? await committeeFor(key, mode, options.fingerprint ?? networkStateService.membershipFingerprint());
  if (!committee) return { granted: false, reason: 'committee unavailable for fingerprint' };

  acquiring.add(key);
  try {
    return await acquireOnce(key, mode, ttlMs, identity, committee, options);
  } finally {
    acquiring.delete(key);
  }
}

/**
 * Whether a held term has PROVABLY lapsed — how a resting standby decides to
 * pursue. The published record is durable and only says who last held the
 * term; whether they still stand is asked of the referees. Deliberately not
 * an acquisition: no acquiring state is entered, because the witness vouch
 * must keep seeing a resting standby as pursuing nothing. Positive evidence
 * only — a live incumbent shield from any referee keeps the rest, and so
 * does total silence: pursuing on silence is what denied the coast vouch by
 * coin flip, and a standby that cannot reach the committee could not win an
 * acquisition anyway.
 */
async function termLapsed(key) {
  const identity = await selfIdentity();
  if (!identity) return false;
  const committee = await committeeFor(key, 'held', networkStateService.membershipFingerprint());
  if (!committee) return false;
  const chainExtras = committee.chain?.length ? { chain: committee.chain } : {};
  const signed = await signedAskFor('probe', key, 'held', 1, identity, committee, chainExtras);
  if (!signed) return false;
  const replies = await askCommittee(committee.members, 'probe', signed.ask, signed.signature);
  const shielded = [...replies.values()].some(
    (reply) => reply?.code === 'incumbent_active' && reply?.accepted?.grantee !== identity.outpoint,
  );
  const lapsed = replies.size > 0 && !shielded;
  fluxEventBus.publish('quorumGrant:restCheck', { key, replies: replies.size, lapsed });
  return lapsed;
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
    fluxEventBus.publish('quorumGrant:founded', { key, founder: identity.outpoint });
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
  fluxEventBus.publish('quorumGrant:granted', { key, epoch, generation: committee.generation ?? 0 });
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

  // grantor outpoint -> consecutive renewal REFUSALS (no_grant / not_grantee /
  // lapsed). Refusing is evidence and silence is not: a silent referee is the
  // heal chore's business, an answering-empty one is the repair chore's.
  #refusals = new Map();

  #lastRepairMs = null;

  #state = 'held';

  #coasting = false;

  #stopped = false;

  #timer = null;

  #onDemoted;

  #clock;

  #schedule;

  #cancel;

  // monotonic ms the standing demotion alarm fires at, null while a coast
  // stands. Armed from every successful renewal - the holder always KNOWS
  // its deadline in advance (last quorum of acks + ttl + slack) - so the
  // stop lands ON the deadline even when the pass cadence collapses, which
  // is exactly what a total isolation does to passes. A demotion noticed a
  // pass late is a second master: slack-below-lock-delay only holds if the
  // stop happens on time.
  #deadlineTargetMs = null;

  #demotionTimer = null;

  // the last coast-refusing reason, for the alarm's demotion message
  #lastDoubt = null;

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
   * Publish this term's record. Change-driven and durable until superseded:
   * it says WHO holds the term, never whether they still stand — liveness is
   * asked of the referees, not inferred from this row's age — so it is
   * published on acquisition and on a roster heal, and no timer republishes
   * it. The roster chain rides the record: it is how everyone who never saw
   * a heal happen — challengers, standbys, freshly seated grantors — learns
   * the committee as it now stands.
   */
  async publishRecord() {
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
    if (!signed) {
      // Without this, a signing failure is indistinguishable from a dead
      // renewal loop: both leave no assess events. publish() is a no-op
      // outside the harness.
      fluxEventBus.publish('quorumGrant:assess', { key: this.#key, outcome: 'askUnsigned' });
      return;
    }

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
        this.#refusals.delete(outpoint);
        renewed += 1;
      } else if (reply?.code === 'not_grantee' || reply?.code === 'no_grant' || reply?.code === 'lapsed') {
        // this grantor no longer counts toward safety; its old ack must not
        // linger as if it did
        this.#acks.delete(outpoint);
        this.#refusals.set(outpoint, (this.#refusals.get(outpoint) ?? 0) + 1);
      }
    });

    // A reply teaching a higher ACCEPTED grant by someone else means a
    // successor exists: not jeopardy — deposed. Stop immediately. A bare
    // promisedEpoch teaches nothing here: a promise binds the CELL (accept
    // nothing lower), never the incumbent — deposing on one is Raft's
    // documented disruptive-server defect, and it is how a residue promise
    // from the founding scramble deposed a healthy master on the 1205 fleet.
    // Our own grant at a higher epoch is a partial term refresh, converged by
    // the repair chore, never a successor.
    const successor = core.adoptFrom([...replies.values()]);
    if (successor && successor.epoch > this.#epoch
      && successor.grantee !== this.#identity.outpoint) {
      this.#demote(`a grant at epoch ${successor.epoch} supersedes ours at ${this.#epoch}`);
      return;
    }

    await this.#assess(renewed >= this.#committee.quorum);

    await this.#maybeHeal();

    await this.#maybeRepair();
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
    fluxEventBus.publish('quorumGrant:healed', {
      key: this.#key, remove: targetOutpoint, add: entry.add, seq,
    });

    await this.publishRecord();
    await this.#seedGrantor(expected);
  }

  /**
   * Hand one grantor the grant this holder already holds: an accept at the
   * CURRENT epoch, carrying any chain. Two callers: the heal path seeds a
   * freshly seated replacement, and the repair chore re-seats an
   * answering-empty cell (wiped journal, stale record). Until it lands the
   * cell answers refusals, which the safety arithmetic treats as absence.
   * Returns the grantor's reply so the repair chore can read a refusal —
   * `superseded` there means a promise stands above the term.
   */
  async #seedGrantor(member) {
    const signed = await signedAskFor(
      'accept',
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
    if (!signed) return null;
    const sentMs = this.#clock();
    const reply = await askGrantor(member, 'accept', signed.ask, signed.signature);
    if (reply?.ok && reply.accepted) {
      this.recordAck(outpointOf(member), sentMs);
      this.#refusals.delete(outpointOf(member));
    }
    return reply;
  }

  /**
   * The repair chore — the heal chore's sibling. Heal replaces referees that
   * answer NOBODY; repair re-seats referees that ANSWER but hold no usable
   * record: the wiped journal, the stale record, and the founding scramble's
   * residue (a promise above the term with nothing accepted — §13.9's
   * answering-empty cell). Left alone, such a cell sits out the term for the
   * term's whole life and the committee runs silently degraded.
   *
   * Runs only from a HELD, non-coasting term — while a quorum renews, no
   * challenger can win (its prepares are shield-refused on the renewed
   * quorum), so nothing this chore bulldozes can be an in-flight takeover.
   * In jeopardy a takeover may be legitimately winning and repair stays out
   * of its way. One window per maxTtl, like heal.
   *
   * Two rungs: seed (an accept at the CURRENT epoch — no epoch movement, the
   * catch-up shape) and, when a seed is refused `superseded`, ONE full
   * re-acquisition at a higher epoch to clear the residue promise — ordinary
   * retry-higher, same grantee, adopting its own value forward.
   */
  async #maybeRepair() {
    if (this.#stopped || this.#state !== 'held' || this.#coasting) return;
    const now = this.#clock();
    if (this.#lastRepairMs !== null && now - this.#lastRepairMs < maxTtlMs()) return;

    const targets = this.#committee.members.filter(
      (member) => (this.#refusals.get(outpointOf(member)) ?? 0) >= REPAIR_AFTER_REFUSALS,
    );
    if (!targets.length) return;
    this.#lastRepairMs = now;

    let blocked = false;
    let seeded = 0;
    // eslint-disable-next-line no-restricted-syntax -- seeds are sequential on
    // purpose: repair is a background chore, never a burst
    for (const member of targets) {
      // eslint-disable-next-line no-await-in-loop
      const reply = await this.#seedGrantor(member);
      if (reply?.ok && reply.accepted) seeded += 1;
      else if (reply?.code === 'superseded') blocked = true;
    }
    fluxEventBus.publish('quorumGrant:repair', {
      key: this.#key,
      targets: targets.map(outpointOf),
      seeded,
      escalating: blocked,
    });
    if (blocked) await this.#refreshTerm();
  }

  /**
   * One re-acquisition of this holder's own term at a higher epoch — the
   * repair chore's second rung, clearing every promise a seed cannot get
   * past. The incumbent passes the shield by design, so this is probe →
   * prepare → accept over the same committee; a failed round changes nothing
   * and the next repair window retries. A partial accept round is converged
   * the same way: the cells that took the higher epoch refuse the old-epoch
   * renewals, feeding the refusal counter that re-runs this chore — and the
   * deposition rule ignores our own higher grant on purpose.
   */
  async #refreshTerm() {
    const chainExtras = this.#committee.chain.length ? { chain: this.#committee.chain } : {};
    const probeSigned = await signedAskFor('probe', this.#key, 'held', 1, this.#identity, this.#committee, chainExtras);
    if (!probeSigned) return;
    const probeReplies = await askCommittee(this.#committee.members, 'probe', probeSigned.ask, probeSigned.signature);

    // defensive: a real successor learned here is a deposition, not a repair
    const adopted = core.adoptFrom([...probeReplies.values()]);
    if (adopted && adopted.epoch > this.#epoch && adopted.grantee !== this.#identity.outpoint) {
      this.#demote(`a grant at epoch ${adopted.epoch} supersedes ours at ${this.#epoch}`);
      return;
    }

    const epoch = core.nextEpoch(core.highestEpochSeen([...probeReplies.values()]));
    if (epoch <= this.#epoch) return;

    const prepareSigned = await signedAskFor('prepare', this.#key, 'held', epoch, this.#identity, this.#committee, chainExtras);
    if (!prepareSigned) return;
    const prepareReplies = await askCommittee(this.#committee.members, 'prepare', prepareSigned.ask, prepareSigned.signature);
    const prepared = core.prepareOutcome([...prepareReplies.values()], this.#committee.quorum);
    if (!prepared.promised) return;

    const acceptSigned = await signedAskFor('accept', this.#key, 'held', epoch, this.#identity, this.#committee, {
      ttlMs: this.#ttlMs,
      ...chainExtras,
    });
    if (!acceptSigned) return;
    const sentMs = this.#clock();
    const acceptReplies = await askCommittee(this.#committee.members, 'accept', acceptSigned.ask, acceptSigned.signature);
    const accepted = core.acceptOutcome([...acceptReplies.values()], this.#committee.quorum);
    if (!accepted.granted) return;

    this.#epoch = epoch;
    this.#acks.clear();
    acceptReplies.forEach((reply, outpoint) => {
      if (reply?.ok && reply.accepted) {
        this.recordAck(outpoint, sentMs);
        this.#refusals.delete(outpoint);
      }
    });
    this.#armDemotion(this.safeUntil() + demotionSlackMs());
    await this.publishRecord();
    fluxEventBus.publish('quorumGrant:termRefreshed', { key: this.#key, epoch });
  }

  async #assess(quorumRenewed) {
    const now = this.#clock();
    const safeUntil = this.safeUntil();

    // Every branch reports what this pass SAW, not just what it decided: the
    // holder's safety arithmetic is otherwise silent in jeopardy, and a master
    // that held when it should have demoted leaves no trace to diagnose.
    // publish() is a no-op outside the harness.
    const seen = {
      key: this.#key,
      quorumRenewed,
      coasting: this.#coasting,
      safeForMs: safeUntil === null ? null : Math.round(safeUntil - now),
      // cells refusing renewals right now — the silently-degraded-committee
      // number the repair chore exists to drive back to zero
      refusingCells: this.#refusals.size,
    };

    if (quorumRenewed) {
      this.#state = 'held';
      this.#coasting = false;
      this.#armDemotion(safeUntil + demotionSlackMs());
      fluxEventBus.publish('quorumGrant:assess', { ...seen, outcome: 'held' });
      return;
    }

    // The witness rule decides FROM THE FIRST failed renewal, never only
    // past safety: a legitimate coast must already stand when the standing
    // alarm fires, because the alarm no longer waits for a pass to notice
    // the deadline.
    const standbys = await standbysFor(this.#key, this.#identity.outpoint);
    // Zero resolvable witnesses is maximal doubt, and doubt never coasts: a
    // global app always has other instances by spec floor, so an empty set
    // means nobody can vouch that no takeover is possible - unanimity over
    // nobody proved nothing, and it kept an isolated master running.
    const witnessReplies = standbys.length ? await pollWitnesses(standbys, this.#key) : new Map();
    const verdict = standbys.length
      ? core.coastVerdict(standbys.map(outpointOf), witnessReplies)
      : { coast: false, reason: 'no witnesses resolvable' };
    seen.standbys = standbys.length;
    seen.witnessReplies = witnessReplies.size;

    if (verdict.coast) {
      this.#state = 'jeopardy';
      if (!this.#coasting) fluxEventBus.publish('quorumGrant:coasting', { key: this.#key });
      this.#coasting = true;
      this.#disarmDemotion();
      fluxEventBus.publish('quorumGrant:assess', { ...seen, outcome: 'coast' });
      return;
    }

    this.#lastDoubt = verdict.reason ?? 'renewal quorum lost past the deadline';
    // The alarm target follows safeUntil while it is known - partial rounds
    // legitimately move it - and stays ANCHORED where it last stood when
    // safeUntil is null (a collapsed ack set, every ack deleted by lapsed
    // refusals): a deadline recomputed from the current pass slides forward
    // forever and the demotion never fires.
    if (safeUntil !== null) {
      this.#armDemotion(safeUntil + demotionSlackMs());
    } else if (this.#deadlineTargetMs === null) {
      this.#armDemotion(now + demotionSlackMs());
    }
    if (now > this.#deadlineTargetMs) {
      fluxEventBus.publish('quorumGrant:assess', {
        ...seen, outcome: 'demote', reason: verdict.reason ?? null,
      });
      this.#demote(this.#lastDoubt);
    } else {
      this.#state = 'jeopardy';
      this.#coasting = false;
      fluxEventBus.publish('quorumGrant:assess', {
        ...seen,
        outcome: 'awaitingDeadline',
        demotionInMs: Math.round(this.#deadlineTargetMs - now),
        reason: verdict.reason ?? null,
      });
    }
  }

  #armDemotion(targetMs) {
    if (this.#deadlineTargetMs === targetMs && this.#demotionTimer !== null) return;
    if (this.#demotionTimer !== null) this.#cancel(this.#demotionTimer);
    this.#deadlineTargetMs = targetMs;
    this.#demotionTimer = this.#schedule(() => {
      this.#demotionTimer = null;
      if (this.#stopped || this.#coasting || this.#deadlineTargetMs === null) return;
      if (this.#clock() < this.#deadlineTargetMs) {
        // a renewal moved the deadline after this timer was set - stand the
        // alarm at the newer target
        this.#armDemotion(this.#deadlineTargetMs);
        return;
      }
      this.#demote(this.#lastDoubt ?? 'renewal quorum lost past the deadline');
    }, Math.max(0, targetMs - this.#clock()));
  }

  #disarmDemotion() {
    this.#deadlineTargetMs = null;
    if (this.#demotionTimer !== null) {
      this.#cancel(this.#demotionTimer);
      this.#demotionTimer = null;
    }
  }

  #demote(reason) {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#state = 'lost';
    this.#coasting = false;
    this.#disarmDemotion();
    if (this.#timer !== null) this.#cancel(this.#timer);
    held.delete(this.#key);
    log.warn(`quorumGrant holder ${this.#key}: demoted — ${reason}`);
    fluxEventBus.publish('quorumGrant:demoted', { key: this.#key, reason });
    if (this.#onDemoted) this.#onDemoted(reason);
  }

  /** Stop locally: end the loop and the registry entry, no wire traffic. */
  stop() {
    this.#stopped = true;
    this.#disarmDemotion();
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
  if (!signedEnvelope.TYPES.includes(type)) {
    fluxEventBus.publish('quorumGrant:carryRefused', { type, key: ask?.key ?? null, reason: 'unknown ask type' });
    return { replies: [] };
  }
  const committee = await committeeFor(ask.key, ask.mode ?? 'held', ask.fingerprint);
  if (!committee) {
    // an empty carry has two causes — bad type, unresolvable committee —
    // and the caller sees the same {replies: []} either way; name which
    fluxEventBus.publish('quorumGrant:carryRefused', { type, key: ask.key, reason: 'committee unavailable for fingerprint' });
    return { replies: [] };
  }

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
      // Double budget, like the relay call: the witness answers only after
      // its own committee probes, which burn a full askTimeout exactly when
      // the committee is unreachable - the one moment this poll matters. A
      // single budget times out on every witness by construction there, and
      // an unaccounted-for witness fails the coast closed.
      const response = await serviceHelper.axiosPost(
        grantorUrl(standby, '/flux/quorumgrant/witness'),
        { key },
        { timeout: askTimeoutMs() * 2, httpAgent: askAgent },
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
  termLapsed,
  holderFor,
  isAcquiring,
  witnessAnswer,
  carryAsk,
  Holder,
  resetForTests,
};
