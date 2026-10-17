'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
const { EventEmitter } = require('events');
const messageHelper = require('../../ZelBack/src/services/messageHelper');
const { Privilege, authOf } = require('../../ZelBack/src/services/utils/privileges');
const verificationHelper = require('../../ZelBack/src/services/verificationHelper');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const benchmarkService = require('../../ZelBack/src/services/benchmarkService');
const daemonStatus = require('../../ZelBack/src/services/daemonService/daemonStatus');
const globalState = require('../../ZelBack/src/services/utils/globalState');
const transportHelper = require('../../ZelBack/src/services/utils/transportHelper');
const contentBlobService = require('../../ZelBack/src/services/appLifecycle/contentBlobService');
const specLibs = require('../../ZelBack/src/services/utils/specLibs');
const signatureVerifier = require('../../ZelBack/src/services/signatureVerifier');
const appEventVerifier = require('../../ZelBack/src/services/appMessaging/appEventVerifier');
const { loadSpecLibrary } = require('./fixtures/fluxSpec');
const { stubRegistry } = require('./fixtures/appRecords');

describe('cryptographicKeys tests', () => {
  let req;
  let res;
  let cryptographicKeys;

  // Helper to reload module after environment change
  const reloadModule = () => {
    cryptographicKeys = proxyquire('../../ZelBack/src/services/appMessaging/cryptographicKeys', {});
  };

  // Helper to call getPublicKey and wait for response
  const callGetPublicKey = (reqObj, resObj, data) => new Promise((resolve) => {
    cryptographicKeys.getPublicKey(reqObj, resObj);
    setTimeout(() => {
      if (Array.isArray(data)) {
        // Handle data chunks
        data.forEach((chunk) => reqObj.emit('data', chunk));
      } else if (data) {
        reqObj.emit('data', data);
      }
      reqObj.emit('end');
      // Give the async handler time to complete
      setTimeout(resolve, 20);
    }, 10);
  });

  beforeEach(() => {
    req = new EventEmitter();
    req.params = {};
    req.query = {};
    req.headers = {};
    res = {
      json: sinon.stub(),
      status: sinon.stub().returnsThis(),
      write: sinon.stub(),
      end: sinon.stub(),
      flush: sinon.stub(),
    };

    // Clear module cache and reload to pick up environment variable changes
    reloadModule();
    // Default to an attested Arcane verdict; the non-arcane case overrides below.
    sinon.stub(globalState, 'isArcane').returns(true);
  });

  afterEach(() => {
    sinon.restore();
    delete process.env.FLUXOS_PATH;
  });

  describe('getAppPublicKey tests', () => {
    it('should throw error if not running on Arcane OS', async () => {
      globalState.isArcane.returns(false);

      try {
        await cryptographicKeys.getAppPublicKey('1ABC123', 'TestApp', 1000);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Arcane OS');
      }
    });

    it('should successfully get public key on Arcane OS', async () => {
      process.env.FLUXOS_PATH = '/some/path';
      reloadModule();

      const mockPublicKey = '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0B\n-----END PUBLIC KEY-----';

      sinon.stub(benchmarkService, 'getPublicKey').resolves({
        status: 'success',
        data: JSON.stringify({
          status: 'ok',
          publicKey: mockPublicKey,
        }),
      });

      const result = await cryptographicKeys.getAppPublicKey('1ABC123', 'TestApp', 1000);

      expect(result).to.equal(mockPublicKey);
    });

    it('should throw error if benchmark service returns error status', async () => {
      process.env.FLUXOS_PATH = '/some/path';
      reloadModule();

      sinon.stub(benchmarkService, 'getPublicKey').resolves({
        status: 'error',
        data: 'Service unavailable',
      });

      try {
        await cryptographicKeys.getAppPublicKey('1ABC123', 'TestApp', 1000);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Error getting public key');
      }
    });

    it('should throw error if public key is null in response', async () => {
      process.env.FLUXOS_PATH = '/some/path';
      reloadModule();

      sinon.stub(benchmarkService, 'getPublicKey').resolves({
        status: 'success',
        data: JSON.stringify({
          status: 'error',
          publicKey: null,
        }),
      });

      try {
        await cryptographicKeys.getAppPublicKey('1ABC123', 'TestApp', 1000);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Error getting public key to encrypt app enterprise content');
      }
    });

    it('should properly format input data for benchmark service', async () => {
      process.env.FLUXOS_PATH = '/some/path';
      reloadModule();

      const getPublicKeyStub = sinon.stub(benchmarkService, 'getPublicKey').resolves({
        status: 'success',
        data: JSON.stringify({
          status: 'ok',
          publicKey: 'mockPublicKey',
        }),
      });

      const fluxID = '1ABC123XYZ';
      const appName = 'MyTestApp';
      const blockHeight = 123_456;

      await cryptographicKeys.getAppPublicKey(fluxID, appName, blockHeight);

      const callArg = getPublicKeyStub.firstCall.args[0];
      const parsedArg = JSON.parse(callArg);
      expect(parsedArg.fluxID).to.equal(fluxID);
      expect(parsedArg.appName).to.equal(appName);
      expect(parsedArg.blockHeight).to.equal(blockHeight);
    });
  });

  describe('getPublicKey tests', () => {
    it('should return unauthorized if user not authorized', async () => {
      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(false);
      sinon.stub(messageHelper, 'errUnauthorizedMessage').returns({
        status: 'error',
        data: { code: 401, message: 'Unauthorized' },
      });

      const appSpec = JSON.stringify({
        owner: '1ABC123',
        name: 'TestApp',
      });

      await callGetPublicKey(req, res, appSpec);

      sinon.assert.calledOnce(res.json);
      expect(res.json.firstCall.args[0].status).to.equal('error');
    });

    it('should return error if owner parameter missing', async () => {
      process.env.FLUXOS_PATH = '/some/path';
      reloadModule();
      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
      sinon.stub(serviceHelper, 'ensureObject').returns({ name: 'TestApp' }); // Missing owner
      sinon.stub(messageHelper, 'createErrorMessage').callsFake((msg) => ({
        status: 'error',
        data: { message: msg },
      }));

      const appSpec = JSON.stringify({ name: 'TestApp' });

      await callGetPublicKey(req, res, appSpec);

      sinon.assert.calledOnce(res.json);
      expect(res.json.firstCall.args[0].status).to.equal('error');
      expect(res.json.firstCall.args[0].data.message).to.include('Input parameters missing');
    });

    it('should return error if name parameter missing', async () => {
      process.env.FLUXOS_PATH = '/some/path';
      reloadModule();
      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
      sinon.stub(serviceHelper, 'ensureObject').returns({ owner: '1ABC123' }); // Missing name
      sinon.stub(messageHelper, 'createErrorMessage').callsFake((msg) => ({
        status: 'error',
        data: { message: msg },
      }));

      const appSpec = JSON.stringify({ owner: '1ABC123' });

      await callGetPublicKey(req, res, appSpec);

      sinon.assert.calledOnce(res.json);
      expect(res.json.firstCall.args[0].status).to.equal('error');
      expect(res.json.firstCall.args[0].data.message).to.include('Input parameters missing');
    });

    it('should return error if daemon not synced', async () => {
      process.env.FLUXOS_PATH = '/some/path';
      reloadModule();
      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
      sinon.stub(serviceHelper, 'ensureObject').returns({
        owner: '1ABC123',
        name: 'TestApp',
      });
      sinon.stub(daemonStatus, 'daemonSyncState').returns({ synced: false, height: 1000 });
      sinon.stub(messageHelper, 'createErrorMessage').callsFake((msg) => ({
        status: 'error',
        data: { message: msg },
      }));

      const appSpec = JSON.stringify({
        owner: '1ABC123',
        name: 'TestApp',
      });

      await callGetPublicKey(req, res, appSpec);
      sinon.assert.calledOnce(res.json);
      expect(res.json.firstCall.args[0].status).to.equal('error');
      expect(res.json.firstCall.args[0].data.message).to.include('Daemon not yet synced');
    });

    it('should successfully return public key when all conditions met', async () => {
      process.env.FLUXOS_PATH = '/some/path';
      reloadModule();
      const mockPublicKey = '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0B\n-----END PUBLIC KEY-----';

      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
      sinon.stub(serviceHelper, 'ensureObject').returns({
        owner: '1ABC123',
        name: 'TestApp',
      });
      sinon.stub(daemonStatus, 'daemonSyncState').returns({ synced: true, height: 2000 });
      sinon.stub(benchmarkService, 'getPublicKey').resolves({
        status: 'success',
        data: JSON.stringify({
          status: 'ok',
          publicKey: mockPublicKey,
        }),
      });
      sinon.stub(messageHelper, 'createDataMessage').callsFake((data) => ({
        status: 'success',
        data,
      }));

      const appSpec = JSON.stringify({
        owner: '1ABC123',
        name: 'TestApp',
      });

      await callGetPublicKey(req, res, appSpec);

      sinon.assert.calledOnce(res.json);
      expect(res.json.firstCall.args[0].status).to.equal('success');
      expect(res.json.firstCall.args[0].data).to.equal(mockPublicKey);
    });

    it('should handle request body in chunks', async () => {
      process.env.FLUXOS_PATH = '/some/path';
      reloadModule();
      const mockPublicKey = 'mockKey123';

      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
      const ensureObjectStub = sinon.stub(serviceHelper, 'ensureObject');
      ensureObjectStub.onFirstCall().returns('{"owner":"1ABC123","name":"TestApp"}');
      ensureObjectStub.onSecondCall().returns({
        owner: '1ABC123',
        name: 'TestApp',
      });
      sinon.stub(daemonStatus, 'daemonSyncState').returns({ synced: true, height: 2000 });
      sinon.stub(benchmarkService, 'getPublicKey').resolves({
        status: 'success',
        data: JSON.stringify({
          status: 'ok',
          publicKey: mockPublicKey,
        }),
      });
      sinon.stub(messageHelper, 'createDataMessage').callsFake((data) => ({
        status: 'success',
        data,
      }));

      // Send request body in multiple chunks
      await callGetPublicKey(req, res, ['{"owner":"1ABC', '123","name":"T', 'estApp"}']);

      sinon.assert.calledOnce(res.json);
      expect(res.json.firstCall.args[0].status).to.equal('success');
    });

    it('should verify user privilege level', async () => {
      process.env.FLUXOS_PATH = '/some/path';
      reloadModule();
      const verifyStub = sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
      sinon.stub(serviceHelper, 'ensureObject').returns({
        owner: '1ABC123',
        name: 'TestApp',
      });
      sinon.stub(daemonStatus, 'daemonSyncState').returns({ synced: true, height: 2000 });
      sinon.stub(benchmarkService, 'getPublicKey').resolves({
        status: 'success',
        data: JSON.stringify({
          status: 'ok',
          publicKey: 'mockKey',
        }),
      });
      sinon.stub(messageHelper, 'createDataMessage').returns({
        status: 'success',
        data: 'mockKey',
      });

      const appSpec = JSON.stringify({
        owner: '1ABC123',
        name: 'TestApp',
      });

      await callGetPublicKey(req, res, appSpec);

      sinon.assert.calledWith(verifyStub, Privilege.USER, authOf(req));
    });

    it('should use daemon height when calling getAppPublicKey', async () => {
      process.env.FLUXOS_PATH = '/some/path';
      reloadModule();
      const daemonHeight = 123_456;

      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
      sinon.stub(serviceHelper, 'ensureObject').returns({
        owner: '1ABC123',
        name: 'TestApp',
      });
      sinon.stub(daemonStatus, 'daemonSyncState').returns({ synced: true, height: daemonHeight });
      const getPublicKeyStub = sinon.stub(benchmarkService, 'getPublicKey').resolves({
        status: 'success',
        data: JSON.stringify({
          status: 'ok',
          publicKey: 'mockKey',
        }),
      });
      sinon.stub(messageHelper, 'createDataMessage').returns({
        status: 'success',
        data: 'mockKey',
      });

      const appSpec = JSON.stringify({
        owner: '1ABC123',
        name: 'TestApp',
      });

      await callGetPublicKey(req, res, appSpec);

      const callArg = getPublicKeyStub.firstCall.args[0];
      const parsedArg = JSON.parse(callArg);
      expect(parsedArg.blockHeight).to.equal(daemonHeight);
    });

    it('should handle errors from getAppPublicKey and return error response', async () => {
      process.env.FLUXOS_PATH = '/some/path';
      reloadModule();

      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
      sinon.stub(serviceHelper, 'ensureObject').returns({
        owner: '1ABC123',
        name: 'TestApp',
      });
      sinon.stub(daemonStatus, 'daemonSyncState').returns({ synced: true, height: 2000 });
      sinon.stub(benchmarkService, 'getPublicKey').resolves({
        status: 'error',
        data: 'Service error',
      });
      sinon.stub(messageHelper, 'createErrorMessage').callsFake((msg) => ({
        status: 'error',
        data: { message: msg },
      }));

      const appSpec = JSON.stringify({
        owner: '1ABC123',
        name: 'TestApp',
      });

      await callGetPublicKey(req, res, appSpec);

      sinon.assert.calledOnce(res.json);
      expect(res.json.firstCall.args[0].status).to.equal('error');
      expect(res.json.firstCall.args[0].data.message).to.include('Error getting public key');
    });

    it('should handle empty request body gracefully', async () => {
      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
      sinon.stub(serviceHelper, 'ensureObject').returns({});
      sinon.stub(messageHelper, 'createErrorMessage').callsFake((msg) => ({
        status: 'error',
        data: { message: msg },
      }));

      await callGetPublicKey(req, res, '');

      sinon.assert.calledOnce(res.json);
      expect(res.json.firstCall.args[0].status).to.equal('error');
    });

    it('should handle malformed JSON in request body', async () => {
      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
      sinon.stub(serviceHelper, 'ensureObject').throws(new Error('Invalid JSON'));
      sinon.stub(messageHelper, 'createErrorMessage').callsFake((msg) => ({
        status: 'error',
        data: { message: msg },
      }));

      await callGetPublicKey(req, res, '{invalid json}');

      sinon.assert.calledOnce(res.json);
      expect(res.json.firstCall.args[0].status).to.equal('error');
    });
  });

  describe('getBlobLocator tests', () => {
    const CALLER = '1CallerZelidXXXXXXXXXXXXXXXXXXXXXXX';
    const OTHER = '1OtherZelidYYYYYYYYYYYYYYYYYYYYYYYY';
    const HASH = `sha256:${'a'.repeat(64)}`;
    const IDENTITY = `b${'a'.repeat(52)}`;
    const MESSAGE_HASH = 'c'.repeat(64);
    // The v9 registration message a caller presents for a name not yet listed.
    const REGISTRATION = {
      type: 'fluxappregister', version: 2, contentHash: 'd'.repeat(64), timestamp: 1_700_000_000_000, extend: true, signature: 'reg-sig',
    };
    let flux;

    before(async function loadLibrary() {
      this.timeout(30_000);
      flux = await loadSpecLibrary();
    });

    // The route's seams: a logged-in arcane caller, the list, a sealed payload
    // that opens to a contentHash, and the derivation. The spec library is real,
    // so the signature payload and the identity are the ones every node builds.
    const stubRoute = ({ listed = null } = {}) => {
      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
      stubRegistry().byName.resolves(listed);
      sinon.stub(specLibs, 'getSpec').resolves(flux);
      sinon.stub(transportHelper, 'openContentEnvelope').resolves(Buffer.from(JSON.stringify({ contentHash: HASH })));
      sinon.stub(contentBlobService, 'deriveLocator').resolves('derived-locator');
      sinon.stub(messageHelper, 'createDataMessage').callsFake((data) => ({ status: 'success', data }));
      sinon.stub(messageHelper, 'createErrorMessage').callsFake((msg) => ({ status: 'error', data: { message: msg } }));
      sinon.stub(messageHelper, 'errUnauthorizedMessage').returns({ status: 'error', data: { code: 401 } });
    };
    const answer = () => res.json.firstCall.args[0];

    it('derives for the listed identity when the caller is the listed owner, whatever the body names', async () => {
      stubRoute({ listed: { owner: CALLER, identity: IDENTITY } });
      req.headers.zelidauth = { zelid: CALLER, signature: 's', loginPhrase: 'p' };
      // The body names a victim fluxID and a registration; neither is read.
      req.body = {
        appName: 'myapp', timestamp: 1_700_000_000, sealed: { algorithm: 'x' }, fluxID: '1VICTIMzelidYYYYYYYYYYYYYYYYYYYYYYY', registration: REGISTRATION,
      };

      await cryptographicKeys.getBlobLocator(req, res);

      expect(contentBlobService.deriveLocator.firstCall.args[1]).to.deep.equal({ identity: IDENTITY, contentHash: HASH });
      expect(answer().status).to.equal('success');
      expect(answer().data).to.deep.equal({ locator: 'derived-locator' });
    });

    it('refuses the listed app to a caller who is not its listed owner, before opening the payload', async () => {
      stubRoute({ listed: { owner: OTHER, identity: IDENTITY } });
      req.headers.zelidauth = { zelid: CALLER };
      req.body = { appName: 'myapp', timestamp: 1_700_000_000, sealed: { algorithm: 'x' } };

      await cryptographicKeys.getBlobLocator(req, res);

      expect(answer().status).to.equal('error');
      expect(answer().data.message).to.include('another owner');
      sinon.assert.notCalled(transportHelper.openContentEnvelope);
      sinon.assert.notCalled(contentBlobService.deriveLocator);
    });

    it('derives for the identity a presented registration makes, once the caller is shown to have signed it', async () => {
      stubRoute();
      const verify = sinon.stub(signatureVerifier, 'verifySignature').resolves(true);
      const hashOf = sinon.stub(appEventVerifier, 'computeOutboundHash').resolves(MESSAGE_HASH);
      req.headers.zelidauth = { zelid: CALLER };
      req.body = {
        appName: 'myapp', timestamp: 1_700_000_000, sealed: { algorithm: 'x' }, registration: REGISTRATION,
      };

      await cryptographicKeys.getBlobLocator(req, res);

      // The signature is checked over the library's v2 payload, for the caller.
      sinon.assert.calledOnceWithExactly(
        verify,
        flux.buildSignaturePayloadV2('fluxappregister', 2, REGISTRATION.contentHash, REGISTRATION.timestamp, true),
        CALLER,
        'reg-sig',
      );
      // The hash is the one every node computes for that message, and the
      // identity is the one the hash makes for the name.
      sinon.assert.calledOnceWithExactly(hashOf, {
        type: 'fluxappregister', envelopeVersion: 2, contentHash: REGISTRATION.contentHash, timestamp: REGISTRATION.timestamp, extend: true, signature: 'reg-sig',
      });
      const expected = flux.appIdentityFromUuid(flux.appUuid('myapp', MESSAGE_HASH));
      expect(contentBlobService.deriveLocator.firstCall.args[1]).to.deep.equal({ identity: expected, contentHash: HASH });
      expect(answer().status).to.equal('success');
    });

    it('refuses a registration the caller did not sign', async () => {
      stubRoute();
      sinon.stub(signatureVerifier, 'verifySignature').resolves(false);
      sinon.stub(appEventVerifier, 'computeOutboundHash').resolves(MESSAGE_HASH);
      req.headers.zelidauth = { zelid: CALLER };
      req.body = {
        appName: 'myapp', timestamp: 1_700_000_000, sealed: { algorithm: 'x' }, registration: REGISTRATION,
      };

      await cryptographicKeys.getBlobLocator(req, res);

      expect(answer().status).to.equal('error');
      expect(answer().data.message).to.include('not signed by the caller');
      sinon.assert.notCalled(contentBlobService.deriveLocator);
    });

    it('refuses an unlisted name with no well-formed v9 registration presented', async () => {
      stubRoute();
      sinon.stub(signatureVerifier, 'verifySignature').resolves(true);
      req.headers.zelidauth = { zelid: CALLER };
      for (const registration of [
        undefined,
        { ...REGISTRATION, type: 'fluxappupdate' },
        { ...REGISTRATION, version: 1 },
        { ...REGISTRATION, extend: 'true' },
        { ...REGISTRATION, signature: '' },
      ]) {
        res.json.resetHistory();
        req.body = {
          appName: 'myapp', timestamp: 1_700_000_000, sealed: { algorithm: 'x' }, registration,
        };
        await cryptographicKeys.getBlobLocator(req, res);
        expect(answer().status, JSON.stringify(registration)).to.equal('error');
        expect(answer().data.message).to.include('not listed');
      }
      sinon.assert.notCalled(contentBlobService.deriveLocator);
    });

    it('opens the sealed payload with the locator AAD ref toward the caller', async () => {
      stubRoute({ listed: { owner: CALLER, identity: IDENTITY } });
      req.headers.zelidauth = { zelid: CALLER };
      req.body = { appName: 'myapp', timestamp: 1_700_000_000, sealed: { algorithm: 'x' } };

      await cryptographicKeys.getBlobLocator(req, res);

      const openArgs = transportHelper.openContentEnvelope.firstCall.args[1];
      expect(openArgs).to.include({
        appName: 'myapp', owner: CALLER, ref: flux.CONTENT_LOCATOR_AAD_REF, timestamp: 1_700_000_000,
      });
    });

    it('returns unauthorized when the user session is invalid', async () => {
      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(false);
      sinon.stub(messageHelper, 'errUnauthorizedMessage').returns({ status: 'error', data: { code: 401 } });
      req.body = { appName: 'a', timestamp: 1, sealed: {} };

      await cryptographicKeys.getBlobLocator(req, res);

      sinon.assert.calledOnce(res.json);
      expect(answer().data.code).to.equal(401);
    });

    it('errors on a non-arcane node', async () => {
      globalState.isArcane.returns(false);
      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
      sinon.stub(messageHelper, 'createErrorMessage').callsFake((msg) => ({ status: 'error', data: { message: msg } }));
      req.body = { appName: 'a', timestamp: 1, sealed: {} };

      await cryptographicKeys.getBlobLocator(req, res);

      expect(answer().status).to.equal('error');
      expect(answer().data.message).to.include('arcane');
    });

    it('rejects a sealed payload that does not carry a valid contentHash', async () => {
      stubRoute({ listed: { owner: CALLER, identity: IDENTITY } });
      transportHelper.openContentEnvelope.resolves(Buffer.from(JSON.stringify({ contentHash: 'not-a-hash' })));
      req.headers.zelidauth = { zelid: CALLER };
      req.body = { appName: 'a', timestamp: 1, sealed: { x: 1 } };

      await cryptographicKeys.getBlobLocator(req, res);

      expect(answer().status).to.equal('error');
      expect(answer().data.message).to.include('sha256');
      sinon.assert.notCalled(contentBlobService.deriveLocator);
    });

    it('errors when required fields are missing', async () => {
      stubRoute({ listed: { owner: CALLER, identity: IDENTITY } });
      req.headers.zelidauth = { zelid: CALLER };
      req.body = { appName: 'a' }; // missing timestamp + sealed

      await cryptographicKeys.getBlobLocator(req, res);

      expect(answer().status).to.equal('error');
      sinon.assert.notCalled(stubRegistry().byName);
    });
  });
});
