'use strict';

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
      return { Labels: { 'io.runonflux.app': 'myapp', ...(replica ? { 'io.runonflux.replica': replica } : {}) } };
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

  // A container identifier is built from the app's stored IDENTITY, not its name.
  // Both build paths must read the same one: an app whose set is built without it
  // is named differently from the single-identity path that created its
  // containers, so every lookup keyed on the result misses.
  describe('identity reaches both build paths', () => {
    let provider;

    async function specFixture() {
      const { FluxAppSpecV9 } = await import('@runonflux/flux-spec');
      return FluxAppSpecV9.fromSubmission({
        version: 9,
        name: 'myapp',
        description: 'fixture',
        owner: '16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1',
        instances: 3,
        ttl: 2_592_000,
        contacts: { email: ['test@example.com'] },
        components: {
          web: {
            name: 'web',
            image: 'nginx:latest',
            cpu: 1,
            memory: 1000,
            swapGb: 2,
            rootFsGb: 2,
            persistentStorage: { sizeGb: 10, mounts: { '/data': { source: 'data', destination: '/data' } } },
            ports: { tcp_80: { containerPort: 80, hostPort: 31000, protocol: 'tcp' } },
          },
        },
      });
    }

    beforeEach(async () => {
      const resolved = await specFixture();
      // resolveInstantiatedSpec is destructured at module load, so it is replaced
      // here rather than stubbed on the module object
      // eslint-disable-next-line global-require
      const proxyquire = require('proxyquire').noCallThru();
      provider = proxyquire('../../ZelBack/src/services/appRuntime/deploymentProvider', {
        '../utils/specCutover': { resolveInstantiatedSpec: async () => resolved },
      });
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('44.55.66.77:16127');
      sinon.stub(generalService, 'obtainNodeCollateralInformation').resolves({
        txhash: OUTPOINT_TXID, txindex: 0,
      });
    });

    afterEach(() => {
      sinon.restore();
    });

    it('builds identifiers from the stored identity, not the app name', async () => {
      const deployments = await provider.buildDeployments({ name: 'myapp', identity: 'a1b2c3d4e5f6' });

      const ids = deployments.flatMap((d) => d.componentEntries().map(([, c]) => c.identifier));
      expect(ids).to.deep.equal(['web_a1b2c3d4e5f6']);
    });

    it('falls back to the name for an app installed before identities were stored', async () => {
      const deployments = await provider.buildDeployments({ name: 'myapp', identity: null });

      const ids = deployments.flatMap((d) => d.componentEntries().map(([, c]) => c.identifier));
      expect(ids).to.deep.equal(['web_myapp']);
    });

    it('an opts identity overrides the spec view - the update path builds the NEW view at the INSTALLED identity', async () => {
      // A registry spec carries no identity (identities are minted at install),
      // so the update diff's new side must be handed the installed row's.
      const deployments = await provider.buildDeployments({ name: 'myapp' }, { identity: 'a1b2c3d4e5f6' });
      const ids = deployments.flatMap((d) => d.componentEntries().map(([, c]) => c.identifier));
      expect(ids).to.deep.equal(['web_a1b2c3d4e5f6']);

      const single = await provider.buildDeployment({ name: 'myapp' }, { replica: null, identity: 'a1b2c3d4e5f6' });
      expect(single.componentEntries().map(([, c]) => c.identifier)).to.deep.equal(['web_a1b2c3d4e5f6']);
    });

    it('agrees with the single-identity path', async () => {
      const [fromSet] = await provider.buildDeployments({ name: 'myapp', identity: 'a1b2c3d4e5f6' });
      const single = await provider.buildDeployment({ name: 'myapp', identity: 'a1b2c3d4e5f6' }, { replica: null });

      expect(fromSet.componentEntries().map(([, c]) => c.identifier))
        .to.deep.equal(single.componentEntries().map(([, c]) => c.identifier));
    });
  });
});
