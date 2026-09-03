'use strict';

const generalService = require('../generalService');
const messageStore = require('../appMessaging/messageStore');
const registryManager = require('../appDatabase/registryManager');
const networkStateService = require('../networkStateService');
const daemonServiceMiscRpcs = require('../daemonService/daemonServiceMiscRpcs');
const fluxEventBus = require('../utils/fluxEventBus');
const { extractIp } = require('../utils/socketAddressUtils');
const foundingCommittee = require('../appMesh/foundingCommittee');
const grantClient = require('./grantClient');
const masterleasePublisher = require('./masterleasePublisher');
const downCertificates = require('./downCertificates');
const log = require('../../lib/log');

// The plane half of ordinals-as-grants (David, 2026-09-02; modelled in
// formal/ordinal-register/): a mesh ordinal (db-0, db-1, …) is a WRITE-ONCE
// grant on the app's founding committee — one register per ordinal per app,
// decided once, given back by its holder on uninstall (release) and reclaimed
// by a node-down certificate about its holder (vacate). The consumer — the
// scan that finds the lowest free ordinal, the names and SRV derived from
// who holds what — lives behind appMesh/ordinalRegisterSeam.js and this
// module is what registers into it at wiring.
//
// Three rules the model forced, each a red before it was a rule:
//   - a probe names a holder only on a QUORUM of cells recording the same
//     unreleased row (grantClient.probeOneshot) — never one cell's row;
//   - every quorum decision publishes its own superseding record (a founding
//     names the holder; a release or vacate names it with released: true), so
//     ordinalHolders is a local read and a node behind on records is the only
//     stale reader there is;
//   - a founding is free-or-mine, so a row a vacate cut short at one cell is
//     repaired by its holder's next founding (grantRegisterCore.onAccept).
//
// The key: `<app>/ordinal-<n>@<rung>` — the app's FIRST world's rung
// (foundingCommittee.appWorld), because an ordinal names the node across
// every component it hosts and components added later have worlds of their
// own. The row is that key at the founder plane's current generation
// (grantorController.registerRowFor), exactly as a founder row is.

const ROLE_PREFIX = 'ordinal-';
const ROLE_PATTERN = /^ordinal-(\d{1,5})@(\d{1,10})$/;

function roleFor(ordinal, rung) {
  return `${ROLE_PREFIX}${ordinal}@${rung}`;
}

function parseRole(role) {
  const match = ROLE_PATTERN.exec(role ?? '');
  if (!match) return null;
  return { ordinal: Number(match[1]), rung: Number(match[2]) };
}

/**
 * The founder plane's current generation for the app — the same read the
 * founding service and the grantors' 409-teach share (foundingService.js
 * currentGeneration), so the row this module addresses is the row the
 * committee judges.
 */
async function currentGeneration(appName) {
  try {
    const record = await messageStore.getGrantGenerationRecord(appName, 'founder');
    return record?.data?.generation ?? 0;
  } catch (error) {
    return 0;
  }
}

async function selfOutpoint() {
  try {
    const collateral = await generalService.obtainNodeCollateralInformation();
    if (!collateral?.txhash) return null;
    return `${collateral.txhash}:${collateral.txindex}`;
  } catch (error) {
    return null;
  }
}

/**
 * The basis every ordinal ask runs under: the app's first world's newest
 * rung, the founding committee at that rung with the current generation
 * folded in, and whether the world is ARMED (a flip inside the quiet zone —
 * the founding service's own gate against starting a round that races it).
 * Null is an honest "not yet": no photo, no committee.
 */
async function basisFor(appName) {
  const world = await foundingCommittee.appWorld(appName);
  if (!world) return null;
  const rung = world.rungs[world.rungs.length - 1];
  const committee = await foundingCommittee.refereeCommittee(appName, rung);
  if (!committee) return null;
  const generation = await currentGeneration(appName);
  return {
    rung,
    generation,
    armed: world.armed === true,
    committee: { ...committee, generation },
  };
}

function keyFor(appName, ordinal, rung) {
  return `${appName}/${roleFor(ordinal, rung)}`;
}

/**
 * The holder THIS node's records name for one ordinal at the current
 * generation — newest rung wins, released rows are free. Used for one thing
 * only: the durable "yes" to the node's own earlier founding. It never
 * answers "no" for anyone else — a record can lag a release, and the scan's
 * word on "free" is the probe's, never a record's.
 */
async function recordedHolder(appName, ordinal, generation) {
  const rows = await messageStore.getMasterleaseRecordsByRolePrefix(appName, `${ROLE_PREFIX}${ordinal}@`);
  let best = null;
  let bestRung = -1;
  (rows ?? []).forEach((row) => {
    const data = row?.data;
    if (!data || data.mode !== 'oneshot' || typeof data.grantee !== 'string') return;
    if ((data.generation ?? 0) !== generation) return;
    const parsed = parseRole(String(row.dedupKey ?? '').slice(String(row.dedupKey ?? '').indexOf('/') + 1));
    if (!parsed || parsed.ordinal !== ordinal || parsed.rung <= bestRung) return;
    best = data.released === true ? null : data.grantee;
    bestRung = parsed.rung;
  });
  return best;
}

async function publishRow(key, grantee, epoch, basis, released) {
  return masterleasePublisher.publishMasterlease({
    key,
    grantee,
    epoch,
    mode: 'oneshot',
    fingerprint: basis.committee.fingerprint,
    generation: basis.generation,
    ...(released ? { released: true } : {}),
  });
}

// ---------------------------------------------------------------------------
// the seam's four calls

/**
 * A quorum read: {decided, holder}. Burns no epoch. Undecided when no basis
 * exists yet or a quorum did not answer — the scan waits, never assumes free.
 */
async function probeOrdinal(appName, ordinal) {
  const basis = await basisFor(appName);
  if (!basis) return { decided: false, holder: null };
  const verdict = await grantClient.probeOneshot(keyFor(appName, ordinal, basis.rung), basis.committee);
  return { decided: verdict.decided, holder: verdict.holder };
}

/**
 * Found the ordinal for this node. yes is durable — the node's own recorded
 * founding answers yes again without a round; no carries the holder so the
 * scan moves on; wait is every honest "not yet" with a hint when one exists.
 */
async function askOrdinal(appName, ordinal) {
  const basis = await basisFor(appName);
  if (!basis) return { answer: 'wait', reason: 'no founding basis' };
  const self = await selfOutpoint();
  if (!self) return { answer: 'wait', reason: 'node identity unavailable' };

  const recorded = await recordedHolder(appName, ordinal, basis.generation);
  if (recorded === self) return { answer: 'yes' };

  if (daemonServiceMiscRpcs.isDaemonSynced()?.data?.synced !== true) {
    return { answer: 'wait', reason: 'own chain view stale' };
  }
  if (basis.armed) {
    return { answer: 'wait', reason: 'world armed' };
  }

  const key = keyFor(appName, ordinal, basis.rung);
  const outcome = await grantClient.acquire(key, { mode: 'oneshot', committee: basis.committee });
  if (outcome.granted) {
    fluxEventBus.publish('quorumGrant:ordinalFounded', { appName, ordinal, holder: self });
    return { answer: 'yes' };
  }
  if (outcome.founder) {
    return { answer: 'no', holder: outcome.founder };
  }
  return {
    answer: 'wait',
    ...(Number.isFinite(outcome.retryAfterMs) && outcome.retryAfterMs > 0 ? { retryAfterMs: outcome.retryAfterMs } : {}),
    ...(outcome.reason ? { reason: outcome.reason } : {}),
  };
}

/**
 * Give the ordinal back: the holder's own release to a quorum, then the
 * superseding record. Releasing what the register does not record as this
 * node's is a no-op success when nobody holds it and a refusal when someone
 * else does.
 */
async function releaseOrdinal(appName, ordinal) {
  const basis = await basisFor(appName);
  if (!basis) return { released: false, reason: 'no founding basis' };
  const self = await selfOutpoint();
  if (!self) return { released: false, reason: 'node identity unavailable' };

  const key = keyFor(appName, ordinal, basis.rung);
  const verdict = await grantClient.probeOneshot(key, basis.committee);
  if (!verdict.decided) return { released: false, reason: 'no quorum answered' };
  if (verdict.holder === null) return { released: true };
  if (verdict.holder !== self) return { released: false, reason: `held by ${verdict.holder}` };

  const ok = await grantClient.releaseOneshot(key, basis.committee, verdict.epoch);
  if (!ok) return { released: false, reason: 'no release quorum' };
  await publishRow(key, self, verdict.epoch, basis, true);
  fluxEventBus.publish('quorumGrant:ordinalReleased', { appName, ordinal, holder: self });
  return { released: true };
}

/**
 * Who holds which ordinal, from this node's own records: the fleet-synced
 * quorum verdicts, newest rung per ordinal, released rows free. A local read
 * — names and SRV come from here on every pass, and a lagging record is a
 * temporarily unknown name, never a collision.
 *
 * @returns {Promise<Map<number, string>>} ordinal -> holder outpoint
 */
async function ordinalHolders(appName) {
  const holders = new Map();
  const generation = await currentGeneration(appName);
  const rows = await messageStore.getMasterleaseRecordsByRolePrefix(appName, ROLE_PREFIX);
  const bestRung = new Map();
  (rows ?? []).forEach((row) => {
    const data = row?.data;
    if (!data || data.mode !== 'oneshot' || typeof data.grantee !== 'string') return;
    if ((data.generation ?? 0) !== generation) return;
    const dedup = String(row.dedupKey ?? '');
    const parsed = parseRole(dedup.slice(dedup.indexOf('/') + 1));
    if (!parsed || parsed.rung <= (bestRung.get(parsed.ordinal) ?? -1)) return;
    bestRung.set(parsed.ordinal, parsed.rung);
    if (data.released === true) holders.delete(parsed.ordinal);
    else holders.set(parsed.ordinal, data.grantee);
  });
  return holders;
}

// ---------------------------------------------------------------------------
// reclaim by certificate


/**
 * Whether the derivation still places a node on this app: its row is in the
 * derived locations, which keep a certified node's rows until the grace has
 * run from the drop (since + NODE_DOWN_GRACE_MS, appsRepository) and honour
 * an announce inside it. Read, never recomputed — the edge is the view's.
 *
 * @returns {Promise<boolean|null>} null when the membership cannot be resolved
 */
async function placedOnApp(appName, outpoint) {
  const membership = networkStateService.membershipAt(networkStateService.membershipFingerprint());
  if (!Array.isArray(membership)) return null;
  const [txhash, outidx] = outpoint.split(':');
  const listed = membership.find((entry) => entry.txhash === txhash && String(entry.outidx) === outidx);
  if (!listed?.ip) return false;
  const holderIp = extractIp(listed.ip);
  const locations = await registryManager.appLocation(appName);
  return (locations ?? []).some((location) => extractIp(location?.ip ?? '') === holderIp);
}

/**
 * Reclaim one ordinal by node-down certificate — the seam's fifth call, asked
 * by the joiner's scan for an ordinal the register says another node holds.
 * R9 (NODE_DOWN_SCENARIOS.md §5): the vacate follows the derivation's
 * placement-dead edge, the same moment a replacement may be placed, observed
 * on a host's pass and acted on once, never on a timer. Three readings, each
 * from its owner: the certificate stands (the node-down store, through the
 * seam), the derivation no longer places the holder (the derived locations),
 * and the register's own probe names the holder. The certificate is the
 * vacate's authority and rides the ask whole; the superseding released row is
 * published for everyone's names.
 *
 * @returns {Promise<{vacated: boolean, reason?: string}>}
 */
async function vacateOrdinal(appName, ordinal, holder) {
  if (typeof holder !== 'string' || !holder) return { vacated: false, reason: 'malformed holder' };
  const standing = await downCertificates.standingCertificateFor(holder);
  if (!standing) return { vacated: false, reason: 'no standing certificate' };
  const placed = await placedOnApp(appName, holder);
  if (placed === null) return { vacated: false, reason: 'membership unavailable' };
  if (placed) return { vacated: false, reason: 'still placed' };

  const basis = await basisFor(appName);
  if (!basis) return { vacated: false, reason: 'no founding world' };
  const key = keyFor(appName, ordinal, basis.rung);
  const verdict = await grantClient.probeOneshot(key, basis.committee);
  if (!verdict.decided) return { vacated: false, reason: 'no quorum answered' };
  if (verdict.holder === null) return { vacated: true };
  if (verdict.holder !== holder) return { vacated: false, reason: `held by ${verdict.holder}` };

  // the store decorates its answer with the row's broadcastedAt; the referees
  // verify the certificate as gossiped
  const certificate = { ...standing };
  delete certificate.broadcastedAt;
  const ok = await grantClient.vacateOneshot(key, basis.committee, certificate);
  if (!ok) {
    log.info(`ordinalRegister - vacate of ${key} for ${holder} reached no quorum`);
    return { vacated: false, reason: 'no vacate quorum' };
  }
  await publishRow(key, holder, verdict.epoch, basis, true);
  fluxEventBus.publish('quorumGrant:ordinalVacated', { appName, ordinal, holder });
  log.info(`ordinalRegister - ${key} vacated: certificate about ${holder}`);
  return { vacated: true };
}

/** The seam's provider: the full contract, registered at wiring. */
function provider() {
  return {
    probeOrdinal,
    askOrdinal,
    releaseOrdinal,
    ordinalHolders,
    vacateOrdinal,
  };
}

module.exports = {
  ROLE_PREFIX,
  roleFor,
  parseRole,
  probeOrdinal,
  askOrdinal,
  releaseOrdinal,
  ordinalHolders,
  vacateOrdinal,
  provider,
};
