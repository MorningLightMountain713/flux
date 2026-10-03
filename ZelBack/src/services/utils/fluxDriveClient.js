'use strict';

const axios = require('axios');
const config = require('config');

// FluxDrive blob API client: uploads already-encrypted ciphertext and fetches it
// back by locator. FluxDrive stores opaque bytes — it never decrypts. The base
// URL is a deploy-time config value (config.fluxDrive.blobApiUrl).

function blobApiBase(override) {
  const url = override || (config.get('fluxDrive') && config.get('fluxDrive.blobApiUrl'));
  if (!url) throw new Error('fluxDrive.blobApiUrl is not configured');
  return url.replace(/\/+$/, '');
}

/**
 * Dual-signature upload of framed ciphertext (nonce || ciphertext || tag). Both
 * signatures are over `locator:identity:timestamp`; the name is what FluxDrive
 * looks the app up by, the identity what it keeps the blob under.
 *
 * @param {Buffer} framed - encrypted blob bytes
 * @param {object} hdr - { locator, appName, identity, timestamp, arcaneSig, ownerSig, source }
 * @param {object} [deps] - { http, baseUrl } for injection
 */
async function uploadBlob(framed, hdr, deps = {}) {
  const http = deps.http || axios;
  const base = blobApiBase(deps.baseUrl);
  await http.post(`${base}/api/v1/blob`, framed, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Flux-Locator': hdr.locator,
      'X-Flux-AppName': hdr.appName,
      'X-Flux-Identity': hdr.identity,
      'X-Flux-Timestamp': String(hdr.timestamp),
      'X-Flux-Arcane-Sig': hdr.arcaneSig,
      'X-Flux-Owner-Sig': hdr.ownerSig,
      'X-Flux-Source': hdr.source || 'blob',
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 30_000,
  });
}

/**
 * Fetch ciphertext by locator (the FluxDrive backstop). Returns a Buffer, or
 * null when the locator is unknown (404). The caller re-verifies the content
 * hash, so a wrong/lost entry is self-correcting. Callers that know the
 * payload's size ceiling pass maxBytes so an oversized response is rejected
 * during download instead of buffered into memory.
 *
 * @param {string} locator
 * @param {object} [deps] - { http, baseUrl, maxBytes }
 * @returns {Promise<Buffer|null>}
 */
async function fetchBlobByLocator(locator, deps = {}) {
  const http = deps.http || axios;
  const base = blobApiBase(deps.baseUrl);
  try {
    const res = await http.get(`${base}/api/v1/blob/${locator}`, {
      responseType: 'arraybuffer',
      timeout: 30_000,
      ...(deps.maxBytes ? { maxContentLength: deps.maxBytes } : {}),
    });
    return Buffer.from(res.data);
  } catch (error) {
    if (error.response && error.response.status === 404) return null;
    throw error;
  }
}

/**
 * Does FluxDrive hold a blob under this locator? A cheap HEAD against the fetch
 * route (Express serves HEAD through the GET handler). Used to presence-check
 * carried-over content — a hash the previous version already delivered — so an
 * update can omit its bytes without silently trusting the backstop still has them.
 *
 * @param {string} locator
 * @param {object} [deps] - { http, baseUrl }
 * @returns {Promise<boolean>}
 */
async function blobExists(locator, deps = {}) {
  const http = deps.http || axios;
  const base = blobApiBase(deps.baseUrl);
  try {
    await http.head(`${base}/api/v1/blob/${locator}`, { timeout: 30_000 });
    return true;
  } catch (error) {
    if (error.response && error.response.status === 404) return false;
    throw error;
  }
}

/**
 * PUT an owner-signed manifest to FluxDrive. Body is JSON `{ version, timestamp,
 * arcaneSig, ownerSig, manifest, pendingMessageHash }`. FluxDrive verifies the
 * dual signature over `identity:version:timestamp:pendingMessageHash` (the
 * identity is the manifest's own), keeps every version of the identity as its
 * own row behind a floor per ownership, and refuses a listed app's manifest for
 * another identity. A manifest naming a message hash is held until the nodes answer
 * that the message applied; one naming none is stored at once. The manifest for
 * a name FluxDrive does not list must name the registration that lists it.
 *
 * @param {string} appName
 * @param {object} body - { version, timestamp, arcaneSig, ownerSig, manifest, pendingMessageHash? }
 * @param {object} [deps] - { http, baseUrl }
 */
async function putManifest(appName, body, deps = {}) {
  const http = deps.http || axios;
  const base = blobApiBase(deps.baseUrl);
  await http.put(
    `${base}/api/v1/manifest/${encodeURIComponent(appName)}`,
    {
      version: body.version,
      timestamp: body.timestamp,
      arcaneSig: body.arcaneSig,
      ownerSig: body.ownerSig,
      manifest: body.manifest,
      pendingMessageHash: body.pendingMessageHash ?? null,
    },
    { timeout: 30_000 },
  );
}

/**
 * Push a slot app's live locator set to FluxDrive's reconcile endpoint. FluxDrive
 * verifies the dual signature over
 * `identity:source:version:keptLocatorsHash:pendingMessageHash` (the kept list is
 * bound by its hash, so the list sent is the list signed), enforces the version
 * floor per identity and source, then tombstones the identity's other locators of
 * that source with grace, never a blind replace. A reconcile naming a message
 * hash is held until the nodes answer that the message applied. A duplicate or
 * stale version is an idempotent 409.
 *
 * @param {string} appName
 * @param {object} body - { source, version, arcaneSig, ownerSig, liveLocators, pendingMessageHash? }
 * @param {object} [deps] - { http, baseUrl }
 */
async function reconcile(appName, body, deps = {}) {
  const http = deps.http || axios;
  const base = blobApiBase(deps.baseUrl);
  await http.post(
    `${base}/api/v1/blob/reconcile`,
    {
      appName,
      source: body.source,
      version: body.version,
      arcaneSig: body.arcaneSig,
      ownerSig: body.ownerSig,
      liveLocators: body.liveLocators,
      pendingMessageHash: body.pendingMessageHash ?? null,
    },
    { timeout: 30_000 },
  );
}

/**
 * Fetch every kept manifest version from the FluxDrive backstop (the cold-start
 * fallback when no running peer is reachable). FluxDrive keeps each version of
 * the identity that holds the name and returns them newest first, by the height
 * each signer took the app then its version; the caller judges each one against
 * the listed row, so a stale or poisoned copy self-corrects. Returns null when
 * none is stored (404).
 *
 * @param {string} appName
 * @param {object} [deps] - { http, baseUrl }
 * @returns {Promise<{versions: Array<{version:number, ownedFrom:number, owner:string, manifest:object}>}|null>}
 */
async function fetchManifest(appName, deps = {}) {
  const http = deps.http || axios;
  const base = blobApiBase(deps.baseUrl);
  try {
    const res = await http.get(`${base}/api/v1/manifest/${encodeURIComponent(appName)}`, { timeout: 30_000 });
    return res.data;
  } catch (error) {
    if (error.response && error.response.status === 404) return null;
    throw error;
  }
}

module.exports = {
  uploadBlob, fetchBlobByLocator, blobExists, putManifest, reconcile, fetchManifest,
};
