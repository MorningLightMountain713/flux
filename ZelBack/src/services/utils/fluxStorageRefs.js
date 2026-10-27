'use strict';

const log = require('../../lib/log');
const serviceHelper = require('../serviceHelper');
const { isFluxStorageUrl } = require('./fluxStorage');
const fluxBroadcastHelper = require('./fluxBroadcastHelper');

/**
 * Fetch a Flux Storage payload via a signed request. Resolves the legacy
 * F_S_ENV / F_S_CMD references used by v1-v8 apps, both at container install
 * time and during the v8->v9 appconvert.
 *
 * Throws on any failure: callers must treat an unresolvable reference as fatal
 * and never proceed with a partial result.
 *
 * A LINK THAT DOES NOT ADDRESS FLUX STORAGE OVER HTTPS IS REFUSED, and never
 * fetched: the request is signed by this node, so a link it would follow anywhere
 * is a request it signs for whoever wrote the specification. Decided here, at the
 * fetch, so it binds every app whatever height it was registered at.
 *
 * @param {string} url - Flux Storage URL carried in the F_S_* reference
 * @param {string} appName
 * @returns {Promise<any>} the stored payload (expected: array of strings)
 */
async function obtainPayloadFromStorage(url, appName) {
  // Ahead of the try so the reason reaches the log as itself rather than as the
  // generic failure the catch reports for a storage that did not answer.
  if (!isFluxStorageUrl(url)) {
    throw new Error(`Storage link ${url} does not address Flux storage over https`);
  }
  try {
    // Signed request: timestamp-bound basic auth so even unsecured storages can
    // verify the caller against the deterministic node list.
    const version = 1;
    const timestamp = Date.now();
    const message = version + url + timestamp;
    const signature = await fluxBroadcastHelper.getFluxMessageSignature(message);
    const axiosConfig = {
      headers: {
        'flux-message': message,
        'flux-signature': signature,
        'flux-app': appName,
      },
      timeout: 20_000,
      // The host is the whole of the check, so a redirect off it would put the node
      // back where it started: fetching an address chosen by the response.
      maxRedirects: 0,
    };
    const response = await serviceHelper.axiosGet(url, axiosConfig);
    return response.data;
  } catch (error) {
    log.error(error);
    throw new Error(`Parameters from Flux Storage ${url} failed to be obtained`);
  }
}

module.exports = {
  obtainPayloadFromStorage,
};
