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

module.exports = { uploadBlob, fetchBlobByLocator };
