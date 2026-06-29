const crypto = require('node:crypto');

// Deterministic crypto backend for the harness benchmark channel. In production
// the benchmark channel proxies to a private backend that HKDF-derives every key
// from secret master salts; here there is no such backend, so this module does
// the real primitives (X25519/HPKE/AES-256-GCM/Ed25519) with FIXED, fully public
// test keys derived from a single non-secret seed. Real encryption, none of the
// secret material — one shared stub keeps every node's keys/locators identical.

// A deliberately public, obviously-fake seed. Everything below is a pure function
// of this plus the request inputs, so all nodes agree and round-trips verify.
const TEST_SEED = Buffer.from('flux-e2e-harness-public-deterministic-crypto-seed-v1', 'utf8');

// Transport channel constants — must match @runonflux/flux-spec/transport/constants.js
// (the node passes neither to transportdecap, so both legs share them; only AAD differs).
const TRANSPORT_INFO = 'FLUX_APP_TRANSPORT_v1';
const TRANSPORT_EXPORT_LABEL = 'FLUX_TRANSPORT_v1';
const TRANSPORT_ATTEST_DOMAIN = 'FLUX_TRANSPORT_PUBKEY_v1';

function hkdf32(salt, info) {
  return Buffer.from(crypto.hkdfSync('sha256', TEST_SEED, Buffer.from(salt), Buffer.from(info), 32));
}

// --- Ed25519 keys (attestation + blob-upload arcane signer) ---
// Build an Ed25519 KeyObject pair from a 32-byte seed via the PKCS8 wrapper.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function ed25519FromSeed(seed) {
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  const privateKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const publicKey = crypto.createPublicKey(privateKey);
  // Raw 32-byte public key is the SPKI DER minus its 12-byte header.
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return { privateKey, publicKey, rawPubB64: Buffer.from(rawPub).toString('base64') };
}

const attestationKey = ed25519FromSeed(hkdf32('ed25519', 'attestation'));
const blobUploadKey = ed25519FromSeed(hkdf32('ed25519', 'blobupload'));

function signEd25519(privateKey, messageBuf) {
  return crypto.sign(null, messageBuf, privateKey).toString('base64');
}

// --- Per-content / per-app symmetric material (node does the bulk AES) ---
function locatorFor({ appName, fluxID, contentHash }) {
  return crypto.createHash('sha256')
    .update(TEST_SEED).update('bloblocator')
    .update(appName).update(String(fluxID)).update(contentHash)
    .digest('hex');
}

function contentKeyFor({ appName, fluxID, contentHash }) {
  return hkdf32('contentkey', `${appName}:${fluxID}:${contentHash}`).toString('base64');
}

function appSecretKeyFor({ appName, fluxID }) {
  return hkdf32('appsecret', `${appName}:${fluxID}`);
}

// app-secret encrypt/decrypt (the at-rest EncryptedSpecV9 path: appencrypt/appdecrypt).
function appEncrypt({ appName, fluxID, message, aad }) {
  const key = appSecretKeyFor({ appName, fluxID });
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  if (aad != null) cipher.setAAD(Buffer.from(aad, 'base64'));
  const ct = Buffer.concat([cipher.update(Buffer.from(message, 'base64')), cipher.final()]);
  return {
    algorithm: 'AES-256-GCM',
    ciphertext: ct.toString('base64'),
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function appDecrypt({ appName, fluxID, ciphertext, nonce, tag, aad }) {
  const key = appSecretKeyFor({ appName, fluxID });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  if (aad != null) decipher.setAAD(Buffer.from(aad, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
  return { message: pt.toString('base64') };
}

// --- X25519 HPKE transport (real, via @hpke/core — the lib the node uses) ---
let hpkeCache;
async function getHpke() {
  if (hpkeCache) return hpkeCache;
  const {
    CipherSuite, DhkemX25519HkdfSha256, HkdfSha256, Aes256Gcm,
  } = await import('@hpke/core');
  const kem = new DhkemX25519HkdfSha256();
  const suite = new CipherSuite({ kem, kdf: new HkdfSha256(), aead: new Aes256Gcm() });
  hpkeCache = { suite, kem };
  return hpkeCache;
}

// Deterministic per-(app,owner) X25519 keypair. deriveKeyPair is a pure function
// of the IKM, so the public key the frontend seals toward matches the private key
// this stub decaps with.
async function transportKeyPair(appName, fluxID) {
  const { kem } = await getHpke();
  const ikm = hkdf32('transport', `${appName}:${fluxID}`);
  return kem.deriveKeyPair(ikm.buffer.slice(ikm.byteOffset, ikm.byteOffset + ikm.byteLength));
}

// The per-app transport public key + its attestation (network attestation key over
// SHA-256(domain || appName || pubkey || fluxID || ts_be64)), matching
// flux-spec transport/attestation.js so a real frontend would also verify it.
async function transportPublicKey({ appName, fluxID, timestamp }) {
  const { kem } = await getHpke();
  const kp = await transportKeyPair(appName, fluxID);
  const rawPub = Buffer.from(await kem.serializePublicKey(kp.publicKey));
  const ts = Number.isInteger(timestamp) ? timestamp : Math.floor(Date.now() / 1000);
  const tsBe = Buffer.alloc(8);
  tsBe.writeBigUInt64BE(BigInt(ts));
  const digest = crypto.createHash('sha256')
    .update(Buffer.from(TRANSPORT_ATTEST_DOMAIN))
    .update(Buffer.from(appName))
    .update(rawPub)
    .update(Buffer.from(String(fluxID)))
    .update(tsBe)
    .digest();
  return {
    publicKey: rawPub.toString('base64'),
    timestamp: ts,
    attestation: signEd25519(attestationKey.privateKey, digest),
  };
}

// HPKE decap + export of the per-submission 32-byte key. The node opens the AEAD
// locally with this key; info/export-label are the channel constants (the node
// passes neither), shared by the spec and content legs.
async function transportDecap({ appName, fluxID, encapsulatedKey }) {
  const { suite } = await getHpke();
  const kp = await transportKeyPair(appName, fluxID);
  const enc = Buffer.from(encapsulatedKey, 'base64');
  const recipient = await suite.createRecipientContext({
    recipientKey: kp.privateKey,
    enc: enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength),
    info: new TextEncoder().encode(TRANSPORT_INFO),
  });
  const key = await recipient.export(new TextEncoder().encode(TRANSPORT_EXPORT_LABEL), 32);
  return { key: Buffer.from(key).toString('base64') };
}

module.exports = {
  locatorFor,
  contentKeyFor,
  appEncrypt,
  appDecrypt,
  transportPublicKey,
  transportDecap,
  signArcaneUpload: (message) => signEd25519(blobUploadKey.privateKey, Buffer.from(message)),
  signAttestation: (message) => signEd25519(attestationKey.privateKey, Buffer.from(message)),
  attestationPubkeyB64: attestationKey.rawPubB64,
  blobUploadPubkeyB64: blobUploadKey.rawPubB64,
  TRANSPORT_INFO,
  TRANSPORT_EXPORT_LABEL,
};
