'use strict';

const chai = require('chai');
const sinon = require('sinon');

const { Privilege } = require('../../ZelBack/src/services/utils/privileges');
const chaiAsPromised = require('chai-as-promised');
const os = require('os');
const signatureVerifier = require('../../ZelBack/src/services/signatureVerifier');
const proxyquire = require('proxyquire');
const { PassThrough } = require('stream');

const dbHelper = require('../../ZelBack/src/services/dbHelper');
const verificationHelper = require('../../ZelBack/src/services/verificationHelper');
const { requireMongo } = require('./dbTestHelper');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const generalService = require('../../ZelBack/src/services/generalService');
const nodeDosState = require('../../ZelBack/src/services/nodeDosState');
const appInspector = require('../../ZelBack/src/services/appManagement/appInspector');
const syncthingService = require('../../ZelBack/src/services/syncthingService');
const capabilities = require('../../ZelBack/src/services/utils/capabilities');
const specLibs = require('../../ZelBack/src/services/utils/specLibs');

const adminConfig = {
  fluxTeamFluxID: '1zasdfg',
  initial: {
    ipaddress: '83.51.212.243',
    zelid: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC',
    kadena: '1234kadena',
    apiport: '5550',
    testnet: true,
  },
};

const idService = proxyquire(
  '../../ZelBack/src/services/idService',
  { },
);

chai.use(chaiAsPromised);
const { expect } = chai;

// A structurally canonical signature: 65 bytes, P2PKH header 31, low-S. These
// tests are about the login flow, so the verifier's verdict is stubbed at this
// node's own boundary; signature verification is the library's and is tested
// there. The placeholder is still well-formed, so nothing here asserts that
// garbage logs in.
const CANONICAL_SIG = Buffer.concat([Buffer.from([0x1f]), Buffer.alloc(32, 1), Buffer.alloc(32, 1)]).toString('base64');

const generateResponse = () => {
  const res = { test: 'testing' };
  res.status = sinon.stub().returns(res);
  res.json = sinon.fake((param) => `Response: ${param}`);
  res.download = sinon.fake(() => 'File downloaded');
  return res;
};

describe('idService tests', () => {
  // idService reads the node's config off globalThis when it is called.
  beforeEach(() => {
    globalThis.userconfig = adminConfig;
    capabilities.setForTests(['localDbPrepared', 'dockerReachable'], true);
  });

  afterEach(() => {
    capabilities.resetForTests();
  });

  before(requireMongo);

  // Signature verification now consults the canonical-form rule in flux-spec,
  // reached through the CJS bridge. The bridge's first call dynamically imports
  // the ESM packages (~250ms); every call after that is served from its cache.
  // Warm it here so a test measuring a response is not also measuring a
  // one-time module load.
  before(async () => {
    await specLibs.getSpecBackend();
  });

  describe('loginPhrase tests', () => {
    let osTotalmemStub;
    let osCpusStub;
    let collateralTierStub;
    let getDosDataStub;

    before(async () => {
      await dbHelper.initiateDB();
    });

    beforeEach(() => {
      osTotalmemStub = sinon.stub(os, 'totalmem');
      osCpusStub = sinon.stub(os, 'cpus');
      collateralTierStub = sinon.stub(generalService, 'nodeCollateralTier');
      getDosDataStub = sinon.stub(nodeDosState, 'getDosData');
      syncthingService.setSyncthingRunningState(true);
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return error if hw reqs are not met', async () => {
      const res = generateResponse();
      collateralTierStub.resolves({ collateral: 1000, tier: generalService.COLLATERAL_TIERS[1000] });
      osTotalmemStub.returns(1 * 1024 ** 3);
      osCpusStub.returns([1]);
      const expectedResponse = {
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'Node hardware requirements not met',
        },
      };

      await idService.loginPhrase(undefined, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
    });

    it('should return error if dosState > 11 and message is Flux IP detection failed', async () => {
      const res = generateResponse();
      collateralTierStub.resolves({ collateral: 1000, tier: generalService.COLLATERAL_TIERS[1000] });
      osTotalmemStub.returns(8 * 1024 ** 3);
      osCpusStub.returns([1, 1, 1, 1]);
      getDosDataStub.returns({
        dosState: 11,
        dosMessage: 'Flux IP detection failed',
      });

      const expectedResponse = {
        status: 'error',
        data: {
          code: 11,
          name: 'DOS',
          message: 'Flux IP detection failed',
        },
      };

      await idService.loginPhrase(undefined, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
    });

    it('should return error if dosState > 11 and message is Flux collision detection', async () => {
      const res = generateResponse();
      collateralTierStub.resolves({ collateral: 1000, tier: generalService.COLLATERAL_TIERS[1000] });
      osTotalmemStub.returns(8 * 1024 ** 3);
      osCpusStub.returns([1, 1, 1, 1]);
      getDosDataStub.returns({
        dosState: 11,
        dosMessage: 'Flux collision detection. Another ip:port is confirmed on flux network with the same collateral transaction information.',
      });

      const expectedResponse = {
        status: 'error',
        data: {
          code: 11,
          name: 'DOS',
          message: 'Flux collision detection. Another ip:port is confirmed on flux network with the same collateral transaction information.',
        },
      };

      await idService.loginPhrase(undefined, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
    });

    it('should return CONNERROR error if dosState > 11 and message is anything else', async () => {
      const res = generateResponse();
      collateralTierStub.resolves({ collateral: 1000, tier: generalService.COLLATERAL_TIERS[1000] });
      osTotalmemStub.returns(8 * 1024 ** 3);
      osCpusStub.returns([1, 1, 1, 1]);
      getDosDataStub.returns({
        dosState: 11,
        dosMessage: 'test',
      });

      const expectedResponse = {
        status: 'error',
        data: {
          code: 11,
          name: 'CONNERROR',
          message: 'test',
        },
      };

      await idService.loginPhrase(undefined, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
    });

    // The gate is two independent terms, and every case above trips both at
    // once - so either could be deleted without a test noticing. One each.
    //
    // The score-only case is a guard, not a live shape: every site in
    // fluxNetworkHelper that pushes the score past the bar sets a message in the
    // same block, and every reset clears both. It is pinned because that pairing
    // is hand-maintained across twenty-one separate mutations of the score - the
    // module says so itself - and the twenty-second added without a message must
    // still take the node out, rather than reading as healthy.
    it('fails on the dos score alone, even with no message paired to it', async () => {
      const res = generateResponse();
      collateralTierStub.resolves({ collateral: 1000, tier: generalService.COLLATERAL_TIERS[1000] });
      osTotalmemStub.returns(8 * 1024 ** 3);
      osCpusStub.returns([1, 1, 1, 1]);
      getDosDataStub.returns({
        dosState: 11,
        dosMessage: null,
      });

      await idService.loginPhrase(undefined, res);

      // createErrorMessage substitutes its own text for a null message, so a
      // score-only failure reaches the caller as 'Unknown error'.
      sinon.assert.calledOnceWithExactly(res.json, {
        status: 'error',
        data: { code: 11, name: 'CONNERROR', message: 'Unknown error' },
      });
    });

    it('fails on a message alone, with the score still at zero', async () => {
      const res = generateResponse();
      collateralTierStub.resolves({ collateral: 1000, tier: generalService.COLLATERAL_TIERS[1000] });
      osTotalmemStub.returns(8 * 1024 ** 3);
      osCpusStub.returns([1, 1, 1, 1]);
      getDosDataStub.returns({
        dosState: 0,
        dosMessage: 'Flux IP detection failed',
      });

      await idService.loginPhrase(undefined, res);

      sinon.assert.calledOnceWithExactly(res.json, {
        status: 'error',
        data: { code: 0, name: 'DOS', message: 'Flux IP detection failed' },
      });
    });

    it('fails while the apps are denied service', async () => {
      const res = generateResponse();
      collateralTierStub.resolves({ collateral: 1000, tier: generalService.COLLATERAL_TIERS[1000] });
      osTotalmemStub.returns(8 * 1024 ** 3);
      osCpusStub.returns([1, 1, 1, 1]);
      getDosDataStub.returns({ dosState: 0, dosMessage: null });
      sinon.stub(appInspector, 'getAppsDOSState').returns({ dosState: 100, dosMessage: 'apps over their limits' });

      await idService.loginPhrase(undefined, res);

      sinon.assert.calledOnceWithExactly(res.json, {
        status: 'error',
        data: { code: 100, name: 'DOS', message: 'apps over their limits' },
      });
    });

    it('should return write new phrase into the db', async () => {
      const insertintoDBStub = sinon.stub(dbHelper, 'insertOneToDatabase').returns(true);
      await dbHelper.initiateDB();
      dbHelper.databaseConnection();
      const res = generateResponse();
      collateralTierStub.resolves({ collateral: 1000, tier: generalService.COLLATERAL_TIERS[1000] });
      osTotalmemStub.returns(8 * 1024 ** 3);
      osCpusStub.returns([1, 1, 1, 1]);
      getDosDataStub.returns({
        dosState: 0,
        dosMessage: null,
      });

      await idService.loginPhrase(undefined, res);

      sinon.assert.calledOnce(insertintoDBStub);
      sinon.assert.calledOnceWithMatch(res.json, { status: 'success', data: sinon.match.string });
    });
  });

  describe('emergencyPhrase tests', () => {
    afterEach(() => {
      sinon.restore();
    });

    it('should return error if db insert throws error', async () => {
      sinon.stub(dbHelper, 'insertOneToDatabase').throws('DB insert error', 'some message');
      await dbHelper.initiateDB();
      dbHelper.databaseConnection();
      const res = generateResponse();
      const expectedResponse = {
        status: 'error',
        data: {
          code: undefined,
          name: 'DB insert error',
          message: 'some message',
        },
      };

      await idService.emergencyPhrase(undefined, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
    });

    it('should return write new emergency phrase into the db', async () => {
      const insertintoDBStub = sinon.stub(dbHelper, 'insertOneToDatabase').returns(true);
      await dbHelper.initiateDB();
      dbHelper.databaseConnection();
      const res = generateResponse();

      await idService.emergencyPhrase(undefined, res);

      sinon.assert.calledOnce(insertintoDBStub);
      sinon.assert.calledOnceWithMatch(res.json, { status: 'success', data: sinon.match.string });
    });
  });

  describe('verifyLogin tests', () => {
    let verdictStub;

    beforeEach(() => {
      // A successful login defers stripping the signature from the database by
      // a minute. Left real, that timer outlives this file and writes to the
      // database against restored stubs.
      sinon.useFakeTimers({ toFake: ['setTimeout'], shouldAdvanceTime: true });
      verdictStub = sinon.stub(signatureVerifier, 'verifySignature');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return error if neither zelId nor address are specified', async () => {
      const req = {
        signature: CANONICAL_SIG,
        loginPhrase: 'loginphrase',
        message: 'message',
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(req));
      mockStream.end();
      const res = generateResponse();
      const expectedError = {
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'No Flux ID is specified',
        },
      };

      await idService.verifyLogin(mockStream, res);

      sinon.assert.calledOnceWithMatch(res.json, expectedError);
    });

    it('should return error if zelID does not start with 1', async () => {
      const req = {
        zelid: '2Z123434',
        signature: CANONICAL_SIG,
        loginPhrase: 'loginphrase',
        message: 'message',
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(req));
      mockStream.end();
      const res = generateResponse();
      const expectedError = {
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'Flux ID is not valid',
        },
      };

      await idService.verifyLogin(mockStream, res);

      sinon.assert.calledOnceWithMatch(res.json, expectedError);
    });

    it('should return error if zelID is less than 25 chars long', async () => {
      const req = {
        zelid: '1Z123434',
        signature: CANONICAL_SIG,
        loginPhrase: 'loginphrase',
        message: 'message',
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(req));
      mockStream.end();
      const res = generateResponse();
      const expectedError = {
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'Flux ID is not valid',
        },
      };

      await idService.verifyLogin(mockStream, res);

      sinon.assert.calledOnceWithMatch(res.json, expectedError);
    });

    it('should return error if zelID is more than 34 chars long', async () => {
      const req = {
        zelid: '1Z1234341Z1234341Z1234341Z1234341Z12',
        signature: CANONICAL_SIG,
        loginPhrase: 'loginphrase',
        message: 'message',
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(req));
      mockStream.end();
      const res = generateResponse();
      const expectedError = {
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'Flux ID is not valid',
        },
      };

      await idService.verifyLogin(mockStream, res);

      sinon.assert.calledOnceWithMatch(res.json, expectedError);
    });

    it('should return error if the message is empty', async () => {
      const req = {
        zelid: '1Jwh4djGdRPvgLwXNGsGCoPE7uu4vihbEg',
        signature: CANONICAL_SIG,
        message: '',
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(req));
      mockStream.end();
      const res = generateResponse();
      const expectedError = {
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'No message is specified',
        },
      };

      await idService.verifyLogin(mockStream, res);

      sinon.assert.calledOnceWithMatch(res.json, expectedError);
    });

    it('should return error if message is undefined', async () => {
      const req = {
        zelid: '1Jwh4djGdRPvgLwXNGsGCoPE7uu4vihbEg',
        signature: CANONICAL_SIG,
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(req));
      mockStream.end();
      const res = generateResponse();
      const expectedError = {
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'No message is specified',
        },
      };

      await idService.verifyLogin(mockStream, res);

      sinon.assert.calledOnceWithMatch(res.json, expectedError);
    });

    it('should return error if message is less than 40 chars', async () => {
      const req = {
        zelid: '1Jwh4djGdRPvgLwXNGsGCoPE7uu4vihbEg',
        signature: CANONICAL_SIG,
        message: '1234',
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(req));
      mockStream.end();
      const res = generateResponse();
      const expectedError = {
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'Signed message is not valid',
        },
      };

      await idService.verifyLogin(mockStream, res);

      sinon.assert.calledOnceWithMatch(res.json, expectedError);
    });

    it('should return error if message first 13 chars timestamp is too low', async () => {
      const req = {
        zelid: '1Jwh4djGdRPvgLwXNGsGCoPE7uu4vihbEg',
        signature: CANONICAL_SIG,
        message: '111111111111111111111111111111111111111111111',
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(req));
      mockStream.end();
      const res = generateResponse();
      const expectedError = {
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'Signed message is not valid',
        },
      };

      await idService.verifyLogin(mockStream, res);

      sinon.assert.calledOnceWithMatch(res.json, expectedError);
    });

    it('should return error if message first 13 chars timestamp is too high', async () => {
      const req = {
        zelid: '1Jwh4djGdRPvgLwXNGsGCoPE7uu4vihbEg',
        signature: CANONICAL_SIG,
        message: '999999999999911111111111111111111111111111111',
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(req));
      mockStream.end();
      const res = generateResponse();
      const expectedError = {
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'Signed message is not valid',
        },
      };

      await idService.verifyLogin(mockStream, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedError);
    });

    it('should return error if database returns nothing', async () => {
      sinon.stub(dbHelper, 'findOneInDatabase').resolves(null);
      const timestamp = Date.now();
      await dbHelper.initiateDB();
      dbHelper.databaseConnection();
      const req = {
        zelid: '1Jwh4djGdRPvgLwXNGsGCoPE7uu4vihbEg',
        signature: CANONICAL_SIG,
        message: `${timestamp - 300_000}11111111111111111111111111111`,
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(req));
      mockStream.end();
      const res = generateResponse();
      const expectedError = {
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'Signed message is no longer valid. Please request a new one.',
        },
      };

      await idService.verifyLogin(mockStream, res);
      await serviceHelper.delay(100);

      sinon.assert.calledOnceWithExactly(res.json, expectedError);
    });

    it('should return error if signature in database is invalid', async () => {
      const timestamp = Date.now();
      sinon.stub(dbHelper, 'findOneInDatabase').resolves({
        loginPhrase: `${timestamp + 10_000}11111111111111111111111111111`,
      });
      await dbHelper.initiateDB();
      dbHelper.databaseConnection();
      const req = {
        zelid: '1Jwh4djGdRPvgLwXNGsGCoPE7uu4vihbEg',
        signature: CANONICAL_SIG,
        message: `${timestamp - 300_000}11111111111111111111111111111`,
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(req));
      mockStream.end();
      const res = generateResponse();
      const expectedError = {
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'Signed message is no longer valid. Please request a new one.',
        },
      };

      await idService.verifyLogin(mockStream, res);
      await serviceHelper.delay(100);

      sinon.assert.calledOnceWithExactly(res.json, expectedError);
    });

    it('should return error if signature verification failed', async () => {
      verdictStub.resolves(false);
      const timestamp = Date.now();
      sinon.stub(dbHelper, 'findOneInDatabase').resolves({
        loginPhrase: `${timestamp - 10_000}11111111111111111111111111111`,
      });
      await dbHelper.initiateDB();
      dbHelper.databaseConnection();
      const req = {
        zelid: '1Jwh4djGdRPvgLwXNGsGCoPE7uu4vihbEg',
        signature: CANONICAL_SIG,
        message: `${timestamp - 300_000}11111111111111111111111111111`,
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(req));
      mockStream.end();
      const res = generateResponse();
      const expectedError = {
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'Invalid signature',
        },
      };

      await idService.verifyLogin(mockStream, res);
      await serviceHelper.delay(100);

      sinon.assert.calledOnceWithExactly(res.json, expectedError);
    });

    it('should return success message if everything is okay', async () => {
      verdictStub.resolves(true);
      const timestamp = Date.now();
      sinon.stub(dbHelper, 'findOneInDatabase').resolves({
        loginPhrase: `${timestamp - 10_000}11111111111111111111111111111`,
      });
      sinon.stub(dbHelper, 'findOneAndUpdateInDatabase').resolves({ usedAt: new Date() });
      sinon.stub(dbHelper, 'insertOneToDatabase').resolves(true);
      await dbHelper.initiateDB();
      dbHelper.databaseConnection();
      const req = {
        zelid: '1Jwh4djGdRPvgLwXNGsGCoPE7uu4vihbEg',
        signature: CANONICAL_SIG,
        message: `${timestamp - 300_000}11111111111111111111111111111`,
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(req));
      mockStream.end();
      const res = generateResponse();
      const expectedError = {
        status: 'success',
        data: {
          message: 'Successfully logged in',
          zelid: '1Jwh4djGdRPvgLwXNGsGCoPE7uu4vihbEg',
          loginPhrase: sinon.match.string,
          signature: CANONICAL_SIG,
          privilage: 'user',
        },
      };

      await idService.verifyLogin(mockStream, res);
      await serviceHelper.delay(100);

      sinon.assert.calledOnceWithMatch(res.json, expectedError);
    });
  });

  describe('provideSign tests', () => {
    let verdictStub;

    beforeEach(() => {
      verdictStub = sinon.stub(signatureVerifier, 'verifySignature');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return error if neither zelId nor address are specified', async () => {
      const req = {
        signature: CANONICAL_SIG,
        loginPhrase: 'loginphrase',
        message: 'message',
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(req));
      mockStream.end();
      const res = generateResponse();
      const expectedError = {
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'No Flux ID is specified',
        },
      };

      await idService.provideSign(mockStream, res);

      sinon.assert.calledOnceWithMatch(res.json, expectedError);
    });

    it('should return error if zelID does not start with 1', async () => {
      const req = {
        zelid: '2Z123434',
        signature: CANONICAL_SIG,
        loginPhrase: 'loginphrase',
        message: 'message',
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(req));
      mockStream.end();
      const res = generateResponse();
      const expectedError = {
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'Flux ID is not valid',
        },
      };

      await idService.provideSign(mockStream, res);

      sinon.assert.calledOnceWithMatch(res.json, expectedError);
    });

    it('should return error if zelID is less than 25 chars long', async () => {
      const req = {
        zelid: '1Z123434',
        signature: CANONICAL_SIG,
        loginPhrase: 'loginphrase',
        message: 'message',
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(req));
      mockStream.end();
      const res = generateResponse();
      const expectedError = {
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'Flux ID is not valid',
        },
      };

      await idService.provideSign(mockStream, res);

      sinon.assert.calledOnceWithMatch(res.json, expectedError);
    });

    it('should return error if zelID is more than 34 chars long', async () => {
      const req = {
        zelid: '1Z1234341Z1234341Z1234341Z1234341Z12',
        signature: CANONICAL_SIG,
        loginPhrase: 'loginphrase',
        message: 'message',
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(req));
      mockStream.end();
      const res = generateResponse();
      const expectedError = {
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'Flux ID is not valid',
        },
      };

      await idService.provideSign(mockStream, res);

      sinon.assert.calledOnceWithMatch(res.json, expectedError);
    });

    it('should return error if the message is empty', async () => {
      const req = {
        zelid: '1Jwh4djGdRPvgLwXNGsGCoPE7uu4vihbEg',
        signature: CANONICAL_SIG,
        message: '',
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(req));
      mockStream.end();
      const res = generateResponse();
      const expectedError = {
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'No message is specified',
        },
      };

      await idService.provideSign(mockStream, res);

      sinon.assert.calledOnceWithMatch(res.json, expectedError);
    });

    it('should return error if message is undefined', async () => {
      const req = {
        zelid: '1Jwh4djGdRPvgLwXNGsGCoPE7uu4vihbEg',
        signature: CANONICAL_SIG,
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(req));
      mockStream.end();
      const res = generateResponse();
      const expectedError = {
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'No message is specified',
        },
      };

      await idService.provideSign(mockStream, res);

      sinon.assert.calledOnceWithMatch(res.json, expectedError);
    });

    it('should return error if message is less than 40 chars', async () => {
      const req = {
        zelid: '1Jwh4djGdRPvgLwXNGsGCoPE7uu4vihbEg',
        signature: CANONICAL_SIG,
        message: '1234',
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(req));
      mockStream.end();
      const res = generateResponse();
      const expectedError = {
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'Signed message is not valid',
        },
      };

      await idService.provideSign(mockStream, res);

      sinon.assert.calledOnceWithMatch(res.json, expectedError);
    });

    it('should return success message if everything is okay', async () => {
      verdictStub.resolves(true);
      const timestamp = Date.now();
      sinon.stub(dbHelper, 'findOneInDatabase').resolves({
        loginPhrase: `${timestamp - 10_000}11111111111111111111111111111`,
      });
      sinon.stub(dbHelper, 'insertOneToDatabase').resolves(true);
      await dbHelper.initiateDB();
      dbHelper.databaseConnection();
      const req = {
        zelid: '1Jwh4djGdRPvgLwXNGsGCoPE7uu4vihbEg',
        signature: CANONICAL_SIG,
        message: `${timestamp - 300_000}11111111111111111111111111111`,
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(req));
      mockStream.end();
      const res = generateResponse();
      const expectedError = {
        status: 'success',
        data: {
          identifier: '1Jwh4djGdRPvgLwXNGsGCoPE7uu4vihbEg1111111111111',
          signature: CANONICAL_SIG,
        },
      };

      await idService.provideSign(mockStream, res);
      await serviceHelper.delay(100);

      sinon.assert.calledOnceWithMatch(res.json, expectedError);
    });
  });

  describe('loggedUsers tests', () => {
    let verifyPrivilegeStub;

    beforeEach(() => {
      verifyPrivilegeStub = sinon.stub(verificationHelper, 'verifyPrivilege');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return error when unauthorized ', async () => {
      const res = generateResponse();
      verifyPrivilegeStub.returns(false);
      const expectedResponse = {
        data: {
          code: 401,
          message: 'Unauthorized. Access denied.',
          name: 'Unauthorized',
        },
        status: 'error',
      };
      await idService.loggedUsers(undefined, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
    });

    it('should return the found item from DB', async () => {
      verifyPrivilegeStub.returns(true);
      const dbStub = sinon.stub(dbHelper, 'findInDatabase').resolves('item found');
      await dbHelper.initiateDB();
      dbHelper.databaseConnection();
      const res = generateResponse();

      await idService.loggedUsers(undefined, res);

      sinon.assert.calledOnceWithExactly(res.json, { status: 'success', data: 'item found' });
      sinon.assert.calledOnce(dbStub);
    });
  });

  describe('loggedSessions tests', () => {
    let verifyPrivilegeStub;

    beforeEach(() => {
      verifyPrivilegeStub = sinon.stub(verificationHelper, 'verifyPrivilege');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return error when unauthorized ', async () => {
      const res = generateResponse();
      verifyPrivilegeStub.returns(false);
      const expectedResponse = {
        data: {
          code: 401,
          message: 'Unauthorized. Access denied.',
          name: 'Unauthorized',
        },
        status: 'error',
      };
      await idService.loggedSessions(undefined, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
    });

    it('should return the found item from DB', async () => {
      verifyPrivilegeStub.returns(true);
      const dbStub = sinon.stub(dbHelper, 'findInDatabase').resolves('item found');
      await dbHelper.initiateDB();
      dbHelper.databaseConnection();
      const res = generateResponse();
      const req = {
        headers: {
          zelidauth: 'zelidauth',
        },
      };

      await idService.loggedSessions(req, res);

      sinon.assert.calledOnceWithExactly(res.json, { status: 'success', data: 'item found' });
      sinon.assert.calledOnce(dbStub);
    });
  });

  describe('logoutCurrentSession tests', () => {
    let verifyPrivilegeStub;

    beforeEach(() => {
      verifyPrivilegeStub = sinon.stub(verificationHelper, 'verifyPrivilege');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return error when unauthorized ', async () => {
      const res = generateResponse();
      verifyPrivilegeStub.returns(false);
      const expectedResponse = {
        data: {
          code: 401,
          message: 'Unauthorized. Access denied.',
          name: 'Unauthorized',
        },
        status: 'error',
      };
      await idService.logoutCurrentSession(undefined, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
    });

    it('should return the found item from DB', async () => {
      verifyPrivilegeStub.returns(true);
      const dbStub = sinon.stub(dbHelper, 'findOneAndDeleteInDatabase').resolves('item removed');
      await dbHelper.initiateDB();
      dbHelper.databaseConnection();
      const res = generateResponse();
      const req = {
        headers: {
          zelidauth: 'zelidauth',
        },
      };

      await idService.logoutCurrentSession(req, res);

      sinon.assert.calledOnceWithExactly(res.json, {
        status: 'success',
        data: {
          code: undefined,
          name: undefined,
          message: 'Successfully logged out',
        },
      });
      sinon.assert.calledOnce(dbStub);
    });
  });

  describe('logoutAllSessions tests', () => {
    let verifyPrivilegeStub;

    beforeEach(() => {
      verifyPrivilegeStub = sinon.stub(verificationHelper, 'verifyPrivilege');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return error when unauthorized ', async () => {
      const res = generateResponse();
      verifyPrivilegeStub.returns(false);
      const expectedResponse = {
        data: {
          code: 401,
          message: 'Unauthorized. Access denied.',
          name: 'Unauthorized',
        },
        status: 'error',
      };
      await idService.logoutAllSessions(undefined, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
    });

    it('should return the found item from DB', async () => {
      verifyPrivilegeStub.returns(true);
      const dbStub = sinon.stub(dbHelper, 'removeDocumentsFromCollection').resolves('doc removed');
      await dbHelper.initiateDB();
      dbHelper.databaseConnection();
      const res = generateResponse();
      const req = {
        headers: {
          zelidauth: 'zelidauth',
        },
      };

      await idService.logoutAllSessions(req, res);

      sinon.assert.calledOnceWithExactly(res.json, {
        status: 'success',
        data: {
          code: undefined,
          name: undefined,
          message: 'Successfully logged out all sessions',
        },
      });
      sinon.assert.calledOnce(dbStub);
    });
  });

  describe('wsRespondLoginPhrase tests', () => {
    const generateWebsocket = () => {
      const ws = {};
      ws.send = sinon.stub().returns('okay');
      ws.close = sinon.stub().returns('okay');
      return ws;
    };
    let dbStub;

    beforeEach(async () => {
      dbStub = sinon.stub(dbHelper, 'findOneInDatabase');
      await dbHelper.initiateDB();
      dbHelper.databaseConnection();
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return error if db rejects promise', async () => {
      dbStub.rejects('myerrromessage');
      const ws = generateWebsocket();
      const req = {
        params: {
          loginphrase: '12345',
        },
      };

      await idService.wsRespondLoginPhrase(ws, req);

      sinon.assert.calledOnceWithExactly(ws.send, 'status=error&data%5Bname%5D=myerrromessage&data%5Bmessage%5D=Unknown%20error');
    });

    it('should return proper message if user is fluxTeamFluxID', async () => {
      dbStub.resolves({
        zelid: adminConfig.fluxTeamFluxID,
        loginPhrase: '12333345656',
        signature: 'signature1',
        createdAt: '168450311',
        expireAt: '168460311',
      });
      const ws = generateWebsocket();
      const req = {
        params: {
          loginphrase: '12345',
        },
      };

      await idService.wsRespondLoginPhrase(ws, req);
      await serviceHelper.delay(150);

      sinon.assert.calledOnceWithExactly(ws.send, 'status=success&data%5Bmessage%5D=Successfully%20logged%20in&data%5Bzelid%5D=1zasdfg&data%5BloginPhrase%5D=12333345656&data%5Bsignature%5D=signature1&data%5Bprivilage%5D=user&data%5BcreatedAt%5D=168450311&data%5BexpireAt%5D=168460311');
    });

    it('should return proper message if user is admin', async () => {
      dbStub.resolves({
        zelid: adminConfig.initial.zelid,
        loginPhrase: '12333345656',
        signature: 'signature1',
        createdAt: '168450311',
        expireAt: '168460311',
      });
      const ws = generateWebsocket();
      const req = {
        params: {
          loginphrase: '12345',
        },
      };

      await idService.wsRespondLoginPhrase(ws, req);
      await serviceHelper.delay(150);

      sinon.assert.calledOnceWithExactly(
        ws.send,
        'status=success&data%5Bmessage%5D=Successfully%20logged%20in&data%5Bzelid%5D=1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC&data%5BloginPhrase%5D=12333345656&data%5Bsignature%5D=signature1&data%5Bprivilage%5D=admin&data%5BcreatedAt%5D=168450311&data%5BexpireAt%5D=168460311',
      );
    });

    it('should return error message if 2nd db call throws error', async () => {
      dbStub.onCall(0).resolves(null);
      dbStub.onCall(1).rejects('error message');
      const ws = generateWebsocket();
      const req = {
        params: {
          loginphrase: '12345',
        },
      };

      await idService.wsRespondLoginPhrase(ws, req);
      await serviceHelper.delay(150);

      sinon.assert.calledOnceWithExactly(
        ws.send,
        'status=error&data%5Bname%5D=error%20message&data%5Bmessage%5D=Unknown%20error',
      );
    });
  });

  describe('wsRespondSignature tests', () => {
    const generateWebsocket = () => {
      const ws = {};
      ws.send = sinon.stub().returns('okay');
      ws.close = sinon.stub().returns('okay');
      return ws;
    };
    let dbStub;

    beforeEach(async () => {
      dbStub = sinon.stub(dbHelper, 'findOneInDatabase');
      await dbHelper.initiateDB();
      dbHelper.databaseConnection();
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return error if db rejects promise', async () => {
      dbStub.rejects('myerrromessage');
      const ws = generateWebsocket();
      const req = {
        params: {
          message: 'message',
        },
      };

      await idService.wsRespondSignature(ws, req);

      sinon.assert.calledOnceWithExactly(ws.send, 'status=error&data%5Bname%5D=myerrromessage&data%5Bmessage%5D=Unknown%20error');
    });

    it('should return proper message if user is fluxTeamFluxID', async () => {
      dbStub.resolves('found');
      const ws = generateWebsocket();
      const req = {
        params: {
          message: 'message',
        },
      };

      await idService.wsRespondSignature(ws, req);
      await serviceHelper.delay(150);

      sinon.assert.calledOnceWithExactly(ws.send, 'status=success&data=found');
    });
  });

  // The four strings /id/checkprivilege answers. The frontend branches on these
  // in fourteen places and is deployed separately, so changing one here breaks
  // login, navigation, app management and checkout in a repo this one cannot
  // see. Pinned by value deliberately: the point is that they do not move.
  describe('the privilege vocabulary on the wire', () => {
    it('answers exactly the four tokens the frontend reads', () => {
      expect(idService.PRIVILEGE_RESPONSE).to.deep.equal({
        NODE_OPERATOR: 'admin',
        FLUX_TEAM: 'fluxteam',
        USER: 'user',
        NONE: 'none',
      });
    });

    it('is not the enum a route requires internally - the two are free to diverge', () => {
      // NODE_OPERATOR is the same string on both sides today, and nothing keeps
      // it that way. Reading one from the other is what would couple them.
      expect(Object.values(idService.PRIVILEGE_RESPONSE)).to.include(Privilege.NODE_OPERATOR);
      expect(Object.values(Privilege)).to.not.include(idService.PRIVILEGE_RESPONSE.NONE);
    });
  });

  describe('checkLoggedUser tests', () => {
    let verifyPrivilegeStub;

    beforeEach(async () => {
      verifyPrivilegeStub = sinon.stub(verificationHelper, 'verifyPrivilege');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should answer none, not the thrown text, if no zelid parameter is passed', async () => {
      const res = generateResponse();
      const params = {
        loginPhrase: 'phrase',
        signature: 'signature',
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(params));
      mockStream.end();

      await idService.checkLoggedUser(mockStream, res);
      await serviceHelper.delay(150);

      sinon.assert.calledOnceWithExactly(res.json, {
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'none',
        },
      });
    });

    it('should answer none, not the thrown text, if no loggedPhrase parameter is passed', async () => {
      const res = generateResponse();
      const params = {
        zelid: '1zel12343434',
        signature: 'signature',
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(params));
      mockStream.end();

      await idService.checkLoggedUser(mockStream, res);
      await serviceHelper.delay(150);

      sinon.assert.calledOnceWithExactly(res.json, {
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'none',
        },
      });
    });

    it('should answer none, not the thrown text, if no signature parameter is passed', async () => {
      const res = generateResponse();
      const params = {
        zelid: '1zel12343434',
        loginPhrase: 'loginphrase',
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(params));
      mockStream.end();

      await idService.checkLoggedUser(mockStream, res);
      await serviceHelper.delay(150);

      sinon.assert.calledOnceWithExactly(res.json, {
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'none',
        },
      });
    });

    it('should return peroper success message if user is an admin', async () => {
      verifyPrivilegeStub.withArgs(Privilege.NODE_OPERATOR, sinon.match.string).returns(true);
      const res = generateResponse();
      const params = {
        zelid: '1zel12343434',
        loginPhrase: 'loginphrase',
        signature: 'signature',
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(params));
      mockStream.end();

      await idService.checkLoggedUser(mockStream, res);
      await serviceHelper.delay(150);

      sinon.assert.calledOnceWithExactly(res.json, {
        status: 'success',
        data: { code: undefined, name: undefined, message: 'admin' },
      });
    });

    it('should return peroper success message if user is fluxteam', async () => {
      verifyPrivilegeStub.withArgs(Privilege.NODE_OPERATOR, sinon.match.string).returns(false);
      verifyPrivilegeStub.withArgs(Privilege.FLUX_TEAM, sinon.match.string).returns(true);
      const res = generateResponse();
      const params = {
        zelid: '1zel12343434',
        loginPhrase: 'loginphrase',
        signature: 'signature',
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(params));
      mockStream.end();

      await idService.checkLoggedUser(mockStream, res);
      await serviceHelper.delay(150);

      sinon.assert.calledOnceWithExactly(res.json, {
        status: 'success',
        data: { code: undefined, name: undefined, message: 'fluxteam' },
      });
    });

    it('should return peroper success message if user is an ordinary user', async () => {
      verifyPrivilegeStub.withArgs(Privilege.NODE_OPERATOR, sinon.match.string).returns(false);
      verifyPrivilegeStub.withArgs(Privilege.FLUX_TEAM, sinon.match.string).returns(false);
      verifyPrivilegeStub.withArgs(Privilege.USER, sinon.match.string).returns(true);
      const res = generateResponse();
      const params = {
        zelid: '1zel12343434',
        loginPhrase: 'loginphrase',
        signature: 'signature',
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(params));
      mockStream.end();

      await idService.checkLoggedUser(mockStream, res);
      await serviceHelper.delay(150);

      sinon.assert.calledOnceWithExactly(res.json, {
        status: 'success',
        data: { code: undefined, name: undefined, message: 'user' },
      });
    });

    it('should answer none when the privilege check itself throws, so the session is cleared', async () => {
      verifyPrivilegeStub.throws(new Error('database unavailable'));
      const res = generateResponse();
      const params = {
        zelid: '1zel12343434',
        loginPhrase: 'loginphrase',
        signature: 'signature',
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(params));
      mockStream.end();

      await idService.checkLoggedUser(mockStream, res);
      await serviceHelper.delay(150);

      // 'none' is the only value that makes the frontend drop zelidauth, and a
      // thrown error is exactly when the session should end. `name` is what
      // still separates this from the refusal below, which carries none.
      sinon.assert.calledOnceWithExactly(res.json, {
        status: 'error',
        data: { code: undefined, name: 'Error', message: 'none' },
      });
    });

    it('should return error message if user has no privileges', async () => {
      verifyPrivilegeStub.withArgs(Privilege.NODE_OPERATOR, sinon.match.string).returns(false);
      verifyPrivilegeStub.withArgs(Privilege.FLUX_TEAM, sinon.match.string).returns(false);
      verifyPrivilegeStub.withArgs(Privilege.USER, sinon.match.string).returns(false);
      const res = generateResponse();
      const params = {
        zelid: '1zel12343434',
        loginPhrase: 'loginphrase',
        signature: 'signature',
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(params));
      mockStream.end();

      await idService.checkLoggedUser(mockStream, res);
      await serviceHelper.delay(150);

      sinon.assert.calledOnceWithExactly(res.json, {
        status: 'error',
        data: { code: undefined, name: undefined, message: 'none' },
      });
    });
  });
});
