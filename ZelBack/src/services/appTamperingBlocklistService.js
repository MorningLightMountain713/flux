'use strict';

const config = require('config');
const log = require('../lib/log');
const appTamperingRepository = require('./appDatabase/appTamperingRepository');
const nodeDosState = require('./nodeDosState');
const generalService = require('./generalService');
const daemonServiceMiscRpcs = require('./daemonService/daemonServiceMiscRpcs');
const globalState = require('./utils/globalState');
const policyStore = require('./policyStore');

const CHECK_INTERVAL_MS = config.get('fluxapps.tamperingCheckIntervalMs');
const TAMPER_SCORE_THRESHOLD = 10;
const DOS_MESSAGE_PREFIX = 'Node flagged via tampering blocklist';
const OWNER = nodeDosState.StickyDosOwner.APP_TAMPERING;

let intervalHandle = null;
let stopping = false;
let syncWaitResolver = null;
let syncBlockEmitter = null;
let syncBlockListener = null;

/**
 * True while this service's own verdict holds the node out of service.
 * @returns {boolean}
 */
function isOurDosHeld() {
  return nodeDosState.isStickyDosHeldBy(OWNER);
}

/**
 * Give up the DOS this service is holding. Every other owner's verdict stands.
 * @param {string} reason Logged context for the release.
 */
function releaseOurDos(reason) {
  if (!isOurDosHeld()) return;
  log.info(`appTamperingBlocklist - clearing sticky DOS (${reason})`);
  nodeDosState.clearStickyDos(OWNER);
}

/**
 * The manually-curated txhash blocklist.
 *
 * Returns null when no copy could be obtained, which is NOT the same answer as an empty
 * list: an empty list means the document was read and nobody is blocked, while null means
 * the question went unanswered. The caller must not treat the second as the first — doing
 * so let an unreadable list clear the DOS on a node that was on it.
 */
function fetchBlocklist() {
  const blocklist = policyStore.getDocument('tamperingblockednodes');
  if (blocklist === null) return null;
  // A signature says who published a document, not that it is the shape this code expects.
  if (!Array.isArray(blocklist)) {
    log.warn('appTamperingBlocklist - tamperingblockednodes in the signed bundle is not an array');
    return null;
  }
  return blocklist;
}

/**
 * An attested Arcane node is exempt from blocklist enforcement. Reads the
 * boot-resolved node-capability verdict (true = arcane -> exempt, false = legacy
 * -> enforce); it is resolved before this service starts, so there is no
 * unresolved tick to guard against.
 */
function isArcaneOs() {
  return globalState.isArcane();
}

/**
 * Tamper score over incident documents (30-day TTL bounds the window).
 * Each schemaVersion>=1 document already IS one deduplicated incident with a
 * severity stamped at write time, so scoring is a plain sum of severities.
 * Pre-schema rows are excluded on purpose: they are row-per-observation noise
 * with no severity, exactly the data a raw countDocuments({}) once let cross
 * the enforcement gate on honest nodes. The startup purge removes them; the
 * filter here covers anything written before that purge has run.
 */
async function computeTamperScore() {
  try {
    // null, never 0: a score this node could not read is not a score of zero,
    // and returning zero would take the clear branch and release a node this
    // service had deliberately DOSed - the same distinction the blocklist
    // fetch makes between could-not-ask and nothing-listed. The repository
    // answers null when it cannot reach the database, so it passes straight
    // through - no `?? 0`.
    return await appTamperingRepository.sumIncidentSeverities();
  } catch (error) {
    log.warn(`appTamperingBlocklist - failed to compute tamper score: ${error.message}`);
    return null;
  }
}

/**
 * Read this node's collateral txhash via fluxd.
 */
async function getMyTxhash() {
  try {
    const info = await generalService.obtainNodeCollateralInformation();
    return info && info.txhash ? info.txhash : null;
  } catch (error) {
    log.warn(`appTamperingBlocklist - failed to read node collateral: ${error.message}`);
    return null;
  }
}

/**
 * Block until the daemon reports synced. The sync fact only changes when a
 * block is processed, so that event is what releases the wait - the level is
 * re-read on each one, and once more right after subscribing in case the edge
 * fired in between. No timer: a chain that never updates is a node that must
 * not enforce, and stop() releases the wait for shutdown.
 */
async function waitForDaemonSynced() {
  const synced = () => {
    const s = daemonServiceMiscRpcs.isDaemonSynced();
    return Boolean(s && s.data && s.data.synced);
  };
  if (stopping || synced()) return;
  await new Promise((resolve) => {
    const settle = () => {
      if (syncBlockEmitter && syncBlockListener) {
        syncBlockEmitter.off('blocksProcessed', syncBlockListener);
      }
      syncBlockListener = null;
      syncWaitResolver = null;
      resolve();
    };
    syncWaitResolver = settle;
    if (syncBlockEmitter) {
      syncBlockListener = () => {
        if (stopping || synced()) settle();
      };
      syncBlockEmitter.on('blocksProcessed', syncBlockListener);
      syncBlockListener();
    }
    // No emitter wired: only stop() releases the wait.
  });
}

/**
 * Core check: if our txhash is in the blocklist AND the weighted tamper score
 * exceeds TAMPER_SCORE_THRESHOLD, DOS the node. Otherwise, if we previously
 * DOSed it, clear the DOS. This service owns the DOS message it sets and only
 * clears it when its own condition is no longer true.
 */
async function enforceBlocklist() {
  if (isArcaneOs()) {
    log.info('appTamperingBlocklist - node is ArcaneOS, enforcement disabled');
    return;
  }

  const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
  if (!syncStatus || !syncStatus.data || !syncStatus.data.synced) {
    log.info('appTamperingBlocklist - daemon not synced, skipping this tick');
    return;
  }

  const [myTxhash, tamperScore] = await Promise.all([
    getMyTxhash(),
    computeTamperScore(),
  ]);
  const blocklist = fetchBlocklist();

  if (!myTxhash) {
    log.warn('appTamperingBlocklist - own txhash unavailable, skipping this tick');
    return;
  }

  // An unreadable blocklist is not an empty one. Falling through on null would
  // take the clear branch below and release a node this service had already
  // DOSed - an outage would undo enforcement rather than postpone it.
  if (blocklist === null) {
    log.warn('appTamperingBlocklist - blocklist unavailable, skipping this tick');
    return;
  }

  // Same rule for the other input to the decision: an unreadable score cannot
  // clear an active DOS.
  if (tamperScore === null) {
    log.warn('appTamperingBlocklist - tamper score unavailable, skipping this tick');
    return;
  }

  const listed = blocklist.includes(myTxhash);
  const exceedsThreshold = tamperScore > TAMPER_SCORE_THRESHOLD;
  const shouldDos = listed && exceedsThreshold;

  log.info(`appTamperingBlocklist - txhash=${myTxhash} listed=${listed} score=${tamperScore} shouldDos=${shouldDos}`);

  if (shouldDos) {
    const message = `${DOS_MESSAGE_PREFIX}: tamper score ${tamperScore}, txhash ${myTxhash}`;
    nodeDosState.setStickyDos(OWNER, message);
    return;
  }

  releaseOurDos(`listed=${listed}, score=${tamperScore}`);
}

/**
 * Start the enforcer. Waits for daemon sync (released by the block feed),
 * performs the first check, then runs every
 * config.fluxapps.tamperingCheckIntervalMs (12h by default). Safe to call
 * multiple times (no-ops if already started).
 *
 * @param {object} [options]
 * @param {import('events').EventEmitter} [options.blockEmitter] - emits
 *   'blocksProcessed'; what releases the sync wait. Without it only stop()
 *   can release an unsynced wait.
 */
async function start(options = {}) {
  if (intervalHandle) return;
  syncBlockEmitter = options.blockEmitter ?? null;
  if (isArcaneOs()) {
    log.info('appTamperingBlocklist - node is ArcaneOS, enforcer will not start');
    return;
  }
  stopping = false;
  log.info('appTamperingBlocklist - enforcer starting, waiting for daemon sync');
  try {
    await waitForDaemonSynced();
  } catch (err) {
    log.error(`appTamperingBlocklist - sync wait failed: ${err.message}`);
    return;
  }
  if (stopping) {
    log.info('appTamperingBlocklist - stop() called during sync wait, aborting start');
    return;
  }
  try {
    await enforceBlocklist();
  } catch (err) {
    log.error(`appTamperingBlocklist - first tick error: ${err.message}`);
  }
  if (stopping) {
    log.info('appTamperingBlocklist - stop() called during first tick, not scheduling interval');
    return;
  }
  intervalHandle = setInterval(() => {
    enforceBlocklist().catch((err) => log.error(`appTamperingBlocklist - tick error: ${err.message}`));
  }, CHECK_INTERVAL_MS);
}

function stop() {
  stopping = true;
  if (syncWaitResolver) {
    const resolve = syncWaitResolver;
    syncWaitResolver = null;
    resolve();
  }
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

function isDosActive() {
  return isOurDosHeld();
}

module.exports = {
  start,
  stop,
  enforceBlocklist,
  fetchBlocklist,
  computeTamperScore,
  getMyTxhash,
  isDosActive,
  TAMPER_SCORE_THRESHOLD,
  DOS_MESSAGE_PREFIX,
};
