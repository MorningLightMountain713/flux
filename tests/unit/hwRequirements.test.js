'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const {
  loadSpecLibrary, V8_SUBMISSION, V9_SUBMISSION, v8Spec, v9Spec, instantiatedSpec,
} = require('./fixtures/fluxSpec');

// The spec library is real here, not stubbed — see tests/unit/fixtures/fluxSpec.js
// for why. hwRequirements is the module a hand-written Placement hurt most: it
// asks `spec.placement.hasTargets()` and `spec.placement.matchesTarget(...)` and
// takes the answers as the node's permission to run an app. A double that
// answered `hasTargets: () => false, matchesTarget: () => true` is exactly the
// shape the v5-v8 conversion bug produced in production — a legacy `nodes` pin
// list that restricted nothing — so the double could not have caught it and the
// tests written against it asserted the bug.
//
// What stays stubbed is I/O and node-local facts: the benchmark channel, the
// daemon collateral lookup, the geolocation resolver, the node-tier lookup and
// the installed-app resource query. socketAddressUtils is NOT stubbed — it is a
// pure comparison, and it is what decides whether a spec targeting `1.2.3.4`
// matches a node whose local socket is `1.2.3.4:16127`.
let flux;

// This node's three identities, as the stubbed I/O below reports them. A spec
// that targets this node names one of these VALUES: a real Placement decides
// matchesTarget from its own target arrays, so there is no `matchesTarget:
// () => true` to write and a placement naming some other node genuinely misses.
const MY_IP = '1.2.3.4';
const MY_ADDR = `${MY_IP}:16127`;
// A real txid. The harness used to report `abc123` as this node's collateral
// hash, which no spec could ever have targeted: both the v9 assignment keys and
// the v9 placement.targetOutpoints entries are schema-checked as 64 hex + ':' +
// vout, so the outpoint branch of matchesTarget was unreachable by construction.
const MY_TXHASH = 'a'.repeat(64);
const MY_OUTPOINT = `${MY_TXHASH}:0`;
const MY_OPERATOR = 'pubkey123';
const OTHER_IP = '9.9.9.9';
const APPS_FOLDER = '/tmp/apps';

// ── Real spec builders ──────────────────────────────────────────────

/**
 * A real v9 components blob, resized. Every size below is inside the schema's
 * own caps — cpu 0.1-14 in steps of 0.1, memory 100-57000 MB in steps of 100,
 * rootFsGb > 0, persistentStorage.sizeGb <= 780 — which is why the node
 * capacities below are small: the 100-core and 64000 MB apps the hand-written
 * double accepted cannot be registered at all.
 */
function sizedComponents({
  cpu = 0.5, memory = 300, storageGb = 5, rootFsGb = 2, swapGb = 0,
} = {}) {
  const components = JSON.parse(JSON.stringify(V9_SUBMISSION.components));
  const { web } = components;
  web.cpu = cpu;
  web.memory = memory;
  web.rootFsGb = rootFsGb;
  web.swapGb = swapGb;
  web.persistentStorage.sizeGb = storageGb;
  // A stateless component cannot keep its mounts: the library refuses a mount
  // with nowhere to land rather than silently dropping it, so shrinking storage
  // to 0 means declaring no mounts.
  if (storageGb === 0) delete web.persistentStorage.mounts;
  return components;
}

/** A real DeploymentSpec of a stated size — what checkNodeResources and
 * checkCpuBurstHeadroom are handed in production, and what admissionControl
 * reserves against. hostDiskGb is derived by the library from storage + rootFs
 * + swap, so a fixture cannot claim a footprint its own parts do not add up to. */
async function deploymentOfSize(size) {
  const spec = await v9Spec({ components: sizedComponents(size) });
  return flux.DeploymentSpec.fromSpec(spec, APPS_FOLDER, { replica: null });
}

/**
 * A real FluxAppSpecV7 — the last version that enforces node targeting at
 * install time, which is the whole reason this file needs one: production's
 * checkTargets treats v8 as the exemption and everything else as enforcing, so
 * testing only v8 and v9 would leave the enforcing branch of a LEGACY spec
 * unexercised.
 *
 * Derived from V8_SUBMISSION's own fields, the way the shared fixture derives
 * its v1 spec, so the two stay describing the same app. v7 has no submission
 * schema; `nodes` is the mixed-identity legacy array, converted to typed
 * Placement targets by the library.
 */
async function v7Spec(overrides = {}) {
  return flux.FluxAppSpecBase.getVersionClass(7).fromSubmission({
    version: 7,
    name: V8_SUBMISSION.name,
    description: V8_SUBMISSION.description,
    owner: V8_SUBMISSION.owner,
    compose: JSON.parse(JSON.stringify(V8_SUBMISSION.compose)),
    instances: V8_SUBMISSION.instances,
    contacts: [],
    geolocation: [],
    expire: V8_SUBMISSION.expire,
    nodes: [],
    staticip: false,
    ...overrides,
  });
}

/** A real v9 spec whose named replica is PINNED to a node identity. `instances`
 * is derived from the assignment, so it must not be authored alongside it. */
async function v9PinnedSpec(assignment) {
  return v9Spec({ assignment, instances: undefined });
}

/** Await a rejection and read its message, so a silently-resolving check cannot
 * pass as a throw. */
async function rejectsWith(promise, fragment) {
  let threw = null;
  await promise.catch((err) => { threw = err; });
  expect(threw, `expected a rejection mentioning "${fragment}"`).to.be.an('error');
  expect(threw.message).to.include(fragment);
  return threw;
}

// ── Module builder ──────────────────────────────────────────────────

// The stubbed collaborators of the most recently built module, so a test can
// read back what production handed them.
let enterpriseNetworkStub;

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
    // The shape geolocationService.getPlacementLocation actually returns, and
    // the vocabulary a real Placement matches against: geonames continent code
    // plus ISO 3166-1 alpha-2 country. null = the node cannot place itself.
    nodeLocation = { continent: 'EU', country: 'CZ' },
    localSocketAddr = MY_ADDR,
    collateral = { txhash: MY_TXHASH, txindex: 0 },
    operatorPubKey = MY_OPERATOR,
    isEnterpriseAppOwner = true,
  } = opts;

  enterpriseNetworkStub = {
    isEnterpriseAppOwner: sinon.stub().returns(isEnterpriseAppOwner),
  };

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
      getPlacementLocation: sinon.stub().resolves(nodeLocation),
    },
    '../fluxNetworkHelper': {
      getLocalSocketAddress: sinon.stub().resolves(localSocketAddr),
      getFluxNodePublicKey: sinon.stub().resolves(operatorPubKey),
    },
    '../utils/enterpriseNetwork': enterpriseNetworkStub,
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
  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(60000);
    flux = await loadSpecLibrary();
  });

  afterEach(() => sinon.restore());

  // ── Placement checks ────────────────────────────────────────────

  describe('checkPlacement', () => {
    describe('static IP', () => {
      it('passes when app does not require static IP', async () => {
        const hw = buildHw();
        const spec = await v9Spec();
        expect(spec.placement.staticIp, 'the default placement asks for nothing').to.be.false;
        await hw.checkPlacement(spec);
      });

      it('passes when node has static IP and app requires it', async () => {
        const hw = buildHw({ isStaticIP: true });
        const spec = await v9Spec({ placement: { staticIp: true } });
        expect(spec.placement.staticIp).to.be.true;
        await hw.checkPlacement(spec);
      });

      it('throws when node lacks static IP and app requires it', async () => {
        const hw = buildHw({ isStaticIP: false });
        const spec = await v9Spec({ placement: { staticIp: true } });
        const err = await rejectsWith(hw.checkPlacement(spec), 'static IP');
        // The refusal names the app, and the name comes off the real spec —
        // a double with a stand-in name proves nothing about that sentence.
        expect(err.message).to.include(spec.name);
      });
    });

    describe('data center', () => {
      it('passes when app does not require data center', async () => {
        const hw = buildHw();
        const spec = await v9Spec();
        expect(spec.placement.dataCenter).to.be.false;
        await hw.checkPlacement(spec);
      });

      it('throws when node is not a data center and app requires it', async () => {
        const hw = buildHw({ isDataCenter: false });
        const spec = await v9Spec({ placement: { dataCenter: true } });
        await rejectsWith(hw.checkPlacement(spec), 'data center');
      });

      it('throws when datacenter is requested by a non-enterprise app owner', async () => {
        // Runtime authorization: datacenter placement is restricted to enterprise app owners,
        // checked before the node-eligibility check.
        const hw = buildHw({ isEnterpriseAppOwner: false });
        const spec = await v9Spec({ placement: { dataCenter: true } });
        await rejectsWith(hw.checkPlacement(spec), 'enterprise app owners');

        // enterpriseNetwork stays stubbed, so nothing here exercises what the
        // real allowlist does with what it is handed. It looks the OWNER up, so
        // assert the owner arrived: the hand-written spec double carried no
        // `owner` at all and this gate was being asked about `undefined`.
        const [handedOwner] = enterpriseNetworkStub.isEnterpriseAppOwner.firstCall.args;
        expect(handedOwner, 'the allowlist is asked about the real owner address').to.equal(spec.owner);
        expect(handedOwner).to.be.a('string').and.have.length.above(0);
      });

      it('applies to a legacy v8 spec through the same version-agnostic getter', async () => {
        // v8 carries `datacenter` as its own top-level field; the placement
        // getter is what makes the runtime check version-agnostic, so the v8
        // route has to be walked rather than assumed.
        const hw = buildHw({ isDataCenter: false });
        const spec = await v8Spec({ datacenter: true });
        expect(spec.version).to.equal(8);
        expect(spec.placement.dataCenter, 'the v8 field reaches the v9-shaped getter').to.be.true;
        await rejectsWith(hw.checkPlacement(spec), 'data center');
      });
    });

    describe('geolocation', () => {
      it('passes when no geo restrictions', async () => {
        const hw = buildHw();
        const spec = await v9Spec();
        expect(spec.placement.hasGeoRestrictions()).to.be.false;
        await hw.checkPlacement(spec);
      });

      it('throws when node geolocation is not set', async () => {
        const hw = buildHw({ nodeLocation: null });
        const spec = await v9Spec({ placement: { geoAllow: [{ continent: 'EU' }] } });
        expect(spec.placement.hasGeoRestrictions(), 'an unrestricted app never reaches this check').to.be.true;
        await rejectsWith(hw.checkPlacement(spec), 'Geolocation not set');
      });

      it('throws when node is in denied geo', async () => {
        // The node reports EU/CZ, so a real geoDeny on EU is a real hit.
        const hw = buildHw();
        const spec = await v9Spec({ placement: { geoDeny: [{ continent: 'EU' }] } });
        await rejectsWith(hw.checkPlacement(spec), 'forbidden');
      });

      it('throws when node is not in allowed geo', async () => {
        const hw = buildHw();
        const spec = await v9Spec({ placement: { geoAllow: [{ continent: 'NA' }] } });
        expect(spec.placement.isDeniedIn({ continent: 'EU', country: 'CZ' }), 'nothing is denied').to.be.false;
        await rejectsWith(hw.checkPlacement(spec), 'not matching');
      });

      it('passes when node is in allowed geo and not denied', async () => {
        const hw = buildHw();
        const spec = await v9Spec({
          placement: {
            geoAllow: [{ continent: 'EU', country: 'CZ' }],
            geoDeny: [{ continent: 'NA' }],
          },
        });
        expect(spec.placement.hasGeoDeny(), 'both lists are live, not just the allow').to.be.true;
        await hw.checkPlacement(spec);
      });

      it('enforces a legacy v8 geolocation DSL through the real conversion', async () => {
        // v8 stores geo as DSL strings; the library converts them to geoAllow /
        // geoDeny entries. A hand-written placement skips the conversion
        // entirely, so a DSL string that converts to nothing would still have
        // read as a restriction.
        const hw = buildHw();
        const spec = await v8Spec({ geolocation: ['a!cEU'] });
        expect(spec.placement.geoDeny, 'the DSL really converted to a deny entry')
          .to.deep.equal([{ continent: 'EU' }]);
        await rejectsWith(hw.checkPlacement(spec), 'forbidden');
      });
    });

    describe('targets', () => {
      it('passes when no targets set', async () => {
        const hw = buildHw();
        const spec = await v9Spec();
        expect(spec.placement.hasTargets()).to.be.false;
        await hw.checkPlacement(spec);
      });

      it('passes for v8 even with targets (v8 does not enforce)', async () => {
        const hw = buildHw();
        const spec = await v8Spec({ nodes: [OTHER_IP] });
        // The whole point of this case, and the thing the double could not
        // express: the legacy pin list IS a real target set that this node
        // genuinely misses. Only production's v8 exemption lets it through.
        expect(spec.placement.hasTargets(), 'a v8 nodes array is a real target set').to.be.true;
        expect(
          spec.placement.matchesTarget({ ip: MY_ADDR, outpoint: MY_OUTPOINT, operator: MY_OPERATOR }),
          'and this node is not in it',
        ).to.be.false;
        await hw.checkPlacement(spec);
      });

      it('throws for v7 when node does not match targets', async () => {
        const hw = buildHw();
        const spec = await v7Spec({ nodes: [OTHER_IP] });
        expect(spec.version).to.equal(7);
        await rejectsWith(hw.checkPlacement(spec), 'not allowed to run');
      });

      it('passes for v7 when node matches targets', async () => {
        // The legacy list names the bare IP; this node's local socket carries a
        // port. Production passes socketAddressesMatch as the ipMatcher and it
        // is the real one here, so the normalization is exercised rather than
        // asserted away by a `(a, b) => a === b` stub.
        const hw = buildHw();
        const spec = await v7Spec({ nodes: [MY_IP] });
        expect(spec.placement.hasTargets(), 'not a vacuous pass').to.be.true;
        expect(spec.placement.targetIps).to.deep.equal([MY_IP]);
        await hw.checkPlacement(spec);
      });

      it('throws for v9 when node does not match targets', async () => {
        const hw = buildHw();
        const spec = await v9PinnedSpec({ targetIps: { [`${OTHER_IP}:16127`]: ['r1'] } });
        expect(spec.placement.mode(), 'a real pinned placement, from a real assignment').to.equal('pinned');
        await rejectsWith(hw.checkPlacement(spec), 'not allowed to run');
      });

      it('passes for v9 when the assignment pins this node by IP', async () => {
        const hw = buildHw();
        const spec = await v9PinnedSpec({ targetIps: { [MY_ADDR]: ['r1'] } });
        expect(spec.placement.mode()).to.equal('pinned');
        expect(spec.placement.hasTargets(), 'not a vacuous pass').to.be.true;
        await hw.checkPlacement(spec);
      });

      it('passes for v9 when the assignment pins this node by collateral outpoint', async () => {
        // The outpoint branch of matchesTarget. It could not be reached at all
        // while the harness reported `abc123` as this node's collateral hash —
        // no schema-valid spec can name that.
        const hw = buildHw();
        const spec = await v9PinnedSpec({ targetOutpoints: { [MY_OUTPOINT]: ['r1'] } });
        expect(spec.placement.targetOutpoints).to.deep.equal([MY_OUTPOINT]);
        expect(spec.placement.targetIps, 'nothing else can be carrying the match').to.be.empty;
        await hw.checkPlacement(spec);
      });

      it('passes for v9 when the placement names this node operator key', async () => {
        // Operator targeting is candidate-only — an operator key backs
        // arbitrarily many nodes, so it cannot pin named replicas.
        const hw = buildHw();
        const spec = await v9Spec({ placement: { targetOperators: [MY_OPERATOR] } });
        expect(spec.placement.mode()).to.equal('candidate');
        expect(spec.placement.targetIps).to.be.empty;
        expect(spec.placement.targetOutpoints).to.be.empty;
        await hw.checkPlacement(spec);
      });

      it('throws when this node cannot detect its own IP', async () => {
        // Targeting is decided against three identities and the address is one
        // of them; a node that does not know its own must refuse rather than
        // match on whatever the other two happen to say.
        const hw = buildHw({ localSocketAddr: null });
        const spec = await v9PinnedSpec({ targetOutpoints: { [MY_OUTPOINT]: ['r1'] } });
        await rejectsWith(hw.checkPlacement(spec), 'Unable to detect Flux IP address');
      });
    });

    describe('the InstantiatedSpec vantage', () => {
      it('reads placement off a stored spec plus its chain state', async () => {
        // checkPlacement is documented to accept either an InstantiatedSpec or a
        // bare spec class instance, and the spawner hands it the former. The
        // delegation is real (name/version/owner/placement all forward to the
        // inner spec), so walk it rather than assuming.
        const hw = buildHw();
        const stored = await instantiatedSpec(await v9PinnedSpec({ targetIps: { [`${OTHER_IP}:16127`]: ['r1'] } }));
        expect(stored.version).to.equal(9);
        expect(stored.placement.hasTargets()).to.be.true;
        await rejectsWith(hw.checkPlacement(stored), 'not allowed to run');
      });
    });
  });

  // ── Resource checks ─────────────────────────────────────────────

  describe('checkNodeResources', () => {
    it('passes when node has enough resources', async () => {
      const hw = buildHw({ ssd: 500, cpucores: 16, ram: 32000 });
      const deployment = await deploymentOfSize({ cpu: 1, memory: 500, storageGb: 10 });
      expect(deployment.resourceTotals(), 'the real library sized the app we asked for')
        .to.include({ cpu: 1, memoryMb: 500, hostDiskGb: 12 });
      await hw.checkNodeResources(deployment);
    });

    it('throws when node has zero SSD', async () => {
      const hw = buildHw({ ssd: 0 });
      const deployment = await deploymentOfSize({ storageGb: 10 });
      await rejectsWith(hw.checkNodeResources(deployment), 'Insufficient space');
    });

    it('throws when insufficient disk space', async () => {
      // availableSpace = 20 * 0.95 - 10 = 9 GB; the app needs 30 + 2 rootFs.
      // CPU and RAM are left ample so the disk rule is the one that fires.
      const hw = buildHw({ ssd: 20, appsHddLocked: 10 });
      const deployment = await deploymentOfSize({ cpu: 0.5, memory: 300, storageGb: 30 });
      expect(deployment.resourceTotals().hostDiskGb, 'storage plus root fs, derived by the library').to.equal(32);
      await rejectsWith(hw.checkNodeResources(deployment), 'Insufficient space');
    });

    it('throws when insufficient CPU', async () => {
      // availableCpu = 4 * 10 - 10 locked - 3 * 10 in use = 0 tenths.
      const hw = buildHw({ cpucores: 4, appsCpusLocked: 3 });
      const deployment = await deploymentOfSize({ cpu: 2, memory: 300, storageGb: 5 });
      await rejectsWith(hw.checkNodeResources(deployment), 'Insufficient CPU');
    });

    it('throws when insufficient RAM', async () => {
      // availableRam = 4000 - 3000 = 1000 MB; the app asks for 2000.
      const hw = buildHw({ ram: 4000, appsRamLocked: 3000 });
      const deployment = await deploymentOfSize({ cpu: 0.5, memory: 2000, storageGb: 5 });
      await rejectsWith(hw.checkNodeResources(deployment), 'Insufficient RAM');
    });

    it('throws when appsResources cannot be read', async () => {
      const hw = buildHw({ resourcesStatus: 'error' });
      const deployment = await deploymentOfSize();
      await rejectsWith(hw.checkNodeResources(deployment), 'locked system resources');
    });

    it('screens each dimension on its own rule', async () => {
      // Three apps, each oversized on exactly ONE axis against the same node.
      // Without this the RAM and CPU cases could both be tripping the disk rule
      // — it is checked first — and two thirds of capacityShortfall would be
      // unexercised while every test still went green.
      const cases = [
        [{ cpu: 0.5, memory: 300, storageGb: 30 }, 'Insufficient space'],
        [{ cpu: 8, memory: 300, storageGb: 1 }, 'Insufficient CPU'],
        [{ cpu: 0.5, memory: 4000, storageGb: 1 }, 'Insufficient RAM'],
      ];
      const deployments = await Promise.all(cases.map(([size]) => deploymentOfSize(size)));
      // ssd 20 -> availableSpace 19; cpucores 5 -> availableCpu 40 tenths;
      // ram 2000 -> availableRam 2000.
      const hw = buildHw({ ssd: 20, cpucores: 5, ram: 2000 });
      const reasons = [];
      for (const deployment of deployments) {
        reasons.push(hw.capacityShortfall(await hw.nodeCapacity(), deployment.resourceTotals()));
      }
      expect(reasons.map((reason, i) => reason && reason.includes(cases[i][1])))
        .to.deep.equal([true, true, true]);
      expect(new Set(reasons).size, 'three distinct rules, not one rule three times').to.equal(3);
    });
  });

  describe('checkCpuBurstHeadroom', () => {
    it('passes when remaining free cores > 4', async () => {
      // 16 cores - 1 (system) - 3 (locked) - 2 (this app) = 10 > 4
      const hw = buildHw({ cpucores: 16, appsCpusLocked: 3, lockedCpu: 10 });
      const deployment = await deploymentOfSize({ cpu: 2 });
      await hw.checkCpuBurstHeadroom(deployment);
    });

    it('throws when remaining free cores exactly 4 (boundary)', async () => {
      // 10 cores - 1 - 3 - 2 = 4 → throw
      const hw = buildHw({ cpucores: 10, appsCpusLocked: 3, lockedCpu: 10 });
      const deployment = await deploymentOfSize({ cpu: 2 });
      await rejectsWith(hw.checkCpuBurstHeadroom(deployment), 'CPU burst headroom');
    });

    it('passes at 5 free cores (just above boundary)', async () => {
      // 10 cores - 1 - 3 - 1 = 5 > 4
      const hw = buildHw({ cpucores: 10, appsCpusLocked: 3, lockedCpu: 10 });
      const deployment = await deploymentOfSize({ cpu: 1 });
      await hw.checkCpuBurstHeadroom(deployment);
    });

    it('throws when over-subscribed (negative free cores)', async () => {
      // 8 cores - 1 - 5 - 4 = -2
      const hw = buildHw({ cpucores: 8, appsCpusLocked: 5, lockedCpu: 10 });
      const deployment = await deploymentOfSize({ cpu: 4 });
      await rejectsWith(hw.checkCpuBurstHeadroom(deployment), 'CPU burst headroom');
    });

    it('throws when appsResources cannot be read', async () => {
      const hw = buildHw({ resourcesStatus: 'error' });
      const deployment = await deploymentOfSize();
      await rejectsWith(hw.checkCpuBurstHeadroom(deployment), 'locked system resources');
    });
  });

  // ── Exports ─────────────────────────────────────────────────────

  // Some of what a node has committed is free, interruptible work. Asking for a
  // reading without it answers a different question from "does this fit": it
  // answers "is a playground session the only reason it does not".
  describe('reclaimable capacity', () => {
    const admissionControl = require('../../ZelBack/src/services/utils/admissionControl');

    afterEach(() => {
      admissionControl.clear();
      admissionControl.setReclaimer(null);
    });

    it('reads the same both ways when nothing reclaimable is held', async () => {
      const hw = buildHw();
      admissionControl.reserve('paidapp', await deploymentOfSize({ cpu: 2, memory: 4000, storageGb: 49, rootFsGb: 1 }));

      const held = await hw.nodeCapacity();
      const ignoring = await hw.nodeCapacity({ ignoreReclaimable: true });
      expect(ignoring).to.deep.equal(held);
    });

    // The invariant, stated as a difference so it holds whatever the node's own
    // numbers are: ignoring reclaimable work frees exactly what that work holds.
    it('frees exactly the reclaimable share, on every dimension', async () => {
      const hw = buildHw();
      const session = await deploymentOfSize({ cpu: 2, memory: 4000, storageGb: 49, rootFsGb: 1 });
      // The size is the library's, not the fixture's claim about it: hostDiskGb
      // is derived from storage + rootFs + swap, so a reservation cannot hold a
      // footprint its own parts do not add up to.
      expect(session.resourceTotals()).to.include({ cpu: 2, memoryMb: 4000, hostDiskGb: 50 });
      expect(session.reservableHostDiskGb()).to.equal(50);
      admissionControl.reserve('op_s1', session, { reclaimable: true });

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

    // The smallest app the schema admits on every axis but CPU, so the node's
    // core count is unambiguously the only thing under test: memory 100 MB is
    // the minimum and rootFsGb must be > 0, which is why no fixture here can
    // ask for a genuinely weightless app.
    const cpuOnly = (cpu) => deploymentOfSize({
      cpu, memory: 100, storageGb: 0, rootFsGb: 1,
    });

    afterEach(() => {
      admissionControl.clear();
      admissionControl.setReclaimer(null);
    });

    it('passes where the plain check would throw, and asks for the capacity back', async () => {
      // 2 cores free, all of it held by a session.
      const hw = buildHw({ cpucores: 3, appsCpusLocked: 2, lockedCpu: 10 });
      const session = await cpuOnly(2);
      admissionControl.reserve('op_s1', session, { reclaimable: true });
      const asked = [];
      admissionControl.setReclaimer(async (totals) => { asked.push(totals); });

      const paidApp = await cpuOnly(2);
      let threw = null;
      await hw.checkNodeResources(paidApp).catch((e) => { threw = e; });
      expect(threw, 'the plain check refuses a paid app mid-redeploy').to.be.an('error');

      expect(await hw.checkNodeResourcesReclaiming(paidApp)).to.equal(true);
      expect(asked.length, 'and the session is actually asked to yield').to.equal(1);

      // The reclaimer stays stubbed here, so nothing exercises what the real one
      // does with what it receives. playgroundService.reclaimFor compares
      // needed.cpu / needed.memoryMb / needed.hostDiskGb against each session's
      // own totals and stops once it has freed enough — an undefined term there
      // never satisfies its comparison and the eviction loop runs the whole
      // registry. So assert all three arrived, from the real spec.
      expect(asked[0]).to.include({ cpu: 2, memoryMb: 100, hostDiskGb: 1 });
    });

    it('asks for nothing when the app fits without reclaiming', async () => {
      const hw = buildHw({ cpucores: 8, appsCpusLocked: 0, lockedCpu: 10 });
      const asked = [];
      admissionControl.setReclaimer(async (totals) => { asked.push(totals); });

      expect(await hw.checkNodeResourcesReclaiming(await cpuOnly(1))).to.equal(true);
      expect(asked.length).to.equal(0);
    });

    it('still throws when the node is genuinely too small', async () => {
      const hw = buildHw({ cpucores: 2, appsCpusLocked: 0, lockedCpu: 10 });
      let threw = null;
      await hw.checkNodeResourcesReclaiming(await cpuOnly(8)).catch((e) => { threw = e; });
      expect(threw).to.be.an('error');
    });
  });

  // The fixtures above are the sizes and identities they are because the real
  // library refuses the ones this file used to carry. Asserted rather than
  // commented, so a fixture cannot quietly drift back.
  describe('fictions the real library refuses', () => {
    it('refuses a component above the v9 per-component caps', async () => {
      // The old doubles screened 100-core and 64000 MB apps. No such app can be
      // registered, so every assertion about how a node treats one was about a
      // deployment that cannot exist.
      let threw = null;
      await v9Spec({ components: sizedComponents({ cpu: 100 }) }).catch((e) => { threw = e; });
      expect(threw, 'a 100-core component').to.be.an('error');
      expect(threw.message).to.include('components.web.cpu');

      threw = null;
      await v9Spec({ components: sizedComponents({ memory: 64000 }) }).catch((e) => { threw = e; });
      expect(threw, 'a 64000 MB component').to.be.an('error');
      expect(threw.message).to.include('components.web.memory');
    });

    it('refuses a collateral outpoint that is not txid:vout', async () => {
      // The harness used to report this node's collateral as { txhash: 'abc123',
      // txindex: 0 }. checkTargets builds `${txhash}:${txindex}` from it and
      // hands it to matchesTarget, so the outpoint the node offered could never
      // have appeared in any spec's targets.
      let threw = null;
      await v9PinnedSpec({ targetOutpoints: { 'abc123:0': ['r1'] } }).catch((e) => { threw = e; });
      expect(threw).to.be.an('error');
      expect(threw.message).to.include('assignment.targetOutpoints');
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
      expect(hw.nodeCapacity).to.be.a('function');
      expect(hw.capacityShortfall).to.be.a('function');
      expect(hw.burstHeadroomShortfall).to.be.a('function');
    });
  });
});
