'use strict';

const log = require('../../lib/log');
const serviceHelper = require('../serviceHelper');

// A single Flux Storage payload is an array of short strings ("KEY=value" for
// env, individual argv items for cmd). Match the install-time limits.
const FS_MAX_ITEMS = 200;
const FS_MAX_ITEM_LENGTH = 5000000;

/**
 * Fetch a Flux Storage payload via a signed request. Resolves the legacy
 * F_S_ENV / F_S_CMD references used by v1-v8 apps, both at container install
 * time and during the v8->v9 appconvert.
 *
 * Throws on any failure: callers must treat an unresolvable reference as fatal
 * and never proceed with a partial result.
 *
 * @param {string} url - Flux Storage URL carried in the F_S_* reference
 * @param {string} appName
 * @returns {Promise<any>} the stored payload (expected: array of strings)
 */
async function obtainPayloadFromStorage(url, appName) {
  try {
    // Signed request: timestamp-bound basic auth so even unsecured storages can
    // verify the caller against the deterministic node list.
    // fluxCommunicationMessagesSender forms a load-time cycle with the app
    // services, so require it lazily.
    // eslint-disable-next-line global-require
    const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');
    const version = 1;
    const timestamp = Date.now();
    const message = version + url + timestamp;
    const signature = await fluxCommunicationMessagesSender.getFluxMessageSignature(message);
    const axiosConfig = {
      headers: {
        'flux-message': message,
        'flux-signature': signature,
        'flux-app': appName,
      },
      timeout: 20000,
    };
    const response = await serviceHelper.axiosGet(url, axiosConfig);
    return response.data;
  } catch (error) {
    log.error(error);
    throw new Error(`Parameters from Flux Storage ${url} failed to be obtained`);
  }
}

function assertStorageArray(payload, label) {
  if (!Array.isArray(payload) || payload.length >= FS_MAX_ITEMS) {
    throw new Error(`${label} from Flux Storage are invalid`);
  }
  for (const item of payload) {
    if (typeof item !== 'string' || item.length > FS_MAX_ITEM_LENGTH) {
      throw new Error(`${label} from Flux Storage are invalid`);
    }
  }
}

/**
 * Resolve and inline legacy F_S_ENV / F_S_CMD storage references in a v9
 * component map (the post-fromLegacy shape: components keyed by name, each with
 * an `env` object and a `cmd` array). v9 has no storage-ref convention, so the
 * referenced values must be fetched and inlined here.
 *
 * Fail-hard: an unreachable or malformed reference throws, so the conversion
 * never emits a spec that is missing its config or still carrying a sentinel.
 *
 * Returns true when any reference was inlined — the caller must then encrypt the
 * converted spec, since values were externalised precisely because they are
 * sensitive.
 *
 * @param {Object} components - v9 components map (mutated in place)
 * @param {string} appName
 * @returns {Promise<boolean>} whether any sensitive value was inlined
 */
async function resolveStorageRefs(components, appName) {
  let inlined = false;
  for (const name of Object.keys(components || {})) {
    const comp = components[name];

    // fromLegacy carries an "F_S_ENV=<url>" env entry through as env.F_S_ENV.
    if (comp.env && typeof comp.env.F_S_ENV === 'string') {
      const url = comp.env.F_S_ENV;
      // eslint-disable-next-line no-await-in-loop
      const payload = await obtainPayloadFromStorage(url, appName);
      assertStorageArray(payload, `Environment parameters for component ${name}`);
      delete comp.env.F_S_ENV;
      for (const entry of payload) {
        const idx = entry.indexOf('=');
        if (idx > 0) {
          comp.env[entry.substring(0, idx).trim()] = entry.substring(idx + 1);
        }
      }
      inlined = true;
    }

    // cmd keeps the "F_S_CMD=<url>" sentinel as a literal argv item.
    if (Array.isArray(comp.cmd)) {
      const ref = comp.cmd.find((c) => typeof c === 'string' && c.startsWith('F_S_CMD='));
      if (ref) {
        const url = ref.split('F_S_CMD=')[1];
        // eslint-disable-next-line no-await-in-loop
        const payload = await obtainPayloadFromStorage(url, appName);
        assertStorageArray(payload, `Commands for component ${name}`);
        comp.cmd = comp.cmd.flatMap((c) => (c === ref ? payload : [c]));
        inlined = true;
      }
    }
  }
  return inlined;
}

module.exports = {
  obtainPayloadFromStorage,
  resolveStorageRefs,
};
