// Cryptographic Keys Service - Manages public keys for application encryption
const messageHelper = require('../messageHelper');
const verificationHelper = require('../verificationHelper');
const serviceHelper = require('../serviceHelper');
const benchmarkService = require('../benchmarkService');
const daemonServiceMiscRpcs = require('../daemonService/daemonServiceMiscRpcs');
const log = require('../../lib/log');

// Check if running on Arcane OS
const isArcane = Boolean(process.env.FLUXOS_PATH);

/**
 * Get application public key for encryption
 * @param {string} fluxID - The Flux ID of the app owner
 * @param {string} appName - The name of the application
 * @param {number} blockHeight - The blockchain height
 * @returns {Promise<string>} The public key
 */
async function getAppPublicKey(fluxID, appName, blockHeight) {
  if (!isArcane) {
    throw new Error('Application Specifications can only be validated on a node running Arcane OS.');
  }
  const inputData = JSON.stringify({
    fluxID,
    appName,
    blockHeight,
  });
  const dataReturned = await benchmarkService.getPublicKey(inputData);
  const { status, data } = dataReturned;
  let publicKey = null;
  if (status === 'success') {
    const dataParsed = JSON.parse(data);
    publicKey = dataParsed.status === 'ok' ? dataParsed.publicKey : null;
    if (!publicKey) {
      throw new Error('Error getting public key to encrypt app enterprise content.');
    }
  } else {
    throw new Error('Error getting public key to encrypt app enterprise content.');
  }

  return publicKey;
}

/**
 * To get Public Key to Encrypt Enterprise Content.
 * @param {object} req Request.
 * @param {object} res Response.
 * @returns {string} Key.
 */
async function getPublicKey(req, res) {
  let body = '';
  req.on('data', (data) => {
    body += data;
  });
  req.on('end', async () => {
    try {
      const authorized = await verificationHelper.verifyPrivilege('user', req);
      if (!authorized) {
        const errMessage = messageHelper.errUnauthorizedMessage();
        return res.json(errMessage);
      }

      const processedBody = serviceHelper.ensureObject(body);
      let appSpecification = processedBody;
      appSpecification = serviceHelper.ensureObject(appSpecification);
      if (!appSpecification.owner || !appSpecification.name) {
        throw new Error('Input parameters missing.');
      }
      const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
      if (!syncStatus.data.synced) {
        throw new Error('Daemon not yet synced.');
      }
      const daemonHeight = syncStatus.data.height;

      const publicKey = await getAppPublicKey(appSpecification.owner, appSpecification.name, daemonHeight);
      // respond with formatted specifications
      const response = messageHelper.createDataMessage(publicKey);
      return res.json(response);
    } catch (error) {
      log.error(error);
      const errorResponse = messageHelper.createErrorMessage(
        error.message || error,
        error.name,
        error.code,
      );
      return res.json(errorResponse);
    }
  });
}

/**
 * Get the attested per-app X25519 transport public key (v9 HPKE submission
 * direction). The response is returned unmodified — the attestation bytes are
 * load-bearing for the client's signature check and must not be re-encoded.
 * @param {object} req Request — appname in the path, fluxid in the query.
 * @param {object} res Response.
 */
async function getTransportPublicKey(req, res) {
  try {
    const appName = req.params.appname;
    const fluxID = req.query.fluxid || req.query.fluxId;

    if (!appName || !fluxID) {
      return res.json(messageHelper.createErrorMessage('transportpubkey requires appname and fluxid'));
    }

    const rpcResult = await benchmarkService.transportPublicKey({ appName, fluxID });
    if (rpcResult.status !== 'success') {
      return res.json(rpcResult);
    }

    const sasResponse = typeof rpcResult.data === 'string'
      ? JSON.parse(rpcResult.data) : rpcResult.data;
    if (!sasResponse || sasResponse.status !== 'ok') {
      throw new Error(`Error getting transport public key: ${(sasResponse && sasResponse.message) || 'unknown'}`);
    }

    return res.json(messageHelper.createDataMessage(sasResponse));
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    return res.json(errorResponse);
  }
}

module.exports = {
  getAppPublicKey,
  getPublicKey,
  getTransportPublicKey,
};
