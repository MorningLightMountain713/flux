'use strict';

const config = require('config');
const serviceHelper = require('../serviceHelper');
const generalService = require('../generalService');
const registryManager = require('../appDatabase/registryManager');
const messageStore = require('../appMessaging/messageStore');
const reconcilerQueue = require('../appMonitoring/reconcilerQueue');
const { extractIp, extractPort } = require('../utils/socketAddressUtils');
const { nowMs } = require('../utils/monotonicClock');
const grantClient = require('./grantClient');
const log = require('../../lib/log');

// The activeStandby mastership consumer (doc §10.1): the seam between the
// grant plane and the reconciler. The reconciler asks one question per pass —
// "does the grant veto this component?" — and this module answers it
// VETO-ONLY: a lost grant answers desired:false, an unknown one defers
// bounded, and a held one answers nothing at all, falling through to the
// controllerDesired data gates exactly as today. It can never answer
// desired:true — the grant decides WHO may run, never THAT something runs.
//
// INERT BY DEFAULT. Two gates sit in front of everything, and both must
// open: the config switch (quorumGrantMastership, default off — flipped in
// the harness, and in production only after the mixed-fleet suites and the
// dark-nodes confirmation-gap work land), and per-app HOLDER UNANIMITY —
// every other holder of the app must answer the grant-record endpoint. One
// holder that does not speak the grant plane puts the WHOLE app on the
// legacy path, on every node, which is the symmetric fallback the lease doc
// demands: the naive per-node fallback leaves one node believing a quorum
// protects it while another node's legacy election promotes anyway.
//
// The FluxOS-restart case shapes the unknown state: a restart wipes the
// in-memory holder while the container keeps running. Stopping a healthy
// master because this process rebooted would be self-inflicted failover, so
// unknown DEFERS (desired:null) while a re-acquire runs — the grantors
// remember their grantee, and incumbent priority makes that re-acquire
// immediate — and only past a bounded grace does unknown degrade to lost.
// Silence keeps the holder; absence of evidence authorizes nothing; and a
// bound turns "temporarily unsure" into "provably not mine" rather than
// letting a node run unverified forever.

const ROLE = 'master';

function featureEnabled() {
  if (testOverrides.enabled !== null) return testOverrides.enabled;
  return config.fluxapps.quorumGrantMastership === true;
}

function unknownGraceMs() {
  if (testOverrides.unknownGraceMs !== null) return testOverrides.unknownGraceMs;
  return config.fluxapps.quorumGrantUnknownGraceMs ?? 120_000;
}

function pursuitIntervalMs() {
  return config.fluxapps.quorumGrantPursuitIntervalMs ?? 30_000;
}

function unanimityCacheMs() {
  return config.fluxapps.quorumGrantUnanimityCacheMs ?? 60_000;
}

function heldTtlMs() {
  return config.fluxapps.quorumGrantHeldTtlMs ?? 150_000;
}

const testOverrides = { enabled: null, unknownGraceMs: null };

// app -> { atMs, unanimous } — the holder-set probe, cached one minute
const unanimity = new Map();

// key -> monotonic ms of the last pursuit kick, jitter-spread
const pursuits = new Map();

// identifier -> monotonic ms the unknown state was first seen, for the bound
const unknownSince = new Map();

function keyFor(appName) {
  return `${appName}/${ROLE}`;
}

/**
 * Whether every OTHER holder of the app answers the grant plane — shape
 * detection on the record read, the established fallback pattern, so no
 * version constant has to be guessed at build time. Anyone missing or
 * refusing puts the app on the legacy path everywhere; the probe is cached
 * because holder sets move on placement timescales, not reconcile ones.
 */
async function holdersUnanimous(appName) {
  const cached = unanimity.get(appName);
  if (cached && nowMs() - cached.atMs < unanimityCacheMs()) return cached.unanimous;

  let unanimous = false;
  try {
    const rows = await registryManager.appLocation(appName);
    const self = await generalService.obtainNodeCollateralInformation();
    const selfHosts = new Set();
    // the node's own row is not probed — this module IS the support it would
    // be probing for; collateral resolves which row is ours
    const nodes = rows || [];
    const key = keyFor(appName);
    const probes = nodes.map(async (row) => {
      if (row.txhash === self.txhash && String(row.outidx ?? row.txindex ?? '') === String(self.txindex)) {
        selfHosts.add(extractIp(row.ip));
        return true;
      }
      try {
        const url = `http://${extractIp(row.ip)}:${extractPort(row.ip)}/flux/quorumgrant/record?key=${encodeURIComponent(key)}`;
        const response = await serviceHelper.axiosGet(url, { timeout: 5_000 });
        return response?.data?.status === 'success';
      } catch (error) {
        return false;
      }
    });
    const answers = await Promise.all(probes);
    unanimous = answers.length > 0 && answers.every(Boolean);
  } catch (error) {
    log.warn(`mastershipGrantGate - unanimity probe for ${appName} failed: ${error.message}`);
    unanimous = false;
  }

  unanimity.set(appName, { atMs: nowMs(), unanimous });
  return unanimous;
}

/**
 * Kick an acquisition if none is running and the last kick is stale. The
 * grantor-side incumbent shield turns standbys away while a master renews,
 * so pursuit is cheap; when the master dies, whoever's jitter fires first
 * wins and the rest adopt. Demotion re-enters the reconciler through the
 * queue — the veto on the next pass is what stops the container.
 */
function pursue(identifier, appName) {
  const key = keyFor(appName);
  if (grantClient.holderFor(key) || grantClient.isAcquiring(key)) return;
  const last = pursuits.get(key) ?? 0;
  const interval = pursuitIntervalMs();
  const jittered = interval / 2 + Math.random() * interval;
  if (nowMs() - last < jittered) return;
  pursuits.set(key, nowMs());

  grantClient.acquire(key, {
    mode: 'held',
    ttlMs: heldTtlMs(),
    onDemoted: (reason) => {
      log.warn(`mastershipGrantGate - ${identifier} demoted: ${reason}`);
      reconcilerQueue.enqueueComponent(identifier);
    },
  }).then((outcome) => {
    if (outcome.granted) {
      log.info(`mastershipGrantGate - ${identifier} holds ${key} (epoch ${outcome.holder.epoch})`);
      reconcilerQueue.enqueueComponent(identifier);
    }
    return outcome;
  }).catch((error) => {
    log.warn(`mastershipGrantGate - pursuit of ${key} failed: ${error.message}`);
  });
}

/**
 * The reconciler seam. Answers null to stay out of the way — feature off,
 * not an activeStandby component, or a mixed fleet — and otherwise a
 * veto-only verdict:
 *
 *   held                        -> null (fall through; the data gates decide)
 *   another node holds          -> { desired: false } — a standby stays down
 *   unknown, within the grace   -> { desired: null } — leave as-is, re-acquiring
 *   unknown, past the grace     -> { desired: false } — fail closed
 *
 * @param {string} identifier component identifier
 * @param {object} comp the deployment component (hasActiveStandbySyncthing, appName)
 * @returns {Promise<{desired: false|null, reason: string}|null>}
 */
async function grantVerdict(identifier, comp) {
  if (!featureEnabled()) return null;
  if (!comp?.hasActiveStandbySyncthing?.()) return null;

  const { appName } = comp;
  if (!(await holdersUnanimous(appName))) return null;

  const key = keyFor(appName);
  if (grantClient.holderFor(key)) {
    unknownSince.delete(identifier);
    return null;
  }

  pursue(identifier, appName);

  // a fresh published record naming someone else is a settled answer, not an
  // unknown: this node is a standby and its container stays down
  try {
    const record = await messageStore.getMasterleaseRecord(appName, ROLE);
    const grantee = record?.data?.grantee ?? null;
    if (grantee) {
      const self = await generalService.obtainNodeCollateralInformation();
      if (grantee !== `${self.txhash}:${self.txindex}`) {
        unknownSince.delete(identifier);
        return { desired: false, reason: 'peerHoldsGrant' };
      }
    }
  } catch (error) {
    log.warn(`mastershipGrantGate - record read for ${appName} failed: ${error.message}`);
  }

  const firstSeen = unknownSince.get(identifier) ?? nowMs();
  unknownSince.set(identifier, firstSeen);
  if (nowMs() - firstSeen <= unknownGraceMs()) {
    return { desired: null, reason: 'grantUnknown' };
  }
  return { desired: false, reason: 'grantNotHeld' };
}

/**
 * Whether the grant currently wants this component NOT started — the
 * actuation-time re-read and the volume-unavailable stop both key on it.
 */
async function blocksStart(identifier, comp) {
  const verdict = await grantVerdict(identifier, comp);
  return verdict !== null;
}

/**
 * Teardown hook, called from hard/softUninstallComponent — the two paths
 * every removal reaches at component granularity (the removedIdentifiers
 * loop does NOT: soft redeploys never get there, and a grant leaked through
 * a redeploy would shield a master that no longer exists). Voluntary
 * release, so successors pay no lock-delay.
 */
async function onComponentTeardown(identifier, comp) {
  if (!comp?.hasActiveStandbySyncthing?.()) return;
  unknownSince.delete(identifier);
  const holder = grantClient.holderFor(keyFor(comp.appName));
  if (!holder) return;
  try {
    await holder.release();
    log.info(`mastershipGrantGate - released ${keyFor(comp.appName)} on teardown of ${identifier}`);
  } catch (error) {
    log.warn(`mastershipGrantGate - release on teardown of ${identifier} failed: ${error.message}`);
  }
}

/** Test seam. */
function resetForTests(options = {}) {
  testOverrides.enabled = options.enabled ?? null;
  testOverrides.unknownGraceMs = options.unknownGraceMs ?? null;
  unanimity.clear();
  pursuits.clear();
  unknownSince.clear();
}

module.exports = {
  grantVerdict,
  blocksStart,
  onComponentTeardown,
  holdersUnanimous,
  resetForTests,
};
