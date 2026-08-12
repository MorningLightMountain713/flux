'use strict';

const config = require('config');
const messageHelper = require('../messageHelper');
const serviceHelper = require('../serviceHelper');
const generalService = require('../generalService');
const fluxCommunicationUtils = require('../fluxCommunicationUtils');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const networkStateService = require('../networkStateService');
const registryManager = require('../appDatabase/registryManager');
const { extractIp } = require('../utils/socketAddressUtils');
const { selectCommittee } = require('../utils/committeeSelector');
const signedEnvelope = require('./signedEnvelope');
const rosterOverlay = require('./rosterOverlay');
const grantRegister = require('./grantRegister');
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

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\/[a-z0-9-]{1,64}$/;
const OUTPOINT_PATTERN = /^[0-9a-f]{64}:\d{1,6}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

// Per-peer ceiling on asks, the limit counter's discipline: the checks above
// bound what a peer can do; this bounds how fast it can try.
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
    key, mode, epoch, candidate, ttlMs, fingerprint, at, signature,
    remove, add, seq, chain,
  } = body;

  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    return bad(400, 'malformed key');
  }
  const needsMode = type === 'probe' || type === 'prepare' || type === 'accept';
  if (needsMode && mode !== 'held' && mode !== 'oneshot') {
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
  if (extractIp(askerNode.ip) !== callerHost(req)) {
    return bad(403, 'ask does not originate from the candidate');
  }

  const ask = {
    key, mode, epoch, candidate, ttlMs, fingerprint, at, remove, add, seq, chain,
  };
  const fields = signedEnvelope.fieldsFor(type, ask);
  if (!fields || !signedEnvelope.verify(type, fields, signature, askerNode.pubkey)) {
    return bad(403, 'signature does not verify');
  }

  return { ok: true, ask, askerNode };
}

/**
 * Whether THIS node sits on the committee for the key, computed against the
 * membership the ask NAMES — the pinning rule (§5). The fingerprint decides
 * WHICH list; a fingerprint this node cannot rebuild is a committee this
 * node cannot verify membership of, and it says so rather than substituting
 * the current list — tolerance matching is how quorum overlap quietly stops
 * being an intersection. Fails closed throughout: a node that cannot
 * identify itself cannot show it belongs.
 *
 * For held keys the base committee is read THROUGH the roster overlay:
 * this grantor's own journaled chain applies as written, and a longer
 * chain carried on the ask applies after full verification against the
 * same membership — which is how a freshly seated replacement, whose
 * register has never heard of the key, knows to answer for it.
 */
async function selfOnCommittee(key, mode, fingerprint, carriedChain) {
  const membership = networkStateService.membershipAt(fingerprint);
  if (!membership) {
    return { member: false, code: 409, reason: 'unknown membership fingerprint' };
  }

  const committee = selectCommittee(membership, `quorumgrant|${key}`, { size: committeeSize(mode) });
  if (committee.refusal) {
    return { member: false, code: 409, reason: committee.refusal };
  }

  let { members } = committee;
  if (mode === 'held') {
    const stored = await grantRegister.read(key);
    const journaled = stored?.roster?.fingerprint === fingerprint ? stored.roster.chain : [];
    if (journaled.length) {
      members = rosterOverlay.rosterAfter(committee.members, membership, journaled) ?? members;
    }
    if (Array.isArray(carriedChain) && carriedChain.length > journaled.length) {
      const verified = rosterOverlay.verifyChain(
        membership, key, fingerprint, committeeSize(mode), carriedChain,
      );
      if (verified) ({ members } = verified);
    }
  }

  const collateral = await generalService.obtainNodeCollateralInformation();
  const member = members.some(
    (node) => node.txhash === collateral.txhash
      && String(node.outidx) === String(collateral.txindex),
  );
  return {
    member, code: member ? 200 : 409, reason: member ? null : 'this node is not on that committee', quorum: committee.quorum, rung: committee.rung,
  };
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
    if (record?.accepted) {
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
  try {
    const host = callerHost(req);
    if (!peerAllowed(host)) {
      return res.status(429).json(messageHelper.createErrorMessage('too many grant asks'));
    }

    const read = await readAsk(req, type);
    if (!read.ok) {
      return res.status(read.code).json(messageHelper.createErrorMessage(read.message));
    }
    const { ask, askerNode } = read;

    const committee = await selfOnCommittee(ask.key, ask.mode ?? 'held', ask.fingerprint, ask.chain);
    if (!committee.member) {
      return res.status(committee.code).json(messageHelper.createErrorMessage(committee.reason));
    }

    if (type !== 'probe') {
      const holding = await askerHolds(ask, askerNode, type);
      if (!holding.holds) {
        return res.status(403).json(messageHelper.createErrorMessage(holding.reason));
      }
    }

    const reply = await operate(ask);
    return res.json(messageHelper.createDataMessage(reply));
  } catch (error) {
    log.error(`quorumGrant grantorController ${type}: ${error.message}`);
    return res.status(500).json(messageHelper.createErrorMessage(error.message));
  }
}

async function probe(req, res) {
  return serve(req, res, 'probe', (ask) => grantRegister.probe(ask.key, {
    epoch: ask.epoch, candidate: ask.candidate,
  }));
}

async function prepare(req, res) {
  return serve(req, res, 'prepare', (ask) => grantRegister.prepare(ask.key, {
    epoch: ask.epoch, candidate: ask.candidate,
  }));
}

async function accept(req, res) {
  return serve(req, res, 'accept', (ask) => grantRegister.accept(ask.key, {
    epoch: ask.epoch,
    grantee: ask.candidate,
    mode: ask.mode,
    ttlMs: ask.ttlMs,
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
      membership, ask.key, ask.fingerprint, committeeSize('held'), ask.chain,
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
    key: ask.key, fingerprint: ask.fingerprint, seq: ask.seq, remove: ask.remove, add: ask.add,
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
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
      return res.status(400).json(messageHelper.createErrorMessage('malformed key'));
    }
    const stored = await grantRegister.read(key);
    return res.json(messageHelper.createDataMessage({
      key,
      promisedEpoch: stored?.promisedEpoch ?? 0,
      accepted: stored?.accepted ?? null,
      roster: stored?.roster ?? null,
    }));
  } catch (error) {
    log.error(`quorumGrant grantorController record: ${error.message}`);
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
  reset,
};
