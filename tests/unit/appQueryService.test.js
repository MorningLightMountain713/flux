'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
// Real registry singleton - un-stubbed in proxyquire, so the module under test and the test share it.
const operationRegistry = require('../../ZelBack/src/services/utils/operationRegistry');

describe('appQueryService tests', () => {
  let appQueryService;
  let dbHelperStub;
  let messageHelperStub;
  let dockerServiceStub;
  let registryManagerStub;

  let appsRepositoryStub;
  let logStub;
  let configStub;

  beforeEach(() => {
    // Config stub
    configStub = {
      database: {
        daemon: {
          collections: {
            scannedHeight: 'scannedHeight',
            appsHashes: 'appsHashes',
          },
        },
        appslocal: {
          collections: {
            appsInformation: 'localAppsInformation',
          },
          database: 'localapps',
        },
        appsglobal: {
          collections: {
            appsMessages: 'appsMessages',
            appsInformation: 'globalAppsInformation',
            appsTemporaryMessages: 'appsTemporaryMessages',
            appsInstallingLocations: 'appsInstallingLocations',
            appsInstallingErrorsLocations: 'appsInstallingErrorsLocations',
          },
          database: 'globalapps',
        },
      },
      fluxapps: {
        latestAppSpecification: 1,
      },
    };

    // Stubs
    dbHelperStub = {
      databaseConnection: sinon.stub(),
      findInDatabase: sinon.stub(),
      findOneInDatabase: sinon.stub(),
    };

    messageHelperStub = {
      createDataMessage: sinon.stub(),
      createErrorMessage: sinon.stub(),
    };

    dockerServiceStub = {
      dockerListContainers: sinon.stub(),
      // mirrors the real ownership test: the identity label is authoritative, the
      // name test survives only for containers created before labels shipped
      isManagedContainer: ({ labels, name }, labelKeys) => {
        if (labels && labels[labelKeys.IDENTIFIER]) return true;
        if (!name) return false;
        const bare = name.startsWith('/') ? name.slice(1) : name;
        return bare.startsWith('flux') || bare.startsWith('zel');
      },
      // mirrors the real helper: the app label is authoritative, the name is read
      // only for pre-label containers, and BOTH prefixes are stripped by width
      containerAppName: ({ labels, name }, labelKeys) => {
        const labelled = labels && labels[labelKeys.APP];
        if (labelled) return labelled;
        if (!name) return null;
        let bare = name.startsWith('/') ? name.slice(1) : name;
        if (bare.startsWith('flux')) bare = bare.slice(4);
        else if (bare.startsWith('zel')) bare = bare.slice(3);
        return bare.split('_')[1] || bare;
      },
    };

    registryManagerStub = {
      appLocation: sinon.stub(),
      appInstallingLocation: sinon.stub(),
    };

    appsRepositoryStub = {
      listInstalledApps: sinon.stub(),
    };

    logStub = {
      error: sinon.stub(),
      info: sinon.stub(),
      warn: sinon.stub(),
    };

    // Proxy require
    appQueryService = proxyquire('../../ZelBack/src/services/appQuery/appQueryService', {
      config: configStub,
      '../dbHelper': dbHelperStub,
      '../messageHelper': messageHelperStub,
      '../dockerService': dockerServiceStub,
      '../appDatabase/registryManager': registryManagerStub,
      '../appDatabase/appsRepository': appsRepositoryStub,
      '../../lib/log': logStub,
      '../utils/specLibs': {
        getSpecBackend: async () => ({
          LABEL_KEYS: { IDENTIFIER: 'io.runonflux.identifier', APP: 'io.runonflux.app' },
        }),
      },
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('installedApps', () => {
    it('should return installed apps from database', async () => {
      const mockApps = [
        { name: 'app1', version: 4 },
        { name: 'app2', version: 3 },
      ];

      appsRepositoryStub.listInstalledApps.resolves(mockApps.map((d) => ({ serialize: () => d })));
      messageHelperStub.createDataMessage.returns({ status: 'success', data: mockApps });

      const result = await appQueryService.installedApps();

      expect(result).to.deep.equal({ status: 'success', data: mockApps });
      expect(appsRepositoryStub.listInstalledApps.calledOnce).to.be.true;
      expect(messageHelperStub.createDataMessage.calledWith(mockApps)).to.be.true;
    });

    it('should return installed apps with specific appname from query', async () => {
      const mockApp = { name: 'app1', version: 4 };
      const req = {
        params: { appname: 'app1' },
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };

      appsRepositoryStub.listInstalledApps.resolves([mockApp].map((d) => ({ serialize: () => d })));
      messageHelperStub.createDataMessage.returns({ status: 'success', data: [mockApp] });

      await appQueryService.installedApps(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(appsRepositoryStub.listInstalledApps.calledOnce).to.be.true;
    });

    it('should handle string parameter for appname', async () => {
      const mockApp = [{ name: 'app1', version: 4 }];

      appsRepositoryStub.listInstalledApps.resolves(mockApp.map((d) => ({ serialize: () => d })));
      messageHelperStub.createDataMessage.returns({ status: 'success', data: mockApp });

      const result = await appQueryService.installedApps('app1');

      expect(result).to.deep.equal({ status: 'success', data: mockApp });
      expect(appsRepositoryStub.listInstalledApps.calledOnce).to.be.true;
    });

    it('should return error message on database failure', async () => {
      const error = new Error('Database error');

      appsRepositoryStub.listInstalledApps.rejects(error);
      messageHelperStub.createErrorMessage.returns({ status: 'error', data: { message: 'Database error' } });

      const result = await appQueryService.installedApps();

      expect(result.status).to.equal('error');
      expect(messageHelperStub.createErrorMessage.calledOnce).to.be.true;
      expect(logStub.error.calledWith(error)).to.be.true;
    });

    it('should return apps data with response passed', async () => {
      const mockApps = [
        { name: 'app1', version: 4 },
        { name: 'app2', version: 3 },
      ];
      const res = {
        json: sinon.stub(),
      };
      const req = {
        params: { appname: 'appName' },
        query: {},
      };

      appsRepositoryStub.listInstalledApps.resolves(mockApps.map((d) => ({ serialize: () => d })));
      messageHelperStub.createDataMessage.returns({ status: 'success', data: mockApps });

      await appQueryService.installedApps(req, res);

      expect(res.json.calledOnceWith({ status: 'success', data: mockApps })).to.be.true;
    });

    it('should return error with response passed on database failure', async () => {
      const error = new Error('Database error');
      const res = {
        json: sinon.stub(),
      };
      const req = 'appName';

      appsRepositoryStub.listInstalledApps.rejects(error);
      messageHelperStub.createErrorMessage.returns({ status: 'error', data: { message: 'Database error' } });

      await appQueryService.installedApps(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(logStub.error.calledWith(error)).to.be.true;
    });
  });

  describe('listRunningApps', () => {
    it('should return running flux apps', async () => {
      const mockContainers = [
        {
          Names: ['/flux_app1'], HostConfig: {}, NetworkSettings: {}, Mounts: [],
        },
        {
          Names: ['/zel_app2'], HostConfig: {}, NetworkSettings: {}, Mounts: [],
        },
        {
          Names: ['/other_app'], HostConfig: {}, NetworkSettings: {}, Mounts: [],
        },
      ];
      const expectedApps = [
        { Names: ['/flux_app1'] },
        { Names: ['/zel_app2'] },
      ];

      dockerServiceStub.dockerListContainers.resolves(mockContainers);
      messageHelperStub.createDataMessage.returns({ status: 'success', data: expectedApps });

      const result = await appQueryService.listRunningApps();

      expect(result).to.deep.equal({ status: 'success', data: expectedApps });
      expect(dockerServiceStub.dockerListContainers.calledWith(false)).to.be.true;
    });

    it('should return empty array when no flux apps are running', async () => {
      dockerServiceStub.dockerListContainers.resolves([]);
      messageHelperStub.createDataMessage.returns({ status: 'success', data: [] });

      const result = await appQueryService.listRunningApps();

      expect(result).to.deep.equal({ status: 'success', data: [] });
    });

    it('should handle docker service errors', async () => {
      const error = new Error('Docker error');

      dockerServiceStub.dockerListContainers.rejects(error);
      messageHelperStub.createErrorMessage.returns({ status: 'error', data: { message: 'Docker error' } });

      const result = await appQueryService.listRunningApps();

      expect(result.status).to.equal('error');
      expect(logStub.error.calledWith(error)).to.be.true;
    });

    // listRunningApps must report an app under backup/restore as running even
    // though its container is deliberately stopped, so the network (FDM, peers)
    // does not react to the stop. The backup/restore leases are keyed by bare MAIN
    // APP name (exactly as appendBackupTask acquires them); container names are
    // component identifiers - the lookup must compare the main app name.
    it('includes a stopped container of an app under backup as running', async () => {
      // hold a backup lease on the real registry (un-stubbed) and clean up.
      operationRegistry.acquire('App', 'backup', 'test'); // bare main-app name (production format)
      try {
        // the container states its own app: the identifier segment is the app's
        // identity, which is not a name and would match no backup lease
        const stoppedContainer = {
          Names: ['/fluxwww_a1b2c3d4e5f6'],
          Labels: { 'io.runonflux.identifier': 'www_a1b2c3d4e5f6', 'io.runonflux.app': 'App' },
          State: 'exited',
          HostConfig: {},
          NetworkSettings: {},
          Mounts: [],
        };
        dockerServiceStub.dockerListContainers.withArgs(false).resolves([]); // nothing running
        dockerServiceStub.dockerListContainers.withArgs(true).resolves([stoppedContainer]);
        messageHelperStub.createDataMessage.callsFake((data) => ({ status: 'success', data }));

        const result = await appQueryService.listRunningApps();

        expect(result.status).to.equal('success');
        const names = result.data.map((app) => app.Names[0]);
        expect(names, 'backed-up app must still be reported as running').to.include('/fluxwww_a1b2c3d4e5f6');
      } finally {
        operationRegistry.release('App');
      }
    });

    it('should return running apps with response passed', async () => {
      const mockContainers = [
        {
          Names: ['/flux_app1'], HostConfig: {}, NetworkSettings: {}, Mounts: [],
        },
        {
          Names: ['/zel_app2'], HostConfig: {}, NetworkSettings: {}, Mounts: [],
        },
      ];
      const expectedApps = [
        { Names: ['/flux_app1'] },
        { Names: ['/zel_app2'] },
      ];
      const res = {
        json: sinon.stub(),
      };

      dockerServiceStub.dockerListContainers.resolves(mockContainers);
      messageHelperStub.createDataMessage.returns({ status: 'success', data: expectedApps });

      await appQueryService.listRunningApps(undefined, res);

      expect(res.json.calledOnceWith({ status: 'success', data: expectedApps })).to.be.true;
    });
  });

  describe('listAllApps', () => {
    it('should return all flux apps including stopped ones', async () => {
      const mockContainers = [
        {
          Names: ['/flux_app1'], HostConfig: {}, NetworkSettings: {}, Mounts: [], State: 'running',
        },
        {
          Names: ['/flux_app2'], HostConfig: {}, NetworkSettings: {}, Mounts: [], State: 'exited',
        },
      ];
      const expectedApps = [
        { Names: ['/flux_app1'], State: 'running' },
        { Names: ['/flux_app2'], State: 'exited' },
      ];

      dockerServiceStub.dockerListContainers.resolves(mockContainers);
      messageHelperStub.createDataMessage.returns({ status: 'success', data: expectedApps });

      const result = await appQueryService.listAllApps();

      expect(result).to.deep.equal({ status: 'success', data: expectedApps });
      expect(dockerServiceStub.dockerListContainers.calledWith(true)).to.be.true;
    });

    it('should return error if dockerService throws, no response passed', async () => {
      const error = new Error('Docker error');

      dockerServiceStub.dockerListContainers.rejects(error);
      messageHelperStub.createErrorMessage.returns({ status: 'error', data: { message: 'Docker error' } });

      const result = await appQueryService.listAllApps();

      expect(result.status).to.equal('error');
      expect(logStub.error.calledWith(error)).to.be.true;
    });

    it('should return error if dockerService throws, response passed', async () => {
      const res = {
        json: sinon.stub(),
      };
      const error = new Error('Docker error');

      dockerServiceStub.dockerListContainers.rejects(error);
      messageHelperStub.createErrorMessage.returns({ status: 'error', data: { message: 'Docker error' } });

      await appQueryService.listAllApps(undefined, res);

      expect(res.json.calledOnce).to.be.true;
      expect(logStub.error.calledWith(error)).to.be.true;
    });

    it('should return all apps with response passed', async () => {
      const mockContainers = [
        {
          Names: ['/flux_app1'], HostConfig: {}, NetworkSettings: {}, Mounts: [], State: 'running',
        },
        {
          Names: ['/flux_app2'], HostConfig: {}, NetworkSettings: {}, Mounts: [], State: 'exited',
        },
      ];
      const expectedApps = [
        { Names: ['/flux_app1'], State: 'running' },
        { Names: ['/flux_app2'], State: 'exited' },
      ];
      const res = {
        json: sinon.stub(),
      };

      dockerServiceStub.dockerListContainers.resolves(mockContainers);
      messageHelperStub.createDataMessage.returns({ status: 'success', data: expectedApps });

      await appQueryService.listAllApps(undefined, res);

      expect(res.json.calledOnceWith({ status: 'success', data: expectedApps })).to.be.true;
    });
  });

  describe('getlatestApplicationSpecificationAPI', () => {
    it('should return latest app specification version', async () => {
      const req = {};
      const res = {
        json: sinon.stub(),
      };

      messageHelperStub.createDataMessage.returns({ status: 'success', data: 1 });

      await appQueryService.getlatestApplicationSpecificationAPI(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(messageHelperStub.createDataMessage.calledOnce).to.be.true;
    });
  });

  describe('getApplicationOriginalOwner', () => {
    it('should return app owner from permanent messages', async () => {
      const req = {
        params: { appname: 'testapp' },
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };
      const mockMessages = [
        { appSpecifications: { owner: 'owner1', name: 'testapp' }, height: 100 },
        { appSpecifications: { owner: 'owner2', name: 'testapp' }, height: 200 },
      ];
      const mockDb = {
        db: sinon.stub().returns('appsDatabase'),
      };

      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findInDatabase.resolves(mockMessages);
      messageHelperStub.createDataMessage.returns({ status: 'success', data: 'owner2' });

      await appQueryService.getApplicationOriginalOwner(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(dbHelperStub.findInDatabase.calledOnce).to.be.true;
    });

    it('should handle missing appname parameter', async () => {
      const req = {
        params: {},
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };

      messageHelperStub.createErrorMessage.returns({ status: 'error', data: { message: 'No Application Name specified' } });

      await appQueryService.getApplicationOriginalOwner(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(messageHelperStub.createErrorMessage.calledOnce).to.be.true;
    });
  });

  describe('getAppsInstallingLocations', () => {
    it('should return apps installing locations', async () => {
      const mockLocations = [
        { name: 'app1', ip: '192.168.1.1' },
        { name: 'app2', ip: '192.168.1.2' },
      ];
      const req = {};
      const res = {
        json: sinon.stub(),
      };

      registryManagerStub.appInstallingLocation.resolves(mockLocations);
      messageHelperStub.createDataMessage.returns({ status: 'success', data: mockLocations });

      await appQueryService.getAppsInstallingLocations(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(registryManagerStub.appInstallingLocation.calledOnce).to.be.true;
    });

    it('should handle registry manager errors', async () => {
      const req = {};
      const res = {
        json: sinon.stub(),
      };
      const error = new Error('Registry error');

      registryManagerStub.appInstallingLocation.rejects(error);
      messageHelperStub.createErrorMessage.returns({ status: 'error', data: { message: 'Registry error' } });

      await appQueryService.getAppsInstallingLocations(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(logStub.error.calledWith(error)).to.be.true;
    });
  });
});
