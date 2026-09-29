'use strict';

// Only the stub server loads this module: @peculiar/x509 is installed in the
// stub's image, not on the host that imports benchCrypto for its derivations.

const crypto = require('node:crypto');
const x509 = require('@peculiar/x509');
const {
  TEST_SEED, ED25519_PKCS8_PREFIX, hkdf32, ed25519FromSeed,
} = require('./benchCrypto');

x509.cryptoProvider.set(crypto.webcrypto);

// Backend TLS: per-app CA and the host certificates it signs.
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
  caCertificate,
  signCertificate,
};
