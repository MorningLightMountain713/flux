'use strict';

const asyncLock = require('../utils/asyncLock');
const fluxRpc = require('../utils/fluxRpc');
const daemonConfig = require('../utils/daemonConfig');
const messageHelper = require('../messageHelper');

const config = require('config');
const configManager = require('../utils/configManager');

// Helper function to get testnet flag dynamically
const isTestnet = () => configManager.getConfigValue('initial.testnet') || false;

let fluxdConfig = null;
let fluxdClient = null;

/**
 * AsyncLock used to limit concurrent calls to the Daemon RPC endpoint.
 * Semaphore with 5 slots to prevent a single long-running RPC (e.g.
 * createConfirmationTransaction) from blocking unrelated RPCs like loginPhrase.
 */
const lock = new asyncLock.AsyncLock(5);


async function readDaemonConfig() {
  fluxdConfig = new daemonConfig.DaemonConfig();
  await fluxdConfig.parseConfig();
}

async function buildFluxdClient() {
  if (!fluxdConfig) await readDaemonConfig();

  const username = fluxdConfig.rpcuser || 'rpcuser';
  const password = fluxdConfig.rpcpassword || 'rpcpassword';

  const portId = isTestnet() ? 'rpcporttestnet' : 'rpcport';

  const rpcPort = fluxdConfig.rpcport || config.daemon[portId];

  const rpcHost = config.daemon.host;
  const client = new fluxRpc.FluxRpc(`http://${rpcHost}:${rpcPort}`, {
    auth: { username, password }, timeout: 40_000,
  });

  fluxdClient = client;

  return client;
}

/**
 * To execute a remote procedure call (RPC).
 *
 * The daemon is asked, never remembered. Nothing it answers is safe to reuse: the
 * wallet and fluxnode calls act as well as answer, so a repeated `sendToAddress`
 * served from a cache hands back the earlier txid and never sends; and the read calls
 * describe live chain state, which is exactly the thing that has moved by the time a
 * second caller asks. Even a block is only fixed in its serialized form — the verbose
 * answer carries `confirmations`, which grows every block and reads -1 once the block
 * is off the main chain.
 *
 * Responses that are worth repeating are cached at the HTTP layer instead, where the
 * key is the URL rather than caller-supplied JSON. Every read route already carries
 * `cache('30 seconds')` or longer.
 *
 * @param {string} rpc Remote procedure call.
 * @param {string[]} params RPC parameters.
 * @returns {object} Message.
 */
async function executeCall(rpc, params) {
  const rpcparameters = params || [];

  if (!fluxdClient) await buildFluxdClient();

  const release = await lock.acquire({ label: 'daemonRpc' });

  try {
    const data = await fluxdClient.run(rpc, { params: rpcparameters });
    return messageHelper.createDataMessage(data);
  } catch (error) {
    const daemonError = messageHelper.createErrorMessage(error.message, error.name, error.code);
    return daemonError;
  } finally {
    release();
  }
}

/**
 * Execute a batch of RPC calls directly, bypassing cache and semaphore lock.
 * @param {Array<{method: string, params: Array}>} calls Array of RPC call specifications.
 * @returns {object} Message containing array of {id, result, error} objects.
 */
async function executeBatchCall(calls) {
  if (!fluxdClient) await buildFluxdClient();

  try {
    const data = await fluxdClient.runBatch(calls);
    return messageHelper.createDataMessage(data);
  } catch (error) {
    return messageHelper.createErrorMessage(error.message, error.name, error.code);
  }
}

/**
 * The daemon calls made since this was last asked, and resets the count.
 * @returns {Map<string, number>} Method name to call count, empty before the client exists.
 */
function takeRpcCallCounts() {
  return fluxdClient ? fluxdClient.takeCallCounts() : new Map();
}

/**
 * To get a value for a specified key from the configuration file.
 * @param {string} parameter Config key.
 * @returns {string} Config value.
 */
function getConfigValue(parameter) {
  if (!fluxdConfig) return undefined;

  const value = fluxdConfig.get(parameter);
  return value;
}

/**
 * To set a value for a specified key from the configuration file.
 * @param {string} parameter Config key.
 * @param {string} value Config key value.
 * @param {{replace?: boolean}} options
 * @returns {<void>}
 */
function setConfigValue(parameter, value, options = {}) {
  if (!fluxdConfig) return;

  const replace = options.replace || false;

  fluxdConfig.set(parameter, value, replace);
}

/**
 * The DaemonConfig object
 * @returns {daemonConfig.DaemonConfig}
 */
function getFluxdConfig() {
  return fluxdConfig;
}

/**
 * The fluxd config file path
 * @returns {string}
 */
function getFluxdConfigPath() {
  return fluxdConfig.absConfigPath;
}

/**
 * The fluxd config directory
 * @returns {string}
 */
function getFluxdDir() {
  if (!fluxdConfig) return undefined;

  return fluxdConfig.configDir;
}

/**
 * The fluxd daemon rpc client
 * @returns {daemonrpc.Client}
 */
function getFluxdClient() {
  return fluxdClient;
}

/**
 *  writes a flux config to the fluxd config directory
 * @param {string?} fileName The name of the config file to write. If empty, this
 * defaults to flux.conf
 * @returns {Promise<Boolean>}
 */
async function writeFluxdConfig(fileName = null) {
  await fluxdConfig.write({ fileName });
}

/**
 *
 * @param {string} fileName The name of the backup file to write (in the fluxd conf dir)
 * @returns {Promise<boolean>}
 */
async function createBackupFluxdConfig(fileName) {
  if (!fileName) return false;

  return fluxdConfig.createBackupConfig(fileName);
}

/**
 * Testing
 */
function setFluxdClient(testClient) {
  fluxdClient = testClient;
}

module.exports = {
  buildFluxdClient,
  createBackupFluxdConfig,
  executeCall,
  executeBatchCall,
  getConfigValue,
  takeRpcCallCounts,
  getFluxdClient,
  getFluxdConfig,
  getFluxdConfigPath,
  getFluxdDir,
  readDaemonConfig,
  setConfigValue,
  writeFluxdConfig,

  // exports for testing purposes
  setFluxdClient,
};
