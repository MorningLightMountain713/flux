'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

// The real fit rule, not a restatement of it. capacityShortfall and
// burstHeadroomShortfall are pure and synchronous, so a stub could only
// re-implement them — and a re-implementation is free to drift from the rule
// the spawner actually applies in production.
const hwRequirementsActual = require('../../ZelBack/src/services/appRequirements/hwRequirements');

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
  let registryManagerStub;
  let deploymentFromSpecStub;
  let findUnderProvisionedStub;
  let delayStub;
  let daemonSyncStub;
  let ensureProvidersRegisteredStub;

  function createConfigStub(overrides = {}) {
    return {
      database: {
        daemon: { database: 'daemon' },
        appslocal: { database: 'localapps' },
        appsglobal: { database: 'globalapps', collections: {} },
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
      // targeting fields: arrays of node identity strings (ip / outpoint / operator)
      targetIps: [],
      targetOutpoints: [],
      targetOperators: [],
      hasTargets: () => ((overrides.targetIps || []).length > 0
        || (overrides.targetOutpoints || []).length > 0
        || (overrides.targetOperators || []).length > 0),
      hasGeoRestrictions: () => false,
      matches: () => true,
      // mirrors the real Placement: with no targets set, matchesTarget is
      // vacuously true ("run anywhere") — never stub it false for an
      // untargeted spec, that masks pinned-vs-eligible conflation bugs
      matchesTarget: () => true,
      isPinnedTo(nodeInfo) { return this.hasTargets() && this.matchesTarget(nodeInfo); },
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
      // The app-identity segment its containers are named from — minted at
      // registration and carried on the real InstantiatedSpec.
      identity: overrides.identity ?? 'a1b2c3d4e5f6',
      spec,
      isEncrypted: !!overrides.encrypted,
      // Mirrors InstantiatedSpec.requiresArcane(): every encrypted spec
      // requires Arcane; a cleartext spec only via an Arcane-requiring
      // feature (telemetry, content, shutdown, preStop) — forced in tests
      // with overrides.requiresArcane.
      requiresArcane: () => !!overrides.encrypted || !!overrides.requiresArcane,
      // Mirrors InstantiatedSpec.resourceTotals(): a readable spec sums its
      // components, a sealed v9 reads its cleartext summary, and a sealed v8
      // cannot answer at all — null meaning "cannot tell", never zero.
      // `resourceTotals: 'throws'` stands in for a spec whose resources cannot
      // be computed (a malformed legacy containerData does this in production).
      resourceTotals: () => {
        if (overrides.resourceTotals === 'throws') throw new Error('unparseable containerData');
        if (overrides.resourceTotals === null) return null;
        const r = {
          cpu: 1, memoryMb: 1000, storageGb: 10, rootFsGb: 2, swapGb: 0, componentCount: 1,
          ...(overrides.resourceTotals || {}),
        };
        return { ...r, hostDiskGb: r.storageGb + r.rootFsGb + r.swapGb };
      },
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
    // One source of truth for "is this app a follower", shared by both linker
    // entry points below.
    const isFollowerStub = opts.isPureFollower ?? sinon.stub().returns(false);
    configStub = createConfigStub(opts.configOverrides);
    globalStateStub = createGlobalStateStub();
    if (opts.globalStateOverrides) {
      Object.assign(globalStateStub, opts.globalStateOverrides);
    }

    logStub = { error: sinon.stub(), info: sinon.stub(), warn: sinon.stub() };
    deploymentFromSpecStub = sinon.stub().callsFake((spec, folder, options = {}) => ({
      identity: options.identity ?? spec.name,
      replica: options.replica ?? null,
      allHostPorts: sinon.stub().returns([]),
      allImages: sinon.stub().returns([]),
      componentEntries: sinon.stub().returns([]),
      resourceTotals: sinon.stub().returns({ cpu: 1, memoryMb: 1000, storageGb: 10 }),
    }));
    findUnderProvisionedStub = sinon.stub().resolves(opts.candidates || []);
    delayStub = sinon.stub();
    delayStub.onFirstCall().resolves();
    delayStub.onSecondCall().rejects(new Error('break recursion'));
    delayStub.rejects(new Error('break recursion'));
    daemonSyncStub = sinon.stub().returns({
      data: { height: opts.daemonHeight || 2555563, synced: true },
    });
    ensureProvidersRegisteredStub = sinon.stub().resolves();
    registryManagerStub = {
      appLocation: sinon.stub().resolves([]),
      appInstallingLocation: sinon.stub().resolves([]),
      installingCountsByApp: sinon.stub().resolves(opts.installingCounts ?? new Map()),
      storeAppInstallingMessage: sinon.stub().resolves(),
      removeAppInstallingMessage: sinon.stub().resolves(),
      getRunningAppIpList: sinon.stub().resolves([]),
      countAppInstallingErrors: sinon.stub().resolves(opts.errorCount ?? 0),
    };

    appSpawner = proxyquire('../../ZelBack/src/services/appLifecycle/appSpawner', {
      config: configStub,
      '../utils/specCutover': {
        ensureProvidersRegistered: ensureProvidersRegisteredStub,
      },
      '../serviceHelper': {
        delay: delayStub,
        ensureNumber: sinon.stub().returnsArg(0),
      },
      '../nodeConfirmationService': {
        isConfirmed: sinon.stub().returns(true),
      },
      '../generalService': {
        checkSynced: sinon.stub().resolves(true),
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
      '../appDatabase/registryManager': registryManagerStub,
      '../appDatabase/appsRepository': {
        findUnderProvisionedApps: findUnderProvisionedStub,
        getGlobalAppInfo: opts.globalAppInfoStub ?? sinon.stub().resolves(null),
        existsInstalledApp: sinon.stub().resolves(false),
        // Identities already installed here; empty means the spawn gate still
        // owes every assigned identity, which is the default fixture state.
        listInstalledIdentities: opts.installedIdentities ?? sinon.stub().resolves([]),
        listInstalledApps: opts.installedApps ?? sinon.stub().resolves([]),
      },
      '../utils/specLibs': {
        getSpecBackend: sinon.stub().resolves({
          DeploymentSpec: {
            // Mirrors DeploymentSpec.fromSpec: `identity ?? appName`, so a caller
            // that omits the identity produces a view named from the app's NAME —
            // which is what every port/ownership comparison then reads.
            fromSpec: deploymentFromSpecStub,
          },
          // notifySpecStored hydrates the raw stored doc into an InstantiatedSpec at
          // the perimeter; the test doc carries a placement object the stub passes through.
          InstantiatedSpec: {
            deserialize: (doc) => ({
              name: doc.name,
              owner: doc.owner,
              spec: { instances: doc.instances },
              placement: doc.placement,
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
      },
      '../appRequirements/hwRequirements': {
        checkNodeResources: sinon.stub().resolves(),
        checkCpuBurstHeadroom: sinon.stub().resolves(),
        systemArchitecture: sinon.stub().resolves('amd64'),
        // The real pair: one reading of free capacity, applied per candidate.
        // Defaults to a node with ample room so existing cases are unaffected;
        // opts.nodeCapacity shrinks it to exercise the screen.
        nodeCapacity: opts.nodeCapacityStub ?? sinon.stub().resolves(opts.nodeCapacity ?? {
          totalSpaceOnNode: 1000, availableSpace: 500, availableCpu: 200,
          availableRam: 100000, freeCores: 32,
        }),
        capacityShortfall: opts.capacityShortfall ?? hwRequirementsActual.capacityShortfall,
        burstHeadroomShortfall: opts.burstHeadroomShortfall
          ?? hwRequirementsActual.burstHeadroomShortfall,
      },
      '../appNetwork/portManager': {
        ensureApplicationPortsNotUsed: sinon.stub().resolves(),
        checkInstallingAppPortAvailable: sinon.stub().resolves(true),
      },
      '../utils/globalState': globalStateStub,
      '../geolocationService': {
        isStaticIP: sinon.stub().returns(opts.nodeHasStaticIp ?? false),
        isDataCenter: sinon.stub().returns(false),
        getPlacementLocation: sinon.stub().resolves({ continent: 'NA', country: 'US', region: 'US-NY' }),
      },
      '../fluxCommunicationMessagesSender': {
        broadcastMessageToOutgoing: sinon.stub().resolves(),
        broadcastMessageToIncoming: sinon.stub().resolves(),
        broadcastMessageToAll: opts.broadcastAllStub || sinon.stub().resolves(),
      },
      '../utils/appConstants': {
        globalAppsInformation: 'appsInformation',
        localAppsInformation: 'localAppsInformation',
        appsFolder: '/tmp/apps',
        INSTALLING_RENEWAL_MS: 12 * 60 * 1000,
      },
      '../utils/enterpriseNetwork': {
        getCachedEnterpriseIdentity: sinon.stub().returns(opts.getCachedEnterpriseIdentity ?? false),
        getSpawnDelays: sinon.stub().returns({ shortDelayTime: 60000, delayTime: 60000 }),
        filterAppsByOwnership: sinon.stub().callsFake((apps) => apps),
        isEnterpriseAppOwner: opts.isEnterpriseAppOwner || sinon.stub().returns(false),
      },
      '../utils/cacheManager': {
        FluxCacheManager: { oneHour: 3600000 },
      },
      '../appRuntime/deploymentProvider': {
        // [null] = loose placement (the single untagged claim); named tests
        // override with the replica names this node is assigned.
        assignedIdentities: opts.assignedIdentitiesStub ?? sinon.stub().resolves([null]),
      },
      '../utils/fluxEventBus': {
        publish: sinon.stub(),
      },
      './appInstaller': {
        InstallStatus,
        installApplication: opts.installStub ?? sinon.stub().resolves({ status: InstallStatus.INSTALLED, reason: null }),
        // Delegates at call time so per-test overrides of installApplication
        // flow through the fan-out entry the spawner now uses.
        get installAssignedReplicas() {
          const single = this.installApplication;
          return async (inst, o = {}) => {
            const result = await single(inst, { ...o, replica: null });
            return { ...result, results: [{ replica: null, ...result }] };
          };
        },
      },
      './relationshipResolver': {
        // Default: every candidate's dependencies are satisfied and no candidate
        // is a pure follower (matches the real module's behaviour for apps with
        // no dependencies/activation). Tests that exercise the readiness filter
        // or the follower suppression override these stubs.
        // The readiness filter picks one of these per candidate: the resolving
        // gate for a pinned app, the sealed check for the general pool. Tests
        // state the intent once and both are wired from it, so a candidate
        // answers the same either way regardless of how it is targeted.
        checkAppDependencyRequirements: opts.checkAppDependencyRequirements ?? sinon.stub().resolves(true),
        dependenciesReadyForSelection: opts.dependenciesReadyForSelection
          ?? opts.checkAppDependencyRequirements ?? sinon.stub().resolves(true),
        // Answering "is this a follower" means resolving the app's spec, so the
        // resolver exposes an async predicate and a batch form for the candidate
        // filter. Tests still state intent as one `isPureFollower` stub; both
        // are derived from it so they cannot disagree.
        isPureFollowerApp: sinon.stub().callsFake(async (app) => isFollowerStub(app)),
        pureFollowerNames: sinon.stub().callsFake(
          async (apps) => new Set((apps || []).filter((a) => a && isFollowerStub(a)).map((a) => a.name)),
        ),
        getRequiredDependencyNamesForNode: opts.getRequiredDependencyNamesForNode ?? sinon.stub().resolves(new Set()),
      },
      './pendingTeardownStore': {
        teardownOwedFor: opts.teardownOwedFor ?? sinon.stub().resolves(false),
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

    it('refuses a cleartext Arcane-requiring app on a non-Arcane node and remembers it', async () => {
      const candidate = makeCandidate({ requiresArcane: true });
      buildModule({ candidates: [candidate] });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(globalStateStub.spawnErrorsLongerAppCache.has('abc123'), 'long-error cache remembers the refusal').to.be.true;
      expect(logStub.info.args.some((a) => a[0]?.includes?.('requires ArcaneOS'))).to.be.true;
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

    it('skips the install trial when 5+ nodes report genuine failures (the re-armed network gate)', async () => {
      // only permanent verdicts are stored/broadcast now, so the count means the
      // app itself is broken - the node must not burn a trial rediscovering it
      const candidate = makeCandidate({ placement: { matches: () => true } });
      buildModule({ candidates: [candidate], errorCount: 5 });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(logStub.warn.args.some((a) => a[0]?.includes?.('network-wide install failures; skipping'))).to.be.true;
      expect(registryManagerStub.storeAppInstallingMessage.called, 'never proceeds to announce/install').to.be.false;
    });

    it('should filter out an app that is mid-teardown (teardown-aware selection)', async () => {
      buildModule({ candidates: [makeCandidate()], teardownOwedFor: sinon.stub().resolves(true) });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(logStub.info.args.some((a) => a[0]?.includes?.('No app currently to be processed'))).to.be.true;
      expect(logStub.info.args.some((a) => a[0]?.includes?.('selected to try to spawn'))).to.be.false;
    });
  });

  describe('claimed slots count toward coverage', () => {
    // The sieve counts running instances only, so an app other nodes are already
    // installing still reads as short. Selection is a lottery: such a candidate can
    // win the draw ahead of one this node could actually have installed.
    it('drops a candidate whose remaining slots are already claimed by installers', async () => {
      buildModule({
        candidates: [makeCandidate({ actual: 1, required: 3 })],
        installingCounts: new Map([['testapp', 2]]),
      });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(logStub.info.args.some((a) => a[0]?.includes?.('No app currently to be processed'))).to.be.true;
      expect(logStub.info.args.some((a) => a[0]?.includes?.('selected to try to spawn'))).to.be.false;
    });

    it('keeps a candidate whose claims still leave a slot open', async () => {
      buildModule({
        candidates: [makeCandidate({ actual: 1, required: 3 })],
        installingCounts: new Map([['testapp', 1]]),
      });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(logStub.info.args.some((a) => a[0]?.includes?.('selected to try to spawn'))).to.be.true;
    });

    // A network covered exactly is covered: 3 required and 3 running-plus-installing
    // means no seat is open, and proceeding installs a fourth instance.
    it('bails when running plus installing exactly meets the requirement', async () => {
      buildModule({ candidates: [makeCandidate({ actual: 0, required: 3 })] });
      registryManagerStub.appLocation.resolves([{ ip: '192.168.1.5:16127' }]);
      registryManagerStub.appInstallingLocation.resolves([
        { ip: '192.168.1.6:16127' }, { ip: '192.168.1.7:16127' },
      ]);
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(logStub.info.args.some((a) => a[0]?.includes?.('already spawned or being installed on 3 instances'))).to.be.true;
      expect(registryManagerStub.storeAppInstallingMessage.called, 'never announces a claim').to.be.false;
    });
  });

  describe('claim election ordering', () => {
    // Every contender runs the same election over the same rows and reads its
    // seat off the ranking, so the order must be total and identical on every
    // node - independent of each node's own row return order. Wake-synchronized
    // contenders claim within the same millisecond, so equal claim times are
    // the normal case, not the edge.
    it('ranks equal-claim-time rows identically from any starting order', () => {
      buildModule({});
      const rows = [
        { ip: '198.18.0.12:16127', announcedAt: 1000 },
        { ip: '198.18.0.10:16127', announcedAt: 1000 },
        { ip: '198.18.0.13:16127', announcedAt: 999 },
        { ip: '198.18.0.11:16127', announcedAt: 1000 },
      ];
      const oneOrder = [...rows].sort(appSpawner.compareClaimRows).map((r) => r.ip);
      const otherOrder = [...rows].reverse().sort(appSpawner.compareClaimRows).map((r) => r.ip);
      expect(oneOrder, 'the ranking is input-order independent').to.deep.equal(otherOrder);
      expect(oneOrder[0], 'the earliest claim still ranks first').to.equal('198.18.0.13:16127');
    });

    it('ranks co-located replica rows of one address deterministically', () => {
      buildModule({});
      const rows = [
        { ip: '198.18.0.10:16127', announcedAt: 1000, replica: 's2' },
        { ip: '198.18.0.10:16127', announcedAt: 1000, replica: 's1' },
      ];
      const oneOrder = [...rows].sort(appSpawner.compareClaimRows).map((r) => r.replica);
      const otherOrder = [...rows].reverse().sort(appSpawner.compareClaimRows).map((r) => r.replica);
      expect(oneOrder, 'the ranking is input-order independent').to.deep.equal(otherOrder);
    });
  });

  describe('pure-follower spawn suppression (manageCollectorLifecycle)', () => {
    it('flag on: drops a follower candidate that nothing assigned to this node requires', async () => {
      buildModule({
        candidates: [makeCandidate()],
        configOverrides: { manageCollectorLifecycle: true },
        isPureFollower: sinon.stub().returns(true),
        getRequiredDependencyNamesForNode: sinon.stub().resolves(new Set()),
      });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(logStub.info.args.some((a) => a[0]?.includes?.('No app currently to be processed'))).to.be.true;
      expect(logStub.info.args.some((a) => a[0]?.includes?.('selected to try to spawn'))).to.be.false;
    });

    it('flag on: keeps a follower candidate that an assigned app requires', async () => {
      buildModule({
        candidates: [makeCandidate()],
        configOverrides: { manageCollectorLifecycle: true },
        isPureFollower: sinon.stub().returns(true),
        getRequiredDependencyNamesForNode: sinon.stub().resolves(new Set(['testApp'])),
      });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(logStub.info.args.some((a) => a[0]?.includes?.('selected to try to spawn'))).to.be.true;
    });

    it('flag off (default): a follower is never suppressed - the console owns the lifecycle', async () => {
      buildModule({
        candidates: [makeCandidate()],
        isPureFollower: sinon.stub().returns(true),
        getRequiredDependencyNamesForNode: sinon.stub().resolves(new Set()),
      });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(logStub.info.args.some((a) => a[0]?.includes?.('selected to try to spawn'))).to.be.true;
    });

    it('flag on: a registry-read failure falls back to not suppressing', async () => {
      buildModule({
        candidates: [makeCandidate()],
        configOverrides: { manageCollectorLifecycle: true },
        isPureFollower: sinon.stub().returns(true),
        getRequiredDependencyNamesForNode: sinon.stub().rejects(new Error('registry read failed')),
      });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(logStub.info.args.some((a) => a[0]?.includes?.('selected to try to spawn'))).to.be.true;
    });

    it('flag on: the deferred-queue intake path is covered by the install gate (skip + throttle clear)', async () => {
      const queued = makeCandidate({ name: 'placeholder', hash: 'ph1' });
      buildModule({
        // a placeholder keeps the candidate pool non-empty so the deferred-queue branch is reached
        candidates: [queued],
        configOverrides: { manageCollectorLifecycle: true },
        isPureFollower: sinon.stub().returns(true),
        getRequiredDependencyNamesForNode: sinon.stub().resolves(new Set()),
        globalAppInfoStub: sinon.stub().resolves(mockInstantiated({ name: 'testApp', hash: 'abc123' })),
        globalStateOverrides: {
          appsToBeCheckedLater: [{
            appName: 'testApp', hash: 'abc123', required: 3, timeToCheck: Date.now() - 1000,
          }],
        },
      });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(logStub.info.args.some((a) => a[0]?.includes?.('is a pure follower and nothing on this node requires it'))).to.be.true;
      expect(globalStateStub.trySpawningGlobalAppCache.has('abc123')).to.be.false;
    });
  });

  describe('shareWith readiness selection filter', () => {
    function notReadyError() {
      return Object.assign(new Error("App 'collector' is not installed on this node"), { code: 'NETWORK_DEPENDENCY_NOT_READY' });
    }

    it('drops a candidate whose shareWith dependency is not ready', async () => {
      buildModule({
        candidates: [makeCandidate()],
        checkAppDependencyRequirements: sinon.stub().rejects(notReadyError()),
      });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(logStub.info.args.some((a) => a[0]?.includes?.('No app currently to be processed'))).to.be.true;
      expect(logStub.info.args.some((a) => a[0]?.includes?.('selected to try to spawn'))).to.be.false;
    });

    it('a PINNED candidate is checked through the resolving gate, the general pool is not', async () => {
      // The rule that keeps this off the hot path: a pinned app will be
      // installed here, so reading its links through the decrypted view costs
      // the same decrypt the install performs anyway. The general pool is many
      // candidates for at most one install, so it is read sealed. Getting this
      // backwards decrypts every candidate on every cycle.
      const gate = sinon.stub().resolves(true);
      const cheap = sinon.stub().resolves(true);
      buildModule({
        candidates: [
          makeCandidate({ name: 'pinnedApp', hash: 'pin1', placement: { targetIps: ['7.7.7.7:16127'] } }),
          makeCandidate({ name: 'generalApp', hash: 'gen1' }),
        ],
        checkAppDependencyRequirements: gate,
        dependenciesReadyForSelection: cheap,
      });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});

      expect(gate.getCalls().map((c) => c.args[0].name)).to.eql(['pinnedApp']);
      expect(cheap.getCalls().map((c) => c.args[0].name)).to.eql(['generalApp']);
    });

    it('outpoint- and operator-pinned candidates also take the resolving gate', async () => {
      // targetsThisNode ORs three predicates; testing only the IP branch would
      // leave two thirds of the rule unexercised.
      const gate = sinon.stub().resolves(true);
      const cheap = sinon.stub().resolves(true);
      buildModule({
        candidates: [
          makeCandidate({ name: 'byOutpoint', hash: 'o1', placement: { targetOutpoints: ['abc:0'] } }),
          makeCandidate({ name: 'byOperator', hash: 'r1', placement: { targetOperators: ['opkey'] } }),
          makeCandidate({ name: 'generalApp', hash: 'g1' }),
        ],
        checkAppDependencyRequirements: gate,
        dependenciesReadyForSelection: cheap,
      });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});

      expect(gate.getCalls().map((c) => c.args[0].name).sort()).to.eql(['byOperator', 'byOutpoint']);
      expect(cheap.getCalls().map((c) => c.args[0].name)).to.eql(['generalApp']);
    });

    it('does not error-cache a dropped candidate — it is reconsidered once the dependency appears', async () => {
      buildModule({
        candidates: [makeCandidate()],
        checkAppDependencyRequirements: sinon.stub().rejects(notReadyError()),
      });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(globalStateStub.spawnErrorsLongerAppCache.has('abc123')).to.be.false;
      expect(globalStateStub.trySpawningGlobalAppCache.has('abc123')).to.be.false;
      expect(globalStateStub.appsToBeCheckedLater).to.have.lengthOf(0);
    });

    it('keeps a candidate whose shareWith dependencies are ready', async () => {
      buildModule({
        candidates: [makeCandidate()],
        checkAppDependencyRequirements: sinon.stub().resolves(true),
      });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(logStub.info.args.some((a) => a[0]?.includes?.('selected to try to spawn'))).to.be.true;
    });

    it('keeps a candidate on a non-NOT_READY error — a real misconfig is handled at install', async () => {
      buildModule({
        candidates: [makeCandidate()],
        checkAppDependencyRequirements: sinon.stub().rejects(new Error('owned by a different owner')),
      });
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

  // Selection is a lottery over the surviving pool, so an app the node cannot
  // host does not merely waste its own cycle — it can win the draw ahead of one
  // that would have installed, and the node spawns nothing.
  describe('resource screening before selection', () => {
    const tightNode = {
      totalSpaceOnNode: 1000, availableSpace: 20, availableCpu: 20,
      availableRam: 2000, freeCores: 8,
    };

    // Anchored on the selection line specifically — the earlier "…can be
    // selected to try to spawn on my node" count line also contains the phrase.
    const selectedName = () => {
      for (const [message] of logStub.info.args) {
        const match = typeof message === 'string'
          && message.match(/Application (\S+) selected to try to spawn/);
        if (match) return match[1];
      }
      return null;
    };

    it('picks the app that fits over the one that does not', async () => {
      // Selection draws at random from the surviving pool, so pin the draw to
      // the first entry and put the oversized app there: without the screen
      // this selects tooBig, with it tooBig is gone and the draw lands on fits.
      // Left to chance the assertion would hold half the time either way.
      sinon.stub(Math, 'random').returns(0);
      const tooBig = makeCandidate({
        name: 'tooBig', hash: 'h1', resourceTotals: { memoryMb: 64000 },
      });
      const fits = makeCandidate({
        name: 'fits', hash: 'h2', resourceTotals: { cpu: 0.5, memoryMb: 500, storageGb: 5 },
      });
      buildModule({ candidates: [tooBig, fits], nodeCapacity: tightNode });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(selectedName()).to.equal('fits');
    });

    it('screens on RAM, CPU and host disk alike', async () => {
      for (const [label, totals] of [
        ['ram', { memoryMb: 64000 }],
        ['cpu', { cpu: 100 }],
        ['disk', { storageGb: 900 }],
      ]) {
        logStub.info.resetHistory();
        buildModule({
          candidates: [makeCandidate({ name: label, hash: `h-${label}`, resourceTotals: totals })],
          nodeCapacity: tightNode,
        });
        // eslint-disable-next-line no-await-in-loop
        await appSpawner.trySpawningGlobalApplication().catch(() => {});
        expect(selectedName(), label).to.equal(null);
      }
    });

    it('screens on burst headroom, not just whether the app fits', async () => {
      // Room for the cores, but installing it leaves the node unable to absorb
      // a spike — a distinct rule from "does it fit".
      buildModule({
        candidates: [makeCandidate({ name: 'burst', hash: 'hb', resourceTotals: { cpu: 5 } })],
        nodeCapacity: {
          totalSpaceOnNode: 1000, availableSpace: 500, availableCpu: 200,
          availableRam: 100000, freeCores: 8,
        },
      });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(selectedName()).to.equal(null);
    });

    it('keeps a candidate that cannot report its size — the install gate decides', async () => {
      // A sealed v8 spec: its format carries no cleartext summary, so the
      // sealed vantage answers null. Null is "cannot tell", never "needs
      // nothing", and must not be screened out on a guess.
      buildModule({
        candidates: [makeCandidate({ name: 'sealedV8', hash: 'h8', resourceTotals: null })],
        nodeCapacity: tightNode,
      });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(selectedName()).to.equal('sealedV8');
    });

    it('one unsizeable spec does not take down the sweep for the rest', async () => {
      const broken = makeCandidate({ name: 'broken', hash: 'hx', resourceTotals: 'throws' });
      const fits = makeCandidate({
        name: 'fits', hash: 'h2', resourceTotals: { cpu: 0.5, memoryMb: 500, storageGb: 5 },
      });
      buildModule({ candidates: [broken, fits], nodeCapacity: tightNode });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      // Both survive: the broken one is left to the install-time check rather
      // than guessed at, and the sweep still reaches the one that fits.
      expect(selectedName()).to.be.oneOf(['broken', 'fits']);
      expect(logStub.warn.args.some((a) => a[0]?.includes?.('could not size broken'))).to.be.true;
    });

    it('screens nothing when node capacity cannot be read', async () => {
      buildModule({
        candidates: [makeCandidate({ name: 'huge', hash: 'h1', resourceTotals: { memoryMb: 999999 } })],
        nodeCapacityStub: sinon.stub().rejects(new Error('benchmark unavailable')),
      });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      // Screening everything out on an unreadable reading would idle the node.
      expect(selectedName()).to.equal('huge');
      expect(logStub.warn.args.some((a) => a[0]?.includes?.('could not read node capacity'))).to.be.true;
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

    it('defers an untargeted app for politeness — vacuously-true matchesTarget must not read as pinned', async () => {
      // real Placement semantics: no targets -> matchesTarget true (run
      // anywhere). On a static-IP node the static-IP politeness deferral
      // still applies; only a genuinely pinned app skips it.
      const candidate = makeCandidate();
      buildModule({ candidates: [candidate], nodeHasStaticIp: true });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(globalStateStub.appsToBeCheckedLater).to.have.lengthOf(1);
      expect(logStub.info.calledWithMatch(/targets this node/)).to.be.false;
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
    it('skips cleanly at 5+ network errors without touching either local cache', async () => {
      // the shared error docs ARE the backoff - they expire in 24h and a respec
      // clears them, so a local cache entry would only delay the recovery
      const candidate = makeCandidate();
      buildModule({ candidates: [candidate], errorCount: 5 });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      expect(globalStateStub.trySpawningGlobalAppCache.has('abc123')).to.be.false;
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

    // Every ownership question downstream — the port guard first — compares the
    // app's IDENTITY. A view built without it reports the app's name instead, so
    // the app meets itself in the port map as a stranger and refuses its own port.
    it('builds its deployment views with the app identity, never falling back to the name', async () => {
      buildModule({
        candidates: [makeCandidate({ identity: 'a1b2c3d4e5f6' })],
        errorCount: 0,
        installStub: sinon.stub().resolves({ status: InstallStatus.INSTALLED, reason: null }),
      });

      await appSpawner.trySpawningGlobalApplication().catch(() => {});

      const calls = deploymentFromSpecStub.getCalls();
      expect(calls, 'the spawner built at least one deployment view').to.not.have.length(0);
      for (const call of calls) {
        expect(call.args[2], 'fromSpec options').to.include({ identity: 'a1b2c3d4e5f6' });
      }
    });

    it('retracts its own installing record when the install DEFERS (so the next cycle is not self-locked)', async () => {
      buildModule({
        candidates: [makeCandidate()],
        errorCount: 0,
        installStub: sinon.stub().resolves({ status: InstallStatus.DEFERRED, reason: 'node busy' }),
      });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      // the record was stored before install; a DEFERRED (not an install) must retract it
      sinon.assert.called(registryManagerStub.storeAppInstallingMessage);
      sinon.assert.called(registryManagerStub.removeAppInstallingMessage);
    });

    it('keeps its own installing record when the install SUCCEEDS', async () => {
      buildModule({
        candidates: [makeCandidate()],
        errorCount: 0,
        installStub: sinon.stub().resolves({ status: InstallStatus.INSTALLED, reason: null }),
      });
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
      sinon.assert.called(registryManagerStub.storeAppInstallingMessage);
      sinon.assert.notCalled(registryManagerStub.removeAppInstallingMessage);
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

    it('second pass under real contention: reaches the election, not the count-gate, and installs as the index-0 winner', async () => {
      const installStub = sinon.stub().resolves({ status: InstallStatus.INSTALLED, reason: null });
      const globalAppInfoStub = sinon.stub().resolves(mockInstantiated({ name: 'conApp', hash: 'con1', placement: contendedPlacement() }));
      buildModule({
        candidates: [makeCandidate({ name: 'placeholder', hash: 'ph1' })],
        installStub,
        globalAppInfoStub,
        globalStateOverrides: {
          appsToBeCheckedLater: [{
            appName: 'conApp', hash: 'con1', required: 1, timeToCheck: Date.now() - 1000, collisionDeferred: true,
          }],
        },
      });
      // Real multi-node contention: installing (2) > required (1). The blunt count
      // gate would return here on a fresh pass; on the collision-return pass it must
      // instead fall through to the broadcastedAt election. Our record broadcast
      // first, so the election ranks us index-0 and we install.
      registryManagerStub.appInstallingLocation.resolves([
        { ip: '192.168.1.1', broadcastedAt: 1000 },
        { ip: '10.0.0.7', broadcastedAt: 2000 },
      ]);

      await appSpawner.trySpawningGlobalApplication().catch(() => {});

      expect(installStub.called, 'the collision-return pass must reach the election and install the index-0 winner').to.equal(true);
    });

    it('second pass when the app reached target while parked: an empty scan still runs the entry, and the loser retracts + clears', async () => {
      const installStub = sinon.stub().resolves({ status: InstallStatus.INSTALLED, reason: null });
      const broadcastAllStub = sinon.stub().resolves();
      const globalAppInfoStub = sinon.stub().resolves(mockInstantiated({ name: 'conApp', hash: 'con1', placement: contendedPlacement() }));
      buildModule({
        // NOTHING is missing instances any more - the winners filled the app while
        // this contender sat parked. The no-candidates prefilter must not starve the
        // due entry, or the parked claim stands until the TTL (a phantom seat).
        candidates: [],
        installStub,
        broadcastAllStub,
        globalAppInfoStub,
        globalStateOverrides: {
          appsToBeCheckedLater: [{
            appName: 'conApp', hash: 'con1', required: 1, timeToCheck: Date.now() - 1000, collisionDeferred: true, announcedAt: 500,
          }],
        },
      });
      // One running instance fills the single seat; our standing claim is the only
      // installing row, so the election ranks us out (running + index + 1 > required).
      registryManagerStub.appLocation.resolves([{ ip: '10.0.0.7', runningSince: new Date() }]);
      registryManagerStub.appInstallingLocation.resolves([{ ip: '192.168.1.1', broadcastedAt: 500, announcedAt: 500 }]);

      await appSpawner.trySpawningGlobalApplication().catch(() => {});

      expect(installStub.called, 'a fully-served app must not install').to.equal(false);
      sinon.assert.calledWithMatch(registryManagerStub.removeAppInstallingMessage, 'conApp');
      const clearedSent = broadcastAllStub.getCalls().some((c) => c.args[0] && c.args[0].name === 'conApp' && c.args[0].cleared === true);
      expect(clearedSent, 'the parked claim must be cleared, not left to the TTL').to.equal(true);
    });
  });

  describe('installing claims (v2 announce / renewal / clear)', () => {
    const contendedPlacement = () => ({
      targetIps: ['192.168.1.1', '10.0.0.7'], // 2 pins, 1 instance -> real contention
      hasTargets: () => true,
      matchesTarget: () => true,
    });

    it('announces v1 to everyone and the v2 claim to claim-capable peers, storing the claim locally', async () => {
      const broadcastAllStub = sinon.stub().resolves();
      buildModule({ candidates: [makeCandidate()], broadcastAllStub });

      await appSpawner.trySpawningGlobalApplication().catch(() => {});

      const stored = registryManagerStub.storeAppInstallingMessage.firstCall.args[0];
      expect(stored.version).to.equal(2);
      expect(stored.announcedAt).to.be.a('number');
      expect(stored.broadcastedAt).to.equal(stored.announcedAt + 1);

      const calls = broadcastAllStub.getCalls();
      const v1Call = calls.find((c) => c.args[0].version === 1);
      const v2Call = calls.find((c) => c.args[0].version === 2 && !c.args[0].cleared);
      expect(v1Call, 'v1 announce must broadcast unfiltered').to.exist;
      expect(v1Call.args[1]).to.equal(undefined);
      expect(v2Call, 'v2 claim must broadcast capability-filtered').to.exist;
      expect(v2Call.args[0].announcedAt).to.equal(v1Call.args[0].broadcastedAt);
      expect(v2Call.args[1]).to.deep.equal({ requireCapability: 'appInstallingClaims' });
    });

    it('a named app announces one tagged v2 claim per assigned replica and no v1', async () => {
      const broadcastAllStub = sinon.stub().resolves();
      buildModule({
        candidates: [makeCandidate()],
        broadcastAllStub,
        assignedIdentitiesStub: sinon.stub().resolves(['s1', 's2']),
      });

      await appSpawner.trySpawningGlobalApplication().catch(() => {});

      const calls = broadcastAllStub.getCalls();
      // An untagged v1 row beside the per-replica claim rows would over-count this
      // node's seats, and no pre-claims node can parse a named app anyway.
      expect(calls.find((c) => c.args[0].version === 1), 'named placement must not announce v1').to.equal(undefined);
      const claims = calls.filter((c) => c.args[0].version === 2 && !c.args[0].cleared);
      expect(claims.map((c) => c.args[0].replica).sort()).to.deep.equal(['s1', 's2']);
      claims.forEach((c) => expect(c.args[1]).to.deep.equal({ requireCapability: 'appInstallingClaims' }));
      // One attempt, one announce time: both seats enter elections at the same rank.
      expect(new Set(claims.map((c) => c.args[0].announcedAt)).size).to.equal(1);
      const storedReplicas = registryManagerStub.storeAppInstallingMessage.getCalls().map((c) => c.args[0].replica);
      expect(storedReplicas.sort()).to.deep.equal(['s1', 's2']);
    });

    it('a failed named install retracts and clears every replica claim', async () => {
      const broadcastAllStub = sinon.stub().resolves();
      buildModule({
        candidates: [makeCandidate()],
        broadcastAllStub,
        installStub: sinon.stub().resolves({ status: InstallStatus.FAILED, reason: 'boom' }),
        assignedIdentitiesStub: sinon.stub().resolves(['s1', 's2']),
      });

      await appSpawner.trySpawningGlobalApplication().catch(() => {});

      const removed = registryManagerStub.removeAppInstallingMessage.getCalls().map((c) => c.args[2]);
      expect(removed.sort()).to.deep.equal(['s1', 's2']);
      const clears = broadcastAllStub.getCalls().filter((c) => c.args[0].cleared === true).map((c) => c.args[0].replica);
      expect(clears.sort()).to.deep.equal(['s1', 's2']);
    });

    it('broadcasts a neutral cleared claim when the install fails', async () => {
      const broadcastAllStub = sinon.stub().resolves();
      buildModule({
        candidates: [makeCandidate()],
        broadcastAllStub,
        installStub: sinon.stub().resolves({ status: InstallStatus.FAILED, reason: 'boom' }),
      });

      await appSpawner.trySpawningGlobalApplication().catch(() => {});

      sinon.assert.called(registryManagerStub.removeAppInstallingMessage);
      const clearedCall = broadcastAllStub.getCalls().find((c) => c.args[0].cleared === true);
      expect(clearedCall, 'a failed attempt must release its seat fleet-wide').to.exist;
      expect(clearedCall.args[0].version).to.equal(2);
      expect(clearedCall.args[1]).to.deep.equal({ requireCapability: 'appInstallingClaims' });
    });

    it('does not clear when the install succeeds', async () => {
      const broadcastAllStub = sinon.stub().resolves();
      buildModule({ candidates: [makeCandidate()], broadcastAllStub });

      await appSpawner.trySpawningGlobalApplication().catch(() => {});

      expect(broadcastAllStub.getCalls().find((c) => c.args[0].cleared === true)).to.equal(undefined);
    });

    it('first pass of a pinned-contended app leaves the claim standing for the parked election', async () => {
      const broadcastAllStub = sinon.stub().resolves();
      const candidate = makeCandidate({ name: 'conApp', hash: 'con1', required: 1, placement: contendedPlacement() });
      buildModule({
        candidates: [candidate],
        broadcastAllStub,
        assignedIdentitiesStub: sinon.stub().resolves(['s1']),
      });

      await appSpawner.trySpawningGlobalApplication().catch(() => {});

      // The claim IS the deferred election entry: retracting or clearing it here would
      // withdraw this node from an election it intends to contest on the second pass.
      sinon.assert.notCalled(registryManagerStub.removeAppInstallingMessage);
      expect(broadcastAllStub.getCalls().find((c) => c.args[0].cleared === true)).to.equal(undefined);
      const queued = globalStateStub.appsToBeCheckedLater.find((a) => a.appName === 'conApp');
      expect(queued.announcedAt, 'the deferred entry must carry the announce time').to.be.a('number');
      // The second pass retracts what the first pass claimed - the identities ride
      // the entry so a spec change between park and pop cannot orphan a row.
      expect(queued.replicas).to.deep.equal(['s1']);
    });

    it('second pass failure retracts the re-adopted claim and broadcasts the clear', async () => {
      const broadcastAllStub = sinon.stub().resolves();
      const installStub = sinon.stub().resolves({ status: InstallStatus.FAILED, reason: 'boom' });
      const globalAppInfoStub = sinon.stub().resolves(mockInstantiated({ name: 'conApp', hash: 'con1', placement: contendedPlacement() }));
      buildModule({
        candidates: [makeCandidate({ name: 'placeholder', hash: 'ph1' })],
        installStub,
        globalAppInfoStub,
        broadcastAllStub,
        globalStateOverrides: {
          appsToBeCheckedLater: [{
            appName: 'conApp', hash: 'con1', required: 1, timeToCheck: Date.now() - 1000, collisionDeferred: true, announcedAt: Date.now() - 60000, replicas: ['s1'],
          }],
        },
      });

      await appSpawner.trySpawningGlobalApplication().catch(() => {});

      sinon.assert.called(registryManagerStub.removeAppInstallingMessage);
      expect(registryManagerStub.removeAppInstallingMessage.firstCall.args[2]).to.equal('s1');
      const clearedCall = broadcastAllStub.getCalls().find((c) => c.args[0].cleared === true);
      expect(clearedCall, 'the second pass owns the claim again, so its failure must clear it').to.exist;
      expect(clearedCall.args[0].replica).to.equal('s1');
    });

    it('election ranks by announcedAt when present: a renewed claim (late broadcastedAt) still wins by announce order', async () => {
      const installStub = sinon.stub().resolves({ status: InstallStatus.INSTALLED, reason: null });
      const globalAppInfoStub = sinon.stub().resolves(mockInstantiated({ name: 'conApp', hash: 'con1', placement: contendedPlacement() }));
      buildModule({
        candidates: [makeCandidate({ name: 'placeholder', hash: 'ph1' })],
        installStub,
        globalAppInfoStub,
        globalStateOverrides: {
          appsToBeCheckedLater: [{
            appName: 'conApp', hash: 'con1', required: 1, timeToCheck: Date.now() - 1000, collisionDeferred: true, announcedAt: 1000,
          }],
        },
      });
      // Our row renewed (broadcastedAt moved to 5000) but announced first (1000); the
      // peer announced second (2000, v1 row - no announcedAt). broadcastedAt ordering
      // would rank us last; announce ordering must rank us first.
      registryManagerStub.appInstallingLocation.resolves([
        { ip: '192.168.1.1', broadcastedAt: 5000, announcedAt: 1000 },
        { ip: '10.0.0.7', broadcastedAt: 2000 },
      ]);

      await appSpawner.trySpawningGlobalApplication().catch(() => {});

      expect(installStub.called, 'the first announcer must win the election even after renewing').to.equal(true);
    });

    it('election ranks by announcedAt when present: a later announcer loses despite an older broadcastedAt', async () => {
      const installStub = sinon.stub().resolves({ status: InstallStatus.INSTALLED, reason: null });
      const globalAppInfoStub = sinon.stub().resolves(mockInstantiated({ name: 'conApp', hash: 'con1', placement: contendedPlacement() }));
      buildModule({
        candidates: [makeCandidate({ name: 'placeholder', hash: 'ph1' })],
        installStub,
        globalAppInfoStub,
        globalStateOverrides: {
          appsToBeCheckedLater: [{
            appName: 'conApp', hash: 'con1', required: 1, timeToCheck: Date.now() - 1000, collisionDeferred: true, announcedAt: 3000,
          }],
        },
      });
      registryManagerStub.appInstallingLocation.resolves([
        { ip: '192.168.1.1', broadcastedAt: 1000, announcedAt: 3000 },
        { ip: '10.0.0.7', broadcastedAt: 2000 },
      ]);

      await appSpawner.trySpawningGlobalApplication().catch(() => {});

      expect(installStub.called, 'a later announcer must stand down for the required-1 seat').to.equal(false);
    });

    it('renews the claim while the install is in flight (same announcedAt, fresh broadcastedAt)', async () => {
      const clock = sinon.useFakeTimers({ now: 1_000_000, toFake: ['setInterval', 'clearInterval', 'Date'] });
      try {
        let resolveInstall;
        const installStub = sinon.stub().returns(new Promise((resolve) => { resolveInstall = resolve; }));
        const broadcastAllStub = sinon.stub().resolves();
        buildModule({ candidates: [makeCandidate()], installStub, broadcastAllStub });

        const run = appSpawner.trySpawningGlobalApplication();
        await clock.tickAsync(0); // drive the attempt to the in-flight install await
        await clock.tickAsync(12 * 60 * 1000);

        const renewal = broadcastAllStub.getCalls().map((c) => c.args)
          .find(([m]) => m.version === 2 && !m.cleared && m.broadcastedAt > m.announcedAt + 1);
        expect(renewal, 'a 12-minute in-flight install must renew its claim').to.exist;
        expect(renewal[0].announcedAt, 'renewals must not move the announce time').to.equal(1_000_000);
        expect(renewal[1]).to.deep.equal({ requireCapability: 'appInstallingClaims' });

        resolveInstall({ status: InstallStatus.INSTALLED, reason: null });
        await run;

        // the finally must disarm the renewal: no further renewals after completion
        const broadcastsAfterRun = broadcastAllStub.callCount;
        await clock.tickAsync(12 * 60 * 1000);
        expect(broadcastAllStub.callCount).to.equal(broadcastsAfterRun);
      } finally {
        clock.restore();
      }
    });
  });

  describe('notifySpecStored - spec-stored wake gate', () => {
    const { appSyncEvents, EVENTS: SYNC_EVENTS } = require('../../ZelBack/src/services/utils/appSyncEvents');
    // harness benchmark IP; normalizeSocketAddress is identity in this harness
    const MY_ADDR = '192.168.1.1';

    afterEach(() => {
      appSyncEvents.removeAllListeners();
    });

    function woke() {
      return logStub.info.getCalls().some(
        (c) => typeof c.args[0] === 'string' && c.args[0].includes('waking spawn loop'),
      );
    }

    function waitForLoopExits(n, timeoutMs = 2000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Expected ${n} loop exit(s) within ${timeoutMs}ms`)), timeoutMs);
        const check = () => {
          const count = logStub.info.getCalls().filter((c) => c.args[0] === 'Spawn loop exited (paused)').length;
          if (count >= n) { clearTimeout(timer); resolve(); } else { setTimeout(check, 5); }
        };
        check();
      });
    }

    function waitUntil(predicate, timeoutMs = 2000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('waitUntil timed out')), timeoutMs);
        const check = () => {
          if (predicate()) { clearTimeout(timer); resolve(); } else { setTimeout(check, 5); }
        };
        check();
      });
    }

    // Run one spawn cycle so the module caches this node's socket address
    // (notifySpecStored's pin-match reads that cache).
    async function primeNodeAddr() {
      await appSpawner.trySpawningGlobalApplication().catch(() => {});
    }

    const placementFor = (targetIps, mode = 'candidate') => ({
      targetIps,
      targetOutpoints: [],
      targetOperators: [],
      mode: () => mode,
      matchesTarget: ({ ip, ipMatcher }) => targetIps.some((t) => ipMatcher(t, ip)),
      isPinnedTo(nodeInfo) { return targetIps.length > 0 && this.matchesTarget(nodeInfo); },
    });

    const passingSpec = (overrides = {}) => ({
      name: 'edingoa', owner: 'enterpriseOwnerX', instances: 1, placement: placementFor([MY_ADDR]), ...overrides,
    });

    it('wakes for an enterprise-owned app pinned to this node with pins <= instances', async () => {
      buildModule({ getCachedEnterpriseIdentity: true, isEnterpriseAppOwner: () => true });
      await primeNodeAddr();
      await appSpawner.notifySpecStored(passingSpec());
      expect(woke()).to.equal(true);
    });

    it('wakes when pinned to exactly as many nodes as required instances (no overshoot)', async () => {
      buildModule({ getCachedEnterpriseIdentity: true, isEnterpriseAppOwner: () => true });
      await primeNodeAddr();
      await appSpawner.notifySpecStored(passingSpec({ instances: 2, placement: placementFor([MY_ADDR, '10.0.0.9']) }));
      expect(woke()).to.equal(true);
    });

    it('does NOT wake on a non-enterprise node', async () => {
      buildModule({ getCachedEnterpriseIdentity: false, isEnterpriseAppOwner: () => true });
      await primeNodeAddr();
      await appSpawner.notifySpecStored(passingSpec());
      expect(woke()).to.equal(false);
    });

    it('does NOT wake for a non-enterprise-owned app', async () => {
      buildModule({ getCachedEnterpriseIdentity: true, isEnterpriseAppOwner: () => false });
      await primeNodeAddr();
      await appSpawner.notifySpecStored(passingSpec());
      expect(woke()).to.equal(false);
    });

    it('does NOT wake when pinned to more nodes than required instances (contention)', async () => {
      buildModule({ getCachedEnterpriseIdentity: true, isEnterpriseAppOwner: () => true });
      await primeNodeAddr();
      await appSpawner.notifySpecStored(passingSpec({ instances: 1, placement: placementFor([MY_ADDR, '10.0.0.9']) }));
      expect(woke()).to.equal(false);
    });

    it('does NOT wake when pinned to a different node', async () => {
      buildModule({ getCachedEnterpriseIdentity: true, isEnterpriseAppOwner: () => true });
      await primeNodeAddr();
      await appSpawner.notifySpecStored(passingSpec({ placement: placementFor(['10.0.0.9']) }));
      expect(woke()).to.equal(false);
    });

    it('does NOT wake before the first spawn cycle resolves this node address', async () => {
      buildModule({ getCachedEnterpriseIdentity: true, isEnterpriseAppOwner: () => true });
      // no primeNodeAddr() -> lastKnownLocalSocketAddr is null -> matchesTarget false
      await appSpawner.notifySpecStored(passingSpec());
      expect(woke()).to.equal(false);
    });

    it('does NOT wake when the spawner is paused', async () => {
      buildModule({ getCachedEnterpriseIdentity: true, isEnterpriseAppOwner: () => true });
      await primeNodeAddr();
      globalStateStub.spawnerPaused = true;
      await appSpawner.notifySpecStored(passingSpec());
      expect(woke()).to.equal(false);
    });

    it('does not throw on a missing spec', async () => {
      buildModule({ getCachedEnterpriseIdentity: true, isEnterpriseAppOwner: () => true });
      await primeNodeAddr();
      await appSpawner.notifySpecStored(undefined);
      expect(woke()).to.equal(false);
    });

    it('ends the idle delay early and re-scans when a pinned spec is stored', async () => {
      buildModule({ getCachedEnterpriseIdentity: true, isEnterpriseAppOwner: () => true });
      delayStub.resetBehavior();
      let delayCalls = 0;
      delayStub.callsFake(() => {
        delayCalls += 1;
        // 1st idle wait parks until woken; 2nd ends the loop so the test finishes
        if (delayCalls >= 2) { globalStateStub.spawnerPaused = true; return Promise.resolve(); }
        return new Promise(() => {});
      });

      appSpawner.initialize();
      appSyncEvents.emit(SYNC_EVENTS.SPAWNER_READY);
      await waitUntil(() => findUnderProvisionedStub.callCount === 1 && delayCalls === 1);

      // Causality guard: the first delay never resolves on its own, so the loop is parked
      // at exactly one scan. Only the wake can advance it.
      expect(findUnderProvisionedStub.callCount).to.equal(1);
      await appSpawner.notifySpecStored(passingSpec());
      await waitForLoopExits(1);

      expect(findUnderProvisionedStub.callCount).to.equal(2);
    });

    it('leaves the idle cadence intact when no relevant spec is stored', async () => {
      // regression: the wake is inert; serviceHelper.delay still drives the loop
      buildModule({ getCachedEnterpriseIdentity: true, isEnterpriseAppOwner: () => true });
      delayStub.resetBehavior();
      let delayCalls = 0;
      delayStub.callsFake(() => {
        delayCalls += 1;
        globalStateStub.spawnerPaused = true;
        return Promise.resolve();
      });

      appSpawner.initialize();
      appSyncEvents.emit(SYNC_EVENTS.SPAWNER_READY);
      await waitForLoopExits(1);

      expect(delayCalls).to.equal(1);
      expect(findUnderProvisionedStub.callCount).to.equal(1);
    });
  });

  describe('spawn loop wake latch (mid-cycle wake)', () => {
    const { appSyncEvents, EVENTS: SYNC_EVENTS } = require('../../ZelBack/src/services/utils/appSyncEvents');
    const MY_ADDR = '192.168.1.1';

    afterEach(() => {
      appSyncEvents.removeAllListeners();
    });

    function waitForLoopExits(n, timeoutMs = 2000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Expected ${n} loop exit(s)`)), timeoutMs);
        const check = () => {
          const count = logStub.info.getCalls().filter((c) => c.args[0] === 'Spawn loop exited (paused)').length;
          if (count >= n) { clearTimeout(timer); resolve(); } else { setTimeout(check, 5); }
        };
        check();
      });
    }

    it('latches a wake that fires mid-cycle and skips the next idle delay', async () => {
      buildModule({ getCachedEnterpriseIdentity: true, isEnterpriseAppOwner: () => true });

      const events = []; // ordered record of 'cycleN' and 'delay'
      let cycle = 0;
      findUnderProvisionedStub.resetBehavior();
      findUnderProvisionedStub.callsFake(async () => {
        cycle += 1;
        events.push(`cycle${cycle}`);
        if (cycle === 1) {
          // Fire the wake DURING cycle 1, when idleWakeResolve is null (it is only set inside
          // the inter-cycle Promise.race AFTER trySpawning returns). Await it so the async gate
          // resolves and wakeIdleLoop latches wakePending BEFORE cycle 1 returns - the latch
          // must then skip cycle 1's park. The cycle has already cached this node's address,
          // so the pin-match passes.
          await appSpawner.notifySpecStored({
            name: 'edingoa', owner: 'enterpriseOwnerX', instances: 1,
            placement: {
              targetIps: [MY_ADDR],
              targetOutpoints: [],
              targetOperators: [],
              mode: () => 'candidate',
              matchesTarget: ({ ip, ipMatcher }) => ipMatcher(MY_ADDR, ip),
              isPinnedTo({ ip, ipMatcher }) { return ipMatcher(MY_ADDR, ip); },
            },
          });
        }
        return [];
      });
      delayStub.resetBehavior();
      delayStub.callsFake(() => {
        events.push('delay');
        globalStateStub.spawnerPaused = true; // pause as soon as a delay actually runs
        return Promise.resolve();
      });

      appSpawner.initialize();
      appSyncEvents.emit(SYNC_EVENTS.SPAWNER_READY);
      await waitForLoopExits(1);

      // With the latch: cycle1 -> (latched wake -> skip delay) -> cycle2 -> delay -> pause.
      // Without it: cycle1 -> delay -> pause, and cycle2 never runs (the wake was dropped).
      expect(events).to.include('cycle2');
      expect(events.indexOf('cycle2')).to.be.lessThan(events.indexOf('delay'));
    });
  });

  describe('installing-broadcast fire-and-forget on sole-installer', () => {
    const MY_ADDR = '192.168.1.1';
    const solePlacement = () => ({ targetIps: [MY_ADDR], hasTargets: () => true, matchesTarget: () => true });

    it('sole path: install proceeds even if the broadcast REJECTS (fire-and-forget)', async () => {
      const installStub = sinon.stub().resolves({ status: InstallStatus.INSTALLED, reason: null });
      const candidate = makeCandidate({ name: 'soleApp', hash: 'sole1', required: 1, placement: solePlacement() });
      buildModule({ candidates: [candidate], installStub, broadcastAllStub: sinon.stub().rejects(new Error('broadcast down')) });

      await appSpawner.trySpawningGlobalApplication().catch(() => {});

      // soleRequiredInstaller -> the broadcast is fire-and-forget (.catch), so a broadcast
      // failure does NOT abort: the install still runs.
      expect(installStub.called, 'install should proceed despite the broadcast failing').to.equal(true);
    });

    it('non-sole path: a broadcast REJECT aborts before install (awaited)', async () => {
      const installStub = sinon.stub().resolves({ status: InstallStatus.INSTALLED, reason: null });
      const candidate = makeCandidate({ required: 3 }); // non-pinned: legacy inline election awaits the broadcast
      buildModule({ candidates: [candidate], installStub, broadcastAllStub: sinon.stub().rejects(new Error('broadcast down')) });

      await appSpawner.trySpawningGlobalApplication().catch(() => {});

      expect(installStub.called, 'a rejected awaited broadcast must abort before install').to.equal(false);
    });
  });
});
