const crypto = require('node:crypto');
const { expect } = require('chai');

const arcaneAttestation = require('../../ZelBack/src/services/utils/arcaneAttestation');

const { ARCANE_ATTESTATION_PUBKEY, verifyAttestationSignature } = arcaneAttestation;

// Export an Ed25519 KeyObject as the raw 32-byte base64 form the backend returns.
function rawPubBase64(publicKey) {
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32).toString('base64');
}

describe('arcaneAttestation verify primitive', () => {
  it('verifies a genuine signature against its public key', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const message = 'FLUX_ARCANE_ATTEST_v1abc123';
    const signature = crypto.sign(null, Buffer.from(message), privateKey).toString('base64');

    expect(verifyAttestationSignature(message, rawPubBase64(publicKey), signature)).to.equal(true);
  });

  it('rejects a tampered message', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const message = 'FLUX_ARCANE_ATTEST_v1abc123';
    const signature = crypto.sign(null, Buffer.from(message), privateKey).toString('base64');

    expect(verifyAttestationSignature(`${message}x`, rawPubBase64(publicKey), signature)).to.equal(false);
  });

  it('rejects a signature from a different key', () => {
    const signer = crypto.generateKeyPairSync('ed25519');
    const other = crypto.generateKeyPairSync('ed25519');
    const message = 'FLUX_ARCANE_ATTEST_v1abc123';
    const signature = crypto.sign(null, Buffer.from(message), signer.privateKey).toString('base64');

    expect(verifyAttestationSignature(message, rawPubBase64(other.publicKey), signature)).to.equal(false);
  });

  it('returns false rather than throwing on a malformed public key', () => {
    expect(verifyAttestationSignature('msg', 'not-a-32-byte-key', 'c2ln')).to.equal(false);
  });

  it('verifies a real attestation against the hardcoded network public key', () => {
    // Captured live from a production node via fluxbenchd attest:
    //   attest {"message":"FLUX_ARCANE_ATTEST_v1deadbeefcafe"}
    const message = 'FLUX_ARCANE_ATTEST_v1deadbeefcafe';
    const signature = 'qs9kQxwJCcLpk9ps7SuIlokTBqrZ7PSZL8pRQFze8oqlAaT5LyrY3qHGvZztzRkZSXc+YB1IV5WyXNcjzp+xBw==';

    expect(verifyAttestationSignature(message, ARCANE_ATTESTATION_PUBKEY, signature)).to.equal(true);
  });
});
