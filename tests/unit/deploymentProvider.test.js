// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');
const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
const generalService = require('../../ZelBack/src/services/generalService');
const dockerService = require('../../ZelBack/src/services/dockerService');
const deploymentProvider = require('../../ZelBack/src/services/appRuntime/deploymentProvider');

chai.use(chaiAsPromised);
const { expect } = chai;

const OUTPOINT_TXID = 'a'.repeat(64);

// A spec whose placement and assignment are REAL flux-spec instances, so the
// resolution runs the actual mode/matching machinery rather than a hand-mocked
// shadow of it. The terse shorthand mirrors the old targeting map: an entry
// { identity: null } is a candidate (loose) target; { identity: [names] } pins
// those named replicas. resolveLocalReplicas reads placement.mode() (cleartext)
// then assignment.replicasFor() (the sealed replica names).
async function specWithPlacement(targets) {
  const { Placement, Assignment } = await import('@runonflux/flux-spec');
  const placementBlob = { targetIps: [], targetOutpoints: [], targetOperators: [] };
  const assignmentBlob = { targetIps: {}, targetOutpoints: {} };
  let pinned = false;
  let candidate = false;
  for (const field of ['targetIps', 'targetOutpoints', 'targetOperators']) {
    const map = targets && targets[field];
    if (!map) continue;
    for (const [identity, names] of Object.entries(map)) {
      placementBlob[field].push(identity);
      if (Array.isArray(names) && names.length > 0) {
        pinned = true;
        // Operators cannot pin (one key backs many nodes); names live under IP/outpoint only.
        if (field !== 'targetOperators') assignmentBlob[field][identity] = names;
      } else {
        candidate = true;
      }
    }
  }
  placementBlob.mode = pinned ? 'pinned' : (candidate ? 'candidate' : 'none');
  return {
    name: 'myapp',
    placement: Placement.from(placementBlob),
    assignment: Assignment.from(assignmentBlob),
  };
}

describe('deploymentProvider tests', () => {
  describe('resolveLocalReplicas', () => {
    let ipStub;
    let collateralStub;

    beforeEach(() => {
      ipStub = sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('44.55.66.77:16127');
      collateralStub = sinon.stub(generalService, 'obtainNodeCollateralInformation').resolves({
        txhash: OUTPOINT_TXID, txindex: 0,
      });
    });

    afterEach(() => {
      sinon.restore();
    });

    it('resolves null for untargeted placement without touching node identity', async () => {
      const spec = await specWithPlacement({});
      expect(await deploymentProvider.resolveLocalReplicas(spec)).to.equal(null);
      sinon.assert.notCalled(ipStub);
      sinon.assert.notCalled(collateralStub);
    });

    it('resolves null for loose (candidate) placement', async () => {
      const spec = await specWithPlacement({ targetIps: { '44.55.66.77': null } });
      expect(await deploymentProvider.resolveLocalReplicas(spec)).to.equal(null);
    });

    it('resolves the replica pinned to this node by IP (socket-address match)', async () => {
      const spec = await specWithPlacement({
        targetIps: { '44.55.66.77': ['s1'], '9.9.9.9': ['s2'] },
      });
      expect(await deploymentProvider.resolveLocalReplicas(spec)).to.deep.equal(['s1']);
    });

    it('resolves the replica pinned to this node by collateral outpoint', async () => {
      const spec = await specWithPlacement({
        targetOutpoints: { [`${OUTPOINT_TXID}:0`]: ['s3'] },
      });
      expect(await deploymentProvider.resolveLocalReplicas(spec)).to.deep.equal(['s3']);
    });

    it('unions both node-identity forms into the co-located set', async () => {
      const spec = await specWithPlacement({
        targetIps: { '44.55.66.77': ['s1'] },
        targetOutpoints: { [`${OUTPOINT_TXID}:0`]: ['s2'] },
      });
      expect(await deploymentProvider.resolveLocalReplicas(spec)).to.have.members(['s1', 's2']);
    });

    it('resolves the empty set when named placement does not target this node', async () => {
      const spec = await specWithPlacement({ targetIps: { '9.9.9.9': ['s1'] } });
      expect(await deploymentProvider.resolveLocalReplicas(spec)).to.deep.equal([]);
    });

    it('resolveLocalReplicas: null for loose, the assigned set for named', async () => {
      const loose = await specWithPlacement({ targetIps: { '44.55.66.77': null } });
      expect(await deploymentProvider.resolveLocalReplicas(loose)).to.equal(null);
      const named = await specWithPlacement({ targetIps: { '44.55.66.77': ['s1', 's2'] } });
      expect(await deploymentProvider.resolveLocalReplicas(named)).to.deep.equal(['s1', 's2']);
    });
  });

  describe('localIdentities (what a teardown owes)', () => {
    let dockerStub;

    beforeEach(() => {
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('44.55.66.77:16127');
      sinon.stub(generalService, 'obtainNodeCollateralInformation').resolves({
        txhash: OUTPOINT_TXID, txindex: 0,
      });
      dockerStub = sinon.stub(dockerService, 'getAppContainerObjects').resolves([]);
    });

    afterEach(() => {
      sinon.restore();
    });

    function container(replica) {
      return { Labels: { 'runonflux.app': 'myapp', ...(replica ? { 'runonflux.replica': replica } : {}) } };
    }

    // localIdentities takes an InstantiatedSpec, not a bare spec: a cleartext
    // one resolves to its own `spec`.
    async function instantiatedWith(placementBlob) {
      return { name: 'myapp', isEncrypted: false, spec: await specWithPlacement(placementBlob) };
    }

    it('loose placement owes the unqualified identity', async () => {
      const spec = await instantiatedWith({ targetIps: { '44.55.66.77': null } });
      dockerStub.resolves([container(null)]);
      expect(await deploymentProvider.localIdentities(spec)).to.deep.equal([null]);
    });

    it('loose placement also owes a qualified container left from a named phase', async () => {
      // Without this the teardown builds only the unqualified view, and the
      // replica's container, volume and appdata dir are orphaned.
      const spec = await instantiatedWith({ targetIps: { '44.55.66.77': null } });
      dockerStub.resolves([container('m1')]);
      expect(await deploymentProvider.localIdentities(spec)).to.have.members([null, 'm1']);
    });

    it('named placement owes its assigned replicas', async () => {
      const spec = await instantiatedWith({ targetIps: { '44.55.66.77': ['s1', 's2'] } });
      dockerStub.resolves([container('s1'), container('s2')]);
      expect(await deploymentProvider.localIdentities(spec)).to.have.members(['s1', 's2']);
    });

    it('named placement also owes an orphan sibling the maps no longer name', async () => {
      const spec = await instantiatedWith({ targetIps: { '44.55.66.77': ['s1'] } });
      dockerStub.resolves([container('s1'), container('s2')]);
      expect(await deploymentProvider.localIdentities(spec)).to.have.members(['s1', 's2']);
    });

    it('owes what is present when named placement no longer targets this node', async () => {
      const spec = await instantiatedWith({ targetIps: { '9.9.9.9': ['s1'] } });
      dockerStub.resolves([container('s1')]);
      expect(await deploymentProvider.localIdentities(spec)).to.deep.equal(['s1']);
    });

    it('falls back to the unqualified identity when neither the spec nor docker has anything to say', async () => {
      const spec = await instantiatedWith({ targetIps: { '9.9.9.9': ['s1'] } });
      expect(await deploymentProvider.localIdentities(spec)).to.deep.equal([null]);
    });
  });

  describe('buildDeployment identity contract', () => {
    afterEach(() => {
      sinon.restore();
    });

    it('refuses an omitted replica - a caller that cannot name its identity must not receive an arbitrary one', async () => {
      await expect(deploymentProvider.buildDeployment({ name: 'myapp' }))
        .to.eventually.be.rejectedWith(/requires an explicit replica/);
    });
  });
});
