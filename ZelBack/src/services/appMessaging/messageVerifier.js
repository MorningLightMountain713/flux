const config = require('config');
const dbHelper = require('../dbHelper');
const log = require('../../lib/log');
const messageHelper = require('../messageHelper');
const verificationHelper = require('../verificationHelper');
const generalService = require('../generalService');
const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');
const serviceHelper = require('../serviceHelper');
const daemonServiceMiscRpcs = require('../daemonService/daemonServiceMiscRpcs');
const { appPricePerMonth } = require('../utils/appUtilities');
const { getChainParamsPriceUpdates } = require('../utils/chainUtilities');
const { buildPricingEngine } = require('../pricing/buildPricingEngine');
const { getSpec, getSpecBackend } = require('../utils/specLibs');
const appsRepository = require('../appDatabase/appsRepository');
const { insertAppSpecifications, updateAppSpecifications } = require('../appDatabase/registryManager');
const { getPreviousSpec } = require('../appDatabase/appSpecHistory');
const appEventVerifier = require('./appEventVerifier');
const {
  globalAppsMessages,
  globalAppsTempMessages,
  appsHashesCollection,
  scannedHeightCollection,
} = require('../utils/appConstants');
const { invalidMessages } = require('../invalidMessages');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const globalState = require('../utils/globalState');
const { processPendingUpdates } = require('./messageStore');

// Import hashesNumberOfSearchs from appsService - this should be shared state
// For now, we'll create a local instance, but ideally this should be moved to globalState
const hashesNumberOfSearchs = new Map();

/**
 * Request app message from network
 * @param {string} hash - Message hash to request
 * @returns {Promise<void>}
 */
async function requestAppMessage(hash) {
  // some message type request app message, message hash
  // peer responds with data from permanent database or temporary database. If does not have it requests further
  const message = {
    type: 'fluxapprequest',
    version: 1,
    hash,
  };
  await fluxCommunicationMessagesSender.broadcastMessageToAll(message);
}

/**
 * Request multiple app messages from network
 * @param {Array} apps - List of apps with hash property
 * @param {boolean} incoming - If true, request from incoming peers
 * @returns {Promise<void>}
 */
async function requestAppsMessage(apps, incoming) {
  // some message type request app message, message hash
  // peer responds with data from permanent database or temporary database. If does not have it requests further
  const message = {
    type: 'fluxapprequest',
    version: 2,
    hashes: apps.map((a) => a.hash),
  };

  if (incoming) {
    await fluxCommunicationMessagesSender.broadcastMessageToRandomIncoming(message);
  } else {
    await fluxCommunicationMessagesSender.broadcastMessageToRandomOutgoing(message);
  }
}

/**
 * Request app message via API
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @returns {Promise<void>}
 */
async function requestAppMessageAPI(req, res) {
  try {
    // only flux team and node owner can do this
    const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);
    if (!authorized) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
      return;
    }

    let { hash } = req.params;
    hash = hash || req.query.hash;

    if (!hash) {
      throw new Error('No Flux App Hash specified');
    }
    requestAppMessage(hash);
    const resultsResponse = messageHelper.createSuccessMessage(`Application hash ${hash} requested from the network`);
    res.json(resultsResponse);
  } catch (error) {
    log.error(error);
    const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}


/**
 * Check if app hash has message
 * @param {string} hash - Hash to check
 * @returns {Promise<boolean>} True if hash has message
 */
async function appHashHasMessage(hash) {
  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.daemon.database);
  const query = { hash };
  const update = { $set: { message: true, messageNotFound: false } };
  const options = {};
  await dbHelper.updateOneInDatabase(database, appsHashesCollection, query, update, options);
  return true;
}

/**
 * Check if app hash has message not found
 * @param {string} hash - Hash to check
 * @returns {Promise<boolean>} True if hash has message not found
 */
async function appHashHasMessageNotFound(hash) {
  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.daemon.database);
  const query = { hash };
  const update = { $set: { messageNotFound: true } };
  const options = {};
  await dbHelper.updateOneInDatabase(database, appsHashesCollection, query, update, options);
  return true;
}

/**
 * Get temporary app messages via API
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
async function getAppsTemporaryMessages(req, res) {
  try {
    const db = dbHelper.databaseConnection();

    const database = db.db(config.database.appsglobal.database);
    let query = {};
    let { hash } = req.params;
    hash = hash || req.query.hash;
    if (hash) {
      query = { hash };
    }
    const projection = { projection: { _id: 0 } };
    const results = await dbHelper.findInDatabase(database, globalAppsTempMessages, query, projection);
    const resultsResponse = messageHelper.createDataMessage(results);
    res.json(resultsResponse);
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

/**
 * Get permanent app messages via API
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
async function getAppsPermanentMessages(req, res) {
  try {
    const db = dbHelper.databaseConnection();
    const database = db.db(config.database.appsglobal.database);
    const query = {};
    let { hash } = req.params;
    hash = hash || req.query.hash;
    let { owner } = req.params;
    owner = owner || req.query.owner;
    let { appname } = req.params;
    appname = appname || req.query.appname;
    if (hash) {
      query.hash = hash;
    }
    if (owner) {
      query['appSpecifications.owner'] = owner;
    }
    if (appname) {
      query['appSpecifications.name'] = appname;
    }
    const projection = { projection: { _id: 0 } };
    const results = await dbHelper.findInDatabase(database, globalAppsMessages, query, projection);
    const resultsResponse = messageHelper.createDataMessage(results);
    res.json(resultsResponse);
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

// ── Helpers for checkAndRequestApp ──────────────────────────────────

function getDaemonHeight() {
  return daemonServiceMiscRpcs.isDaemonSynced().data.height;
}

function getDefaultExpire(height) {
  return height >= config.fluxapps.daemonPONFork
    ? config.fluxapps.blocksLasting * 4
    : config.fluxapps.blocksLasting;
}

async function constructConfirmedEvent(tempMessage, txid, height, valueSat, blockTime) {
  const { AppEventLegacy, ConfirmedAppEvent } = await getSpecBackend();
  const specs = tempMessage.appSpecifications;

  if (tempMessage.version === 2) {
    return ConfirmedAppEvent.deserialize({
      type: tempMessage.type,
      version: tempMessage.version,
      appSpecifications: specs,
      contentHash: tempMessage.contentHash,
      hash: tempMessage.hash,
      timestamp: tempMessage.timestamp,
      extend: tempMessage.extend ?? true,
      signature: tempMessage.signature,
      txid: serviceHelper.ensureString(txid),
      height: serviceHelper.ensureNumber(height),
      valueSat: serviceHelper.ensureNumber(valueSat),
      registeredAt: serviceHelper.ensureNumber(blockTime),
      arcaneAttestation: tempMessage.arcaneAttestation || null,
    });
  }

  return AppEventLegacy.deserialize({
    type: tempMessage.type,
    version: tempMessage.version,
    appSpecifications: specs,
    hash: tempMessage.hash,
    timestamp: tempMessage.timestamp,
    signature: tempMessage.signature,
    txid: serviceHelper.ensureString(txid),
    height: serviceHelper.ensureNumber(height),
    valueSat: serviceHelper.ensureNumber(valueSat),
  });
}

async function computeRegistrationFee(spec, height) {
  if (spec.version >= 9) {
    const engine = await buildPricingEngine(height);
    const breakdown = await engine.price(spec, { height, duration: spec.ttl || 0 });
    return BigInt(breakdown.total);
  }
  const appPrices = await getChainParamsPriceUpdates();
  let appPrice = await appPricePerMonth(spec, height, appPrices);
  const defaultExpire = getDefaultExpire(height);
  const expireIn = spec.expire || defaultExpire;
  appPrice *= expireIn / defaultExpire;
  appPrice = Math.ceil(appPrice * 100) / 100;
  const intervals = appPrices.filter((p) => p.height < height);
  const priceSpec = intervals[intervals.length - 1];
  if (appPrice < priceSpec.minPrice) appPrice = priceSpec.minPrice;
  return BigInt(Math.round(appPrice * 1e8));
}

async function computeUpdateFee(spec, prevSpec, height, prevHeight) {
  if (spec.version >= 9) {
    const engine = await buildPricingEngine(height);
    const result = await engine.priceUpdate(prevSpec, spec, {
      height,
      duration: spec.ttl || 0,
      now: Date.now(),
      recentEvents: [],
    });
    return (result && result.free) ? 0n : BigInt(result.total);
  }
  const appPrices = await getChainParamsPriceUpdates();
  let appPrice = await appPricePerMonth(spec, height, appPrices);
  let previousSpecsPrice = await appPricePerMonth(prevSpec, prevHeight, appPrices);
  const defaultExpireCurrent = getDefaultExpire(height);
  const defaultExpirePrevious = getDefaultExpire(prevHeight);
  const currentExpireIn = spec.expire || defaultExpireCurrent;
  const previousExpireIn = prevSpec.expire || defaultExpirePrevious;
  appPrice *= currentExpireIn / defaultExpireCurrent;
  appPrice = Math.ceil(appPrice * 100) / 100;
  previousSpecsPrice *= previousExpireIn / defaultExpirePrevious;
  previousSpecsPrice = Math.ceil(previousSpecsPrice * 100) / 100;
  const heightDifference = height - prevHeight;
  const perc = (previousExpireIn - heightDifference) / previousExpireIn;
  let actualPriceToPay = appPrice * 0.9;
  if (perc > 0) {
    actualPriceToPay = (appPrice - (perc * previousSpecsPrice)) * 0.9;
  }
  actualPriceToPay = Number(Math.ceil(actualPriceToPay * 100) / 100);
  const intervals = appPrices.filter((p) => p.height < height);
  const priceSpec = intervals[intervals.length - 1];
  if (actualPriceToPay < priceSpec.minPrice) {
    actualPriceToPay = priceSpec.minPrice;
  }
  return BigInt(Math.round(actualPriceToPay * 1e8));
}

async function handleExpiredApp(name) {
  log.warn(`App ${name} has expired. Cleaning up stale data.`);
  const existingGlobal = await appsRepository.existsGlobalApp(name);
  if (existingGlobal) {
    log.warn(`Removing expired app ${name} from global apps database`);
    await appsRepository.removeGlobalAppInfo(name);
  }
  const existingLocal = await appsRepository.existsInstalledApp(name);
  if (existingLocal) {
    log.warn(`REMOVAL REASON: App expired - ${name} update received after expiration (messageVerifier)`);
    // eslint-disable-next-line global-require
    const appUninstaller = require('../appLifecycle/appUninstaller');
    await appUninstaller.uninstallApplication(name, { forceKill: true, skipGuard: true, broadcastRemoval: true });
  }
}

// ── Core promotion function ─────────────────────────────────────────

/**
 * Promote a temp message to permanent when the chain confirms it.
 * Called by explorerService when it encounters an OP_RETURN with an app hash.
 *
 * @param {string} hash - Message hash
 * @param {string} txid - Confirming transaction ID
 * @param {number} height - Block height
 * @param {number} valueSat - Satoshis paid in the transaction
 * @param {number} blockTime - Unix timestamp of the confirming block
 * @param {number} i - Retry counter (internal)
 * @returns {Promise<boolean>}
 */
async function checkAndRequestApp(hash, txid, height, valueSat, blockTime = null, i = 0) {
  try {
    if (height < config.fluxapps.epochstart) return false;

    const existing = await appsRepository.getPermanentMessage(hash);
    if (existing) {
      await appHashHasMessage(hash);
      return true;
    }

    const tempMessage = await appsRepository.getTempMessage(hash);
    if (!tempMessage || typeof tempMessage !== 'object' || Array.isArray(tempMessage)) {
      if (i < 2) {
        await requestAppMessage(hash);
        await serviceHelper.delay(60 * 1000);
        return checkAndRequestApp(hash, txid, height, valueSat, blockTime, i + 1);
      }
      return false;
    }

    const specifications = tempMessage.appSpecifications;
    if (!specifications) {
      log.error(`Temp message ${hash} has no specifications`);
      return false;
    }

    // Construct the confirmed event from temp message + chain data.
    // This deserializes the spec into its class instance (v1-v9).
    const confirmedEvent = await constructConfirmedEvent(tempMessage, txid, height, valueSat, blockTime);

    // Re-verify signature for updates against current permanent state.
    // Prevents race: two updates verified against same state at temp time,
    // but the first one changed the owner before the second is promoted.
    if (confirmedEvent.isUpdate) {
      const previousSpec = await getPreviousSpec(specifications, tempMessage.timestamp);
      if (previousSpec) {
        const currentState = await appsRepository.getGlobalAppInfo(specifications.name);
        await appEventVerifier.authorize({
          appEvent: confirmedEvent,
          previousSpec: currentState ? currentState.spec : null,
          daemonHeight: getDaemonHeight(),
        });
      }
    }

    // Store the permanent message
    await appsRepository.storePermanentMessage(confirmedEvent.serialize());
    await appHashHasMessage(hash);

    // Project to InstantiatedSpec — the domain type for live app state
    const { InstantiatedSpec } = await getSpecBackend();
    const instantiated = InstantiatedSpec.fromEvent(confirmedEvent.toInstantiatedSpec());

    // Expiry check
    const daemonHeight = getDaemonHeight();
    if (instantiated.isExpired(blockTime, daemonHeight)) {
      await handleExpiredApp(instantiated.name);
      return true;
    }

    // Pricing — the spec is already a class instance on confirmedEvent.spec
    const spec = instantiated.spec;
    if (confirmedEvent.isRegistration) {
      const requiredSats = await computeRegistrationFee(spec, height);
      if (BigInt(valueSat) >= requiredSats) {
        await insertAppSpecifications(instantiated.serialize());
        await processPendingUpdates(instantiated.name);
      } else {
        log.warn(`App ${hash} registration underpaid: ${valueSat} < ${requiredSats}`);
      }
    } else {
      const prevMessage = await appsRepository.getPreviousPermanentMessage(
        spec.name, tempMessage.timestamp,
      );
      if (!prevMessage) {
        log.error(`Last permanent message for ${spec.name} not found`);
        return true;
      }
      const prevSpecs = prevMessage.appSpecifications;
      await getSpec();
      const { deserializeSpec } = await getSpecBackend();
      const prevSpec = deserializeSpec(prevSpecs);
      const requiredSats = await computeUpdateFee(spec, prevSpec, height, prevMessage.height);
      if (BigInt(valueSat) >= requiredSats) {
        await updateAppSpecifications(instantiated.serialize());
      } else {
        log.warn(`App ${hash} update underpaid: ${valueSat} < ${requiredSats}`);
      }
    }

    return true;
  } catch (error) {
    log.error(`Error checking and requesting app ${hash}:`, error);
    log.error(`Error details - Message: ${error.message}, Stack: ${error.stack}`);
    return false;
  }
}

/**
 * Check and request multiple app messages in batch
 * @param {object[]} apps - Array of app objects with hash, txid, height, value properties
 * @param {boolean} incoming - Whether messages are incoming
 * @param {number} i - Retry counter
 * @returns {Promise<void>} Completion status
 */
async function checkAndRequestMultipleApps(apps, incoming = false, i = 1) {
  try {
    const numberOfPeers = fluxNetworkHelper.getNumberOfPeers();
    if (numberOfPeers < 12) {
      log.info('checkAndRequestMultipleApps - Not enough connected peers to request missing Flux App messages');
      return;
    }
    await requestAppsMessage(apps, incoming);
    await serviceHelper.delay(30 * 1000);
    const appsToRemove = [];
    // eslint-disable-next-line no-restricted-syntax
    for (const app of apps) {
      // eslint-disable-next-line no-await-in-loop
      const messageReceived = await checkAndRequestApp(app.hash, app.txid, app.height, app.value, null, 2);
      if (messageReceived) {
        appsToRemove.push(app);
      }
    }
    // eslint-disable-next-line no-param-reassign
    apps = apps.filter((item) => !appsToRemove.includes(item));
    if (apps.length > 0 && i < 5) {
      await checkAndRequestMultipleApps(apps, i % 2 === 0, i + 1);
    }
  } catch (error) {
    log.error(error);
  }
}

// Global variables for continuousFluxAppHashesCheck
let continuousFluxAppHashesCheckRunning = false;
let firstContinuousFluxAppHashesCheckRun = true;

/**
 * Continuously checks for missing flux app hashes and requests missing messages
 * @param {boolean} force - Force check even if already running
 * @returns {Promise<void>}
 */
async function continuousFluxAppHashesCheck(force = false) {
  try {
    if (continuousFluxAppHashesCheckRunning) {
      return;
    }
    log.info('Requesting missing Flux App messages');
    continuousFluxAppHashesCheckRunning = true;
    const numberOfPeers = fluxNetworkHelper.getNumberOfPeers();
    if (numberOfPeers < 12) {
      log.info('Not enough connected peers to request missing Flux App messages');
      continuousFluxAppHashesCheckRunning = false;
      return;
    }

    const synced = await generalService.checkSynced();
    if (synced !== true) {
      log.info('Flux not yet synced');
      continuousFluxAppHashesCheckRunning = false;
      return;
    }

    if (firstContinuousFluxAppHashesCheckRun && !globalState.checkAndSyncAppHashesWasEverExecuted) {
      // Import checkAndSyncAppHashes from appHashSyncService
      // eslint-disable-next-line global-require
      const appHashSyncService = require('./appHashSyncService');
      await appHashSyncService.checkAndSyncAppHashes();
    }

    const dbopen = dbHelper.databaseConnection();
    const database = dbopen.db(config.database.daemon.database);
    const queryHeight = { generalScannedHeight: { $gte: 0 } };
    const projectionHeight = {
      projection: {
        _id: 0,
        generalScannedHeight: 1,
      },
    };
    const scanHeight = await dbHelper.findOneInDatabase(database, scannedHeightCollection, queryHeight, projectionHeight);
    if (!scanHeight) {
      throw new Error('Scanning not initiated');
    }
    const explorerHeight = serviceHelper.ensureNumber(scanHeight.generalScannedHeight);

    // get flux app hashes that do not have a message
    const query = { message: false };
    const projection = {
      projection: {
        _id: 0,
        txid: 1,
        hash: 1,
        height: 1,
        value: 1,
        message: 1,
        messageNotFound: 1,
      },
    };
    const results = await dbHelper.findInDatabase(database, appsHashesCollection, query, projection);
    // sort it by height, so we request oldest messages first
    results.sort((a, b) => a.height - b.height);
    let appsMessagesMissing = [];
    // eslint-disable-next-line no-restricted-syntax
    for (const result of results) {
      if (!result.messageNotFound || force || firstContinuousFluxAppHashesCheckRun) { // most likely wrong data, if no message found. This attribute is cleaned every reconstructAppMessagesHashPeriod blocks so all nodes search again for missing messages
        let heightDifference = explorerHeight - result.height;
        if (heightDifference < 0) {
          heightDifference = 0;
        }
        let maturity = Math.round(heightDifference / config.fluxapps.blocksLasting);
        if (maturity > 12) {
          maturity = 16; // maturity of max 16 representing its older than 1 year. Old messages will only be searched 3 times, newer messages more oftenly
        }
        if (invalidMessages.find((message) => message.hash === result.hash && message.txid === result.txid)) {
          if (!force) {
            maturity = 30; // do not request known invalid messages.
          }
        }
        // every config.fluxapps.blocksLasting increment maturity by 2;
        let numberOfSearches = maturity;
        if (hashesNumberOfSearchs.has(result.hash)) {
          numberOfSearches = hashesNumberOfSearchs.get(result.hash) + 2; // max 10 tries
        }
        hashesNumberOfSearchs.set(result.hash, numberOfSearches);
        log.info(`Requesting missing Flux App message: ${result.hash}, ${result.txid}, ${result.height}`);
        if (numberOfSearches <= 20) { // up to 10 searches
          const appMessageInformation = {
            hash: result.hash,
            txid: result.txid,
            height: result.height,
            value: result.value,
          };
          appsMessagesMissing.push(appMessageInformation);
          if (appsMessagesMissing.length === 500) {
            log.info('Requesting 500 app messages');
            checkAndRequestMultipleApps(appsMessagesMissing);
            // eslint-disable-next-line no-await-in-loop
            await serviceHelper.delay(2 * 60 * 1000); // delay 2 minutes to give enough time to process all messages received
            appsMessagesMissing = [];
          }
        } else {
          // eslint-disable-next-line no-await-in-loop
          await appHashHasMessageNotFound(result.hash); // mark message as not found
          hashesNumberOfSearchs.delete(result.hash); // remove from our map
        }
      }
    }
    if (appsMessagesMissing.length > 0) {
      log.info(`Requesting ${appsMessagesMissing.length} app messages`);
      checkAndRequestMultipleApps(appsMessagesMissing);
    }
    continuousFluxAppHashesCheckRunning = false;
    firstContinuousFluxAppHashesCheckRun = false;
  } catch (error) {
    log.error(error);
    continuousFluxAppHashesCheckRunning = false;
    firstContinuousFluxAppHashesCheckRun = false;
  }
}

/**
 * API endpoint to manually trigger app hashes check
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @returns {Promise<void>}
 */
async function triggerAppHashesCheckAPI(req, res) {
  try {
    // only flux team and node owner can do this
    const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);
    if (!authorized) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
      return;
    }

    continuousFluxAppHashesCheck(true);
    const resultsResponse = messageHelper.createSuccessMessage('Running check on missing application messages ');
    res.json(resultsResponse);
  } catch (error) {
    log.error(error);
    const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

module.exports = {
  requestAppMessage,
  requestAppsMessage,
  requestAppMessageAPI,
  appHashHasMessage,
  appHashHasMessageNotFound,
  getAppsTemporaryMessages,
  getAppsPermanentMessages,
  checkAndRequestApp,
  checkAndRequestMultipleApps,
  continuousFluxAppHashesCheck,
  triggerAppHashesCheckAPI,
};
