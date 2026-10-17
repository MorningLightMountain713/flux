'use strict';

// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');
const { stubHostedInstances, stubInstanceResources, stubRegistry } = require('./fixtures/appRecords');
const appDomain = require('./fixtures/appDomain');
const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
const generalService = require('../../ZelBack/src/services/generalService');
const dockerService = require('../../ZelBack/src/services/dockerService');
const deploymentProvider = require('../../ZelBack/src/services/appRuntime/deploymentProvider');
const proxyquire = require('proxyquire').noCallThru();
const specLibs = require('../../ZelBack/src/services/utils/specLibs');

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
  const { Placement, Assignment } = await specLibs.getSpec();
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

  describe('listInstalledDeployments', () => {
    it('builds from the specs it is handed, without listing them again', async () => {
      // The resource check lists the installed apps to find the rows it cannot
      // read, then needs their deployments. Given the specs it already has, this
      // must not read and deserialize the same collection a second time — it
      // runs on every admission decision and every spawn cycle. Nothing about
      // the ANSWER changes, so only the read itself can be asserted.
      const listed = stubHostedInstances().apps;

      const deployments = await deploymentProvider.listInstalledDeployments([]);

      expect(deployments).to.deep.equal([]);
      sinon.assert.notCalled(listed);

      // The companion: with nothing handed over it still reads, so this is a
      // shortcut rather than a listing that stopped working.
      await deploymentProvider.listInstalledDeployments();
      sinon.assert.calledOnce(listed);
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

    // localIdentities takes an RegisteredSpec, not a bare spec: a cleartext
    // one resolves to its own `spec`.
    async function registeredWith(placementBlob) {
      return { name: 'myapp', isEncrypted: false, spec: await specWithPlacement(placementBlob) };
    }

    it('loose placement owes the unqualified identity', async () => {
      const spec = await registeredWith({ targetIps: { '44.55.66.77': null } });
      dockerStub.resolves([container(null)]);
      expect(await deploymentProvider.localIdentities(spec)).to.deep.equal([null]);
    });

    it('loose placement also owes a qualified container left from a named phase', async () => {
      // Without this the teardown builds only the unqualified view, and the
      // replica's container, volume and appdata dir are orphaned.
      const spec = await registeredWith({ targetIps: { '44.55.66.77': null } });
      dockerStub.resolves([container('m1')]);
      expect(await deploymentProvider.localIdentities(spec)).to.have.members([null, 'm1']);
    });

    it('named placement owes its assigned replicas', async () => {
      const spec = await registeredWith({ targetIps: { '44.55.66.77': ['s1', 's2'] } });
      dockerStub.resolves([container('s1'), container('s2')]);
      expect(await deploymentProvider.localIdentities(spec)).to.have.members(['s1', 's2']);
    });

    it('named placement also owes an orphan sibling the maps no longer name', async () => {
      const spec = await registeredWith({ targetIps: { '44.55.66.77': ['s1'] } });
      dockerStub.resolves([container('s1'), container('s2')]);
      expect(await deploymentProvider.localIdentities(spec)).to.have.members(['s1', 's2']);
    });

    it('owes what is present when named placement no longer targets this node', async () => {
      const spec = await registeredWith({ targetIps: { '9.9.9.9': ['s1'] } });
      dockerStub.resolves([container('s1')]);
      expect(await deploymentProvider.localIdentities(spec)).to.deep.equal(['s1']);
    });

    it('falls back to the unqualified identity when neither the spec nor docker has anything to say', async () => {
      const spec = await registeredWith({ targetIps: { '9.9.9.9': ['s1'] } });
      expect(await deploymentProvider.localIdentities(spec)).to.deep.equal([null]);
    });
  });

  // A container identifier is built from the app's stored IDENTITY and each
  // component's KEY, not from names. Both build paths must read the same ones:
  // an app whose set is built without them is named differently from the
  // single-identity path that created its containers, so every lookup keyed on
  // the result misses.
  describe('building from installed records', () => {
    let provider;
    let instanceResources;
    let resolved;
    // A minted key, deliberately unlike the component's name.
    const WEB_KEY = `c${'k'.repeat(52)}`;

    async function specFixture() {
      const { FluxAppSpecV9 } = await specLibs.getSpec();
      return FluxAppSpecV9.fromSubmission({
        version: 9,
        name: 'myapp',
        description: 'fixture',
        owner: '1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm',
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
            ports: { tcp_80: { containerPort: 80, hostPort: 31_000, protocol: 'tcp' } },
          },
        },
      });
    }

    const registered = (identity = 'a1b2c3d4e5f6') => appDomain.registeredSpec({ event: null, spec: resolved, identity });
    const install = async ({ identity, componentKeys = null, replica = null } = {}) => appDomain.hostedInstance({
      record: await registered(identity), componentKeys, replica,
    });
    const identifiers = (deployments) => deployments.flatMap((d) => d.componentEntries().map(([, c]) => c.identifier));

    beforeEach(async () => {
      resolved = await specFixture();
      // resolveRegisteredSpec is destructured at module load, so it is replaced
      // here rather than stubbed on the module object
      provider = proxyquire('../../ZelBack/src/services/appRuntime/deploymentProvider', {
        '../utils/specCutover': { resolveRegisteredSpec: async (record) => (record.name === 'sealed' ? null : resolved) },
      });
      // No resources until a test writes one: the registration names everything.
      instanceResources = stubInstanceResources();
      stubHostedInstances();
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('44.55.66.77:16127');
      sinon.stub(generalService, 'obtainNodeCollateralInformation').resolves({
        txhash: OUTPOINT_TXID, txindex: 0,
      });
    });

    afterEach(() => {
      sinon.restore();
    });

    describe('what each entry point takes', () => {
      it('builds only from a hosted instance: a registered record is refused', async () => {
        const record = await registered();
        await expect(provider.buildDeployment(record, { replica: null }))
          .to.eventually.be.rejectedWith(/^buildDeployment builds from a hosted instance/);
        await expect(provider.buildDeployments(record))
          .to.eventually.be.rejectedWith(/^buildDeployments builds from a hosted instance/);
        await expect(provider.installedDeployments(record))
          .to.eventually.be.rejectedWith(/^installedDeployments builds from a hosted instance/);
      });

      it('refuses an omitted replica - a caller that cannot name its identity must not receive an arbitrary one', async () => {
        await expect(provider.buildDeployment(await install()))
          .to.eventually.be.rejectedWith(/^buildDeployment for myapp requires an explicit replica/);
      });

      it('plans a version not installed as it is only with its component keys stated', async () => {
        const record = await registered();
        await expect(provider.planDeployment(record, { replica: null }))
          .to.eventually.be.rejectedWith(/^planDeployment for myapp requires an explicit replica and componentKeys/);
        await expect(provider.planDeployment(record, { componentKeys: null }))
          .to.eventually.be.rejectedWith(/^planDeployment for myapp requires an explicit replica and componentKeys/);
        await expect(provider.planDeployments(record, {}))
          .to.eventually.be.rejectedWith(/^planDeployments for myapp requires explicit componentKeys/);
        expect(identifiers([await provider.planDeployment(record, { replica: null, componentKeys: null })])).to.deep.equal(['web_a1b2c3d4e5f6']);
      });
    });

    it('names containers by the hosted instance\'s component keys', async () => {
      const keyed = await install({ componentKeys: new Map([['web', WEB_KEY]]) });

      expect(identifiers(await provider.buildDeployments(keyed))).to.deep.equal([`${WEB_KEY}_a1b2c3d4e5f6`]);
      expect(identifiers([await provider.buildDeployment(keyed, { replica: null })])).to.deep.equal([`${WEB_KEY}_a1b2c3d4e5f6`]);
    });

    it('plans a version with the keys stated', async () => {
      const planned = await provider.planDeployments(await registered(), { componentKeys: new Map([['web', WEB_KEY]]) });
      expect(identifiers(planned)).to.deep.equal([`${WEB_KEY}_a1b2c3d4e5f6`]);
    });

    it('builds identifiers from the stored identity, not the app name', async () => {
      expect(identifiers(await provider.buildDeployments(await install()))).to.deep.equal(['web_a1b2c3d4e5f6']);
    });

    it('falls back to the name for an app installed before identities were stored', async () => {
      expect(identifiers(await provider.buildDeployments(await install({ identity: null })))).to.deep.equal(['web_myapp']);
    });

    it('hands the view the version the caller states the app was registered with, which fixes its folder id and its kept alias', async () => {
      const [before] = await provider.buildDeployments(await install(), { registrationVersion: 8 });
      const web = before.getComponent('web');
      expect(web.syncFolderId).to.equal('fluxweb_myapp');
      expect(web.networkAliases).to.include('fluxweb_myapp');
      const [unstated] = await provider.buildDeployments(await install());
      expect(() => unstated.getComponent('web').syncFolderId).to.throw(/registration version/);
    });

    it('an opts identity overrides the record\'s - an update is planned at the INSTALLED identity', async () => {
      // A registry record carries the identity the network minted, and an app
      // keeps the one it was installed with, so the update's view is handed it.
      const listed = await registered('ffffffffffff');
      const planned = await provider.planDeployments(listed, { identity: 'a1b2c3d4e5f6', componentKeys: null });
      expect(identifiers(planned)).to.deep.equal(['web_a1b2c3d4e5f6']);

      const single = await provider.planDeployment(listed, { replica: null, identity: 'a1b2c3d4e5f6', componentKeys: null });
      expect(identifiers([single])).to.deep.equal(['web_a1b2c3d4e5f6']);
    });

    it('agrees with the single-identity path', async () => {
      const keyed = await install({ componentKeys: new Map([['web', WEB_KEY]]) });
      const [fromSet] = await provider.buildDeployments(keyed);
      const single = await provider.buildDeployment(keyed, { replica: null });

      expect(identifiers([fromSet])).to.deep.equal(identifiers([single]));
    });

    it('lists an installed app it cannot read by its identity, or its name where it has none', async () => {
      const { RegisteredSpec } = await specLibs.getSpecBackend();
      const sealed = (identity) => appDomain.hostedInstance({
        record: new RegisteredSpec({
          spec: { name: 'sealed' }, hash: 'h', height: 1, identity,
        }),
      });
      const { deployments, unreadableApps } = await provider.listInstalledDeploymentsDetailed([await sealed('bident'), await sealed(null)]);

      expect(deployments).to.deep.equal([]);
      expect([...unreadableApps]).to.deep.equal([['bident', 'sealed'], ['sealed', 'sealed']]);
    });

    describe('the containers a request names', () => {
      it('are this node\'s, addressed through its hosted instance whatever version the registry lists', async () => {
        stubHostedInstances().byName.resolves(await install({ componentKeys: new Map([['web', WEB_KEY]]) }));
        stubRegistry().byName.resolves(await registered('ffffffffffff'));

        expect((await provider.resolveRequestTargets('myapp')).ids).to.deep.equal([`${WEB_KEY}_a1b2c3d4e5f6`]);
        expect((await provider.resolveRequestTargets('web_myapp')).ids).to.deep.equal([`${WEB_KEY}_a1b2c3d4e5f6`]);
      });

      it('are none for an app the registry lists and this node has not installed', async () => {
        stubRegistry().byName.resolves(await registered());

        await expect(provider.resolveRequestTargets('myapp')).to.eventually.be.rejectedWith(/^Application not found$/);
      });
    });

    // The names recorded for a component the node has started on are the
    // deployment's; the registration names only what the node has not.
    describe('the names a deployment of an installed instance carries', () => {
      let InstanceResources;
      const RECORDED = { id: 'fluxweb_myapp', aliases: ['web', 'web.myapp', 'fluxweb_myapp'] };
      const resourcesWith = (replica, blockKey) => new InstanceResources({
        name: 'myapp',
        replica,
        components: blockKey ? {
          [blockKey]: InstanceResources.newBlock({
            identifier: 'web_a1b2c3d4e5f6', image: 'nginx:latest', syncFolder: { id: RECORDED.id, path: '/x' }, aliases: RECORDED.aliases,
          }),
        } : {},
      });

      beforeEach(async () => {
        ({ InstanceResources } = await specLibs.getSpecBackend());
      });

      it('names a component the resources hold as recorded, whatever the registration says', async () => {
        instanceResources.byInstance.resolves(resourcesWith(null, 'web'));
        const row = await install();

        const [fromSet] = await provider.buildDeployments(row, { registrationVersion: 9 });
        const single = await provider.buildDeployment(row, { replica: null, registrationVersion: 9 });

        for (const web of [fromSet.getComponent('web'), single.getComponent('web')]) {
          expect(web.syncFolderId).to.equal('fluxweb_myapp');
          expect(web.networkAliases).to.deep.equal(RECORDED.aliases);
        }
        sinon.assert.alwaysCalledWithExactly(instanceResources.byInstance, 'myapp', null);
      });

      it('finds a component\'s recorded names by its key, never by its name', async () => {
        const keyed = await install({ componentKeys: new Map([['web', WEB_KEY]]) });

        instanceResources.byInstance.resolves(resourcesWith(null, WEB_KEY));
        const byKey = (await provider.buildDeployment(keyed, { replica: null, registrationVersion: 9 })).getComponent('web');
        expect(byKey.syncFolderId).to.equal('fluxweb_myapp');
        expect(byKey.networkAliases).to.deep.equal(RECORDED.aliases);

        instanceResources.byInstance.resolves(resourcesWith(null, 'web'));
        const byName = (await provider.buildDeployment(keyed, { replica: null, registrationVersion: 9 })).getComponent('web');
        expect(byName.syncFolderId).to.equal(`${WEB_KEY}_a1b2c3d4e5f6`);
      });

      it('plans the names the spec derives when asked to ignore the recorded ones', async () => {
        instanceResources.byInstance.resolves(resourcesWith(null, 'web'));
        const derived = (await provider.planDeployment(await registered(), {
          replica: null, registrationVersion: 9, componentKeys: null, recordedNames: false,
        })).getComponent('web');
        expect(derived.syncFolderId).to.equal('web_a1b2c3d4e5f6');
        expect(derived.networkAliases).to.not.include('fluxweb_myapp');
      });

      it('names a component the resources hold no block for, and an instance with no resources, by the registration', async () => {
        instanceResources.byInstance.resolves(resourcesWith(null, null));
        const noBlock = (await provider.buildDeployment(await install(), { replica: null, registrationVersion: 8 })).getComponent('web');
        expect(noBlock.syncFolderId).to.equal('fluxweb_myapp');
        expect(noBlock.networkAliases).to.include('fluxweb_myapp');

        instanceResources.byInstance.resolves(null);
        const [noResources] = await provider.buildDeployments(await install(), { registrationVersion: 9 });
        expect(noResources.getComponent('web').syncFolderId).to.equal('web_a1b2c3d4e5f6');
      });

      it('holds no folder id for a component the resources do not hold when a reader states no version', async () => {
        instanceResources.byInstance.resolves(resourcesWith(null, null));
        const unstarted = (await provider.buildDeployment(await install(), { replica: null })).getComponent('web');
        expect(unstarted.syncFolderId).to.equal(null);
      });

      it('reads the resources of the instance being built, by its replica', async () => {
        await provider.buildDeployment(await install({ replica: 's1' }), { replica: 's1' });
        sinon.assert.calledWith(instanceResources.byInstance, 'myapp', 's1');
      });
    });
  });
});
