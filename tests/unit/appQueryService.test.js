'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
// Real registry singleton - un-stubbed in proxyquire, so the module under test and the test share it.
const operationRegistry = require('../../ZelBack/src/services/utils/operationRegistry');
const { asConfig } = require('./fixtures/config');
const {
  loadSpecLibrary, V8_SUBMISSION, v8Spec, v9Spec, sealedV9Spec, registeredSpec, assertAnswers,
} = require('./fixtures/fluxSpec');
const { installedRecord } = require('./fixtures/appRecords');
const appsRuntimeState = require('../../ZelBack/src/services/appManagement/appsRuntimeState');
const appReconciler = require('../../ZelBack/src/services/appMonitoring/appReconciler');
const globalState = require('../../ZelBack/src/services/utils/globalState');

// The spec library is real here, not stubbed — see tests/unit/fixtures/fluxSpec.js.
// This is the query layer over stored app state, so what appsRepository hands back
// is what it really hands back: hydrated RegisteredSpec objects, cleartext or
// node-sealed. What stays stubbed is I/O and policy — mongo through dbHelper,
// docker, the repository itself, and the message wrapper.
//
// The docker literals below are Docker API responses and the location/permanent
// message literals are mongo rows; neither is a spec double, and both stay as they are.
let flux;

// A second real Flux ID, so "the last registration wins" is a comparison between two
// real owners rather than between two placeholder strings the library would refuse.
const OTHER_OWNER = '1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm';

describe('appQueryService tests', () => {
  let appQueryService;
  let appHistoryStub;
  let dbHelperStub;
  let messageHelperStub;
  let dockerServiceStub;
  let deploymentProviderStub;
  let registryManagerStub;

  let installedStub;
  let nodeSpecsStub;
  let logStub;
  let configStub;

  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(30_000);
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

    deploymentProviderStub = { listInstalledDeploymentsDetailed: sinon.stub().resolves({ deployments: [], unreadableApps: new Map() }) };
    dockerServiceStub = {
      dockerListContainers: sinon.stub(),
      // Namespacing, rather than returning a constant: these tests assert which
      // containers survive the filter, so a stub that waved everything through
      // would stop testing anything. The real one is pinned by its own cases in
      // dockerService.test.js.
      // The real one is the identifier itself.
      getAppIdentifier: (identifier) => identifier,
      // mirrors the real ownership test: the identity label is authoritative, the
      // name test survives only for containers created before labels shipped
      // mirrors the real helper: the identifier label is authoritative, the name is
      // read only for a container created before labels shipped
      containerIdentifier: ({ labels, name }, { LABEL_KEYS: labelKeys }) => {
        if (labels && labels[labelKeys.IDENTIFIER]) return labels[labelKeys.IDENTIFIER];
        return name ? name.replace(/^\//, '').replace(/^flux/, '') : null;
      },
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


    installedStub = {
      byName: sinon.stub().resolves(null),
      apps: sinon.stub().resolves([]),
      names: sinon.stub().resolves([]),
    };

    nodeSpecsStub = { getNodeSpecs: sinon.stub().resolves({ cpuCores: 8, ram: 16_000, ssdStorage: 500 }) };

    logStub = {
      error: sinon.stub(),
      info: sinon.stub(),
      warn: sinon.stub(),
    };

    // Proxy require
    appHistoryStub = { latestApplied: sinon.stub().resolves(null) };
    appQueryService = proxyquire('../../ZelBack/src/services/appQuery/appQueryService', {
      config: asConfig(configStub),
      '../appDecisions/appHistory': appHistoryStub,
      '../dbHelper': dbHelperStub,
      '../messageHelper': messageHelperStub,
      '../dockerService': dockerServiceStub,
      '../appRuntime/deploymentProvider': deploymentProviderStub,
      '../appDatabase/registryManager': registryManagerStub,
      '../appDatabase/appRecords': { hostedInstances: () => installedStub },
      '../appRequirements/nodeSpecs': nodeSpecsStub,
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
      // What listInstalledApps really resolves: hydrated RegisteredSpec objects,
      // version-mixed the way the local collection is. installedApps maps
      // serialize() over them, so the answer is the stored wire form, not a summary.
      const rows = [
        await registeredSpec(await v8Spec({ name: 'appone' }), { hash: 'h1', height: 100 }),
        await registeredSpec(await v9Spec({ name: 'apptwo' }), { hash: 'h2', height: 200 }),
      ];
      const expected = rows.map((row) => row.serialize());

      installedStub.apps.resolves(rows.map((row) => installedRecord(row)));

      const result = await appQueryService.installedApps();

      expect(result).to.deep.equal(expected);
      expect(result.map((doc) => doc.version), 'the list is version-mixed').to.deep.equal([8, 9]);
      expect(installedStub.apps.calledOnce).to.be.true;

      // The repository stays stubbed, so nothing here exercises what the real one
      // returns — assert the rows crossing that boundary answer what production
      // calls on them.
      rows.forEach((row) => assertAnswers(row, ['serialize']));

      // Each answer is a stored row, so the real deserializer must read it straight
      // back: this is where a peer's `/apps/installedapps` answer comes from, and a
      // shape hydrate cannot read is a shape nobody can consume.
      result.forEach((doc) => {
        expect(flux.RegisteredSpec.deserialize(doc, { chain: flux.Chain.MAIN })).to.be.instanceOf(flux.RegisteredSpec);
      });
    });

    // The hosted instance is this node's: its replica, a removal in progress and
    // the component keys it derived never leave the node, and the keys hold
    // component names an encrypted app keeps sealed.
    it('serves each app\'s registered record, none of the hosted instance\'s own fields', async () => {
      const row = await registeredSpec(await v9Spec({ name: 'apptwo' }), { hash: 'h2', height: 200 });
      installedStub.apps.resolves([new flux.HostedInstance({
        record: row, replica: 'r1', owed: { since: 1, reason: 'expired' }, componentKeys: new Map([['web', `c${'b'.repeat(51)}a`]]),
      })]);

      const result = await appQueryService.installedApps();

      expect(result).to.deep.equal([row.serialize()]);
      for (const field of flux.HOSTED_FIELDS) expect(result[0], field).to.not.have.property(field);
    });

    // An enterprise app is stored node-sealed. The endpoint must be able to answer
    // for it, and the answer must stay sealed.
    it('serves a node-sealed app without leaking its cleartext', async () => {
      const row = await registeredSpec(
        await sealedV9Spec({ name: 'sealedapp' }), { hash: 'hs9', height: 900 },
      );

      installedStub.apps.resolves([installedRecord(row)]);

      const [doc] = await appQueryService.installedApps();

      expect(doc.version).to.equal(9);
      expect(doc).to.have.property('encrypted');
      expect(doc, 'the cleartext component set must not be served').to.not.have.property('components');
      // The cleartext summary survives, which is what a caller sizes the app from.
      expect(doc.resources).to.exist;
      expect(flux.RegisteredSpec.deserialize(doc, { chain: flux.Chain.MAIN }).spec).to.be.instanceOf(flux.SealedSpecV9);
      // And the round-trip above is not vacuous: a sealed row binds its cleartext
      // metadata into the AAD, so one extra storage field is refused outright.
      expect(
        () => flux.RegisteredSpec.deserialize({ ...doc, replica: 'r1' }, { chain: flux.Chain.MAIN }),
        'a decorated sealed doc must be refused, or the round-trip proves nothing',
      ).to.throw(/unexpected fields/);
    });

    it('answers one app by name', async () => {
      const row = await registeredSpec(await v8Spec({ name: 'appone' }), { hash: 'h1', height: 100 });
      installedStub.byName.resolves(installedRecord(row));

      const result = await appQueryService.installedApps('appone');

      expect(result).to.deep.equal([row.serialize()]);
      sinon.assert.calledOnceWithExactly(installedStub.byName, 'appone');
      sinon.assert.notCalled(installedStub.apps);
    });

    it('answers nothing for a name this node does not host', async () => {
      const result = await appQueryService.installedApps('elsewhere');

      expect(result).to.deep.equal([]);
    });

    it('throws when the hosted instances cannot be read', async () => {
      installedStub.apps.rejects(new Error('Database error'));

      let thrown = null;
      try { await appQueryService.installedApps(); } catch (error) { thrown = error; }

      expect(thrown?.message).to.equal('Database error');
    });
  });

  describe('installedAppsAPI', () => {
    const res = () => ({ json: sinon.stub() });

    it('answers the app named in the path', async () => {
      const row = await registeredSpec(await v8Spec({ name: 'appone' }), { hash: 'h1', height: 100 });
      installedStub.byName.resolves(installedRecord(row));
      messageHelperStub.createDataMessage.callsFake((data) => ({ status: 'success', data }));
      const response = res();

      await appQueryService.installedAppsAPI({ params: { appname: 'appone' }, query: {} }, response);

      sinon.assert.calledOnceWithExactly(installedStub.byName, 'appone');
      sinon.assert.calledOnceWithExactly(response.json, { status: 'success', data: [row.serialize()] });
    });

    it('answers the app named in the query', async () => {
      const row = await registeredSpec(await v8Spec({ name: 'appone' }), { hash: 'h1', height: 100 });
      installedStub.byName.resolves(installedRecord(row));
      messageHelperStub.createDataMessage.callsFake((data) => ({ status: 'success', data }));
      const response = res();

      await appQueryService.installedAppsAPI({ params: {}, query: { appname: 'appone' } }, response);

      sinon.assert.calledOnceWithExactly(installedStub.byName, 'appone');
      sinon.assert.calledOnceWithExactly(response.json, { status: 'success', data: [row.serialize()] });
    });

    it('answers every hosted app when none is named', async () => {
      const rows = [
        await registeredSpec(await v8Spec({ name: 'appone' }), { hash: 'h1', height: 100 }),
        await registeredSpec(await v9Spec({ name: 'apptwo' }), { hash: 'h2', height: 200 }),
      ];
      installedStub.apps.resolves(rows.map((row) => installedRecord(row)));
      messageHelperStub.createDataMessage.callsFake((data) => ({ status: 'success', data }));
      const response = res();

      await appQueryService.installedAppsAPI({ params: {}, query: {} }, response);

      sinon.assert.calledOnceWithExactly(response.json, { status: 'success', data: rows.map((row) => row.serialize()) });
    });

    it('answers an error message when the hosted instances cannot be read', async () => {
      const error = new Error('Database error');
      installedStub.apps.rejects(error);
      messageHelperStub.createErrorMessage.returns({ status: 'error', data: { message: 'Database error' } });
      const response = res();

      await appQueryService.installedAppsAPI({ params: {}, query: {} }, response);

      sinon.assert.calledOnceWithExactly(response.json, { status: 'error', data: { message: 'Database error' } });
      sinon.assert.calledWith(logStub.error, error);
    });
  });

  describe('fluxUsage', () => {
    const running = (...names) => names.map((name) => ({
      Names: [`/${name}`], HostConfig: {}, NetworkSettings: {}, Mounts: [],
    }));

    it('counts installed, running and stopped apps and reports the node specs', async () => {
      installedStub.names.resolves(['a', 'b', 'c']);
      dockerServiceStub.dockerListContainers.resolves(running('fluxapp1', 'fluxapp2', 'other'));
      messageHelperStub.createDataMessage.callsFake((data) => ({ status: 'success', data }));
      const res = { json: sinon.stub() };

      await appQueryService.fluxUsageAPI({}, res);

      const { data } = res.json.firstCall.args[0];
      expect(data).to.deep.equal({
        totalApps: 3, runningApps: 2, stoppedApps: 1, nodeSpecs: { cpuCores: 8, ram: 16_000, ssdStorage: 500 },
      });
    });

    it('answers a programmatic caller', async () => {
      installedStub.names.resolves([]);
      dockerServiceStub.dockerListContainers.resolves([]);
      messageHelperStub.createDataMessage.callsFake((data) => ({ status: 'success', data }));

      const result = await appQueryService.fluxUsage();

      expect(result.totalApps).to.equal(0);
    });

    it('counts no running apps when the container list cannot be read', async () => {
      installedStub.names.resolves(['a']);
      dockerServiceStub.dockerListContainers.rejects(new Error('docker down'));
      messageHelperStub.createDataMessage.callsFake((data) => ({ status: 'success', data }));
      messageHelperStub.createErrorMessage.returns({ status: 'error' });
      const res = { json: sinon.stub() };

      await appQueryService.fluxUsageAPI({}, res);

      expect(res.json.firstCall.args[0].data.runningApps).to.equal(0);
    });

    it('answers an error when the installed apps cannot be counted', async () => {
      installedStub.names.rejects(new Error('Database error'));
      messageHelperStub.createErrorMessage.returns({ status: 'error' });
      const res = { json: sinon.stub() };

      await appQueryService.fluxUsageAPI({}, res);

      expect(res.json.firstCall.args[0].status).to.equal('error');
    });
  });

  describe('listRunningContainers', () => {
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
      dockerServiceStub.dockerListContainers.resolves(mockContainers);

      const result = await appQueryService.listRunningContainers();

      expect(result.map((app) => app.Names[0])).to.deep.equal(['/flux_app1', '/zel_app2']);
      expect(dockerServiceStub.dockerListContainers.calledWith(false)).to.be.true;
    });

    it('should return empty array when no flux apps are running', async () => {
      dockerServiceStub.dockerListContainers.resolves([]);

      expect(await appQueryService.listRunningContainers()).to.deep.equal([]);
    });

    it('throws when docker cannot list the containers', async () => {
      dockerServiceStub.dockerListContainers.rejects(new Error('Docker error'));

      let thrown = null;
      try { await appQueryService.listRunningContainers(); } catch (error) { thrown = error; }

      expect(thrown?.message).to.equal('Docker error');
    });

    // The running containers must report an app under backup/restore as running even
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
        const result = await appQueryService.listRunningContainers();

        const names = result.map((app) => app.Names[0]);
        expect(names, 'backed-up app must still be reported as running').to.include('/fluxwww_a1b2c3d4e5f6');
      } finally {
        operationRegistry.release('App');
      }
    });

  });

  // A container docker reports in full, so every assertion below is about what
  // reaches the caller rather than about what the stub was told to return.
  const dockerContainer = {
    Id: '9f2c1b0e4d3a',
    Names: ['/fluxwww_App'],
    Image: 'someregistry.example/private:1.2.3',
    ImageID: 'sha256:0123456789abcdef',
    Command: '/entrypoint.sh --serve',
    Created: 1_700_000_000,
    Ports: [{ PrivatePort: 8080, PublicPort: 31_000, Type: 'tcp' }],
    Labels: { 'org.opencontainers.image.revision': 'a1b2c3d4' },
    State: 'running',
    Status: 'Up 2 hours',
    HostConfig: {},
    NetworkSettings: {},
    Mounts: [],
  };

  describe('publicContainerView', () => {
    // The whole key set, not a list of fields that must be absent: a view built
    // from three names cannot grow a fourth, and this is the assertion that says
    // so. A field docker adds in a future version fails here rather than being
    // published until someone reads a listing and notices.
    it('carries three fields and nothing else', () => {
      const [view] = appQueryService.publicContainerView([dockerContainer]);

      expect(Object.keys(view).sort()).to.deep.equal(['Names', 'State', 'Status']);
    });

    it('reports nothing of the image, its entrypoint, its ports or its build', () => {
      const [view] = appQueryService.publicContainerView([dockerContainer]);

      ['Id', 'Image', 'ImageID', 'Command', 'Ports', 'Labels', 'Created'].forEach((field) => {
        expect(view, field).to.not.have.property(field);
      });
    });

    // FDM builds /flux{component}_{app} and matches Names[0] exactly, failing
    // closed when it does not - a bare name, or one with the prefix stripped,
    // takes every g: app out of routing.
    it("keeps Names as docker's array, verbatim", () => {
      const [view] = appQueryService.publicContainerView([dockerContainer]);

      expect(view.Names).to.deep.equal(['/fluxwww_App']);
      expect(view.State).to.equal('running');
      expect(view.Status).to.equal('Up 2 hours');
    });

    it('leaves the container it was given untouched', () => {
      const container = { ...dockerContainer };

      appQueryService.publicContainerView([container]);

      expect(container).to.deep.equal(dockerContainer);
    });

    it('answers an empty listing with an empty view', () => {
      expect(appQueryService.publicContainerView([])).to.deep.equal([]);
    });
  });

  describe('listRunningAppsAPI', () => {
    it('answers with the public view rather than the container object', async () => {
      dockerServiceStub.dockerListContainers.resolves([dockerContainer]);
      messageHelperStub.createDataMessage.callsFake((data) => ({ status: 'success', data }));
      const res = { json: sinon.stub() };

      await appQueryService.listRunningAppsAPI({}, res);

      expect(res.json.calledOnce).to.be.true;
      expect(res.json.firstCall.args[0]).to.deep.equal({
        status: 'success',
        data: [{ Names: ['/fluxwww_App'], State: 'running', Status: 'Up 2 hours' }],
      });
    });

    // The route is cached, and apicache keys on the request URL alone, so an
    // answer given to one caller is the answer every later caller gets. Two
    // different callers therefore have to be handed the same thing.
    it('answers the same whoever is asking', async () => {
      dockerServiceStub.dockerListContainers.resolves([dockerContainer]);
      messageHelperStub.createDataMessage.callsFake((data) => ({ status: 'success', data }));
      const anonymous = { json: sinon.stub() };
      const authenticated = { json: sinon.stub() };

      await appQueryService.listRunningAppsAPI({ headers: {} }, anonymous);
      await appQueryService.listRunningAppsAPI({ headers: { zelidauth: 'zelid=x&signature=y' } }, authenticated);

      expect(authenticated.json.firstCall.args[0]).to.deep.equal(anonymous.json.firstCall.args[0]);
    });

    it('answers docker\'s error as an error message', async () => {
      dockerServiceStub.dockerListContainers.rejects(new Error('Docker error'));
      messageHelperStub.createErrorMessage.returns({ status: 'error', data: { message: 'Docker error' } });
      const res = { json: sinon.stub() };

      await appQueryService.listRunningAppsAPI({}, res);

      expect(res.json.calledOnceWith({ status: 'error', data: { message: 'Docker error' } })).to.be.true;
    });
  });

  describe('activeStandbyComponents', () => {
    // What a balancer routing an activeStandby app is told: which of these components
    // this node runs or holds, named by the app's identity and never by component name.
    const IDENTITY = `b${'c'.repeat(52)}`;
    const activeStandbyV9 = async () => flux.DeploymentSpec.fromSpec(await v9Spec({
      components: {
        db: {
          name: 'db',
          description: 'the store one node writes',
          image: 'postgres:16',
          cpu: 0.5,
          memory: 300,
          rootFsGb: 2,
          persistentStorage: {
            sizeGb: 5,
            mounts: { '/var/lib/postgresql/data': { source: 'data', destination: '/var/lib/postgresql/data' } },
            sync: { mode: 'activeStandby' },
          },
        },
        web: {
          name: 'web',
          description: 'runs on every instance',
          image: 'nginx:latest',
          cpu: 0.5,
          memory: 300,
          rootFsGb: 2,
          ports: { http: { containerPort: 80, hostPort: 31_000 } },
        },
      },
    }), '/apps/', { replica: null, identity: IDENTITY, registrationVersion: 9 });

    const identifierOf = (deployment, name) => deployment.componentEntries()
      .find(([componentName]) => componentName === name)[1].identifier;

    const report = async ({
      deployments, running = [], committed = [], stopped = [], unreadable = new Map(),
    }) => {
      deploymentProviderStub.listInstalledDeploymentsDetailed.resolves({ deployments, unreadableApps: unreadable });
      dockerServiceStub.dockerListContainers.resolves(
        running.map((name) => ({ Names: [`/${name}`], Labels: { 'io.runonflux.identifier': name } })),
      );
      sinon.stub(appReconciler, 'committedIdentifiers').returns(committed);
      sinon.stub(appsRuntimeState, 'operatorStoppedIdentifiers').resolves(stopped);
      return appQueryService.activeStandbyComponents();
    };

    it('reports a running activeStandby component by identity, and not the components every instance runs', async () => {
      const deployment = await activeStandbyV9();
      const result = await report({
        deployments: [deployment],
        running: [identifierOf(deployment, 'db'), identifierOf(deployment, 'web')],
      });

      expect(result).to.deep.equal({ components: [{ identity: IDENTITY, replica: null, state: 'running' }], unreadable: [] });
    });

    it('reports one its operator stopped as held', async () => {
      const deployment = await activeStandbyV9();
      const result = await report({ deployments: [deployment], stopped: [identifierOf(deployment, 'db')] });

      expect(result.components).to.deep.equal([{ identity: IDENTITY, replica: null, state: 'held' }]);
    });

    it('reports one the reconciler is starting as held', async () => {
      const deployment = await activeStandbyV9();
      const result = await report({ deployments: [deployment], committed: [identifierOf(deployment, 'db')] });

      expect(result.components).to.deep.equal([{ identity: IDENTITY, replica: null, state: 'held' }]);
    });

    it('leaves out one this node neither runs nor holds', async () => {
      const deployment = await activeStandbyV9();
      const result = await report({ deployments: [deployment], running: [identifierOf(deployment, 'web')] });

      expect(result.components).to.deep.equal([]);
    });

    it('lists an app it cannot read by identity, so absence is never mistaken for "not here"', async () => {
      const result = await report({ deployments: [], unreadable: new Map([[IDENTITY, 'myapp']]) });

      expect(result).to.deep.equal({ components: [], unreadable: [IDENTITY] });
    });

    it('reports an app registered before v9 by its identity too', async () => {
      const deployment = flux.DeploymentSpec.fromSpec(
        await v8Spec({ compose: [{ ...V8_SUBMISSION.compose[0], containerData: 'g:/tmp' }] }),
        '/apps/',
        { replica: null, identity: IDENTITY, registrationVersion: 8 },
      );
      const [[, component]] = deployment.componentEntries();
      const result = await report({ deployments: [deployment], running: [component.identifier] });

      expect(result.components).to.deep.equal([{ identity: IDENTITY, replica: null, state: 'running' }]);
    });
  });

  describe('heldComponents', () => {
    // What a peer mid-election is told this node owns. Answering short here is not
    // a stale reading - it is a second container started on a volume this node is
    // already writing, which corrupts it.

    // The three sources, each independently switchable, because the point of every
    // case below is which one carried the answer.
    // A running container is ours by its identity label; one made before the
    // labels shipped is recognised by its legacy prefix.
    const held = async ({
      running = [], committed = [], stopped = [], strangers = [],
    } = {}) => {
      dockerServiceStub.dockerListContainers.resolves([
        ...running.map((name) => ({ Names: [`/${name}`], Labels: { 'io.runonflux.identifier': name } })),
        ...strangers.map((name) => ({ Names: [`/${name}`], Labels: {} })),
      ]);
      sinon.stub(appReconciler, 'committedIdentifiers').returns(committed);
      sinon.stub(appsRuntimeState, 'operatorStoppedIdentifiers').resolves(stopped);
      messageHelperStub.createDataMessage.returnsArg(0);
      return appQueryService.heldComponents();
    };

    it('reports a component the operator stopped, with no container and nothing committed', async () => {
      // The regression. `appstop` is durable and node-local: the election skips
      // this node and the reconciler leaves the container down. Before this, none
      // of that reached a peer - it saw no container, no commitment, and elected a
      // new primary over an owner who had stopped theirs to work on it.
      const result = await held({ stopped: ['www_App'] });

      expect(result).to.deep.equal(['www_App']);
    });

    it('reports a stopped identifier as the docker name the caller asks about, which is the identifier', async () => {
      const result = await held({ stopped: ['www_App', 'zelKadena'] });

      expect(result).to.deep.equal(['www_App', 'zelKadena']);
    });

    it('unions the three sources and reports each component once', async () => {
      const result = await held({
        running: ['www_App'],
        committed: ['www_App'],
        stopped: ['www_App'],
      });

      expect(result).to.deep.equal(['www_App']);
    });

    it('reports a component of an app registered before v9 under its 8.x name as well', async () => {
      // The deployment this node runs for an app registered on v8 and since
      // moved onto its identity: the container is named by the identity, the
      // folder id is still the 8.x container name, and a peer that has not
      // moved, or runs 8.x, asks by that name.
      const deployment = flux.DeploymentSpec.fromSpec(await v9Spec({ name: 'myapp' }), '/apps/', { replica: null, identity: 'bident', registrationVersion: 8 });
      deploymentProviderStub.listInstalledDeploymentsDetailed.resolves({ deployments: [deployment], unreadableApps: new Map() });
      const [identifier] = deployment.componentEntries().map(([, c]) => c.identifier);

      const result = await held({ running: [identifier] });

      expect(result).to.deep.equal([identifier, 'fluxweb_myapp']);
    });

    // Each source is the SOLE carrier of one name. Feeding all three the same
    // identifier pins the dedup but says nothing about the sources themselves:
    // a dropped source loses nothing there, and the pre-start window committed
    // exists for - installed, not yet running, invisible to a peer - would be
    // lost with no test able to see it.
    it('reports a component that only one source carries, for each source', async () => {
      const result = await held({
        running: ['a_App'],
        committed: ['b_App'],
        stopped: ['c_App'],
      });

      expect(result).to.deep.equal(['a_App', 'b_App', 'c_App']);
    });

    it('still reports a running container that carries no lock and no commitment, and never a container that is not ours', async () => {
      const result = await held({ running: ['api_App'], strangers: ['nostalgic_hopper'] });

      expect(result).to.deep.equal(['api_App']);
    });

    it('holds nothing when the node holds nothing', async () => {
      expect(await held()).to.deep.equal([]);
    });

    it('fails the request when the lock store cannot be read, rather than answering short', async () => {
      // A peer reads a short answer as "free". Both failure directions have to land
      // in the error path so the caller sees a node that could not answer, not a
      // node that answered nothing.
      dockerServiceStub.dockerListContainers.resolves([{ Names: ['/fluxwww_App'] }]);
      sinon.stub(appReconciler, 'committedIdentifiers').returns([]);
      sinon.stub(appsRuntimeState, 'operatorStoppedIdentifiers').rejects(new Error('no primary available'));
      messageHelperStub.createErrorMessage.returns({ status: 'error' });

      const result = await appQueryService.heldComponents();

      expect(result).to.deep.equal({ status: 'error' });
      expect(messageHelperStub.createDataMessage.called, 'answered with a list built from a failed read').to.be.false;
    });
  });

  describe('promotedFolders', () => {

    afterEach(() => {
      globalState.promotedFolderIds = new Set();
    });

    it('reports the folders this node holds writable, from the monitor set', async () => {
      globalState.promotedFolderIds = new Set(['fluxa_a', 'fluxb_b']);
      messageHelperStub.createDataMessage.returnsArg(0);

      const result = await appQueryService.promotedFolders();

      expect(result).to.deep.equal({ ready: true, folders: ['fluxa_a', 'fluxb_b'] });
    });

    it('answers not-ready before the monitor has ever read the folder config', async () => {
      // The state that made this necessary: holding nothing and not having looked
      // are the same empty set but opposite answers, and a booting node that IS
      // holding a folder would otherwise read as free and be promoted alongside.
      globalState.promotedFolderIds = null;
      messageHelperStub.createDataMessage.returnsArg(0);

      const result = await appQueryService.promotedFolders();

      expect(result).to.deep.equal({ ready: false, folders: [] });
    });

    it('distinguishes holding nothing from not having looked', async () => {
      globalState.promotedFolderIds = new Set();
      messageHelperStub.createDataMessage.returnsArg(0);

      const result = await appQueryService.promotedFolders();

      expect(result.folders).to.deep.equal([]);
      expect(result.ready, 'an empty set after a real read is a genuine answer').to.equal(true);
    });

    it('touches no backend, so an anonymous caller cannot amplify into syncthing', async () => {
      // The route is unauthenticated and the API has no rate limiting, so this
      // must answer from memory rather than reading syncthing per request.
      globalState.promotedFolderIds = new Set(['fluxa_a']);
      messageHelperStub.createDataMessage.returnsArg(0);

      await appQueryService.promotedFolders();

      expect(dockerServiceStub.dockerListContainers.called).to.be.false;
    });

    it('drops a folder that is no longer promoted', async () => {
      // The monitor replaces the set wholesale from the folder config each pass, so
      // a demotion or an uninstall leaves by simply not being rebuilt - there is no
      // separate removal path that could be missed.
      globalState.promotedFolderIds = new Set(['fluxa_a', 'fluxb_b']);
      messageHelperStub.createDataMessage.returnsArg(0);

      globalState.promotedFolderIds = new Set(['fluxa_a']); // b demoted to receiveonly
      const result = await appQueryService.promotedFolders();

      expect(result.folders).to.deep.equal(['fluxa_a']);
    });

    describe('holdings', () => {
      let verificationHelperStub;
      let fluxNetworkHelperStub;
      let fluxCommunicationUtilsStub;
      let holdingsService;
      const signed = (over = {}) => ({
        target: '10.0.0.9:16127', timestamp: Date.now(), pubKey: 'PUB', signature: 'SIG', ...over,
      });

      beforeEach(() => {
        // Who the caller is: team privilege, a node's signature, the freshness of the
        // request and the address it names. Stubbed here, on a load of its own.
        verificationHelperStub = { verifyPrivilege: sinon.stub().resolves(false) };
        fluxNetworkHelperStub = {
          getLocalSocketAddress: sinon.stub().resolves('10.0.0.9:16127'),
          verifySignedFluxnodeMessage: sinon.stub().resolves(false),
        };
        fluxCommunicationUtilsStub = {
          verifyTimestampInFluxBroadcast: sinon.stub().returns(true),
          BROADCAST_CLOCK_SKEW_MS: 120_000,
        };
        holdingsService = proxyquire('../../ZelBack/src/services/appQuery/appQueryService', {
          config: asConfig(configStub),
          '../dbHelper': dbHelperStub,
          '../messageHelper': messageHelperStub,
          '../dockerService': dockerServiceStub,
          '../appRuntime/deploymentProvider': deploymentProviderStub,
          '../appDatabase/registryManager': registryManagerStub,
          '../appDatabase/appRecords': { hostedInstances: () => installedStub },
          '../../lib/log': logStub,
          '../verificationHelper': verificationHelperStub,
          '../fluxNetworkHelper': fluxNetworkHelperStub,
          '../fluxCommunicationUtils': fluxCommunicationUtilsStub,
        });
        globalState.promotedFolderIds = new Set(['fluxa_a']);
        globalState.folderHoldings = new Map([['fluxa_a', { bytes: 5_821_604_997, newestModified: 200 }]]);
        messageHelperStub.createDataMessage.returnsArg(0);
      });

      afterEach(() => {
        globalState.folderHoldings = null;
      });

      it('serves the holdings to a node on the deterministic list', async () => {
        fluxNetworkHelperStub.verifySignedFluxnodeMessage.resolves(true);

        const result = await holdingsService.promotedFolderHoldings({ body: signed() });

        expect(result.holding).to.deep.equal({ fluxa_a: { bytes: 5_821_604_997, newestModified: 200 } });
      });

      it('serves the holdings to the flux team', async () => {
        verificationHelperStub.verifyPrivilege.resolves(true);

        const result = await holdingsService.promotedFolderHoldings({ body: {}, headers: { zelidauth: 'x' } });

        expect(result.holding).to.deep.equal({ fluxa_a: { bytes: 5_821_604_997, newestModified: 200 } });
      });

      // Each of these is a caller that is not entitled. The answer still carries the
      // open half, so nothing a peer already relied on regresses.
      [
        ['nothing is signed', {}],
        ['the signature does not verify', signed()],
      ].forEach(([what, body]) => {
        it(`withholds the holdings when ${what}`, async () => {
          const result = await holdingsService.promotedFolderHoldings({ body });

          expect(result.holding, 'holdings went to a caller that proved nothing').to.equal(undefined);
          expect(result).to.deep.equal({ ready: true, folders: ['fluxa_a'] });
        });
      });

      // A request stamped for next year is not stale, so the freshness check passes it
      // forever. That is the one a node can mint on purpose: signed once against a
      // chosen target, the body itself authorises whoever holds it, so publishing it
      // hands out what this endpoint exists to keep to nodes. Skew is bounded; choosing
      // when your own request expires is not skew.
      it('withholds the holdings from a request stamped beyond the clock-skew bound', async () => {
        fluxNetworkHelperStub.verifySignedFluxnodeMessage.resolves(true);

        const result = await holdingsService.promotedFolderHoldings({
          body: signed({ timestamp: Date.now() + (365 * 24 * 60 * 60 * 1000) }),
        });

        expect(result.holding, 'a body dated in the future served as a credential').to.equal(undefined);
        expect(result).to.deep.equal({ ready: true, folders: ['fluxa_a'] });
      });

      // The bound is the fleet's clocks disagreeing, which is honest and must still work.
      it('serves a request from a node whose clock runs a little ahead', async () => {
        fluxNetworkHelperStub.verifySignedFluxnodeMessage.resolves(true);

        const result = await holdingsService.promotedFolderHoldings({
          body: signed({ timestamp: Date.now() + 60_000 }),
        });

        expect(result.holding, 'a peer 60s ahead is skew, not a forged expiry').to.deep.equal({
          fluxa_a: { bytes: 5_821_604_997, newestModified: 200 },
        });
      });

      // The route is open, so the ORDER the checks run in is part of its contract: a
      // caller that has proved nothing gets nothing done on its behalf. Own-address is
      // the first thing here that reaches outside the body, and the value behind it is
      // cached with an expiry - so whoever is at the door when it lapses should be a
      // caller that verified. Asserted on the call rather than the verdict, because the
      // verdict is the same under either order and only this separates them.
      it('looks nothing up about itself for a caller that did not verify', async () => {
        fluxNetworkHelperStub.verifySignedFluxnodeMessage.resolves(false);

        const result = await holdingsService.promotedFolderHoldings({ body: signed() });

        expect(result.holding).to.equal(undefined);
        sinon.assert.called(fluxNetworkHelperStub.verifySignedFluxnodeMessage);
        sinon.assert.notCalled(fluxNetworkHelperStub.getLocalSocketAddress);
      });

      // The signature VERIFIES here, so the address is the only thing that can refuse
      // it - which is the whole of what binding to a recipient buys: a body captured in
      // flight is a valid signature by a real node, and must still not work elsewhere.
      it('withholds the holdings when the request is addressed to another node', async () => {
        fluxNetworkHelperStub.verifySignedFluxnodeMessage.resolves(true);

        const result = await holdingsService.promotedFolderHoldings({ body: signed({ target: '10.0.0.8:16127' }) });

        expect(result.holding, 'a signature captured in flight worked on another node').to.equal(undefined);
        expect(result).to.deep.equal({ ready: true, folders: ['fluxa_a'] });
      });

      it('withholds the holdings when this node does not know its own address', async () => {
        fluxNetworkHelperStub.verifySignedFluxnodeMessage.resolves(true);
        fluxNetworkHelperStub.getLocalSocketAddress.resolves(null);

        const result = await holdingsService.promotedFolderHoldings({ body: signed() });

        expect(result.holding, 'a node that cannot say who it is accepted a request naming anyone').to.equal(undefined);
      });

      it('withholds the holdings when the request is too old to be fresh', async () => {
        fluxNetworkHelperStub.verifySignedFluxnodeMessage.resolves(true);
        fluxCommunicationUtilsStub.verifyTimestampInFluxBroadcast.returns(false);

        const result = await holdingsService.promotedFolderHoldings({ body: signed() });

        expect(result.holding, 'a captured request stayed usable').to.equal(undefined);
      });

      it('does not ask whether a caller with no signature is a node', async () => {
        await holdingsService.promotedFolderHoldings({ body: { target: '10.0.0.9:16127' } });

        expect(fluxNetworkHelperStub.verifySignedFluxnodeMessage.called).to.equal(false);
      });
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

  });

  describe('listAllAppsApi', () => {
    it('answers with the public view rather than the container object', async () => {
      dockerServiceStub.dockerListContainers.resolves([
        { ...dockerContainer, State: 'exited', Status: 'Exited (0) 5 minutes ago' },
      ]);
      messageHelperStub.createDataMessage.callsFake((data) => ({ status: 'success', data }));
      const res = { json: sinon.stub() };

      await appQueryService.listAllAppsApi({}, res);

      expect(res.json.calledOnce).to.be.true;
      expect(res.json.firstCall.args[0]).to.deep.equal({
        status: 'success',
        data: [{ Names: ['/fluxwww_App'], State: 'exited', Status: 'Exited (0) 5 minutes ago' }],
      });
    });

    it('answers docker\'s error as an error message', async () => {
      const error = new Error('Docker error');

      dockerServiceStub.dockerListContainers.rejects(error);
      messageHelperStub.createErrorMessage.returns({ status: 'error', data: { message: 'Docker error' } });
      const res = { json: sinon.stub() };

      await appQueryService.listAllAppsApi({}, res);

      expect(res.json.calledOnceWith({ status: 'error', data: { message: 'Docker error' } })).to.be.true;
      expect(logStub.error.calledWith(error)).to.be.true;
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
        () => flux.FluxAppSpecV8.fromSubmission({ ...V8_SUBMISSION, owner: 'owner1' }, { chain: flux.Chain.MAIN }),
        'the real class refuses a placeholder owner',
      ).to.throw(/Flux ID/);

      const registration = await v8Spec({ name: 'testapp', owner: OTHER_OWNER });
      appHistoryStub.latestApplied.resolves({ message: { appSpecifications: registration.serialize() }, decision: {} });
      messageHelperStub.createDataMessage.callsFake((data) => ({ status: 'success', data }));

      await appQueryService.getApplicationOriginalOwner(req, res);

      // The owner of the latest registration the chain applied, and a real address.
      sinon.assert.calledOnceWithExactly(appHistoryStub.latestApplied, 'testapp', { type: 'registration' });
      expect(res.json.firstCall.args[0]).to.deep.equal({ status: 'success', data: OTHER_OWNER });
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
