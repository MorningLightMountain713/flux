const crypto = require('node:crypto');
const benchmarkService = require('../benchmarkService');
const fluxDriveClient = require('../utils/fluxDriveClient');
const { aeadEncrypt, aeadDecrypt } = require('../utils/aeadCrypto');

const MAX_BLOB_BYTES = 2 * 1024 * 1024;
const FRESHNESS_WINDOW_SECONDS = 300;

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// Unwrap a benchmark-channel reply: executeCall wraps the result as
// { status: 'success', data: <inner> } and the inner crypto reply is
// { status: 'ok', <field> }. Returns the requested field or throws.
function benchmarkField(resp, field) {
  if (!resp || resp.status !== 'success') throw new Error('contentBlob: benchmark channel unavailable');
  const data = typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;
  if (!data || data.status !== 'ok' || data[field] == null) throw new Error('contentBlob: benchmark channel rejected the request');
  return data[field];
}

/**
 * Encrypt a content blob and upload it to FluxDrive — synchronous, so the blob is
 * durably stored before the spec enters gossip. The owner's freshness-bound
 * signature is supplied by the caller (signed client-side); the arcane signature
 * is taken here. The locator and the per-blob key are both derived over the
 * benchmark channel; the AES-256-GCM happens locally.
 *
 * @param {object} blob - { appName, fluxID, contentHash, bytes, ownerSig, timestamp, source? }
 * @param {object} deps - { benchmark?, uploader, now? }
 * @returns {Promise<{ locator: string }>}
 */
async function encryptAndUploadBlob(blob, deps) {
  const {
    appName, fluxID, contentHash, bytes, ownerSig, timestamp, source = 'blob',
  } = blob;
  const { benchmark = benchmarkService, uploader, now = Date.now } = deps || {};

  if (`sha256:${sha256Hex(bytes)}` !== contentHash) throw new Error(`contentBlob: hash mismatch for ${contentHash}`);
  if (bytes.length > MAX_BLOB_BYTES) throw new Error(`contentBlob: blob exceeds ${MAX_BLOB_BYTES} bytes`);
  if (Math.abs(now() / 1000 - Number(timestamp)) > FRESHNESS_WINDOW_SECONDS) throw new Error('contentBlob: owner signature is stale');

  const locator = benchmarkField(await benchmark.blobLocator({ appName, fluxID, contentHash }), 'locator');
  const key = Buffer.from(benchmarkField(await benchmark.contentKey({ appName, fluxID, contentHash }), 'key'), 'base64');
  const framed = aeadEncrypt(key, bytes, Buffer.from(contentHash));

  const message = sha256Hex(`${locator}:${appName}:${timestamp}`);
  const arcaneSig = benchmarkField(await benchmark.signBlobUpload({ message }), 'signature');

  await uploader.uploadBlob(framed, {
    locator, appName, timestamp, arcaneSig, ownerSig, source,
  });
  return { locator };
}

/**
 * Decrypt a fetched blob ciphertext and verify it against the signed content
 * hash — the single load-bearing integrity check. Throws on a failed GCM tag or
 * hash mismatch, so a wrong/poisoned source is rejected and the caller falls
 * through to the next one.
 *
 * @param {object} blob - { appName, fluxID, contentHash, framed }
 * @param {object} deps - { benchmark? }
 * @returns {Promise<Buffer>} verified plaintext
 */
async function decryptAndVerifyBlob(blob, deps) {
  const { appName, fluxID, contentHash, framed } = blob;
  const { benchmark = benchmarkService } = deps || {};

  const key = Buffer.from(benchmarkField(await benchmark.contentKey({ appName, fluxID, contentHash }), 'key'), 'base64');
  const plaintext = aeadDecrypt(key, framed, Buffer.from(contentHash));
  if (`sha256:${sha256Hex(plaintext)}` !== contentHash) throw new Error(`contentBlob: post-decrypt hash mismatch for ${contentHash}`);
  return plaintext;
}

/**
 * Resolve a content blob at install time: peers first (by locator), then the
 * FluxDrive backstop. Every candidate is decrypted and hash-verified before it is
 * accepted, so a wrong/poisoned/garbage source is skipped and the next is tried.
 * Throws only when no source yields verified content (deep-cold — the caller
 * retries later). Peers are tried in the order given; the caller shuffles for
 * herd-safety.
 *
 * @param {object} req - { appName, fluxID, contentHash, peers }
 * @param {object} deps - { benchmark?, fluxDrive?, peerFetch, maxPeerAttempts? }
 * @returns {Promise<Buffer>} verified plaintext
 */
async function resolveBlob(req, deps) {
  const { appName, fluxID, contentHash, peers = [] } = req;
  const {
    benchmark = benchmarkService, fluxDrive = fluxDriveClient, peerFetch, maxPeerAttempts = 3,
  } = deps || {};

  const locator = benchmarkField(await benchmark.blobLocator({ appName, fluxID, contentHash }), 'locator');
  const verify = (framed) => (framed
    ? decryptAndVerifyBlob({ appName, fluxID, contentHash, framed }, { benchmark }).catch(() => null)
    : null);

  for (const peer of peers.slice(0, maxPeerAttempts)) {
    const framed = await peerFetch(peer, appName, locator).catch(() => null);
    const plain = await verify(framed);
    if (plain) return plain;
  }

  const framed = await fluxDrive.fetchBlobByLocator(locator).catch(() => null);
  const plain = await verify(framed);
  if (plain) return plain;

  throw new Error(`contentBlob: no source for ${contentHash}`);
}

/**
 * Provision every content-blob mount of a deployment at install: resolve the blob
 * (peers-first, FluxDrive backstop, hash-verified) and write the plaintext to its
 * host source path. Throws if any declared mount cannot be resolved — an app is
 * not installable without its declared content. The deployment exposes the
 * content mounts via its domain accessor (DeploymentComponent.contentBlobMounts).
 *
 * @param {object} deployment - DeploymentSpec
 * @param {object} ctx - { appName, fluxID, peers }
 * @param {object} deps - { resolve?, writeFile, benchmark?, fluxDrive?, peerFetch }
 */
async function provisionContentBlobs(deployment, ctx, deps) {
  const { appName, fluxID, peers = [] } = ctx;
  const {
    resolve = resolveBlob, writeFile, benchmark, fluxDrive, peerFetch,
  } = deps || {};

  for (const [, comp] of deployment.componentEntries()) {
    for (const { source, hash } of comp.contentBlobMounts()) {
      const plaintext = await resolve(
        { appName, fluxID, contentHash: hash, peers },
        { benchmark, fluxDrive, peerFetch },
      );
      await writeFile(source, plaintext);
    }
  }
}

module.exports = {
  encryptAndUploadBlob,
  decryptAndVerifyBlob,
  resolveBlob,
  provisionContentBlobs,
  sha256Hex,
  MAX_BLOB_BYTES,
  FRESHNESS_WINDOW_SECONDS,
};
