'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

const { loadSpecLibrary, v8Spec, v9Spec, instantiatedSpec } = require('./fixtures/fluxSpec');
const { inMemoryInstalled } = require('./fixtures/appRecords');

const APPS_FOLDER = '/dat/var/lib/fluxos/flux-apps/';
const IDENTITY = 'a1b2c3d4e5f6';

describe('installedLedger', () => {
  let flux;
  let stubs;
  let installedLedger;

  before(async function loadLibrary() {
    this.timeout(30_000);
    flux = await loadSpecLibrary();
  });

  beforeEach(() => {
    stubs = {
      dockerService: {
        appDockerImageDigest: sinon.stub().resolves('sha256:deadbeef'),
        dockerContainerInspect: sinon.stub().resolves(null),
      },
      volumeService: { recordedVolumeImage: sinon.stub().resolves({ path: '/dat/appvolumes/x', fsUuid: 'uuid-1' }) },
      fluxNetworkHelper: { isFirewallActive: sinon.stub().resolves(true) },
      upnpService: { isUPNP: sinon.stub().returns(false) },
      deploymentProvider: { buildDeployment: sinon.stub() },
      moveStore: { begin: sinon.stub().resolves() },
      log: { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
    };
    installedLedger = proxyquire('../../ZelBack/src/services/appLifecycle/installedLedger', {
      '../dockerService': stubs.dockerService,
      '../utils/volumeService': stubs.volumeService,
      '../fluxNetworkHelper': stubs.fluxNetworkHelper,
      '../upnpService': stubs.upnpService,
      '../appRuntime/deploymentProvider': stubs.deploymentProvider,
      './appIdentityMoveStore': stubs.moveStore,
      '../utils/appConstants': { appsFolder: APPS_FOLDER },
      '../../lib/log': stubs.log,
    });
  });

  afterEach(() => sinon.restore());

  describe('observeLedger', () => {
    it('reads a real deployment\'s names, the recorded volume, the daemon\'s digest and the ports as the node opens them', async () => {
      const spec = await v9Spec({ name: 'ledgered' });
      const deployment = flux.DeploymentSpec.fromSpec(spec, APPS_FOLDER, { replica: null, identity: IDENTITY });
      stubs.volumeService.recordedVolumeImage.resolves({ path: `/dat/appvolumes/web_${IDENTITY}FLUXFSVOL`, fsUuid: 'uuid-1' });

      const ledger = await installedLedger.observeLedger(deployment);

      expect(ledger.network).to.deep.equal({ name: deployment.networkName });
      const { web } = ledger.components;
      expect(web.identifier).to.equal(`web_${IDENTITY}`);
      expect(web.image).to.deep.equal({ reference: 'nginx:latest', digest: 'sha256:deadbeef' });
      sinon.assert.calledOnceWithExactly(stubs.dockerService.appDockerImageDigest, 'nginx:latest');
      expect(web.hostPorts).to.deep.equal([{ port: 31_000, opened: ['ufw'] }]);
      expect(web.volume).to.deep.equal({
        file: `/dat/appvolumes/web_${IDENTITY}FLUXFSVOL`, disk: '/', fsUuid: 'uuid-1', mountDir: `${APPS_FOLDER}web_${IDENTITY}`,
      });
      sinon.assert.calledOnceWithExactly(stubs.volumeService.recordedVolumeImage, `web_${IDENTITY}`);
      expect(web.mountSources.map((m) => m.kind)).to.include('dir');
      expect(web.mountSources.every((m) => m.path.startsWith(`${APPS_FOLDER}web_${IDENTITY}`))).to.equal(true);
      expect(web.syncFolder).to.equal(null);
      expect(web.aliases).to.deep.equal(deployment.getComponent('web').networkAliases);
      expect(web.mesh).to.equal(null);
      expect(web.tls).to.equal(null);
      expect(Object.keys(web).sort()).to.deep.equal([...flux.COMPONENT_LEDGER_FIELDS].sort());
    });

    it('records each port as opened by UPnP too when the node maps ports, and nothing when the firewall is off', async () => {
      const deployment = flux.DeploymentSpec.fromSpec(await v9Spec({ name: 'ports' }), APPS_FOLDER, { replica: null, identity: IDENTITY });
      stubs.upnpService.isUPNP.returns(true);
      expect((await installedLedger.observeLedger(deployment)).components.web.hostPorts[0].opened).to.deep.equal(['ufw', 'upnp']);
      stubs.fluxNetworkHelper.isFirewallActive.resolves(false);
      expect((await installedLedger.observeLedger(deployment)).components.web.hostPorts[0].opened).to.deep.equal(['upnp']);
    });

    it('writes null for what the host does not hold: a volume never recorded, an image the daemon lacks, a stateless component', async () => {
      const deployment = flux.DeploymentSpec.fromSpec(await v9Spec({ name: 'bare' }), APPS_FOLDER, { replica: null, identity: IDENTITY });
      stubs.volumeService.recordedVolumeImage.resolves(null);
      stubs.dockerService.appDockerImageDigest.resolves(null);
      const { web } = (await installedLedger.observeLedger(deployment)).components;
      expect(web.volume).to.deep.equal({
        file: null, disk: null, fsUuid: null, mountDir: `${APPS_FOLDER}web_${IDENTITY}`,
      });
      expect(web.image.digest).to.equal(null);

      const stateless = {
        networkName: 'net',
        componentEntries: () => [['job', {
          identifier: 'job_x', image: 'busybox', hostPorts: [], isStateless: true, mounts: [], networkAliases: ['job'], hasSyncthing: () => false, requiresBackendTls: () => false,
        }]],
      };
      const { job } = (await installedLedger.observeLedger(stateless)).components;
      expect(job.volume).to.equal(null);
      sinon.assert.calledOnceWithExactly(stubs.volumeService.recordedVolumeImage, `web_${IDENTITY}`);
    });

    it('records the folder the deployment names, the mesh name the container runs as, the TLS mount, and a volume on another disk', async () => {
      stubs.dockerService.dockerContainerInspect.resolves({ Config: { Env: ['A=1', 'FLUX_MESH_SELF=db-0', 'B=2'] } });
      stubs.volumeService.recordedVolumeImage.resolves({ path: '/mnt/disk2/db_xFLUXFSVOL', fsUuid: 'uuid-2' });
      const deployment = {
        networkName: 'net',
        componentEntries: () => [['db', {
          identifier: 'db_x',
          image: 'postgres:16',
          hostPorts: [],
          isStateless: false,
          mounts: [{ Source: `${APPS_FOLDER}db_x/data`, sourceType: 'directory' }, { Source: `${APPS_FOLDER}db_x/conf.toml`, sourceType: 'file' }],
          networkAliases: ['db'],
          syncFolderId: 'db_x',
          hasSyncthing: () => true,
          requiresBackendTls: () => true,
        }]],
      };
      const { db } = (await installedLedger.observeLedger(deployment)).components;
      expect(db.syncFolder).to.deep.equal({ id: 'db_x', path: `${APPS_FOLDER}db_x` });
      expect(db.mesh).to.deep.equal({ name: 'db-0' });
      expect(db.tls).to.deep.equal({ dir: flux.hostTlsDir(`${APPS_FOLDER}db_x`) });
      expect(db.volume.disk).to.equal('/mnt/disk2');
      expect(db.mountSources).to.deep.equal([{ path: `${APPS_FOLDER}db_x/data`, kind: 'dir' }, { path: `${APPS_FOLDER}db_x/conf.toml`, kind: 'file' }]);
    });
  });

  describe('adoptInstalledLedgers', () => {
    const legacyRow = (spec, extra = {}) => ({
      ...(spec), hash: `h-${spec.name}`, height: 100, replica: null, componentIdentifiers: [`web_${spec.name}`], ...extra,
    });

    it('writes the ledger of every instance stored without one, names an identity-less one by its name, and moves its move record', async () => {
      const { installed, provider } = await inMemoryInstalled();
      const v8 = (await v8Spec({ name: 'legacy' })).serialize();
      const v9 = (await v9Spec({ name: 'moving' })).serialize();
      await provider.insert(installed.constructor.STORE, [
        legacyRow(v8),
        legacyRow({ ...v9, registeredAt: 1_751_628_800 }, { identity: IDENTITY, move: { to: 'idnext', since: 7 } }),
      ]);
      await installed.completeDerivedFields();
      stubs.deploymentProvider.buildDeployment.callsFake(async (record, { replica }) => flux.DeploymentSpec.fromSpec(
        record.spec, APPS_FOLDER, { replica, identity: record.identity },
      ));

      const results = await installedLedger.adoptInstalledLedgers();

      expect(results.adopted).to.deep.equal([{ name: 'legacy', replica: null }, { name: 'moving', replica: null }]);
      expect(results.skipped).to.deep.equal([]);
      expect(await installed.unadopted()).to.deep.equal([]);
      const legacy = await installed.byReplica('legacy', null);
      expect(legacy.identity, 'named by its name').to.equal('legacy');
      expect(legacy.component('web').identifier).to.equal('web_legacy');
      expect(legacy.identifiers()).to.deep.equal(['web_legacy']);
      const moving = await installed.byReplica('moving', null);
      expect(moving.identity).to.equal(IDENTITY);
      expect(moving.component('web').identifier).to.equal(`web_${IDENTITY}`);
      sinon.assert.calledOnceWithExactly(stubs.moveStore.begin, 'moving', null, 'idnext', 7);
      expect(await installed.byIdentifier(`web_${IDENTITY}`), 'found by the ledger\'s identifier').to.not.equal(null);
    });

    it('leaves an instance it cannot adopt as it is, says so, and adopts the rest', async () => {
      const { installed, provider } = await inMemoryInstalled();
      const v8 = (await v8Spec({ name: 'good' })).serialize();
      const bad = (await v8Spec({ name: 'bad' })).serialize();
      await provider.insert(installed.constructor.STORE, [legacyRow(v8), legacyRow(bad)]);
      await installed.completeDerivedFields();
      stubs.deploymentProvider.buildDeployment.callsFake(async (record, { replica }) => {
        if (record.name === 'bad') throw new Error('cannot decrypt');
        return flux.DeploymentSpec.fromSpec(record.spec, APPS_FOLDER, { replica, identity: record.identity });
      });

      const results = await installedLedger.adoptInstalledLedgers();

      expect(results.adopted).to.deep.equal([{ name: 'good', replica: null }]);
      expect(results.skipped).to.deep.equal([{ name: 'bad', replica: null, reason: 'cannot decrypt' }]);
      expect((await installed.unadopted()).map(({ record }) => record.name)).to.deep.equal(['bad']);
      sinon.assert.calledWithMatch(stubs.log.warn, /bad not adopted: cannot decrypt/);
      expect((await installed.byReplica('bad', null)).hasLedger()).to.equal(false);
    });

    it('does nothing on a node whose every instance has a ledger', async () => {
      const { installed } = await inMemoryInstalled();
      const { InstalledSpec } = flux;
      const record = await instantiatedSpec(await v8Spec({ name: 'done' }), { identity: 'done' });
      await installed.put(new InstalledSpec({ record, replica: null, ledger: { network: { name: 'n' }, components: { web: { identifier: 'web_done' } } } }));
      expect(await installedLedger.adoptInstalledLedgers()).to.deep.equal({ adopted: [], skipped: [] });
      sinon.assert.notCalled(stubs.deploymentProvider.buildDeployment);
      sinon.assert.notCalled(stubs.log.info);
    });
  });
});
