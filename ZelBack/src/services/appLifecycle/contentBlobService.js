const crypto = require('node:crypto');
const axios = require('axios');
const benchmarkService = require('../benchmarkService');
const fluxDriveClient = require('../utils/fluxDriveClient');
const { aeadEncrypt, aeadDecrypt } = require('../utils/aeadCrypto');

const MAX_BLOB_BYTES = 2 * 1024 * 1024;
// Upper bound on the single HPKE-sealed content envelope a submission carries (it
// holds every blob's base64 ciphertext + the manifest). The per-blob 2 MB cap is
// re-checked after the envelope is opened; this just bounds the transit payload.
const MAX_CONTENT_BYTES = 64 * 1024 * 1024;
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
 * Derive a content blob's locator over the benchmark channel — the single place the
 * blobLocator RPC reply is unwrapped, shared by upload, resolve, serve, and the slot
 * reconcile push, so they all key on byte-identical locators.
 *
 * @param {object} [benchmark] - the benchmark channel (defaults to the singleton)
 * @param {object} ref - { appName, fluxID, contentHash }
 * @returns {Promise<string>} the locator
 */
async function deriveLocator(benchmark = benchmarkService, { appName, fluxID, contentHash }) {
  return benchmarkField(await benchmark.blobLocator({ appName, fluxID, contentHash }), 'locator');
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

  const locator = await deriveLocator(benchmark, { appName, fluxID, contentHash });
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
 * Take the arcane (fleet anti-abuse) signature over an arbitrary message via the
 * benchmark channel — the message-agnostic signer the blob upload already uses (the
 * channel neither knows nor cares whether the message is a blob or a manifest token).
 * Used by the manifest backstop PUT to sign sha256(appName:version:timestamp).
 *
 * @param {string} message - the message to sign (a sha256 hex digest)
 * @param {object} [deps] - { benchmark? }
 * @returns {Promise<string>} the base64 arcane signature
 */
async function signUploadMessage(message, deps = {}) {
  const { benchmark = benchmarkService } = deps || {};
  return benchmarkField(await benchmark.signBlobUpload({ message }), 'signature');
}

/**
 * The plaintext content hashes a decrypted spec declares across every
 * component's contentRef mounts.
 */
function specContentHashes(spec) {
  const hashes = new Set();
  const components = typeof spec.componentEntries === 'function'
    ? spec.componentEntries().map(([, comp]) => comp)
    : Object.values(spec.components || {});
  for (const comp of components) {
    const ps = comp && comp.persistentStorage;
    if (!ps || typeof ps.getMountsWithContentRef !== 'function') continue;
    for (const mount of ps.getMountsWithContentRef()) {
      if (mount.contentRef && mount.contentRef.hash) hashes.add(mount.contentRef.hash);
    }
  }
  return hashes;
}

/**
 * Upload every content blob a submission declares — synchronously, so all blobs
 * are durably stored before the spec enters gossip. Matches the decrypted spec's
 * contentRef mounts to the supplied blob parts by plaintext hash: every declared
 * hash must have a blob, and every supplied blob must be referenced by the spec
 * (a stray blob is an anti-abuse reject). Each match is encrypted, dual-signed,
 * and uploaded via encryptAndUploadBlob; any mismatch or upload failure throws so
 * the caller never broadcasts a spec whose content is not stored.
 *
 * @param {object} spec - decrypted submission spec (name, owner, components)
 * @param {Map<string, Buffer>} blobs - plaintext bytes keyed by "sha256:<hex>"
 * @param {Map<string, { sig: string, timestamp: string|number }>} ownerSigs - owner sig + signed timestamp, keyed by hash
 * @param {object} deps - { uploader, benchmark?, now? }
 * @returns {Promise<Array<{ hash: string, locator: string }>>}
 */
async function encryptAndUploadBlobs(spec, blobs, ownerSigs, deps) {
  const { uploader, benchmark, now } = deps || {};
  const appName = spec.name;
  const fluxID = spec.owner;
  const declared = specContentHashes(spec);

  for (const hash of declared) {
    if (!blobs.has(hash)) throw new Error(`contentBlob: missing blob part for ${hash}`);
  }
  for (const hash of blobs.keys()) {
    if (!declared.has(hash)) throw new Error(`contentBlob: blob ${hash} is not referenced by the spec`);
  }

  const uploaded = [];
  for (const hash of declared) {
    const owner = ownerSigs.get(hash);
    if (!owner || !owner.sig || owner.timestamp == null) {
      throw new Error(`contentBlob: missing owner signature for ${hash}`);
    }
    // eslint-disable-next-line no-await-in-loop
    const { locator } = await encryptAndUploadBlob(
      {
        appName,
        fluxID,
        contentHash: hash,
        bytes: blobs.get(hash),
        ownerSig: owner.sig,
        timestamp: owner.timestamp,
      },
      { uploader, benchmark, now },
    );
    uploaded.push({ hash, locator });
  }
  return uploaded;
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

  const locator = await deriveLocator(benchmark, { appName, fluxID, contentHash });
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

/**
 * Serve a content blob to a peer (the peers-first source): find which of this
 * app's content mounts matches the requested locator, read its plaintext from
 * disk, and re-encrypt it with a fresh nonce. Returns the framed ciphertext, or
 * null if this node has no mount matching the locator. The requester re-verifies
 * against the signed hash, so a fresh re-encryption is fine.
 *
 * @param {object} req - { appName, fluxID, locator }
 * @param {object} deps - { benchmark?, getDeployment, readFile }
 * @returns {Promise<Buffer|null>}
 */
async function serveBlob(req, deps) {
  const { appName, fluxID, locator } = req;
  const { benchmark = benchmarkService, getDeployment, readFile } = deps || {};

  const deployment = await getDeployment(appName);
  if (!deployment) return null;

  for (const [, comp] of deployment.componentEntries()) {
    for (const { source, hash } of comp.contentBlobMounts()) {
      const derived = await deriveLocator(benchmark, { appName, fluxID, contentHash: hash });
      if (derived !== locator) continue;
      const plaintext = await readFile(source);
      const key = Buffer.from(benchmarkField(await benchmark.contentKey({ appName, fluxID, contentHash: hash }), 'key'), 'base64');
      return aeadEncrypt(key, plaintext, Buffer.from(hash));
    }
  }
  return null;
}

/**
 * Fetch a content blob's ciphertext from a peer running the app. Returns the
 * framed bytes, or null on any error (the resolver falls through to the next
 * source). This is resolveBlob's peerFetch.
 *
 * @param {string} peer - peer host:port
 * @param {string} appName
 * @param {string} locator
 * @param {object} [deps] - { http }
 * @returns {Promise<Buffer|null>}
 */
async function fetchBlobFromPeer(peer, appName, locator, deps = {}) {
  const http = deps.http || axios;
  try {
    const res = await http.get(`http://${peer}/apps/contentblob/${appName}/${locator}`, {
      responseType: 'arraybuffer',
      timeout: 10_000,
    });
    return Buffer.from(res.data);
  } catch (error) {
    return null;
  }
}

module.exports = {
  encryptAndUploadBlob,
  encryptAndUploadBlobs,
  deriveLocator,
  signUploadMessage,
  decryptAndVerifyBlob,
  resolveBlob,
  provisionContentBlobs,
  serveBlob,
  fetchBlobFromPeer,
  specContentHashes,
  sha256Hex,
  MAX_BLOB_BYTES,
  MAX_CONTENT_BYTES,
  FRESHNESS_WINDOW_SECONDS,
};
