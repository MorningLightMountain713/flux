'use strict';

const config = require('config');
const dbHelper = require('../dbHelper');
const log = require('../../lib/log');
const messageHelper = require('../messageHelper');
const verificationHelper = require('../verificationHelper');
const generalService = require('../generalService');
const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');
const serviceHelper = require('../serviceHelper');
const appsRepository = require('../appDatabase/appsRepository');
const confirmedMessageStore = require('./confirmedMessageStore');
const {
  globalAppsMessages,
  globalAppsTempMessages,
  appsHashesCollection,
  scannedHeightCollection,
} = require('../utils/appConstants');
const { invalidMessages } = require('../invalidMessages');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const { Privilege, authOf } = require('../utils/privileges');

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
 * Request multiple app messages from one random held peer. Retries land on
 * different peers by randomness, not by direction — the old incoming flag
 * alternated socket populations whose split is a dial-race outcome.
 * @param {Array} apps - List of apps with hash property
 * @returns {Promise<void>}
 */
async function requestAppsMessage(apps) {
  // some message type request app message, message hash
  // peer responds with data from permanent database or temporary database. If does not have it requests further
  const message = {
    type: 'fluxapprequest',
    version: 2,
    hashes: apps.map((a) => a.hash),
  };
  await fluxCommunicationMessagesSender.broadcastMessageToRandomPeer(message);
}

/**
 * Request app message via API
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
async function requestAppMessageAPI(req, res) {
  try {
    // only flux team and node owner can do this
    const authorized = await verificationHelper.verifyPrivilege(Privilege.NODE_OPERATOR_OR_FLUX_TEAM, authOf(req));
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
  const database = db.db(config.get('database.daemon.database'));
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
  const database = db.db(config.get('database.daemon.database'));
  const query = { hash };
  const update = { $set: { messageNotFound: true } };
  const options = {};
  await dbHelper.updateOneInDatabase(database, appsHashesCollection, query, update, options);
  return true;
}

/**
 * Get temporary app messages via API
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getAppsTemporaryMessages(req, res) {
  try {
    const db = dbHelper.databaseConnection();

    const database = db.db(config.get('database.appsglobal.database'));
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
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getAppsPermanentMessages(req, res) {
  try {
    const db = dbHelper.databaseConnection();
    const database = db.db(config.get('database.appsglobal.database'));
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

/**
 * Get ingress attestations for an app-message hash. fluxteam-only: this exposes
 * the source address a registration/update was submitted from, which must never
 * reach the public API.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getIngressAttestations(req, res) {
  try {
    const authorized = await verificationHelper.verifyPrivilege(Privilege.FLUX_TEAM, authOf(req));
    if (!authorized) {
      res.json(messageHelper.errUnauthorizedMessage());
      return;
    }
    let { hash } = req.params;
    hash = hash || req.query.hash;
    if (!hash) {
      res.json(messageHelper.createErrorMessage('hash parameter is mandatory'));
      return;
    }
    const results = await appsRepository.listIngressAttestations(hash);
    res.json(messageHelper.createDataMessage(results));
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
 * fluxteam-only: every ingress attestation for an app, grouped by the
 * register/update message it attests to. Records stay sealed — the source is
 * decrypted offline with the fluxteam keyring, never by the node.
 */
async function getIngressAttestationsByApp(req, res) {
  try {
    const authorized = await verificationHelper.verifyPrivilege(Privilege.FLUX_TEAM, authOf(req));
    if (!authorized) {
      res.json(messageHelper.errUnauthorizedMessage());
      return;
    }
    let { name } = req.params;
    name = name || req.query.name;
    if (!name) {
      res.json(messageHelper.createErrorMessage('name parameter is mandatory'));
      return;
    }
    const results = await appsRepository.listIngressAttestationsByApp(name);
    res.json(messageHelper.createDataMessage(results));
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

// ── Core promotion function ─────────────────────────────────────────

/**
 * Stores a gossiped message when this node's scan has recorded its payment. The
 * chain facts are the payment record's, read by the store; the decider judges
 * what is stored.
 *
 * @param {string} hash - Message hash
 * @param {number} i - Retry counter (internal)
 * @returns {Promise<boolean>} whether the message is stored
 */
async function checkAndRequestApp(hash, i = 0) {
  try {
    const existing = await appsRepository.getPermanentMessage(hash);
    if (existing) {
      await appHashHasMessage(hash);
      confirmedMessageStore.notifyStored([hash]);
      return true;
    }

    const tempMessage = await appsRepository.getTempMessage(hash);
    if (!tempMessage || typeof tempMessage !== 'object' || Array.isArray(tempMessage)) {
      if (i < 2) {
        await requestAppMessage(hash);
        await serviceHelper.delay(60 * 1000);
        return checkAndRequestApp(hash, i + 1);
      }
      return false;
    }

    const storage = await confirmedMessageStore.storeConfirmedMessages([tempMessage]);
    if (storage.alreadyStored.length) return true;
    if (!storage.stored.length) {
      const why = storage.unpaid.length ? 'this node has no payment record for it' : storage.refused[0].reason;
      log.error(`checkAndRequestApp - ${hash} not stored: ${why}`);
      return false;
    }
    // The message is durable now — clear the orphan TTL on its ingress
    // attestations so their attribution persists alongside the permanent record.
    await appsRepository.confirmIngressAttestations(hash);
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
 * @param {number} i - Retry counter
 * @returns {Promise<void>} Completion status
 */
async function checkAndRequestMultipleApps(apps, i = 1) {
  try {
    const numberOfPeers = fluxNetworkHelper.getNumberOfPeers();
    if (numberOfPeers < config.get('fluxapps.minHashSyncPeers')) {
      log.info('checkAndRequestMultipleApps - Not enough connected peers to request missing Flux App messages');
      return;
    }
    await requestAppsMessage(apps);
    await serviceHelper.delay(30 * 1000);
    const appsToRemove = [];
    // eslint-disable-next-line no-restricted-syntax
    for (const app of apps) {
      // eslint-disable-next-line no-await-in-loop
      const messageReceived = await checkAndRequestApp(app.hash, 2);
      if (messageReceived) {
        appsToRemove.push(app);
      }
    }
    // eslint-disable-next-line no-param-reassign
    apps = apps.filter((item) => !appsToRemove.includes(item));
    if (apps.length > 0 && i < 5) {
      await checkAndRequestMultipleApps(apps, i + 1);
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
    if (numberOfPeers < config.get('fluxapps.minHashSyncPeers')) {
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

    const dbopen = dbHelper.databaseConnection();
    const database = dbopen.db(config.get('database.daemon.database'));
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
        blockTime: 1,
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
        let maturity = Math.round(heightDifference / config.get('fluxapps.blocksLasting'));
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
            blockTime: result.blockTime ?? null,
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
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
async function triggerAppHashesCheckAPI(req, res) {
  try {
    // only flux team and node owner can do this
    const authorized = await verificationHelper.verifyPrivilege(Privilege.NODE_OPERATOR_OR_FLUX_TEAM, authOf(req));
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
  getIngressAttestations,
  getIngressAttestationsByApp,
  checkAndRequestApp,
  checkAndRequestMultipleApps,
  continuousFluxAppHashesCheck,
  triggerAppHashesCheckAPI,
};
