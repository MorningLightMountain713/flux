const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { Readable, Writable } = require('node:stream');
const zlib = require('node:zlib');

const tar = require('tar/create');

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');

chai.use(chaiAsPromised);
const { expect } = chai;

const sinon = require('sinon');
const proxyquire = require('proxyquire');

const verificationHelper = require('../../ZelBack/src/services/verificationHelper');
const benchmarkService = require('../../ZelBack/src/services/benchmarkService');
const explorerService = require('../../ZelBack/src/services/explorerService');
const generalService = require('../../ZelBack/src/services/generalService');
const fluxCommunication = require('../../ZelBack/src/services/fluxCommunication');
const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
const appInspector = require('../../ZelBack/src/services/appManagement/appInspector');
const appQueryService = require('../../ZelBack/src/services/appQuery/appQueryService');
const resourceQueryService = require('../../ZelBack/src/services/appQuery/resourceQueryService');
const registryManager = require('../../ZelBack/src/services/appDatabase/registryManager');
const daemonServiceControlRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceControlRpcs');
// eslint-disable-next-line no-unused-vars
const daemonServiceBenchmarkRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceBenchmarkRpcs');
const daemonServiceFluxnodeRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceFluxnodeRpcs');
const daemonServiceUtils = require('../../ZelBack/src/services/daemonService/daemonServiceUtils');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const logLib = require('../../ZelBack/src/lib/log');
const syncthingService = require('../../ZelBack/src/services/syncthingService');
const geolocationService = require('../../ZelBack/src/services/geolocationService');
const enterpriseConfig = require('../../ZelBack/src/services/utils/enterpriseConfig');
const packageJson = require('../../package.json');

// Mock adminConfig for consistent testing
const adminConfig = {
  initial: {
    ipaddress: '127.0.0.1',
    zelid: '1K6nyw2VjV6jEN1f1CkbKn9htWnYkQabbR',
    kadena: 'kadena:k:b3d922d1a57793651a1e0d951ef1671a10833e170810d3520388628cdc082fce?chainid=0',
    testnet: false,
    development: false,
    apiport: 16127,
    routerIP: '',
    pgpPrivateKey: '',
    pgpPublicKey: '',
    blockedPorts: [],
    blockedRepositories: [],
  },
};

// Create shared fs promises stubs for proxyquire
const fsPromisesStubs = {
  access: sinon.stub().resolves(), // Always resolve successfully
  writeFile: sinon.stub().resolves(), // Shared writeFile stub
};

const fluxService = proxyquire(
  '../../ZelBack/src/services/fluxService',
  {
    '../../../config/userconfig': adminConfig,
    'node:fs/promises': fsPromisesStubs,
  },
);

const generateResponse = () => {
  const res = { test: 'testing' };
  res.status = sinon.stub().returns(res);
  res.json = sinon.fake((param) => `Response: ${param}`);
  res.download = sinon.fake(() => 'File downloaded');
  res.attachment = sinon.stub();
  res.send = sinon.fake(() => 'Sent');
  res.end = sinon.stub();
  return res;
};

describe('fluxService tests', () => {
  describe('fluxBackendFolder tests', () => {
    afterEach(() => {
      sinon.restore();
    });

    it('should return a proper folder path', async () => {
      const res = generateResponse();
      const fluxBackFolder = path.join(__dirname, '../../ZelBack/');
      const expectedResponse = {
        status: 'success',
        data: fluxBackFolder,
      };

      const response = await fluxService.fluxBackendFolder(undefined, res);

      expect(response).to.eql(`Response: ${expectedResponse}`);
      sinon.assert.calledWithExactly(res.json, expectedResponse);
    });
  });

  describe('updateFlux tests', () => {
    let verifyPrivilegeStub;
    let runCmdStub;

    beforeEach(() => {
      verifyPrivilegeStub = sinon.stub(verificationHelper, 'verifyPrivilege');
      runCmdStub = sinon.stub(serviceHelper, 'runCommand');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should throw error if user is not an admin or flux team', async () => {
      verifyPrivilegeStub.returns(false);
      const res = generateResponse();
      const expectedResponse = {
        data: {
          code: 401,
          message: 'Unauthorized. Access denied.',
          name: 'Unauthorized',
        },
        status: 'error',
      };

      const response = await fluxService.updateFlux(undefined, res);

      expect(response).to.eql(`Response: ${expectedResponse}`);
      sinon.assert.calledWithExactly(res.json, expectedResponse);
    });

    it('should return success message if cmd exec does not return error', async () => {
      verifyPrivilegeStub.returns(true);
      runCmdStub.resolves({ error: null });
      const nodedpath = path.join(__dirname, '../../');

      const expectedResponse = {
        data: {
          code: undefined,
          message: 'Flux successfully updated',
          name: undefined,
        },
        status: 'success',
      };
      const res = generateResponse();

      await fluxService.updateFlux(undefined, res);
      await serviceHelper.delay(200);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
      sinon.assert.calledWithMatch(runCmdStub, 'npm', { cwd: nodedpath, params: ['run', 'updateflux'] });
    });

    it('should return error if cmd exec throws error', async () => {
      verifyPrivilegeStub.returns(true);
      runCmdStub.resolves({
        error: {
          message: 'This is an error',
          code: 403,
          name: 'testing error',
        },
      });
      const nodedpath = path.join(__dirname, '../../');

      const expectedResponse = {
        data: {
          code: 403,
          message: 'Error updating Flux: This is an error',
          name: 'testing error',
        },
        status: 'error',
      };
      const res = generateResponse();

      await fluxService.updateFlux(undefined, res);
      await serviceHelper.delay(200);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
      sinon.assert.calledWithExactly(runCmdStub, 'npm', { cwd: nodedpath, params: ['run', 'updateflux'] });
    });
  });

  describe('softUpdateFlux tests', () => {
    let verifyPrivilegeStub;
    let runCmdStub;

    beforeEach(() => {
      verifyPrivilegeStub = sinon.stub(verificationHelper, 'verifyPrivilege');
      runCmdStub = sinon.stub(serviceHelper, 'runCommand');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should throw error if user is not an admin or flux team', async () => {
      verifyPrivilegeStub.returns(false);
      const res = generateResponse();
      const expectedResponse = {
        data: {
          code: 401,
          message: 'Unauthorized. Access denied.',
          name: 'Unauthorized',
        },
        status: 'error',
      };
      const req = {};

      const response = await fluxService.softUpdateFlux(req, res);

      expect(response).to.eql(`Response: ${expectedResponse}`);
      sinon.assert.calledWithExactly(res.json, expectedResponse);
    });

    it('should return success message if cmd exec does not return error', async () => {
      verifyPrivilegeStub.returns(true);
      runCmdStub.resolves({ error: null });
      const nodedpath = path.join(__dirname, '../../');

      const expectedResponse = {
        data: {
          code: undefined,
          message: 'Flux successfully soft updated',
          name: undefined,
        },
        status: 'success',
      };
      const res = generateResponse();

      await fluxService.softUpdateFlux(undefined, res);
      await serviceHelper.delay(200);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
      sinon.assert.calledWithExactly(runCmdStub, 'npm', { cwd: nodedpath, params: ['run', 'softupdate'] });
    });

    it('should return error if cmd exec throws error ', async () => {
      verifyPrivilegeStub.returns(true);
      runCmdStub.resolves({
        error: {
          message: 'This is an error',
          code: 403,
          name: 'testing error',
        },
      });
      const nodedpath = path.join(__dirname, '../../');

      const expectedResponse = {
        data: {
          code: 403,
          message: 'Error soft updating Flux: This is an error',
          name: 'testing error',
        },
        status: 'error',
      };
      const res = generateResponse();

      await fluxService.softUpdateFlux(undefined, res);
      await serviceHelper.delay(200);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
      sinon.assert.calledWithExactly(runCmdStub, 'npm', { cwd: nodedpath, params: ['run', 'softupdate'] });
    });
  });

  describe('softUpdateFluxInstall tests', () => {
    let verifyPrivilegeStub;
    let runCmdStub;

    beforeEach(() => {
      verifyPrivilegeStub = sinon.stub(verificationHelper, 'verifyPrivilege');
      runCmdStub = sinon.stub(serviceHelper, 'runCommand');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should throw error if user is not an admin or flux team', async () => {
      verifyPrivilegeStub.returns(false);
      const res = generateResponse();
      const expectedResponse = {
        data: {
          code: 401,
          message: 'Unauthorized. Access denied.',
          name: 'Unauthorized',
        },
        status: 'error',
      };

      const response = await fluxService.softUpdateFluxInstall({}, res);

      expect(response).to.eql(`Response: ${expectedResponse}`);
      sinon.assert.calledWithExactly(res.json, expectedResponse);
    });

    it('should return success message if cmd exec does not return error', async () => {
      verifyPrivilegeStub.returns(true);
      runCmdStub.resolves({ error: null });
      const nodedpath = path.join(__dirname, '../../');

      const expectedResponse = {
        data: {
          code: undefined,
          message: 'Flux successfully soft updated with installation',
          name: undefined,
        },
        status: 'success',
      };
      const res = generateResponse();

      await fluxService.softUpdateFluxInstall(undefined, res);
      await serviceHelper.delay(200);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
      sinon.assert.calledWithExactly(runCmdStub, 'npm', { cwd: nodedpath, params: ['run', 'softupdateinstall'] });
    });

    it('should return error if cmd exec throws error ', async () => {
      verifyPrivilegeStub.returns(true);
      runCmdStub.resolves({
        error: {
          message: 'This is an error',
          code: 403,
          name: 'testing error',
        },
      });
      const nodedpath = path.join(__dirname, '../../');

      const expectedResponse = {
        data: {
          code: 403,
          message: 'Error soft updating Flux with installation: This is an error',
          name: 'testing error',
        },
        status: 'error',
      };
      const res = generateResponse();

      await fluxService.softUpdateFluxInstall(undefined, res);
      await serviceHelper.delay(200);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
      sinon.assert.calledWithExactly(runCmdStub, 'npm', { cwd: nodedpath, params: ['run', 'softupdateinstall'] });
    });
  });

  describe('hardUpdateFlux tests', () => {
    let verifyPrivilegeStub;
    let runCmdStub;

    beforeEach(() => {
      verifyPrivilegeStub = sinon.stub(verificationHelper, 'verifyPrivilege');
      runCmdStub = sinon.stub(serviceHelper, 'runCommand');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should throw error if user is not an admin or flux team', async () => {
      verifyPrivilegeStub.returns(false);
      const res = generateResponse();
      const expectedResponse = {
        data: {
          code: 401,
          message: 'Unauthorized. Access denied.',
          name: 'Unauthorized',
        },
        status: 'error',
      };

      const response = await fluxService.hardUpdateFlux(undefined, res);

      expect(response).to.eql(`Response: ${expectedResponse}`);
      sinon.assert.calledWithExactly(res.json, expectedResponse);
    });

    it('should return success message if cmd exec does not return error', async () => {
      verifyPrivilegeStub.returns(true);
      runCmdStub.resolves({ error: null });
      const nodedpath = path.join(__dirname, '../../');

      const expectedResponse = {
        data: {
          code: undefined,
          message: 'Flux successfully hard updated',
          name: undefined,
        },
        status: 'success',
      };
      const res = generateResponse();

      await fluxService.hardUpdateFlux(undefined, res);
      await serviceHelper.delay(200);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
      sinon.assert.calledWithExactly(runCmdStub, 'npm', { cwd: nodedpath, params: ['run', 'hardupdateflux'] });
    });

    it('should return error if cmd exec throws error ', async () => {
      verifyPrivilegeStub.returns(true);
      runCmdStub.resolves({
        error: {
          message: 'This is an error',
          code: 403,
          name: 'testing error',
        },
      });
      const nodedpath = path.join(__dirname, '../../');

      const expectedResponse = {
        data: {
          code: 403,
          message: 'Error hard updating Flux: This is an error',
          name: 'testing error',
        },
        status: 'error',
      };
      const res = generateResponse();

      await fluxService.hardUpdateFlux(undefined, res);
      await serviceHelper.delay(200);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
      sinon.assert.calledWithExactly(runCmdStub, 'npm', { cwd: nodedpath, params: ['run', 'hardupdateflux'] });
    });
  });

  describe('rebuildHome tests', () => {
    let verifyPrivilegeStub;
    let runCmdStub;

    beforeEach(() => {
      verifyPrivilegeStub = sinon.stub(verificationHelper, 'verifyPrivilege');
      runCmdStub = sinon.stub(serviceHelper, 'runCommand');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should throw error if user is not an admin or flux team', async () => {
      verifyPrivilegeStub.returns(false);
      const res = generateResponse();
      const expectedResponse = {
        data: {
          code: 401,
          message: 'Unauthorized. Access denied.',
          name: 'Unauthorized',
        },
        status: 'error',
      };

      const response = await fluxService.rebuildHome(undefined, res);

      expect(response).to.eql(`Response: ${expectedResponse}`);
      sinon.assert.calledWithExactly(res.json, expectedResponse);
    });

    it('should return success message if cmd exec does not return error', async () => {
      verifyPrivilegeStub.returns(true);
      runCmdStub.resolves({ error: null });
      const nodedpath = path.join(__dirname, '../../');

      const expectedResponse = {
        data: {
          code: undefined,
          message: 'Flux UI successfully rebuilt',
          name: undefined,
        },
        status: 'success',
      };
      const res = generateResponse();

      await fluxService.rebuildHome(undefined, res);
      await serviceHelper.delay(200);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
      sinon.assert.calledWithExactly(runCmdStub, 'npm', { cwd: nodedpath, params: ['run', 'homebuild'] });
    });

    it('should return error if cmd exec throws error ', async () => {
      verifyPrivilegeStub.returns(true);
      runCmdStub.resolves({
        error: {
          message: 'This is an error',
          code: 403,
          name: 'testing error',
        },
      });
      const nodedpath = path.join(__dirname, '../../');

      const expectedResponse = {
        data: {
          code: 403,
          message: 'Error rebuilding Flux UI: This is an error',
          name: 'testing error',
        },
        status: 'error',
      };
      const res = generateResponse();

      await fluxService.rebuildHome(undefined, res);
      await serviceHelper.delay(200);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
      sinon.assert.calledWithExactly(runCmdStub, 'npm', { cwd: nodedpath, params: ['run', 'homebuild'] });
    });
  });

  describe('updateDaemon tests', () => {
    let verifyPrivilegeStub;
    let runCmdStub;

    beforeEach(() => {
      verifyPrivilegeStub = sinon.stub(verificationHelper, 'verifyPrivilege');
      runCmdStub = sinon.stub(serviceHelper, 'runCommand');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should throw error if user is not an admin or flux team', async () => {
      verifyPrivilegeStub.returns(false);
      const res = generateResponse();
      const expectedResponse = {
        data: {
          code: 401,
          message: 'Unauthorized. Access denied.',
          name: 'Unauthorized',
        },
        status: 'error',
      };

      const response = await fluxService.updateDaemon(undefined, res);

      expect(response).to.eql(`Response: ${expectedResponse}`);
      sinon.assert.calledWithExactly(res.json, expectedResponse);
    });

    it('should return success message if cmd exec does not return error', async () => {
      verifyPrivilegeStub.returns(true);
      runCmdStub.resolves({ error: null });
      const nodedpath = path.join(__dirname, '../../helpers');

      const expectedResponse = {
        data: {
          code: undefined,
          message: 'Daemon successfully updated',
          name: undefined,
        },
        status: 'success',
      };
      const res = generateResponse();

      await fluxService.updateDaemon(undefined, res);
      await serviceHelper.delay(200);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
      sinon.assert.calledWithExactly(runCmdStub, `${nodedpath}/updateDaemon.sh`, { cwd: nodedpath });
    });

    it('should return error if cmd exec throws error ', async () => {
      verifyPrivilegeStub.returns(true);
      runCmdStub.resolves({
        error: {
          message: 'This is an error',
          code: 403,
          name: 'testing error',
        },
      });
      const nodedpath = path.join(__dirname, '../../helpers');

      const expectedResponse = {
        data: {
          code: 403,
          message: 'Error updating Daemon: This is an error',
          name: 'testing error',
        },
        status: 'error',
      };
      const res = generateResponse();

      await fluxService.updateDaemon(undefined, res);
      await serviceHelper.delay(200);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
      sinon.assert.calledWithExactly(runCmdStub, `${nodedpath}/updateDaemon.sh`, { cwd: nodedpath });
    });
  });

  describe('updateBenchmark tests', () => {
    let verifyPrivilegeStub;
    let runCmdStub;

    beforeEach(() => {
      verifyPrivilegeStub = sinon.stub(verificationHelper, 'verifyPrivilege');
      runCmdStub = sinon.stub(serviceHelper, 'runCommand');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should throw error if user is not an admin or flux team', async () => {
      verifyPrivilegeStub.returns(false);
      const res = generateResponse();
      const expectedResponse = {
        data: {
          code: 401,
          message: 'Unauthorized. Access denied.',
          name: 'Unauthorized',
        },
        status: 'error',
      };

      const response = await fluxService.updateBenchmark(undefined, res);

      expect(response).to.eql(`Response: ${expectedResponse}`);
      sinon.assert.calledWithExactly(res.json, expectedResponse);
    });

    it('should return success message if cmd exec does not return error', async () => {
      verifyPrivilegeStub.returns(true);
      runCmdStub.resolves({ error: null });
      const nodedpath = path.join(__dirname, '../../helpers');

      const expectedResponse = {
        data: {
          code: undefined,
          message: 'Benchmark successfully updated',
          name: undefined,
        },
        status: 'success',
      };
      const res = generateResponse();

      await fluxService.updateBenchmark(undefined, res);
      await serviceHelper.delay(200);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
      sinon.assert.calledWithExactly(runCmdStub, `${nodedpath}/updateBenchmark.sh`, { cwd: nodedpath });
    });

    it('should return error if cmd exec throws error ', async () => {
      verifyPrivilegeStub.returns(true);
      runCmdStub.resolves({
        error: {
          message: 'This is an error',
          code: 403,
          name: 'testing error',
        },
      });
      const nodedpath = path.join(__dirname, '../../helpers');

      const expectedResponse = {
        data: {
          code: 403,
          message: 'Error updating Benchmark: This is an error',
          name: 'testing error',
        },
        status: 'error',
      };
      const res = generateResponse();

      await fluxService.updateBenchmark(undefined, res);
      await serviceHelper.delay(200);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
      sinon.assert.calledWithExactly(runCmdStub, `${nodedpath}/updateBenchmark.sh`, { cwd: nodedpath });
    });
  });

  describe('startBenchmark tests', () => {
    let verifyPrivilegeStub;
    let runCmdStub;

    beforeEach(() => {
      verifyPrivilegeStub = sinon.stub(verificationHelper, 'verifyPrivilege');
      runCmdStub = sinon.stub(serviceHelper, 'runCommand');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should throw error if user is not an admin or flux team', async () => {
      verifyPrivilegeStub.returns(false);
      const res = generateResponse();
      const expectedResponse = {
        data: {
          code: 401,
          message: 'Unauthorized. Access denied.',
          name: 'Unauthorized',
        },
        status: 'error',
      };

      const response = await fluxService.startBenchmark(undefined, res);

      expect(response).to.eql(`Response: ${expectedResponse}`);
      sinon.assert.calledWithExactly(res.json, expectedResponse);
    });

    it('should return success message if cmd exec does not return error', async () => {
      verifyPrivilegeStub.returns(true);
      runCmdStub.resolves({ error: null });

      const expectedResponse = {
        data: {
          code: undefined,
          message: 'Benchmark successfully started',
          name: undefined,
        },
        status: 'success',
      };
      const res = generateResponse();

      await fluxService.startBenchmark(undefined, res);
      await serviceHelper.delay(200);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
      sinon.assert.calledWithExactly(runCmdStub, 'fluxbenchd', { params: ['-daemon'] });
    });

    it('should return error if cmd exec throws error ', async () => {
      verifyPrivilegeStub.returns(true);
      runCmdStub.resolves({
        error: {
          message: 'This is an error',
          code: 403,
          name: 'testing error',
        },
      });

      const expectedResponse = {
        data: {
          code: 403,
          message: 'Error starting Benchmark: This is an error',
          name: 'testing error',
        },
        status: 'error',
      };
      const res = generateResponse();

      await fluxService.startBenchmark(undefined, res);
      await serviceHelper.delay(200);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
      sinon.assert.calledWithExactly(runCmdStub, 'fluxbenchd', { params: ['-daemon'] });
    });
  });

  describe('restartBenchmark tests', () => {
    let verifyPrivilegeStub;
    let runCmdStub;

    beforeEach(() => {
      verifyPrivilegeStub = sinon.stub(verificationHelper, 'verifyPrivilege');
      runCmdStub = sinon.stub(serviceHelper, 'runCommand');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should throw error if user is not an admin or flux team', async () => {
      verifyPrivilegeStub.returns(false);
      const res = generateResponse();
      const expectedResponse = {
        data: {
          code: 401,
          message: 'Unauthorized. Access denied.',
          name: 'Unauthorized',
        },
        status: 'error',
      };

      const response = await fluxService.restartBenchmark(undefined, res);

      expect(response).to.eql(`Response: ${expectedResponse}`);
      sinon.assert.calledWithExactly(res.json, expectedResponse);
    });

    it('should return success message if cmd exec does not return error', async () => {
      verifyPrivilegeStub.returns(true);
      runCmdStub.resolves({ error: null });
      const nodedpath = path.join(__dirname, '../../helpers');

      const expectedResponse = {
        data: {
          code: undefined,
          message: 'Benchmark successfully restarted',
          name: undefined,
        },
        status: 'success',
      };
      const res = generateResponse();

      await fluxService.restartBenchmark(undefined, res);
      await serviceHelper.delay(200);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
      sinon.assert.calledWithExactly(runCmdStub, `${nodedpath}/restartBenchmark.sh`, { cwd: nodedpath });
    });

    it('should return error if cmd exec throws error ', async () => {
      verifyPrivilegeStub.returns(true);
      runCmdStub.resolves({
        error: {
          message: 'This is an error',
          code: 403,
          name: 'testing error',
        },
      });
      const nodedpath = path.join(__dirname, '../../helpers');

      const expectedResponse = {
        data: {
          code: 403,
          message: 'Error restarting Benchmark: This is an error',
          name: 'testing error',
        },
        status: 'error',
      };
      const res = generateResponse();

      await fluxService.restartBenchmark(undefined, res);
      await serviceHelper.delay(200);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
      sinon.assert.calledWithExactly(runCmdStub, `${nodedpath}/restartBenchmark.sh`, { cwd: nodedpath });
    });
  });

  describe('startDaemon tests', () => {
    let verifyPrivilegeStub;
    let runCmdStub;

    beforeEach(() => {
      verifyPrivilegeStub = sinon.stub(verificationHelper, 'verifyPrivilege');
      runCmdStub = sinon.stub(serviceHelper, 'runCommand');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should throw error if user is not an admin or flux team', async () => {
      verifyPrivilegeStub.returns(false);
      const res = generateResponse();
      const expectedResponse = {
        data: {
          code: 401,
          message: 'Unauthorized. Access denied.',
          name: 'Unauthorized',
        },
        status: 'error',
      };

      const response = await fluxService.startDaemon(undefined, res);

      expect(response).to.eql(`Response: ${expectedResponse}`);
      sinon.assert.calledWithExactly(res.json, expectedResponse);
    });

    it('should return success message if cmd exec does not return error', async () => {
      verifyPrivilegeStub.returns(true);
      runCmdStub.resolves({ error: null });

      const expectedResponse = {
        data: {
          code: undefined,
          message: 'Daemon successfully started',
          name: undefined,
        },
        status: 'success',
      };
      const res = generateResponse();

      await fluxService.startDaemon(undefined, res);
      await serviceHelper.delay(200);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
      sinon.assert.calledWithExactly(runCmdStub, 'fluxd');
    });

    it('should return error if cmd exec throws error ', async () => {
      verifyPrivilegeStub.returns(true);
      runCmdStub.resolves({
        error: {
          message: 'This is an error',
          code: 403,
          name: 'testing error',
        },
      });

      const expectedResponse = {
        data: {
          code: 403,
          message: 'Error starting Daemon: This is an error',
          name: 'testing error',
        },
        status: 'error',
      };
      const res = generateResponse();

      await fluxService.startDaemon(undefined, res);
      await serviceHelper.delay(200);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
      sinon.assert.calledWithExactly(runCmdStub, 'fluxd');
    });
  });

  describe('restartDaemon tests', () => {
    let verifyPrivilegeStub;
    let runCmdStub;

    beforeEach(() => {
      verifyPrivilegeStub = sinon.stub(verificationHelper, 'verifyPrivilege');
      runCmdStub = sinon.stub(serviceHelper, 'runCommand');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should throw error if user is not an admin or flux team', async () => {
      verifyPrivilegeStub.returns(false);
      const res = generateResponse();
      const expectedResponse = {
        data: {
          code: 401,
          message: 'Unauthorized. Access denied.',
          name: 'Unauthorized',
        },
        status: 'error',
      };

      const response = await fluxService.restartDaemon(undefined, res);

      expect(response).to.eql(`Response: ${expectedResponse}`);
      sinon.assert.calledWithExactly(res.json, expectedResponse);
    });

    it('should return success message if cmd exec does not return error', async () => {
      verifyPrivilegeStub.returns(true);
      runCmdStub.resolves({ error: null });
      const nodedpath = path.join(__dirname, '../../helpers');

      const expectedResponse = {
        data: {
          code: undefined,
          message: 'Daemon successfully restarted',
          name: undefined,
        },
        status: 'success',
      };
      const res = generateResponse();

      await fluxService.restartDaemon(undefined, res);
      await serviceHelper.delay(200);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
      sinon.assert.calledWithExactly(runCmdStub, `${nodedpath}/restartDaemon.sh`, { cwd: nodedpath });
    });

    it('should return error if cmd exec throws error ', async () => {
      verifyPrivilegeStub.returns(true);
      runCmdStub.resolves({
        error: {
          message: 'This is an error',
          code: 403,
          name: 'testing error',
        },
      });
      const nodedpath = path.join(__dirname, '../../helpers');

      const expectedResponse = {
        data: {
          code: 403,
          message: 'Error restarting Daemon: This is an error',
          name: 'testing error',
        },
        status: 'error',
      };
      const res = generateResponse();

      await fluxService.restartDaemon(undefined, res);
      await serviceHelper.delay(200);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
      sinon.assert.calledWithExactly(runCmdStub, `${nodedpath}/restartDaemon.sh`, { cwd: nodedpath });
    });
  });

  describe('reindexDaemon tests', () => {
    let verifyPrivilegeStub;
    let runCmdStub;

    beforeEach(() => {
      verifyPrivilegeStub = sinon.stub(verificationHelper, 'verifyPrivilege');
      runCmdStub = sinon.stub(serviceHelper, 'runCommand');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should throw error if user is not an admin or flux team', async () => {
      verifyPrivilegeStub.returns(false);
      const res = generateResponse();
      const expectedResponse = {
        data: {
          code: 401,
          message: 'Unauthorized. Access denied.',
          name: 'Unauthorized',
        },
        status: 'error',
      };

      const response = await fluxService.reindexDaemon(undefined, res);

      expect(response).to.eql(`Response: ${expectedResponse}`);
      sinon.assert.calledWithExactly(res.json, expectedResponse);
    });

    it('should return success message if cmd exec does not return error', async () => {
      verifyPrivilegeStub.returns(true);
      runCmdStub.resolves({ error: null });
      const nodedpath = path.join(__dirname, '../../helpers');

      const expectedResponse = {
        data: {
          code: undefined,
          message: 'Daemon successfully reindexing',
          name: undefined,
        },
        status: 'success',
      };
      const res = generateResponse();

      await fluxService.reindexDaemon(undefined, res);
      await serviceHelper.delay(200);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
      sinon.assert.calledWithExactly(runCmdStub, `${nodedpath}/reindexDaemon.sh`, { cwd: nodedpath });
    });

    it('should return error if cmd exec throws error ', async () => {
      verifyPrivilegeStub.returns(true);
      runCmdStub.resolves({
        error: {
          message: 'This is an error',
          code: 403,
          name: 'testing error',
        },
      });
      const nodedpath = path.join(__dirname, '../../helpers');

      const expectedResponse = {
        data: {
          code: 403,
          message: 'Error reindexing Daemon: This is an error',
          name: 'testing error',
        },
        status: 'error',
      };
      const res = generateResponse();

      await fluxService.reindexDaemon(undefined, res);
      await serviceHelper.delay(200);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
      sinon.assert.calledWithExactly(runCmdStub, `${nodedpath}/reindexDaemon.sh`, { cwd: nodedpath });
    });
  });

  describe('getFluxVersion tests', () => {
    const { version } = packageJson;
    afterEach(() => {
      sinon.restore();
    });

    it('should trigger rpc, no response passed', async () => {
      const result = await fluxService.getFluxVersion();

      expect(result.status).to.equal('success');
      expect(result.data).to.be.a('string');
      expect(result.data).to.equal(version);
    });

    it('should trigger rpc, response passed', async () => {
      const res = generateResponse();
      const expectedResponse = {
        status: 'success',
        data: version,
      };

      const result = await fluxService.getFluxVersion(undefined, res);

      expect(result).to.equal(`Response: ${expectedResponse}`);
      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
    });
  });

  describe('getFluxZelID tests', () => {
    let originalUserConfig;

    beforeEach(() => {
      originalUserConfig = globalThis.userconfig;
      globalThis.userconfig = adminConfig;
    });

    afterEach(() => {
      globalThis.userconfig = originalUserConfig;
      sinon.restore();
    });

    it('should trigger rpc, no response passed', async () => {
      const result = await fluxService.getFluxZelID();

      expect(result.status).to.equal('success');
      expect(result.data).to.be.a('string');
      expect(result.data).to.equal(adminConfig.initial.zelid);
    });

    it('should trigger rpc, response passed', async () => {
      const res = generateResponse();
      const expectedResponse = {
        status: 'success',
        data: adminConfig.initial.zelid,
      };

      const result = await fluxService.getFluxZelID(undefined, res);

      expect(result).to.equal(`Response: ${expectedResponse}`);
      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
    });
  });

  describe('getEnterpriseAppOwners tests', () => {
    afterEach(() => {
      sinon.restore();
    });

    it('serves the owner union once the map is loaded', () => {
      sinon.stub(enterpriseConfig, 'isOwnerMapLoaded').returns(true);
      sinon.stub(enterpriseConfig, 'getEnterpriseAppOwners').returns(['ownerA', 'ownerB']);
      const res = generateResponse();

      fluxService.getEnterpriseAppOwners(undefined, res);

      sinon.assert.notCalled(res.status);
      sinon.assert.calledOnceWithExactly(res.json, { status: 'success', data: ['ownerA', 'ownerB'] });
    });

    // An empty union is byte-identical to a network with no enterprise nodes, so a caller
    // cannot tell "not loaded yet" from "nobody is authorized" — it has to be told.
    it('answers 503 rather than an empty union while the map is not loaded', () => {
      sinon.stub(enterpriseConfig, 'isOwnerMapLoaded').returns(false);
      const owners = sinon.stub(enterpriseConfig, 'getEnterpriseAppOwners');
      const res = generateResponse();

      fluxService.getEnterpriseAppOwners(undefined, res);

      sinon.assert.calledOnceWithExactly(res.status, 503);
      sinon.assert.notCalled(owners);
      expect(res.json.firstCall.args[0].status).to.equal('error');
    });

    it('reports not-loaded to a programmatic caller too, rather than throwing', () => {
      sinon.stub(enterpriseConfig, 'isOwnerMapLoaded').returns(false);

      const result = fluxService.getEnterpriseAppOwners();

      expect(result.status).to.equal('error');
      expect(result.data.code).to.equal(503);
    });
  });

  describe('getFluxIP tests', () => {
    let getLocalSocketAddressStub;

    beforeEach(() => {
      getLocalSocketAddressStub = sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress');
    });

    afterEach(() => {
      getLocalSocketAddressStub.restore();
    });

    it('should return socket address if available, no response passed', async () => {
      getLocalSocketAddressStub.resolves('127.0.0.1:5050');
      const expectedResponse = {
        status: 'success',
        data: '127.0.0.1:5050',
      };

      const getIpResult = await fluxService.getFluxIP();

      expect(getIpResult).to.eql(expectedResponse);
      sinon.assert.calledOnce(getLocalSocketAddressStub);
    });

    it('should return socket address if available, response passed', async () => {
      getLocalSocketAddressStub.resolves('127.0.0.1:5050');
      const expectedResponse = {
        status: 'success',
        data: '127.0.0.1:5050',
      };
      const res = generateResponse();

      const getIpResult = await fluxService.getFluxIP(undefined, res);

      expect(getIpResult).to.eql(`Response: ${expectedResponse}`);
      sinon.assert.calledOnce(getLocalSocketAddressStub);
    });

    it('should return null if IP cannot be detected', async () => {
      getLocalSocketAddressStub.resolves(null);
      const expectedResponse = {
        status: 'success',
        data: null,
      };

      const getIpResult = await fluxService.getFluxIP();

      expect(getIpResult).to.be.eql(expectedResponse);
      sinon.assert.calledOnce(getLocalSocketAddressStub);
    });
  });

  describe('daemonDebug tests', () => {
    let verifyPrivilegeStub;

    beforeEach(() => {
      verifyPrivilegeStub = sinon.stub(verificationHelper, 'verifyPrivilege');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return unauthorized message if the user is not an admin', async () => {
      verifyPrivilegeStub.returns(false);
      const res = generateResponse();
      const expectedResponse = {
        data: {
          code: 401,
          message: 'Unauthorized. Access denied.',
          name: 'Unauthorized',
        },
        status: 'error',
      };

      const result = await fluxService.daemonDebug(undefined, res);

      expect(result).to.eql(`Response: ${expectedResponse}`);
      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
    });

    it('should return debug log file if the user is an admin', async () => {
      verifyPrivilegeStub.returns(true);
      const res = generateResponse();
      const expectedResponse = 'File downloaded';

      const result = await fluxService.daemonDebug(undefined, res);

      expect(result).to.eql(expectedResponse);
      sinon.assert.calledWithMatch(res.download, 'debug.log');
    });
  });

  describe('benchmarkDebug tests', () => {
    let verifyPrivilegeStub;

    beforeEach(() => {
      verifyPrivilegeStub = sinon.stub(verificationHelper, 'verifyPrivilege');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return unauthorized message if the user is not an admin', async () => {
      verifyPrivilegeStub.returns(false);
      const res = generateResponse();
      const expectedResponse = {
        data: {
          code: 401,
          message: 'Unauthorized. Access denied.',
          name: 'Unauthorized',
        },
        status: 'error',
      };

      const result = await fluxService.benchmarkDebug(undefined, res);

      expect(result).to.eql(`Response: ${expectedResponse}`);
      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
    });

    it('should return debug log file if the user is an admin', async () => {
      verifyPrivilegeStub.returns(true);
      const res = generateResponse();
      const expectedResponse = 'File downloaded';

      const result = await fluxService.benchmarkDebug(undefined, res);

      expect(result).to.eql(expectedResponse);
      sinon.assert.calledWithMatch(res.download, 'debug.log');
    });
  });

  describe('tailDaemonDebug tests', () => {
    let verifyPrivilegeStub;
    let runCmdStub;

    beforeEach(() => {
      verifyPrivilegeStub = sinon.stub(verificationHelper, 'verifyPrivilege');
      runCmdStub = sinon.stub(serviceHelper, 'runCommand');
      // Mock daemon service utils to return valid paths
      sinon.stub(daemonServiceUtils, 'getConfigValue').returns(path.join(os.homedir(), '.flux'));
      sinon.stub(daemonServiceUtils, 'getFluxdDir').returns(path.join(os.homedir(), '.flux'));
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return unauthorized message if the user is not an admin', async () => {
      verifyPrivilegeStub.returns(false);
      const res = generateResponse();
      const expectedResponse = {
        data: {
          code: 401,
          message: 'Unauthorized. Access denied.',
          name: 'Unauthorized',
        },
        status: 'error',
      };

      await fluxService.tailDaemonDebug(undefined, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
    });

    it('should return debug log file if the user is an admin', async () => {
      verifyPrivilegeStub.returns(true);
      const res = generateResponse();
      runCmdStub.resolves({ error: null, stdout: 'success message' });

      await fluxService.tailDaemonDebug(undefined, res);
      await serviceHelper.delay(200);

      sinon.assert.calledOnceWithExactly(res.json, {
        status: 'success',
        data: { code: undefined, name: undefined, message: 'success message' },
      });
    });

    it('should return error if cmd exec throws error', async () => {
      verifyPrivilegeStub.returns(true);
      runCmdStub.resolves({
        error: {
          message: 'This is an error',
          code: 403,
          name: 'testing error',
        },
      });
      const nodedpath = path.join(os.homedir(), '.flux', 'debug.log');
      const expectedResponse = {
        data: {
          code: 403,
          message: 'Error obtaining Daemon debug file: This is an error',
          name: 'testing error',
        },
        status: 'error',
      };
      const res = generateResponse();
      await fluxService.tailDaemonDebug(undefined, res);
      await serviceHelper.delay(200);
      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
      sinon.assert.calledWithMatch(runCmdStub, 'tail', { params: ['-n', '100', nodedpath] });
    });
  });

  describe('tailBenchmarkDebug tests', () => {
    let verifyPrivilegeStub;
    let runCmdStub;
    // eslint-disable-next-line no-unused-vars
    let fsAccessStub;

    beforeEach(() => {
      verifyPrivilegeStub = sinon.stub(verificationHelper, 'verifyPrivilege');
      runCmdStub = sinon.stub(serviceHelper, 'runCommand');
      // Force fs.access to fail so it falls back to .zelbenchmark path
      fsAccessStub = sinon.stub(fs, 'access').callsFake(() => Promise.reject(new Error('ENOENT: no such file or directory')));
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return unauthorized message if the user is not an admin', async () => {
      verifyPrivilegeStub.returns(false);
      const res = generateResponse();
      const expectedResponse = {
        data: {
          code: 401,
          message: 'Unauthorized. Access denied.',
          name: 'Unauthorized',
        },
        status: 'error',
      };

      await fluxService.tailBenchmarkDebug(undefined, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
    });

    it('should return debug log file if the user is an admin', async () => {
      verifyPrivilegeStub.returns(true);
      const res = generateResponse();
      runCmdStub.resolves({ error: null, stdout: 'some logs' });

      await fluxService.tailBenchmarkDebug(undefined, res);
      await serviceHelper.delay(200);

      sinon.assert.calledWithMatch(res.json, {
        status: 'success',
        data: { code: undefined, name: undefined, message: 'some logs' },
      });
    });

    it('should return error if cmd exec throws error ', async () => {
      verifyPrivilegeStub.returns(true);
      runCmdStub.resolves({
        error: {
          message: 'This is an error',
          code: 403,
          name: 'testing error',
        },
      });
      const nodedpath = path.join(__dirname, '../../../.fluxbenchmark/debug.log'); // Updated to match current implementation
      const expectedResponse = {
        data: {
          code: 403,
          message: 'Error obtaining Benchmark debug file: This is an error',
          name: 'testing error',
        },
        status: 'error',
      };
      const res = generateResponse();

      await fluxService.tailBenchmarkDebug(undefined, res);
      await serviceHelper.delay(200);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
      sinon.assert.calledWithMatch(runCmdStub, 'tail', { params: ['-n', '100', nodedpath] });
    });
  });

  describe('flux log endpoints (sink-aware)', () => {
    const tmpLog = path.join(os.tmpdir(), 'fluxservice-log-endpoint-test.log');
    const FIXTURE = [
      '{"level":30,"time":"2026-07-18T10:00:00.000Z","msg":"an info line"}',
      '{"level":40,"time":"2026-07-18T10:00:01.000Z","msg":"a warn line"}',
      '{"level":50,"time":"2026-07-18T10:00:02.000Z","err":{"type":"Error","message":"boom","stack":"Error: boom\\n    at x"},"msg":"boom"}',
      'a stray non-json stdout line',
    ].join('\n');
    let verifyPrivilegeStub;
    let sinkInfoStub;

    beforeEach(async () => {
      verifyPrivilegeStub = sinon.stub(verificationHelper, 'verifyPrivilege');
      await fs.writeFile(tmpLog, FIXTURE);
      sinkInfoStub = sinon.stub(logLib, 'sinkInfo').returns({ journald: false, file: tmpLog });
    });

    afterEach(() => {
      sinon.restore();
    });

    it('fluxLog serves the selected level as a rendered .log attachment', async () => {
      const res = generateResponse();
      await fluxService.fluxLog(undefined, res, 'error');
      sinon.assert.calledOnceWithExactly(res.attachment, 'error.log');
      const text = res.send.firstCall.args[0];
      expect(text).to.include('2026-07-18T10:00:02.000Z ERROR boom');
      expect(text).to.include('Error: boom');
      expect(text).to.not.include('an info line');
      expect(text).to.not.include('a warn line');
    });

    it('warn serves exactly warn; info includes non-NDJSON strays; debug serves everything', async () => {
      const res1 = generateResponse();
      await fluxService.fluxLog(undefined, res1, 'warn');
      expect(res1.send.firstCall.args[0]).to.include('WARN a warn line');
      expect(res1.send.firstCall.args[0]).to.not.include('an info line');

      const res2 = generateResponse();
      await fluxService.fluxLog(undefined, res2, 'info');
      expect(res2.send.firstCall.args[0]).to.include('INFO an info line');
      expect(res2.send.firstCall.args[0]).to.include('a stray non-json stdout line');
      expect(res2.send.firstCall.args[0]).to.not.include('boom');

      const res3 = generateResponse();
      await fluxService.fluxLog(undefined, res3, 'debug');
      const all = res3.send.firstCall.args[0];
      expect(all).to.include('an info line');
      expect(all).to.include('a warn line');
      expect(all).to.include('ERROR boom');
      expect(all).to.include('a stray non-json stdout line');
    });

    it('under journald the lines come from journalctl -u fluxos -o json', async () => {
      sinkInfoStub.returns({ journald: true, file: null });
      const journal = [
        JSON.stringify({ MESSAGE: '{"level":50,"time":"2026-07-18T11:00:00.000Z","msg":"journal error"}' }),
        JSON.stringify({ MESSAGE: '{"level":30,"time":"2026-07-18T11:00:01.000Z","msg":"journal info"}' }),
      ].join('\n');
      const runCmdStub = sinon.stub(serviceHelper, 'runCommand').resolves({ error: null, stdout: journal });

      const res = generateResponse();
      await fluxService.fluxLog(undefined, res, 'error');

      sinon.assert.calledWithMatch(runCmdStub, 'journalctl', {
        params: ['-u', 'fluxos', '_TRANSPORT=stdout', '-o', 'json', '-n', '100000', '--no-pager'],
      });
      expect(res.send.firstCall.args[0]).to.include('ERROR journal error');
      expect(res.send.firstCall.args[0]).to.not.include('journal info');
    });

    it('honors lines, since, and grep query filters', async () => {
      const res1 = generateResponse();
      await fluxService.fluxLog({ query: { grep: 'WARN' } }, res1, 'debug');
      expect(res1.send.firstCall.args[0]).to.equal('2026-07-18T10:00:01.000Z WARN a warn line');

      const res2 = generateResponse();
      await fluxService.fluxLog({ query: { lines: '1' } }, res2, 'debug');
      expect(res2.send.firstCall.args[0]).to.equal('a stray non-json stdout line');

      // since drops older records and unstamped strays
      const res3 = generateResponse();
      await fluxService.fluxLog({ query: { since: '2026-07-18T10:00:01.500Z' } }, res3, 'debug');
      const text = res3.send.firstCall.args[0];
      expect(text).to.include('ERROR boom');
      expect(text).to.not.include('a warn line');
      expect(text).to.not.include('stray');
    });

    it('passes since through to journalctl as an epoch bound', async () => {
      sinkInfoStub.returns({ journald: true, file: null });
      const runCmdStub = sinon.stub(serviceHelper, 'runCommand').resolves({ error: null, stdout: '' });
      const res = generateResponse();
      await fluxService.fluxLog({ query: { since: '2026-07-18T10:00:00.000Z' } }, res, 'debug');
      const { params } = runCmdStub.firstCall.args[1];
      const sinceIdx = params.indexOf('--since');
      expect(sinceIdx).to.be.greaterThan(-1);
      expect(params[sinceIdx + 1]).to.equal(`@${Math.floor(new Date('2026-07-18T10:00:00.000Z').getTime() / 1000)}`);
    });

    for (const [fn, level] of [
      ['fluxErrorLog', 'error.log'], ['fluxWarnLog', 'warn.log'],
      ['fluxInfoLog', 'info.log'], ['fluxDebugLog', 'debug.log'],
    ]) {
      it(`${fn} rejects unauthorized users`, async () => {
        const res = generateResponse();
        verifyPrivilegeStub.returns(false);
        const expectedResponse = {
          data: { code: 401, message: 'Unauthorized. Access denied.', name: 'Unauthorized' },
          status: 'error',
        };
        await fluxService[fn](undefined, res);
        sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
      });

      it(`${fn} serves the attachment when authorized`, async () => {
        const res = generateResponse();
        verifyPrivilegeStub.returns(true);
        await fluxService[fn](undefined, res);
        await serviceHelper.delay(50);
        sinon.assert.calledOnceWithExactly(res.attachment, level);
      });
    }
  });

  describe('tailFluxLog tests', () => {
    const tmpLog = path.join(os.tmpdir(), 'fluxservice-log-endpoint-test.log');
    let verifyPrivilegeStub;
    let sinkInfoStub;

    beforeEach(async () => {
      verifyPrivilegeStub = sinon.stub(verificationHelper, 'verifyPrivilege');
      await fs.writeFile(tmpLog, '{"level":30,"time":"2026-07-18T10:00:00.000Z","msg":"tail me"}');
      sinkInfoStub = sinon.stub(logLib, 'sinkInfo').returns({ journald: false, file: tmpLog });
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return unauthorized message if the user is not an admin', async () => {
      verifyPrivilegeStub.returns(false);
      const res = generateResponse();
      const expectedResponse = {
        data: { code: 401, message: 'Unauthorized. Access denied.', name: 'Unauthorized' },
        status: 'error',
      };
      await fluxService.tailFluxLog(undefined, res);
      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
    });

    it('returns the last lines as a success message when authorized', async () => {
      verifyPrivilegeStub.returns(true);
      const res = generateResponse();
      await fluxService.tailFluxLog(undefined, res, 'info');
      const payload = res.json.firstCall.args[0];
      expect(payload.status).to.equal('success');
      expect(payload.data.message).to.include('INFO tail me');
    });

    it('applies query filters on tails too', async () => {
      verifyPrivilegeStub.returns(true);
      const res = generateResponse();
      await fluxService.tailFluxLog({ query: { grep: 'no-such-text' } }, res, 'info');
      expect(res.json.firstCall.args[0].data.message).to.equal('');
    });

    it('should return error if the journal read fails', async () => {
      verifyPrivilegeStub.returns(true);
      sinkInfoStub.returns({ journald: true, file: null });
      sinon.stub(serviceHelper, 'runCommand').resolves({
        error: { message: 'This is an error', code: 403, name: 'testing error' },
      });
      const expectedResponse = {
        data: { code: 403, message: 'Error obtaining Flux log file: This is an error', name: 'testing error' },
        status: 'error',
      };
      const res = generateResponse();
      await fluxService.tailFluxLog(undefined, res, 'debug');
      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
    });
  });

  describe('tail level wrappers', () => {
    const tmpLog = path.join(os.tmpdir(), 'fluxservice-log-endpoint-test.log');
    let verifyPrivilegeStub;

    beforeEach(async () => {
      verifyPrivilegeStub = sinon.stub(verificationHelper, 'verifyPrivilege');
      await fs.writeFile(tmpLog, '{"level":50,"time":"2026-07-18T10:00:00.000Z","msg":"tail err"}');
      sinon.stub(logLib, 'sinkInfo').returns({ journald: false, file: tmpLog });
    });

    afterEach(() => {
      sinon.restore();
    });

    for (const fn of ['tailFluxErrorLog', 'tailFluxWarnLog', 'tailFluxInfoLog', 'tailFluxDebugLog']) {
      it(`${fn} rejects unauthorized users`, async () => {
        const res = generateResponse();
        verifyPrivilegeStub.returns(false);
        const expectedResponse = {
          data: { code: 401, message: 'Unauthorized. Access denied.', name: 'Unauthorized' },
          status: 'error',
        };
        await fluxService[fn](undefined, res);
        sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
      });

      it(`${fn} returns a success message when authorized`, async () => {
        const res = generateResponse();
        verifyPrivilegeStub.returns(true);
        await fluxService[fn](undefined, res);
        const payload = res.json.firstCall.args[0];
        expect(payload.status).to.equal('success');
      });
    }
  });

  describe('getFluxTimezone tests', () => {
    it('should return timezone, no response passed', () => {
      const result = fluxService.getFluxTimezone();

      expect(result.status).to.eql('success');
      expect(result.data).to.be.a('string');
    });

    it('should return timezone,  response passed', () => {
      const res = generateResponse();

      fluxService.getFluxTimezone(undefined, res);

      sinon.assert.calledWithMatch(res.json, { status: 'success' });
    });
  });

  describe('getFluxInfo tests', () => {
    let daemonServiceControlRpcsStub;
    let daemonServiceFluxnodeRpcsStub;
    let benchmarkServiceGetInfoStub;
    let benchmarkServiceGetStatusStub;
    let benchmarkServiceGetBenchmarksStub;
    let appsServiceFluxUsageStub;
    let appsServiceListRunningAppsStub;
    let appsServiceAppsResourcesStub;
    let appsServiceGetAppHashesStub;
    let explorerServiceStub;
    let fluxCommunicationStub;
    let fluxNetworkHelperStub;
    let syncthingServiceStub;

    beforeEach(() => {
      daemonServiceControlRpcsStub = sinon.stub(daemonServiceControlRpcs, 'getInfo');
      daemonServiceFluxnodeRpcsStub = sinon.stub(daemonServiceFluxnodeRpcs, 'getFluxNodeStatus');
      benchmarkServiceGetInfoStub = sinon.stub(benchmarkService, 'getInfo');
      benchmarkServiceGetStatusStub = sinon.stub(benchmarkService, 'getStatus');
      benchmarkServiceGetBenchmarksStub = sinon.stub(benchmarkService, 'getBenchmarks');
      sinon.stub(appInspector, 'getAppsDOSState').returns({ status: 'success', data: { state: 'ok' } });
      appsServiceFluxUsageStub = sinon.stub(resourceQueryService, 'fluxUsage');
      appsServiceListRunningAppsStub = sinon.stub(appQueryService, 'listRunningApps');
      appsServiceAppsResourcesStub = sinon.stub(resourceQueryService, 'appsResources');
      appsServiceGetAppHashesStub = sinon.stub(registryManager, 'getAppHashes');
      explorerServiceStub = sinon.stub(explorerService, 'getScannedHeight');
      fluxCommunicationStub = sinon.stub(fluxCommunication, 'connectedPeersInfo');
      fluxNetworkHelperStub = sinon.stub(fluxNetworkHelper, 'getIncomingConnectionsInfo');
      syncthingServiceStub = sinon.stub(syncthingService, 'systemVersion');
      // getNodeGeolocation reads a process-wide module cache and the local DB; pin it
      // so the response is driven by this test rather than by geolocation state left by
      // an earlier suite.
      sinon.stub(geolocationService, 'getNodeGeolocation').resolves(null);
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return flux info no response passed', async () => {
      daemonServiceControlRpcsStub.returns({ status: 'success', data: 'info data' });
      daemonServiceFluxnodeRpcsStub.returns({ status: 'success', data: 'status data' });
      benchmarkServiceGetInfoStub.returns({ status: 'success', data: 'info2 data' });
      benchmarkServiceGetStatusStub.returns({ status: 'success', data: 'status2 data' });
      benchmarkServiceGetBenchmarksStub.returns({ status: 'success', data: 'benchmarks data' });
      appsServiceFluxUsageStub.returns({ status: 'success', data: 'usage data' });
      appsServiceListRunningAppsStub.returns({ status: 'success', data: 'listRunningApps data' });
      appsServiceAppsResourcesStub.returns({ status: 'success', data: 'appsResources data' });
      appsServiceGetAppHashesStub.returns({ status: 'success', data: [{ height: 694000, message: true }] });
      explorerServiceStub.returns({ status: 'success', data: 'getScannedHeight data' });
      fluxCommunicationStub.returns({ status: 'success', data: 'connectedPeersInfo data' });
      fluxNetworkHelperStub.returns({ status: 'success', data: 'getIncomingConnectionsInfo data' });
      syncthingServiceStub.returns({ status: 'success', data: 'syncthingVersion data' });

      const result = await fluxService.getFluxInfo();

      expect(result).to.be.an('object');
      expect(result.status).to.equal('success');
      expect(result.data.daemon).to.eql({ info: 'info data', zmqEnabled: false });
      expect(result.data.node).to.eql({ status: 'status data' });
      expect(result.data.flux).to.be.an('object');
      expect(result.data.apps).to.be.an('object');
      expect(result.data.benchmark).to.eql({
        info: 'info2 data',
        status: 'status2 data',
        bench: 'benchmarks data',
      });
    });

    it('should return flux info response passed', async () => {
      daemonServiceControlRpcsStub.returns({ status: 'success', data: 'info data' });
      daemonServiceFluxnodeRpcsStub.returns({ status: 'success', data: 'status data' });
      benchmarkServiceGetInfoStub.returns({ status: 'success', data: 'info2 data' });
      benchmarkServiceGetStatusStub.returns({ status: 'success', data: 'status2 data' });
      benchmarkServiceGetBenchmarksStub.returns({ status: 'success', data: 'benchmarks data' });
      appsServiceFluxUsageStub.returns({ status: 'success', data: 'usage data' });
      appsServiceListRunningAppsStub.returns({ status: 'success', data: 'listRunningApps data' });
      appsServiceAppsResourcesStub.returns({ status: 'success', data: 'appsResources data' });
      appsServiceGetAppHashesStub.returns({ status: 'success', data: [{ height: 694000, message: true }] });
      explorerServiceStub.returns({ status: 'success', data: 'getScannedHeight data' });
      fluxCommunicationStub.returns({ status: 'success', data: 'connectedPeersInfo data' });
      fluxNetworkHelperStub.returns({ status: 'success', data: 'getIncomingConnectionsInfo data' });
      syncthingServiceStub.returns({ status: 'success', data: 'syncthingVersion data' });

      const res = generateResponse();

      await fluxService.getFluxInfo(undefined, res);

      sinon.assert.calledOnceWithMatch(res.json, {
        status: 'success',
        data: {
          daemon: { info: 'info data' },
          node: { status: 'status data' },
          benchmark: {
            info: 'info2 data',
            status: 'status2 data',
            bench: 'benchmarks data',
          },
          apps: {
            fluxusage: 'usage data',
            runningapps: 'listRunningApps data',
            resources: 'appsResources data',
          },
          geolocation: null,
          appsHashesTotal: 1,
          hashesPresent: 1,
        },
      });
    });

    it('should return error if control rpcs returns error', async () => {
      daemonServiceControlRpcsStub.returns({ status: 'error', data: 'info data' });
      daemonServiceFluxnodeRpcsStub.returns({ status: 'success', data: 'status data' });
      benchmarkServiceGetInfoStub.returns({ status: 'success', data: 'info2 data' });
      benchmarkServiceGetStatusStub.returns({ status: 'success', data: 'status2 data' });
      benchmarkServiceGetBenchmarksStub.returns({ status: 'success', data: 'benchmarks data' });
      appsServiceFluxUsageStub.returns({ status: 'success', data: 'usage data' });
      appsServiceListRunningAppsStub.returns({ status: 'success', data: 'listRunningApps data' });
      appsServiceAppsResourcesStub.returns({ status: 'success', data: 'appsResources data' });
      appsServiceGetAppHashesStub.returns({ status: 'success', data: [{ height: 694000, message: true }] });
      explorerServiceStub.returns({ status: 'success', data: 'getScannedHeight data' });
      fluxCommunicationStub.returns({ status: 'success', data: 'connectedPeersInfo data' });
      fluxNetworkHelperStub.returns({ status: 'success', data: 'getIncomingConnectionsInfo data' });
      syncthingServiceStub.returns({ status: 'success', data: 'syncthingVersion data' });

      const res = generateResponse();

      await fluxService.getFluxInfo(undefined, res);

      sinon.assert.calledOnceWithMatch(res.json, {
        status: 'error',
        data: { code: undefined, name: undefined, message: 'info data' },
      });
    });

    it('should return error if status returns error', async () => {
      daemonServiceControlRpcsStub.returns({ status: 'success', data: 'info data' });
      daemonServiceFluxnodeRpcsStub.returns({ status: 'error', data: 'status data' });
      benchmarkServiceGetInfoStub.returns({ status: 'success', data: 'info2 data' });
      benchmarkServiceGetStatusStub.returns({ status: 'success', data: 'status2 data' });
      benchmarkServiceGetBenchmarksStub.returns({ status: 'success', data: 'benchmarks data' });
      appsServiceFluxUsageStub.returns({ status: 'success', data: 'usage data' });
      appsServiceListRunningAppsStub.returns({ status: 'success', data: 'listRunningApps data' });
      appsServiceAppsResourcesStub.returns({ status: 'success', data: 'appsResources data' });
      appsServiceGetAppHashesStub.returns({ status: 'success', data: [{ height: 694000, message: true }] });
      explorerServiceStub.returns({ status: 'success', data: 'getScannedHeight data' });
      fluxCommunicationStub.returns({ status: 'success', data: 'connectedPeersInfo data' });
      fluxNetworkHelperStub.returns({ status: 'success', data: 'getIncomingConnectionsInfo data' });
      syncthingServiceStub.returns({ status: 'success', data: 'syncthingVersion data' });

      const res = generateResponse();

      await fluxService.getFluxInfo(undefined, res);

      sinon.assert.calledOnceWithMatch(res.json, {
        status: 'error',
        data: { code: undefined, name: undefined, message: 'status data' },
      });
    });

    it('should return error if benchmarkServiceGetInfo returns error', async () => {
      daemonServiceControlRpcsStub.returns({ status: 'success', data: 'info data' });
      daemonServiceFluxnodeRpcsStub.returns({ status: 'success', data: 'status data' });
      benchmarkServiceGetInfoStub.returns({ status: 'error', data: 'info2 data' });
      benchmarkServiceGetStatusStub.returns({ status: 'success', data: 'status2 data' });
      benchmarkServiceGetBenchmarksStub.returns({ status: 'success', data: 'benchmarks data' });
      appsServiceFluxUsageStub.returns({ status: 'success', data: 'usage data' });
      appsServiceListRunningAppsStub.returns({ status: 'success', data: 'listRunningApps data' });
      appsServiceAppsResourcesStub.returns({ status: 'success', data: 'appsResources data' });
      appsServiceGetAppHashesStub.returns({ status: 'success', data: [{ height: 694000, message: true }] });
      explorerServiceStub.returns({ status: 'success', data: 'getScannedHeight data' });
      fluxCommunicationStub.returns({ status: 'success', data: 'connectedPeersInfo data' });
      fluxNetworkHelperStub.returns({ status: 'success', data: 'getIncomingConnectionsInfo data' });
      syncthingServiceStub.returns({ status: 'success', data: 'syncthingVersion data' });

      const res = generateResponse();

      await fluxService.getFluxInfo(undefined, res);

      sinon.assert.calledOnceWithMatch(res.json, {
        status: 'error',
        data: { code: undefined, name: undefined, message: 'info2 data' },
      });
    });

    it('should return error if benchmarkServiceGetStatus returns error', async () => {
      daemonServiceControlRpcsStub.returns({ status: 'success', data: 'info data' });
      daemonServiceFluxnodeRpcsStub.returns({ status: 'success', data: 'status data' });
      benchmarkServiceGetInfoStub.returns({ status: 'success', data: 'info2 data' });
      benchmarkServiceGetStatusStub.returns({ status: 'error', data: 'status2 data' });
      benchmarkServiceGetBenchmarksStub.returns({ status: 'success', data: 'benchmarks data' });
      appsServiceFluxUsageStub.returns({ status: 'success', data: 'usage data' });
      appsServiceListRunningAppsStub.returns({ status: 'success', data: 'listRunningApps data' });
      appsServiceAppsResourcesStub.returns({ status: 'success', data: 'appsResources data' });
      appsServiceGetAppHashesStub.returns({ status: 'success', data: [{ height: 694000, message: true }] });
      explorerServiceStub.returns({ status: 'success', data: 'getScannedHeight data' });
      fluxCommunicationStub.returns({ status: 'success', data: 'connectedPeersInfo data' });
      fluxNetworkHelperStub.returns({ status: 'success', data: 'getIncomingConnectionsInfo data' });
      syncthingServiceStub.returns({ status: 'success', data: 'syncthingVersion data' });

      const res = generateResponse();

      await fluxService.getFluxInfo(undefined, res);

      sinon.assert.calledOnceWithMatch(res.json, {
        status: 'error',
        data: { code: undefined, name: undefined, message: 'status2 data' },
      });
    });

    it('should return error if benchmarkServiceGetBenchmarks returns error', async () => {
      daemonServiceControlRpcsStub.returns({ status: 'success', data: 'info data' });
      daemonServiceFluxnodeRpcsStub.returns({ status: 'success', data: 'status data' });
      benchmarkServiceGetInfoStub.returns({ status: 'success', data: 'info2 data' });
      benchmarkServiceGetStatusStub.returns({ status: 'success', data: 'status2 data' });
      benchmarkServiceGetBenchmarksStub.returns({ status: 'error', data: 'benchmarks data' });
      appsServiceFluxUsageStub.returns({ status: 'success', data: 'usage data' });
      appsServiceListRunningAppsStub.returns({ status: 'success', data: 'listRunningApps data' });
      appsServiceAppsResourcesStub.returns({ status: 'success', data: 'appsResources data' });
      appsServiceGetAppHashesStub.returns({ status: 'success', data: [{ height: 694000, message: true }] });
      explorerServiceStub.returns({ status: 'success', data: 'getScannedHeight data' });
      fluxCommunicationStub.returns({ status: 'success', data: 'connectedPeersInfo data' });
      fluxNetworkHelperStub.returns({ status: 'success', data: 'getIncomingConnectionsInfo data' });
      syncthingServiceStub.returns({ status: 'success', data: 'syncthingVersion data' });

      const res = generateResponse();

      await fluxService.getFluxInfo(undefined, res);

      sinon.assert.calledOnceWithMatch(res.json, {
        status: 'error',
        data: { code: undefined, name: undefined, message: 'benchmarks data' },
      });
    });

    it('should return error if appsServiceFluxUsage returns error', async () => {
      daemonServiceControlRpcsStub.returns({ status: 'success', data: 'info data' });
      daemonServiceFluxnodeRpcsStub.returns({ status: 'success', data: 'status data' });
      benchmarkServiceGetInfoStub.returns({ status: 'success', data: 'info2 data' });
      benchmarkServiceGetStatusStub.returns({ status: 'success', data: 'status2 data' });
      benchmarkServiceGetBenchmarksStub.returns({ status: 'success', data: 'benchmarks data' });
      appsServiceFluxUsageStub.returns({ status: 'error', data: 'usage data' });
      appsServiceListRunningAppsStub.returns({ status: 'success', data: 'listRunningApps data' });
      appsServiceAppsResourcesStub.returns({ status: 'success', data: 'appsResources data' });
      appsServiceGetAppHashesStub.returns({ status: 'success', data: [{ height: 694000, message: true }] });
      explorerServiceStub.returns({ status: 'success', data: 'getScannedHeight data' });
      fluxCommunicationStub.returns({ status: 'success', data: 'connectedPeersInfo data' });
      fluxNetworkHelperStub.returns({ status: 'success', data: 'getIncomingConnectionsInfo data' });
      syncthingServiceStub.returns({ status: 'success', data: 'syncthingVersion data' });

      const res = generateResponse();

      await fluxService.getFluxInfo(undefined, res);

      sinon.assert.calledOnceWithMatch(res.json, {
        status: 'error',
        data: { code: undefined, name: undefined, message: 'usage data' },
      });
    });

    it('should return error if appsServiceListRunningApps returns error', async () => {
      daemonServiceControlRpcsStub.returns({ status: 'success', data: 'info data' });
      daemonServiceFluxnodeRpcsStub.returns({ status: 'success', data: 'status data' });
      benchmarkServiceGetInfoStub.returns({ status: 'success', data: 'info2 data' });
      benchmarkServiceGetStatusStub.returns({ status: 'success', data: 'status2 data' });
      benchmarkServiceGetBenchmarksStub.returns({ status: 'success', data: 'benchmarks data' });
      appsServiceFluxUsageStub.returns({ status: 'success', data: 'usage data' });
      appsServiceListRunningAppsStub.returns({ status: 'error', data: 'listRunningApps data' });
      appsServiceAppsResourcesStub.returns({ status: 'success', data: 'appsResources data' });
      appsServiceGetAppHashesStub.returns({ status: 'success', data: [{ height: 694000, message: true }] });
      explorerServiceStub.returns({ status: 'success', data: 'getScannedHeight data' });
      fluxCommunicationStub.returns({ status: 'success', data: 'connectedPeersInfo data' });
      fluxNetworkHelperStub.returns({ status: 'success', data: 'getIncomingConnectionsInfo data' });
      syncthingServiceStub.returns({ status: 'success', data: 'syncthingVersion data' });

      const res = generateResponse();

      await fluxService.getFluxInfo(undefined, res);

      sinon.assert.calledOnceWithMatch(res.json, {
        status: 'error',
        data: { code: undefined, name: undefined, message: 'listRunningApps data' },
      });
    });

    it('should return error if appsServiceAppsResources returns error', async () => {
      daemonServiceControlRpcsStub.returns({ status: 'success', data: 'info data' });
      daemonServiceFluxnodeRpcsStub.returns({ status: 'success', data: 'status data' });
      benchmarkServiceGetInfoStub.returns({ status: 'success', data: 'info2 data' });
      benchmarkServiceGetStatusStub.returns({ status: 'success', data: 'status2 data' });
      benchmarkServiceGetBenchmarksStub.returns({ status: 'success', data: 'benchmarks data' });
      appsServiceFluxUsageStub.returns({ status: 'success', data: 'usage data' });
      appsServiceListRunningAppsStub.returns({ status: 'success', data: 'listRunningApps data' });
      appsServiceAppsResourcesStub.returns({ status: 'error', data: 'appsResources data' });
      appsServiceGetAppHashesStub.returns({ status: 'success', data: [{ height: 694000, message: true }] });
      explorerServiceStub.returns({ status: 'success', data: 'getScannedHeight data' });
      fluxCommunicationStub.returns({ status: 'success', data: 'connectedPeersInfo data' });
      fluxNetworkHelperStub.returns({ status: 'success', data: 'getIncomingConnectionsInfo data' });
      syncthingServiceStub.returns({ status: 'success', data: 'syncthingVersion data' });

      const res = generateResponse();

      await fluxService.getFluxInfo(undefined, res);

      sinon.assert.calledOnceWithMatch(res.json, {
        status: 'error',
        data: { code: undefined, name: undefined, message: 'appsResources data' },
      });
    });

    it('should return error if appsServiceGetAppHashesStub returns error', async () => {
      daemonServiceControlRpcsStub.returns({ status: 'success', data: 'info data' });
      daemonServiceFluxnodeRpcsStub.returns({ status: 'success', data: 'status data' });
      benchmarkServiceGetInfoStub.returns({ status: 'success', data: 'info2 data' });
      benchmarkServiceGetStatusStub.returns({ status: 'success', data: 'status2 data' });
      benchmarkServiceGetBenchmarksStub.returns({ status: 'success', data: 'benchmarks data' });
      appsServiceFluxUsageStub.returns({ status: 'success', data: 'usage data' });
      appsServiceListRunningAppsStub.returns({ status: 'success', data: 'listRunningApps data' });
      appsServiceAppsResourcesStub.returns({ status: 'success', data: 'appsResources data' });
      appsServiceGetAppHashesStub.returns({ status: 'error', data: 'getAppHashes data' });
      explorerServiceStub.returns({ status: 'success', data: 'getScannedHeight data' });
      fluxCommunicationStub.returns({ status: 'success', data: 'connectedPeersInfo data' });
      fluxNetworkHelperStub.returns({ status: 'success', data: 'getIncomingConnectionsInfo data' });
      syncthingServiceStub.returns({ status: 'success', data: 'syncthingVersion data' });

      const res = generateResponse();

      await fluxService.getFluxInfo(undefined, res);

      sinon.assert.calledOnceWithMatch(res.json, {
        status: 'error',
        data: { code: undefined, name: undefined, message: 'getAppHashes data' },
      });
    });

    it('should return error if explorerService returns error', async () => {
      daemonServiceControlRpcsStub.returns({ status: 'success', data: 'info data' });
      daemonServiceFluxnodeRpcsStub.returns({ status: 'success', data: 'status data' });
      benchmarkServiceGetInfoStub.returns({ status: 'success', data: 'info2 data' });
      benchmarkServiceGetStatusStub.returns({ status: 'success', data: 'status2 data' });
      benchmarkServiceGetBenchmarksStub.returns({ status: 'success', data: 'benchmarks data' });
      appsServiceFluxUsageStub.returns({ status: 'success', data: 'usage data' });
      appsServiceListRunningAppsStub.returns({ status: 'success', data: 'listRunningApps data' });
      appsServiceAppsResourcesStub.returns({ status: 'success', data: 'appsResources data' });
      appsServiceGetAppHashesStub.returns({ status: 'success', data: [{ height: 694000, message: true }] });
      explorerServiceStub.returns({ status: 'error', data: 'getScannedHeight data' });
      fluxCommunicationStub.returns({ status: 'success', data: 'connectedPeersInfo data' });
      fluxNetworkHelperStub.returns({ status: 'success', data: 'getIncomingConnectionsInfo data' });
      syncthingServiceStub.returns({ status: 'success', data: 'syncthingVersion data' });

      const res = generateResponse();

      await fluxService.getFluxInfo(undefined, res);

      sinon.assert.calledOnceWithMatch(res.json, {
        status: 'error',
        data: { code: undefined, name: undefined, message: 'getScannedHeight data' },
      });
    });

    it('should return error if fluxCommunication returns error', async () => {
      daemonServiceControlRpcsStub.returns({ status: 'success', data: 'info data' });
      daemonServiceFluxnodeRpcsStub.returns({ status: 'success', data: 'status data' });
      benchmarkServiceGetInfoStub.returns({ status: 'success', data: 'info2 data' });
      benchmarkServiceGetStatusStub.returns({ status: 'success', data: 'status2 data' });
      benchmarkServiceGetBenchmarksStub.returns({ status: 'success', data: 'benchmarks data' });
      appsServiceFluxUsageStub.returns({ status: 'success', data: 'usage data' });
      appsServiceListRunningAppsStub.returns({ status: 'success', data: 'listRunningApps data' });
      appsServiceAppsResourcesStub.returns({ status: 'success', data: 'appsResources data' });
      appsServiceGetAppHashesStub.returns({ status: 'success', data: [{ height: 694000, message: true }] });
      explorerServiceStub.returns({ status: 'success', data: 'getScannedHeight data' });
      fluxCommunicationStub.returns({ status: 'error', data: 'connectedPeersInfo data' });
      fluxNetworkHelperStub.returns({ status: 'success', data: 'getIncomingConnectionsInfo data' });
      syncthingServiceStub.returns({ status: 'success', data: 'syncthingVersion data' });

      const res = generateResponse();

      await fluxService.getFluxInfo(undefined, res);

      sinon.assert.calledOnceWithMatch(res.json, {
        status: 'error',
        data: { code: undefined, name: undefined, message: 'connectedPeersInfo data' },
      });
    });

    it('should return error if fluxNetworkHelperStub returns error', async () => {
      daemonServiceControlRpcsStub.returns({ status: 'success', data: 'info data' });
      daemonServiceFluxnodeRpcsStub.returns({ status: 'success', data: 'status data' });
      benchmarkServiceGetInfoStub.returns({ status: 'success', data: 'info2 data' });
      benchmarkServiceGetStatusStub.returns({ status: 'success', data: 'status2 data' });
      benchmarkServiceGetBenchmarksStub.returns({ status: 'success', data: 'benchmarks data' });
      appsServiceFluxUsageStub.returns({ status: 'success', data: 'usage data' });
      appsServiceListRunningAppsStub.returns({ status: 'success', data: 'listRunningApps data' });
      appsServiceAppsResourcesStub.returns({ status: 'success', data: 'appsResources data' });
      appsServiceGetAppHashesStub.returns({ status: 'success', data: [{ height: 694000, message: true }] });
      explorerServiceStub.returns({ status: 'success', data: 'getScannedHeight data' });
      fluxCommunicationStub.returns({ status: 'success', data: 'connectedPeersInfo data' });
      fluxNetworkHelperStub.returns({ status: 'error', data: 'getIncomingConnectionsInfo data' });
      syncthingServiceStub.returns({ status: 'success', data: 'syncthingVersion data' });

      const res = generateResponse();

      await fluxService.getFluxInfo(undefined, res);

      sinon.assert.calledOnceWithMatch(res.json, {
        status: 'error',
        data: { code: undefined, name: undefined, message: 'getIncomingConnectionsInfo data' },
      });
    });
  });

  describe('routerIP tests', () => {
    const generateResponse = () => {
      const res = { test: 'testing' };
      res.status = sinon.stub().returns(res);
      res.json = sinon.fake((param) => param);
      return res;
    };

    afterEach(() => {
      sinon.restore();
    });

    // The router address is installer-recorded network topology. On ArcaneOS flux-configd
    // owns the file and renders it from the installer yaml; elsewhere this was the last
    // thing FluxOS wrote to config/userconfig.js.
    it('should refuse to adjust the router IP, naming where it is set', async () => {
      const res = generateResponse();

      await fluxService.adjustRouterIP({ params: { routerip: '192.168.1.50' } }, res);

      sinon.assert.calledOnce(res.json);
      const [reply] = res.json.firstCall.args;
      expect(reply.status).to.equal('error');
      expect(reply.data.code).to.equal(410);
      expect(reply.data.message).to.include('configuration TUI');
    });

    it('should refuse without consulting privilege, since there is no state to protect', async () => {
      const verifyPrivilegeStub = sinon.stub(verificationHelper, 'verifyPrivilege');
      const res = generateResponse();

      await fluxService.adjustRouterIP({ params: {} }, res);

      sinon.assert.notCalled(verifyPrivilegeStub);
      sinon.assert.calledOnceWithMatch(res.json, { status: 'error' });
    });
  });

  describe('apiport tests', () => {
    afterEach(() => {
      sinon.restore();
    });

    it('should read back the configured api port', () => {
      const res = generateResponse();

      fluxService.getAPIPort(undefined, res);

      sinon.assert.calledOnceWithMatch(res.json, { status: 'success' });
    });

    // The port also lives in fluxbench's own config, which FluxOS cannot write, and
    // fluxbench's copy is the one the network resolves this node by — so adjusting it
    // here only ever produced a node listening on one port and announcing another.
    it('should refuse to adjust the api port, naming where it is set', async () => {
      const res = generateResponse();

      await fluxService.adjustAPIPort({ params: { apiport: 16137 } }, res);

      sinon.assert.calledOnce(res.json);
      const [reply] = res.json.firstCall.args;
      expect(reply.status).to.equal('error');
      expect(reply.data.code).to.equal(410);
      expect(reply.data.message).to.include('fluxbench.conf');
    });

    it('should refuse to adjust blocked ports', async () => {
      const res = generateResponse();

      await fluxService.adjustBlockedPorts({ body: { blockedPorts: [8080] } }, res);

      const [reply] = res.json.firstCall.args;
      expect(reply.status).to.equal('error');
      expect(reply.data.code).to.equal(410);
    });

    it('should refuse to adjust blocked repositories', async () => {
      const res = generateResponse();

      await fluxService.adjustBlockedRepositories({ body: { blockedRepositories: ['a/b'] } }, res);

      const [reply] = res.json.firstCall.args;
      expect(reply.status).to.equal('error');
      expect(reply.data.code).to.equal(410);
    });
  });

  describe('getNodeTier tests', () => {
    let generalServiceNodeTierStub;
    let generalServiceNodeCollateralStub;
    beforeEach(() => {
      generalServiceNodeTierStub = sinon.stub(generalService, 'nodeTier');
      generalServiceNodeCollateralStub = sinon.stub(generalService, 'nodeCollateral');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return error if values are not correct', async () => {
      generalServiceNodeTierStub.returns('test');
      generalServiceNodeCollateralStub.returns('1');
      const res = generateResponse();
      const expectedResponse = {
        data: {
          code: undefined,
          message: 'Unrecognised Flux node tier',
          name: 'Error',
        },
        status: 'error',
      };

      await fluxService.getNodeTier(undefined, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
    });

    it('should return cumulus if tier is basic and collateral is 10000', async () => {
      generalServiceNodeTierStub.returns('basic');
      generalServiceNodeCollateralStub.returns(10000);
      const res = generateResponse();
      const expectedResponse = { status: 'success', data: 'cumulus' };

      await fluxService.getNodeTier(undefined, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
    });

    it('should return nimbus if tier is super and collateral is 25000', async () => {
      generalServiceNodeTierStub.returns('super');
      generalServiceNodeCollateralStub.returns(25000);
      const res = generateResponse();
      const expectedResponse = { status: 'success', data: 'nimbus' };

      await fluxService.getNodeTier(undefined, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
    });

    it('should return stratus if tier is bamf and collateral is 100000', async () => {
      generalServiceNodeTierStub.returns('bamf');
      generalServiceNodeCollateralStub.returns(100000);
      const res = generateResponse();
      const expectedResponse = { status: 'success', data: 'stratus' };

      await fluxService.getNodeTier(undefined, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
    });

    it('should return cumulus_new if tier is basic and collateral is 1000', async () => {
      generalServiceNodeTierStub.returns('basic');
      generalServiceNodeCollateralStub.returns(1000);
      const res = generateResponse();
      const expectedResponse = { status: 'success', data: 'cumulus_new' };

      await fluxService.getNodeTier(undefined, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
    });

    it('should return nimbus_new if tier is super and collateral is 12500', async () => {
      generalServiceNodeTierStub.returns('super');
      generalServiceNodeCollateralStub.returns(12500);
      const res = generateResponse();
      const expectedResponse = { status: 'success', data: 'nimbus_new' };

      await fluxService.getNodeTier(undefined, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
    });

    it('should return stratus_new if tier is bamf and collateral is 40000', async () => {
      generalServiceNodeTierStub.returns('bamf');
      generalServiceNodeCollateralStub.returns(40000);
      const res = generateResponse();
      const expectedResponse = { status: 'success', data: 'stratus_new' };

      await fluxService.getNodeTier(undefined, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
    });
  });

  describe('streamChain tests', () => {
    let osStub;
    // eslint-disable-next-line no-unused-vars
    let readdirStub;
    let daemonServiceUtilsStub;
    let tarPackStub;

    beforeEach(() => {
      osStub = sinon.stub(os, 'homedir');
      // Reset and configure the shared fs stubs for streamChain tests
      if (!fsPromisesStubs.stat || typeof fsPromisesStubs.stat.resetHistory !== 'function') {
        fsPromisesStubs.stat = sinon.stub();
      } else {
        fsPromisesStubs.stat.resetHistory();
      }
      if (!fsPromisesStubs.readdir || typeof fsPromisesStubs.readdir.resetHistory !== 'function') {
        fsPromisesStubs.readdir = sinon.stub();
      } else {
        fsPromisesStubs.readdir.resetHistory();
      }

      daemonServiceUtilsStub = sinon.stub(daemonServiceUtils, 'buildFluxdClient');
      tarPackStub = sinon.stub(tar, 'create');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return 422 if streaming is disabled', async () => {
      const res = generateResponse();
      fluxService.disableStreaming();

      await fluxService.streamChain(null, res);

      expect(res.statusMessage).to.equal('Failed minimium throughput criteria. Disabled.');
      expect(fluxService.getStreamLock()).to.equal(false);

      sinon.assert.calledWithExactly(res.status, 422);
      sinon.assert.calledOnce(res.end);
      fluxService.enableStreaming();
    });

    it('should return 503 if a stream is already in progress', async () => {
      const res = generateResponse();
      fluxService.lockStreamLock();

      await fluxService.streamChain(null, res);

      expect(res.statusMessage).to.equal('Streaming of chain already in progress, server busy.');
      expect(fluxService.getStreamLock()).to.equal(true);
      sinon.assert.calledWithExactly(res.status, 503);
      sinon.assert.calledOnce(res.end);
      fluxService.unlockStreamLock();
    });

    it('should lock if no other streams are in progress', async () => {
      // add this test
    });

    it('should return 400 if Fluxnode is behind a proxy', async () => {
      const res = generateResponse();
      const req = { socket: { remoteAddress: '' } };

      await fluxService.streamChain(req, res);

      expect(res.statusMessage).to.equal('Socket closed.');
      sinon.assert.calledWithExactly(res.status, 400);
      sinon.assert.calledOnce(res.end);
    });

    it('should return 403 if request if from a public IP address', async () => {
      const res = generateResponse();
      const req = { socket: { remoteAddress: '1.2.3.4' } };

      await fluxService.streamChain(req, res);

      expect(res.statusMessage).to.equal('Request must be from an address on the same private network as the host.');
      sinon.assert.calledWithExactly(res.status, 403);
      sinon.assert.calledOnce(res.end);
    });

    it('should return 500 if any chain folders are missing', async () => {
      const res = generateResponse();
      const req = { socket: { remoteAddress: '10.20.30.40' } };

      osStub.returns('/home/testuser');

      fsPromisesStubs.stat.rejects(new Error("Test block dir doesn't exist"));

      await fluxService.streamChain(req, res);

      expect(res.statusMessage).to.equal('Unable to find chain');
      sinon.assert.calledWithExactly(res.status, 500);
      sinon.assert.calledOnce(res.end);
    });

    it('should return 422 if unsafe and compression requested', async () => {
      const res = generateResponse();
      const req = { socket: { remoteAddress: '10.20.30.40' }, body: { unsafe: true, compress: true } };

      osStub.returns('/home/testuser');
      // Use callsFake to ensure each call to stat returns the right value
      fsPromisesStubs.stat.callsFake(async () => ({ isDirectory: () => true }));

      await fluxService.streamChain(req, res);

      expect(res.statusMessage).to.equal('Unable to compress blockchain in unsafe mode, it will corrupt new db.');
      sinon.assert.calledWithExactly(res.status, 422);
      sinon.assert.calledOnce(res.end);
    });

    it('should return 503 when fluxd still running when in safe mode', async () => {
      const res = generateResponse();
      const req = { socket: { remoteAddress: '10.20.30.40' } };

      osStub.returns('/home/testuser');
      fsPromisesStubs.stat.resolves({ isDirectory: () => true });
      daemonServiceUtilsStub.resolves({ run: async () => 123456 });

      await fluxService.streamChain(req, res);

      expect(res.statusMessage).to.equal('Flux daemon still running, unable to clone blockchain.');
      sinon.assert.calledWithExactly(res.status, 503);
      sinon.assert.calledOnce(res.end);
    });

    it('should set Approx-Content-Length response header with expected value', async () => {
      const received = [];

      const req = { socket: { remoteAddress: '10.20.30.40' } };

      const res = new Writable({
        write(chunk, encoding, done) {
          received.push(chunk.toString());
          done();
        },
      });

      res.setHeader = sinon.stub();

      let count = 0;
      const readable = new Readable({
        read() {
          this.push('test');
          if (count === 3) this.push(null);
          count += 1;
        },
      });

      osStub.returns('/home/testuser');

      const createFile = (name) => ({
        name,
        isDirectory: () => false,
        isFile: () => true,
      });

      const folderCount = 3;
      const testFileSize = 1048576;
      const testFiles = [...Array(50).keys()].map((x) => createFile(x.toString()));
      const headerSize = testFiles.length * 512 * folderCount;
      const eof = 1024;
      const totalFileSize = testFiles.length * testFileSize * folderCount;
      const expectedSize = headerSize + totalFileSize + eof;

      const daemonServiceError = new Error();
      daemonServiceError.code = 'ECONNREFUSED';

      fsPromisesStubs.stat.resolves({
        isDirectory: () => true,
        size: testFileSize,
      });

      fsPromisesStubs.readdir.resolves(testFiles);

      daemonServiceUtilsStub.resolves({ run: async () => daemonServiceError });
      tarPackStub.returns(readable);

      // Stub serviceHelper.dirInfo to return expected data for each folder
      const dirInfoStub = sinon.stub(serviceHelper, 'dirInfo');
      dirInfoStub.resolves({
        count: testFiles.length, // 50 files per folder
        size: testFiles.length * testFileSize, // total size per folder
      });

      await fluxService.streamChain(req, res);
      sinon.assert.calledWithExactly(res.setHeader, 'Approx-Content-Length', expectedSize.toString());
    });

    it('should stream chain uncompressed when no compression requested', async () => {
      const received = [];

      const req = { socket: { remoteAddress: '10.20.30.40' } };
      const daemonServiceError = new Error();
      daemonServiceError.code = 'ECONNREFUSED';

      const res = new Writable({
        write(chunk, encoding, done) {
          received.push(chunk.toString());
          done();
        },
      });

      res.setHeader = sinon.stub();

      let count = 0;
      const readable = new Readable({
        read() {
          this.push('test');
          if (count === 3) this.push(null);
          count += 1;
        },
      });

      osStub.returns('/home/testuser');
      fsPromisesStubs.stat.resolves({ isDirectory: () => true });
      daemonServiceUtilsStub.resolves({ run: async () => daemonServiceError });
      tarPackStub.returns(readable);

      await fluxService.streamChain(req, res);
      expect(received).to.deep.equal(['test', 'test', 'test', 'test']);
    });

    it('should stream chain compressed when compression requested', async () => {
      const received = [];

      const req = { socket: { remoteAddress: '10.20.30.40' }, body: { compress: true } };

      const daemonServiceError = new Error();
      daemonServiceError.code = 'ECONNREFUSED';

      const res = zlib.createGunzip();
      res.setHeader = sinon.stub();

      res.on('data', (data) => {
        // this gets all data in buffer
        received.push(data.toString());
      });

      res.on('end', () => { });

      let count = 0;
      const readable = new Readable({
        read() {
          this.push('test');
          if (count === 3) this.push(null);
          count += 1;
        },
      });

      osStub.returns('/home/testuser');
      fsPromisesStubs.stat.resolves({ isDirectory: () => true });
      daemonServiceUtilsStub.resolves({ run: async () => daemonServiceError });
      tarPackStub.returns(readable);

      await fluxService.streamChain(req, res);
      expect(received).to.deep.equal(['testtesttesttest']);
    });
  });
});
