import crypto from 'node:crypto';
import {
  CipherSuite, DhkemX25519HkdfSha256, HkdfSha256, Aes256Gcm,
} from '@hpke/core';

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
const meshAttestationKey = ed25519FromSeed(hkdf32('ed25519', 'mesh-attestation'));
const appAttestationKey = ed25519FromSeed(hkdf32('ed25519', 'app-attestation'));

// Mesh voucher domain separator — must match VOUCHER_DOMAIN in
// ZelBack/src/services/appMesh/meshVoucher.js. The signer prepends it, so no
// caller can mint bytes shaped like another protocol's.
const MESH_VOUCHER_DOMAIN = 'FLUX_MESH_VOUCHER_v1:';

// App-attestation domain separator — must match ARCANE_ATTEST_DOMAIN in
// flux-spec signature/arcaneAttestation.js. Prepended here for the same reason
// as the mesh one: the signer owns the domain, so a caller supplies only a
// payload and cannot mint bytes shaped like another protocol's message.
const APP_ATTEST_DOMAIN = 'FLUX_ARCANE_ATTEST_v2:';

function signEd25519(privateKey, messageBuf) {
  return crypto.sign(null, messageBuf, privateKey).toString('base64');
}

// --- Per-content / per-app symmetric material (node does the bulk AES) ---
// A v9 identity: `b`, 51 base32 characters, then `a` or `q`. Every content
// derivation is keyed by it, never by the app's name or owner, and any other
// spelling is refused rather than deriving a key that is not the app's.
const IDENTITY_PATTERN = /^b[a-z2-7]{51}[aq]$/;

function requireIdentity(identity) {
  if (typeof identity !== 'string' || !IDENTITY_PATTERN.test(identity)) throw new Error('identity invalid');
  return identity;
}

function locatorFor({ identity, contentHash }) {
  return crypto.createHash('sha256')
    .update(TEST_SEED).update('bloblocator')
    .update(requireIdentity(identity)).update(contentHash)
    .digest('hex');
}

function contentKeyFor({ identity, contentHash }) {
  return hkdf32('contentkey', `${requireIdentity(identity)}:${contentHash}`).toString('base64');
}

// The key an appencrypt/appdecrypt request names: the app-secret key by name and
// owner, for an encrypted spec sealed for the owner it names; or the content seal
// key by identity, for a manifest's slots, which stay the app's across an
// ownership transfer. A request naming both is refused.
function sealKeyFor({ appName, fluxID, identity }) {
  if (identity !== undefined) {
    if (appName !== undefined || fluxID !== undefined) throw new Error('AMBIGUOUS_KEY');
    return hkdf32('contentseal', requireIdentity(identity));
  }
  return hkdf32('appsecret', `${appName}:${fluxID}`);
}

// appencrypt/appdecrypt: the at-rest seal of a spec or of a manifest's slots.
function appEncrypt({
  appName, fluxID, identity, message, aad,
}) {
  const key = sealKeyFor({ appName, fluxID, identity });
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

function appDecrypt({
  appName, fluxID, identity, ciphertext, nonce, tag, aad,
}) {
  const key = sealKeyFor({ appName, fluxID, identity });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  if (aad != null) decipher.setAAD(Buffer.from(aad, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
  return { message: pt.toString('base64') };
}

// --- Arcane blob signatures ---
// The channel builds the signed text itself from typed fields, as the library's
// fluxDriveWrites does: a per-kind domain prefix over the hex digest of that
// kind's text. Every text names the app's identity; a manifest names the height
// its signer took the app and the hash of the slot locators it keeps, sorted and
// each once, so no caller can have a different list signed, and, carried by a
// spec update, the update's message hash, empty otherwise. Callers send fields,
// never a message.
function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const BLOB_SIGNATURE_DOMAINS = {
  upload: 'FLUX_BLOB_UPLOAD_v1:',
  manifest: 'FLUX_BLOB_MANIFEST_v1:',
};

// Every write carries a timestamp and is refused outside this window.
const BLOB_FRESHNESS_WINDOW_MS = 300 * 1000;

function pendingMessageHashField(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error('signblobupload: pendingMessageHash invalid');
  return value;
}

function keptLocatorsHash(locators) {
  if (!Array.isArray(locators) || !locators.length) throw new Error('signblobupload: keptLocators invalid');
  return sha256Hex([...new Set(locators)].sort().join('\n'));
}

function blobSignedDigest(fields) {
  const identity = requireIdentity(fields.identity);
  switch (fields.kind) {
    case 'upload':
      return sha256Hex(`${fields.locator}:${identity}:${fields.timestamp}`);
    case 'manifest':
      if (!Number.isSafeInteger(fields.ownedFrom) || fields.ownedFrom < 0) throw new Error('signblobupload: ownedFrom invalid');
      return sha256Hex(`${identity}:${fields.ownedFrom}:${fields.version}:${fields.timestamp}:${keptLocatorsHash(fields.keptLocators)}:${pendingMessageHashField(fields.pendingMessageHash)}`);
    default:
      throw new Error(`signblobupload: unknown kind ${fields.kind}`);
  }
}

function signBlobUpload(fields) {
  const domain = BLOB_SIGNATURE_DOMAINS[fields.kind];
  if (!domain) throw new Error(`signblobupload: unknown kind ${fields.kind}`);
  const skewMs = Math.abs(Date.now() - Number(fields.timestamp));
  if (!Number.isFinite(skewMs) || skewMs > BLOB_FRESHNESS_WINDOW_MS) {
    throw new Error('signblobupload: timestamp outside the freshness window');
  }
  return signEd25519(blobUploadKey.privateKey, Buffer.from(domain + blobSignedDigest(fields)));
}

// --- X25519 HPKE transport (real, via @hpke/core — the lib the node uses) ---
let hpkeCache;
async function getHpke() {
  if (hpkeCache) return hpkeCache;
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
// SHA-256(domain || len_be32(appName) || appName || pubkey || len_be32(fluxID)
// || fluxID || ts_be64)).
//
// appName and fluxID carry their byte lengths so the message has exactly one reading.
// Concatenated bare — which this did, while claiming to match — only the pubkey and
// the timestamp are fixed-width, so a byte slid out of appName into pubkey and one out
// of pubkey into fluxID gives an identical message, and one signature vouches for two
// different (appName, pubkey, fluxID) triples.
//
// This is an independent implementation of flux-spec's attestationMessage() and of
// the benchmark channel signer's. Independent on purpose: three implementations agreeing is
// worth something, and importing flux-spec's builder here would leave the test that
// checks them comparing a function with itself. tests/unit/transportAttestation.test.js
// runs this producer through that verifier, which is what keeps them honest.
function be32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

async function transportPublicKey({ appName, fluxID, timestamp }) {
  const { kem } = await getHpke();
  const kp = await transportKeyPair(appName, fluxID);
  const rawPub = Buffer.from(await kem.serializePublicKey(kp.publicKey));
  const ts = Number.isInteger(timestamp) ? timestamp : Math.floor(Date.now() / 1000);
  const tsBe = Buffer.alloc(8);
  tsBe.writeBigUInt64BE(BigInt(ts));
  const appNameBuf = Buffer.from(appName);
  const fluxIdBuf = Buffer.from(String(fluxID));
  const digest = crypto.createHash('sha256')
    .update(Buffer.from(TRANSPORT_ATTEST_DOMAIN))
    .update(be32(appNameBuf.length))
    .update(appNameBuf)
    .update(rawPub)
    .update(be32(fluxIdBuf.length))
    .update(fluxIdBuf)
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

export const signAttestation = (message) => signEd25519(attestationKey.privateKey, Buffer.from(message));
export const signMeshAttestation = (message) => signEd25519(meshAttestationKey.privateKey, Buffer.from(MESH_VOUCHER_DOMAIN + message));
export const signAppAttestation = (message) => signEd25519(appAttestationKey.privateKey, Buffer.from(APP_ATTEST_DOMAIN + message));
export const attestationPubkeyB64 = attestationKey.rawPubB64;
export const blobUploadPubkeyB64 = blobUploadKey.rawPubB64;
export const meshAttestationPubkeyB64 = meshAttestationKey.rawPubB64;
export const appAttestationPubkeyB64 = appAttestationKey.rawPubB64;

export {
  IDENTITY_PATTERN,
  requireIdentity,
  locatorFor,
  contentKeyFor,
  appEncrypt,
  appDecrypt,
  transportPublicKey,
  transportDecap,
  signBlobUpload,
  TRANSPORT_INFO,
  TRANSPORT_EXPORT_LABEL,
  TEST_SEED,
  ED25519_PKCS8_PREFIX,
  hkdf32,
  ed25519FromSeed,
};
