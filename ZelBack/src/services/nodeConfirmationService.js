const config = require('config');
const daemonServiceFluxnodeRpcs = require('./daemonService/daemonServiceFluxnodeRpcs');
const daemonServiceMiscRpcs = require('./daemonService/daemonServiceMiscRpcs');
const fluxNetworkHelper = require('./fluxNetworkHelper');
const networkStateService = require('./networkStateService');
const { AsyncGate } = require('./utils/asyncGate');
const fluxEventBus = require('./utils/fluxEventBus');
const log = require('../lib/log');

const DAEMON_STALE_MS = config.confirmation.daemonStaleMs;
const CONFIRM_EXPIRATION_BLOCKS = config.confirmation.confirmExpirationBlocks;
const BLOCK_INTERVAL_MS = config.confirmation.blockIntervalMs;

let ourPubkey = null;
let nodeStatus = null;
let daemonReachable = false;
let lastKnownBlocksSinceConfirmation = null;
let daemonConfirmed = null;
let daemonStale = false;
let messageCapable = false;
let started = false;
// Monotonic. A wall clock jump — an NTP correction, a resumed VM — must not be able to
// age this out, because both windows it gates shed every app on the node.
let lastSuccessfulPollAt = null;

function elapsedSincePollMs() {
  if (lastSuccessfulPollAt === null) return null;
  return Number(process.hrtime.bigint() - lastSuccessfulPollAt) / 1_000_000;
}

const confirmedGate = new AsyncGate();
const confirmationStatusGate = new AsyncGate();
const confirmationListeners = [];
const daemonStaleListeners = [];
const messageCapabilityListeners = [];

function isConfirmed() {
  return daemonConfirmed;
}

/**
 * The daemon's own-status payload as of the last successful poll, or null if one has
 * never succeeded. Sticky across an unreachable daemon for the same reason
 * daemonConfirmed is: the fields callers read are the node's identity and its
 * on-chain standing, neither of which an RPC timeout says anything about.
 * @returns {object|null}
 */
function getNodeStatus() {
  return nodeStatus;
}

/**
 * Whether the daemon answered the most recent status poll. Callers whose work is only
 * meaningful against current daemon data — collision detection reads the node list and
 * this status together — should skip rather than re-derive last poll's conclusion.
 * @returns {boolean}
 */
function isDaemonReachable() {
  return daemonReachable;
}

/**
 * Blocks the chain has advanced since this node was last confirmed, or null when the
 * chain view is not current enough to say.
 *
 * The tip arrives on the push socket, so it survives the status RPC failing — which is
 * the window this exists to answer in. A tip that stopped arriving is a different
 * matter: it would freeze the count wherever it stood when the daemon went quiet and
 * read as comfortably inside the limit forever. isDaemonSynced already withdraws its
 * claim once nothing recent has landed, so that is what gates this.
 *
 * @returns {number|null}
 */
function blocksSinceConfirmation() {
  const lastConfirmed = nodeStatus?.last_confirmed_height;
  if (!Number.isFinite(lastConfirmed) || lastConfirmed <= 0) return null;

  const { height, synced } = daemonServiceMiscRpcs.isDaemonSynced().data;
  if (!synced || !Number.isFinite(height) || height <= 0) return null;

  return height - lastConfirmed;
}

function canSendMessages() {
  return messageCapable;
}

function isDaemonStale() {
  return daemonStale;
}

function waitForConfirmed() {
  return confirmedGate.wait();
}

function waitForConfirmationStatus() {
  return confirmationStatusGate.wait();
}

function onConfirmationChange(callback) {
  confirmationListeners.push(callback);
}

function onDaemonStale(callback) {
  daemonStaleListeners.push(callback);
}

function onMessageCapabilityChange(callback) {
  messageCapabilityListeners.push(callback);
}

/**
 * Whether this node's confirmation has passed its on-chain deadline.
 *
 * Expiry is a block count, not a duration: fluxd drops a node that has not re-confirmed
 * within CONFIRM_EXPIRATION_BLOCKS of its last confirmation. While the push socket is
 * still delivering the tip that count is a fact, so it is preferred outright.
 *
 * Only when the chain view is gone too does this fall back to estimating, and it
 * estimates from the blocks that were left at last contact rather than from a fixed
 * window — a node already near its deadline when the daemon went silent expires soon
 * after, not a full window later.
 *
 * @param {number} elapsedMs Milliseconds since the last successful poll.
 * @returns {boolean} True once the deadline has passed.
 */
function hasConfirmationExpired(elapsedMs) {
  const blocks = blocksSinceConfirmation();
  if (blocks !== null) return blocks > CONFIRM_EXPIRATION_BLOCKS;

  const blocksAtLastContact = lastKnownBlocksSinceConfirmation;
  if (blocksAtLastContact === null) return false;

  const blocksRemaining = CONFIRM_EXPIRATION_BLOCKS - blocksAtLastContact;
  return elapsedMs > blocksRemaining * BLOCK_INTERVAL_MS;
}

async function poll() {
  const prevDaemonConfirmed = daemonConfirmed;
  const prevMessageCapable = messageCapable;
  let rpcReachable = false;
  try {
    const response = await daemonServiceFluxnodeRpcs.getFluxNodeStatus();
    if (response.status === 'success') {
      rpcReachable = true;
      lastSuccessfulPollAt = process.hrtime.bigint();
      daemonStale = false;
      nodeStatus = response.data ?? null;
      daemonConfirmed = nodeStatus?.status === 'CONFIRMED';
      const blocks = blocksSinceConfirmation();
      if (blocks !== null) lastKnownBlocksSinceConfirmation = blocks;
    }
  } catch (error) {
    // RPC unreachable — keep previous daemonConfirmed value
  }

  daemonReachable = rpcReachable;

  // Future: use in-band NAK-based confirmation check instead of timeout.
  // See dev/in-band-confirmation-check.md
  const elapsed = elapsedSincePollMs();
  if (!rpcReachable && elapsed !== null) {
    // Remove apps, but messageCapable preserved (can still broadcast)
    if (elapsed > DAEMON_STALE_MS && !daemonStale) {
      daemonStale = true;
      log.warn(`nodeConfirmationService - Daemon unreachable for ${Math.round(elapsed / 60000)} minutes, stale`);
      for (const cb of daemonStaleListeners) {
        try { cb(); } catch (e) { log.error(e); }
      }
    }

    if (daemonConfirmed && hasConfirmationExpired(elapsed)) {
      daemonConfirmed = false;
      confirmedGate.close();
      log.warn('nodeConfirmationService - Confirmation expired on chain while the daemon was unreachable');
      fluxEventBus.publish('confirmation:changed', { confirmed: false });
      for (const cb of confirmationListeners) {
        try { cb(false); } catch (e) { log.error(e); }
      }
    }
  }

  if (rpcReachable) {
    if (daemonConfirmed) {
      confirmedGate.open();
    } else {
      confirmedGate.close();
    }
    if (prevDaemonConfirmed !== daemonConfirmed) {
      const direction = daemonConfirmed ? 'gained' : 'lost';
      log.info(`nodeConfirmationService - Confirmation ${direction}`);
      fluxEventBus.publish('confirmation:changed', { confirmed: daemonConfirmed });
      for (const cb of confirmationListeners) {
        try { cb(daemonConfirmed); } catch (e) { log.error(e); }
      }
    }
  }

  if (!daemonConfirmed) {
    messageCapable = false;
    if (prevMessageCapable !== messageCapable) {
      log.info('nodeConfirmationService - Node not confirmed by daemon, message capability lost');
      for (const cb of messageCapabilityListeners) {
        try { cb(false); } catch (e) { log.error(e); }
      }
    }
    return;
  }

  let newMessageCapable = false;
  try {
    if (!ourPubkey) {
      ourPubkey = await fluxNetworkHelper.getFluxNodePublicKey();
      if (!ourPubkey || typeof ourPubkey !== 'string') {
        ourPubkey = null;
      }
    }

    const localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();
    if (localSocketAddr && ourPubkey) {
      const node = await networkStateService.getFluxnodeBySocketAddress(localSocketAddr);
      if (node && node.pubkey === ourPubkey) {
        newMessageCapable = true;
      }
    }
  } catch (error) {
    log.warn(`nodeConfirmationService - Message capability check failed: ${error.message}`);
  }

  messageCapable = newMessageCapable;

  if (prevMessageCapable !== messageCapable) {
    const direction = messageCapable ? 'gained' : 'lost';
    log.info(`nodeConfirmationService - Message capability ${direction} (confirmed=${daemonConfirmed}, messageCapable=${messageCapable})`);
    fluxEventBus.publish('messageCapability:changed', { capable: messageCapable });
    for (const cb of messageCapabilityListeners) {
      try { cb(messageCapable); } catch (e) { log.error(e); }
    }
  }
}

function scheduleNext() {
  setTimeout(async () => {
    await poll();
    scheduleNext();
  }, config.confirmation.pollIntervalMs);
}

async function start() {
  if (started) return;
  started = true;
  await poll();
  confirmationStatusGate.open();
  scheduleNext();
  log.info(`nodeConfirmationService - Started (confirmed=${daemonConfirmed}, messageCapable=${messageCapable})`);
}

/**
 * Places the last successful poll a given age in the past. Tests express staleness as
 * an age because the clock behind it is monotonic and has no wall-clock equivalent.
 * @param {number|null} ageMs Age in milliseconds, or null for "never polled".
 * @returns {void}
 */
function setLastSuccessfulPollAgeMs(ageMs) {
  if (ageMs === null) {
    lastSuccessfulPollAt = null;
    return;
  }

  lastSuccessfulPollAt = process.hrtime.bigint() - BigInt(Math.round(ageMs * 1_000_000));
}

module.exports = {
  isConfirmed,
  getNodeStatus,
  isDaemonReachable,
  isDaemonStale,
  canSendMessages,
  waitForConfirmed,
  waitForConfirmationStatus,
  onConfirmationChange,
  onDaemonStale,
  onMessageCapabilityChange,
  start,
  setLastSuccessfulPollAgeMs,
};
