const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

// Orchestration tests for registryManager.convertApplicationSpecification /
// appConvertApi. fromLegacy + the v9 class + the crypto providers are tested in
// flux-spec; here we exercise the FluxOS glue: load, decrypt-if-encrypted,
// resolve storage refs, and seal-if-sensitive, with full control over branches.

describe('appConvert (registryManager) tests', () => {
  let getGlobalAppInfo;
  let resolveStorageRefs;
  let fromLegacy;
  let fromSubmission;
  let transportCreate;
  let encrypt;
  let legacyDecrypt;
  let legacyCryptoCreate;
  let registryManager;

  function loadWith() {
    return proxyquire('../../ZelBack/src/services/appDatabase/registryManager', {
      './appsRepository': { getGlobalAppInfo },
      '../utils/fluxStorageRefs': { resolveStorageRefs },
      '../utils/specLibs': {
        validateSubmissionSpec: sinon.stub(),
        getSpecBackend: async () => ({ fromLegacy }),
        getSpec: async () => ({
          FluxAppSpecV9: { fromSubmission: fromSubmission },
          buildSpecViewAad: () => Buffer.from('aad'),
        }),
      },
      '../providers/FluxOSLegacyCryptoProvider': { create: legacyCryptoCreate },
      '../providers/FluxOSTransportProvider': { create: transportCreate },
    });
  }

  beforeEach(() => {
    getGlobalAppInfo = sinon.stub();
    resolveStorageRefs = sinon.stub().resolves(false);
    fromLegacy = sinon.stub().returns({ spec: { components: { web: {} } }, warnings: ['w1'] });
    fromSubmission = sinon.stub().returns({
      name: 'myapp',
      owner: 'owner1',
      toCanonical: () => ({ version: 9, name: 'myapp' }),
    });
    encrypt = sinon.stub().resolves({ algorithm: 'HPKE', encapsulatedKey: 'ek', ciphertext: 'ct' });
    transportCreate = sinon.stub().resolves({ encrypt });
    legacyDecrypt = sinon.stub().resolves({ spec: { v8cleartext: true } });
    legacyCryptoCreate = sinon.stub().resolves({});
    registryManager = loadWith();
  });

  afterEach(() => sinon.restore());

  function cleartextApp(extra = {}) {
    return {
      spec: { marker: 'v8' }, version: 8, height: 1000, isEncrypted: false, name: 'myapp', owner: 'owner1', ...extra,
    };
  }

  it('returns a cleartext v9 spec when nothing sensitive is inlined', async () => {
    getGlobalAppInfo.resolves(cleartextApp());

    const result = await registryManager.convertApplicationSpecification('myapp', {});

    expect(result.encrypted).to.equal(false);
    expect(result.spec).to.deep.equal({ version: 9, name: 'myapp' });
    expect(result.warnings).to.deep.equal(['w1']);
    // fromLegacy got the cleartext legacy spec + the confirmation height.
    expect(fromLegacy.firstCall.args[0]).to.deep.equal({ marker: 'v8' });
    expect(fromLegacy.firstCall.args[1]).to.deep.equal({ confirmationHeight: 1000 });
    // storage refs resolved on the v9 components map.
    expect(resolveStorageRefs.calledOnceWith({ web: {} }, 'myapp')).to.equal(true);
    expect(transportCreate.called).to.equal(false);
  });

  it('seals the spec toward the frontend when a storage ref was inlined', async () => {
    getGlobalAppInfo.resolves(cleartextApp());
    resolveStorageRefs.resolves(true);

    const result = await registryManager.convertApplicationSpecification('myapp', { recipientPubkeyBase64: 'PUB' });

    expect(result.encrypted).to.equal(true);
    expect(result.transportEncrypted).to.deep.equal({ algorithm: 'HPKE', encapsulatedKey: 'ek', ciphertext: 'ct' });
    expect(result.appName).to.equal('myapp');
    expect(result.timestamp).to.be.a('number');
    expect(transportCreate.calledOnceWith('myapp', 'owner1', 'PUB')).to.equal(true);
    expect(encrypt.calledOnce).to.equal(true);
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
    const encApp = cleartextApp({
      isEncrypted: true,
      spec: { decrypt: legacyDecrypt },
    });
    getGlobalAppInfo.resolves(encApp);

    const result = await registryManager.convertApplicationSpecification('myapp', { recipientPubkeyBase64: 'PUB' });

    expect(legacyCryptoCreate.calledOnceWith('myapp', 'owner1')).to.equal(true);
    expect(legacyDecrypt.calledOnce).to.equal(true);
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
