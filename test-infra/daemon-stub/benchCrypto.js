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

// --- Backend TLS: per-app CA and the host certificates it signs ---
//
// Production derives a per-app CA inside a private backend from secret master
// salts. This reproduces the SHAPE of that arrangement — one CA per app,
// signing a short-lived leaf per container — and none of the scheme: the key
// comes from the public TEST_SEED above via harness-local info strings. The CA
// this produces for a given app and the real CA for the same app are unrelated
// keys, so nothing signed here is valid anywhere but a harness fleet, and
// nothing here discloses how a real certificate is derived.
//
// What it does share with production is the contract the node has to satisfy:
// an Ed25519 CA, a leaf carrying serverAuth EKU and the app's SANs, and a CA
// certificate whose bytes are identical on every node so a cached copy is
// never stale.
// Loaded on FIRST USE, never at import. This module is imported directly by the
// test runner — content-helper and several suites pull it in for the locator and
// key derivations — and there the stub's dependencies do not exist, because they
// live inside the stub's image rather than on the host. A top-level require here
// therefore fails every one of those consumers at import with MODULE_NOT_FOUND,
// which is exactly what it did. Only the certificate paths below need x509, and
// they only ever run inside the stub container, where the dependency is present.
let x509Lib = null;
function getX509() {
  if (!x509Lib) {
    // eslint-disable-next-line global-require
    x509Lib = require('@peculiar/x509');
    x509Lib.cryptoProvider.set(crypto.webcrypto);
  }
  return x509Lib;
}

// The CA window is fixed rather than relative so the certificate is
// byte-deterministic: every node deriving it independently must produce the
// same file, which is what lets FDM cache it and treat the write as idempotent.
const CA_NOT_BEFORE = new Date('2026-01-01T00:00:00Z');
const CA_NOT_AFTER = new Date('2126-01-01T00:00:00Z');
const LEAF_VALID_DAYS = 30;
const SAN_SUFFIX = '.app.runonflux.io';

// Ed25519 signing keys for x509 have to arrive as WebCrypto CryptoKeys; the
// PKCS8 wrapper is the same one ed25519FromSeed builds above.
async function importCaKeyPair(seed) {
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  const privateKey = await crypto.webcrypto.subtle.importKey(
    'pkcs8', der, { name: 'Ed25519' }, false, ['sign'],
  );
  const node = ed25519FromSeed(seed);
  const spki = node.publicKey.export({ type: 'spki', format: 'der' });
  const publicKey = await crypto.webcrypto.subtle.importKey(
    'spki', spki, { name: 'Ed25519' }, true, ['verify'],
  );
  return { privateKey, publicKey };
}

// One CA per app, memoized so repeated calls return byte-identical PEM.
const caCache = new Map();

async function appCa(appName) {
  if (caCache.has(appName)) return caCache.get(appName);
  const pending = (async () => {
    const x509 = getX509();
    const keys = await importCaKeyPair(hkdf32('backendtls-ca', `ca-signing-key:${appName}`));
    // Deterministic serial: same app, same bytes, on every node.
    const serialNumber = crypto.createHash('sha256')
      .update(TEST_SEED).update('backendtls-ca-serial').update(appName)
      .digest('hex')
      .slice(0, 32);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber,
      name: `CN=flux-ca-${appName}`,
      notBefore: CA_NOT_BEFORE,
      notAfter: CA_NOT_AFTER,
      keys,
      signingAlgorithm: { name: 'Ed25519' },
      extensions: [
        new x509.BasicConstraintsExtension(true, 0, true),
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true,
        ),
      ],
    });
    return { keys, cert };
  })();
  caCache.set(appName, pending);
  return pending;
}

/**
 * The app's CA certificate, PEM. Byte-deterministic for a given app name.
 * @param {{appName: string}} req
 */
async function caCertificate({ appName }) {
  const { cert } = await appCa(appName);
  return { certificate: cert.toString('pem') };
}

/**
 * Sign a CSR into a host certificate for the app, exactly as the production
 * signer would: 30-day life, serverAuth EKU, and the app's SANs. The CSR's
 * public key is used as submitted — the node generated it and keeps the private
 * half, which is the property that makes the leaf per-container.
 * @param {{csr: string, appName: string}} req
 */
async function signCertificate({ csr, appName }) {
  const x509 = getX509();
  const request = new x509.Pkcs10CertificateRequest(csr);
  const { keys, cert: caCert } = await appCa(appName);
  const notBefore = new Date();
  const notAfter = new Date(notBefore.getTime() + LEAF_VALID_DAYS * 24 * 60 * 60 * 1000);

  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: crypto.randomBytes(8).toString('hex'),
    subject: `CN=${appName}`,
    issuer: caCert.subject,
    notBefore,
    notAfter,
    signingKey: keys.privateKey,
    publicKey: request.publicKey,
    signingAlgorithm: { name: 'Ed25519' },
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment, true,
      ),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], false),
      new x509.SubjectAlternativeNameExtension([
        { type: 'dns', value: `${appName}${SAN_SUFFIX}` },
        { type: 'dns', value: appName },
      ]),
    ],
  });

  return { certificate: leaf.toString('pem') };
}

module.exports = {
  locatorFor,
  contentKeyFor,
  appEncrypt,
  appDecrypt,
  transportPublicKey,
  transportDecap,
  caCertificate,
  signCertificate,
  signArcaneUpload: (message) => signEd25519(blobUploadKey.privateKey, Buffer.from(message)),
  signAttestation: (message) => signEd25519(attestationKey.privateKey, Buffer.from(message)),
  attestationPubkeyB64: attestationKey.rawPubB64,
  blobUploadPubkeyB64: blobUploadKey.rawPubB64,
  TRANSPORT_INFO,
  TRANSPORT_EXPORT_LABEL,
};
