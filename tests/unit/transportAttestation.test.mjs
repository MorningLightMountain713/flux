import crypto from 'node:crypto';
import { expect } from 'chai';
import * as benchCrypto from '../../test-infra/daemon-stub/benchCrypto.js';
import specLibs from '../../ZelBack/src/services/utils/specLibs.js';

const APP_NAME = 'transportattestapp';
const FLUX_ID = '1KPKzy7iSSDpiLJ9DUiTHhwUwvsBFTGmLo';

// Ed25519 over raw key bytes: node wants a KeyObject, and the attestation pubkey
// travels as 32 raw bytes, so wrap it in the fixed SPKI prefix for Ed25519.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function ed25519Verify(signature, message, rawPubkey) {
  const key = crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawPubkey)]),
    format: 'der',
    type: 'spki',
  });
  return crypto.verify(null, Buffer.from(message), key, Buffer.from(signature));
}

const b64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

// The transport attestation is the only cryptographic gate between "some node served
// us a public key" and "this is the app's real key", and until this test nothing had
// ever run one end to end: flux-spec's verifier is exercised by hand-built messages,
// and the harness's fake benchmark daemon — the only producer we can read — was never
// pointed at it.
//
// It was not pointed at it because it would have failed. flux-spec and the signer on
// the benchmark channel both write each variable field's length ahead of the field, so
// the signed message has exactly one reading; the stub concatenated appName, pubkey and fluxID bare, while its
// comment claimed it matched flux-spec byte for byte. Nothing it signed could verify.
//
// This binds the two. The stub stays an independent implementation — importing
// flux-spec's own message builder into it would make this test compare a function
// with itself — and this is what makes the agreement real rather than assumed.
describe('transport pubkey attestation — the stub produces what flux-spec verifies', () => {
  let verifyTransportPubkeyAttestation;
  let Chain;

  before(async () => {
    ({ verifyTransportPubkeyAttestation, Chain } = await specLibs.getSpec());
  });

  it('the harness chain holds the default attestation key the stub signs with', () => {
    expect(Buffer.from(Chain.HARNESS.attestationKey('default')).toString('base64'))
      .to.equal(benchCrypto.attestationPubkeyB64);
  });

  it('verifies an attestation the benchmark daemon stub just signed', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const served = await benchCrypto.transportPublicKey({
      appName: APP_NAME, fluxID: FLUX_ID, timestamp,
    });

    const ok = await verifyTransportPubkeyAttestation({
      appName: APP_NAME,
      fluxID: FLUX_ID,
      publicKey: b64(served.publicKey),
      timestamp: served.timestamp,
      attestation: b64(served.attestation),
      chain: Chain.HARNESS,
      maxAgeMs: 60_000,
      now: served.timestamp * 1000,
    }, ed25519Verify);

    expect(ok, 'the stub signs a message flux-spec does not verify').to.equal(true);
  });

  // The reason the lengths are written down. Without them the same bytes read two
  // ways, so one signature would vouch for two different (app, key, owner) triples.
  it('does not verify the same attestation against a different app name', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const served = await benchCrypto.transportPublicKey({
      appName: APP_NAME, fluxID: FLUX_ID, timestamp,
    });

    const ok = await verifyTransportPubkeyAttestation({
      appName: `${APP_NAME}x`,
      fluxID: FLUX_ID,
      publicKey: b64(served.publicKey),
      timestamp: served.timestamp,
      attestation: b64(served.attestation),
      chain: Chain.HARNESS,
      maxAgeMs: 60_000,
      now: served.timestamp * 1000,
    }, ed25519Verify);

    expect(ok).to.equal(false);
  });

  it('refuses an attestation older than the window it was given', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const served = await benchCrypto.transportPublicKey({
      appName: APP_NAME, fluxID: FLUX_ID, timestamp,
    });

    const ok = await verifyTransportPubkeyAttestation({
      appName: APP_NAME,
      fluxID: FLUX_ID,
      publicKey: b64(served.publicKey),
      timestamp: served.timestamp,
      attestation: b64(served.attestation),
      chain: Chain.HARNESS,
      maxAgeMs: 1000,
      now: served.timestamp * 1000 + 5000,
    }, ed25519Verify);

    expect(ok).to.equal(false);
  });
});
