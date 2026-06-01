const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('transportHelper tests', () => {
  let transportHelper;
  let benchmarkServiceStub;
  let fromJSONStub;
  let buildTransportAadStub;

  beforeEach(() => {
    benchmarkServiceStub = { transportOpen: sinon.stub() };
    fromJSONStub = sinon.stub().returns({
      encapsulatedKey: Buffer.from('encapsulated-key'),
      ciphertext: Buffer.from('cipher-text'),
    });
    buildTransportAadStub = sinon.stub().returns(Buffer.from('aad-bytes'));
    const getSpecStub = sinon.stub().resolves({
      TransportEnvelope: { fromJSON: fromJSONStub },
      buildTransportAad: buildTransportAadStub,
    });
    transportHelper = proxyquire('../../ZelBack/src/services/utils/transportHelper', {
      '../benchmarkService': benchmarkServiceStub,
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
    sinon.assert.notCalled(benchmarkServiceStub.transportOpen);
  });

  it('throws when a transport-encrypted submission is missing cleartext name/owner', async () => {
    const spec = { transportEncrypted: { algorithm: 'x' }, owner: 'owner1' };

    try {
      await transportHelper.openTransportEnvelope(spec, {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.message).to.include('missing cleartext name/owner');
      sinon.assert.notCalled(benchmarkServiceStub.transportOpen);
    }
  });

  it('opens the envelope and returns the parsed sparse spec', async () => {
    const sparse = { version: 9, name: 'app', owner: 'owner1' };
    benchmarkServiceStub.transportOpen.resolves({
      status: 'success',
      data: { status: 'ok', message: JSON.stringify(sparse) },
    });
    const spec = { name: 'app', owner: 'owner1', transportEncrypted: { algorithm: 'x' } };

    const result = await transportHelper.openTransportEnvelope(spec, {
      contentHash: 'h', timestamp: 1, type: 'fluxappregister',
    });

    expect(result).to.deep.equal(sparse);
    sinon.assert.calledOnce(benchmarkServiceStub.transportOpen);
    const args = benchmarkServiceStub.transportOpen.firstCall.args[0];
    expect(args.appName).to.equal('app');
    expect(args.fluxID).to.equal('owner1');
    expect(args.encapsulatedKey).to.equal(Buffer.from('encapsulated-key').toString('base64'));
    expect(args.ciphertext).to.equal(Buffer.from('cipher-text').toString('base64'));
    expect(args.aad).to.equal(Buffer.from('aad-bytes').toString('base64'));
  });

  it('parses a string-encoded data payload', async () => {
    const sparse = { version: 9, name: 'app' };
    benchmarkServiceStub.transportOpen.resolves({
      status: 'success',
      data: JSON.stringify({ status: 'ok', message: JSON.stringify(sparse) }),
    });
    const spec = { name: 'app', owner: 'owner1', transportEncrypted: {} };

    const result = await transportHelper.openTransportEnvelope(spec, {});

    expect(result).to.deep.equal(sparse);
  });

  it('throws INTERNAL_ERROR when the benchmark is unreachable', async () => {
    benchmarkServiceStub.transportOpen.resolves({ status: 'error' });
    const spec = { name: 'app', owner: 'owner1', transportEncrypted: {} };

    try {
      await transportHelper.openTransportEnvelope(spec, {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.code).to.equal('INTERNAL_ERROR');
    }
  });

  it('throws with the SAS-reported code when the open fails', async () => {
    benchmarkServiceStub.transportOpen.resolves({
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
});
