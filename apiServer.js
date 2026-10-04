// First, and above every other require: the environment this process answers from. This
// file runs as an entry point of its own under `require.main === module`, so it settles
// the environment rather than relying on whoever required it having done so.
require('./ZelBack/pinEnvironment');
// Second, and above everything that reads config: every fluxapps knob this code
// names must be one config ships. Same refusal as the userconfig check below,
// for the half of the configuration that ships with the node rather than being
// written by the operator.
require('./ZelBack/configReconciliation').reconcile();

const configManager = require('./ZelBack/src/services/utils/configManager');

// Refuse to start on a config that could not be read or did not validate, rather than
// running on defaults. A node with no zelid cannot authenticate its own operator, so it
// would come up looking healthy while being unable to do anything or to be fixed through
// its own API. Exiting non-zero instead means systemd retries, and the node recovers on
// its own once the file is corrected.
const configError = configManager.getLastLoadError();
if (configError) {
  console.error(`FluxOS cannot start - config/userconfig.js ${configError}`);
  process.exit(1);
}

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const config = require('config');

// The core, and only the core: the API listens once these are loaded, and every
// service loads after it (lib/moduleLoader.js).
const fluxServer = require('./ZelBack/src/lib/fluxServer');
const moduleLoader = require('./ZelBack/src/lib/moduleLoader');
const log = require('./ZelBack/src/lib/log');
const serviceHelper = require('./ZelBack/src/services/serviceHelper');
const capabilities = require('./ZelBack/src/services/utils/capabilities');
const specLibrary = require('./ZelBack/src/services/utils/specLibrary');

// Read through the manager rather than off globalThis: the dependency on the config
// having been loaded is then a real one, not an ordering convention between requires.
const apiPort = configManager.getConfigValue('initial.apiport') || config.server.apiport;
const apiPortHttps = +apiPort + 1;

/**
 * The Cacheable. So we only instantiate it once (and for testing)
 */
let cacheable = null;

/**
 * Gets the cacheable CacheableLookup() for testing
 */
function getCacheable() {
  return cacheable;
}

/**
 * Gets the cacheable CacheableLookup() for testing
 */
function resetCacheable() {
  cacheable = null;
}

/**
 * Adds extra servers to DNS, if they are not being used already. This is just
 * within the NodeJS process, not systemwide.
 *
 * Sets these globally for both http and https (axios) It will use the OS servers
 * by default, and if they fail, move on to our added servers, if a server fails, requests
 * go to an active server immediately, for a period.
 * @param {Map?} userCache An optional cache, we use this as a reference for testing
 * @returns {Promise<void>}
 */
async function createDnsCache(userCache) {
  try {
    if (cacheable) return;

    const cache = userCache || new Map();

    const { default: CacheableLookup } = await moduleLoader.importModule('cacheable-lookup');
    cacheable = new CacheableLookup({ maxTtl: 360, cache });

    cacheable.install(http.globalAgent);
    cacheable.install(https.globalAgent);

    const cloudflareDns = '1.1.1.1';
    const googleDns = '8.8.8.8';
    const quad9Dns = '9.9.9.9';

    const backupServers = [cloudflareDns, googleDns, quad9Dns];

    const existingServers = cacheable.servers;

    // it dedupes any servers
    cacheable.servers = [...existingServers, ...backupServers];
  } catch (error) {
    log.error(error);
  }
}


/**
 * Utility function to log error before exiting. As the logging is async, if
 * we don't wait a while, the process exits bofore the logging takes place
 *
 * @param {string} msg
 * @param {{delay?: number, exitCode?: number}} options
 */
async function logErrorAndExit(msg, options = {}) {
  const delayMs = options.delay || 1000;
  const exitCode = options.exitCode || 0;

  if (msg) log.error(msg);

  const delayS = Math.round((delayMs / 1000) * 100) / 100;

  log.info(`Waiting: ${delayS}s, before exiting with code: ${exitCode}`);

  await serviceHelper.delay(delayMs);
  process.exit(exitCode);
}



/**
 * Main entrypoint
 *
 * @returns {Promise<String>}
 */
async function initiate() {
  // Before anything else: every later caller reaches flux-spec synchronously.
  await specLibrary.loadSpecLibrary();
  if (!config.server.allowedPorts.includes(+apiPort)) {
    await logErrorAndExit(`Flux port ${apiPort} is not supported. Shutting down.`);
  }

  process.on('uncaughtException', (err) => {
    const dnsErrors = ['ENOTFOUND', 'EAI_AGAIN', 'ESERVFAIL'];
    if (dnsErrors.includes(err.code) && err.hostname) {
      log.error('Uncaught DNS Lookup Error!!, swallowing.');
      log.error(err);
      return;
    }

    logErrorAndExit(err, { exitCode: 1 });
  });

  await createDnsCache();

  const appRoot = process.cwd();
  // ToDo: move this to async
  const certExists = fs.existsSync(path.join(appRoot, 'certs/v1.key'));

  if (!certExists) {
    const cwd = path.join(appRoot, 'helpers');
    const scriptPath = path.join(cwd, 'createSSLcert.sh');
    await serviceHelper.runCommand(scriptPath, { cwd });
  }

  // ToDo: move these to async
  const key = fs.readFileSync(path.join(appRoot, 'certs/v1.key'), 'utf8');
  const cert = fs.readFileSync(path.join(appRoot, 'certs/v1.crt'), 'utf8');

  const httpServer = new fluxServer.FluxServer();
  const httpsServer = new fluxServer.FluxServer({
    mode: 'https', key, cert, expressApp: httpServer.app,
  });

  const httpError = await httpServer.listen(apiPort).catch((err) => err);

  if (httpError) {
    // if shutting down clean, nodemon won't restart
    logErrorAndExit(`Flux api server unable to start. ${httpError}`);
    return '';
  }

  const httpsError = await httpsServer.listen(apiPortHttps).catch((err) => err);

  if (httpsError) {
    // if shutting down clean, nodemon won't restart
    logErrorAndExit(`Flux api server unable to start. ${httpsError}`);
    return '';
  }

  log.info(`Flux listening on port ${apiPort}!`);
  log.info(`Flux https listening on port ${apiPortHttps}!`);
  capabilities.claim('apiListening', 'apiServer').raise(`listening on ${apiPort} and ${apiPortHttps}`);


  // Every service loads here, once the API answers.
  moduleLoader.load('services/nodeProcess').start({
    apiPort, socketIoServers: [httpServer.socketIo, httpsServer.socketIo],
  });

  return apiPort;
}




if (require.main === module) {
  initiate();
}

module.exports = {
  createDnsCache,
  getCacheable,
  initiate,
  resetCacheable,
};
