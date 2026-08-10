'use strict';

const config = require('config');
const messageHelper = require('../messageHelper');
const serviceHelper = require('../serviceHelper');
const daemonServiceUtils = require('./daemonServiceUtils');
const daemonServiceBlockchainRpcs = require('./daemonServiceBlockchainRpcs');
const log = require('../../lib/log');
const fluxEventBus = require('../utils/fluxEventBus');

/**
 * Get the default daemon header based on testnet configuration
 * @returns {number} Default header height
 */
function getDefaultDaemonHeader() {
  const isTestnet = globalThis.userconfig.initial?.testnet === true;
  return isTestnet ? 377006 : 1136836;
}

let currentDaemonHeight = 0;
let currentDaemonHeader = getDefaultDaemonHeader();
let isDaemonInsightExplorer = null;
// Monotonic. A wall clock jump — an NTP correction, a resumed VM — must not be able to
// age this out, because a stale reading here is what sheds every app on the node.
let lastChainUpdateAt = null;

// Long enough that an ordinary slow block is not suspicious.
const CHAIN_STALE_AFTER_MS = config.daemon.subscriptions.chainStaleAfterMs;

function elapsedSinceChainUpdateMs() {
  if (lastChainUpdateAt === null) return null;
  return Number(process.hrtime.bigint() - lastChainUpdateAt) / 1_000_000;
}

/**
 * Records a new chain tip seen on the push socket.
 *
 * Height only. `headers` is what the chain claims to be, and a daemon that is past
 * initial download but still catching up publishes a block per connection — so
 * inferring headers from a pushed height would call it synced while it is behind.
 * The authoritative pair still comes from RPC, just far less often.
 *
 * @param {number} height Height of the block just connected.
 * @returns {void}
 */
function recordChainTip(height) {
  if (!Number.isInteger(height)) return;

  currentDaemonHeight = height;
  // A reorg genuinely shortens the chain, so the tip is allowed to move down.
  if (height > currentDaemonHeader) currentDaemonHeader = height;
  lastChainUpdateAt = process.hrtime.bigint();
}

/**
 * To check if Insight Explorer is activated in the daemon configuration file.
 * @returns {boolean} True if the daemon is configured with Insight Explorer on.
 */
function isInsightExplorer() {
  if (isDaemonInsightExplorer != null) {
    return isDaemonInsightExplorer;
  }
  const insightValue = daemonServiceUtils.getConfigValue('insightexplorer');
  if (insightValue === 1 || insightValue === '1') {
    isDaemonInsightExplorer = true;
    return true;
  }
  isDaemonInsightExplorer = false;
  return false;
}

// == NON Daemon ==
/**
 * To check if daemon is synced.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {object} Message.
 */
function isDaemonSynced(req, res) {
  const isSynced = {
    header: currentDaemonHeader,
    height: currentDaemonHeight,
    synced: false,
  };

  const elapsed = elapsedSinceChainUpdateMs();

  if (elapsed === null || elapsed > CHAIN_STALE_AFTER_MS) {
    // Nothing recent from either the socket or RPC, so we cannot claim to know.
    isSynced.synced = false;
  } else if (currentDaemonHeight > currentDaemonHeader - 5) {
    isSynced.synced = true;
  }

  const successResponse = messageHelper.createDataMessage(isSynced);
  return res ? res.json(successResponse) : successResponse;
}

/**
 * To show flux daemon blockchain sync status in logs.
 */
async function fluxDaemonBlockchainInfo() {
  try {
    const daemonBlockChainInfo = await daemonServiceUtils.executeCall('getBlockchainInfo', []);
    if (daemonBlockChainInfo.status !== 'success') {
      log.error(daemonBlockChainInfo.data.message || daemonBlockChainInfo.data);
      return false;
    }
    currentDaemonHeight = daemonBlockChainInfo.data.blocks;
    // Authoritative in both directions. A reorg lowers both, and clamping the header
    // to its high water mark would leave the node reading as unsynced against a
    // height that no longer exists.
    currentDaemonHeader = daemonBlockChainInfo.data.headers;
    lastChainUpdateAt = process.hrtime.bigint();
    fluxEventBus.publish('daemon:polled', { height: currentDaemonHeight, headers: currentDaemonHeader });
    log.info(`Daemon Sync status: ${currentDaemonHeight}/${currentDaemonHeader}`);
    return true;
  } catch (error) {
    log.warn(error);
    return false;
  }
}

/**
 * To call the flux daemon blockchain info function at set intervals.
 */
async function daemonBlockchainInfoService() {
  let reachable = null;
  async function pollAndEmit() {
    const succeeded = await fluxDaemonBlockchainInfo();
    if (reachable !== succeeded) {
      reachable = succeeded;
      fluxEventBus.publish(succeeded ? 'daemon:recovered' : 'daemon:unreachable', {});
    }
  }
  await pollAndEmit();
  function scheduleNext() {
    setTimeout(async () => {
      await pollAndEmit();
      scheduleNext();
    }, config.fluxapps.daemonInfoIntervalMs ?? 30000);
  }
  scheduleNext();
}

const RPC_IN_WARMUP = -28;

/**
 * Wait for the daemon RPC to become available.
 * Polls getblockcount every 5 seconds until a successful response.
 * @returns {Promise<number>} The block height once RPC is available.
 */
async function waitForDaemonRpc() {
  const POLL_INTERVAL_MS = 5000;
  const LOG_INTERVAL_MS = 60000;
  let lastLogAt = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await daemonServiceBlockchainRpcs.getBlockCount();
    if (result.status === 'success') {
      log.info(`Daemon RPC available at block height ${result.data}`);
      return result.data;
    }
    const now = Date.now();
    if (!lastLogAt || now - lastLogAt >= LOG_INTERVAL_MS) {
      const reason = result.data?.code === RPC_IN_WARMUP
        ? result.data.message
        : 'daemon not reachable';
      log.info(`Waiting for daemon RPC... (${reason})`);
      lastLogAt = now;
    }
    // eslint-disable-next-line no-await-in-loop
    await serviceHelper.delay(POLL_INTERVAL_MS);
  }
}

function getIsDaemonInsightExplorer() {
  return isDaemonInsightExplorer;
}

function setIsDaemonInsightExplorer(newValue) {
  isDaemonInsightExplorer = newValue;
}

function setCurrentDaemonHeight(newValue) {
  currentDaemonHeight = newValue;
}

function setCurrentDaemonHeader(newValue) {
  currentDaemonHeader = newValue;
}

function getCurrentDaemonHeight() {
  return currentDaemonHeight;
}

function getCurrentDaemonHeader() {
  return currentDaemonHeader;
}

function getElapsedSinceChainUpdateMs() {
  return elapsedSinceChainUpdateMs();
}

/**
 * Places the last chain update a given age in the past. Tests express staleness as an
 * age because the clock behind it is monotonic and has no wall-clock equivalent.
 * @param {number|null} ageMs Age in milliseconds, or null for "never updated".
 * @returns {void}
 */
function setLastChainUpdateAgeMs(ageMs) {
  if (ageMs === null) {
    lastChainUpdateAt = null;
    return;
  }

  lastChainUpdateAt = process.hrtime.bigint() - BigInt(Math.round(ageMs * 1_000_000));
}

module.exports = {
  isInsightExplorer,
  // == NON Daemon ==
  isDaemonSynced,
  daemonBlockchainInfoService,
  recordChainTip,
  waitForDaemonRpc,

  // exports for testing purposes
  fluxDaemonBlockchainInfo,
  getIsDaemonInsightExplorer,
  setIsDaemonInsightExplorer,
  setCurrentDaemonHeight,
  setCurrentDaemonHeader,
  getCurrentDaemonHeight,
  getCurrentDaemonHeader,
  getElapsedSinceChainUpdateMs,
  setLastChainUpdateAgeMs,
};
