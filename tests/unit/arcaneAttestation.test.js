'use strict';

const crypto = require('node:crypto');
const { expect } = require('chai');

const arcaneAttestation = require('../../ZelBack/src/services/utils/arcaneAttestation');

const { ARCANE_APP_ATTESTATION_PUBKEY, verifyAttestationSignature } = arcaneAttestation;

// Export an Ed25519 KeyObject as the raw 32-byte base64 form the backend returns.
function rawPubBase64(publicKey) {
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32).toString('base64');
}

describe('arcaneAttestation verify primitive', () => {
  it('verifies a genuine signature against its public key', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const message = 'FLUX_ARCANE_ATTEST_v2:abc123';
    const signature = crypto.sign(null, Buffer.from(message), privateKey).toString('base64');

    expect(verifyAttestationSignature(message, rawPubBase64(publicKey), signature)).to.equal(true);
  });

  it('rejects a tampered message', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const message = 'FLUX_ARCANE_ATTEST_v2:abc123';
    const signature = crypto.sign(null, Buffer.from(message), privateKey).toString('base64');

    expect(verifyAttestationSignature(`${message}x`, rawPubBase64(publicKey), signature)).to.equal(false);
  });

  it('rejects a signature from a different key', () => {
    const signer = crypto.generateKeyPairSync('ed25519');
    const other = crypto.generateKeyPairSync('ed25519');
    const message = 'FLUX_ARCANE_ATTEST_v2:abc123';
    const signature = crypto.sign(null, Buffer.from(message), signer.privateKey).toString('base64');

    expect(verifyAttestationSignature(message, rawPubBase64(other.publicKey), signature)).to.equal(false);
  });

  it('returns false rather than throwing on a malformed public key', () => {
    expect(verifyAttestationSignature('msg', 'not-a-32-byte-key', 'c2ln')).to.equal(false);
  });

  // The production app-purpose key is not yet known: it has to be read once,
  // out-of-band, from a secure-backend build carrying the `app` purpose. These
  // two tests pin the state that leaves us in, so it is a tested property rather
  // than a comment somebody has to notice — and so filling the key in turns them
  // red, which is the reminder to replace them with a real pinned signature.
  it('has no production app-attestation key yet', () => {
    expect(ARCANE_APP_ATTESTATION_PUBKEY).to.equal('');
  });

  it('fails closed while the key is unset — every attestation is invalid', () => {
    // The safe direction, and harmless while v9 has not activated: an encrypted
    // v9 message is dropped rather than admitted on an unverifiable receipt.
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const message = 'FLUX_ARCANE_ATTEST_v2:abc123';
    const signature = crypto.sign(null, Buffer.from(message), privateKey).toString('base64');

    expect(verifyAttestationSignature(message, ARCANE_APP_ATTESTATION_PUBKEY, signature))
      .to.equal(false);
  });

  it('takes a config override, which is how the harness exercises the real gate', () => {
    // The gate is only meaningful if something can point it at a keypair a test
    // controls; the fleet harness sets arcane.appAttestationPubkey to its
    // benchmark stub's app-purpose key.
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const message = 'FLUX_ARCANE_ATTEST_v2:abc123';
    const signature = crypto.sign(null, Buffer.from(message), privateKey).toString('base64');

    expect(verifyAttestationSignature(message, rawPubBase64(publicKey), signature)).to.equal(true);
  });
});
