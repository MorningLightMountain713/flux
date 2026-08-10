'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

// Orchestration tests for registryManager.convertApplicationSpecification /
// appConvertApi. fromLegacy + the v9 class + the crypto providers are tested in
// flux-spec; here we exercise the FluxOS glue: load, decrypt-if-encrypted,
// resolve storage refs, validate (non-throwing draft), and seal-if-sensitive,
// with full control over branches.

describe('appConvert (registryManager) tests', () => {
  let getGlobalAppInfo;
  let resolveStorageRefs;
  let fromLegacy;
  let validateSchema;
  let fromSubmission;
  let transportCreate;
  let seal;
  let sealEnvelope;
  let specDecrypt;
  let registryManager;

  function loadWith() {
    return proxyquire('../../ZelBack/src/services/appDatabase/registryManager', {
      './appsRepository': { getGlobalAppInfo },
      '../utils/fluxStorageRefs': { resolveStorageRefs },
      '../utils/specLibs': {
        validateSubmissionSpec: sinon.stub(),
        getSpecBackend: async () => ({ fromLegacy }),
        getSpec: async () => ({
          FluxAppSpecV9: { fromSubmission, validateSchema },
          buildSpecViewAad: () => Buffer.from('aad'),
          SPEC_VIEW_INFO: 'FLUX_APP_SPEC_VIEW_v1',
        }),
      },
      '../providers/FluxOSTransportProvider': { create: transportCreate },
    });
  }

  beforeEach(() => {
    getGlobalAppInfo = sinon.stub();
    resolveStorageRefs = sinon.stub().resolves(false);
    // fromLegacy always emits a blob carrying the cleartext name/owner metadata;
    // convert reads those off the blob, so an incomplete blob still names itself.
    fromLegacy = sinon.stub().returns({
      spec: { name: 'myapp', owner: 'owner1', components: { web: {} } },
      warnings: ['w1'],
    });
    validateSchema = sinon.stub().returns({ valid: true, errors: [] });
    fromSubmission = sinon.stub().returns({
      name: 'myapp',
      owner: 'owner1',
      toCanonical: () => ({ version: 9, name: 'myapp' }),
    });
    sealEnvelope = { toJSON: () => ({ algorithm: 'HPKE', encapsulatedKey: 'ek', ciphertext: 'ct' }) };
    seal = sinon.stub().resolves(sealEnvelope);
    transportCreate = sinon.stub().resolves({ seal });
    specDecrypt = sinon.stub().resolves({ spec: { v8cleartext: true } });
    registryManager = loadWith();
  });

  afterEach(() => sinon.restore());

  function cleartextApp(extra = {}) {
    return {
      spec: { marker: 'v8' }, version: 8, height: 1000, isEncrypted: false, name: 'myapp', owner: 'owner1', ...extra,
    };
  }

  it('returns a complete cleartext v9 spec when nothing sensitive is inlined', async () => {
    getGlobalAppInfo.resolves(cleartextApp());

    const result = await registryManager.convertApplicationSpecification('myapp', {});

    expect(result.encrypted).to.equal(false);
    expect(result.complete).to.equal(true);
    expect(result.errors).to.deep.equal([]);
    expect(result.spec).to.deep.equal({ version: 9, name: 'myapp' });
    expect(result.warnings).to.deep.equal(['w1']);
    // fromLegacy got the cleartext legacy spec + the confirmation height.
    expect(fromLegacy.firstCall.args[0]).to.deep.equal({ marker: 'v8' });
    expect(fromLegacy.firstCall.args[1]).to.deep.equal({ confirmationHeight: 1000 });
    // storage refs resolved on the v9 components map.
    expect(resolveStorageRefs.calledOnceWith({ web: {} }, 'myapp')).to.equal(true);
    expect(transportCreate.called).to.equal(false);
  });

  it('returns a fillable draft with inline errors when the converted spec is incomplete', async () => {
    getGlobalAppInfo.resolves(cleartextApp());
    validateSchema.returns({ valid: false, errors: [{ field: 'contacts', message: 'contacts is required' }] });

    const result = await registryManager.convertApplicationSpecification('myapp', {});

    expect(result.encrypted).to.equal(false);
    expect(result.complete).to.equal(false);
    expect(result.errors).to.deep.equal([{ field: 'contacts', message: 'contacts is required' }]);
    // the draft is the sparse v9 blob itself; strict fromSubmission is never
    // run on an invalid blob (it would throw).
    expect(result.spec).to.deep.equal({ name: 'myapp', owner: 'owner1', components: { web: {} } });
    expect(fromSubmission.called).to.equal(false);
    expect(result.warnings).to.deep.equal(['w1']);
  });

  it('seals the spec toward the frontend when a storage ref was inlined', async () => {
    getGlobalAppInfo.resolves(cleartextApp());
    resolveStorageRefs.resolves(true);

    const result = await registryManager.convertApplicationSpecification('myapp', { recipientPubkeyBase64: 'PUB' });

    expect(result.encrypted).to.equal(true);
    expect(result.complete).to.equal(true);
    expect(result.transportEncrypted).to.deep.equal({ algorithm: 'HPKE', encapsulatedKey: 'ek', ciphertext: 'ct' });
    expect(result.appName).to.equal('myapp');
    expect(result.timestamp).to.be.a('number');
    // create takes only (name, owner); the recipient pubkey is a seal arg.
    expect(transportCreate.calledOnceWith('myapp', 'owner1')).to.equal(true);
    expect(seal.calledOnce).to.equal(true);
    const sealArg = seal.firstCall.args[0];
    expect(sealArg.peerPublicKey).to.deep.equal(Buffer.from('PUB', 'base64'));
    expect(sealArg.info).to.equal('FLUX_APP_SPEC_VIEW_v1');
  });

  it('seals the sparse draft when the source was encrypted but the conversion is incomplete', async () => {
    const createProvider = sinon.stub().resolves({});
    getGlobalAppInfo.resolves(cleartextApp({
      isEncrypted: true,
      spec: { createProvider, decrypt: specDecrypt },
    }));
    validateSchema.returns({ valid: false, errors: [{ field: 'contacts', message: 'contacts is required' }] });

    const result = await registryManager.convertApplicationSpecification('myapp', { recipientPubkeyBase64: 'PUB' });

    expect(result.encrypted).to.equal(true);
    expect(result.complete).to.equal(false);
    expect(result.errors).to.have.length(1);
    // the sealed plaintext is the sparse draft blob, not a canonical form.
    const sealArg = seal.firstCall.args[0];
    expect(JSON.parse(sealArg.plaintext.toString('utf8'))).to.deep.equal({
      name: 'myapp', owner: 'owner1', components: { web: {} },
    });
    expect(fromSubmission.called).to.equal(false);
  });

  it('requires a transport pubkey when the result must be encrypted', async () => {
    getGlobalAppInfo.resolves(cleartextApp());
    resolveStorageRefs.resolves(true);

    let threw;
    try {
      await registryManager.convertApplicationSpecification('myapp', {});
    } catch (e) {
      threw = e;
    }
    expect(threw).to.be.an('error');
    expect(threw.message).to.include('flux-transport-pubkey');
  });

  it('decrypts an encrypted source before converting, then seals', async () => {
    const backendProvider = {};
    const createProvider = sinon.stub().resolves(backendProvider);
    const encApp = cleartextApp({
      isEncrypted: true,
      spec: { createProvider, decrypt: specDecrypt },
    });
    getGlobalAppInfo.resolves(encApp);

    const result = await registryManager.convertApplicationSpecification('myapp', { recipientPubkeyBase64: 'PUB' });

    expect(createProvider.calledOnce).to.equal(true);
    expect(specDecrypt.calledOnceWith(backendProvider)).to.equal(true);
    // fromLegacy got the decrypted cleartext spec.
    expect(fromLegacy.firstCall.args[0]).to.deep.equal({ v8cleartext: true });
    expect(result.encrypted).to.equal(true);
  });

  it('rejects an app that is already on spec version 9', async () => {
    getGlobalAppInfo.resolves(cleartextApp({ version: 9 }));

    let threw;
    try {
      await registryManager.convertApplicationSpecification('myapp', {});
    } catch (e) {
      threw = e;
    }
    expect(threw.message).to.include('already on spec version 9');
  });

  it('rejects an unknown app', async () => {
    getGlobalAppInfo.resolves(null);

    let threw;
    try {
      await registryManager.convertApplicationSpecification('ghost', {});
    } catch (e) {
      threw = e;
    }
    expect(threw.message).to.include('not found');
  });
});
