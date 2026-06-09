const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('containerHealthMonitor tests', () => {
  let containerHealthMonitor;
  let globalStateStub;

  beforeEach(() => {
    globalStateStub = {
      waitForBootContainerStateSettled: sinon.stub().resolves(),
      isOperationInProgress: sinon.stub().returns(false),
      backupInProgress: [],
      restoreInProgress: [],
      appsMonitored: new Map(),
      getAppLbState: sinon.stub().returns(null),
    };

    containerHealthMonitor = proxyquire('../../ZelBack/src/services/appMonitoring/containerHealthMonitor', {
      '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
      '../dbHelper': { databaseConnection: sinon.stub(), findInDatabase: sinon.stub(), findOneInDatabase: sinon.stub() },
      '../dockerService': { getDockerContainer: sinon.stub().resolves(null), appDockerStart: sinon.stub(), dockerListContainers: sinon.stub() },
      '../appDatabase/appsRepository': { getGlobalAppInfo: sinon.stub() },
      '../appLifecycle/appInstaller': { installComponent: sinon.stub().resolves() },
      '../appLifecycle/appUninstaller': { uninstallApplication: sinon.stub().resolves() },
      '../appRuntime/deploymentProvider': { buildDeployment: sinon.stub() },
      '../appManagement/appInspector': { startAppMonitoring: sinon.stub() },
      '../appTamperingDetectionService': { recordEvent: sinon.stub().resolves(), isNetworkMissingError: sinon.stub().returns(false) },
      '../utils/globalState': globalStateStub,
      '../utils/cacheManager': { default: { stoppedAppsCache: new Map() } },
      '../utils/volumeService': { verifyAppVolumeMount: sinon.stub().resolves(true) },
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('monitorAndRecoverApps', () => {
    it('should wait for bootComplete before proceeding', async () => {
      let monitorResolved = false;
      globalStateStub.waitForBootContainerStateSettled = sinon.stub().returns(
        new Promise((resolve) => { setTimeout(resolve, 50); }),
      );

      const promise = containerHealthMonitor.monitorAndRecoverApps('10.0.0.1', [], [], new Map())
        .then(() => { monitorResolved = true; });
      await new Promise((r) => setImmediate(r));
      expect(monitorResolved).to.be.false;
      await promise;
      expect(monitorResolved).to.be.true;
      expect(globalStateStub.waitForBootContainerStateSettled.calledOnce).to.be.true;
    });

    it('reads component/syncthing info from resolved views, not the encrypted wrapper', async () => {
      // An installed enterprise app: inst.spec is the EncryptedSpecV8 wrapper
      // with no componentNames(); the resolved view supplies it.
      const encryptedSpec = {
        componentNames() { throw new Error('must not call componentNames on the encrypted wrapper'); },
        hasSyncthing() { throw new Error('must not call hasSyncthing on the encrypted wrapper'); },
      };
      const inst = {
        name: 'encapp', version: 8, isEncrypted: true, hash: 'h1', spec: encryptedSpec,
      };
      const view = {
        componentNames: () => ['comp'],
        hasSyncthing: () => false,
        hasActiveStandbySyncthing: () => false,
      };
      const resolvedViews = new Map([['encapp', view]]);

      // comp_encapp not running → treated as stopped; getGlobalAppInfo returns
      // undefined so no recovery action runs. The point: no throw, view is used.
      const result = await containerHealthMonitor.monitorAndRecoverApps(
        '10.0.0.1', [inst], [], resolvedViews,
      );
      expect(result).to.have.property('masterSlaveAppsInstalled');
      expect(result).to.have.property('startedApps');
    });
  });

  describe('monitorAndRecoverApps - per-component syncthing handling', () => {
    const MINUTE = 60 * 1000;

    // Build a containerHealthMonitor with individually controllable stubs.
    function load({ getGlobalAppInfo, getDockerContainer, findOneInDatabase, stoppedAppsCache, getAppLbState } = {}) {
      const appDockerStart = sinon.stub().resolves();
      const gs = {
        waitForBootContainerStateSettled: sinon.stub().resolves(),
        isOperationInProgress: sinon.stub().returns(false),
        backupInProgress: [],
        restoreInProgress: [],
        appsMonitored: new Map(),
        getAppLbState: getAppLbState || sinon.stub().returns(null),
      };
      const chm = proxyquire('../../ZelBack/src/services/appMonitoring/containerHealthMonitor', {
        '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
        '../dbHelper': {
          databaseConnection: sinon.stub().returns({ db: () => ({}) }),
          findInDatabase: sinon.stub(),
          findOneInDatabase: findOneInDatabase || sinon.stub().resolves(null),
        },
        '../dockerService': { getDockerContainer: getDockerContainer || sinon.stub().resolves(null), appDockerStart, dockerListContainers: sinon.stub() },
        '../appDatabase/appsRepository': { getGlobalAppInfo: getGlobalAppInfo || sinon.stub().resolves(undefined) },
        '../appLifecycle/appInstaller': { installComponent: sinon.stub().resolves() },
        '../appLifecycle/appUninstaller': { uninstallApplication: sinon.stub().resolves() },
        '../appRuntime/deploymentProvider': { buildDeployment: sinon.stub() },
        '../appManagement/appInspector': { startAppMonitoring: sinon.stub() },
        '../appTamperingDetectionService': { recordEvent: sinon.stub().resolves(), isNetworkMissingError: sinon.stub().returns(false) },
        '../utils/globalState': gs,
        '../utils/cacheManager': { default: { stoppedAppsCache: stoppedAppsCache || new Map() } },
        '../utils/volumeService': { verifyAppVolumeMount: sinon.stub().resolves(true) },
      });
      return { chm, appDockerStart };
    }

    // Per-component sync classification the resolved view's getComponent returns.
    const comp = (sync, activeStandby) => ({ hasSyncthing: () => sync, hasActiveStandbySyncthing: () => activeStandby });

    it('auto-starts a stopped non-syncthing component of a mixed app and leaves the active-standby sibling to election', async () => {
      const components = { web: comp(false, false), db: comp(true, true) };
      const view = {
        componentNames: () => ['web', 'db'],
        hasSyncthing: () => true, // app-level: app has a syncthing component
        hasActiveStandbySyncthing: () => true,
        getComponent: (n) => components[n],
      };
      const inst = { name: 'mix', version: 8, hash: 'h', spec: {} };
      const { chm, appDockerStart } = load({
        getGlobalAppInfo: sinon.stub().resolves({ name: 'mix' }),
        getDockerContainer: sinon.stub().resolves(true), // containers exist but stopped
        stoppedAppsCache: new Map([['web_mix', '']]), // seen before -> start this cycle
      });

      await chm.monitorAndRecoverApps('1.2.3.4', [inst], [], new Map([['mix', view]]));

      expect(appDockerStart.calledWith('web_mix'), 'non-syncthing sibling auto-started').to.be.true;
      expect(appDockerStart.neverCalledWith('db_mix'), 'active-standby component left to election').to.be.true;
    });

    it('does not recover a draining/stopping app but arms the cache so recovery is immediate once the state clears', async () => {
      const components = { web: comp(false, false) };
      const view = {
        componentNames: () => ['web'], hasSyncthing: () => false, hasActiveStandbySyncthing: () => false, getComponent: (n) => components[n],
      };
      const inst = { name: 'gone', version: 8, hash: 'h', spec: {} };
      const getAppLbState = sinon.stub().returns('stopping');
      const stoppedAppsCache = new Map();
      const { chm, appDockerStart } = load({
        getGlobalAppInfo: sinon.stub().resolves({ name: 'gone' }),
        getDockerContainer: sinon.stub().resolves(true),
        stoppedAppsCache,
        getAppLbState,
      });

      // pipeline holds the app: no start, but the two-strike cache gets armed
      await chm.monitorAndRecoverApps('1.2.3.4', [inst], [], new Map([['gone', view]]));
      expect(appDockerStart.called, 'held by the shutdown pipeline').to.be.false;
      expect(stoppedAppsCache.has('web_gone'), 'two-strike cache armed during the pipeline').to.be.true;

      // state cleared/expired: the very next cycle starts the container
      getAppLbState.returns(null);
      await chm.monitorAndRecoverApps('1.2.3.4', [inst], [], new Map([['gone', view]]));
      expect(appDockerStart.calledWith('web_gone'), 'started on the first post-clear cycle').to.be.true;
    });

    it('applies the 30-minute install grace to a stopped syncthing component installed less than 30m ago', async () => {
      const components = { data: comp(true, false) }; // syncthing, not active-standby
      const view = {
        componentNames: () => ['data'], hasSyncthing: () => true, hasActiveStandbySyncthing: () => false, getComponent: (n) => components[n],
      };
      const inst = { name: 'rapp', version: 8, hash: 'h', spec: {} };
      const { chm, appDockerStart } = load({
        getGlobalAppInfo: sinon.stub().resolves({ name: 'rapp' }),
        getDockerContainer: sinon.stub().resolves(true),
        findOneInDatabase: sinon.stub().resolves({ runningSince: new Date(Date.now() - 10 * MINUTE).toISOString() }),
        stoppedAppsCache: new Map([['data_rapp', '']]),
      });

      await chm.monitorAndRecoverApps('1.2.3.4', [inst], [], new Map([['rapp', view]]));

      expect(appDockerStart.called, 'within grace window -> not started').to.be.false;
    });

    it('starts a stopped syncthing component once the 30-minute grace has passed', async () => {
      const components = { data: comp(true, false) };
      const view = {
        componentNames: () => ['data'], hasSyncthing: () => true, hasActiveStandbySyncthing: () => false, getComponent: (n) => components[n],
      };
      const inst = { name: 'rapp', version: 8, hash: 'h', spec: {} };
      const { chm, appDockerStart } = load({
        getGlobalAppInfo: sinon.stub().resolves({ name: 'rapp' }),
        getDockerContainer: sinon.stub().resolves(true),
        findOneInDatabase: sinon.stub().resolves({ runningSince: new Date(Date.now() - 40 * MINUTE).toISOString() }),
        stoppedAppsCache: new Map([['data_rapp', '']]),
      });

      await chm.monitorAndRecoverApps('1.2.3.4', [inst], [], new Map([['rapp', view]]));

      expect(appDockerStart.calledWith('data_rapp'), 'grace passed -> started').to.be.true;
    });

    it('includes a syncthing app in masterSlaveAppsInstalled for broadcast even when a component is stopped', async () => {
      const components = { db: comp(true, true) };
      const view = {
        componentNames: () => ['db'], hasSyncthing: () => true, hasActiveStandbySyncthing: () => true, getComponent: (n) => components[n],
      };
      const inst = { name: 'gapp', version: 8, hash: 'h', spec: {} };
      const { chm } = load({
        getGlobalAppInfo: sinon.stub().resolves({ name: 'gapp' }),
        getDockerContainer: sinon.stub().resolves(true),
      });

      const result = await chm.monitorAndRecoverApps('1.2.3.4', [inst], [], new Map([['gapp', view]]));

      expect(result.masterSlaveAppsInstalled).to.include(inst);
    });
  });
});
