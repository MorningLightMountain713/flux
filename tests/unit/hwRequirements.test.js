const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

// ── Placement helpers ───────────────────────────────────────────────

function mockPlacement(overrides = {}) {
  return {
    staticIp: false,
    dataCenter: false,
    hasGeoRestrictions: () => false,
    hasGeoDeny: () => false,
    hasGeoAllow: () => false,
    isAllowedIn: () => true,
    isDeniedIn: () => false,
    hasTargets: () => false,
    matchesTarget: () => true,
    ...overrides,
  };
}

function mockSpec(overrides = {}) {
  return {
    name: 'testapp',
    version: 9,
    placement: mockPlacement(),
    ...overrides,
  };
}

function mockDeployment(resources = {}) {
  const defaults = {
    cpu: 1, memoryMb: 500, storageGb: 10, rootFsGb: 10, swapGb: 0, componentCount: 1,
  };
  const r = { ...defaults, ...resources };
  // Mirror the real shape: hostDiskGb is derived, never independently supplied,
  // so a stub cannot claim a footprint its own parts do not add up to.
  const totals = { ...r, hostDiskGb: r.storageGb + r.rootFsGb + r.swapGb };
  return {
    resourceTotals: () => totals,
    reservableHostDiskGb: () => totals.hostDiskGb,
  };
}

// ── Module builder ──────────────────────────────────────────────────

function buildHw(opts = {}) {
  const {
    cpucores = 16,
    ram = 32000,
    ssd = 500,
    appsCpusLocked = 0,
    appsRamLocked = 0,
    appsHddLocked = 0,
    resourcesStatus = 'success',
    lockedCpu = 10,
    lockedRam = 0,
    lockedHdd = 0,
    lockedExtrahdd = 0,
    isStaticIP = true,
    isDataCenter = true,
    nodeGeo = { continentCode: 'EU', countryCode: 'CZ', regionName: 'PRG' },
    localSocketAddr = '1.2.3.4:16127',
    collateral = { txhash: 'abc123', txindex: 0 },
    operatorPubKey = 'pubkey123',
    isEnterpriseAppOwner = true,
  } = opts;

  return proxyquire('../../ZelBack/src/services/appRequirements/hwRequirements', {
    '../benchmarkService': {
      getBenchmarks: sinon.stub().resolves({
        status: 'success',
        data: { cpucores, ram, ssd, architecture: 'amd64' },
      }),
    },
    '../generalService': {
      nodeTier: sinon.stub().resolves('cumulus'),
      obtainNodeCollateralInformation: sinon.stub().resolves(collateral),
    },
    '../geolocationService': {
      isStaticIP: sinon.stub().returns(isStaticIP),
      isDataCenter: sinon.stub().returns(isDataCenter),
      getPlacementLocation: sinon.stub().resolves(nodeGeo
        ? { continent: nodeGeo.continentCode, country: nodeGeo.countryCode }
        : null),
    },
    '../fluxNetworkHelper': {
      getLocalSocketAddress: sinon.stub().resolves(localSocketAddr),
      getFluxNodePublicKey: sinon.stub().resolves(operatorPubKey),
    },
    '../utils/enterpriseNetwork': {
      isEnterpriseAppOwner: sinon.stub().returns(isEnterpriseAppOwner),
    },
    '../utils/socketAddressUtils': {
      socketAddressesMatch: (a, b) => a === b,
    },
    '../appQuery/resourceQueryService': {
      appsResources: sinon.stub().resolves({
        status: resourcesStatus,
        data: { appsCpusLocked, appsRamLocked, appsHddLocked },
      }),
    },
    '../../lib/log': { error: sinon.stub(), info: sinon.stub(), warn: sinon.stub() },
    os: {
      cpus: sinon.stub().returns(new Array(cpucores)),
      totalmem: sinon.stub().returns(ram * 1024 * 1024),
    },
    config: {
      fluxSpecifics: {
        cpu: { cumulus: 2, nimbus: 4, stratus: 8 },
        ram: { cumulus: 4000, nimbus: 8000, stratus: 16000 },
        hdd: { cumulus: 220, nimbus: 440, stratus: 880 },
      },
      lockedSystemResources: {
        cpu: lockedCpu, ram: lockedRam, hdd: lockedHdd, extrahdd: lockedExtrahdd,
      },
    },
  });
}

describe('hwRequirements', () => {
  afterEach(() => sinon.restore());

  // ── Placement checks ────────────────────────────────────────────

  describe('checkPlacement', () => {
    describe('static IP', () => {
      it('passes when app does not require static IP', async () => {
        const hw = buildHw();
        const spec = mockSpec({ placement: mockPlacement({ staticIp: false }) });
        await hw.checkPlacement(spec);
      });

      it('passes when node has static IP and app requires it', async () => {
        const hw = buildHw({ isStaticIP: true });
        const spec = mockSpec({ placement: mockPlacement({ staticIp: true }) });
        await hw.checkPlacement(spec);
      });

      it('throws when node lacks static IP and app requires it', async () => {
        const hw = buildHw({ isStaticIP: false });
        const spec = mockSpec({ placement: mockPlacement({ staticIp: true }) });
        try {
          await hw.checkPlacement(spec);
          expect.fail('expected throw');
        } catch (err) {
          expect(err.message).to.include('static IP');
        }
      });
    });

    describe('data center', () => {
      it('passes when app does not require data center', async () => {
        const hw = buildHw();
        const spec = mockSpec({ placement: mockPlacement({ dataCenter: false }) });
        await hw.checkPlacement(spec);
      });

      it('throws when node is not a data center and app requires it', async () => {
        const hw = buildHw({ isDataCenter: false });
        const spec = mockSpec({ placement: mockPlacement({ dataCenter: true }) });
        try {
          await hw.checkPlacement(spec);
          expect.fail('expected throw');
        } catch (err) {
          expect(err.message).to.include('data center');
        }
      });

      it('throws when datacenter is requested by a non-enterprise app owner', async () => {
        // Runtime authorization: datacenter placement is restricted to enterprise app owners,
        // checked before the node-eligibility check.
        const hw = buildHw({ isEnterpriseAppOwner: false });
        const spec = mockSpec({ placement: mockPlacement({ dataCenter: true }) });
        try {
          await hw.checkPlacement(spec);
          expect.fail('expected throw');
        } catch (err) {
          expect(err.message).to.include('enterprise app owners');
        }
      });
    });

    describe('geolocation', () => {
      it('passes when no geo restrictions', async () => {
        const hw = buildHw();
        const spec = mockSpec({ placement: mockPlacement({ hasGeoRestrictions: () => false }) });
        await hw.checkPlacement(spec);
      });

      it('throws when node geolocation is not set', async () => {
        const hw = buildHw({ nodeGeo: null });
        const spec = mockSpec({
          placement: mockPlacement({
            hasGeoRestrictions: () => true,
          }),
        });
        try {
          await hw.checkPlacement(spec);
          expect.fail('expected throw');
        } catch (err) {
          expect(err.message).to.include('Geolocation not set');
        }
      });

      it('throws when node is in denied geo', async () => {
        const hw = buildHw();
        const spec = mockSpec({
          placement: mockPlacement({
            hasGeoRestrictions: () => true,
            isDeniedIn: () => true,
          }),
        });
        try {
          await hw.checkPlacement(spec);
          expect.fail('expected throw');
        } catch (err) {
          expect(err.message).to.include('forbidden');
        }
      });

      it('throws when node is not in allowed geo', async () => {
        const hw = buildHw();
        const spec = mockSpec({
          placement: mockPlacement({
            hasGeoRestrictions: () => true,
            isDeniedIn: () => false,
            isAllowedIn: () => false,
          }),
        });
        try {
          await hw.checkPlacement(spec);
          expect.fail('expected throw');
        } catch (err) {
          expect(err.message).to.include('not matching');
        }
      });

      it('passes when node is in allowed geo and not denied', async () => {
        const hw = buildHw();
        const spec = mockSpec({
          placement: mockPlacement({
            hasGeoRestrictions: () => true,
            isDeniedIn: () => false,
            isAllowedIn: () => true,
          }),
        });
        await hw.checkPlacement(spec);
      });
    });

    describe('targets', () => {
      it('passes when no targets set', async () => {
        const hw = buildHw();
        const spec = mockSpec({ placement: mockPlacement({ hasTargets: () => false }) });
        await hw.checkPlacement(spec);
      });

      it('passes for v8 even with targets (v8 does not enforce)', async () => {
        const hw = buildHw();
        const spec = mockSpec({
          version: 8,
          placement: mockPlacement({
            hasTargets: () => true,
            matchesTarget: () => false,
          }),
        });
        await hw.checkPlacement(spec);
      });

      it('throws for v7 when node does not match targets', async () => {
        const hw = buildHw();
        const spec = mockSpec({
          version: 7,
          placement: mockPlacement({
            hasTargets: () => true,
            matchesTarget: () => false,
          }),
        });
        try {
          await hw.checkPlacement(spec);
          expect.fail('expected throw');
        } catch (err) {
          expect(err.message).to.include('not allowed to run');
        }
      });

      it('passes for v7 when node matches targets', async () => {
        const hw = buildHw();
        const spec = mockSpec({
          version: 7,
          placement: mockPlacement({
            hasTargets: () => true,
            matchesTarget: () => true,
          }),
        });
        await hw.checkPlacement(spec);
      });

      it('throws for v9 when node does not match targets', async () => {
        const hw = buildHw();
        const spec = mockSpec({
          version: 9,
          placement: mockPlacement({
            hasTargets: () => true,
            matchesTarget: () => false,
          }),
        });
        try {
          await hw.checkPlacement(spec);
          expect.fail('expected throw');
        } catch (err) {
          expect(err.message).to.include('not allowed to run');
        }
      });
    });
  });

  // ── Resource checks ─────────────────────────────────────────────

  describe('checkNodeResources', () => {
    it('passes when node has enough resources', async () => {
      const hw = buildHw({ ssd: 500, cpucores: 16, ram: 32000 });
      const deployment = mockDeployment({ cpu: 1, memoryMb: 500, storageGb: 10 });
      await hw.checkNodeResources(deployment);
    });

    it('throws when node has zero SSD', async () => {
      const hw = buildHw({ ssd: 0 });
      const deployment = mockDeployment({ storageGb: 10 });
      try {
        await hw.checkNodeResources(deployment);
        expect.fail('expected throw');
      } catch (err) {
        expect(err.message).to.include('Insufficient space');
      }
    });

    it('throws when insufficient disk space', async () => {
      const hw = buildHw({ ssd: 20, appsHddLocked: 10 });
      const deployment = mockDeployment({ storageGb: 100 });
      try {
        await hw.checkNodeResources(deployment);
        expect.fail('expected throw');
      } catch (err) {
        expect(err.message).to.include('Insufficient space');
      }
    });

    it('throws when insufficient CPU', async () => {
      const hw = buildHw({ cpucores: 4, appsCpusLocked: 3 });
      const deployment = mockDeployment({ cpu: 100 });
      try {
        await hw.checkNodeResources(deployment);
        expect.fail('expected throw');
      } catch (err) {
        expect(err.message).to.include('Insufficient CPU');
      }
    });

    it('throws when insufficient RAM', async () => {
      const hw = buildHw({ ram: 4000, appsRamLocked: 3000 });
      const deployment = mockDeployment({ memoryMb: 2000 });
      try {
        await hw.checkNodeResources(deployment);
        expect.fail('expected throw');
      } catch (err) {
        expect(err.message).to.include('Insufficient RAM');
      }
    });

    it('throws when appsResources cannot be read', async () => {
      const hw = buildHw({ resourcesStatus: 'error' });
      const deployment = mockDeployment();
      try {
        await hw.checkNodeResources(deployment);
        expect.fail('expected throw');
      } catch (err) {
        expect(err.message).to.include('locked system resources');
      }
    });
  });

  describe('checkCpuBurstHeadroom', () => {
    it('passes when remaining free cores > 4', async () => {
      // 16 cores - 1 (system) - 3 (locked) - 2 (this app) = 10 > 4
      const hw = buildHw({ cpucores: 16, appsCpusLocked: 3, lockedCpu: 10 });
      const deployment = mockDeployment({ cpu: 2 });
      await hw.checkCpuBurstHeadroom(deployment);
    });

    it('throws when remaining free cores exactly 4 (boundary)', async () => {
      // 10 cores - 1 - 3 - 2 = 4 → throw
      const hw = buildHw({ cpucores: 10, appsCpusLocked: 3, lockedCpu: 10 });
      const deployment = mockDeployment({ cpu: 2 });
      try {
        await hw.checkCpuBurstHeadroom(deployment);
        expect.fail('expected throw');
      } catch (err) {
        expect(err.message).to.include('CPU burst headroom');
      }
    });

    it('passes at 5 free cores (just above boundary)', async () => {
      // 10 cores - 1 - 3 - 1 = 5 > 4
      const hw = buildHw({ cpucores: 10, appsCpusLocked: 3, lockedCpu: 10 });
      const deployment = mockDeployment({ cpu: 1 });
      await hw.checkCpuBurstHeadroom(deployment);
    });

    it('throws when over-subscribed (negative free cores)', async () => {
      // 8 cores - 1 - 5 - 4 = -2
      const hw = buildHw({ cpucores: 8, appsCpusLocked: 5, lockedCpu: 10 });
      const deployment = mockDeployment({ cpu: 4 });
      try {
        await hw.checkCpuBurstHeadroom(deployment);
        expect.fail('expected throw');
      } catch (err) {
        expect(err.message).to.include('CPU burst headroom');
      }
    });

    it('throws when appsResources cannot be read', async () => {
      const hw = buildHw({ resourcesStatus: 'error' });
      const deployment = mockDeployment();
      try {
        await hw.checkCpuBurstHeadroom(deployment);
        expect.fail('expected throw');
      } catch (err) {
        expect(err.message).to.include('locked system resources');
      }
    });
  });

  // ── Exports ─────────────────────────────────────────────────────

  // Some of what a node has committed is free, interruptible work. Asking for a
  // reading without it answers a different question from "does this fit": it
  // answers "is a playground session the only reason it does not".
  describe('reclaimable capacity', () => {
    const admissionControl = require('../../ZelBack/src/services/utils/admissionControl');
    const deploymentOf = (cpu, memory, hdd) => ({
      resourceTotals: () => ({ cpu, memoryMb: memory }),
      reservableHostDiskGb: () => hdd,
    });

    afterEach(() => {
      admissionControl.clear();
      admissionControl.setReclaimer(null);
    });

    it('reads the same both ways when nothing reclaimable is held', async () => {
      const hw = buildHw();
      admissionControl.reserve('paidapp', deploymentOf(2, 4000, 50));

      const held = await hw.nodeCapacity();
      const ignoring = await hw.nodeCapacity({ ignoreReclaimable: true });
      expect(ignoring).to.deep.equal(held);
    });

    // The invariant, stated as a difference so it holds whatever the node's own
    // numbers are: ignoring reclaimable work frees exactly what that work holds.
    it('frees exactly the reclaimable share, on every dimension', async () => {
      const hw = buildHw();
      admissionControl.reserve('op_s1', deploymentOf(2, 4000, 50), { reclaimable: true });

      const held = await hw.nodeCapacity();
      const ignoring = await hw.nodeCapacity({ ignoreReclaimable: true });

      expect(ignoring.availableCpu - held.availableCpu).to.equal(20); // tenths of a core
      expect(ignoring.availableRam - held.availableRam).to.equal(4000);
      expect(ignoring.availableSpace - held.availableSpace).to.equal(50);
      expect(ignoring.freeCores - held.freeCores).to.equal(2);
    });
  });

  // A redeploy and an update both remove containers BEFORE checking capacity, so
  // a throw there leaves a paid app destroyed rather than merely not started.
  describe('checkNodeResourcesReclaiming', () => {
    const admissionControl = require('../../ZelBack/src/services/utils/admissionControl');
    const deploymentOf = (cpu, memory, hdd) => ({
      resourceTotals: () => ({
        cpu, memoryMb: memory, storageGb: 0, rootFsGb: hdd, swapGb: 0, hostDiskGb: hdd,
      }),
      reservableHostDiskGb: () => hdd,
    });

    afterEach(() => {
      admissionControl.clear();
      admissionControl.setReclaimer(null);
    });

    it('passes where the plain check would throw, and asks for the capacity back', async () => {
      // 2 cores free, all of it held by a session.
      const hw = buildHw({ cpucores: 3, appsCpusLocked: 2, lockedCpu: 10 });
      admissionControl.reserve('op_s1', deploymentOf(2, 0, 0), { reclaimable: true });
      const asked = [];
      admissionControl.setReclaimer(async (totals) => { asked.push(totals); });

      let threw = null;
      await hw.checkNodeResources(deploymentOf(2, 0, 0)).catch((e) => { threw = e; });
      expect(threw, 'the plain check refuses a paid app mid-redeploy').to.be.an('error');

      expect(await hw.checkNodeResourcesReclaiming(deploymentOf(2, 0, 0))).to.equal(true);
      expect(asked.length, 'and the session is actually asked to yield').to.equal(1);
    });

    it('asks for nothing when the app fits without reclaiming', async () => {
      const hw = buildHw({ cpucores: 8, appsCpusLocked: 0, lockedCpu: 10 });
      const asked = [];
      admissionControl.setReclaimer(async (totals) => { asked.push(totals); });

      expect(await hw.checkNodeResourcesReclaiming(deploymentOf(1, 0, 0))).to.equal(true);
      expect(asked.length).to.equal(0);
    });

    it('still throws when the node is genuinely too small', async () => {
      const hw = buildHw({ cpucores: 2, appsCpusLocked: 0, lockedCpu: 10 });
      let threw = null;
      await hw.checkNodeResourcesReclaiming(deploymentOf(8, 0, 0)).catch((e) => { threw = e; });
      expect(threw).to.be.an('error');
    });
  });

  describe('exports', () => {
    it('exports the expected functions', () => {
      const hw = buildHw();
      expect(hw.checkPlacement).to.be.a('function');
      expect(hw.checkNodeResources).to.be.a('function');
      expect(hw.checkNodeResourcesReclaiming).to.be.a('function');
      expect(hw.checkCpuBurstHeadroom).to.be.a('function');
      expect(hw.systemArchitecture).to.be.a('function');
      expect(hw.getNodeSpecs).to.be.a('function');
    });
  });
});
