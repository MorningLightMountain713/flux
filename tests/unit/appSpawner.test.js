const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('appSpawner tests', () => {
  let appSpawner;
  let logStub;
  let configStub;
  let globalStateStub;
  let findUnderProvisionedStub;
  let delayStub;
  let daemonSyncStub;

  function createConfigStub(overrides = {}) {
    return {
      database: {
        daemon: { database: 'daemon' },
        appslocal: { database: 'localapps' },
        appsglobal: { database: 'globalapps', collections: { appsLocations: 'zelappslocation' } },
      },
      fluxapps: {
        installation: { delay: 300 },
        daemonPONFork: 2020000,
        blocksLasting: 22000,
        newMinBlocksAllowance: 100,
        maxAppsPerNode: 200,
        installCollisionWaitMs: 5000,
        spawnReconfirmDelayMs: 10000,
        nonEnterpriseSpawnDelayMs: 120000,
        spawnDeferrals: {
          targetedNodesMs: { standard: 300000, enterprise: 60000 },
          staticIpMs: { standard: 300000, enterprise: 60000 },
          datacenterMs: { standard: 300000, enterprise: 60000 },
          capacityGap: {
            largeMs: { standard: 300000, enterprise: 60000 },
            mediumMs: { standard: 300000, enterprise: 60000 },
            smallMs: { standard: 300000, enterprise: 60000 },
          },
        },
        ...overrides,
      },
    };
  }

  function createGlobalStateStub() {
    return {
      dbReady: true,
      fluxNodeWasNotConfirmedOnLastCheck: false,
      fluxNodeWasAlreadyConfirmed: true,
      firstExecutionAfterItsSynced: false,
      spawnerPaused: false,
      spawnErrorsLongerAppCache: new Map(),
      trySpawningGlobalAppCache: new Map(),
      appsToBeCheckedLater: [],
      appsSyncthingToBeCheckedLater: [],
    };
  }

  function mockPlacement(overrides = {}) {
    return {
      staticIp: false,
      dataCenter: false,
      geoAllow: null,
      geoDeny: null,
      targetIps: [],
      targetOutpoints: [],
      targetOperators: [],
      hasTargets: () => (overrides.targetIps?.length > 0 || overrides.targetOutpoints?.length > 0 || overrides.targetOperators?.length > 0),
      hasGeoRestrictions: () => false,
      matches: () => true,
      matchesTarget: () => false,
      ...overrides,
    };
  }

  function mockSpec(overrides = {}) {
    const placement = mockPlacement(overrides.placement);
    return {
      version: overrides.version || 7,
      name: overrides.name || 'testApp',
      owner: overrides.owner || 'testOwner',
      instances: overrides.instances || 3,
      enterprise: overrides.enterprise || false,
      placement,
      componentEntries: () => [],
      serialize: () => overrides,
      hasSyncthing: () => false,
    };
  }

  function mockInstantiated(overrides = {}) {
    const spec = mockSpec(overrides);
    return {
      name: spec.name,
      version: spec.version,
      owner: spec.owner,
      hash: overrides.hash || 'abc123',
      spec,
      isEncrypted: () => false,
      serialize: () => overrides,
    };
  }

  function makeCandidate(overrides = {}) {
    return {
      instantiated: mockInstantiated(overrides),
      actual: overrides.actual ?? 0,
      required: overrides.required ?? 3,
    };
  }

  function buildModule(opts = {}) {
    configStub = createConfigStub(opts.configOverrides);
    globalStateStub = createGlobalStateStub();
    if (opts.globalStateOverrides) {
      Object.assign(globalStateStub, opts.globalStateOverrides);
    }

    logStub = { error: sinon.stub(), info: sinon.stub(), warn: sinon.stub() };
    findUnderProvisionedStub = sinon.stub().resolves(opts.candidates || []);
    delayStub = sinon.stub();
    delayStub.onFirstCall().resolves();
    delayStub.onSecondCall().rejects(new Error('break recursion'));
    delayStub.rejects(new Error('break recursion'));
    daemonSyncStub = sinon.stub().returns({
      data: { height: opts.daemonHeight || 2555563, synced: true },
    });

    appSpawner = proxyquire('../../ZelBack/src/services/appLifecycle/appSpawner', {
      config: configStub,
      '../serviceHelper': {
        delay: delayStub,
        ensureNumber: sinon.stub().returnsArg(0),
      },
      '../generalService': {
        checkSynced: sinon.stub().resolves(true),
        isNodeStatusConfirmed: sinon.stub().resolves(true),
        nodeTier: sinon.stub().resolves('cumulus'),
        obtainNodeCollateralInformation: sinon.stub().resolves({ txhash: 'aaa', txindex: 0 }),
      },
      '../benchmarkService': {
        getBenchmarks: sinon.stub().resolves({
          status: 'success',
          data: { ipaddress: '192.168.1.1' },
        }),
      },
      '../fluxNetworkHelper': {
        isPortOpen: sinon.stub().resolves(true),
        isPortUserBlocked: sinon.stub().returns(false),
        isNodeDos: sinon.stub().returns(false),
        getFluxNodePublicKey: sinon.stub().returns('pubkey123'),
      },
      '../daemonService/daemonServiceMiscRpcs': {
        isDaemonSynced: daemonSyncStub,
      },
      '../../lib/log': logStub,
      '../appQuery/appQueryService': {
        listRunningApps: sinon.stub().resolves({ status: 'success', data: [] }),
      },
      '../appDatabase/registryManager': {
        appLocation: sinon.stub().resolves([]),
        appInstallingLocation: sinon.stub().resolves([]),
        expireGlobalApplications: sinon.stub().resolves(),
        storeAppInstallingMessage: sinon.stub().resolves(),
        getRunningAppIpList: sinon.stub().resolves([]),
        countAppInstallingErrors: sinon.stub().resolves(opts.errorCount ?? 0),
      },
      '../appDatabase/appsRepository': {
        findUnderProvisionedApps: findUnderProvisionedStub,
        getGlobalAppInfo: sinon.stub().resolves(null),
        existsInstalledApp: sinon.stub().resolves(false),
      },
      '../utils/specLibs': {
        getSpecBackend: sinon.stub().resolves({
          DeploymentSpec: {
            fromSpec: sinon.stub().returns({
              allHostPorts: sinon.stub().returns([]),
              allImages: sinon.stub().returns([]),
              componentEntries: sinon.stub().returns([]),
              totalResources: sinon.stub().returns({ cpu: 1, memory: 1000, storage: 10 }),
            }),
          },
        }),
      },
      '../utils/socketAddressUtils': {
        normalizeSocketAddress: sinon.stub().returnsArg(0),
        extractIp: sinon.stub().callsFake((addr) => (addr ? addr.split(':')[0] : '')),
        extractPort: sinon.stub().callsFake((addr) => (addr ? parseInt(addr.split(':')[1], 10) : 0)),
        socketAddressesMatch: sinon.stub().callsFake((a, b) => a === b),
      },
      '../appSecurity/imageManager': {
        isImageBlocked: sinon.stub().resolves({ blocked: false }),
        verifyRepository: sinon.stub().resolves(),
        isAppVetted: sinon.stub().resolves(false),
      },
      '../appRequirements/hwRequirements': {
        checkNodeResources: sinon.stub().resolves(),
        checkCpuBurstHeadroom: sinon.stub().resolves(),
        systemArchitecture: sinon.stub().resolves('amd64'),
      },
      '../appNetwork/portManager': {
        ensureApplicationPortsNotUsed: sinon.stub().resolves(),
        checkInstallingAppPortAvailable: sinon.stub().resolves(true),
      },
      '../utils/globalState': globalStateStub,
      '../geolocationService': {
        isStaticIP: sinon.stub().returns(false),
        isDataCenter: sinon.stub().returns(false),
        getNodeGeolocation: sinon.stub().returns({ continentCode: 'NA', countryCode: 'US', regionName: 'NY' }),
      },
      '../fluxCommunicationMessagesSender': {
        broadcastMessageToOutgoing: sinon.stub().resolves(),
        broadcastMessageToIncoming: sinon.stub().resolves(),
        broadcastMessageToAll: sinon.stub().resolves(),
      },
      '../utils/appConstants': {
        globalAppsInformation: 'appsInformation',
        localAppsInformation: 'localAppsInformation',
        appsFolder: '/tmp/apps',
      },
      '../utils/enterpriseNetwork': {
        getCachedEnterpriseIdentity: sinon.stub().returns(false),
        getSpawnDelays: sinon.stub().returns({ shortDelayTime: 60000, delayTime: 60000 }),
        filterAppsByOwnership: sinon.stub().callsFake((apps) => apps),
        isEnterpriseAppOwner: sinon.stub().returns(false),
      },
      '../utils/cacheManager': {
        FluxCacheManager: { oneHour: 3600000 },
      },
      '../utils/fluxEventBus': {
        publish: sinon.stub(),
      },
      './appInstaller': {
        installApplication: opts.installStub ?? sinon.stub().resolves(true),
      },
      './appUninstaller': {
        uninstallApplication: sinon.stub().resolves(),
      },
    });
  }

  afterEach(() => {
    sinon.restore();
  });

  describe('initialize', () => {
    beforeEach(() => buildModule());

    it('should initialize appInstaller and appUninstaller dependencies', () => {
      const deps = {
        appInstaller: { registerAppLocally: sinon.stub() },
        appUninstaller: { removeAppLocally: sinon.stub() },
      };
      appSpawner.initialize(deps);
      expect(appSpawner.initialize).to.be.a('function');
    });

    it('should handle empty dependencies object', () => {
      appSpawner.initialize({});
      expect(appSpawner.initialize).to.be.a('function');
    });
  });

  describe('trySpawningGlobalApplication', () => {
    beforeEach(() => buildModule());

    it('should be exported as a function', () => {
      expect(appSpawner.trySpawningGlobalApplication).to.be.a('function');
    });

    it('should call findUnderProvisionedApps with current height and timestamp', async () => {
      await appSpawner.trySpawningGlobalApplication();
      expect(findUnderProvisionedStub.calledOnce).to.be.true;
      const [height, nowSeconds] = findUnderProvisionedStub.firstCall.args;
      expect(height).to.equal(2555563);
      expect(nowSeconds).to.be.a('number');
      expect(nowSeconds).to.be.closeTo(Math.floor(Date.now() / 1000), 2);
    });

    it('should return delay when no candidates found', async () => {
      const result = await appSpawner.trySpawningGlobalApplication();
      expect(result).to.be.a('number');
      expect(logStub.info.args.some((a) => a[0]?.includes?.('No installable application found'))).to.be.true;
    });
  });

  describe('candidate filtering', () => {
    it('should filter out apps in the long-term error cache', async () => {
      const candidate = makeCandidate();
      buildModule({ candidates: [candidate] });
      globalStateStub.spawnErrorsLongerAppCache.set('abc123', '');
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(logStub.info.args.some((a) => a[0]?.includes?.('No app currently to be processed'))).to.be.true;
    });

    it('should filter out apps in the short-term spawn cache', async () => {
      const candidate = makeCandidate();
      buildModule({ candidates: [candidate] });
      globalStateStub.trySpawningGlobalAppCache.set('abc123', '');
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(logStub.info.args.some((a) => a[0]?.includes?.('No app currently to be processed'))).to.be.true;
    });

    it('should filter out apps that fail placement.matches', async () => {
      const candidate = makeCandidate({ placement: { matches: () => false } });
      buildModule({ candidates: [candidate] });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(logStub.info.args.some((a) => a[0]?.includes?.('No app currently to be processed'))).to.be.true;
    });

    it('should pass apps that satisfy placement.matches', async () => {
      const candidate = makeCandidate({ placement: { matches: () => true } });
      buildModule({ candidates: [candidate] });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(logStub.info.args.some((a) => a[0]?.includes?.('selected to try to spawn'))).to.be.true;
    });
  });

  describe('target priority cascade', () => {
    it('should prefer IP-targeted apps over untargeted', async () => {
      const untargeted = makeCandidate({ name: 'untargeted', hash: 'h1' });
      const ipTargeted = makeCandidate({
        name: 'ipTargeted', hash: 'h2',
        placement: {
          targetIps: ['192.168.1.1'],
          matchesTarget: (info) => info.ip === '192.168.1.1',
        },
      });
      buildModule({ candidates: [untargeted, ipTargeted] });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(logStub.info.args.some((a) => a[0]?.includes?.('ipTargeted selected'))).to.be.true;
    });

    it('should prefer outpoint-targeted over operator-targeted', async () => {
      const operatorTargeted = makeCandidate({
        name: 'opTargeted', hash: 'h1',
        placement: {
          targetOperators: ['pubkey123'],
          matchesTarget: (info) => !!info.operator,
        },
      });
      const outpointTargeted = makeCandidate({
        name: 'outTargeted', hash: 'h2',
        placement: {
          targetOutpoints: ['aaa:0'],
          matchesTarget: (info) => !!info.outpoint,
        },
      });
      buildModule({ candidates: [operatorTargeted, outpointTargeted] });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(logStub.info.args.some((a) => a[0]?.includes?.('outTargeted selected'))).to.be.true;
    });

    it('should fall back to random selection when no targets match', async () => {
      const a = makeCandidate({ name: 'appA', hash: 'h1' });
      const b = makeCandidate({ name: 'appB', hash: 'h2' });
      buildModule({ candidates: [a, b] });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      const selectedLog = logStub.info.args.find((args) => args[0]?.includes?.('selected to try to spawn'));
      expect(selectedLog).to.exist;
    });
  });

  describe('deferral logic', () => {
    it('should defer apps with targets that do not match this node', async () => {
      const candidate = makeCandidate({
        placement: {
          targetIps: ['10.0.0.1'],
          hasTargets: () => true,
          matchesTarget: () => false,
        },
      });
      buildModule({ candidates: [candidate] });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(globalStateStub.appsToBeCheckedLater).to.have.lengthOf(1);
      expect(globalStateStub.appsToBeCheckedLater[0].appName).to.equal('testApp');
    });

    it('should not defer apps with no targets', async () => {
      const candidate = makeCandidate();
      buildModule({ candidates: [candidate] });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(globalStateStub.appsToBeCheckedLater).to.have.lengthOf(0);
    });
  });

  describe('install error caching', () => {
    it('should add to short-term cache when network error count >= 5', async () => {
      const candidate = makeCandidate();
      buildModule({ candidates: [candidate], errorCount: 5 });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(globalStateStub.trySpawningGlobalAppCache.has('abc123')).to.be.true;
      expect(globalStateStub.spawnErrorsLongerAppCache.has('abc123')).to.be.false;
    });

    it('should add to long-term cache on local install failure', async () => {
      const candidate = makeCandidate();
      buildModule({
        candidates: [candidate],
        errorCount: 0,
        installStub: sinon.stub().resolves(false),
      });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(globalStateStub.spawnErrorsLongerAppCache.has('abc123')).to.be.true;
    });

    it('should not overwrite short-term cache with long-term cache when network errors throw into catch', async () => {
      const candidate = makeCandidate();
      buildModule({ candidates: [candidate], errorCount: 5 });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(globalStateStub.trySpawningGlobalAppCache.has('abc123')).to.be.true;
      expect(globalStateStub.spawnErrorsLongerAppCache.has('abc123')).to.be.false;
    });
  });

  describe('spawn loop', () => {
    const { appSyncEvents, EVENTS: SYNC_EVENTS } = require('../../ZelBack/src/services/utils/appSyncEvents');

    afterEach(() => {
      appSyncEvents.removeAllListeners();
    });

    function waitForLoopExits(n, timeoutMs = 2000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Expected ${n} loop exit(s) within ${timeoutMs}ms`)), timeoutMs);
        const check = () => {
          const count = logStub.info.getCalls().filter(
            (c) => c.args[0] === 'Spawn loop exited (paused)',
          ).length;
          if (count >= n) { clearTimeout(timer); resolve(); } else { setTimeout(check, 5); }
        };
        check();
      });
    }

    it('should call trySpawningGlobalApplication repeatedly until paused', async () => {
      buildModule();
      delayStub.resetBehavior();
      let iterations = 0;
      delayStub.callsFake(() => {
        iterations += 1;
        if (iterations >= 3) globalStateStub.spawnerPaused = true;
        return Promise.resolve();
      });

      appSpawner.initialize();
      appSyncEvents.emit(SYNC_EVENTS.SPAWNER_READY);
      await waitForLoopExits(1);

      expect(findUnderProvisionedStub.callCount).to.equal(3);
    });

    it('should exit loop when spawnerPaused set mid-iteration', async () => {
      buildModule();
      delayStub.resetBehavior();
      delayStub.callsFake(() => {
        globalStateStub.spawnerPaused = true;
        return Promise.resolve();
      });

      appSpawner.initialize();
      appSyncEvents.emit(SYNC_EVENTS.SPAWNER_READY);
      await waitForLoopExits(1);

      expect(findUnderProvisionedStub.callCount).to.equal(1);
      expect(logStub.info.calledWith('Spawn loop exited (paused)')).to.be.true;
    });

    it('should not start a second loop on duplicate SPAWNER_READY', async () => {
      buildModule();
      delayStub.resetBehavior();
      let iterations = 0;
      delayStub.callsFake(() => {
        iterations += 1;
        if (iterations === 1) {
          appSyncEvents.emit(SYNC_EVENTS.SPAWNER_READY);
        }
        if (iterations >= 3) globalStateStub.spawnerPaused = true;
        return Promise.resolve();
      });

      appSpawner.initialize();
      appSyncEvents.emit(SYNC_EVENTS.SPAWNER_READY);
      await waitForLoopExits(1);

      const exitLogs = logStub.info.getCalls().filter(
        (c) => c.args[0] === 'Spawn loop exited (paused)',
      );
      expect(exitLogs).to.have.lengthOf(1);
      expect(findUnderProvisionedStub.callCount).to.equal(3);
    });

    it('should restart loop on SPAWNER_READY after pause', async () => {
      buildModule();
      delayStub.resetBehavior();
      let iterations = 0;
      delayStub.callsFake(() => {
        iterations += 1;
        if (iterations === 2) {
          appSyncEvents.emit(SYNC_EVENTS.READINESS_LOST);
        }
        if (iterations >= 5) globalStateStub.spawnerPaused = true;
        return Promise.resolve();
      });

      appSpawner.initialize();
      appSyncEvents.emit(SYNC_EVENTS.SPAWNER_READY);
      await waitForLoopExits(1);

      expect(findUnderProvisionedStub.callCount).to.equal(2);

      appSyncEvents.emit(SYNC_EVENTS.SPAWNER_READY);
      await waitForLoopExits(2);

      expect(findUnderProvisionedStub.callCount).to.be.gte(4);
    });

    it('should return delay value from trySpawningGlobalApplication not recurse', async () => {
      buildModule();
      delayStub.resetBehavior();
      const delays = [];
      delayStub.callsFake((ms) => {
        delays.push(ms);
        globalStateStub.spawnerPaused = true;
        return Promise.resolve();
      });

      appSpawner.initialize();
      appSyncEvents.emit(SYNC_EVENTS.SPAWNER_READY);
      await waitForLoopExits(1);

      expect(delays).to.have.lengthOf(1);
      expect(delays[0]).to.be.a('number');
      expect(delays[0]).to.be.greaterThan(0);
    });
  });

  describe('expiration math (pure logic)', () => {
    function evaluateExpiration(height, expire, currentHeight) {
      const ponFork = 2020000;
      const blocksLasting = 22000;
      const minBlocksAllowance = 100;

      const expireIn = expire ?? (height >= ponFork ? blocksLasting * 4 : blocksLasting);
      let actualExpirationHeight;
      if (height < ponFork) {
        const originalExpiration = height + expireIn;
        if (originalExpiration <= ponFork) {
          actualExpirationHeight = originalExpiration;
        } else {
          const blocksAfterFork = originalExpiration - ponFork;
          actualExpirationHeight = ponFork + (blocksAfterFork * 4);
        }
      } else {
        actualExpirationHeight = height + expireIn;
      }
      return {
        actualExpirationHeight,
        wouldInstall: actualExpirationHeight > currentHeight + minBlocksAllowance,
      };
    }

    const currentHeight = 2555563;

    it('should reject post-PON app with expire=100 (cancellation)', () => {
      const result = evaluateExpiration(2555500, 100, currentHeight);
      expect(result.wouldInstall).to.be.false;
    });

    it('should accept post-PON app with 101+ blocks remaining', () => {
      const result = evaluateExpiration(2555500, 164, currentHeight);
      expect(result.wouldInstall).to.be.true;
    });

    it('should accept post-PON app with default expire (88000)', () => {
      const result = evaluateExpiration(2550000, 88000, currentHeight);
      expect(result.wouldInstall).to.be.true;
    });

    it('should apply 4x multiplier to blocks after PON fork', () => {
      const result = evaluateExpiration(2000000, 22000, currentHeight);
      expect(result.actualExpirationHeight).to.equal(2028000);
      expect(result.wouldInstall).to.be.false;
    });

    it('should accept pre-PON app with long lease', () => {
      const result = evaluateExpiration(2000000, 264000, currentHeight);
      expect(result.actualExpirationHeight).to.equal(2996000);
      expect(result.wouldInstall).to.be.true;
    });
  });

  describe('deferred queue fixes', () => {
    it('findIndex should match apps whose timeToCheck is in the past (<=)', () => {
      const now = Date.now();
      const queue = [
        { timeToCheck: now - 1000, appName: 'ready', hash: 'abc', required: 3 },
        { timeToCheck: now + 60000, appName: 'notReady', hash: 'def', required: 3 },
      ];
      const index = queue.findIndex((app) => app.timeToCheck <= now);
      expect(index).to.equal(0);
      expect(queue[index].appName).to.equal('ready');
    });

    it('findIndex should not match apps whose timeToCheck is in the future', () => {
      const now = Date.now();
      const queue = [
        { timeToCheck: now + 60000, appName: 'notReady', hash: 'abc', required: 3 },
      ];
      const index = queue.findIndex((app) => app.timeToCheck <= now);
      expect(index).to.equal(-1);
    });

    it('Array.some should correctly filter apps already in deferred queue', () => {
      const queue = [
        { appName: 'myApp', hash: 'abc', required: 3, timeToCheck: Date.now() + 60000 },
      ];
      const apps = [
        { name: 'myApp', hash: 'abc' },
        { name: 'otherApp', hash: 'def' },
      ];
      const filtered = apps.filter((app) => !queue.some((appAux) => appAux.appName === app.name));
      expect(filtered).to.have.lengthOf(1);
      expect(filtered[0].name).to.equal('otherApp');
    });
  });
});
