'use strict';

const config = require('config');
const log = require('../../lib/log');
const messageHelper = require('../messageHelper');
const verificationHelper = require('../verificationHelper');
const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');
const serviceHelper = require('../serviceHelper');
const appsRepository = require('../appDatabase/appsRepository');
const confirmedMessageStore = require('./confirmedMessageStore');
const appRecords = require('../appDatabase/appRecords');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const { Privilege, authOf } = require('../utils/privileges');


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
 * Get temporary app messages via API
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getAppsTemporaryMessages(req, res) {
  try {
    let { hash } = req.params;
    hash = hash || req.query.hash;
    const pooled = hash
      ? [await appRecords.messages().byHash(hash)].filter((record) => record && record.isHeld && !record.isPaid)
      : await appRecords.messages().pool();
    const results = pooled.map((record) => record.temporaryForm());
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
    let { hash } = req.params;
    hash = hash || req.query.hash;
    let { owner } = req.params;
    owner = owner || req.query.owner;
    let { appname } = req.params;
    appname = appname || req.query.appname;
    const filter = {};
    if (hash) filter.hash = hash;
    if (owner) filter.owner = owner;
    if (appname) filter.name = appname;
    const results = (await appRecords.messages().confirmedFind(filter)).map((record) => record.permanentForm());
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


module.exports = {
  requestAppMessage,
  requestAppsMessage,
  requestAppMessageAPI,
  getAppsTemporaryMessages,
  getAppsPermanentMessages,
  getIngressAttestations,
  getIngressAttestationsByApp,
  checkAndRequestApp,
  checkAndRequestMultipleApps,
};
