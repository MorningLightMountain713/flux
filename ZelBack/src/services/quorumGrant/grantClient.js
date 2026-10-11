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
const generationWorld = require('./generationWorld');
const rosterOverlay = require('./rosterOverlay');
const downCertificates = require('./downCertificates');
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
//   The COAST bends that arithmetic: a coasting holder's demotion re-arms at
//   coast-collapse + slack, arbitrarily later than the row death the
//   lock-delay counts from — so a coast outliving lockDelay − slack would
//   let a successor be seated at the very moment the grantors return, before
//   the collapse is even observable here.
//   The grantor side restores the ordering: the lock-delay is anchored at
//   the LATER of row death and the grantor's own return to refereeing
//   (grantRegisterCore.lockDelayRemaining), so the successor's wait starts
//   only when a successor could first be seated at all, and this holder's
//   renewal loop (renewIntervalMs < lockDelayMs) reclaims its own rows —
//   free-or-mine, never delayed — inside that window.
//
// The Holder takes an injectable clock and scheduler so every timing rule
// above is testable as arithmetic; production passes nothing and gets the
// monotonic clock and setTimeout.

function renewIntervalMs() {
  return config.get('fluxapps.quorumGrantRenewIntervalMs');
}

function defaultTtlMs() {
  return config.get('fluxapps.quorumGrantHeldTtlMs');
}

function demotionSlackMs() {
  return config.get('fluxapps.quorumGrantDemotionSlackMs');
}

function lockDelayMs() {
  return config.get('fluxapps.quorumGrantLockDelayMs');
}

function askTimeoutMs() {
  return config.get('fluxapps.quorumGrantAskTimeoutMs');
}

/**
 * How long the heal and repair chores wait between seat changes.
 *
 * It used to be maxTtlMs - 300s - purely because they shared a knob, and the
 * two do entirely different jobs: maxTtlMs bounds a TERM, this bounds how fast
 * the COMMITTEE may move. Coupled, three dark seats took 150s to notice plus
 * 300s each to replace: over twelve minutes to repair a committee, during which
 * losing a quorum is permanent, because healing itself needs a quorum.
 *
 * The floor is propagation, not detection. The roster chain rides on every ask
 * and renewals go every ~20s, so healing faster than the chain spreads means
 * chains grow faster than nodes learn them. 30s is one full renewal cycle plus
 * margin, and 10x faster than the coupling it replaces.
 *
 * Safe to shorten: the one-seat-per-TTL rate limit is NOT what carries
 * at-most-one-live-grantee. formal/held-committee-rotation naive-multiseat
 * turns it off and finds no violation over 126,463 simulated traces / 17.9M
 * states - against a calibration (naive-noadopt) that surfaces its known
 * violation in 20 traces. It does a different job: bounding how fast a holder
 * could pack the committee. Not droppable, but not a safety brake either.
 */
function repairIntervalMs() {
  return config.get('fluxapps.quorumGrantRepairIntervalMs');
}


function committeeSizeFor(mode) {
  if (mode === 'oneshot') return config.get('fluxapps.quorumGrantOneshotCommitteeSize');
  // nine referees, majority five — the grantor side derives the same size
  return config.get('fluxapps.quorumGrantHeldCommitteeSize');
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

  const world = await currentWorld(key);
  const { generation } = world;
  const walkKey = rosterOverlay.walkKeyFor(key, generation);
  const committee = selectCommittee(membership, walkKey, { size: committeeSizeFor('held') });
  if (committee.refusal) return null;

  let chainMembers = committee.members;
  let chain = [];
  let cancels = [];
  const identity = key.slice(0, key.indexOf('/'));
  const role = key.slice(key.indexOf('/') + 1);
  const published = await readMasterleaseRoster(identity, role);
  const sameBasis = published
    && published.fingerprint === fingerprint
    && published.generation === generation;
  if (sameBasis && published.chain.length) {
    const verified = rosterOverlay.verifyChain(
      membership, key, fingerprint, generation, committeeSizeFor('held'), published.chain,
    );
    if (verified) {
      chainMembers = verified.members;
      ({ chain } = published);
    }
  }
  // The published cancel chain is adopted as published state, shape-gated
  // only: certificates verify at formation and at the grantors' gauntlet,
  // and a reader past the store's retention could not re-verify them anyway.
  // A lie here misroutes asks to grantors that refuse — routing, not trust.
  if (sameBasis && published.cancels.length
    && rosterOverlay.cancelChainWellFormed(published.cancels)) {
    ({ cancels } = published);
  }
  cancels = await withStoreCancellations(chainMembers, chain, cancels, membership, walkKey);
  const members = cancelledApplied(membership, walkKey, chainMembers, chain, cancels);

  return {
    members, chainMembers, quorum: committee.quorum, fingerprint, generation, height: world.height, chain, cancels,
  };
}

/** What every held ask carries of the committee's overlay state. */
function overlayExtras(committee) {
  return {
    ...(committee.chain?.length ? { chain: committee.chain } : {}),
    ...(committee.cancels?.length ? { cancels: committee.cancels } : {}),
  };
}

// key -> { world, atMs }: the monotonic moment this node first stood the key
// in the world it stands in now
const worldsReceived = new Map();

function noteWorldReceived(key, world) {
  const seen = worldsReceived.get(key);
  if (seen && generationWorld.sameWorld(seen.world, world)) return;
  worldsReceived.set(key, { world: { generation: world.generation, height: world.height }, atMs: nowMs() });
}

/**
 * The world a key stands in as this node has synced it: the generation its
 * committee is dealt from and the height that committee took over at.
 */
async function currentWorld(key) {
  try {
    const slash = key.indexOf('/');
    const world = generationWorld.worldOf(await messageStore.standingGeneration(key.slice(0, slash), key.slice(slash + 1)));
    noteWorldReceived(key, world);
    return world;
  } catch (error) {
    return {
      generation: 0, height: null, record: null, aside: false,
    };
  }
}

/**
 * How long this node must still wait before pursuing a seat for a key it does
 * not hold: one lock-delay from the moment it first stood the key in its
 * current world. From that moment its witness answers name that world, so a
 * holder coasting on another world's vouch reads that at its next poll,
 * inside the wait, and stops before this node can be seated. A world first
 * seen at this node's start waits the same, and a world this node cannot read
 * waits the whole lock-delay.
 *
 * @param {string} key
 * @returns {Promise<number>} ms still to wait; 0 when free to pursue
 */
async function worldReceiptWaitMs(key) {
  await currentWorld(key);
  const seen = worldsReceived.get(key);
  if (!seen) return lockDelayMs();
  return Math.max(0, seen.atMs + lockDelayMs() - nowMs());
}

/** The owner-signed generation record this node holds for a key, or null. */
async function knownGenerationRecord(key) {
  try {
    const slash = key.indexOf('/');
    const record = await messageStore.getGrantGenerationRecord(key.slice(0, slash), key.slice(slash + 1));
    return record?.data ?? null;
  } catch (error) {
    return null;
  }
}

// keys whose taught record is being stored right now — one round of asks
// brings the same record back from every cell that knows it
const learning = new Set();

/**
 * Consume what an answer teaches. A generation record naming a generation
 * other than the one this node asked under enters the store through the same
 * owner-verified path a broadcast takes — one fact, kept in one place — and
 * the store, which keeps every record it verifies, decides which stands; its
 * listeners carry the news to whoever holds the key. A lower number is news
 * as much as a higher one: a sale steps an app back to an earlier world. A
 * record at the generation asked under is nothing this node does not know,
 * and a record about some other key is not this answer's to teach.
 */
async function learnGeneration(key, askedGeneration, answer) {
  const record = answer?.generationRecord;
  if (!record || !Number.isSafeInteger(record.generation)) return;
  if (record.generation === (askedGeneration ?? 0)) return;
  const slash = key.indexOf('/');
  if (record.identity !== key.slice(0, slash) || record.role !== key.slice(slash + 1)) return;
  if (learning.has(key)) return;
  learning.add(key);
  try {
    await messageStore.storeAppStateEvent(
      messageStore.APP_STATE_EVENT_TYPES.GRANTGENERATION,
      { message: record, envelope: null },
    );
    fluxEventBus.publish('quorumGrant:generationLearned', { key, generation: record.generation });
  } catch (error) {
    log.warn(`quorumGrant ${key}: storing a taught generation record failed: ${error.message}`);
  } finally {
    learning.delete(key);
  }
}

/**
 * The overlay state the published record carries for a key — roster chain
 * and cancel chain — with the basis it binds to, or null. A read, never a
 * verification: the roster chain re-verifies against the membership, the
 * cancel chain is adopted as published state.
 */
async function readMasterleaseRoster(identity, role) {
  try {
    const record = await messageStore.getMasterleaseRecord(identity, role);
    const data = record?.data;
    if (!data || typeof data.fingerprint !== 'string') return null;
    return {
      fingerprint: data.fingerprint,
      generation: data.generation ?? 0,
      chain: Array.isArray(data.roster?.chain) ? data.roster.chain : [],
      cancels: Array.isArray(data.cancels?.chain) ? data.cancels.chain : [],
    };
  } catch (error) {
    return null;
  }
}

/**
 * The roster with a cancel chain applied over the tier-1 result — the
 * overlay order every verifier runs: base walk, then the quorum-signed
 * chain, then the cancel set.
 */
function cancelledApplied(membership, walkKey, members, chain, cancels) {
  const cancelled = rosterOverlay.cancelledSubjects(cancels);
  if (!cancelled.size) return members;
  const excluded = new Set(chain.map((entry) => entry.remove));
  return rosterOverlay.applyCancellations(membership, walkKey, members, excluded, cancelled).members;
}

/**
 * Extend a cancel chain with what this node's own store holds that the
 * published chain does not: a refutation lifts a standing cancellation, a
 * standing certificate cancels a seated member — replacements included, so
 * derivation runs to a fixed point. A lapsed certificate changes nothing:
 * without a refutation the published cancellation stands.
 */
async function withStoreCancellations(members, chain, cancels, membership, walkKey) {
  let extended = [...cancels];

  const standing = rosterOverlay.cancelledSubjects(extended);
  const lifts = await Promise.all([...standing].sort().map(async (subject) => {
    if (await downCertificates.standingCertificateFor(subject)) return null;
    const refutation = await downCertificates.refutationFor(subject);
    return refutation ? { subject, refutation } : null;
  }));
  lifts.filter(Boolean).forEach(({ subject, refutation }) => {
    extended.push({
      seq: extended.length + 1, reinstate: subject, refutation, at: Date.now(),
    });
  });

  for (;;) {
    const roster = cancelledApplied(membership, walkKey, members, chain, extended);
    const seated = roster.map(outpointOf).sort();
    // eslint-disable-next-line no-await-in-loop -- each round checks the
    // roster the previous round's cancellations derived
    const certified = (await Promise.all(seated.map(async (outpoint) => {
      const cert = await downCertificates.standingCertificateFor(outpoint);
      return cert ? { outpoint, cert } : null;
    }))).filter(Boolean);
    if (!certified.length) return extended;

    const appended = [...extended];
    certified.forEach(({ outpoint, cert }) => {
      appended.push({
        seq: appended.length + 1, cancel: outpoint, cert, at: Date.now(),
      });
    });
    // past the shape cap the world has changed too much for an overlay:
    // stop extending and let re-acquisition at a fresh basis restart it
    if (!rosterOverlay.cancelChainWellFormed(appended)) return extended;
    extended = appended;
  }
}

/**
 * The app's other holders — the relay carriers and the witness set — from
 * this node's own locations view.
 */
async function standbysFor(key, selfOutpoint) {
  const identity = key.slice(0, key.indexOf('/'));
  const rows = await registryManager.appLocationOf(identity);
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
async function askGrantor(member, type, ask, signature, options = {}) {
  return (await askGrantorDetailed(member, type, ask, signature, options)).reply;
}

/**
 * askGrantor with one more fact: whether the grantor responded at all — a
 * reply, or a refusal at its door — as against silence.
 * @returns {Promise<{reply: object|null, answered: boolean}>}
 */
async function askGrantorDetailed(member, type, ask, signature, { timeoutMs } = {}) {
  try {
    const response = await serviceHelper.axiosPost(
      grantorUrl(member, `/flux/quorumgrant/${type}`),
      { ...ask, signature },
      { timeout: timeoutMs ?? askTimeoutMs(), httpAgent: askAgent },
    );
    return { reply: response?.data?.data ?? null, answered: true };
  } catch (error) {
    // The grantor names why it refused and the reason dies in this catch —
    // outside the harness nothing observes it (publish() is a no-op), and a
    // refused ask and an unreachable grantor both come back null on purpose:
    // the quorum arithmetic treats silence as silence either way. What the
    // refusal TEACHES does not die here: a newer generation named by the
    // refusing cell is this node's world having ended.
    fluxEventBus.publish('quorumGrant:askRefused', {
      type,
      member: outpointOf(member),
      status: error.response?.status ?? null,
      reason: error.response?.data?.data?.message ?? error.message ?? null,
    });
    const refusal = error.response?.data?.data;
    await learnGeneration(ask.key, ask.generation, refusal);
    return {
      reply: null,
      answered: error.response?.status !== undefined,
      named: Number.isSafeInteger(refusal?.generation)
        ? { generation: refusal.generation, height: refusal.height }
        : null,
      drainUntil: Number.isSafeInteger(refusal?.drainUntil) ? refusal.drainUntil : null,
    };
  }
}

/**
 * Ask every committee member directly. One signature serves all of them —
 * the payload never names the member.
 * @returns {Map<string, object>} outpoint -> reply, silent members absent;
 *   `answered` on the map counts the members that responded at all, and
 *   `named` holds every world ({generation, height}) a refusing member named as its standing one,
 *   `draining` the lift height each member refusing as draining named
 */
async function askCommittee(members, type, ask, signature, { timeoutMs } = {}) {
  const asks = members.map(async (member) => ({
    member, ...(await askGrantorDetailed(member, type, ask, signature, { timeoutMs })),
  }));
  const settled = await Promise.all(asks);
  const replies = new Map();
  const named = [];
  const draining = [];
  let answered = 0;
  settled.forEach(({
    member, reply, answered: responded, named: world, drainUntil,
  }) => {
    if (responded) answered += 1;
    if (reply) replies.set(outpointOf(member), reply);
    if (world) named.push(world);
    if (drainUntil !== null && drainUntil !== undefined) draining.push(drainUntil);
  });
  replies.answered = answered;
  replies.named = named;
  replies.draining = draining;
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

// The ask types a referee answers only to a holder of the app
// (grantorController.askerHolds).
const HOLDER_CHECKED_TYPES = new Set(['prepare', 'accept', 'renew']);

/**
 * This node's own running announcement, for the asks a referee answers only
 * to a holder: a cell that has not received the broadcast seats on this
 * copy instead of refusing. Outside the ask's signature; the broadcast
 * envelope carries its own. Nothing to attach before the node's first
 * announcement.
 */
async function holdingEvidence(type) {
  if (!HOLDER_CHECKED_TYPES.has(type)) return {};
  const socketAddress = await fluxNetworkHelper.getLocalSocketAddress();
  if (!socketAddress) return {};
  const announcement = await messageStore.appRunningBroadcastOf(socketAddress);
  return announcement ? { announcement } : {};
}

async function signedAskFor(type, key, mode, epoch, identity, basis, extras = {}) {
  const ask = {
    key,
    mode,
    epoch,
    candidate: identity.outpoint,
    generation: basis.generation ?? 0,
    generationHeight: basis.height ?? null,
    fingerprint: basis.fingerprint,
    at: Date.now(),
    ...extras,
    ...(await holdingEvidence(type)),
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

/**
 * Register a holder for its key. One holder per key: acquire and relearn each
 * check the registry before their wire round and register after it, so a
 * second holder can arrive while the first stands. The higher epoch is the
 * live term at the referees and stays; the other is stopped locally, since
 * the referees have already superseded it.
 *
 * @returns {Holder} the holder registered for the key; when it is not the one
 *   passed in, the caller's holder was stopped and must not be started
 */
function registerHolder(key, holder) {
  const standing = held.get(key);
  if (standing && standing !== holder) {
    if (standing.epoch >= holder.epoch) {
      holder.stop();
      return standing;
    }
    standing.stop();
  }
  held.set(key, holder);
  return holder;
}

// ---------------------------------------------------------------------------
// acquisition

/**
 * One acquisition pass: probe (held mode), prepare, adopt, accept. Retry
 * policy belongs to the CONSUMER — this returns a rich outcome and never
 * loops on its own, so a caller cannot be surprised by how long it took.
 *
 * @param {string} key resource key
 * @param {object} options {mode, ttlMs, fingerprint, committee, onDemoted,
 *   clock, schedule, prepareOnlyIfOpen} — `prepareOnlyIfOpen` is the running
 *   node's attempt inside the activation window: a probe that goes on to
 *   prepare only when a quorum is open, answering {granted: false, reason:
 *   'no open quorum', retryAfterMs} otherwise with the figure a quorum opens
 *   at (0 = nothing taught, re-probe) and no epoch burnt; `committee` is an already-resolved
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
 * Re-learn a term this node may still hold, after a FluxOS restart wiped the
 * in-memory holder while the container kept running.
 *
 * There is nothing to time. A node that lost its term knowledge knows the term
 * ends no LATER than that instant plus a TTL, but safety needs the EARLIEST
 * possible end and that is unbounded below - the term may already be gone. So
 * no timer is sound at any value, and the node re-learns from the grantors or
 * it stops.
 *
 * This works at exactly the moment acquisition does not. `grantRegister.read`
 * is served THROUGH the rejoin drain - "reading what the journal holds
 * contradicts nothing" - so a fleet update wave, which puts every grantor
 * inside its drain and refuses every ask, still answers this. That wave is the
 * production case: it is what stopped a healthy master on a 10-node fleet 22
 * seconds before that same node was granted the term back.
 *
 * @returns {Promise<{recovered: boolean, holder: Holder|null, reason: string|null}>}
 */
async function relearn(key, options = {}) {
  if (held.has(key)) return { recovered: true, holder: held.get(key), reason: null };

  const identity = await selfIdentity();
  if (!identity) return { recovered: false, holder: null, reason: 'node identity unavailable' };

  const mode = options.mode ?? 'held';
  const committee = options.committee
    ?? await committeeFor(key, mode, options.fingerprint ?? networkStateService.membershipFingerprint());
  if (!committee) return { recovered: false, holder: null, reason: 'committee unavailable for fingerprint' };

  const clock = options.clock ?? nowMs;
  const startMs = clock();
  const reads = committee.members.map(async (member) => {
    try {
      const response = await serviceHelper.axiosGet(
        `${grantorUrl(member, '/flux/quorumgrant/record')}?key=${encodeURIComponent(key)}`,
        { timeout: askTimeoutMs(), httpAgent: askAgent },
      );
      const data = response?.data?.data;
      await learnGeneration(key, committee.generation, data);
      if (!data?.accepted) return null;
      return {
        grantee: data.accepted.grantee,
        epoch: data.accepted.epoch,
        remainingMs: data.remainingMs,
      };
    } catch (error) {
      return null;
    }
  });
  const replies = (await Promise.all(reads)).filter(Boolean);
  // The WHOLE batch, not each reply: the slowest answer bounds how stale the
  // earliest one may be, and over-discounting is the safe direction.
  const roundTripMs = clock() - startMs;

  const outcome = core.recoverOutcome(replies, identity.outpoint, committee.quorum, roundTripMs);
  // the term a quorum of registers names, whoever holds it — what the veto acts on
  const term = core.quorumTerm(replies, committee.quorum);
  fluxEventBus.publish('quorumGrant:relearn', {
    key,
    read: replies.length,
    quorum: committee.quorum,
    recovered: outcome.recovered,
    safeForMs: outcome.safeForMs,
    reason: outcome.reason,
  });
  if (!outcome.recovered) {
    return {
      recovered: false, holder: null, reason: outcome.reason, term,
    };
  }

  const holder = new Holder({
    key,
    epoch: outcome.epoch,
    ttlMs: options.ttlMs ?? defaultTtlMs(),
    identity,
    committee,
    onDemoted: options.onDemoted,
    clock: options.clock,
    schedule: options.schedule,
    cancel: options.cancel,
    recoveredUntilMs: clock() + outcome.safeForMs,
  });
  const registered = registerHolder(key, holder);
  if (registered !== holder) {
    return {
      recovered: true, holder: registered, reason: null, term,
    };
  }
  // §7's alarm is STANDING and a restart is exactly what disarms it. Arming
  // here rather than waiting for the first renewal pass is the whole point:
  // the pass is a renewal interval away, and a term re-learned with less than
  // that left would otherwise run with nothing scheduled to stop it.
  holder.armStandingDeadline();
  holder.start();
  log.info(`quorumGrant ${key}: term re-learned at epoch ${outcome.epoch}, ${outcome.safeForMs}ms remaining`);
  return {
    recovered: true, holder, reason: null, term,
  };
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
  const overlay = overlayExtras(committee);
  const signed = await signedAskFor('probe', key, 'held', 1, identity, committee, overlay);
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
  const overlay = overlayExtras(committee);

  // Pre-vote: learn without burning an epoch. A live incumbent means the
  // answer is "not you, not now" and a correct challenger walks away.
  const probeSigned = await signedAskFor('probe', key, mode, 1, identity, committee, overlay);
  if (!probeSigned) return { granted: false, reason: 'could not sign ask' };
  const probeReplies = await askCommittee(members, 'probe', probeSigned.ask, probeSigned.signature);

  const shield = [...probeReplies.values()].find(
    (reply) => reply?.code === 'incumbent_active' && reply?.accepted?.grantee !== identity.outpoint,
  );
  if (mode === 'held' && shield) {
    return { granted: false, incumbent: shield.accepted };
  }

  // The window attempt prepares only on an open quorum (ACTIVATION_CROSSING_DESIGN
  // §2.5): the model's poll rule, under which an opening of three ticks of one
  // stable quorum-set is enough. Preparing into a shut committee would burn
  // an epoch for nothing and, worse, leave an accept in flight against a
  // cell that has just gone stale when the doors do open (RESULTS.md row 33).
  if (options.prepareOnlyIfOpen) {
    const opening = core.openingOutcome([...probeReplies.values()], quorum);
    if (!opening.open) {
      return {
        granted: false, reason: 'no open quorum', retryAfterMs: opening.retryAfterMs, highestEpoch: opening.highestEpoch,
      };
    }
  }

  const probeOutcome = core.prepareOutcome([...probeReplies.values()], quorum);
  if (probeOutcome.retryAfterMs > 0) {
    return { granted: false, retryAfterMs: probeOutcome.retryAfterMs };
  }

  // Prepare at one past everything the probe taught.
  const epoch = core.nextEpoch(probeOutcome.highestEpoch);
  const prepareSigned = await signedAskFor('prepare', key, mode, epoch, identity, committee, overlay);
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
    ...overlay,
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
    fluxEventBus.publish('quorumGrant:founded', { key, founder: identity.outpoint, generation: committee.generation });
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
    cancel: options.cancel,
  });
  acceptReplies.forEach((reply, outpoint) => {
    if (reply?.ok) {
      holder.recordAck(outpoint, sentMs);
      holder.recordAcceptance(outpoint, reply.acceptance);
    }
  });
  const registered = registerHolder(key, holder);
  if (registered !== holder) return { granted: true, holder: registered, deposed: null };
  // §7's demotion alarm is STANDING: it fires ON the deadline without waiting
  // for a pass. Arming it here rather than inside the first renewal is the same
  // rule the restart path needs - the first pass is a jittered renewal interval
  // away, and a holder is not allowed to be un-alarmed for any of it.
  holder.armStandingDeadline();
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

  // grantor outpoint -> its latest signed term acceptance for THIS epoch (the
  // credential, STEP_ACROSS_DESIGN.md D1); starts empty at every epoch bump
  #acceptances = new Map();

  // The drain the committee this holder steps across to stands in: the height
  // it lifts at, and the latest moment enough of its cells to meet every
  // quorum were refusing as draining. A stranger's seat opens no earlier
  // than one lock-delay past that moment, so it bounds every step taken
  // after the lift. Null while no such refusals are known.
  #lift = null;

  // the step-across on the wire, shared by every caller while it is
  #stepping = null;

  // a lift block landed while a step was on the wire: step again when it settles
  #liftAgain = false;

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

  // A RE-LEARNED term has no acks of its own: this node never sent the round
  // that won it, it read the result off a quorum of registers after a restart.
  // So the median rule has nothing to work with and this carries the deadline
  // until the first renewal replaces it - already discounted for the read's
  // round trip by recoverOutcome, because the grantors' figure was computed
  // on THEIR clocks.
  #recoveredUntilMs = null;

  constructor(options) {
    this.#key = options.key;
    this.#epoch = options.epoch;
    this.#ttlMs = options.ttlMs;
    this.#identity = options.identity;
    this.#committee = options.committee;
    this.#committee.chain = this.#committee.chain ?? [];
    this.#committee.cancels = this.#committee.cancels ?? [];
    this.#committee.generation = this.#committee.generation ?? 0;
    this.#onDemoted = options.onDemoted ?? null;
    this.#recoveredUntilMs = options.recoveredUntilMs ?? null;
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

  get generation() {
    return this.#committee.generation;
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

  /** The referee's signed term acceptance that rode an accept or renew reply. */
  recordAcceptance(grantorOutpoint, acceptance) {
    if (!acceptance || typeof acceptance.signature !== 'string' || acceptance.grantor !== grantorOutpoint) return;
    this.#acceptances.set(grantorOutpoint, { grantor: grantorOutpoint, signature: acceptance.signature });
  }

  /**
   * What this holder can prove to a committee that never granted it: the
   * retired world's basis and a quorum of that world's signed acceptances of
   * this term (STEP_ACROSS_DESIGN.md D1/D2). Null below a quorum.
   */
  credential() {
    const acceptances = [...this.#acceptances.values()];
    if (acceptances.length < this.#committee.quorum) return null;
    return {
      fingerprint: this.#committee.fingerprint,
      generation: this.#committee.generation,
      generationHeight: this.#committee.height ?? null,
      epoch: this.#epoch,
      roster: this.#committee.chain.length ? { chain: this.#committee.chain } : null,
      acceptances,
    };
  }

  /** The median rule over the latest ack per grantor. */
  safeUntil() {
    const acks = [...this.#acks.values()].map((sentMs) => ({ sentMs, ttlMs: this.#ttlMs }));
    const fromAcks = core.safeUntilMs(acks, this.#committee.quorum);
    // A re-learned holder has no acks until its first renewal lands, and the
    // median rule answers null for that, so the recovered figure carries the
    // deadline until then. It is CLEARED the moment a renewal quorum answers
    // (see renewOnce) rather than being max'd or min'd against the acks: once
    // the acks exist they are the truth, and making that true by construction
    // beats making it true by arithmetic nobody can test.
    return fromAcks !== null ? fromAcks : this.#recoveredUntilMs;
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
      generationHeight: this.#committee.height ?? null,
      ttlMs: this.#ttlMs,
      acceptances: [...this.#acceptances.values()],
      ...(this.#committee.chain.length ? { roster: { chain: this.#committee.chain } } : {}),
      ...(this.#committee.cancels.length ? { cancels: { chain: this.#committee.cancels } } : {}),
    });
  }

  /**
   * Arm the standing alarm from whatever deadline this holder currently has,
   * without waiting for a renewal pass to do it.
   *
   * §7's alarm fires ON the deadline, and both entry points otherwise leave a
   * holder un-alarmed for a jittered renewal interval: acquire() installs a
   * Holder and schedules only the loop, and a restart clears the belief that
   * armed the previous one. A term with less left than that interval - a
   * re-learned one especially - would run with nothing scheduled to stop it.
   */
  armStandingDeadline() {
    const safeUntil = this.safeUntil();
    if (safeUntil === null) return;
    this.#armDemotion(safeUntil + demotionSlackMs());
  }

  start() {
    this.#loop();
  }

  /**
   * Arm the next renewal pass. A pass in flight holds no timer and re-arms
   * itself when it ends, so at most one pass runs at a time.
   */
  #loop(delayMs = jitteredMs(renewIntervalMs())) {
    if (this.#stopped) return;
    if (this.#timer !== null) this.#cancel(this.#timer);
    this.#timer = this.#schedule(async () => {
      this.#timer = null;
      try {
        await this.renewOnce();
      } catch (error) {
        log.error(`quorumGrant holder ${this.#key}: ${error.message}`);
      }
      this.#loop();
    }, delayMs);
  }

  /**
   * A generation record for this key landed, or its row was written with a
   * new owner. When this node now stands in a world other than the one this
   * term was granted in — a re-roll, a sale, a step back — that world has
   * ended, and the next contact with the referees is the one that acts on it:
   * now, not a renewal interval from now. A pass in flight is that contact
   * already.
   *
   * @returns {Promise<void>}
   */
  async noteGeneration() {
    if (this.#stopped) return;
    const standing = await currentWorld(this.#key);
    if (this.#stopped || generationWorld.sameWorld(standing, this.#committee)) return;
    log.info(`quorumGrant holder ${this.#key}: generation ${standing.generation} from height ${standing.height} `
      + `stands in place of our ${this.#committee.generation} — contacting the referees now`);
    if (this.#timer === null) return;
    this.#loop(0);
  }

  /**
   * One renewal pass: direct asks, relay for the silent members, then the
   * safety arithmetic — and when the arithmetic says jeopardy, the witness
   * poll decides between coasting and the deadline.
   */
  async renewOnce() {
    if (this.#stopped) return;
    // A newer generation stands over this term's world: step across to the
    // re-rolled committee before renewing (STEP_ACROSS_DESIGN.md D4). On
    // success the renewal below already runs under the new committee; on
    // refusal nothing changed and today's path follows — the old cells
    // refuse, the lease lapses, the demotion handler runs.
    await this.#stepAcross();
    if (this.#stopped) return;
    // a step at the lift can land while this pass is on the wire: from then
    // the pass's replies and verdict are about a term the holder left
    const basis = this.#committee;

    const signed = await signedAskFor(
      'renew',
      this.#key,
      'held',
      this.#epoch,
      this.#identity,
      this.#committee,
      {
        ttlMs: this.#ttlMs,
        ...overlayExtras(this.#committee),
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

    if (this.#stopped || this.#committee !== basis) return;

    let renewed = 0;
    replies.forEach((reply, outpoint) => {
      // any reply at all — a grant, a refusal — is a referee that answers;
      // dark means answering nobody, directly or through any carrier
      this.#lastAnswerMs.set(outpoint, sentMs);
      if (reply?.ok && reply.renewed) {
        this.recordAck(outpoint, sentMs);
        this.recordAcceptance(outpoint, reply.acceptance);
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

    await this.#assess(renewed >= this.#committee.quorum, await this.#doubtNamed(direct.named), basis);

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
    if (this.#lastHealMs !== null && now - this.#lastHealMs < repairIntervalMs()) return;

    // Tier-1 is cancel-blind: proposals are judged against the base-plus-
    // chain roster, so only seats on THAT roster are healable here. A dark
    // cancel-seated member is the cancel plane's business — its certificate
    // replaces it at the next derivation.
    const membership = networkStateService.membershipAt(this.#committee.fingerprint);
    if (!membership) return;
    const walkKey = rosterOverlay.walkKeyFor(this.#key, this.#committee.generation);
    const base = selectCommittee(membership, walkKey, { size: committeeSizeFor('held') });
    if (base.refusal) return;
    const chainRoster = rosterOverlay.rosterAfter(base.members, membership, this.#committee.chain);
    if (!chainRoster) return;
    const healable = new Set(chainRoster.map(outpointOf));

    const dark = this.#committee.members.filter(
      (member) => healable.has(outpointOf(member))
        && now - (this.#lastAnswerMs.get(outpointOf(member)) ?? now) > this.#ttlMs,
    );
    if (!dark.length) return;
    this.#lastHealMs = now;

    const target = dark[0];
    const targetOutpoint = outpointOf(target);
    const survivors = chainRoster.filter((member) => outpointOf(member) !== targetOutpoint);
    const excluded = new Set(this.#committee.chain.map((entry) => entry.remove));
    excluded.add(targetOutpoint);
    const expected = rosterOverlay.nextReplacement(membership, walkKey, survivors, excluded);
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
        ...overlayExtras(this.#committee),
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
    this.#committee.members = cancelledApplied(
      membership, walkKey, [...survivors, expected], this.#committee.chain, this.#committee.cancels,
    );
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
        ...overlayExtras(this.#committee),
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
    if (this.#lastRepairMs !== null && now - this.#lastRepairMs < repairIntervalMs()) return;

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
    const overlay = overlayExtras(this.#committee);
    const probeSigned = await signedAskFor('probe', this.#key, 'held', 1, this.#identity, this.#committee, overlay);
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

    const prepareSigned = await signedAskFor('prepare', this.#key, 'held', epoch, this.#identity, this.#committee, overlay);
    if (!prepareSigned) return;
    const prepareReplies = await askCommittee(this.#committee.members, 'prepare', prepareSigned.ask, prepareSigned.signature);
    const prepared = core.prepareOutcome([...prepareReplies.values()], this.#committee.quorum);
    if (!prepared.promised) return;

    const acceptSigned = await signedAskFor('accept', this.#key, 'held', epoch, this.#identity, this.#committee, {
      ttlMs: this.#ttlMs,
      ...overlay,
    });
    if (!acceptSigned) return;
    const sentMs = this.#clock();
    const acceptReplies = await askCommittee(this.#committee.members, 'accept', acceptSigned.ask, acceptSigned.signature);
    const accepted = core.acceptOutcome([...acceptReplies.values()], this.#committee.quorum);
    if (!accepted.granted) return;

    this.#epoch = epoch;
    this.#acks.clear();
    this.#acceptances.clear();
    acceptReplies.forEach((reply, outpoint) => {
      if (reply?.ok && reply.accepted) {
        this.recordAck(outpoint, sentMs);
        this.recordAcceptance(outpoint, reply.acceptance);
        this.#refusals.delete(outpoint);
      }
    });
    // the acks are the truth from here; a re-learned figure must not outlive them
    this.#recoveredUntilMs = null;
    this.#armDemotion(this.safeUntil() + demotionSlackMs());
    await this.publishRecord();
    fluxEventBus.publish('quorumGrant:termRefreshed', { key: this.#key, epoch });
  }

  /**
   * Step-across (STEP_ACROSS_DESIGN.md D2–D4): take this term's seat on the
   * re-rolled committee, carrying the retired committee's signed acceptances
   * as the proof the new referees can check. Probe → prepare → accept over
   * the NEW committee, both asks carrying the credential; on a quorum of
   * accepts the holder's world becomes the new one — committee, epoch, acks,
   * acceptances — and the record is republished. Any refusal leaves the
   * holder exactly as it was: the next pass tries again while the credential
   * and the standing generation say it should.
   *
   * @returns {Promise<boolean>} whether the holder now holds under the new world
   */
  async #maybeStepAcross({ timeoutMs } = {}) {
    if (this.#stopped) return false;
    // The three rounds fit inside what the lock-delay leaves after the
    // courier's delivery (one ask timeout): a cell that learned the re-roll
    // at its lift seats a stranger one lock-delay past that, and this
    // holder's accept must land first (formal/quiet-window family K; the
    // boot inequality asserts only that the delivery itself fits).
    const roundMs = timeoutMs ?? Math.max(1, Math.min(askTimeoutMs(), Math.floor((lockDelayMs() - askTimeoutMs()) / 3)));
    const standing = await currentWorld(this.#key);
    if (generationWorld.sameWorld(standing, this.#committee)) {
      this.#lift = null;
      return false;
    }
    const credential = this.credential();
    if (!credential) {
      log.info(`quorumGrant holder ${this.#key}: generation ${standing.generation} stands in place of ours and no credential is held — not stepping across`);
      return false;
    }
    const next = await committeeFor(this.#key, 'held', networkStateService.membershipFingerprint());
    if (!next) {
      log.info(`quorumGrant holder ${this.#key}: no committee resolves for generation ${standing.generation} at this membership — not stepping across`);
      return false;
    }
    next.chain = next.chain ?? [];
    next.cancels = next.cancels ?? [];
    const extras = { ...overlayExtras(next), carried: credential };

    const probeSigned = await signedAskFor('probe', this.#key, 'held', 1, this.#identity, next, extras);
    if (!probeSigned) {
      log.info(`quorumGrant holder ${this.#key}: step-across probe could not be signed`);
      return false;
    }
    const probeAtMs = this.#clock();
    const probeReplies = await askCommittee(next.members, 'probe', probeSigned.ask, probeSigned.signature, { timeoutMs: roundMs });
    this.#noteDrain(probeReplies, probeAtMs, next);
    // a grantee already seated on the new committee is its holder, not us: fall back
    const adopted = core.adoptFrom([...probeReplies.values()]);
    if (adopted && adopted.grantee !== this.#identity.outpoint) {
      log.info(`quorumGrant holder ${this.#key}: step-across to generation ${next.generation} finds ${adopted.grantee} seated at epoch ${adopted.epoch}`);
      return false;
    }
    const epoch = core.nextEpoch(Math.max(core.highestEpochSeen([...probeReplies.values()]), this.#epoch));

    const prepareSigned = await signedAskFor('prepare', this.#key, 'held', epoch, this.#identity, next, extras);
    if (!prepareSigned) {
      log.info(`quorumGrant holder ${this.#key}: step-across prepare could not be signed`);
      return false;
    }
    const prepareAtMs = this.#clock();
    const prepareReplies = await askCommittee(next.members, 'prepare', prepareSigned.ask, prepareSigned.signature, { timeoutMs: roundMs });
    this.#noteDrain(prepareReplies, prepareAtMs, next);
    const prepared = core.prepareOutcome([...prepareReplies.values()], next.quorum);
    if (!prepared.promised) {
      log.info(`quorumGrant holder ${this.#key}: step-across to generation ${next.generation} not promised (${prepared.reason ?? 'no prepare quorum'})`);
      return false;
    }

    const acceptSigned = await signedAskFor('accept', this.#key, 'held', epoch, this.#identity, next, { ttlMs: this.#ttlMs, ...extras });
    if (!acceptSigned) {
      log.info(`quorumGrant holder ${this.#key}: step-across accept could not be signed`);
      return false;
    }
    const sentMs = this.#clock();
    const acceptReplies = await askCommittee(next.members, 'accept', acceptSigned.ask, acceptSigned.signature, { timeoutMs: roundMs });
    this.#noteDrain(acceptReplies, sentMs, next);
    const accepted = core.acceptOutcome([...acceptReplies.values()], next.quorum);
    if (!accepted.granted) {
      log.info(`quorumGrant holder ${this.#key}: step-across to generation ${next.generation} not accepted (${accepted.reason ?? 'no accept quorum'})`);
      return false;
    }
    // a holder demoted or stopped while its rounds were on the wire takes no world
    if (this.#stopped) return false;

    this.#committee = next;
    this.#epoch = epoch;
    this.#lift = null;
    this.#acks.clear();
    this.#acceptances.clear();
    this.#refusals.clear();
    this.#lastAnswerMs.clear();
    next.members.forEach((member) => this.#lastAnswerMs.set(outpointOf(member), sentMs));
    acceptReplies.forEach((reply, outpoint) => {
      if (reply?.ok && reply.accepted) {
        this.recordAck(outpoint, sentMs);
        this.recordAcceptance(outpoint, reply.acceptance);
      }
    });
    this.#recoveredUntilMs = null;
    this.#coasting = false;
    this.#state = 'held';
    this.#armDemotion(this.safeUntil() + demotionSlackMs());
    await this.publishRecord();
    log.info(`quorumGrant holder ${this.#key}: stepped across to generation ${next.generation} at epoch ${epoch}`);
    fluxEventBus.publish('quorumGrant:steppedAcross', { key: this.#key, generation: next.generation, epoch });
    return true;
  }

  /**
   * One round's drain refusals from the committee this holder steps across
   * to. When enough of its cells to meet every quorum refused as draining,
   * none of them had first served past the lift when the round was sent, so
   * no stranger can be seated before one lock-delay past that moment.
   */
  #noteDrain(replies, sentMs, next) {
    const { draining } = replies;
    if (!draining || draining.length < next.members.length - next.quorum + 1) return;
    this.#lift = { height: Math.min(...draining), refusedAtMs: sentMs };
  }

  /** What is left of the time a step after the lift has, or null with no drain known. */
  #liftBudgetMs() {
    if (!this.#lift) return null;
    return this.#lift.refusedAtMs + lockDelayMs() - this.#clock() - core.HARD_STOP_MS;
  }

  /**
   * The step-across, one at a time: a caller arriving while a step is on the
   * wire shares its outcome.
   *
   * @returns {Promise<boolean>} whether the holder now holds under the new world
   */
  #stepAcross(options) {
    if (this.#stepping) return this.#stepping;
    this.#stepping = this.#maybeStepAcross(options).finally(() => {
      this.#stepping = null;
      if (this.#liftAgain) {
        this.#liftAgain = false;
        this.#stepAtLift();
      }
    });
    return this.#stepping;
  }

  /**
   * Step across once the committee's drain has lifted, inside what the
   * lock-delay leaves past the last drain refusal.
   *
   * @returns {Promise<boolean>} whether the holder now holds under the new world
   */
  async #stepAtLift() {
    if (this.#stopped || !this.#lift) return false;
    const budgetMs = this.#liftBudgetMs();
    if (budgetMs <= 0) {
      log.info(`quorumGrant holder ${this.#key}: the drain lifted at height ${this.#lift.height} with ${budgetMs}ms of the lock-delay left — not stepping across`);
      this.#lift = null;
      return false;
    }
    return this.#stepAcross({ timeoutMs: Math.min(askTimeoutMs(), Math.floor(budgetMs / 3)) });
  }

  /**
   * A block this node processed. The block that lifts the drain the holder's
   * step-across was refused under is the moment the new committee first
   * serves: the holder steps across then, not at its next pass.
   *
   * @param {number} height
   * @returns {Promise<boolean>} whether the holder now holds under the new world
   */
  async noteBlock(height) {
    if (this.#stopped || !this.#lift || height < this.#lift.height) return false;
    if (this.#stepping) {
      this.#liftAgain = true;
      return this.#stepping;
    }
    return this.#stepAtLift();
  }

  /**
   * The block that lifts a drain can land inside one pass, between the
   * step-across probe (the new cells refused it at their door) and the
   * witness poll (the new cells serve): the pass would demote a holder that
   * steps across on its next one. So attempt the step-across once more before
   * demoting — the register decides it, never this side. The new committee's
   * accept quorum admits the carrier iff no rival was chosen (a chosen rival
   * shields a quorum of cells, which refuses the carrier's prepare); a silent
   * cell changes nothing, since a rival needs a quorum and the carrier reads
   * the rest. The only bound is time: inside what the lock-delay leaves past
   * the last drain refusal and the hard stop, so a demotion is never delayed
   * past a stranger's earliest seat.
   */
  async #stepAcrossBeforeDemoting() {
    return this.#stepAtLift();
  }

  /**
   * A refusal naming a world taken over after the one this node stands in,
   * once it has learned what the refusals taught: the referee has a sale or
   * re-roll this node's chain has not shown it. That is no ground for a
   * coast, which vouches that no takeover is possible; and it is no ground
   * for a step, which needs a world this node can name.
   *
   * @param {?Array<{generation: number, height: ?number}>} named - the worlds the refusing referees named
   * @returns {Promise<?string>} the doubt, or null
   */
  async #doubtNamed(named) {
    if (!named?.length) return null;
    const standing = await currentWorld(this.#key);
    const later = named.find((world) => generationWorld.laterWorld(world, standing));
    return later === undefined
      ? null
      : `a referee names generation ${later.generation} from height ${later.height}, which this node does not stand on`;
  }

  async #assess(quorumRenewed, doubt = null, basis = this.#committee) {
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
      this.#recoveredUntilMs = null;
      this.#armDemotion(safeUntil + demotionSlackMs());
      fluxEventBus.publish('quorumGrant:assess', { ...seen, outcome: 'held' });
      return;
    }

    // The witness rule decides FROM THE FIRST failed renewal, never only
    // past safety: a legitimate coast must already stand when the standing
    // alarm fires, because the alarm no longer waits for a pass to notice
    // the deadline.
    let verdict = { coast: false, reason: doubt };
    if (!doubt) {
      const standbys = await standbysFor(this.#key, this.#identity.outpoint);
      // Zero resolvable witnesses is maximal doubt, and doubt never coasts: a
      // global app always has other instances by spec floor, so an empty set
      // means nobody can vouch that no takeover is possible - unanimity over
      // nobody proved nothing, and it kept an isolated master running.
      const witnessReplies = standbys.length
        ? await pollWitnesses(standbys, this.#key, this.#committee.generation)
        : new Map();
      verdict = standbys.length
        ? core.coastVerdict(standbys.map(outpointOf), witnessReplies, this.#committee)
        : { coast: false, reason: 'no witnesses resolvable' };
      seen.standbys = standbys.length;
      seen.witnessReplies = witnessReplies.size;
      if (this.#stopped || this.#committee !== basis) return;
    }

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
      if (await this.#stepAcrossBeforeDemoting()) {
        fluxEventBus.publish('quorumGrant:assess', { ...seen, outcome: 'steppedAcross' });
        return;
      }
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
      // a step on the wire is bounded by the lock-delay past the last drain
      // refusal: the alarm decides once it has landed, which re-arms it on success
      if (this.#stepping) {
        this.#stepping.then(() => {
          if (this.#stopped || this.#demotionTimer !== null || this.#deadlineTargetMs === null) return;
          this.#armDemotion(this.#deadlineTargetMs);
        });
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
    if (held.get(this.#key) === this) held.delete(this.#key);
    log.warn(`quorumGrant holder ${this.#key}: demoted — ${reason}`);
    fluxEventBus.publish('quorumGrant:demoted', { key: this.#key, reason });
    if (this.#onDemoted) this.#onDemoted(reason);
  }

  /** Stop locally: end the loop and the registry entry, no wire traffic. */
  stop() {
    this.#stopped = true;
    this.#disarmDemotion();
    if (this.#timer !== null) this.#cancel(this.#timer);
    if (held.get(this.#key) === this) held.delete(this.#key);
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
// the ordinal plane's three reads and writes against a oneshot register
// (formal/ordinal-register/RESULTS.md, the build items): a probe folded as a
// QUORUM verdict, a release, and a vacate carrying a certificate.

/**
 * The quorum fold over a oneshot committee's replies: a holder is named only
 * when at least a quorum of cells record the SAME grantee on an unreleased
 * row — never adoptFrom's highest single row, which the model showed
 * adopting a returned holder from the one cell its vacate had not reached
 * ("ask, never count", the rule relearn applies to terms).
 *
 * A cell answers when its reply carries its row, refusals included: the probe
 * rides epoch 1, so every cell promised above it answers `superseded` with
 * its row attached, `accepted: null` when nothing was ever accepted there. A
 * reply with no row attached is not an answer.
 *
 * `named` is every grantee an answering cell holds on an unreleased row. A
 * cell whose node was down misses a write, so a holder can be named on fewer
 * cells than a quorum and still hold a founding off: those are the rows a
 * vacate must reach.
 *
 * @param {Array<object>} replies
 * @param {number} quorum
 * @returns {{decided: boolean, holder: string|null, named: string[], epoch: number}}
 */
function oneshotQuorumFold(replies, quorum) {
  const answered = replies.filter((reply) => reply && (reply.ok === true || reply.accepted !== undefined));
  const counts = new Map();
  let epoch = 0;
  answered.forEach((reply) => {
    const accepted = reply?.accepted;
    if (!accepted || accepted.released || accepted.mode !== 'oneshot') return;
    counts.set(accepted.grantee, (counts.get(accepted.grantee) ?? 0) + 1);
    epoch = Math.max(epoch, accepted.epoch);
  });
  const named = [...counts.entries()].find(([, count]) => count >= quorum);
  return {
    decided: answered.length >= quorum,
    holder: named ? named[0] : null,
    named: [...counts.keys()],
    epoch,
  };
}

/**
 * Probe a oneshot key across its committee and fold the answers as a quorum
 * verdict. Burns no epoch (a probe is a pre-vote).
 *
 * @param {string} key
 * @param {object} committee {members, quorum, fingerprint, generation}
 * @returns {Promise<{decided: boolean, holder: string|null, named: string[], epoch: number}>}
 */
async function probeOneshot(key, committee) {
  const identity = await selfIdentity();
  if (!identity) return { decided: false, holder: null, named: [], epoch: 0 };
  const signed = await signedAskFor('probe', key, 'oneshot', 1, identity, committee);
  if (!signed) return { decided: false, holder: null, named: [], epoch: 0 };
  const replies = await askCommittee(committee.members, 'probe', signed.ask, signed.signature);
  return oneshotQuorumFold([...replies.values()], committee.quorum);
}

/**
 * Give a oneshot row back (an ordinal on uninstall): the grantee-signed
 * release, quorum of acks or nothing.
 *
 * @returns {Promise<boolean>} a quorum of cells released the row
 */
async function releaseOneshot(key, committee, epoch) {
  const identity = await selfIdentity();
  if (!identity) return false;
  const signed = await signedAskFor('release', key, 'oneshot', epoch, identity, committee);
  if (!signed) return false;
  const replies = await askCommittee(committee.members, 'release', signed.ask, signed.signature);
  const acked = [...replies.values()].filter((reply) => reply?.ok === true).length;
  return acked >= committee.quorum;
}

/**
 * Reclaim a oneshot row by certificate: the ask carries the certificate
 * whole (it is self-verifying through the node-down seam on every cell);
 * the submitter signs the ask, not the certificate.
 *
 * @returns {Promise<boolean>} a quorum of cells vacated the row
 */
async function vacateOneshot(key, committee, cert) {
  const identity = await selfIdentity();
  if (!identity) return false;
  const signed = await signedAskFor('vacate', key, 'oneshot', 1, identity, committee, { cert });
  if (!signed) return false;
  const replies = await askCommittee(committee.members, 'vacate', signed.ask, signed.signature);
  const acked = [...replies.values()].filter((reply) => reply?.ok === true).length;
  return acked >= committee.quorum;
}

// ---------------------------------------------------------------------------
// what this node answers its peers

/**
 * The witness answer for a key: what THIS node is doing about it, the world it
 * stands the key in, and whether a quorum of the key's committee would seat
 * this node now — record reads naming this node as the candidate, cheap and
 * unauthenticated, each cell answering what its register would decide.
 */
async function witnessAnswer(key, mode = 'held') {
  const holding = held.has(key);
  const isAcquiring = acquiring.has(key);

  let quorumReachable = false;
  let doubt = false;
  const fingerprint = networkStateService.membershipFingerprint();
  const committee = fingerprint ? await committeeFor(key, mode, fingerprint) : null;
  if (committee) {
    const self = await generalService.obtainNodeCollateralInformation();
    const candidate = encodeURIComponent(`${self.txhash}:${self.txindex}`);
    const probes = committee.members.map(async (member) => {
      try {
        const response = await serviceHelper.axiosGet(
          grantorUrl(member, `/flux/quorumgrant/record?key=${encodeURIComponent(key)}&candidate=${candidate}`),
          { timeout: askTimeoutMs() },
        );
        // A cell that answers reads but is not REFEREEING cannot seat a
        // challenger, and counting it would talk the incumbent out of the
        // coast exactly when the whole fleet's grantors went quiet. Nor can
        // a cell that referees but is not SERVING — in its rejoin drain or
        // the key's generation drain (the drain-aware coast, formal/quiet-
        // window rows 23 and 29–31): a restart wave is committee-down until
        // the drains lift, and the register anchors every successor's wait
        // at that lift. An absent field is an older node and counts as it
        // always did.
        await learnGeneration(key, committee.generation, response?.data?.data);
        // A cell standing in a world taken over after this node's has a sale
        // or re-roll this node's chain has not shown it: this node polled the
        // wrong committee for whether a takeover is possible, so it cannot
        // vouch that none is.
        const answered = response?.data?.data;
        if (Number.isSafeInteger(answered?.generation)
          && generationWorld.laterWorld({ generation: answered.generation, height: answered.height }, committee)) {
          doubt = true;
        }
        // a cell counts when it would seat this node now; an older node
        // without the verdict counts as serving
        return response?.data?.status === 'success'
          && response.data.data?.refereeing !== false
          && response.data.data?.serving !== false
          && response.data.data?.seats !== false;
      } catch (error) {
        return false;
      }
    });
    const answers = await Promise.all(probes);
    quorumReachable = answers.filter(Boolean).length >= committee.quorum;
  }

  // The answer teaches too: a master whose committee has gone dark to it
  // still polls its witnesses, and a witness that knows the standing
  // generation is the master's remaining way to hear its world ended.
  const generationRecord = await knownGenerationRecord(key);
  const standing = await currentWorld(key);
  return {
    holding,
    acquiring: isAcquiring,
    quorumReachable,
    doubt,
    world: { generation: standing.generation, height: standing.height },
    generation: generationRecord?.generation ?? 0,
    generationRecord,
  };
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

  // The ask may carry overlay state newer than anything this carrier has
  // seen published — a heal or a cancellation that just happened. The roster
  // chain is self-verifying, so verify and honor it: otherwise a freshly
  // seated grantor reachable only through relays would never hear a word.
  // The cancel chain steers only who is asked, so it is adopted on shape
  // like every other routing read.
  let { members } = committee;
  if ((ask.mode ?? 'held') === 'held') {
    const membership = networkStateService.membershipAt(ask.fingerprint);
    if (membership) {
      let chainMembers = committee.chainMembers ?? committee.members;
      let { chain } = committee;
      if (Array.isArray(ask.chain)
        && ask.chain.length > committee.chain.length
        && rosterOverlay.chainWellFormed(ask.chain)) {
        const verified = rosterOverlay.verifyChain(
          membership, ask.key, ask.fingerprint, ask.generation ?? 0, committeeSizeFor('held'), ask.chain,
        );
        if (verified) {
          ({ members: chainMembers } = verified);
          ({ chain } = ask);
        }
      }
      let { cancels = [] } = committee;
      if (Array.isArray(ask.cancels)
        && ask.cancels.length > cancels.length
        && rosterOverlay.cancelChainWellFormed(ask.cancels)) {
        ({ cancels } = ask);
      }
      members = cancelledApplied(
        membership, rosterOverlay.walkKeyFor(ask.key, ask.generation ?? 0), chainMembers, chain, cancels,
      );
    }
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
  couriers.forEach((courier) => { if (courier.timer) courierCancel(courier.timer); });
  couriers.clear();
  worldsReceived.clear();
}

function stopHolder(holder) {
  holder.stop();
}

async function pollWitnesses(standbys, key, askedGeneration) {
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
      const reply = response?.data?.data ?? null;
      await learnGeneration(key, askedGeneration, reply);
      return { outpoint: outpointOf(standby), reply };
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

/**
 * A block this node processed: every holder whose step-across waits on a
 * drain lifting at or below it steps across now.
 *
 * @param {number} height
 * @returns {Promise<boolean[]>} each holder's outcome
 */
function noteBlock(height) {
  return Promise.all([...held.values()].map((holder) => holder.noteBlock(height).catch((error) => {
    log.error(`quorumGrant holder ${holder.key}: ${error.message}`);
    return false;
  })));
}

/** The live Holder for a key on this node, or null. */
function holderFor(key) {
  return held.get(key) ?? null;
}

/**
 * The store's word that a generation record stands for a key — registered
 * with messageStore.onGrantGenerationRecord by the service wiring. Only a
 * holder of that key has anything to do about it.
 */
function noteGenerationRecord({ identity, role, generation }) {
  const key = `${identity}/${role}`;
  const holder = held.get(key);
  const noted = holder
    ? holder.noteGeneration().catch((error) => log.error(`quorumGrant holder ${key}: ${error.message}`))
    : Promise.resolve();
  return Promise.all([noted, startCourier(key, generation)]);
}

// ---------------------------------------------------------------------------
// the generation courier - the look-ahead's push half
//
// A stranger can seat only at cells that HOLD the re-roll record, so the cells
// that hold it are the one source a record-deaf master always has
// (formal/quiet-window family K, LookAheadProbe; COMMITTEE_RECOVERY_DESIGN.md
// 2026-09-05: the master watches the door, not the mail). When a generation
// record lands as the standing one and THIS node sits on the committee that
// generation draws, it carries the record to every instance of the app - the
// master among them, and the standbys that witness for it - and carries it
// again each renewal interval until each acknowledges, for one maximum term.
// Nothing at rest; a re-roll costs one call per new-committee cell per
// instance. The record is the owner's signed statement and the receiver
// stores it on the path a broadcast takes, so this is a courier, not an
// authority: the worst courier is a silent one. The receiver's answer is the
// generation it now holds; at or above the carried one, the delivery is done.
const couriers = new Map(); // key -> { generation, targets, attempt, until, timer }
// the retry scheduler, injectable like a holder's - a test drives it by hand
let courierSchedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  if (timer.unref) timer.unref();
  return timer;
};
let courierCancel = (timer) => clearTimeout(timer);

function courierHorizonMs() {
  return config.get('fluxapps.quorumGrantMaxTtlMs');
}

async function selfOutpoint() {
  const collateral = await generalService.obtainNodeCollateralInformation();
  return collateral?.txhash ? `${collateral.txhash}:${collateral.txindex}` : null;
}

/** Whether this node sits on the committee the given generation draws for a key. */
async function onCommitteeOf(key, generation, self) {
  const fingerprint = networkStateService.membershipFingerprint();
  const membership = fingerprint ? networkStateService.membershipAt(fingerprint) : null;
  if (!membership) return false;
  const committee = selectCommittee(membership, rosterOverlay.walkKeyFor(key, generation), { size: committeeSizeFor('held') });
  if (committee.refusal) return false;
  return committee.members.some((member) => outpointOf(member) === self);
}

function startCourier(key, generation) {
  const standing = couriers.get(key);
  if (standing) {
    if (standing.generation >= generation) return Promise.resolve();
    if (standing.timer) courierCancel(standing.timer);
    couriers.delete(key);
  }
  const courier = {
    generation, targets: null, attempt: 0, until: Date.now() + courierHorizonMs(), timer: null,
  };
  couriers.set(key, courier);
  return courierRound(key, courier).catch((error) => {
    log.warn(`quorumGrant courier ${key}: ${error.message}`);
    if (couriers.get(key) === courier) couriers.delete(key);
  });
}

async function courierRound(key, courier) {
  if (couriers.get(key) !== courier) return;
  const record = await knownGenerationRecord(key);
  if (!record || record.generation !== courier.generation) {
    couriers.delete(key);
    return;
  }
  if (courier.targets === null) {
    const self = await selfOutpoint();
    if (!self || !(await onCommitteeOf(key, courier.generation, self))) {
      couriers.delete(key);
      return;
    }
    // every instance of the app but this node: standbysFor is that list
    courier.targets = new Map((await standbysFor(key, self)).map((node) => [outpointOf(node), node]));
  }
  courier.attempt += 1;
  await Promise.all([...courier.targets.entries()].map(async ([outpoint, node]) => {
    try {
      const response = await serviceHelper.axiosPost(
        grantorUrl(node, '/flux/quorumgrant/teach'),
        { record },
        { timeout: askTimeoutMs(), httpAgent: askAgent },
      );
      const standing = response?.data?.data?.generation;
      if (Number.isSafeInteger(standing) && standing >= courier.generation) courier.targets.delete(outpoint);
    } catch (error) {
      // silent or refusing: carried again next interval
    }
  }));
  // publish() is a no-op outside the harness
  fluxEventBus.publish('quorumGrant:generationCarried', {
    key, generation: courier.generation, attempt: courier.attempt, remaining: courier.targets.size,
  });
  if (courier.targets.size === 0 || Date.now() >= courier.until) {
    couriers.delete(key);
    return;
  }
  // the callback hands its round back so a scheduler that awaits it (the
  // tests') sees the round complete; a timer ignores the return
  courier.timer = courierSchedule(() => {
    courier.timer = null;
    return courierRound(key, courier).catch((error) => {
      log.warn(`quorumGrant courier ${key}: ${error.message}`);
      if (couriers.get(key) === courier) couriers.delete(key);
    });
  }, renewIntervalMs());
}

/** Test seam: the courier's retry scheduler. */
function setCourierSchedulerForTests(schedule, cancel) {
  courierSchedule = schedule;
  courierCancel = cancel;
}

/** Whether an acquisition for the key is currently in flight. */
function isAcquiring(key) {
  return acquiring.has(key);
}

module.exports = {
  acquire,
  termLapsed,
  worldReceiptWaitMs,
  holderFor,
  relearn,
  isAcquiring,
  witnessAnswer,
  noteBlock,
  noteGenerationRecord,
  setCourierSchedulerForTests,
  carryAsk,
  Holder,
  probeOneshot,
  releaseOneshot,
  vacateOneshot,
  oneshotQuorumFold,
  resetForTests,
};
