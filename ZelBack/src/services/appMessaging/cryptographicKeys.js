'use strict';

// Cryptographic Keys Service - Manages public keys for application encryption
const messageHelper = require('../messageHelper');
const verificationHelper = require('../verificationHelper');
const serviceHelper = require('../serviceHelper');
const benchmarkService = require('../benchmarkService');
const daemonServiceMiscRpcs = require('../daemonService/daemonServiceMiscRpcs');
const log = require('../../lib/log');
const globalState = require('../utils/globalState');
const transportHelper = require('../utils/transportHelper');
const contentBlobService = require('../appLifecycle/contentBlobService');
const specLibs = require('../utils/specLibs');

const CONTENT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

/**
 * Get application public key for encryption
 * @param {string} fluxID - The Flux ID of the app owner
 * @param {string} appName - The name of the application
 * @param {number} blockHeight - The blockchain height
 * @returns {Promise<string>} The public key
 */
async function getAppPublicKey(fluxID, appName, blockHeight) {
  if (!globalState.isArcane()) {
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
 * @param {import('express').Request} req
 * @param {import('express').Response} res
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
 * @param {import('express').Request} req Request — appname in the path, fluxid in the query.
 * @param {import('express').Response} res
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

    const transportResponse = typeof rpcResult.data === 'string'
      ? JSON.parse(rpcResult.data) : rpcResult.data;
    if (!transportResponse || transportResponse.status !== 'ok') {
      throw new Error(`Error getting transport public key: ${(transportResponse && transportResponse.message) || 'unknown'}`);
    }

    return res.json(messageHelper.createDataMessage(transportResponse));
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

/**
 * POST /apps/bloblocator — derive a content blob's locator for the app owner (the
 * frontend), so they can owner-sign the dual-sig upload over
 * sha256(locator:appName:timestamp). The locator is fleet-secret-derived (the owner
 * can't compute it), and an OPEN endpoint would be a confirmation-of-file oracle —
 * appName + owner are public, so an attacker need only supply a guessed contentHash to
 * test whether a victim app uses a known file (CONTENT_BLOBS §4.5: the locator must stay
 * un-testable against a known file). Two controls close that:
 *  - the contentHash (the fingerprint the locator scheme hides) rides HPKE-sealed toward
 *    THIS node's per-app transport key — never in the clear — and is opened only here;
 *  - the locator is derived for fluxID = the AUTHENTICATED caller's zelid (the caller can't
 *    even name another identity), so you can only derive locators for your OWN content.
 * Arcane-only (the fleet secret lives in the benchmark channel).
 *
 * Body: { appName, timestamp, sealed } — sealed = TransportEnvelope JSON over
 * { contentHash }, AAD = buildContentTransportAad({ appName, ref: CONTENT_LOCATOR_AAD_REF,
 * timestamp }).
 */
async function getBlobLocator(req, res) {
  try {
    const authorized = await verificationHelper.verifyPrivilege('user', req);
    if (!authorized) {
      res.json(messageHelper.errUnauthorizedMessage());
      return;
    }
    if (!globalState.isArcane()) {
      throw new Error('Locator derivation requires an arcane node');
    }
    const auth = serviceHelper.ensureObject(req.headers.zelidauth);
    const callerZelid = auth && auth.zelid;
    if (!callerZelid) {
      res.json(messageHelper.errUnauthorizedMessage());
      return;
    }

    const { appName, timestamp, sealed } = req.body || {};
    if (!appName || timestamp == null || !sealed) {
      throw new Error('bloblocator requires appName, timestamp, and the sealed contentHash');
    }

    // Open the sealed contentHash toward this node's per-app transport key for the
    // CALLER's identity; the AAD ref distinguishes a locator request from a submission part.
    const { CONTENT_LOCATOR_AAD_REF } = await specLibs.getSpec();
    const plaintext = await transportHelper.openContentEnvelope(sealed, {
      appName, owner: callerZelid, ref: CONTENT_LOCATOR_AAD_REF, timestamp: Number(timestamp),
    });
    const { contentHash } = serviceHelper.ensureObject(plaintext.toString('utf8'));
    if (!CONTENT_HASH_PATTERN.test(contentHash || '')) {
      throw new Error('sealed payload must carry a contentHash of the form sha256:<64 hex>');
    }

    // Derive for the caller's OWN identity — never a fluxID the caller named.
    const locator = await contentBlobService.deriveLocator(benchmarkService, {
      appName, fluxID: callerZelid, contentHash,
    });
    res.json(messageHelper.createDataMessage({ locator }));
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

module.exports = {
  getAppPublicKey,
  getPublicKey,
  getTransportPublicKey,
  getBlobLocator,
};
