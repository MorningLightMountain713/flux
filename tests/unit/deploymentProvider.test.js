// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');
const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
const generalService = require('../../ZelBack/src/services/generalService');
const deploymentProvider = require('../../ZelBack/src/services/appRuntime/deploymentProvider');

chai.use(chaiAsPromised);
const { expect } = chai;

const OUTPOINT_TXID = 'a'.repeat(64);

// A spec whose placement is a REAL Placement instance, so the resolution runs
// the actual mode/matching machinery rather than a hand-mocked shadow of it.
async function specWithPlacement(placementBlob) {
  const { Placement } = await import('@runonflux/flux-spec');
  return { name: 'myapp', placement: Placement.from(placementBlob) };
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
