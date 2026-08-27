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

  it('verifies a real app-purpose attestation against the hardcoded key', () => {
    // Captured live from cabbage 2026-08-27, running the SAS build that added
    // the `app` purpose:
    //   POST /v2/attest {"message":"<64 a's><64 b's>","purpose":"app"}
    // The signer prepends FLUX_ARCANE_ATTEST_v2: server-side, so the message
    // rebuilt here is the domain plus the payload — exactly what flux-spec's
    // buildArcaneAttestMessage produces from a contentHash and an envelope hash.
    const message = `FLUX_ARCANE_ATTEST_v2:${'a'.repeat(64)}${'b'.repeat(64)}`;
    const signature = 'KgeTEdb3s2bBeDG3cttfzwwO85JVh0xcg4PfTE5TNb7HIc567wuzE1PSpmcoO8xeDUUlUpkZvSMbGcbyDsM1CA==';

    expect(verifyAttestationSignature(message, ARCANE_APP_ATTESTATION_PUBKEY, signature))
      .to.equal(true);
  });

  it('does not verify a signature made under the default purpose', () => {
    // Same payload, same instance, signed without a purpose — the default
    // network-wide key that FluxDrive blob upload pins. A purpose derives its
    // own key, so this is mathematically unable to verify here rather than
    // merely unlikely to. Captured in the same session as the signature above.
    const message = `FLUX_ARCANE_ATTEST_v2:${'a'.repeat(64)}${'b'.repeat(64)}`;
    const defaultPurposeSignature = 'RdqozoBfUOsViIWUhxWnosBvQdeHjyttndVvOWISN2uWw+lc1Jk85xVfP8cXUgsq/9YkvUHkLByIrovJm5wRCg==';

    expect(verifyAttestationSignature(message, ARCANE_APP_ATTESTATION_PUBKEY, defaultPurposeSignature))
      .to.equal(false);
  });

  it('resolves to the network constant when no config override is set', () => {
    // Config-driven (arcane.appAttestationPubkey) so the fleet harness can point
    // the gate at its benchmark stub's app-purpose key; with no override it must
    // fall back to the network constant.
    expect(ARCANE_APP_ATTESTATION_PUBKEY).to.equal('ERXxzVN8fg4sCjhIPp37XRu1ealmD4TA6tU7A3o6tQM=');
  });
});
