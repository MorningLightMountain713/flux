const { expect } = require('chai');
const sinon = require('sinon');
const crypto = require('node:crypto');
const proxyquire = require('proxyquire').noCallThru();
const { aeadEncrypt, NONCE_BYTES } = require('../../ZelBack/src/services/utils/aeadCrypto');

describe('transportHelper tests', () => {
  let transportHelper;
  let benchmarkServiceStub;
  let fromJSONStub;
  let buildTransportAadStub;

  const AAD = Buffer.from('aad-bytes');

  // Build a real export-mode envelope: a fresh key, plus an aeadEncrypt frame
  // (nonce‖ct‖tag) split into the envelope's nonce + ciphertext (ct‖tag). The
  // matching transportDecap reply carries that key, so the open path runs real
  // AES-256-GCM rather than a stub.
  function sealEnvelope(plaintextObj, aad = AAD) {
    const key = crypto.randomBytes(32);
    const frame = aeadEncrypt(key, Buffer.from(JSON.stringify(plaintextObj)), aad);
    const nonce = frame.subarray(0, NONCE_BYTES);
    const ciphertext = frame.subarray(NONCE_BYTES);
    return {
      key,
      envelope: { encapsulatedKey: Buffer.from('encapsulated-key'), nonce, ciphertext },
    };
  }

  beforeEach(() => {
    benchmarkServiceStub = { transportDecap: sinon.stub() };
    fromJSONStub = sinon.stub();
    buildTransportAadStub = sinon.stub().returns(AAD);
    const getSpecStub = sinon.stub().resolves({
      TransportEnvelope: { fromJSON: fromJSONStub },
      buildTransportAad: buildTransportAadStub,
    });
    // The open path now lives in the transport provider; load the real provider
    // (real aeadCrypto + flux-spec) with only the benchmark channel stubbed, so
    // openTransportEnvelope still exercises the real split-HPKE open.
    const transportProvider = proxyquire('../../ZelBack/src/services/providers/FluxOSTransportProvider', {
      '../benchmarkService': benchmarkServiceStub,
    });
    transportHelper = proxyquire('../../ZelBack/src/services/utils/transportHelper', {
      '../providers/FluxOSTransportProvider': transportProvider,
      './specLibs': { getSpec: getSpecStub },
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  it('returns the spec unchanged when there is no transport envelope', async () => {
    const spec = { version: 9, name: 'app' };

    const result = await transportHelper.openTransportEnvelope(spec, {});

    expect(result).to.equal(spec);
    sinon.assert.notCalled(benchmarkServiceStub.transportDecap);
  });

  it('throws when a transport-encrypted submission is missing cleartext name/owner', async () => {
    const spec = { transportEncrypted: { algorithm: 'x' }, owner: 'owner1' };

    try {
      await transportHelper.openTransportEnvelope(spec, {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.message).to.include('missing cleartext name/owner');
      sinon.assert.notCalled(benchmarkServiceStub.transportDecap);
    }
  });

  it('decaps the key, opens the spec locally, and returns the parsed sparse spec', async () => {
    const sparse = { version: 9, name: 'app', owner: 'owner1' };
    const { key, envelope } = sealEnvelope(sparse);
    fromJSONStub.returns(envelope);
    benchmarkServiceStub.transportDecap.resolves({
      status: 'success',
      data: { status: 'ok', key: key.toString('base64') },
    });
    const spec = { name: 'app', owner: 'owner1', transportEncrypted: { algorithm: 'x' } };

    const result = await transportHelper.openTransportEnvelope(spec, {
      contentHash: 'h', timestamp: 1, type: 'fluxappregister',
    });

    expect(result).to.deep.equal(sparse);
    sinon.assert.calledOnce(benchmarkServiceStub.transportDecap);
    const args = benchmarkServiceStub.transportDecap.firstCall.args[0];
    expect(args.appName).to.equal('app');
    expect(args.fluxID).to.equal('owner1');
    expect(args.encapsulatedKey).to.equal(Buffer.from('encapsulated-key').toString('base64'));
    // No bulk on the channel: only the encapsulated key crosses, never ciphertext/aad.
    expect(args).to.not.have.property('ciphertext');
    expect(args).to.not.have.property('aad');
  });

  it('parses a string-encoded decap payload', async () => {
    const sparse = { version: 9, name: 'app' };
    const { key, envelope } = sealEnvelope(sparse);
    fromJSONStub.returns(envelope);
    benchmarkServiceStub.transportDecap.resolves({
      status: 'success',
      data: JSON.stringify({ status: 'ok', key: key.toString('base64') }),
    });
    const spec = { name: 'app', owner: 'owner1', transportEncrypted: {} };

    const result = await transportHelper.openTransportEnvelope(spec, {});

    expect(result).to.deep.equal(sparse);
  });

  it('throws MISSING_FIELD when the envelope carries no nonce', async () => {
    fromJSONStub.returns({
      encapsulatedKey: Buffer.from('encapsulated-key'),
      ciphertext: Buffer.from('x'.repeat(48)),
      nonce: null,
    });
    const spec = { name: 'app', owner: 'owner1', transportEncrypted: {} };

    try {
      await transportHelper.openTransportEnvelope(spec, {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.code).to.equal('MISSING_FIELD');
      sinon.assert.notCalled(benchmarkServiceStub.transportDecap);
    }
  });

  it('throws INTERNAL_ERROR when the benchmark is unreachable', async () => {
    const { envelope } = sealEnvelope({ a: 1 });
    fromJSONStub.returns(envelope);
    benchmarkServiceStub.transportDecap.resolves({ status: 'error' });
    const spec = { name: 'app', owner: 'owner1', transportEncrypted: {} };

    try {
      await transportHelper.openTransportEnvelope(spec, {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.code).to.equal('INTERNAL_ERROR');
    }
  });

  it('throws the backend-reported code when decap fails', async () => {
    const { envelope } = sealEnvelope({ a: 1 });
    fromJSONStub.returns(envelope);
    benchmarkServiceStub.transportDecap.resolves({
      status: 'success',
      data: { status: 'error', message: 'DECRYPT_FAILED' },
    });
    const spec = { name: 'app', owner: 'owner1', transportEncrypted: {} };

    try {
      await transportHelper.openTransportEnvelope(spec, {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.code).to.equal('DECRYPT_FAILED');
    }
  });

  it('throws DECRYPT_FAILED when local AEAD authentication fails (aad mismatch)', async () => {
    // Correct key, but the frame was sealed under a different aad than
    // buildTransportAad reconstructs — GCM auth fails locally.
    const { key, envelope } = sealEnvelope({ version: 9 }, Buffer.from('different-aad'));
    fromJSONStub.returns(envelope);
    benchmarkServiceStub.transportDecap.resolves({
      status: 'success',
      data: { status: 'ok', key: key.toString('base64') },
    });
    const spec = { name: 'app', owner: 'owner1', transportEncrypted: {} };

    try {
      await transportHelper.openTransportEnvelope(spec, {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.code).to.equal('DECRYPT_FAILED');
    }
  });
});
