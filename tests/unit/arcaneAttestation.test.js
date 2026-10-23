'use strict';

const crypto = require('node:crypto');
const { expect } = require('chai');

const { verifyEd25519OpenSsl } = require('../../ZelBack/src/services/utils/arcaneAttestation');
const { loadSpecLibrary } = require('../../ZelBack/src/services/utils/specLibrary');

// An Ed25519 KeyObject's raw 32-byte public key.
function rawPublicKey(publicKey) {
  return new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
}

describe('arcaneAttestation: the node\'s Ed25519 verifier', () => {
  let flux;
  before(async function loadLibrary() {
    this.timeout(30_000);
    flux = await loadSpecLibrary();
  });

  // The proof that lets a node verify through OpenSSL instead of flux-spec's
  // default: on every case a network key can meet, it gives the network rule's
  // answer.
  it('agrees with flux-spec\'s Ed25519 rule', async () => {
    await flux.assertEd25519Agrees(verifyEd25519OpenSsl);
  });

  it('verifies a genuine signature, and refuses a tampered message or another key', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const other = crypto.generateKeyPairSync('ed25519');
    const message = Buffer.from('FLUX_ARCANE_ATTEST_v2:abc123');
    const signature = crypto.sign(null, message, privateKey);

    expect(verifyEd25519OpenSsl(signature, message, rawPublicKey(publicKey))).to.equal(true);
    expect(verifyEd25519OpenSsl(signature, Buffer.from('FLUX_ARCANE_ATTEST_v2:abc124'), rawPublicKey(publicKey))).to.equal(false);
    expect(verifyEd25519OpenSsl(signature, message, rawPublicKey(other.publicKey))).to.equal(false);
  });

  it('returns false rather than throwing on a malformed key or signature', () => {
    expect(verifyEd25519OpenSsl(new Uint8Array(64), Buffer.from('m'), new Uint8Array(31))).to.equal(false);
    expect(verifyEd25519OpenSsl(new Uint8Array(3), Buffer.from('m'), new Uint8Array(32))).to.equal(false);
  });

  // Captured live from an Arcane node 2026-08-27, from the first build of the
  // benchmark channel's signer to carry the `app` purpose, requested through
  // the daemon's attest RPC with that purpose and a 128-hex message. The signer
  // prepends FLUX_ARCANE_ATTEST_v2: itself, so the message rebuilt here is the
  // domain plus the payload, exactly what flux-spec's buildArcaneAttestMessage
  // produces from a contentHash and an envelope hash.
  const MESSAGE = Buffer.from(`FLUX_ARCANE_ATTEST_v2:${'a'.repeat(64)}${'b'.repeat(64)}`);
  const APP_SIGNATURE = Buffer.from('KgeTEdb3s2bBeDG3cttfzwwO85JVh0xcg4PfTE5TNb7HIc567wuzE1PSpmcoO8xeDUUlUpkZvSMbGcbyDsM1CA==', 'base64');
  // The same payload signed without a purpose, in the same session: the default
  // network key, which signs the payload as given, with no domain prepended.
  const DEFAULT_SIGNATURE = Buffer.from('RdqozoBfUOsViIWUhxWnosBvQdeHjyttndVvOWISN2uWw+lc1Jk85xVfP8cXUgsq/9YkvUHkLByIrovJm5wRCg==', 'base64');

  it('verifies a real app-purpose attestation under mainnet\'s app key, by OpenSSL and by the rule', () => {
    const appKey = flux.Chain.MAIN.attestationKey(flux.ATTESTATION_PURPOSE.APP);
    expect(verifyEd25519OpenSsl(APP_SIGNATURE, MESSAGE, appKey)).to.equal(true);
    expect(flux.verifyEd25519(APP_SIGNATURE, MESSAGE, appKey)).to.equal(true);
  });

  it('verifies a real default-purpose signature under mainnet\'s default key, and never as an app attestation', () => {
    const { Chain, ATTESTATION_PURPOSE } = flux;
    const payload = Buffer.from(`${'a'.repeat(64)}${'b'.repeat(64)}`);
    expect(verifyEd25519OpenSsl(DEFAULT_SIGNATURE, payload, Chain.MAIN.attestationKey(ATTESTATION_PURPOSE.DEFAULT))).to.equal(true);
    expect(verifyEd25519OpenSsl(DEFAULT_SIGNATURE, MESSAGE, Chain.MAIN.attestationKey(ATTESTATION_PURPOSE.APP))).to.equal(false);
  });
});
