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
 * hash, so a wrong/lost entry is self-correcting.
 *
 * @param {string} locator
 * @param {object} [deps] - { http, baseUrl }
 * @returns {Promise<Buffer|null>}
 */
async function fetchBlobByLocator(locator, deps = {}) {
  const http = deps.http || axios;
  const base = blobApiBase(deps.baseUrl);
  try {
    const res = await http.get(`${base}/api/v1/blob/${locator}`, {
      responseType: 'arraybuffer',
      timeout: 30_000,
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
  uploadBlob, fetchBlobByLocator, putManifest, fetchManifest,
};
