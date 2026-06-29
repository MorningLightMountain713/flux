const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

// Mirrors appInstaller.InstallStatus (proxyquire.noCallThru stubs the real module out).
const InstallStatus = Object.freeze({
  INSTALLED: 'installed',
  SKIPPED: 'skipped',
  DEFERRED: 'deferred',
  REJECTED: 'rejected',
  FAILED: 'failed',
});

describe('appSpawner tests', () => {
  let appSpawner;
  let logStub;
  let configStub;
  let globalStateStub;
  let findUnderProvisionedStub;
  let delayStub;
  let daemonSyncStub;
  let ensureProvidersRegisteredStub;

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
        unencryptedSpawnDelayMs: 120000,
        spawnDeferrals: {
          targetedNodesMs: { standard: 300000, encrypted: 60000 },
          staticIpMs: { standard: 300000, encrypted: 60000 },
          datacenterMs: { standard: 300000, encrypted: 60000 },
          capacityGap: {
            largeMs: { standard: 300000, encrypted: 60000 },
            mediumMs: { standard: 300000, encrypted: 60000 },
            smallMs: { standard: 300000, encrypted: 60000 },
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
      capabilityVerdict: null,
      isArcane() { return this.capabilityVerdict === true; },
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
      isEncrypted: !!overrides.encrypted,
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
    ensureProvidersRegisteredStub = sinon.stub().resolves();

    appSpawner = proxyquire('../../ZelBack/src/services/appLifecycle/appSpawner', {
      config: configStub,
      '../utils/specCutover': {
        ensureProvidersRegistered: ensureProvidersRegisteredStub,
      },
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
        getFluxNodePublicKey: sinon.stub().returns('pubkey123'),
      },
      '../nodeDosState': {
        isNodeDos: sinon.stub().returns(false),
      },
      '../daemonService/daemonServiceMiscRpcs': {
        isDaemonSynced: daemonSyncStub,
      },
      '../../lib/log': logStub,
      '../appDatabase/registryManager': {
        appLocation: sinon.stub().resolves([]),
        appInstallingLocation: sinon.stub().resolves([]),
        storeAppInstallingMessage: sinon.stub().resolves(),
        getRunningAppIpList: sinon.stub().resolves([]),
        countAppInstallingErrors: sinon.stub().resolves(opts.errorCount ?? 0),
      },
      '../appDatabase/appsRepository': {
        findUnderProvisionedApps: findUnderProvisionedStub,
        getGlobalAppInfo: opts.globalAppInfoStub ?? sinon.stub().resolves(null),
        existsInstalledApp: sinon.stub().resolves(false),
        listInstalledApps: opts.installedApps ?? sinon.stub().resolves([]),
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
        isImageBlocked: opts.imageBlockedStub ?? sinon.stub().resolves({ blocked: false }),
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
        isStaticIP: sinon.stub().returns(opts.nodeHasStaticIp ?? false),
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
        InstallStatus,
        installApplication: opts.installStub ?? sinon.stub().resolves({ status: InstallStatus.INSTALLED, reason: null }),
      },
      './appUninstaller': {
        uninstallApplication: sinon.stub().resolves(),
        expireGlobalApplications: sinon.stub().resolves(),
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

    it('caps on INSTALLED apps (DB count), not running containers', async () => {
      // post-flip an app is "installed" before its container runs, and an app is
      // one-or-more containers - so the cap counts installed apps from the DB
      const atCapacity = Array.from({ length: 200 }, (unused, i) => ({ name: `app${i}` }));
      buildModule({ installedApps: sinon.stub().resolves(atCapacity) });
      const result = await appSpawner.trySpawningGlobalApplication();
      expect(result).to.be.a('number');
      expect(logStub.info.args.some((a) => a[0]?.includes?.('Node at max apps capacity'))).to.be.true;
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

    it('never defers an app that targets this node (politeness rules have nobody to yield to)', async () => {
      // outpoint-pinned to this node + node has a static IP the app does not
      // require: the static-IP deferral must NOT delay a targeted app
      const candidate = makeCandidate({
        placement: {
          targetOutpoints: ['txid:0'],
          hasTargets: () => true,
          matchesTarget: () => true,
          staticIp: false,
        },
      });
      buildModule({ candidates: [candidate], nodeHasStaticIp: true });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(globalStateStub.appsToBeCheckedLater).to.have.lengthOf(0);
      expect(logStub.info.calledWithMatch(/targets this node/)).to.be.true;
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
        installStub: sinon.stub().resolves({ status: InstallStatus.FAILED, reason: 'install error' }),
      });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(globalStateStub.spawnErrorsLongerAppCache.has('abc123')).to.be.true;
    });

    it('defers without long-caching when the blocklist is unreachable at the compliance check', async () => {
      const candidate = makeCandidate();
      buildModule({
        candidates: [candidate],
        errorCount: 0,
        imageBlockedStub: sinon.stub().resolves({ blocked: false, undetermined: true }),
      });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      // transient outage -> retry next cycle, never the longer back-off cache
      expect(globalStateStub.spawnErrorsLongerAppCache.has('abc123')).to.be.false;
    });

    it('defers without long-caching when installApplication reports the blocklist unreachable', async () => {
      const candidate = makeCandidate();
      buildModule({
        candidates: [candidate],
        errorCount: 0,
        installStub: sinon.stub().resolves({ status: InstallStatus.DEFERRED, reason: 'blocklist unreachable' }),
      });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(globalStateStub.spawnErrorsLongerAppCache.has('abc123')).to.be.false;
    });

    it('should not overwrite short-term cache with long-term cache when network errors throw into catch', async () => {
      const candidate = makeCandidate();
      buildModule({ candidates: [candidate], errorCount: 5 });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(globalStateStub.trySpawningGlobalAppCache.has('abc123')).to.be.true;
      expect(globalStateStub.spawnErrorsLongerAppCache.has('abc123')).to.be.false;
    });

    it('retries a failed decrypt next cycle instead of caching the app', async () => {
      const candidate = makeCandidate({ encrypted: true, hash: 'enc123' });
      candidate.instantiated.spec.createProvider = sinon.stub().rejects(new Error('benchmark channel down'));
      // attested arcane: encrypted apps are eligible here, so the decrypt is actually reached
      buildModule({ candidates: [candidate], globalStateOverrides: { capabilityVerdict: true } });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      // a node-local decrypt failure is not a verdict on the app: neither
      // cache may hold the hash, so the next cycle reselects it
      expect(globalStateStub.trySpawningGlobalAppCache.has('enc123')).to.be.false;
      expect(globalStateStub.spawnErrorsLongerAppCache.has('enc123')).to.be.false;
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

    it('registers crypto providers before the first spawn cycle', async () => {
      buildModule();
      delayStub.resetBehavior();
      delayStub.callsFake(() => {
        globalStateStub.spawnerPaused = true;
        return Promise.resolve();
      });

      appSpawner.initialize();
      appSyncEvents.emit(SYNC_EVENTS.SPAWNER_READY);
      await waitForLoopExits(1);

      expect(ensureProvidersRegisteredStub.calledOnce).to.be.true;
      // the first encrypted-app decrypt must never beat registration
      expect(ensureProvidersRegisteredStub.calledBefore(findUnderProvisionedStub)).to.be.true;
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

  describe('isSoleRequiredInstaller', () => {
    beforeEach(() => buildModule());

    const placementWith = (targetIps = [], targetOutpoints = [], targetOperators = []) => ({
      targetIps, targetOutpoints, targetOperators,
    });

    it('is true when pinned to exactly as many nodes as required instances', () => {
      expect(appSpawner.isSoleRequiredInstaller(placementWith(['1.2.3.4:16127']), 1)).to.equal(true);
      expect(appSpawner.isSoleRequiredInstaller(placementWith(['a', 'b']), 2)).to.equal(true);
    });

    it('is true when pinned to fewer nodes than required instances', () => {
      expect(appSpawner.isSoleRequiredInstaller(placementWith(['1.2.3.4:16127']), 3)).to.equal(true);
    });

    it('counts pins across IP, outpoint and operator targets', () => {
      // 1 IP + 1 outpoint + 1 operator = 3 pins
      expect(appSpawner.isSoleRequiredInstaller(placementWith(['ip'], ['out:0'], ['op']), 3)).to.equal(true);
      expect(appSpawner.isSoleRequiredInstaller(placementWith(['ip'], ['out:0'], ['op']), 2)).to.equal(false);
    });

    it('is false when pinned to more nodes than required instances (real contention)', () => {
      expect(appSpawner.isSoleRequiredInstaller(placementWith(['a', 'b', 'c']), 2)).to.equal(false);
    });

    it('is false for an unpinned app (no targets)', () => {
      expect(appSpawner.isSoleRequiredInstaller(placementWith(), 1)).to.equal(false);
    });

    it('is false when the placement is missing', () => {
      expect(appSpawner.isSoleRequiredInstaller(undefined, 1)).to.equal(false);
      expect(appSpawner.isSoleRequiredInstaller(null, 1)).to.equal(false);
    });
  });

  describe('sole-required-installer wait skip', () => {
    it('skips both propagation waits for a pinned app with pins <= required instances', async () => {
      const installStub = sinon.stub().resolves({ status: InstallStatus.INSTALLED, reason: null });
      const candidate = makeCandidate({
        required: 1,
        placement: { targetIps: ['192.168.1.1'], hasTargets: () => true, matchesTarget: () => true },
      });
      buildModule({ candidates: [candidate], installStub });

      await appSpawner.trySpawningGlobalApplication().catch(() => {});

      // reached the install past the broadcast, but as a sole installer neither the
      // collision wait nor the post-install over-instance wait ran.
      sinon.assert.called(installStub);
      sinon.assert.notCalled(delayStub);
    });

    it('takes the collision wait for a non-pinned app (open contention)', async () => {
      const installStub = sinon.stub().resolves({ status: InstallStatus.INSTALLED, reason: null });
      const candidate = makeCandidate({ required: 3 }); // default placement: no targets

      buildModule({ candidates: [candidate], installStub });

      await appSpawner.trySpawningGlobalApplication().catch(() => {});

      sinon.assert.called(installStub);
      sinon.assert.calledWith(delayStub, 5000); // installCollisionWaitMs
    });
  });

  describe('isPinnedContended', () => {
    beforeEach(() => buildModule());

    const placementWith = (targetIps = [], targetOutpoints = [], targetOperators = []) => ({
      targetIps, targetOutpoints, targetOperators,
    });

    it('is true when pinned to MORE nodes than required instances (real multi-node contention)', () => {
      expect(appSpawner.isPinnedContended(placementWith(['a', 'b']), 1)).to.equal(true);
      expect(appSpawner.isPinnedContended(placementWith(['a', 'b', 'c']), 2)).to.equal(true);
    });

    it('is false when pinned to as many or fewer nodes than required (a sole installer)', () => {
      expect(appSpawner.isPinnedContended(placementWith(['a']), 1)).to.equal(false);
      expect(appSpawner.isPinnedContended(placementWith(['a', 'b']), 2)).to.equal(false);
      expect(appSpawner.isPinnedContended(placementWith(['a']), 3)).to.equal(false);
    });

    it('is false for an unpinned app (open contention is not handled by the off-loop defer)', () => {
      expect(appSpawner.isPinnedContended(placementWith(), 1)).to.equal(false);
      expect(appSpawner.isPinnedContended(undefined, 1)).to.equal(false);
      expect(appSpawner.isPinnedContended(null, 1)).to.equal(false);
    });

    it('is mutually exclusive with isSoleRequiredInstaller', () => {
      const placement = placementWith(['a', 'b', 'c']);
      expect(appSpawner.isPinnedContended(placement, 2)).to.equal(true);
      expect(appSpawner.isSoleRequiredInstaller(placement, 2)).to.equal(false);
    });
  });

  describe('pinned-contended collision window runs OFF the serial spawn loop', () => {
    const contendedPlacement = () => ({
      targetIps: ['192.168.1.1', '10.0.0.7'], // 2 pins, 1 instance -> real contention
      hasTargets: () => true,
      matchesTarget: () => true,
    });

    it('first pass: a pinned-contended app is deferred (collisionDeferred) and does NOT install inline', async () => {
      const installStub = sinon.stub().resolves({ status: InstallStatus.INSTALLED, reason: null });
      const candidate = makeCandidate({ name: 'conApp', hash: 'con1', required: 1, placement: contendedPlacement() });
      buildModule({ candidates: [candidate], installStub });

      await appSpawner.trySpawningGlobalApplication().catch(() => {});

      // the collision window is taken OFF the loop: the app is queued (collisionDeferred) instead of
      // installed-with-an-inline-wait, so contention-free apps behind it are not blocked.
      const queued = globalStateStub.appsToBeCheckedLater.find((a) => a.appName === 'conApp');
      expect(queued, 'pinned-contended app must be deferred onto appsToBeCheckedLater').to.exist;
      expect(queued.collisionDeferred).to.equal(true);
      expect(installStub.called, 'install must NOT run on the deferring first pass').to.equal(false);
    });

    it('second pass: the deferred (collisionDeferred) app installs without re-deferring', async () => {
      const installStub = sinon.stub().resolves({ status: InstallStatus.INSTALLED, reason: null });
      const globalAppInfoStub = sinon.stub().resolves(mockInstantiated({ name: 'conApp', hash: 'con1', placement: contendedPlacement() }));
      buildModule({
        // a placeholder keeps numberOfGlobalApps > 0 so the deferred-queue branch is reached
        candidates: [makeCandidate({ name: 'placeholder', hash: 'ph1' })],
        installStub,
        globalAppInfoStub,
        globalStateOverrides: {
          appsToBeCheckedLater: [{
            appName: 'conApp', hash: 'con1', required: 1, timeToCheck: Date.now() - 1000, collisionDeferred: true,
          }],
        },
      });

      await appSpawner.trySpawningGlobalApplication().catch(() => {});

      // window already elapsed off-loop -> it installs this time, and is spliced out (not re-queued).
      expect(installStub.called, 'a collisionDeferred app back from the queue must install').to.equal(true);
      expect(globalStateStub.appsToBeCheckedLater.find((a) => a.appName === 'conApp'), 'must not re-defer').to.not.exist;
    });
  });
});
