'use strict';

const config = require('config');
const messageHelper = require('../messageHelper');
const serviceHelper = require('../serviceHelper');
const generalService = require('../generalService');
const fluxCommunicationUtils = require('../fluxCommunicationUtils');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const networkStateService = require('../networkStateService');
const registryManager = require('../appDatabase/registryManager');
const messageStore = require('../appMessaging/messageStore');
const foundingCommittee = require('../appMesh/foundingCommittee');
const { extractIp, extractPort } = require('../utils/socketAddressUtils');
const { selectCommittee } = require('../utils/committeeSelector');
const fluxEventBus = require('../utils/fluxEventBus');
const signedEnvelope = require('./signedEnvelope');
const rosterOverlay = require('./rosterOverlay');
const grantRegister = require('./grantRegister');
const { MODES } = require('./grantRegisterCore');
const core = require('./grantClientCore');
const log = require('../../lib/log');

// The node-to-node face of the grantor. A grant is a WRITE, unlike almost
// every other node-to-node call, so unlike the limit counter this surface is
// authenticated — three claims are checked on every ask, each against state
// this node already holds, never against anything the request asserts about
// itself:
//
//   - the asker IS who it names: the ask carries a collateral outpoint, the
//     named node's registered address must be where the TCP connection comes
//     from, and the signature must verify against that node's registered
//     key. Wearing another node's name means signing with its key from its
//     address.
//   - this node IS a committee member for the key, or 409 — a grantor that
//     answered for committees it does not sit on would be a grantor for
//     anyone who asked, which is not a grantor.
//   - the asker HOLDS the app the key names, per this node's own view of the
//     app's locations. This ships WITH the endpoint rather than with the
//     consumers: a ONE-SHOT register is write-once, so an unguarded inert
//     endpoint would let anyone pre-claim a future app's founder register —
//     squatting founding, permanently. Holding the app is the one thing a
//     squatter cannot fake from outside placement.
//
// Every validation happens at reply time, on this request, from current
// state — never from a decision queued earlier (the Jepsen etcd 3.4.3
// lesson). What the register then decides is grantRegisterCore's job.

// A founder key's role carries its world anchor (`founder-<component>@<height>`)
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\/[a-zA-Z0-9-]{1,64}(@\d{1,10})?$/;
// register rows additionally carry a founder round's generation suffix
const ROW_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\/[a-zA-Z0-9-]{1,64}(@\d{1,16}){0,2}$/;
const FOUNDER_ROLE_PATTERN = /^founder-([a-f0-9]{16})@(\d{1,10})$/;
const OUTPOINT_PATTERN = /^[0-9a-f]{64}:\d{1,6}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

// Per-peer ceiling on asks, the limit counter's discipline: the checks above
// bound what a peer can do; this bounds how fast it can try.
//
// The ceiling binds per (caller-host → this-grantor) PAIR and is shared by
// every app the pair interacts over. At production cadences one app costs a
// pair roughly 3 asks/min mastered (renewals every ~20s) or ~2-6 asks/min
// as a resting standby (term-lapse probes), so the default 600/min supports
// on the order of 100+ co-hosted activeStandby apps sharing one referee.
// Beyond that density raise quorumGrantPeerAsksPerMinute — starvation shows
// as `rateLimited` in the served events, never silently.
const PEER_WINDOW_MS = 60 * 1000;
const peerAsks = new Map(); // host -> { windowStart, count }

function peerMaxAsks() {
  return config.fluxapps.quorumGrantPeerAsksPerMinute ?? 600;
}

function askFreshnessMs() {
  return config.fluxapps.quorumGrantAskFreshnessMs ?? 120_000;
}

function committeeSize(mode) {
  if (mode === 'oneshot') return config.fluxapps.quorumGrantOneshotCommitteeSize ?? 9;
  // nine referees, majority five: with self-healing rosters reclaiming dark
  // seats, the wider committee prices nothing and cuts static dark exposure
  return config.fluxapps.quorumGrantHeldCommitteeSize ?? 9;
}

function minHolderAgeMs() {
  return config.fluxapps.quorumGrantMinHolderAgeMs ?? 420_000;
}

function peerAllowed(host) {
  const now = Date.now();
  const seen = peerAsks.get(host);
  if (!seen || now - seen.windowStart >= PEER_WINDOW_MS) {
    peerAsks.set(host, { windowStart: now, count: 1 });
    return true;
  }
  seen.count += 1;
  return seen.count <= peerMaxAsks();
}

function callerHost(req) {
  const raw = (req.socket && req.socket.remoteAddress) || '';
  // node reports IPv4 callers as IPv6-mapped addresses on dual-stack sockets
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

/**
 * The current generation for a held key: the newest owner-signed record on
 * the event plane as this node has synced it, 0 when the owner has never
 * re-rolled. What every held ask's named generation is judged against.
 */
async function heldGeneration(key) {
  const slash = key.indexOf('/');
  const record = await messageStore.getGrantGenerationRecord(key.slice(0, slash), key.slice(slash + 1));
  return record?.data?.generation ?? 0;
}

function bad(code, message) {
  return { ok: false, code, message };
}

/**
 * Parse and verify one ask: shapes, freshness, identity, signature. Returns
 * the ask plus the node record the identity resolved to — later checks reuse
 * it rather than looking the asker up twice.
 */
async function readAsk(req, type) {
  const body = serviceHelper.ensureObject(req.body) ?? {};
  const {
    key, mode, epoch, candidate, ttlMs, generation, fingerprint, at, signature,
    remove, add, seq, chain,
  } = body;

  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    return bad(400, 'malformed key');
  }
  const needsMode = type === 'probe' || type === 'prepare' || type === 'accept';
  if (needsMode && !MODES.includes(mode)) {
    return bad(400, 'malformed mode');
  }
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    return bad(400, 'malformed epoch');
  }
  if (typeof candidate !== 'string' || !OUTPOINT_PATTERN.test(candidate)) {
    return bad(400, 'malformed candidate');
  }
  const needsTtl = type === 'renew' || (type === 'accept' && mode === 'held');
  if (needsTtl && (!Number.isSafeInteger(ttlMs) || ttlMs < 1)) {
    return bad(400, 'malformed ttl');
  }
  if (typeof fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(fingerprint)) {
    return bad(400, 'malformed fingerprint');
  }
  if (!Number.isSafeInteger(generation) || generation < 0) {
    return bad(400, 'malformed generation');
  }
  if (type === 'roster') {
    if (typeof remove !== 'string' || !OUTPOINT_PATTERN.test(remove)) {
      return bad(400, 'malformed remove');
    }
    if (typeof add !== 'string' || !OUTPOINT_PATTERN.test(add)) {
      return bad(400, 'malformed add');
    }
    if (!Number.isSafeInteger(seq) || seq < 1) {
      return bad(400, 'malformed seq');
    }
  }
  // Any held ask may carry the holder's roster chain — self-verifying on its
  // own signatures and outside the ask's signature, so a carrier stripping
  // it costs liveness, never safety. Shape-gated here; verified where used.
  if (chain !== undefined && !rosterOverlay.chainWellFormed(chain)) {
    return bad(400, 'malformed chain');
  }
  if (!Number.isSafeInteger(at) || Math.abs(Date.now() - at) > askFreshnessMs()) {
    return bad(400, 'stale ask');
  }
  if (typeof signature !== 'string' || !signature) {
    return bad(400, 'missing signature');
  }

  const nodes = await fluxCommunicationUtils.deterministicFluxList();
  const askerNode = (nodes || []).find(
    (node) => `${node.txhash}:${node.outidx}` === candidate,
  );
  if (!askerNode) {
    return bad(403, 'candidate is not a listed node');
  }
  if (type === 'renew') {
    // The one carrier-independent ask: any holder may deliver a renewal, so
    // the caller is not required to BE the candidate — authenticity is the
    // candidate's signature verified below, and replay is bounded by the
    // freshness window and can only extend the named incumbent's term. The
    // carrier must still be a listed node. Every term-changing ask below
    // keeps the stricter source binding.
    const caller = callerHost(req);
    if (!(nodes || []).some((node) => extractIp(node.ip) === caller)) {
      return bad(403, 'caller is not a listed node');
    }
  } else if (extractIp(askerNode.ip) !== callerHost(req)) {
    // Both sides named, or the refusal cannot be diagnosed from the caller's
    // side: it only ever learns this message.
    return bad(403, `ask does not originate from the candidate (listed ${extractIp(askerNode.ip)}, caller ${callerHost(req)})`);
  }

  const ask = {
    key, mode, epoch, candidate, ttlMs, generation, fingerprint, at, remove, add, seq, chain,
  };
  const fields = signedEnvelope.fieldsFor(type, ask);
  if (!fields || !signedEnvelope.verify(type, fields, signature, askerNode.pubkey)) {
    return bad(403, 'signature does not verify');
  }

  return { ok: true, ask, askerNode };
}

/**
 * Whether THIS node sits on the committee for the key. The mode names the
 * plane, and the two planes answer from different state.
 *
 * Oneshot keys are founder registers, and their committee is the app's
 * founding committee: the record every node materialized when it processed
 * the registration, read back with the same exit arithmetic the candidates
 * run. Answering from the record instead of rebuilding the walk is what
 * lets a grantor whose own membership window never covered the ask's basis
 * still answer — the photo outlives the album — and it is what makes the
 * committee per-app: one founding committee referees every component's
 * founder register.
 *
 * Held keys pin to the membership the ask NAMES. The fingerprint decides
 * WHICH list; a fingerprint this node cannot rebuild is a committee this
 * node cannot verify membership of, and it says so rather than substituting
 * the current list — tolerance matching is how quorum overlap quietly stops
 * being an intersection. Fails closed throughout: a node that cannot
 * identify itself cannot show it belongs.
 *
 * The held committee is one deal of a generation-salted walk: the
 * ask names the generation, and it must be the newest one the owner has
 * signed as this grantor knows it — an ask under a retired generation is
 * refused with the current number, because grants written by two
 * generations' committees against one register are two masters. The base
 * is then read THROUGH the roster overlay: this grantor's own journaled
 * chain applies as written, and a longer chain carried on the ask applies
 * after full verification against the same membership — which is how a
 * freshly seated replacement, whose register has never heard of the key,
 * knows to answer for it.
 */
async function selfOnCommittee(key, mode, fingerprint, generation, carriedChain) {
  if (mode === 'oneshot') {
    const role = key.slice(key.indexOf('/') + 1);
    const founderRole = FOUNDER_ROLE_PATTERN.exec(role);
    if (!founderRole) {
      return { member: false, code: 409, reason: 'not a founder register' };
    }
    // Component-blind: the token is opaque to a referee, and the anchor is
    // served iff this node photographed that spec height — which components
    // exist is knowledge only the hosts hold, and a referee never needs it.
    const collateral = await generalService.obtainNodeCollateralInformation();
    const founding = await foundingCommittee.selfOnFoundingCommittee(
      key.slice(0, key.indexOf('/')), Number(founderRole[2]), fingerprint, generation, collateral,
    );
    return {
      member: founding.member,
      code: founding.member ? 200 : 409,
      reason: founding.reason,
      quorum: founding.quorum,
    };
  }

  const membership = networkStateService.membershipAt(fingerprint);
  if (!membership) {
    return { member: false, code: 409, reason: 'unknown membership fingerprint' };
  }

  const current = await heldGeneration(key);
  if (generation !== current) {
    return { member: false, code: 409, reason: `ask names generation ${generation}, current is ${current}` };
  }

  const walkKey = rosterOverlay.walkKeyFor(key, generation);
  const committee = selectCommittee(membership, walkKey, { size: committeeSize('held') });
  if (committee.refusal) {
    return { member: false, code: 409, reason: committee.refusal };
  }

  let { members } = committee;
  const stored = await grantRegister.read(key);
  const journaled = stored?.roster?.fingerprint === fingerprint
    && (stored.roster.generation ?? 0) === generation
    ? stored.roster.chain : [];
  if (journaled.length) {
    members = rosterOverlay.rosterAfter(committee.members, membership, journaled) ?? members;
  }
  if (Array.isArray(carriedChain) && carriedChain.length > journaled.length) {
    const verified = rosterOverlay.verifyChain(
      membership, key, fingerprint, generation, committeeSize('held'), carriedChain,
    );
    if (verified) ({ members } = verified);
  }

  const collateral = await generalService.obtainNodeCollateralInformation();
  const member = members.some(
    (node) => node.txhash === collateral.txhash
      && String(node.outidx) === String(collateral.txindex),
  );
  // Seated by a CHAIN rather than by the base walk - a tier-1 heal added this
  // node. That is the seat F1 is about: a heal is a swap, so the majorities
  // either side of it can be disjoint, and an added seat that answers before it
  // knows the standing term is exactly the swing vote a challenger needs.
  const seatedByChain = member && !committee.members.some(
    (node) => node.txhash === collateral.txhash
      && String(node.outidx) === String(collateral.txindex),
  );
  return {
    member,
    seatedByChain,
    members,
    code: member ? 200 : 409,
    reason: member ? null : 'this node is not on that committee',
    quorum: committee.quorum,
    rung: committee.rung,
  };
}

/**
 * F1: an added seat adopts the standing term before it serves.
 *
 * A tier-1 heal is a SWAP - remove X, add Y in one step - and majorities either
 * side of a swap can be disjoint: {A,B,X} -> {A,B,Y} leaves {B,X} and {A,Y}
 * sharing nobody. X is only "dark" from someone's point of view, and a
 * partitioned X votes happily. So the new seat must not be able to crown a
 * second master: it reads the standing term off a quorum of its own committee,
 * writes it into its register, and only then answers.
 *
 * FAILS CLOSED. A fresh seat that cannot reach a quorum to ask does not serve -
 * it has no state and no way to get any, and answering from that position is
 * the whole defect.
 *
 * This is what §5 already requires of a ONE-SHOT re-pin ("state transfer with
 * an activation gate"); §7.1 never said it for HELD additions.
 *
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
async function adoptStandingTerm(ask, committee) {
  const stored = await grantRegister.read(ask.key);
  // Already holds state for this key: nothing to adopt, and adopting over it
  // would be a fresh seat overwriting a row it earned.
  if (stored?.accepted) return { ok: true, reason: null };

  const self = await generalService.obtainNodeCollateralInformation();
  const peers = (committee.members || []).filter(
    (node) => !(node.txhash === self.txhash && String(node.outidx) === String(self.txindex)),
  );
  const reads = peers.map(async (node) => {
    try {
      const response = await serviceHelper.axiosGet(
        `http://${extractIp(node.ip)}:${extractPort(node.ip)}/flux/quorumgrant/record`
          + `?key=${encodeURIComponent(ask.key)}`,
        { timeout: config.fluxapps.quorumGrantAskTimeoutMs ?? 5_000 },
      );
      const data = response?.data?.data;
      if (!data) return null;
      if (!data.accepted) return { answered: true };
      return {
        answered: true,
        grantee: data.accepted.grantee,
        epoch: data.accepted.epoch,
        remainingMs: data.remainingMs,
      };
    } catch (error) {
      return null;
    }
  });
  const answers = (await Promise.all(reads)).filter(Boolean);
  if (answers.length < committee.quorum) {
    return { ok: false, reason: 'a freshly seated grantor cannot reach a quorum to adopt the standing term' };
  }

  const term = core.quorumTerm(answers.filter((reply) => reply.grantee), committee.quorum);
  // A quorum answered and no term stands: there is nothing to adopt and this
  // seat may serve. Distinct from not being able to ASK, which refuses above.
  if (!term.grantee) return { ok: true, reason: null };

  await grantRegister.adopt(ask.key, {
    epoch: term.epoch,
    grantee: term.grantee,
    remainingMs: term.remainingMs,
    generation: ask.generation,
    fingerprint: ask.fingerprint ?? null,
  });
  log.info(`quorumGrant grantorController: fresh seat adopted ${ask.key} epoch ${term.epoch} for ${term.grantee}`);
  return { ok: true, reason: null };
}

/**
 * Whether the asker holds the app the key names, from this node's own
 * locations view — the anti-squat rule. For HELD challenges of an existing
 * record the row must also be old enough that every grantor and the
 * incumbent's witness poll can already see it (§7's minimum-holder-age
 * floor); a first-ever acquisition is exempt, or a fresh app could not seat
 * its first master until the floor ran.
 */
async function askerHolds(ask, askerNode, type) {
  const appName = ask.key.slice(0, ask.key.indexOf('/'));
  const rows = await registryManager.appLocation(appName);
  const askerHost = extractIp(askerNode.ip);
  const row = (rows || []).find((location) => extractIp(location.ip) === askerHost);
  if (!row) return { holds: false, reason: 'not a holder of the app' };

  const challengeOps = type === 'prepare' || type === 'accept';
  if (ask.mode === 'held' && challengeOps && minHolderAgeMs() > 0) {
    const record = await grantRegister.read(ask.key);
    // The floor binds CHALLENGERS only, never the recorded grantee — the
    // same principle as lock-delay. The incumbent's repair chore re-accepts
    // (and, past a residue promise, re-acquires) its own term through these
    // very ops, and holding it to a challenge floor would strand a young
    // master with an answering-empty cell it cannot repair.
    if (record?.accepted && record.accepted.grantee !== ask.candidate) {
      const since = row.runningSince ?? row.broadcastedAt ?? null;
      const age = since !== null ? Date.now() - new Date(since).getTime() : 0;
      if (!Number.isFinite(age) || age < minHolderAgeMs()) {
        return { holds: false, reason: 'holder too young to challenge' };
      }
    }
  }

  return { holds: true };
}

/**
 * The shared gauntlet, then the register. One shape for every op so the
 * client sees one protocol, not five endpoints with opinions.
 */
async function serve(req, res, type, operate) {
  // Stage timings, published win or lose: the caller's 5s budget dies
  // SOMEWHERE in this gauntlet and nothing else says where. The ask's own
  // key/epoch/candidate and the operate verdict's refusal code ride along
  // once known — solving the 1205 fight from archived captures took an hour
  // of cross-cell arithmetic to recover exactly these four fields. publish()
  // is a no-op outside the harness.
  const t0 = Date.now();
  const ms = {};
  let askSeen = null;
  function report(outcome, code) {
    fluxEventBus.publish('quorumGrant:served', {
      type,
      outcome,
      total: Date.now() - t0,
      ...(askSeen ? { key: askSeen.key, epoch: askSeen.epoch, candidate: askSeen.candidate } : {}),
      ...(code ? { code } : {}),
      ...ms,
    });
  }
  try {
    const host = callerHost(req);
    if (!peerAllowed(host)) {
      report('rateLimited');
      return res.status(429).json(messageHelper.createErrorMessage('too many grant asks'));
    }

    const read = await readAsk(req, type);
    ms.read = Date.now() - t0;
    if (!read.ok) {
      report('refusedRead');
      return res.status(read.code).json(messageHelper.createErrorMessage(read.message));
    }
    const { ask, askerNode } = read;
    askSeen = ask;

    const committee = await selfOnCommittee(ask.key, ask.mode ?? 'held', ask.fingerprint, ask.generation, ask.chain);
    ms.committee = Date.now() - t0 - ms.read;
    if (!committee.member) {
      report('refusedCommittee');
      return res.status(committee.code).json(messageHelper.createErrorMessage(committee.reason));
    }

    // F1: a seat a heal ADDED knows nothing about the standing term, and a
    // heal is a swap whose two majorities can be disjoint. It adopts before it
    // answers, or it does not answer.
    if (committee.seatedByChain && (ask.mode ?? 'held') === 'held') {
      const adopted = await adoptStandingTerm(ask, committee);
      if (!adopted.ok) {
        report('refusedUnadopted');
        return res.status(409).json(messageHelper.createErrorMessage(adopted.reason));
      }
    }

    if (type !== 'probe') {
      const holding = await askerHolds(ask, askerNode, type);
      ms.holds = Date.now() - t0 - ms.read - ms.committee;
      if (!holding.holds) {
        report('refusedHolder');
        return res.status(403).json(messageHelper.createErrorMessage(holding.reason));
      }
    }

    const reply = await operate(ask);
    ms.operate = Date.now() - t0 - ms.read - ms.committee - (ms.holds ?? 0);
    report('served', reply?.ok === false ? reply.code : undefined);
    return res.json(messageHelper.createDataMessage(reply));
  } catch (error) {
    report('errored');
    log.error(`quorumGrant grantorController ${type}: ${error.message}`);
    return res.status(500).json(messageHelper.createErrorMessage(error.message));
  }
}

/**
 * The register row an ask addresses. A founder register is one write-once
 * cell PER GENERATION — `<key>@<generation>`, generation 0 included — so a
 * re-found runs a fresh round instead of adopting the retired world's
 * founder from a surviving grantor's old cell, which a durable oneshot row
 * would otherwise teach forever. Held rows stay bare: one row is shared
 * across generations by design, epochs continuing monotonically through it
 * while the committee changes around it.
 */
function registerRowFor(ask) {
  return ask.mode === 'oneshot' ? `${ask.key}@${ask.generation}` : ask.key;
}

async function probe(req, res) {
  return serve(req, res, 'probe', (ask) => grantRegister.probe(registerRowFor(ask), {
    epoch: ask.epoch, candidate: ask.candidate,
  }));
}

async function prepare(req, res) {
  return serve(req, res, 'prepare', (ask) => grantRegister.prepare(registerRowFor(ask), {
    epoch: ask.epoch, candidate: ask.candidate,
  }));
}

async function accept(req, res) {
  return serve(req, res, 'accept', (ask) => grantRegister.accept(registerRowFor(ask), {
    epoch: ask.epoch,
    grantee: ask.candidate,
    mode: ask.mode,
    ttlMs: ask.ttlMs,
    generation: ask.generation,
    fingerprint: ask.fingerprint ?? null,
  }));
}

async function renew(req, res) {
  return serve(req, res, 'renew', (ask) => grantRegister.renew(ask.key, {
    epoch: ask.epoch, grantee: ask.candidate, ttlMs: ask.ttlMs,
  }));
}

async function release(req, res) {
  return serve(req, res, 'release', (ask) => grantRegister.release(ask.key, {
    epoch: ask.epoch, grantee: ask.candidate,
  }));
}

/**
 * The register half of one roster proposal: resolve the membership the ask
 * names, verify any carried chain against it, let the core judge, and —
 * only after the journal write inside the register — sign this grantor's
 * acceptance over the exact entry recorded. The signature is the one thing
 * an unsigned reply channel cannot give the holder: a quorum of these makes
 * the entry a self-verifying object.
 */
async function operateRoster(ask) {
  const membership = networkStateService.membershipAt(ask.fingerprint);
  if (!membership) {
    return { ok: false, code: 'unknown_fingerprint' };
  }

  let verifiedCarriedChain;
  if (Array.isArray(ask.chain) && ask.chain.length) {
    const verified = rosterOverlay.verifyChain(
      membership, ask.key, ask.fingerprint, ask.generation, committeeSize('held'), ask.chain,
    );
    if (!verified) {
      return { ok: false, code: 'bad_chain' };
    }
    verifiedCarriedChain = ask.chain;
  }

  const reply = await grantRegister.roster(ask.key, {
    epoch: ask.epoch,
    candidate: ask.candidate,
    remove: ask.remove,
    add: ask.add,
    seq: ask.seq,
    generation: ask.generation,
    fingerprint: ask.fingerprint,
    at: ask.at,
  }, {
    key: ask.key,
    membership,
    committeeSize: committeeSize('held'),
    verifiedCarriedChain,
  });

  if (!reply.ok) return reply;

  const collateral = await generalService.obtainNodeCollateralInformation();
  const wif = await fluxNetworkHelper.getFluxNodePrivateKey();
  const fields = signedEnvelope.fieldsFor('rosteraccept', {
    key: ask.key,
    fingerprint: ask.fingerprint,
    generation: ask.generation,
    seq: ask.seq,
    remove: ask.remove,
    add: ask.add,
  });
  const signed = wif ? signedEnvelope.sign('rosteraccept', fields, wif) : null;
  if (!signed) {
    // journaled but unable to attest: answer as a refusal so the holder
    // counts this grantor's silence, not a half-acceptance
    return { ok: false, code: 'unavailable' };
  }
  return {
    ...reply,
    acceptance: {
      grantor: `${collateral.txhash}:${collateral.txindex}`,
      signature: signed.signature,
    },
  };
}

async function roster(req, res) {
  return serve(req, res, 'roster', operateRoster);
}

/**
 * The recorded register state for a key — public facts (epoch, grantee),
 * unauthenticated like every other node-to-node read, and served during the
 * drain. What the harness asserts against and catch-up paths consult.
 */
async function record(req, res) {
  try {
    const key = req.params.key ?? req.query.key;
    if (typeof key !== 'string' || !ROW_PATTERN.test(key)) {
      return res.status(400).json(messageHelper.createErrorMessage('malformed key'));
    }
    const generation = Number(req.query.generation ?? 0);
    if (!Number.isInteger(generation) || generation < 0) {
      return res.status(400).json(messageHelper.createErrorMessage('malformed generation'));
    }
    // A founder register is one cell per generation (registerRowFor): a
    // logical founder key addresses its generation's cell, default 0. Any
    // other key — held, or an explicit row id — reads verbatim.
    const role = key.slice(key.indexOf('/') + 1);
    const row = FOUNDER_ROLE_PATTERN.test(role)
      ? registerRowFor({ mode: 'oneshot', key, generation })
      : key;
    const stored = await grantRegister.read(row);
    // §7 ships DURATIONS, never deadlines. `expiresAt` is a figure on THIS
    // grantor's clock and a reader that adds it to its own is comparing a
    // remote timestamp to a local one - which §7 forbids in as many words, and
    // which the model found inside the first proposed recovery fix, where it
    // broke at every margin because the flaw is the conversion rather than any
    // gap. So the read also answers what is LEFT, subtracted here, and a
    // recovering holder acts on that and never on expiresAt.
    //
    // null is not zero: a one-shot founding is durable and carries no expiry,
    // and reading that as "lapsed" would be a different answer entirely.
    const expiresAt = stored?.accepted?.expiresAt;
    const remainingMs = Number.isFinite(expiresAt)
      ? Math.max(0, expiresAt - Date.now())
      : null;
    return res.json(messageHelper.createDataMessage({
      key,
      promisedEpoch: stored?.promisedEpoch ?? 0,
      accepted: stored?.accepted ?? null,
      remainingMs,
      roster: stored?.roster ?? null,
    }));
  } catch (error) {
    log.error(`quorumGrant grantorController record: ${error.message}`);
    return res.status(500).json(messageHelper.createErrorMessage(error.message));
  }
}

/**
 * The founding basis this node's own photo holds for one app anchor —
 * fingerprint, generation, quorum, members. A routing aid for photo-less
 * hosts, never a trust grant: every grantor an asker then reaches verifies
 * the ask against ITS OWN photo and the register is write-once, so a lying
 * answer here can only misroute asks to nodes that refuse. Public facts,
 * unauthenticated like the record read; an absent photo answers null.
 */
async function foundingBasis(req, res) {
  try {
    const appName = req.query.app;
    const anchor = Number(req.query.anchor);
    if (typeof appName !== 'string' || !appName || appName.length > 200
      || !Number.isInteger(anchor) || anchor <= 0) {
      return res.status(400).json(messageHelper.createErrorMessage('malformed founding basis query'));
    }
    // Resolve the asked world to THIS node's newest rung — a host missing
    // a flip it never witnessed discovers the current basis, not the one
    // it asked about.
    const rung = await foundingCommittee.newestRungFor(appName, anchor);
    if (rung === null) {
      return res.json(messageHelper.createDataMessage({ rung: null, basis: null }));
    }
    const committee = await foundingCommittee.refereeCommittee(appName, rung);
    if (!committee) {
      return res.json(messageHelper.createDataMessage({ rung, basis: null }));
    }
    return res.json(messageHelper.createDataMessage({
      rung,
      basis: {
        fingerprint: committee.fingerprint,
        generation: committee.generation,
        quorum: committee.quorum,
        members: committee.members,
      },
    }));
  } catch (error) {
    log.error(`quorumGrant grantorController foundingBasis: ${error.message}`);
    return res.status(500).json(messageHelper.createErrorMessage(error.message));
  }
}

/** Test seam. */
function reset() {
  peerAsks.clear();
}

module.exports = {
  probe,
  prepare,
  accept,
  renew,
  roster,
  release,
  record,
  foundingBasis,
  reset,
};
