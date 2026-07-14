const axios = require('axios');
const config = require('config');

// FluxDrive blob API client: uploads already-encrypted ciphertext and fetches it
// back by locator. FluxDrive stores opaque bytes — it never decrypts. The base
// URL is a deploy-time config value (config.fluxDrive.blobApiUrl).

function blobApiBase(override) {
  const url = override || (config.fluxDrive && config.fluxDrive.blobApiUrl);
  if (!url) throw new Error('fluxDrive.blobApiUrl is not configured');
  return url.replace(/\/+$/, '');
}

/**
 * Dual-signature upload of framed ciphertext (nonce || ciphertext || tag).
 *
 * @param {Buffer} framed - encrypted blob bytes
 * @param {object} hdr - { locator, appName, timestamp, arcaneSig, ownerSig, source }
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
 * PUT the latest owner-signed manifest to the FluxDrive backstop. Body is JSON
 * `{ version, timestamp, arcaneSig, ownerSig, manifest }` — FluxDrive authorizes the
 * operational dual-signature over sha256(appName:version:timestamp) (the node's
 * arcane sig + the owner PUT-sig produced by the frontend at submission), enforces a
 * per-(appName, owner) version floor, and stores the (sealed-slots) manifest verbatim.
 *
 * @param {string} appName
 * @param {object} body - { version, timestamp, arcaneSig, ownerSig, manifest }
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
    },
    { timeout: 30_000 },
  );
}

/**
 * Push a slot app's live locator set to FluxDrive's reconcile endpoint (the GC
 * update-case, CONTENT_BLOBS §10.1c). FluxDrive verifies the dual-signature over
 * sha256(appName:source:version) — the node's arcane sig + the owner's reconcile-sig —
 * enforces the per-(appName, source) monotonic version floor, then ADDS new locators
 * and tombstones this app's superseded ones of that source (orphan-with-grace), never
 * a blind replace. A duplicate / stale version is an idempotent 409.
 *
 * @param {string} appName
 * @param {object} body - { source, version, arcaneSig, ownerSig, liveLocators }
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
    },
    { timeout: 30_000 },
  );
}

/**
 * Fetch the confirmed manifest from the FluxDrive backstop (the cold-start fallback
 * when no running peer is reachable). Returns `{ version, manifest }`, or null when
 * none is stored (404). The caller re-verifies the owner sig + highest-version-wins,
 * so a stale/poisoned copy self-corrects.
 *
 * @param {string} appName
 * @param {object} [deps] - { http, baseUrl }
 * @returns {Promise<{version:number, manifest:object}|null>}
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
  uploadBlob, fetchBlobByLocator, putManifest, reconcile, fetchManifest,
};
