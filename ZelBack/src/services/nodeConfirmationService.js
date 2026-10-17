'use strict';

const config = require('config');
const daemonServiceFluxnodeRpcs = require('./daemonService/daemonServiceFluxnodeRpcs');
const daemonStatus = require('./daemonService/daemonStatus');
const daemonSubscriptionService = require('./daemonService/daemonSubscriptionService');
const fluxNetworkHelper = require('./fluxNetworkHelper');
const networkStateService = require('./networkStateService');
const capabilities = require('./utils/capabilities');
const fluxEventBus = require('./utils/fluxEventBus');
const log = require('../lib/log');

const DAEMON_STALE_MS = config.get('confirmation.daemonStaleMs');
const CONFIRM_EXPIRATION_BLOCKS = config.get('confirmation.confirmExpirationBlocks');
const BLOCK_INTERVAL_MS = config.get('confirmation.blockIntervalMs');

let ourPubkey = null;
let nodeStatus = null;
let daemonReachable = false;
let lastKnownBlocksSinceConfirmation = null;
let daemonConfirmed = null;
let daemonStale = false;
let messageCapable = false;
let started = false;
let pushDriven = false;
let pollTimer = null;
// Monotonic. A wall clock jump — an NTP correction, a resumed VM — must not be able to
// age this out, because both windows it gates shed every app on the node.
let lastStatusObservedAt = null;

function elapsedSinceStatusMs() {
  if (lastStatusObservedAt === null) return null;
  return Number(process.hrtime.bigint() - lastStatusObservedAt) / 1_000_000;
}

const daemonStaleListeners = [];

/**
 * Publish `nodeConfirmed` from the daemon's verdict.
 * @param {boolean} confirmed
 * @param {string} reason
 */
function publishConfirmed(confirmed, reason) {
  const handle = capabilities.claim('nodeConfirmed', 'nodeConfirmationService');
  if (confirmed) handle.raise(reason); else handle.lower(reason);
}

/**
 * Publish `nodeMessageCapable`: the network's node list carries this node at its
 * own address and key, so other nodes will hear what it broadcasts.
 * @param {boolean} capable
 * @param {string} reason
 */
function publishMessageCapable(capable, reason) {
  const handle = capabilities.claim('nodeMessageCapable', 'nodeConfirmationService');
  if (capable) handle.raise(reason); else handle.lower(reason);
}

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
 * This node's collateral, from the status this service holds: the daemon pushes
 * it on every change, and it stands while the daemon cannot answer. The daemon
 * is asked only before a first status has been read.
 * @returns {Promise<{txhash: string, txindex: number}>}
 */
async function ownCollateral() {
  let status = nodeStatus;
  if (!status) {
    const answer = await daemonServiceFluxnodeRpcs.getFluxNodeStatus();
    if (answer.status === 'error') throw answer.data;
    status = answer.data;
  }
  return { txhash: status.txhash, txindex: Number(status.outidx) };
}

/**
 * Whether the daemon answered the most recent status poll. Callers whose work is only
 * meaningful against current daemon data — collision detection reads the node list and
 * this status together — should skip rather than re-derive last poll's conclusion.
 * @returns {boolean}
 */
function isDaemonReachable() {
  // Nothing is polling in push mode, so there is no failed call to read. Liveness is
  // the authority there: any message is a heartbeat and only a failed probe says dead.
  if (pushDriven) return daemonSubscriptionService.daemonAlive();
  return daemonReachable;
}

/**
 * Blocks the chain has advanced since this node was last confirmed, or null when the
 * chain view is not current enough to say.
 *
 * The tip arrives on the push socket, so it survives the status RPC failing — which is
 * the window this exists to answer in. A tip that stopped arriving is a different
 * matter: it would freeze the count wherever it stood when the daemon went quiet and
 * read as comfortably inside the limit forever. daemonSyncState already withdraws its
 * claim once nothing recent has landed, so that is what gates this.
 *
 * @returns {number|null}
 */
function blocksSinceConfirmation() {
  const lastConfirmed = nodeStatus?.last_confirmed_height;
  if (!Number.isFinite(lastConfirmed) || lastConfirmed <= 0) return null;

  const { height, synced } = daemonStatus.daemonSyncState();
  if (!synced || !Number.isFinite(height) || height <= 0) return null;

  return height - lastConfirmed;
}

function canSendMessages() {
  return messageCapable;
}

function isDaemonStale() {
  return daemonStale;
}

function onDaemonStale(callback) {
  daemonStaleListeners.push(callback);
}

/**
 * Blocks since confirmation read off a tip that has stopped moving. A status can
 * land before the first chain view does, so no current count is on record; the
 * tip then froze where the daemon went quiet, and the difference is the count as
 * of last contact. Null when there is no tip or no confirmation to read.
 * @returns {number|null}
 */
function blocksAtFrozenTip() {
  const lastConfirmed = nodeStatus?.last_confirmed_height;
  if (!Number.isFinite(lastConfirmed) || lastConfirmed <= 0) return null;

  const { height } = daemonStatus.daemonSyncState();
  if (!Number.isFinite(height) || height <= 0) return null;

  return height - lastConfirmed;
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

  const blocksAtLastContact = lastKnownBlocksSinceConfirmation ?? blocksAtFrozenTip();
  if (blocksAtLastContact === null) return false;

  const blocksRemaining = CONFIRM_EXPIRATION_BLOCKS - blocksAtLastContact;
  return elapsedMs > blocksRemaining * BLOCK_INTERVAL_MS;
}

/**
 * Records a status this node has just observed, from whichever transport carried it.
 * @param {object|null} status Status payload in the shape getzelnodestatus returns.
 * @returns {void}
 */
function recordStatus(status) {
  lastStatusObservedAt = process.hrtime.bigint();
  daemonStale = false;
  nodeStatus = status;
  daemonConfirmed = nodeStatus?.status === 'CONFIRMED';

  const blocks = blocksSinceConfirmation();
  if (blocks !== null) lastKnownBlocksSinceConfirmation = blocks;
}

/**
 * Brings the derived state — the gates, the listeners, message capability — into line
 * with whatever was last observed.
 *
 * @param {object} previous Values captured before the observation was applied.
 * @param {boolean} statusObserved Whether a current status was just seen. False means
 *   the caller only advanced the clock or the chain, so the windows are re-examined
 *   against a status that is now older.
 * @returns {Promise<void>}
 */
async function reconcile(previous, statusObserved) {
  const { daemonConfirmed: prevDaemonConfirmed, messageCapable: prevMessageCapable } = previous;

  // Future: use in-band NAK-based confirmation check instead of timeout.
  // See dev/in-band-confirmation-check.md
  const elapsed = elapsedSinceStatusMs();
  if (!statusObserved && elapsed !== null) {
    // Remove apps, but messageCapable preserved (can still broadcast)
    if (elapsed > DAEMON_STALE_MS && !daemonStale) {
      daemonStale = true;
      log.warn(`nodeConfirmationService - Daemon unreachable for ${Math.round(elapsed / 60_000)} minutes, stale`);
      fluxEventBus.publish('daemon:stale', { elapsedMs: elapsed });
      for (const cb of daemonStaleListeners) {
        try { cb(); } catch (e) { log.error(e); }
      }
    }

    if (daemonConfirmed && hasConfirmationExpired(elapsed)) {
      daemonConfirmed = false;
      log.warn('nodeConfirmationService - Confirmation expired on chain while the daemon was unreachable');
      // The cause is published before the capability moves: everything the
      // capability drives is a consequence of it.
      fluxEventBus.publish('confirmation:changed', { confirmed: false });
      publishConfirmed(false, 'confirmation expired on chain while the daemon was unreachable');
    }
  }

  if (statusObserved) {
    // The cause is published before the capability moves: everything the
    // capability drives is a consequence of it.
    if (prevDaemonConfirmed !== daemonConfirmed) {
      const direction = daemonConfirmed ? 'gained' : 'lost';
      log.info(`nodeConfirmationService - Confirmation ${direction}`);
      fluxEventBus.publish('confirmation:changed', { confirmed: daemonConfirmed });
    }
    publishConfirmed(daemonConfirmed, daemonConfirmed ? 'daemon reports this node confirmed' : 'daemon reports this node not confirmed');
  }

  if (!daemonConfirmed) {
    messageCapable = false;
    publishMessageCapable(false, 'node not confirmed by the daemon');
    if (prevMessageCapable !== messageCapable) {
      log.info('nodeConfirmationService - Node not confirmed by daemon, message capability lost');
      fluxEventBus.publish('messageCapability:changed', { capable: messageCapable });
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

    // ASKED OF THE DAEMON, NOT OF THE CACHE. This is the only reader here that
    // establishes whether this node can still be heard, and it does so through the
    // benchmark answering at all - an address it cannot produce is what makes a node
    // stop claiming it can broadcast. A value served from memory answers the address
    // and not the question, so a daemon that died inside the cache window leaves this
    // node believing it can still send, and readiness follows it back up.
    const localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress({ fresh: true });
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
  publishMessageCapable(messageCapable, messageCapable
    ? 'the node list carries this node at its own address and key'
    : 'the node list does not carry this node at its own address and key');

  if (prevMessageCapable !== messageCapable) {
    const direction = messageCapable ? 'gained' : 'lost';
    log.info(`nodeConfirmationService - Message capability ${direction} (confirmed=${daemonConfirmed}, messageCapable=${messageCapable})`);
    fluxEventBus.publish('messageCapability:changed', { capable: messageCapable });
  }
}

/**
 * Asks the daemon for this node's status over RPC.
 * @returns {Promise<boolean>} True when the daemon answered.
 */
async function poll() {
  const previous = { daemonConfirmed, messageCapable };
  let answered = false;

  try {
    const response = await daemonServiceFluxnodeRpcs.getFluxNodeStatus();
    if (response.status === 'success') {
      answered = true;
      recordStatus(response.data ?? null);
    }
  } catch (error) {
    // Unreachable — keep the previous status; a timeout says nothing about the chain.
  }

  daemonReachable = answered;
  await reconcile(previous, answered);
  return answered;
}

/**
 * Applies a status carried by the fluxnodestatus topic.
 *
 * The topic publishes on change, so its arrival is the event; there is nothing to ask
 * for afterwards. It carries the outpoint in two fields where the RPC carries one
 * string, so the collateral is composed back into the shape every reader expects.
 *
 * @param {object} decoded A decoded fluxnodestatus message.
 * @returns {Promise<void>}
 */
async function applyPushedStatus(decoded) {
  const previous = { daemonConfirmed, messageCapable };

  recordStatus({
    ...nodeStatus,
    status: decoded.status,
    tier: decoded.tier,
    collateral: `COutPoint(${decoded.txhash}, ${decoded.outidx})`,
    txhash: decoded.txhash,
    outidx: String(decoded.outidx),
    ip: decoded.ip,
    confirmed_height: decoded.confirmedHeight,
    last_confirmed_height: decoded.lastConfirmedHeight,
    last_paid_height: decoded.lastPaidHeight,
  });

  daemonReachable = true;
  await reconcile(previous, true);

  fluxEventBus.publish('daemon:ownStatus', {
    status: decoded.status,
    tier: decoded.tier,
    lastConfirmedHeight: decoded.lastConfirmedHeight,
    confirmedHeight: decoded.confirmedHeight,
  });
}

/**
 * Re-examines the windows without a new status — the chain moved, so a confirmation
 * that was inside its deadline may no longer be.
 * @returns {Promise<void>}
 */
async function reevaluate() {
  const previous = { daemonConfirmed, messageCapable };
  await reconcile(previous, false);
}

function scheduleNext() {
  pollTimer = setTimeout(async () => {
    await poll();
    scheduleNext();
  }, config.get('confirmation.pollIntervalMs'));
}

/**
 * Begins tracking this node's status.
 *
 * @param {{push?: boolean}} options `push` means a source is feeding statuses in and
 *   the RPC is needed only to seed the first one, since the topic publishes on change
 *   and would otherwise leave a freshly started node with nothing until it changed.
 * @returns {Promise<void>}
 */
async function start(options = {}) {
  if (started) return;
  started = true;
  pushDriven = options.push === true;

  // Whether this node can be heard depends on the node list as much as on the
  // daemon: when the list arrives, ask again rather than wait for the next poll.
  capabilities.onUp('nodeListPopulated', () => {
    reevaluate().catch((error) => log.error(error));
  });

  await poll();
  capabilities.claim('confirmationStatusKnown', 'nodeConfirmationService').raise('first confirmation status read');
  if (!pushDriven) scheduleNext();

  log.info(`nodeConfirmationService - Started ${pushDriven ? 'on fluxnodestatus' : 'polling'} (confirmed=${daemonConfirmed}, messageCapable=${messageCapable})`);
}

/**
 * Stops the polling transport. A push subscription is owned by its source.
 * @returns {void}
 */
function stop() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  started = false;
  pushDriven = false;
}

/**
 * Places the last observed status a given age in the past. Tests express staleness as
 * an age because the clock behind it is monotonic and has no wall-clock equivalent.
 * @param {number|null} ageMs Age in milliseconds, or null for "never observed".
 * @returns {void}
 */
function setLastStatusAgeMs(ageMs) {
  if (ageMs === null) {
    lastStatusObservedAt = null;
    return;
  }

  lastStatusObservedAt = process.hrtime.bigint() - BigInt(Math.round(ageMs * 1_000_000));
}

module.exports = {
  isConfirmed,
  getNodeStatus,
  ownCollateral,
  isDaemonReachable,
  isDaemonStale,
  canSendMessages,
  onDaemonStale,
  applyPushedStatus,
  poll,
  reevaluate,
  start,
  stop,
  setLastStatusAgeMs,
};
