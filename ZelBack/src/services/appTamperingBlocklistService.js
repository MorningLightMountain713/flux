const config = require('config');
const log = require('../lib/log');
const appTamperingRepository = require('./appDatabase/appTamperingRepository');
const nodeDosState = require('./nodeDosState');
const generalService = require('./generalService');
const daemonServiceMiscRpcs = require('./daemonService/daemonServiceMiscRpcs');
const globalState = require('./utils/globalState');
const policyStore = require('./policy/policyStore');

const CHECK_INTERVAL_MS = config.fluxapps.tamperingCheckIntervalMs ?? 12 * 60 * 60 * 1000;
const SYNC_POLL_MS = 60 * 1000; // 60s while waiting for daemon sync
const TAMPER_SCORE_THRESHOLD = 10;
const DOS_MESSAGE_PREFIX = 'Node flagged via tampering blocklist';

let intervalHandle = null;
let ourDosActive = false;
let stopping = false;
let syncWaitTimer = null;
let syncWaitResolver = null;

/**
 * True when the current sticky DOS message was set by this service.
 * Identified by the DOS_MESSAGE_PREFIX we always prepend when we set it.
 */
function isOurStickyDos() {
  const msg = nodeDosState.getStickyDosMessage();
  return typeof msg === 'string' && msg.startsWith(DOS_MESSAGE_PREFIX);
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
  return policyStore.get('tamperingBlocklist');
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
    return (await appTamperingRepository.sumIncidentSeverities()) ?? 0;
  } catch (error) {
    log.warn(`appTamperingBlocklist - failed to compute tamper score: ${error.message}`);
    return 0;
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
 * Block until the daemon reports synced. Polls every SYNC_POLL_MS.
 * The per-iteration sleep is cancellable via stop() so shutdown is prompt.
 */
async function waitForDaemonSynced() {
  while (!stopping) {
    const s = daemonServiceMiscRpcs.isDaemonSynced();
    if (s && s.data && s.data.synced) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      syncWaitResolver = resolve;
      syncWaitTimer = setTimeout(() => {
        syncWaitTimer = null;
        syncWaitResolver = null;
        resolve();
      }, SYNC_POLL_MS);
    });
  }
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

  // An unreadable blocklist is not an empty one. Falling through on null would take the
  // clear branch below and release a node this service had already DOSed, so a github
  // outage would undo enforcement rather than postpone it.
  if (!blocklist) {
    log.warn('appTamperingBlocklist - blocklist unavailable, skipping this tick');
    return;
  }

  const listed = blocklist.includes(myTxhash);
  const exceedsThreshold = tamperScore > TAMPER_SCORE_THRESHOLD;
  const shouldDos = listed && exceedsThreshold;

  log.info(`appTamperingBlocklist - txhash=${myTxhash} listed=${listed} score=${tamperScore} shouldDos=${shouldDos}`);

  if (shouldDos) {
    const message = `${DOS_MESSAGE_PREFIX}: tamper score ${tamperScore}, txhash ${myTxhash}`;
    nodeDosState.setStickyDosMessage(message);
    nodeDosState.setStickyDosStateValue(100);
    ourDosActive = true;
    log.error(message);
    return;
  }

  if (ourDosActive || isOurStickyDos()) {
    log.info(`appTamperingBlocklist - clearing sticky DOS (listed=${listed}, score=${tamperScore})`);
    nodeDosState.clearStickyDosMessage();
    ourDosActive = false;
  }
}

/**
 * Start the enforcer. Waits for daemon sync, performs the first check, then
 * runs every 12h. Safe to call multiple times (no-ops if already started).
 */
async function start() {
  if (intervalHandle) return;
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
  if (syncWaitTimer) {
    clearTimeout(syncWaitTimer);
    syncWaitTimer = null;
  }
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
  return ourDosActive;
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
