'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
// Real registry singleton - un-stubbed in proxyquire, so the module under test and the test share it.
const operationRegistry = require('../../ZelBack/src/services/utils/operationRegistry');
const {
  loadSpecLibrary, V8_SUBMISSION, v8Spec, v9Spec, sealedV9Spec, instantiatedSpec, assertAnswers,
} = require('./fixtures/fluxSpec');

// The spec library is real here, not stubbed — see tests/unit/fixtures/fluxSpec.js.
// This is the query layer over stored app state, so what appsRepository hands back
// is what it really hands back: hydrated InstantiatedSpec objects, cleartext or
// node-sealed. What stays stubbed is I/O and policy — mongo through dbHelper,
// docker, the repository itself, and the message wrapper.
//
// The docker literals below are Docker API responses and the location/permanent
// message literals are mongo rows; neither is a spec double, and both stay as they are.
let flux;

// A second real Flux ID, so "the last registration wins" is a comparison between two
// real owners rather than between two placeholder strings the library would refuse.
const OTHER_OWNER = '16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1';

describe('appQueryService tests', () => {
  let appQueryService;
  let dbHelperStub;
  let messageHelperStub;
  let dockerServiceStub;
  let registryManagerStub;

  let appsRepositoryStub;
  let logStub;
  let configStub;

  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(30000);
    flux = await loadSpecLibrary();
  });

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
      // What listInstalledApps really resolves: hydrated InstantiatedSpec objects,
      // version-mixed the way the local collection is. installedApps maps
      // serialize() over them, so the answer is the stored wire form, not a summary.
      const rows = [
        await instantiatedSpec(await v8Spec({ name: 'appone' }), { hash: 'h1', height: 100 }),
        await instantiatedSpec(await v9Spec({ name: 'apptwo' }), { hash: 'h2', height: 200 }),
      ];
      const expected = rows.map((row) => row.serialize());

      appsRepositoryStub.listInstalledApps.resolves(rows);
      messageHelperStub.createDataMessage.callsFake((data) => ({ status: 'success', data }));

      const result = await appQueryService.installedApps();

      expect(result).to.deep.equal({ status: 'success', data: expected });
      expect(result.data.map((doc) => doc.version), 'the list is version-mixed').to.deep.equal([8, 9]);
      expect(appsRepositoryStub.listInstalledApps.calledOnce).to.be.true;

      // The repository stays stubbed, so nothing here exercises what the real one
      // returns — assert the rows crossing that boundary answer what production
      // calls on them.
      rows.forEach((row) => assertAnswers(row, ['serialize']));

      // messageHelper stays stubbed too, and the real one only wraps its payload for
      // res.json. The payload is a stored row, so the real deserializer must read it
      // straight back: this endpoint is where a peer's `/apps/installedapps` answer
      // comes from, and a shape hydrate cannot read is a shape nobody can consume.
      const [payload] = messageHelperStub.createDataMessage.firstCall.args;
      payload.forEach((doc) => {
        expect(flux.InstantiatedSpec.deserialize(doc)).to.be.instanceOf(flux.InstantiatedSpec);
      });
    });

    // An enterprise app is stored node-sealed. The endpoint must be able to answer
    // for it, and the answer must stay sealed.
    it('serves a node-sealed app without leaking its cleartext', async () => {
      const row = await instantiatedSpec(
        await sealedV9Spec({ name: 'sealedapp' }), { hash: 'hs9', height: 900 },
      );

      appsRepositoryStub.listInstalledApps.resolves([row]);
      messageHelperStub.createDataMessage.callsFake((data) => ({ status: 'success', data }));

      const result = await appQueryService.installedApps();

      const [doc] = result.data;
      expect(doc.version).to.equal(9);
      expect(doc).to.have.property('encrypted');
      expect(doc, 'the cleartext component set must not be served').to.not.have.property('components');
      // The cleartext summary survives, which is what a caller sizes the app from.
      expect(doc.resources).to.exist;
      expect(flux.InstantiatedSpec.deserialize(doc).spec).to.be.instanceOf(flux.EncryptedSpecV9);
      // And the round-trip above is not vacuous: a sealed row binds its cleartext
      // metadata into the AAD, so one extra storage field is refused outright.
      expect(
        () => flux.InstantiatedSpec.deserialize({ ...doc, replica: 'r1' }),
        'a decorated sealed doc must be refused, or the round-trip proves nothing',
      ).to.throw(/unexpected fields/);
    });

    it('should return installed apps with specific appname from query', async () => {
      const row = await instantiatedSpec(await v8Spec({ name: 'appone' }), { hash: 'h1', height: 100 });
      const req = {
        params: { appname: 'appone' },
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };

      appsRepositoryStub.listInstalledApps.resolves([row]);
      messageHelperStub.createDataMessage.callsFake((data) => ({ status: 'success', data }));

      await appQueryService.installedApps(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(appsRepositoryStub.listInstalledApps.firstCall.args[0])
        .to.deep.equal({ filter: { name: 'appone' } });
      expect(res.json.firstCall.args[0]).to.deep.equal({ status: 'success', data: [row.serialize()] });
    });

    it('should handle string parameter for appname', async () => {
      const row = await instantiatedSpec(await v8Spec({ name: 'appone' }), { hash: 'h1', height: 100 });

      appsRepositoryStub.listInstalledApps.resolves([row]);
      messageHelperStub.createDataMessage.callsFake((data) => ({ status: 'success', data }));

      const result = await appQueryService.installedApps('appone');

      expect(result).to.deep.equal({ status: 'success', data: [row.serialize()] });
      expect(appsRepositoryStub.listInstalledApps.firstCall.args[0])
        .to.deep.equal({ filter: { name: 'appone' } });
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
      const rows = [
        await instantiatedSpec(await v8Spec({ name: 'appone' }), { hash: 'h1', height: 100 }),
        await instantiatedSpec(await v9Spec({ name: 'apptwo' }), { hash: 'h2', height: 200 }),
      ];
      const expected = rows.map((row) => row.serialize());
      const res = {
        json: sinon.stub(),
      };
      const req = {
        params: { appname: 'appName' },
        query: {},
      };

      appsRepositoryStub.listInstalledApps.resolves(rows);
      messageHelperStub.createDataMessage.callsFake((data) => ({ status: 'success', data }));

      await appQueryService.installedApps(req, res);

      expect(res.json.calledOnceWith({ status: 'success', data: expected })).to.be.true;
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
      // Permanent messages are mongo rows, but the spec nested in one is the real
      // wire form. The owner the endpoint reads is the spec's own owner, and the
      // placeholder these rows used to carry is not an address at all:
      expect(
        () => flux.FluxAppSpecV8.fromSubmission({ ...V8_SUBMISSION, owner: 'owner1' }),
        'the real class refuses a placeholder owner',
      ).to.throw(/Flux ID/);

      const firstRegistration = await v8Spec({ name: 'testapp' });
      const lastRegistration = await v8Spec({ name: 'testapp', owner: OTHER_OWNER });
      expect(firstRegistration.owner).to.not.equal(lastRegistration.owner);

      const mockMessages = [
        { appSpecifications: firstRegistration.serialize(), height: 100, type: 'fluxappregister' },
        { appSpecifications: lastRegistration.serialize(), height: 200, type: 'fluxappregister' },
      ];
      const mockDb = {
        db: sinon.stub().returns('appsDatabase'),
      };

      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findInDatabase.resolves(mockMessages);
      messageHelperStub.createDataMessage.callsFake((data) => ({ status: 'success', data }));

      await appQueryService.getApplicationOriginalOwner(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(dbHelperStub.findInDatabase.calledOnce).to.be.true;
      // The newest registration wins, and it is a real address.
      expect(res.json.firstCall.args[0])
        .to.deep.equal({ status: 'success', data: lastRegistration.owner });
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
