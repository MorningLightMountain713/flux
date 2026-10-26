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
  let AttestedTransportKey;

  before(async () => {
    ({ verifyTransportPubkeyAttestation, Chain, AttestedTransportKey } = await specLibs.getSpec());
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

    expect(ok, 'the stub signs a message flux-spec does not verify').to.be.instanceOf(AttestedTransportKey);
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

    expect(ok).to.equal(null);
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

    expect(ok).to.equal(null);
  });
});

// The submission's key step, bound the same way. The stub derives the
// per-submission key as fluxbench does, written apart from flux-spec; a client
// seals with flux-spec's HpkeTransportProvider and the node opens with
// flux-spec's openSubmission, so the stub's key must be the one both of those
// agree on.
describe('transport submission — the stub derives the key flux-spec seals and opens with', () => {
  let spec;

  before(async () => {
    spec = await specLibs.getSpec();
  });

  async function sealedSubmission(plaintext, aad) {
    const served = await benchCrypto.transportPublicKey({ appName: APP_NAME, fluxID: FLUX_ID });
    const recipient = await spec.verifyTransportPubkeyAttestation({
      appName: APP_NAME,
      fluxID: FLUX_ID,
      publicKey: b64(served.publicKey),
      timestamp: served.timestamp,
      attestation: b64(served.attestation),
      chain: spec.Chain.HARNESS,
      maxAgeMs: 60_000,
    }, ed25519Verify);
    const provider = await spec.HpkeTransportProvider.create();
    return provider.seal({
      plaintext, aad, recipient, info: spec.TRANSPORT_INFO,
    });
  }

  const decapFor = async (appName, envelope) => b64((await benchCrypto.transportDecap({
    appName, fluxID: FLUX_ID, encapsulatedKey: Buffer.from(envelope.encapsulatedKey).toString('base64'),
  })).key);

  it('opens a submission with the key the stub derives', async () => {
    const plaintext = new TextEncoder().encode(JSON.stringify({ version: 9, name: APP_NAME }));
    const aad = spec.buildTransportAad({ contentHash: 'ab'.repeat(32), timestamp: 1_760_000_000_000, type: 'fluxappregister' });
    const envelope = await sealedSubmission(plaintext, aad);

    const opened = spec.openSubmission({ envelope, aad, key: await decapFor(APP_NAME, envelope) });

    expect(opened).to.deep.equal(plaintext);
  });

  it('does not open it with the key the stub derives for another app', async () => {
    const plaintext = new TextEncoder().encode('{}');
    const aad = spec.buildTransportAad({ contentHash: 'ab'.repeat(32), timestamp: 1_760_000_000_000, type: 'fluxappregister' });
    const envelope = await sealedSubmission(plaintext, aad);

    const key = await decapFor(`${APP_NAME}x`, envelope);

    expect(() => spec.openSubmission({ envelope, aad, key })).to.throw(/does not open/);
  });
});
