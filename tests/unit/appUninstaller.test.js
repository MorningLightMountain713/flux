'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const { installedRecord } = require('./fixtures/appRecords');
const proxyquire = require('proxyquire').noCallThru();
const telemetrySinkCache = require('../../ZelBack/src/services/telemetrySinkCache');
const appTamperingDetectionService = require('../../ZelBack/src/services/appTamperingDetectionService');
// Real registry singleton - un-stubbed in proxyquire, so the uninstaller and the test share it.
const operationRegistry = require('../../ZelBack/src/services/utils/operationRegistry');
const { asConfig } = require('./fixtures/config');
const { AsyncLock } = require('../../ZelBack/src/services/utils/asyncLock');
const realAppConstants = require('../../ZelBack/src/services/utils/appConstants');
const { departingApps: realDepartingApps } = require('../../ZelBack/src/services/utils/globalState');

describe('appUninstaller tests', () => {
  let runtimeStateStub;
  let runCommandStub;
  let volumeServiceStub;
  let appUninstaller;
  let verificationHelperStub;
  let messageHelperStub;
  let logStub;
  let configStub;
  let globalStateStub;
  let broadcastAllStub;
  let dockerServiceStub;
  let installedStub;
  let registryStub;
  let ledgersStub;
  let fluxNetworkHelperStub;
  let upnpServiceStub;
  let syncthingMonitorHelpersStub;
  let fluxShutdowndClientStub;
  let relationshipResolverStub;
  let pendingTeardownStoreStub;
  let mastershipGrantGateStub;
  let meshOrdinalsStub;
  let contentStoreStub;

  beforeEach(() => {
    configStub = {
      database: {
        url: 'mongodb://localhost:27017',
        daemon: {
          collections: { scannedHeight: 'scannedHeight', appsHashes: 'appsHashes' },
          database: 'daemon',
        },
        appslocal: {
          collections: { appsInformation: 'localAppsInformation' },
          database: 'localapps',
        },
        appsglobal: {
          collections: {
            appsMessages: 'appsMessages',
            appsInformation: 'globalAppsInformation',
            appsTemporaryMessages: 'appsTemporaryMessages',
          },
          database: 'globalapps',
        },
      },
      fluxapps: {
        newMinBlocksAllowance: 22_000,
        newMinBlocksAllowanceBlock: 1_000_000,
        minBlocksAllowance: 5000,
        manageCollectorLifecycle: false,
      },
    };

    verificationHelperStub = {
      verifyPrivilege: sinon.stub(),
    };

    messageHelperStub = {
      createErrorMessage: sinon.stub(),
      errUnauthorizedMessage: sinon.stub(),
      createSuccessMessage: sinon.stub().returns({ status: 'success' }),
    };

    logStub = {
      error: sinon.stub(),
      info: sinon.stub(),
      warn: sinon.stub(),
    };

    broadcastAllStub = sinon.stub().resolves();
    globalStateStub = {
      abortInstall: sinon.stub(),
      installAborted: sinon.stub().returns(false),
      runningAppsCache: new Set(),
      trySpawningGlobalAppCache: new Map(),
      // The real marks, which peerNotification reads, and a cycle lock of the shape it holds.
      departingApps: realDepartingApps,
      announceCycle: new AsyncLock(1, { maxHoldMs: 0 }),
    };

    runtimeStateStub = {
      setCondemned: sinon.stub().resolves(),
      remove: sinon.stub().resolves(true),
      removeControllerState: sinon.stub().resolves(),
    };
    dockerServiceStub = {
      appDockerStop: sinon.stub().resolves(),
      appDockerKill: sinon.stub().resolves(),
      appDockerRemove: sinon.stub().resolves(),
      appDockerForceRemove: sinon.stub().resolves(),
      // container gone after a successful remove: the teardown reclaims host storage
      getDockerContainer: sinon.stub().resolves(null),
      appDockerImageRemove: sinon.stub().resolves(),
      dockerListContainers: sinon.stub().resolves([]),
      forceRemoveFluxAppDockerNetwork: sinon.stub().resolves(),
      removeFluxAppDockerNetwork: sinon.stub().resolves(),
      clearFluxRemovedContainers: sinon.stub(),
      getAppIdentifier: sinon.stub().returns('testapp'),
      getBaseAppName: sinon.stub().callsFake((id) => id),
    };

    fluxShutdowndClientStub = {
      SHUTDOWN_REASON: {
        TTL_EXPIRED: 'ttl-expired', USER_CANCEL: 'user-cancel', REDEPLOY: 'redeploy', EVICTION: 'eviction', MANUAL: 'manual',
      },
      beginAppStop: sinon.stub().resolves({ outcome: 'not_arcane' }),
      forceAppStop: sinon.stub().resolves({ outcome: 'forced' }),
      deleteAppPlanBestEffort: sinon.stub().resolves(),
    };

    registryStub = { byName: sinon.stub().resolves(null) };
    // Nothing installed until a test says otherwise, and no ledger for what is.
    installedStub = {
      byName: sinon.stub().resolves(null),
      byReplica: sinon.stub().resolves(null),
      instancesOf: sinon.stub().resolves([]),
      apps: sinon.stub().resolves([]),
      keys: sinon.stub().resolves([]),
      owed: sinon.stub().resolves([]),
      markOwed: sinon.stub().resolves(),
      remove: sinon.stub().resolves(),
    };
    ledgersStub = { byInstance: sinon.stub().resolves(null), remove: sinon.stub().resolves() };

    relationshipResolverStub = {
      isPureFollowerApp: sinon.stub().resolves(false),
      findCascadeWorkloadsRequiring: sinon.stub().resolves([]),
      findUnrequiredInstalledDependencies: sinon.stub().resolves([]),
    };

    pendingTeardownStoreStub = {
      readAllTeardowns: sinon.stub().resolves([]),
      getTeardown: sinon.stub().resolves(null),
      clearTeardown: sinon.stub().resolves(),
      bumpAttempts: sinon.stub().resolves(),
    };

    mastershipGrantGateStub = {
      onComponentTeardown: sinon.stub().resolves(),
    };
    meshOrdinalsStub = { releaseOrdinal: sinon.stub().resolves() };
    contentStoreStub = { removeApp: sinon.stub().resolves() };
    fluxNetworkHelperStub = {
      closeConnection: sinon.stub().resolves(),
      isFirewallActive: sinon.stub().resolves(false),
      allowPort: sinon.stub().resolves(true),
      deleteAllowPortRule: sinon.stub().resolves(),
      getLocalSocketAddress: sinon.stub().resolves('7.7.7.7:16127'),
      getFluxNodePublicKey: sinon.stub().resolves('nodepubkey'),
    };
    upnpServiceStub = { removeMapUpnpPort: sinon.stub().resolves(), isUPNP: sinon.stub().returns(false) };
    syncthingMonitorHelpersStub = { removeSyncthingFolder: sinon.stub().resolves() };

    runCommandStub = sinon.stub().resolves({ error: null, stdout: '', stderr: '' });
    volumeServiceStub = { isPathMounted: sinon.stub().resolves(false) };
    appUninstaller = proxyquire('../../ZelBack/src/services/appLifecycle/appUninstaller', {
      config: asConfig(configStub),
      '../verificationHelper': verificationHelperStub,
      '../messageHelper': messageHelperStub,
      '../serviceHelper': {
        ensureString: sinon.stub().returnsArg(0),
        ensureBoolean: sinon.stub().returnsArg(0),
        ensureNumber: sinon.stub().callsFake((v) => Number(v)),
        delay: sinon.stub().resolves(),
        runCommand: runCommandStub,
      },
      '../dockerService': dockerServiceStub,
      // isPathMounted runs through the real serviceHelper and spawns a process.
      '../utils/volumeService': volumeServiceStub,
      // Left real, this reads the developer's own crontab.
      crontab: { load: (cb) => cb(null, null) },
      '../../lib/log': logStub,
      '../utils/globalState': globalStateStub,
      '../utils/appConstants': { ...realAppConstants, ANNOUNCE_CYCLE_WAIT_MS: 50 },
      '../telemetryConfigService': {
        ensureNode: sinon.stub().resolves(),
        remove: sinon.stub().resolves(),
      },
      // Stubbed so the standalone run never reaches the real imageCacheStore,
      // whose DB fail-safe ("keep") would mask the reference-gated GC under test.
      './imageCacheRetention': {
        shouldRetainImage: sinon.stub().resolves(false),
      },
      '../upnpService': upnpServiceStub,
      '../fluxNetworkHelper': fluxNetworkHelperStub,
      '../generalService': {
        obtainNodeCollateralInformation: sinon.stub().resolves({ txhash: 'txh', txindex: 0 }),
      },
      '../fluxCommunicationMessagesSender': {
        broadcastMessageToOutgoing: sinon.stub().resolves(),
        broadcastMessageToIncoming: sinon.stub().resolves(),
        broadcastMessageToAll: broadcastAllStub,
      },
      '../appDatabase/appRecords': {
        registry: () => registryStub,
        ledgers: () => ledgersStub,
        installed: () => installedStub,
        instanceKey: ({ name, replica }) => `${String(name).toLowerCase()}\u0000${replica ?? ''}`,
      },
      '../appMonitoring/syncthingMonitorHelpers': syncthingMonitorHelpersStub,
      './relationshipResolver': relationshipResolverStub,
      './pendingTeardownStore': pendingTeardownStoreStub,
      '../appManagement/appsRuntimeState': runtimeStateStub,
      '../appRuntime/deploymentProvider': {
        getInstalledDeployment: sinon.stub().resolves(null),
        buildDeployment: sinon.stub().resolves(null),
        localIdentities: sinon.stub().resolves([null]),
      },
      '../appManagement/appInspector': {
        stopAppMonitoring: sinon.stub().resolves(),
      },
      '../utils/fluxShutdowndClient': fluxShutdowndClientStub,
      './mastershipGrantGate': mastershipGrantGateStub,
      '../appMesh/meshOrdinals': meshOrdinalsStub,
      './contentStore': contentStoreStub,
      '../appMesh/meshReconciler': { removeAppMesh: sinon.stub().resolves() },
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  /** A teardown's target: the records' facts and one block per component the ledger names. */
  const target = (doc) => ({
    name: doc.name,
    replica: doc.replica ?? null,
    owner: doc.owner ?? null,
    identity: doc.identity ?? null,
    networkName: doc.networkName ?? null,
    components: doc.components.map((c) => ({
      componentName: c.label,
      identifier: c.identifier,
      image: { reference: c.image ?? null, digest: null },
      hostPorts: (c.ports || []).map((port) => ({ port, opened: [] })),
      volume: c.volume ?? null,
      mountSources: [],
      syncFolder: null,
      aliases: [],
      mesh: null,
      tls: null,
    })),
    owed: {
      since: 1, reason: doc.reason ?? null, force: Boolean(doc.forceKill), broadcast: false, budgetSeconds: doc.shutdownBudgetSeconds ?? 0, attempts: 0,
    },
    source: 'record',
  });

  /** A ledger stand-in holding the given blocks. */
  const ledgerOf = (components, network = { name: 'fluxDockerNetwork_TestApp' }) => ({
    network,
    components,
    component: (name) => components[name] ?? null,
    identifiers: () => Object.values(components).map((block) => block.identifier),
  });

  /** The instances this node hosts of any app asked for: one per replica named. */
  const hosting = (spec, replicas = [null]) => {
    installedStub.instancesOf.callsFake(async (name) => replicas.map((replica) => installedRecord(spec(name), { replica })));
    installedStub.byReplica.callsFake(async (name, replica) => installedRecord(spec(name), { replica }));
  };

  describe('removeAppLocallyApi', () => {
    it('refuses a missing appname by name, rather than dereferencing it', async () => {
      const req = {
        params: {},
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };

      messageHelperStub.createErrorMessage.returns({ status: 'error' });

      await appUninstaller.removeAppLocallyApi(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(logStub.error.called).to.be.true;
      expect(messageHelperStub.createErrorMessage.firstCall.args[0]).to.equal('No Flux App specified');
      expect(messageHelperStub.createErrorMessage.firstCall.args[1]).to.not.equal('TypeError');
    });

    it('rejects a component name without dereferencing an absent appname first', async () => {
      const req = {
        params: { appname: 'component_app' },
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };

      messageHelperStub.createErrorMessage.returns({ status: 'error' });

      await appUninstaller.removeAppLocallyApi(req, res);

      expect(messageHelperStub.createErrorMessage.firstCall.args[0]).to.equal('Components cannot be removed manually');
      expect(verificationHelperStub.verifyPrivilege.called).to.be.false;
    });

    it('should reject unauthorized users', async () => {
      const req = {
        params: { appname: 'testapp' },
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };

      verificationHelperStub.verifyPrivilege.resolves(false);
      messageHelperStub.errUnauthorizedMessage.returns({ status: 'error' });

      await appUninstaller.removeAppLocallyApi(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(verificationHelperStub.verifyPrivilege.called).to.be.true;
    });

    it('should handle missing appname parameter', async () => {
      const req = {
        params: {},
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };

      messageHelperStub.createErrorMessage.returns({ status: 'error' });

      await appUninstaller.removeAppLocallyApi(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(logStub.error.called).to.be.true;
      expect(messageHelperStub.createErrorMessage.firstCall.args[0]).to.equal('No Flux App specified');
      expect(messageHelperStub.createErrorMessage.firstCall.args[1]).to.not.equal('TypeError');
    });

    it('rejects a component name without dereferencing an absent appname first', async () => {
      const req = {
        params: { appname: 'component_app' },
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };

      messageHelperStub.createErrorMessage.returns({ status: 'error' });

      await appUninstaller.removeAppLocallyApi(req, res);

      expect(messageHelperStub.createErrorMessage.firstCall.args[0]).to.equal('Components cannot be removed manually');
      expect(verificationHelperStub.verifyPrivilege.called).to.be.false;
    });
  });

  describe('uninstallComponent: the grant release keys on the data', () => {
    const component = () => ({
      identifier: 'web_TestApp',
      appName: 'TestApp',
      identity: 'ab12cd34ef56',
      name: 'web',
      hasActiveStandbySyncthing: () => true,
    });

    it('a volume-preserving teardown (rebuild-in-place) holds the term', async () => {
      await appUninstaller.uninstallComponent(component(), { removeVolumes: false }).catch(() => {});
      sinon.assert.notCalled(mastershipGrantGateStub.onComponentTeardown);
    });

    it('a volume-destroying teardown releases the grant', async () => {
      await appUninstaller.uninstallComponent(component(), { removeVolumes: true }).catch(() => {});
      sinon.assert.calledOnceWithExactly(
        mastershipGrantGateStub.onComponentTeardown, 'web_TestApp', 'ab12cd34ef56',
      );
    });

    // A redeploy is an explicit "make it run": neither the operator's stop lock nor a
    // stale controller verdict survives it. Never remove(): that takes the run facts
    // too, and a rebuild that then fails would read an established component as one
    // that never ran.
    describe('the component\'s runtime state', () => {
      [false, true].forEach((removeVolumes) => {
        it(`clears the controller state and nothing the component proved, volume ${removeVolumes ? 'recreated' : 'kept'}`, async () => {
          await appUninstaller.uninstallComponent(component(), { removeVolumes });
          sinon.assert.calledOnceWithExactly(runtimeStateStub.removeControllerState, 'web_TestApp');
          sinon.assert.notCalled(runtimeStateStub.remove);
        });
      });

      it('has the reconciler forget the component it removed', async () => {
        const forgotten = sinon.stub();
        appUninstaller.setOnComponentRemoved(forgotten);
        try {
          await appUninstaller.uninstallComponent(component(), { removeVolumes: false });
        } finally {
          appUninstaller.setOnComponentRemoved(null);
        }
        sinon.assert.calledOnceWithExactly(forgotten, 'web_TestApp');
      });

      it('keeps it while the container survives the teardown', async () => {
        dockerServiceStub.getDockerContainer.resolves({ Id: 'still-here' });
        await appUninstaller.uninstallComponent(component(), { removeVolumes: false }).catch(() => {});
        sinon.assert.notCalled(runtimeStateStub.removeControllerState);
        sinon.assert.notCalled(runtimeStateStub.remove);
      });
    });

    // What goes with the component is what the ledger names for it: its ports
    // by the methods they were opened with, its folder by its id, its image file.
    describe('what the ledger names for the component', () => {
      const imageRemovals = () => runCommandStub.getCalls()
        .filter((c) => c.args[0] === 'rm' && String(c.args[1].params[1]).endsWith('FLUXFSVOL'))
        .map((c) => c.args[1].params[1]);

      it('tears down the ports, the folder and the image file the block names', async () => {
        ledgersStub.byInstance.resolves(ledgerOf({
          web: {
            identifier: 'web_TestApp',
            image: { reference: 'img', digest: null },
            hostPorts: [{ port: 31_001, opened: ['upnp'] }, { port: 31_002, opened: ['ufw'] }],
            volume: {
              file: '/dat/fluxweb_TestAppFLUXFSVOL', disk: '/dat', fsUuid: 'u', mountDir: '/x/web_TestApp',
            },
            mountSources: [],
            syncFolder: { id: 'fluxweb_TestApp', path: '/x/web_TestApp' },
            aliases: [],
            mesh: null,
            tls: null,
          },
        }));

        await appUninstaller.uninstallComponent(component(), { removeVolumes: true });

        sinon.assert.calledOnceWithExactly(ledgersStub.byInstance, 'TestApp', null);
        sinon.assert.calledOnceWithExactly(upnpServiceStub.removeMapUpnpPort, 31_001, 'Flux_App_TestApp');
        sinon.assert.calledOnceWithExactly(fluxNetworkHelperStub.deleteAllowPortRule, 31_002);
        sinon.assert.calledOnceWithExactly(syncthingMonitorHelpersStub.removeSyncthingFolder, 'fluxweb_TestApp');
        expect(imageRemovals()).to.deep.equal(['/dat/fluxweb_TestAppFLUXFSVOL']);
      });

      it('removes no port and no image file when the ledger names no block for it', async () => {
        await appUninstaller.uninstallComponent(component(), { removeVolumes: true });

        sinon.assert.notCalled(upnpServiceStub.removeMapUpnpPort);
        sinon.assert.notCalled(fluxNetworkHelperStub.deleteAllowPortRule);
        expect(imageRemovals()).to.deep.equal([]);
        sinon.assert.calledWithMatch(logStub.warn, /names no block/);
      });
    });

    it('a true removal releases the grant - a removed app must not shield its term', async () => {
      fluxShutdowndClientStub.beginAppStop.resolves({ outcome: 'complete' });
      await appUninstaller.runTeardown(target({
        name: 'myapp',
        networkName: 'myapp',
        forceKill: false,
        owner: '1own',
        reason: 'user-cancel',
        shutdownBudgetSeconds: 30,
        identity: 'ab12cd34ef56',
        components: [{ identifier: 'web_myapp', label: 'web', ports: [] }],
      }));
      sinon.assert.calledOnceWithExactly(
        mastershipGrantGateStub.onComponentTeardown, 'web_myapp', 'ab12cd34ef56',
      );
      // The app's ordinal goes back under its identity, and its content store goes with it.
      sinon.assert.calledOnceWithExactly(meshOrdinalsStub.releaseOrdinal, 'ab12cd34ef56');
      sinon.assert.calledOnceWithExactly(contentStoreStub.removeApp, 'ab12cd34ef56');
    });
  });

  // The published claim goes with the data it describes: one kept past the removal
  // offers peers a volume this node no longer has.
  describe('a teardown that removes the volume', () => {
    beforeEach(() => {
      // The folder a holding is published under is the component's physical name.
      dockerServiceStub.getAppIdentifier.callsFake((identifier) => `flux${identifier}`);
      globalStateStub.folderHoldings = new Map([['fluxweb_TestApp', { bytes: 5 }], ['fluxother_App', { bytes: 7 }]]);
    });

    const comp = () => ({ identifier: 'web_TestApp', appName: 'TestApp', name: 'web' });

    it('withdraws the published holding of the component whose data it deletes', async () => {
      await appUninstaller.uninstallComponent(comp(), { removeVolumes: true }).catch(() => {});
      expect(globalStateStub.folderHoldings.has('fluxweb_TestApp'), 'a claim outlived the data').to.equal(false);
      expect(globalStateStub.folderHoldings.has('fluxother_App'), 'another folder lost its claim').to.equal(true);
    });

    it('keeps it when the volume stays', async () => {
      await appUninstaller.uninstallComponent(comp(), { removeVolumes: false }).catch(() => {});
      expect(globalStateStub.folderHoldings.has('fluxweb_TestApp')).to.equal(true);
    });
  });

  describe('the teardown removes the image file the ledger names', () => {
    const teardown = (volume) => appUninstaller.runTeardown(target({
      name: 'myapp',
      networkName: 'myapp',
      forceKill: false,
      owner: '1own',
      reason: 'user-cancel',
      shutdownBudgetSeconds: 30,
      components: [{
        identifier: 'web_myapp', label: 'web', ports: [], volume,
      }],
    }));
    const imageRemovals = () => runCommandStub.getCalls()
      .filter((c) => c.args[0] === 'rm' && String(c.args[1].params[1]).endsWith('FLUXFSVOL'));

    beforeEach(() => {
      fluxShutdowndClientStub.beginAppStop.resolves({ outcome: 'complete' });
    });

    it('removes the file the ledger names, and looks nowhere else', async () => {
      await teardown({
        file: '/mnt/data2/fluxweb_myappFLUXFSVOL', disk: '/mnt/data2', fsUuid: 'u', mountDir: '/x/web_myapp',
      });
      expect(imageRemovals().map((c) => c.args[1].params)).to.deep.equal([['-rf', '/mnt/data2/fluxweb_myappFLUXFSVOL']]);
    });

    it('says the image is left on disk when the ledger names a volume with no file', async () => {
      await teardown({
        file: null, disk: null, fsUuid: null, mountDir: '/x/web_myapp',
      });
      expect(imageRemovals()).to.deep.equal([]);
      sinon.assert.calledWithMatch(logStub.warn, /could not be located and is left on disk/);
    });

    it('looks for no image for a stateless component', async () => {
      await teardown(null);
      expect(imageRemovals()).to.deep.equal([]);
      sinon.assert.neverCalledWithMatch(logStub.warn, /left on disk/);
    });
  });

  describe('uninstallApplication tests', () => {
    it('reports the error via onStatus and returns FAILED if no app name is specified', async () => {
      const messages = [];
      const result = await appUninstaller.uninstallApplication(undefined, { onStatus: (msg) => messages.push(msg) });
      expect(messages.some((m) => m.includes('No App specified'))).to.be.true;
      expect(result.status).to.equal(appUninstaller.UninstallStatus.FAILED);
    });

    it('returns SKIPPED when a forced removal can find the app nowhere', async () => {
      const result = await appUninstaller.uninstallApplication('nonexistent', { skipGuard: true, forceKill: true });
      expect(result.status).to.equal(appUninstaller.UninstallStatus.SKIPPED);
    });

    it('reports not found via onStatus and returns SKIPPED when the app is missing and skipGuard is false', async () => {
      const messages = [];
      const result = await appUninstaller.uninstallApplication('nonexistent', { onStatus: (msg) => messages.push(msg) });
      expect(messages.some((m) => m.includes('Flux App not found'))).to.be.true;
      expect(result.status).to.equal(appUninstaller.UninstallStatus.SKIPPED);
    });

    it('returns DEFERRED without attempting removal when the app holds an operation lease', async () => {
      operationRegistry.acquire('anyapp', 'install', 'test');
      try {
        const result = await appUninstaller.uninstallApplication('anyapp', {});
        expect(result.status).to.equal(appUninstaller.UninstallStatus.DEFERRED);
      } finally {
        operationRegistry.clear();
      }
    });

    it('skipGuard never bypasses an ACTIVE remove lease (no double teardown)', async () => {
      operationRegistry.acquire('anyapp', 'remove', 'other-teardown');
      try {
        const result = await appUninstaller.uninstallApplication('anyapp', { forceKill: true, skipGuard: true });
        expect(result.status).to.equal(appUninstaller.UninstallStatus.DEFERRED);
      } finally {
        operationRegistry.clear();
      }
    });

    it('skipGuard still barges past a NON-remove lease (install cleanup / force past a redeploy)', async () => {
      operationRegistry.acquire('anyapp', 'install', 'the-install');
      try {
        const result = await appUninstaller.uninstallApplication('anyapp', { forceKill: true, skipGuard: true });
        // it proceeds past the install lease (does not defer); the app is simply not found here
        expect(result.status).to.not.equal(appUninstaller.UninstallStatus.DEFERRED);
      } finally {
        operationRegistry.clear();
      }
    });

    // A removal whose prelude marked the instance and then died before its
    // teardown leaves an owed instance; the next removal finds it.
    it('finds an instance already marked owed, by name and by replica', async () => {
      const owedMark = {
        since: 1, reason: null, force: true, broadcast: false, budgetSeconds: 0, attempts: 0,
      };
      installedStub.instancesOf.callsFake(async (name, opts) => (opts?.includeOwed ? [installedRecord({ name, owner: '1own' }, { owed: owedMark })] : []));
      installedStub.byReplica.callsFake(async (name, replica, opts) => (opts?.includeOwed ? installedRecord({ name, owner: '1own' }, { replica, owed: owedMark }) : null));

      const whole = await appUninstaller.uninstallApplication('owedapp', { forceKill: true, background: true });
      const one = await appUninstaller.uninstallApplication('owedreplica', { forceKill: true, background: true, replica: 's1' });

      expect(whole.status).to.equal(appUninstaller.UninstallStatus.REMOVED);
      expect(one.status).to.equal(appUninstaller.UninstallStatus.REMOVED);
      sinon.assert.calledWith(installedStub.markOwed, 'owedapp', null);
      sinon.assert.calledWith(installedStub.markOwed, 'owedreplica', 's1');
    });

    it('operatorForce defers when a remove lease is held but nothing is draining to escalate', async () => {
      operationRegistry.acquire('anyapp', 'remove', 'the-teardown'); // no escalation registered
      try {
        const result = await appUninstaller.uninstallApplication('anyapp', { forceKill: true, skipGuard: true, operatorForce: true });
        expect(result.status).to.equal(appUninstaller.UninstallStatus.DEFERRED);
      } finally {
        operationRegistry.clear();
      }
    });
  });

  // A REMOVAL THAT TELLS THE NETWORK AND AN ANNOUNCEMENT MUST NOT CROSS. An
  // announcement that read the table before the row went still names the app, so the
  // node stops claiming it at the decision, and the removal message waits for a cycle
  // already sending - the claim lands first and the removal clears it.
  describe('a broadcast removal and the announcement', () => {
    const spec = (name) => ({ name, owner: '1own' });
    const tick = () => new Promise((resolve) => { setImmediate(() => setImmediate(resolve)); });
    let broadcast;
    let markedDuring;

    beforeEach(() => {
      realDepartingApps.clear();
      hosting(spec);
      broadcast = broadcastAllStub;
      markedDuring = null;
      // Read at the removal's durable write: the instance marked owed.
      installedStub.markOwed.callsFake(async (name, replica) => {
        markedDuring = { app: realDepartingApps.has(name), replica: replica ? realDepartingApps.has(name, replica) : null };
      });
    });

    afterEach(() => {
      operationRegistry.clear();
      realDepartingApps.clear();
    });

    // The mark belongs to the removal that took it. A duplicate refused at the lease
    // took none, so it cannot hand back the claim a live removal is withdrawing.
    it('a refused duplicate leaves the running removal\'s mark in place', async () => {
      realDepartingApps.enter('leaving');
      const token = operationRegistry.acquire('leaving', 'remove', 'test', 'a removal in flight');
      try {
        const result = await appUninstaller.uninstallApplication('leaving', { broadcastRemoval: true });
        expect(result.status).to.equal(appUninstaller.UninstallStatus.DEFERRED);
        expect(realDepartingApps.has('leaving'), 'a refused duplicate released a live removal\'s mark').to.equal(true);
      } finally {
        operationRegistry.release('leaving', token);
        realDepartingApps.leave('leaving');
      }
    });

    it('stops claiming the app from the decision, and claims nothing once it is done', async () => {
      const result = await appUninstaller.uninstallApplication('leaving', { forceKill: true, broadcastRemoval: true, background: true });

      expect(result.status).to.equal(appUninstaller.UninstallStatus.REMOVED);
      expect(markedDuring.app, 'the app was still claimed while it was being handed back').to.equal(true);
      expect(realDepartingApps.has('leaving'), 'the mark outlived the removal').to.equal(false);
      sinon.assert.calledOnce(broadcast);
    });

    it('hands back only the replica a replica removal names', async () => {
      await appUninstaller.uninstallApplication('pinned', {
        forceKill: true, broadcastRemoval: true, background: true, replica: 's1',
      });

      expect(markedDuring, 'a sibling that stays was handed back with it').to.deep.equal({ app: false, replica: true });
      expect(realDepartingApps.has('pinned', 's2')).to.equal(false);
    });

    it('marks nothing for a removal that tells the network nothing', async () => {
      await appUninstaller.uninstallApplication('quiet', { forceKill: true, background: true });
      expect(markedDuring.app, 'a removal that announces nothing withdrew the claim').to.equal(false);
    });

    it('clears the mark when the removal fails', async () => {
      installedStub.markOwed.rejects(new Error('db down'));
      const result = await appUninstaller.uninstallApplication('broken', { forceKill: true, broadcastRemoval: true, background: true });
      expect(result.status).to.equal(appUninstaller.UninstallStatus.FAILED);
      expect(realDepartingApps.has('broken'), 'a failed removal kept the app unclaimed').to.equal(false);
    });

    it('does not announce the removal while an announcement cycle is still sending', async () => {
      const release = await globalStateStub.announceCycle.acquire();
      const removal = appUninstaller.uninstallApplication('racing', { forceKill: true, broadcastRemoval: true, background: true });
      await tick();
      sinon.assert.notCalled(broadcast);

      release();
      await removal;
      // The canary: without it the assertion above passes for a removal that never
      // got as far as the wait.
      sinon.assert.calledOnce(broadcast);
    });

    // A cycle that never finishes must not hold the node's removals.
    it('gives up on a wedged cycle and announces anyway', async () => {
      await globalStateStub.announceCycle.acquire();
      const outcome = await Promise.race([
        appUninstaller.uninstallApplication('stuck', { forceKill: true, broadcastRemoval: true, background: true }).then(() => 'announced'),
        new Promise((resolve) => { setTimeout(() => resolve('held'), 2000); }),
      ]);
      expect(outcome, 'a wedged cycle held the removal indefinitely').to.equal('announced');
      sinon.assert.calledOnce(broadcast);
    });

    it('does not wait for a cycle when the removal tells the network nothing', async () => {
      await globalStateStub.announceCycle.acquire();
      const outcome = await Promise.race([
        appUninstaller.uninstallApplication('silent', { forceKill: true, background: true }).then(() => 'removed'),
        new Promise((resolve) => { setTimeout(() => resolve('waited'), 40); }),
      ]);
      expect(outcome, 'a silent removal queued behind an announcement it cannot contradict').to.equal('removed');
    });
  });

  describe('denyPorts closes each port by the methods it was opened with', () => {
    it('asks the firewall for a ufw-opened port, the router for a upnp-opened one, both for both, neither for none', async () => {
      await appUninstaller.denyPorts([
        { port: 1, opened: ['ufw'] }, { port: 2, opened: ['upnp'] }, { port: 3, opened: ['ufw', 'upnp'] }, { port: 4, opened: [] },
      ], 'app');

      expect(fluxNetworkHelperStub.deleteAllowPortRule.args.map(([port]) => port)).to.deep.equal([1, 3]);
      expect(upnpServiceStub.removeMapUpnpPort.args).to.deep.equal([[2, 'Flux_App_app'], [3, 'Flux_App_app']]);
    });
  });

  describe('reclaimUnusedImages (reference-gated image GC)', () => {
    const noop = () => {};

    it('removes an image no remaining container references', async () => {
      dockerServiceStub.dockerListContainers.resolves([]);
      await appUninstaller.reclaimUnusedImages(['alpine:latest'], noop);
      expect(dockerServiceStub.appDockerImageRemove.calledOnceWithExactly('alpine:latest')).to.be.true;
    });

    it('leaves an image still referenced by another container (matched by tag)', async () => {
      dockerServiceStub.dockerListContainers.resolves([{ Image: 'alpine:latest' }]);
      await appUninstaller.reclaimUnusedImages(['alpine:latest'], noop);
      expect(dockerServiceStub.appDockerImageRemove.called).to.be.false;
    });

    it('leaves an image still referenced by ImageID', async () => {
      dockerServiceStub.dockerListContainers.resolves([{ Image: 'other:tag', ImageID: 'sha256:abc' }]);
      await appUninstaller.reclaimUnusedImages(['sha256:abc'], noop);
      expect(dockerServiceStub.appDockerImageRemove.called).to.be.false;
    });

    it('deduplicates a shared image to a single removal', async () => {
      dockerServiceStub.dockerListContainers.resolves([]);
      await appUninstaller.reclaimUnusedImages(['alpine:latest', 'alpine:latest', 'alpine:latest'], noop);
      expect(dockerServiceStub.appDockerImageRemove.calledOnce).to.be.true;
    });

    it('treats a Docker "must force" 409 as benign (no error logged)', async () => {
      dockerServiceStub.dockerListContainers.resolves([]);
      dockerServiceStub.appDockerImageRemove.rejects(new Error('(HTTP code 409) unable to remove repository reference "alpine:latest" (must force)'));
      await appUninstaller.reclaimUnusedImages(['alpine:latest'], noop);
      expect(logStub.error.called).to.be.false;
    });

    it('no-ops on an empty list without listing containers', async () => {
      await appUninstaller.reclaimUnusedImages([], noop);
      expect(dockerServiceStub.dockerListContainers.called).to.be.false;
    });
  });

  describe('runTeardown stop routing through flux-shutdownd', () => {
    const doc = () => ({
      key: 'myapp',
      name: 'myapp',
      networkName: 'fluxDockerNetwork_myapp',
      forceKill: false,
      owner: '1own',
      reason: 'user-cancel',
      shutdownBudgetSeconds: 30,
      components: [{
        identifier: 'web_myapp', appId: 'fluxweb_myapp', label: 'web', ports: [],
      }],
    });

    it('passes the persisted reason + force to beginAppStop', async () => {
      fluxShutdowndClientStub.beginAppStop.resolves({ outcome: 'rejected_pipeline_active' });
      await appUninstaller.runTeardown(target(doc()));
      expect(fluxShutdowndClientStub.beginAppStop.calledOnce).to.equal(true);
      const [owner, name, reason, opts] = fluxShutdowndClientStub.beginAppStop.firstCall.args;
      expect(owner).to.equal('1own');
      expect(name).to.equal('myapp');
      expect(reason).to.equal('user-cancel');
      expect(opts.force).to.equal(false);
      // A doc with no replica is a whole-app stop: replica must arrive as
      // definite null, never undefined.
      expect(opts.replica).to.equal(null);
    });

    it('scopes the daemon stop to the teardown doc identity (a scale-down never drains the sibling)', async () => {
      fluxShutdowndClientStub.beginAppStop.resolves({ outcome: 'rejected_pipeline_active' });
      await appUninstaller.runTeardown(target({ ...doc(), replica: 's2' }));
      const opts = fluxShutdowndClientStub.beginAppStop.firstCall.args[3];
      expect(opts.replica).to.equal('s2');
    });

    it('defers (no local stop, no remove) when a node-wide shutdown owns the stop', async () => {
      fluxShutdowndClientStub.beginAppStop.resolves({ outcome: 'rejected_pipeline_active' });
      await appUninstaller.runTeardown(target(doc()));
      expect(dockerServiceStub.appDockerStop.called).to.equal(false);
      expect(dockerServiceStub.appDockerKill.called).to.equal(false);
      expect(dockerServiceStub.appDockerRemove.called).to.equal(false);
    });

    it('stops locally (appDockerStop, never kill) when the daemon is absent (non-Arcane)', async () => {
      fluxShutdowndClientStub.beginAppStop.resolves({ outcome: 'not_arcane' });
      // the host teardown after the stop loop touches unmocked deps; the stop loop runs first.
      await appUninstaller.runTeardown(target(doc())).catch(() => {});
      // The BARE identifier: dockerService owns physical naming and prefixes it
      // itself, so handing it the already-prefixed appId asks for fluxfluxweb_myapp.
      expect(dockerServiceStub.appDockerStop.calledWith('web_myapp')).to.equal(true);
      expect(dockerServiceStub.appDockerKill.called).to.equal(false);
    });

    it('skips the local stop when the daemon already drained it (Arcane)', async () => {
      fluxShutdowndClientStub.beginAppStop.resolves({ outcome: 'complete' });
      await appUninstaller.runTeardown(target(doc())).catch(() => {});
      expect(dockerServiceStub.appDockerStop.called).to.equal(false);
      expect(dockerServiceStub.appDockerKill.called).to.equal(false);
    });

    // The identity work made getAppIdentifier always-prefix (it used to return an
    // already-prefixed value unchanged), so handing a docker call the physical name
    // now asks for `fluxflux...` and silently matches nothing: the container is left
    // running, the remove is reported as success, and - worst - the presence probe
    // that gates reclaiming host storage also answers "gone" and the volume is
    // unmounted and the appdata deleted under a live container. Both call sites take
    // the BARE identifier, and this pins that contract on the docker seam itself.
    it('hands docker the bare identifier, never the flux-prefixed physical name', async () => {
      fluxShutdowndClientStub.beginAppStop.resolves({ outcome: 'not_arcane' });
      await appUninstaller.runTeardown(target(doc())).catch(() => {});

      const passed = []
        .concat(dockerServiceStub.appDockerStop.args.map((a) => a[0]))
        .concat(dockerServiceStub.appDockerRemove.args.map((a) => a[0]))
        .concat(dockerServiceStub.getDockerContainer.args.map((a) => a[0]));
      expect(passed.length, 'the teardown reached the docker seam').to.be.greaterThan(0);
      const prefixed = passed.filter((v) => typeof v === 'string' && v.startsWith('flux'));
      expect(prefixed, `physical names passed to dockerService: ${prefixed}`).to.deep.equal([]);
    });

    it('force-disconnects endpoints and removes the network even on a graceful teardown (no leak)', async () => {
      fluxShutdowndClientStub.beginAppStop.resolves({ outcome: 'complete' });
      await appUninstaller.runTeardown(target(doc())).catch(() => {});
      // the teardown record carries the resolved network name; removal takes it as the
      // option, so a record that outlives the row still names the right network
      expect(dockerServiceStub.forceRemoveFluxAppDockerNetwork.calledWith(
        null, { networkName: 'fluxDockerNetwork_myapp' },
      )).to.equal(true);
      expect(dockerServiceStub.removeFluxAppDockerNetwork.called).to.equal(false);
    });

    describe('what a replica teardown leaves for a sibling', () => {
      const replicaDoc = () => ({
        ...doc(), replica: 's2', identity: 'bident',
      });
      let deleteSink;
      let forgetApp;
      beforeEach(() => {
        fluxShutdowndClientStub.beginAppStop.resolves({ outcome: 'complete' });
        deleteSink = sinon.spy(telemetrySinkCache, 'deleteSink');
        forgetApp = sinon.spy(appTamperingDetectionService, 'forgetApp');
      });
      afterEach(() => {
        deleteSink.restore();
        forgetApp.restore();
      });

      it('keeps the app\'s network, telemetry sink and content store while a sibling replica stays', async () => {
        installedStub.instancesOf.resolves([installedRecord({ name: 'myapp', owner: '1own' }, { replica: 's1' })]);

        await appUninstaller.runTeardown(target(replicaDoc())).catch(() => {});

        sinon.assert.notCalled(dockerServiceStub.forceRemoveFluxAppDockerNetwork);
        sinon.assert.notCalled(deleteSink);
        sinon.assert.notCalled(forgetApp);
        sinon.assert.notCalled(contentStoreStub.removeApp);
      });

      // The instance being removed is marked owed and still stored: it is not a
      // sibling that stays.
      it('removes them with the last replica', async () => {
        installedStub.instancesOf.callsFake(async (name, opts) => (opts?.includeOwed
          ? [installedRecord({ name, owner: '1own' }, { replica: 's2', owed: target(replicaDoc()).owed })]
          : []));

        await appUninstaller.runTeardown(target(replicaDoc())).catch(() => {});

        sinon.assert.calledWith(dockerServiceStub.forceRemoveFluxAppDockerNetwork, null, { networkName: 'fluxDockerNetwork_myapp' });
        sinon.assert.calledWith(deleteSink, 'myapp');
        sinon.assert.calledOnceWithExactly(forgetApp, 'myapp');
        sinon.assert.calledOnceWithExactly(contentStoreStub.removeApp, 'bident');
      });

      it('keeps them when the store cannot say whether a sibling stays', async () => {
        installedStub.instancesOf.rejects(new Error('mongo down'));

        await appUninstaller.runTeardown(target(replicaDoc())).catch(() => {});

        sinon.assert.notCalled(dockerServiceStub.forceRemoveFluxAppDockerNetwork);
        sinon.assert.notCalled(contentStoreStub.removeApp);
      });
    });

    it('refuses a second concurrent teardown of the same app (single-flight)', async () => {
      // Hold the first teardown open at the shutdownd stop so the second overlaps it.
      let releaseStop;
      fluxShutdowndClientStub.beginAppStop.onFirstCall().returns(new Promise((resolve) => { releaseStop = resolve; }));
      fluxShutdowndClientStub.beginAppStop.onSecondCall().resolves({ outcome: 'not_arcane' });

      const first = appUninstaller.runTeardown(target(doc())).catch(() => {});
      await appUninstaller.runTeardown(target(doc())); // same key -> single-flight bail, returns at once

      expect(fluxShutdowndClientStub.beginAppStop.callCount, 'the second teardown must not start a second stop').to.equal(1);
      releaseStop({ outcome: 'not_arcane' });
      await first;
    });

    it('an operator force-remove escalates the in-flight graceful drain via the daemon', async () => {
      const settle = () => new Promise((resolve) => { setImmediate(() => setImmediate(resolve)); });
      // A graceful teardown in flight, held at the drain, registers its escalation.
      let releaseStop;
      fluxShutdowndClientStub.beginAppStop.onFirstCall().returns(new Promise((resolve) => { releaseStop = resolve; }));
      const draining = appUninstaller.runTeardown(target(doc())).catch(() => {});
      await settle();

      // The in-flight teardown holds its remove lease; an operator force-remove of the
      // same app escalates it rather than starting a second teardown.
      operationRegistry.acquire('myapp', 'remove', 'the-teardown');
      const result = await appUninstaller.uninstallApplication('myapp', { forceKill: true, skipGuard: true, operatorForce: true });
      operationRegistry.clear();

      expect(fluxShutdowndClientStub.forceAppStop.calledWith('1own', 'myapp'), 'escalated the drain via the daemon').to.equal(true);
      expect(result.status).to.equal(appUninstaller.UninstallStatus.REMOVED);

      releaseStop({ outcome: 'forced' });
      await draining;
    });
  });

  describe('clearSpawnThrottleForPinnedReinstall (throttle clear on operator removal)', () => {
    const pinnedSpec = (matches = true, hasTargets = true) => ({
      hash: 'pinhash',
      placement: {
        hasTargets: () => hasTargets,
        matchesTarget: () => matches,
        isPinnedTo(nodeInfo) { return this.hasTargets() && this.matchesTarget(nodeInfo); },
      },
    });

    it('clears the throttle for a foreground non-force removal of an app pinned to this node', async () => {
      registryStub.byName.resolves(pinnedSpec());
      globalStateStub.trySpawningGlobalAppCache = new Map([['pinhash', '']]);

      await appUninstaller.clearSpawnThrottleForPinnedReinstall('pinApp', { forceKill: false, background: false });

      expect(globalStateStub.trySpawningGlobalAppCache.has('pinhash')).to.equal(false);
    });

    it('does NOT clear (and does not even look up) for a force removal', async () => {
      registryStub.byName.resolves(pinnedSpec());
      globalStateStub.trySpawningGlobalAppCache = new Map([['pinhash', '']]);

      await appUninstaller.clearSpawnThrottleForPinnedReinstall('pinApp', { forceKill: true, background: false });

      expect(globalStateStub.trySpawningGlobalAppCache.has('pinhash')).to.equal(true);
      expect(registryStub.byName.called).to.equal(false);
    });

    it('does NOT clear (and does not even look up) for a background removal (expiry/cancel)', async () => {
      registryStub.byName.resolves(pinnedSpec());
      globalStateStub.trySpawningGlobalAppCache = new Map([['pinhash', '']]);

      await appUninstaller.clearSpawnThrottleForPinnedReinstall('pinApp', { forceKill: false, background: true });

      expect(globalStateStub.trySpawningGlobalAppCache.has('pinhash')).to.equal(true);
      expect(registryStub.byName.called).to.equal(false);
    });

    it('does NOT clear when the app is not pinned to this node', async () => {
      registryStub.byName.resolves(pinnedSpec(false)); // matchesTarget -> false
      globalStateStub.trySpawningGlobalAppCache = new Map([['pinhash', '']]);

      await appUninstaller.clearSpawnThrottleForPinnedReinstall('pinApp', { forceKill: false, background: false });

      expect(globalStateStub.trySpawningGlobalAppCache.has('pinhash')).to.equal(true);
    });

    it('does NOT clear for an unpinned app (no placement targets)', async () => {
      registryStub.byName.resolves(pinnedSpec(true, false)); // hasTargets -> false
      globalStateStub.trySpawningGlobalAppCache = new Map([['pinhash', '']]);

      await appUninstaller.clearSpawnThrottleForPinnedReinstall('pinApp', { forceKill: false, background: false });

      expect(globalStateStub.trySpawningGlobalAppCache.has('pinhash')).to.equal(true);
    });

    it('is a no-op when the app is no longer globally registered', async () => {
      registryStub.byName.resolves(null);
      globalStateStub.trySpawningGlobalAppCache = new Map([['pinhash', '']]);

      await appUninstaller.clearSpawnThrottleForPinnedReinstall('gone', { forceKill: false, background: false });

      expect(globalStateStub.trySpawningGlobalAppCache.has('pinhash')).to.equal(true);
    });
  });

  describe('collector lifecycle: reverse cascade + orphan sweep', () => {
    const spec = (name) => ({ name, owner: '1own' });

    function warnLogged(substr) {
      return logStub.warn.getCalls().some((c) => typeof c.args[0] === 'string' && c.args[0].includes(substr));
    }
    function infoLogged(substr) {
      return logStub.info.getCalls().some((c) => typeof c.args[0] === 'string' && c.args[0].includes(substr));
    }
    const tick = () => new Promise((resolve) => { setImmediate(() => setImmediate(resolve)); });

    afterEach(() => {
      operationRegistry.clear();
    });

    it('graceful removal of a follower uninstalls its requiring workload FIRST (the order of the owed marks proves it)', async () => {
      configStub.fluxapps.manageCollectorLifecycle = true;
      hosting(spec);
      relationshipResolverStub.findCascadeWorkloadsRequiring.withArgs('collector').resolves([spec('workload')]);

      await appUninstaller.uninstallApplication('collector', { forceKill: false, background: true });

      expect(infoLogged('Reverse dependency cascade: uninstalling workload workload'), 'cascade announced').to.equal(true);
      expect(warnLogged('APP REMOVAL TRIGGERED: workload'), 'nested workload removal ran').to.equal(true);
      // The workload's instance is marked owed before the collector's own.
      const keys = installedStub.markOwed.getCalls().map((c) => c.args[0]);
      expect(keys.indexOf('workload'), 'workload marked owed').to.be.at.least(0);
      expect(keys.indexOf('workload')).to.be.lessThan(keys.indexOf('collector'));
    });

    it('defers the follower teardown when a requiring workload is mid-operation (DEFERRED)', async () => {
      configStub.fluxapps.manageCollectorLifecycle = true;
      hosting(spec);
      relationshipResolverStub.findCascadeWorkloadsRequiring.withArgs('collector').resolves([spec('workload')]);
      // the requiring workload holds a redeploy lease, so its removal DEFERS
      operationRegistry.acquire('workload', 'redeploy', 'the-redeploy');
      try {
        const result = await appUninstaller.uninstallApplication('collector', { forceKill: false, background: true });
        expect(result.status, 'the follower teardown must defer while its consumer is mid-operation').to.equal(appUninstaller.UninstallStatus.DEFERRED);
        const keys = installedStub.markOwed.getCalls().map((c) => c.args[0]);
        expect(keys.indexOf('collector'), 'the follower must NOT have started tearing down').to.equal(-1);
      } finally {
        operationRegistry.clear();
      }
    });

    it('a removal that names no replica marks every instance owed - pinned included', async () => {
      // A pinned app's instances carry replica names: a removal of the app
      // takes each of them, not a loose instance it never had.
      hosting(spec, ['s1', 's2']);

      await appUninstaller.uninstallApplication('pinnedapp', { forceKill: true, background: true });

      expect(installedStub.markOwed.getCalls().map((c) => c.args.slice(0, 2))).to.deep.equal([['pinnedapp', 's1'], ['pinnedapp', 's2']]);
      sinon.assert.notCalled(installedStub.byReplica);
    });

    it('a replica-named removal marks only that instance owed', async () => {
      hosting(spec, ['s1', 's2']);

      await appUninstaller.uninstallApplication('pinnedapp', { forceKill: true, background: true, replica: 's1' });

      sinon.assert.calledOnce(installedStub.markOwed);
      sinon.assert.calledWith(installedStub.markOwed, 'pinnedapp', 's1');
    });

    // The cascade is a correctness invariant - a consumer must never outlive
    // its dependency - so it fires whatever the removal's urgency. Force
    // decides the MANNER, and it propagates: the consumers come down
    // consumer-first like any cascade, but killed rather than drained.
    it('a force-kill cascades too, and the force propagates to the consumers', async () => {
      configStub.fluxapps.manageCollectorLifecycle = true;
      hosting(spec);
      relationshipResolverStub.findCascadeWorkloadsRequiring.withArgs('collector').resolves([spec('workload')]);

      await appUninstaller.uninstallApplication('collector', { forceKill: true, background: true });

      expect(warnLogged('APP REMOVAL TRIGGERED: workload | forceKill=true'), 'the consumer is removed in the same manner').to.equal(true);
      const keys = installedStub.markOwed.getCalls().map((c) => c.args[0]);
      expect(keys.indexOf('workload'), 'consumer-first ordering holds under force').to.be.at.least(0);
      expect(keys.indexOf('workload')).to.be.lessThan(keys.indexOf('collector'));
    });

    // Force means the dependency is coming down regardless: a consumer
    // mid-operation is escalated past, never allowed to block the teardown -
    // the defer rule belongs to graceful removals only.
    it('a forced cascade does not defer on a mid-operation consumer', async () => {
      configStub.fluxapps.manageCollectorLifecycle = true;
      hosting(spec);
      relationshipResolverStub.findCascadeWorkloadsRequiring.withArgs('collector').resolves([spec('workload')]);
      operationRegistry.acquire('workload', 'redeploy', 'the-redeploy');
      try {
        const result = await appUninstaller.uninstallApplication('collector', { forceKill: true, background: true });

        expect(result.status, 'the dependency comes down under force').to.not.equal(appUninstaller.UninstallStatus.DEFERRED);
        const keys = installedStub.markOwed.getCalls().map((c) => c.args[0]);
        expect(keys.indexOf('collector'), 'the dependency teardown proceeded').to.be.at.least(0);
      } finally {
        operationRegistry.clear();
      }
    });

    // The installer's failed-install cleanups remove an app the network still
    // wants here - the spawner retries it - so tearing its consumers down
    // would churn them for nothing. Intent is its own axis: those callers say
    // so explicitly, and everyone else keeps the invariant by default.
    it('a caller stating cascade:false skips the cascade', async () => {
      configStub.fluxapps.manageCollectorLifecycle = true;
      hosting(spec);

      await appUninstaller.uninstallApplication('collector', { forceKill: true, background: true, cascade: false });

      expect(relationshipResolverStub.findCascadeWorkloadsRequiring.called).to.equal(false);
    });

    // A replica removal leaves the app present on the node - nothing a
    // consumer depends on has gone, so there is nothing to cascade.
    it('a replica-scoped removal never cascades', async () => {
      configStub.fluxapps.manageCollectorLifecycle = true;
      hosting(spec);

      await appUninstaller.uninstallApplication('collector', { forceKill: false, background: true, replica: 's1' });

      expect(relationshipResolverStub.findCascadeWorkloadsRequiring.called).to.equal(false);
    });

    it('does not cascade with the lifecycle toggle off (default)', async () => {
      hosting(spec);

      await appUninstaller.uninstallApplication('collector', { forceKill: false, background: true });

      expect(relationshipResolverStub.findCascadeWorkloadsRequiring.called).to.equal(false);
    });

    it('a graceful workload removal triggers the deferred orphan sweep', async () => {
      configStub.fluxapps.manageCollectorLifecycle = true;
      hosting(spec);
      relationshipResolverStub.isPureFollowerApp.resolves(false);

      const result = await appUninstaller.uninstallApplication('workload', { forceKill: false, background: true });
      expect(result.status).to.equal(appUninstaller.UninstallStatus.REMOVED);
      await tick();

      expect(relationshipResolverStub.findUnrequiredInstalledDependencies.called, 'sweep ran after the removal settled').to.equal(true);
    });

    it('a force-kill of a follower does NOT trigger the sweep', async () => {
      configStub.fluxapps.manageCollectorLifecycle = true;
      hosting(spec);
      relationshipResolverStub.isPureFollowerApp.resolves(true);

      await appUninstaller.uninstallApplication('collector', { forceKill: true, skipGuard: true, background: true });
      await tick();

      expect(relationshipResolverStub.findUnrequiredInstalledDependencies.called).to.equal(false);
    });

    it('removeUnrequiredDependencies unwinds a chain until no orphans remain, consumer-first', async () => {
      const datadog = spec('datadog');
      const alloy = spec('alloy');
      // The resolver returns orphans already ordered consumer-first — it holds
      // the resolved views the ordering depends on. This exercises the unwind
      // loop; the ordering itself is covered in the resolver's own suite.
      relationshipResolverStub.findUnrequiredInstalledDependencies.onCall(0).resolves([datadog, alloy]);
      relationshipResolverStub.findUnrequiredInstalledDependencies.onCall(1).resolves([alloy]);
      relationshipResolverStub.findUnrequiredInstalledDependencies.onCall(2).resolves([]);

      await appUninstaller.removeUnrequiredDependencies();

      const removals = logStub.info.getCalls()
        .map((c) => c.args[0])
        .filter((m) => typeof m === 'string' && m.startsWith('Dependency cleanup: removing'));
      expect(removals[0]).to.include('datadog');
      expect(removals[1]).to.include('alloy');
    });

    it('re-runs the sweep when a trigger arrives mid-pass (dirty flag), never dropping it', async () => {
      let releaseFind;
      relationshipResolverStub.findUnrequiredInstalledDependencies.returns(new Promise((resolve) => { releaseFind = resolve; }));

      const first = appUninstaller.removeUnrequiredDependencies();
      await tick(); // past the identity reads, parked inside the first find pass
      const second = appUninstaller.removeUnrequiredDependencies();
      await second; // the concurrent trigger returns immediately, marking the running sweep dirty
      expect(relationshipResolverStub.findUnrequiredInstalledDependencies.callCount).to.equal(1);

      releaseFind([]); // first pass finds nothing to remove...
      await first;
      // ...but the dirty flag forces one more pass instead of dropping the concurrent trigger.
      expect(relationshipResolverStub.findUnrequiredInstalledDependencies.callCount).to.equal(2);
    });

    it('the sweep passes this node\'s identity so a standalone self-hold can be judged', async () => {
      relationshipResolverStub.findUnrequiredInstalledDependencies.resolves([]);

      await appUninstaller.removeUnrequiredDependencies();

      const { nodeIdentity } = relationshipResolverStub.findUnrequiredInstalledDependencies.firstCall.args[0];
      expect(nodeIdentity).to.eql({ ip: '7.7.7.7:16127', outpoint: 'txh:0', operator: 'nodepubkey' });
    });
  });

});
