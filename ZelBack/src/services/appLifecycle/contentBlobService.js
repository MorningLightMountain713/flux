'use strict';

const crypto = require('node:crypto');
const axios = require('axios');
const benchmarkService = require('../benchmarkService');
const fluxDriveClient = require('../utils/fluxDriveClient');
const contentStore = require('./contentStore');
const specLibs = require('../utils/specLibs');
const { aeadEncrypt, aeadDecrypt } = require('../utils/aeadCrypto');
const fluxEventBus = require('../utils/fluxEventBus');

// The content byte caps are v9 protocol constants (SpecConstraintsV9) — every
// node must enforce the same values for verification to be meaningful. flux-spec
// is ESM, so they are read through the async loader (cached after the first
// call; every consumer is already async). maxBlobBytes bounds a blob's
// plaintext; maxContentBytes bounds the single HPKE-sealed submission envelope
// (every blob's base64 ciphertext + the manifest) — the per-blob cap is
// re-checked after the envelope opens.
async function maxBlobBytes() {
  const { SpecConstraintsV9 } = await specLibs.getSpec();
  return SpecConstraintsV9.maxContentBlobBytes;
}
async function maxContentBytes() {
  const { SpecConstraintsV9 } = await specLibs.getSpec();
  return SpecConstraintsV9.maxContentEnvelopeBytes;
}
// A valid framed blob is plaintext + 28 bytes (nonce 12 || ciphertext || tag
// 16); the margin is headroom, anything larger can never verify. Bounds every
// blob download so a malicious source cannot balloon memory.
async function maxFramedBlobBytes() {
  return (await maxBlobBytes()) + 1024;
}

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

// Every derivation and every signed text names the app's identity, never its
// name or owner: a name is a lease and an owner can change, while a blob and
// the key it is sealed under stay the app's. The benchmark channel refuses a
// request naming no identity; refusing here names the caller instead.
function requireIdentity(identity) {
  if (typeof identity !== 'string' || !identity) throw new Error('contentBlob: content is keyed by the app identity, which is missing');
  return identity;
}

/**
 * Derive a content blob's locator over the benchmark channel — the single place the
 * blobLocator RPC reply is unwrapped, shared by upload, resolve, serve, and the slot
 * reconcile push, so they all key on byte-identical locators.
 *
 * @param {object} [benchmark] - the benchmark channel (defaults to the singleton)
 * @param {object} ref - { identity, contentHash }
 * @returns {Promise<string>} the locator
 */
async function deriveLocator(benchmark = benchmarkService, { identity, contentHash }) {
  return benchmarkField(await benchmark.blobLocator({ identity: requireIdentity(identity), contentHash }), 'locator');
}

/**
 * Encrypt a content blob and upload it to FluxDrive — synchronous, so the blob is
 * durably stored before the spec enters gossip. The owner's freshness-bound
 * signature is supplied by the caller (signed client-side); the arcane signature
 * is taken here. The locator and the per-blob key are both derived over the
 * benchmark channel from the app's identity and the content hash; the
 * AES-256-GCM happens locally. Both signatures are over the library's
 * `blobUploadDigest` (`locator:identity:timestamp`); the name rides the upload
 * so FluxDrive can look the app up.
 *
 * @param {object} blob - { appName, identity, contentHash, bytes, ownerSig, timestamp, source? }
 * @param {object} deps - { benchmark?, uploader, now? }
 * @returns {Promise<{ locator: string }>}
 */
async function encryptAndUploadBlob(blob, deps) {
  const {
    appName, identity, contentHash, bytes, ownerSig, timestamp, source = 'blob',
  } = blob;
  const { benchmark = benchmarkService, uploader, now = Date.now } = deps || {};

  requireIdentity(identity);
  if (`sha256:${sha256Hex(bytes)}` !== contentHash) throw new Error(`contentBlob: hash mismatch for ${contentHash}`);
  const blobCap = await maxBlobBytes();
  if (bytes.length > blobCap) throw new Error(`contentBlob: blob exceeds ${blobCap} bytes`);
  // timestamp is the submission timestamp (milliseconds, like the app-message timestamp), so compare in ms.
  if (Math.abs(now() - Number(timestamp)) > FRESHNESS_WINDOW_SECONDS * 1000) throw new Error('contentBlob: owner signature is stale');

  const locator = await deriveLocator(benchmark, { identity, contentHash });
  const key = Buffer.from(benchmarkField(await benchmark.contentKey({ identity, contentHash }), 'key'), 'base64');
  const framed = aeadEncrypt(key, bytes, Buffer.from(contentHash));

  const arcaneSig = benchmarkField(await benchmark.signBlobUpload({
    kind: 'upload', identity, locator, timestamp,
  }), 'signature');

  await uploader.uploadBlob(framed, {
    locator, appName, identity, timestamp, arcaneSig, ownerSig, source,
  });
  fluxEventBus.publish('content:blobUploaded', { appName, hash: contentHash, locator, source });
  return { locator };
}

/**
 * Take the arcane (fleet anti-abuse) signature for a manifest PUT. The benchmark
 * channel builds the signed text itself from these typed fields, under its own
 * domain: the library's `manifestPutDigest`,
 * `identity:version:timestamp:pendingMessageHash`, the last empty when the put is
 * not carried by a spec update. It refuses a timestamp outside the freshness
 * window and never signs caller-supplied bytes.
 *
 * @param {object} fields - { identity, version, timestamp, pendingMessageHash? }
 * @param {object} [deps] - { benchmark? }
 * @returns {Promise<string>} the base64 arcane signature
 */
async function signManifestPut({
  identity, version, timestamp, pendingMessageHash = null,
}, deps = {}) {
  const { benchmark = benchmarkService } = deps || {};
  return benchmarkField(await benchmark.signBlobUpload({
    kind: 'manifest', identity: requireIdentity(identity), version, timestamp, pendingMessageHash,
  }), 'signature');
}

/**
 * Take the arcane signature for a slot reconcile. The channel builds the signed
 * text itself: the library's `slotReconcileDigest`,
 * `identity:source:version:keptLocatorsHash:pendingMessageHash`, the kept
 * locators hashed sorted and each once, so no other list can ride the
 * signature. No timestamp: FluxDrive's version floor per identity and source
 * bounds replay instead.
 *
 * @param {object} fields - { identity, source, version, keptLocators, pendingMessageHash? }
 * @param {object} [deps] - { benchmark? }
 * @returns {Promise<string>} the base64 arcane signature
 */
async function signReconcile({
  identity, source, version, keptLocators, pendingMessageHash = null,
}, deps = {}) {
  const { benchmark = benchmarkService } = deps || {};
  return benchmarkField(await benchmark.signBlobUpload({
    kind: 'reconcile', identity: requireIdentity(identity), source, version, keptLocators, pendingMessageHash,
  }), 'signature');
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
 * Assert a carried-over blob is still present in FluxDrive. An update may omit
 * the bytes for a hash its previous version already delivered — the locator is
 * identical (identity and contentHash), so the previous upload is the durable
 * copy. This presence check closes the pathological gap (the backstop lost it)
 * with a precise reject instead of a silent hole every cold-start install hits.
 *
 * @param {object} ref - { identity, contentHash }
 * @param {object} deps - { uploader, benchmark? }
 * @returns {Promise<string>} the locator
 */
async function assertBlobStored(ref, deps) {
  const { uploader, benchmark } = deps || {};
  const locator = await deriveLocator(benchmark, ref);
  const exists = await uploader.blobExists(locator);
  if (!exists) {
    throw new Error(`contentBlob: ${ref.contentHash} is carried over from the previous version but is not in storage — attach the file bytes`);
  }
  return locator;
}

/**
 * Upload a submission's content blobs — synchronously, so all declared content is
 * durably stored before the spec enters gossip. Matches the decrypted spec's
 * contentRef mounts to the supplied blob parts by plaintext hash. Every supplied
 * blob must be referenced by the spec (a stray blob is an anti-abuse reject), and
 * every declared hash must either carry its blob part or be CARRIED OVER —
 * declared by the immediately previous version of this app (priorSpec), whose
 * bytes already sit in FluxDrive under this exact locator. A carried-over hash is
 * presence-checked instead of re-uploaded, so an update attaches only what
 * changed; a register (no priorSpec) attaches everything. Owner signatures are
 * required only for attached blobs. Any mismatch, missing part, or upload failure
 * throws so the caller never broadcasts a spec whose content is not stored.
 *
 * @param {object} input - { spec, identity, priorSpec?, blobs, ownerSigs }
 *   spec - decrypted submission spec (name, owner, components)
 *   identity - the identity of the app the submission is for
 *   priorSpec - the decrypted spec this update supersedes (absent on register)
 *   blobs - Map of plaintext bytes keyed by "sha256:<hex>"
 *   ownerSigs - Map of { sig, timestamp } keyed by hash (attached blobs only)
 * @param {object} deps - { uploader, benchmark?, now? }
 * @returns {Promise<Array<{ hash: string, locator: string }>>} the uploads performed
 */
async function encryptAndUploadBlobs(input, deps) {
  const {
    spec, identity, priorSpec, blobs, ownerSigs,
  } = input;
  const { uploader, benchmark, now } = deps || {};
  const appName = spec.name;
  requireIdentity(identity);
  const declared = specContentHashes(spec);
  const carriedOver = priorSpec ? specContentHashes(priorSpec) : new Set();

  for (const hash of blobs.keys()) {
    if (!declared.has(hash)) throw new Error(`contentBlob: blob ${hash} is not referenced by the spec`);
  }

  const uploaded = [];
  for (const hash of declared) {
    if (!blobs.has(hash)) {
      if (!carriedOver.has(hash)) throw new Error(`contentBlob: missing blob part for ${hash}`);
      // eslint-disable-next-line no-await-in-loop
      await assertBlobStored({ identity, contentHash: hash }, { uploader, benchmark });
      continue;
    }
    const owner = ownerSigs.get(hash);
    if (!owner || !owner.sig || owner.timestamp == null) {
      throw new Error(`contentBlob: missing owner signature for ${hash}`);
    }
    // eslint-disable-next-line no-await-in-loop
    const { locator } = await encryptAndUploadBlob(
      {
        appName,
        identity,
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
 * @param {object} blob - { identity, contentHash, framed }
 * @param {object} deps - { benchmark? }
 * @returns {Promise<Buffer>} verified plaintext
 */
async function decryptAndVerifyBlob(blob, deps) {
  const { identity, contentHash, framed } = blob;
  const { benchmark = benchmarkService } = deps || {};

  const key = Buffer.from(benchmarkField(await benchmark.contentKey({ identity: requireIdentity(identity), contentHash }), 'key'), 'base64');
  const plaintext = aeadDecrypt(key, framed, Buffer.from(contentHash));
  if (`sha256:${sha256Hex(plaintext)}` !== contentHash) throw new Error(`contentBlob: post-decrypt hash mismatch for ${contentHash}`);
  return plaintext;
}

/**
 * Resolve a content blob: the node's own artifact store first (a same-version
 * re-provision needs no network), then peers (by locator), then the FluxDrive
 * backstop. Every candidate is decrypted and hash-verified before it is
 * accepted, so a wrong/poisoned/garbage source is skipped and the next is
 * tried; a corrupt store entry is dropped and re-fetched. A verified network
 * fetch is written through to the store — the copy peer-serving reads later.
 * Throws only when no source yields verified content (deep-cold — the caller
 * retries later). Peers are tried in the order given; the caller shuffles for
 * herd-safety.
 *
 * @param {object} req - { appName, identity, contentHash, peers } - the identity
 *   keys this node's store, the locator and the blob's key
 * @param {object} deps - { benchmark?, fluxDrive?, peerFetch, maxPeerAttempts?, store? }
 * @returns {Promise<Buffer>} verified plaintext
 */
async function resolveBlob(req, deps) {
  const {
    appName, identity, contentHash, peers = [],
  } = req;
  const {
    benchmark = benchmarkService, fluxDrive = fluxDriveClient, peerFetch, maxPeerAttempts = 3,
    store = contentStore,
  } = deps || {};

  const verify = (framed) => (framed
    ? decryptAndVerifyBlob({ identity, contentHash, framed }, { benchmark }).catch(() => null)
    : null);

  const stored = await store.get(identity, contentHash);
  if (stored) {
    const plain = await verify(stored);
    if (plain) {
      fluxEventBus.publish('content:blobResolved', { appName, hash: contentHash, source: 'store' });
      return plain;
    }
    await store.remove(identity, contentHash);
  }

  const locator = await deriveLocator(benchmark, { identity, contentHash });

  for (const peer of peers.slice(0, maxPeerAttempts)) {
    const framed = await peerFetch(peer, appName, locator).catch(() => null);
    const plain = await verify(framed);
    if (plain) {
      await store.put(identity, contentHash, framed);
      fluxEventBus.publish('content:blobResolved', { appName, hash: contentHash, source: 'peer' });
      return plain;
    }
    // A discarded attempt may still have been served on the peer's side (e.g. the
    // response timed out in transit) — publish it so serve counts stay accountable.
    fluxEventBus.publish('content:blobPeerMiss', { appName, hash: contentHash, peer });
  }

  const framed = await fluxDrive.fetchBlobByLocator(locator, { maxBytes: await maxFramedBlobBytes() }).catch(() => null);
  const plain = await verify(framed);
  if (plain) {
    await store.put(identity, contentHash, framed);
    fluxEventBus.publish('content:blobResolved', { appName, hash: contentHash, source: 'fluxdrive' });
    return plain;
  }

  throw new Error(`contentBlob: no source for ${contentHash}`);
}

/**
 * Provision every content-blob mount of a deployment at install: resolve the blob
 * (peers-first, FluxDrive backstop, hash-verified) and write the plaintext to its
 * host source path. Throws if any declared mount cannot be resolved — an app is
 * not installable without its declared content. The deployment exposes the
 * content mounts via its domain accessor (DeploymentComponent.contentBlobMounts).
 *
 * @param {object} deployment - DeploymentSpec, whose identity keys every blob
 * @param {object} ctx - { appName, peers }
 * @param {object} deps - { resolve?, writeFile, benchmark?, fluxDrive?, peerFetch }
 */
async function provisionContentBlobs(deployment, ctx, deps) {
  const { appName, peers = [] } = ctx;
  const {
    resolve = resolveBlob, writeFile, benchmark, fluxDrive, peerFetch,
  } = deps || {};

  for (const [, comp] of deployment.componentEntries()) {
    for (const { source, hash } of comp.contentBlobMounts()) {
      let plaintext;
      try {
        plaintext = await resolve(
          {
            appName, identity: deployment.identity, contentHash: hash, peers,
          },
          { benchmark, fluxDrive, peerFetch },
        );
      } catch (error) {
        fluxEventBus.publish('content:blobProvisionFailed', { appName, hash });
        throw error;
      }
      await writeFile(source, plaintext);
      fluxEventBus.publish('content:blobProvisioned', { appName, hash });
    }
  }
}

/**
 * Serve a content blob to a peer (the peers-first source): find which of this
 * app's stored artifact blobs derives to the requested locator and return its
 * framed ciphertext verbatim. The store holds exactly what this node fetched
 * and verified — never the app's live mount, which the app may legitimately
 * have mutated (writable content is a feature) — so a serve can never leak
 * runtime-written data nor waste the requester's round-trip on bytes that
 * fail its hash check. Slot blobs are served the same way (the apply path
 * stores them as it resolves them). Returns null when nothing matches; the
 * requester falls through to FluxDrive.
 *
 * @param {object} req - { appName, identity, locator } - the identity of the app
 *   installed here, which keys its store and its locators
 * @param {object} deps - { benchmark?, store? }
 * @returns {Promise<Buffer|null>}
 */
async function serveBlob(req, deps) {
  const { appName, identity, locator } = req;
  const { benchmark = benchmarkService, store = contentStore } = deps || {};

  for (const hash of await store.list(identity)) {
    const derived = await deriveLocator(benchmark, { identity, contentHash: hash });
    if (derived !== locator) continue;
    const framed = await store.get(identity, hash);
    if (!framed) return null;
    fluxEventBus.publish('content:blobServed', { appName, locator });
    return framed;
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
      // A valid framed blob can never exceed this; without the bound a
      // malicious peer answering a locator request could stream an unbounded
      // body into this node's memory before the decrypt-verify rejects it.
      maxContentLength: await maxFramedBlobBytes(),
    });
    return Buffer.from(res.data);
  } catch (error) {
    return null;
  }
}

module.exports = {
  encryptAndUploadBlob,
  encryptAndUploadBlobs,
  assertBlobStored,
  deriveLocator,
  signManifestPut,
  signReconcile,
  decryptAndVerifyBlob,
  resolveBlob,
  provisionContentBlobs,
  serveBlob,
  fetchBlobFromPeer,
  specContentHashes,
  sha256Hex,
  maxBlobBytes,
  maxContentBytes,
  maxFramedBlobBytes,
  FRESHNESS_WINDOW_SECONDS,
};
