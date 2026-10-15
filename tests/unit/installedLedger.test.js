'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

const {
  loadSpecLibrary, V9_SUBMISSION, v8Spec, v9Spec, instantiatedSpec,
} = require('./fixtures/fluxSpec');
const { inMemoryInstalled, inMemoryLedgers } = require('./fixtures/appRecords');

const APPS_FOLDER = '/dat/var/lib/fluxos/flux-apps/';
const IDENTITY = 'a1b2c3d4e5f6';

describe('installedLedger', () => {
  let flux;
  let stubs;
  let installedLedger;
  let volumeOf;
  // The host: what is mounted where, what the kernel backs each mount with,
  // which files exist, and what blkid reads from each.
  let host;

  before(async function loadLibrary() {
    this.timeout(30_000);
    flux = await loadSpecLibrary();
  });

  beforeEach(() => {
    volumeOf = sinon.stub().resolves({ path: '/dat/appvolumes/x', fsUuid: 'uuid-1' });
    host = {
      mounted: new Map(), files: new Set(), stamps: new Map(),
    };
    stubs = {
      volumeService: {
        isPathMounted: sinon.stub().callsFake(async (dir) => host.mounted.has(dir)),
        mountedImagePath: sinon.stub().callsFake(async (dir) => host.mounted.get(dir) ?? null),
        imageFsUuid: sinon.stub().callsFake(async (file) => host.stamps.get(file) ?? null),
        getVolumeFilePath: sinon.stub().callsFake(async (named) => {
          const candidate = `/dat/appvolumes/${named}FLUXFSVOL`;
          return host.files.has(candidate) ? { path: candidate, conclusive: true, blocked: null } : { path: null, conclusive: true, blocked: null };
        }),
      },
      fs: { access: async (file) => { if (!host.files.has(file)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } },
      dockerService: {
        appDockerImageDigest: sinon.stub().resolves('sha256:deadbeef'),
        dockerContainerInspect: sinon.stub().resolves(null),
      },
      appsRuntimeState: { getVolumeImage: sinon.stub().callsFake(async (identifier) => (identifier === 'web_legacy' ? { path: '/dat/appvolumes/legacy', fsUuid: 'uuid-legacy' } : null)) },
      fluxNetworkHelper: { isFirewallActive: sinon.stub().resolves(true) },
      upnpService: { isUPNP: sinon.stub().returns(false) },
      deploymentProvider: { buildDeployment: sinon.stub() },
      // The version each app was registered with, as its registration message states it.
      appHistory: { registrationVersionOf: sinon.stub().resolves(8) },
      moveStore: { begin: sinon.stub().resolves() },
      log: { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
    };
    installedLedger = proxyquire('../../ZelBack/src/services/appLifecycle/installedLedger', {
      '../dockerService': stubs.dockerService,
      '../utils/volumeService': stubs.volumeService,
      'node:fs/promises': stubs.fs,
      '../appManagement/appsRuntimeState': stubs.appsRuntimeState,
      '../fluxNetworkHelper': stubs.fluxNetworkHelper,
      '../upnpService': stubs.upnpService,
      '../appRuntime/deploymentProvider': stubs.deploymentProvider,
      '../appDecisions/appHistory': stubs.appHistory,
      './appIdentityMoveStore': stubs.moveStore,
      '../utils/appConstants': { appsFolder: APPS_FOLDER },
      '../../lib/log': stubs.log,
    });
  });

  afterEach(() => sinon.restore());

  describe('observeLedger', () => {
    it('reads a real deployment\'s names, the volume the reader answers, the daemon\'s digest and the ports as the node opens them', async () => {
      const spec = await v9Spec({ name: 'ledgered' });
      const deployment = flux.DeploymentSpec.fromSpec(spec, APPS_FOLDER, { replica: null, identity: IDENTITY });
      volumeOf.resolves({ path: `/dat/appvolumes/web_${IDENTITY}FLUXFSVOL`, fsUuid: 'uuid-1' });

      const ledger = await installedLedger.observeLedger(deployment, volumeOf);

      expect(ledger.network).to.deep.equal({ name: deployment.networkName });
      const { web } = ledger.components;
      expect(web.identifier).to.equal(`web_${IDENTITY}`);
      expect(web.image).to.deep.equal({ reference: 'nginx:latest', digest: 'sha256:deadbeef' });
      sinon.assert.calledOnceWithExactly(stubs.dockerService.appDockerImageDigest, 'nginx:latest');
      expect(web.hostPorts).to.deep.equal([{ port: 31_000, opened: ['ufw'] }]);
      expect(web.volume).to.deep.equal({
        file: `/dat/appvolumes/web_${IDENTITY}FLUXFSVOL`, disk: '/', fsUuid: 'uuid-1', mountDir: `${APPS_FOLDER}web_${IDENTITY}`,
      });
      sinon.assert.calledOnceWithExactly(volumeOf, `web_${IDENTITY}`);
      expect(web.mountSources.map((m) => m.kind)).to.include('dir');
      expect(web.mountSources.every((m) => m.path.startsWith(`${APPS_FOLDER}web_${IDENTITY}`))).to.equal(true);
      expect(web.syncFolder).to.equal(null);
      expect(web.aliases).to.deep.equal(deployment.getComponent('web').networkAliases);
      expect(web.mesh).to.equal(null);
      expect(web.tls).to.equal(null);
      expect(Object.keys(web).sort()).to.deep.equal([...flux.COMPONENT_LEDGER_FIELDS].sort());
      expect(() => new flux.InstalledLedger({ name: 'ledgered', ...ledger }), 'a ledger the record accepts').to.not.throw();
    });

    it('records each port as opened by UPnP too when the node maps ports, and nothing when the firewall is off', async () => {
      const deployment = flux.DeploymentSpec.fromSpec(await v9Spec({ name: 'ports' }), APPS_FOLDER, { replica: null, identity: IDENTITY });
      stubs.upnpService.isUPNP.returns(true);
      expect((await installedLedger.observeLedger(deployment, volumeOf)).components.web.hostPorts[0].opened).to.deep.equal(['ufw', 'upnp']);
      stubs.fluxNetworkHelper.isFirewallActive.resolves(false);
      expect((await installedLedger.observeLedger(deployment, volumeOf)).components.web.hostPorts[0].opened).to.deep.equal(['upnp']);
    });

    it('keys each component\'s block by its key, never its name', async () => {
      const key = `c${'k'.repeat(52)}`;
      const deployment = flux.DeploymentSpec.fromSpec(await v9Spec({ name: 'keyed' }), APPS_FOLDER, {
        replica: null, identity: IDENTITY, componentKeys: new Map([['web', key]]),
      });
      volumeOf.resolves(null);

      const { components } = await installedLedger.observeLedger(deployment, volumeOf);

      expect(Object.keys(components)).to.deep.equal([key]);
      expect(components[key].identifier).to.equal(`${key}_${IDENTITY}`);
    });

    it('writes null for what the host does not hold: a volume never recorded, an image the daemon lacks, a stateless component', async () => {
      const deployment = flux.DeploymentSpec.fromSpec(await v9Spec({ name: 'bare' }), APPS_FOLDER, { replica: null, identity: IDENTITY });
      volumeOf.resolves(null);
      stubs.dockerService.appDockerImageDigest.resolves(null);
      const { web } = (await installedLedger.observeLedger(deployment, volumeOf)).components;
      expect(web.volume).to.deep.equal({
        file: null, disk: null, fsUuid: null, mountDir: `${APPS_FOLDER}web_${IDENTITY}`,
      });
      expect(web.image.digest).to.equal(null);

      const stateless = {
        networkName: 'net',
        componentEntries: () => [['job', {
          componentKey: 'job',
          identifier: 'job_x', image: 'busybox', hostPorts: [], isStateless: true, mounts: [], networkAliases: ['job'], hasSyncthing: () => false, requiresBackendTls: () => false,
        }]],
      };
      const { job } = (await installedLedger.observeLedger(stateless, volumeOf)).components;
      expect(job.volume).to.equal(null);
      sinon.assert.calledOnceWithExactly(volumeOf, `web_${IDENTITY}`);
    });

    it('records the folder the deployment names, the mesh name the container runs as, the TLS mount, and a volume on another disk', async () => {
      stubs.dockerService.dockerContainerInspect.resolves({ Config: { Env: ['A=1', 'FLUX_MESH_SELF=db-0', 'B=2'] } });
      volumeOf.resolves({ path: '/mnt/disk2/db_xFLUXFSVOL', fsUuid: 'uuid-2' });
      const deployment = {
        networkName: 'net',
        componentEntries: () => [['db', {
          componentKey: 'db',
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
      const { db } = (await installedLedger.observeLedger(deployment, volumeOf)).components;
      expect(db.syncFolder).to.deep.equal({ id: 'db_x', path: `${APPS_FOLDER}db_x` });
      expect(db.mesh).to.deep.equal({ name: 'db-0' });
      expect(db.tls).to.deep.equal({ dir: flux.hostTlsDir(`${APPS_FOLDER}db_x`) });
      expect(db.volume.disk).to.equal('/mnt/disk2');
      expect(db.mountSources).to.deep.equal([{ path: `${APPS_FOLDER}db_x/data`, kind: 'dir' }, { path: `${APPS_FOLDER}db_x/conf.toml`, kind: 'file' }]);
    });
  });

  describe('discoverVolumeImage', () => {
    const ID = 'web_app';
    const recorded = { path: '/dat/appvolumes/recorded', fsUuid: 'uuid-recorded' };

    it('takes the file the kernel mounts at the component\'s directory, under either name, with the record\'s stamp when it names that file', async () => {
      host.mounted.set(`${APPS_FOLDER}${ID}`, '/dat/appvolumes/recorded');
      expect(await installedLedger.discoverVolumeImage(ID, recorded)).to.deep.equal(recorded);
      sinon.assert.notCalled(stubs.volumeService.imageFsUuid);

      host.mounted.clear();
      host.mounted.set(`${APPS_FOLDER}flux${ID}`, '/dat/appvolumes/elsewhere');
      host.stamps.set('/dat/appvolumes/elsewhere', 'uuid-read');
      expect(await installedLedger.discoverVolumeImage(ID, recorded)).to.deep.equal({ path: '/dat/appvolumes/elsewhere', fsUuid: 'uuid-read' });
    });

    it('takes the record when its file is there, reading the stamp the record lacks', async () => {
      host.files.add(recorded.path);
      expect(await installedLedger.discoverVolumeImage(ID, recorded)).to.deep.equal(recorded);
      host.stamps.set(recorded.path, 'uuid-read');
      expect(await installedLedger.discoverVolumeImage(ID, { path: recorded.path, fsUuid: null })).to.deep.equal({ path: recorded.path, fsUuid: 'uuid-read' });
      sinon.assert.notCalled(stubs.volumeService.getVolumeFilePath);
    });

    it('searches by the identifier, then by its 8.x name, when nothing is mounted and the record names nothing there', async () => {
      host.files.add(`/dat/appvolumes/flux${ID}FLUXFSVOL`);
      host.stamps.set(`/dat/appvolumes/flux${ID}FLUXFSVOL`, 'uuid-found');
      expect(await installedLedger.discoverVolumeImage(ID, recorded)).to.deep.equal({ path: `/dat/appvolumes/flux${ID}FLUXFSVOL`, fsUuid: 'uuid-found' });
      expect(stubs.volumeService.getVolumeFilePath.getCalls().map((c) => c.args[0])).to.deep.equal([ID, `flux${ID}`]);

      host.files.add(`/dat/appvolumes/${ID}FLUXFSVOL`);
      expect((await installedLedger.discoverVolumeImage(ID, null)).path, 'the identifier\'s own name first').to.equal(`/dat/appvolumes/${ID}FLUXFSVOL`);
    });

    it('answers null when the host holds nothing, with a stamp it cannot read as null', async () => {
      expect(await installedLedger.discoverVolumeImage(ID, null)).to.equal(null);
      host.files.add(`/dat/appvolumes/${ID}FLUXFSVOL`);
      expect(await installedLedger.discoverVolumeImage(ID, null)).to.deep.equal({ path: `/dat/appvolumes/${ID}FLUXFSVOL`, fsUuid: null });
    });

    it('looks only at the directories it is given, when given', async () => {
      host.mounted.set(`${APPS_FOLDER}${ID}`, '/dat/appvolumes/own');
      host.mounted.set('/elsewhere/dir', '/dat/appvolumes/other');
      expect((await installedLedger.discoverVolumeImage(ID, null, ['/elsewhere/dir'])).path).to.equal('/dat/appvolumes/other');
    });
  });

  describe('adoptInstalledLedgers', () => {
    const legacyRow = (spec, extra = {}) => ({
      ...(spec), hash: `h-${spec.name}`, height: 100, replica: null, componentIdentifiers: [`web_${spec.name}`], ...extra,
    });

    // The provider builds only from an installed record, keyed by its component keys.
    function buildsRealDeployments() {
      stubs.deploymentProvider.buildDeployment.callsFake(async (install, { replica, registrationVersion }) => {
        if (!(install instanceof flux.InstalledSpec)) throw new Error('buildDeployment builds from an installed record');
        return flux.DeploymentSpec.fromSpec(install.spec, APPS_FOLDER, {
          replica, identity: install.identity, registrationVersion, ...(install.componentKeys ? { componentKeys: install.componentKeys } : {}),
        });
      });
    }

    it('keys the ledger it writes by the installed record\'s component keys', async () => {
      const key = `c${'k'.repeat(52)}`;
      const { installed, provider } = await inMemoryInstalled();
      const { ledgers } = await inMemoryLedgers();
      await provider.insert(installed.constructor.STORE, [legacyRow((await v9Spec({ name: 'keyed' })).serialize(), {
        identity: IDENTITY, uuid: 'u-keyed', componentKeys: { web: key },
      })]);
      await installed.completeDerivedFields();
      buildsRealDeployments();

      const results = await installedLedger.adoptInstalledLedgers();

      expect(results.adopted).to.deep.equal([{ name: 'keyed', replica: null }]);
      const ledger = await ledgers.byInstance('keyed', null);
      expect(Object.keys(ledger.components)).to.deep.equal([key]);
      expect(ledger.component(key).identifier).to.equal(`${key}_${IDENTITY}`);
    });

    /** A v9 app whose one component shares its data: the folder it is named under is the registration's. */
    const syncedSpec = async (name) => (await v9Spec({
      name,
      components: {
        web: {
          ...V9_SUBMISSION.components.web,
          persistentStorage: { sizeGb: 5, mounts: { '/data': { source: 'data', destination: '/data' } }, sync: { mode: 'activeStandby' } },
        },
      },
    })).serialize();

    it('names the ledger it writes by the version the registration message states, read for the record\'s app', async () => {
      const { installed, provider } = await inMemoryInstalled();
      const { ledgers } = await inMemoryLedgers();
      const synced = await syncedSpec('shared');
      await provider.insert(installed.constructor.STORE, [legacyRow(synced, { identity: IDENTITY, uuid: 'u-shared' })]);
      await installed.completeDerivedFields();
      buildsRealDeployments();

      const results = await installedLedger.adoptInstalledLedgers();

      expect(results.adopted).to.deep.equal([{ name: 'shared', replica: null }]);
      sinon.assert.calledOnceWithExactly(stubs.appHistory.registrationVersionOf, 'shared', 'u-shared');
      const ledger = await ledgers.byInstance('shared', null);
      expect(ledger.component('web').syncFolder.id, 'the 8.x name, as a registration before v9 fixes it').to.equal('fluxweb_shared');
    });

    it('leaves an instance no applied message registers as it is, and says so', async () => {
      const { installed, provider } = await inMemoryInstalled();
      const { ledgers } = await inMemoryLedgers();
      const synced = await syncedSpec('orphan');
      await provider.insert(installed.constructor.STORE, [legacyRow(synced, { identity: IDENTITY })]);
      await installed.completeDerivedFields();
      buildsRealDeployments();
      stubs.appHistory.registrationVersionOf.resolves(null);

      const results = await installedLedger.adoptInstalledLedgers();

      expect(results.adopted).to.deep.equal([]);
      expect(results.skipped.map((s) => s.name)).to.deep.equal(['orphan']);
      expect(await ledgers.byInstance('orphan', null)).to.equal(null);
      sinon.assert.calledWithMatch(stubs.log.warn, /orphan not adopted/);
    });

    it('writes a ledger for every instance without one, finding its volume from the runtime-state record, names an identity-less one by its name, and hands over its move', async () => {
      const { installed, provider } = await inMemoryInstalled();
      const { ledgers } = await inMemoryLedgers();
      const v8 = (await v8Spec({ name: 'legacy' })).serialize();
      const v9 = (await v9Spec({ name: 'moving' })).serialize();
      await provider.insert(installed.constructor.STORE, [
        legacyRow(v8),
        legacyRow({ ...v9, registeredAt: 1_751_628_800 }, { identity: IDENTITY, move: { to: 'idnext', since: 7 } }),
      ]);
      await installed.completeDerivedFields();
      buildsRealDeployments();
      host.files.add('/dat/appvolumes/legacy');
      host.files.add(`/dat/appvolumes/web_${IDENTITY}FLUXFSVOL`);
      host.stamps.set(`/dat/appvolumes/web_${IDENTITY}FLUXFSVOL`, 'uuid-found');

      const results = await installedLedger.adoptInstalledLedgers();

      expect(results.adopted).to.deep.equal([{ name: 'legacy', replica: null }, { name: 'moving', replica: null }]);
      expect(results.skipped).to.deep.equal([]);
      const legacy = await installed.byReplica('legacy', null);
      expect(legacy.identity, 'named by its name').to.equal('legacy');
      const legacyLedger = await ledgers.byInstance('legacy', null);
      expect(legacyLedger.component('web').identifier).to.equal('web_legacy');
      expect(legacyLedger.component('web').volume).to.include({ file: '/dat/appvolumes/legacy', fsUuid: 'uuid-legacy' });
      sinon.assert.calledWithExactly(stubs.appsRuntimeState.getVolumeImage, 'web_legacy');
      const movingLedger = await ledgers.byInstance('moving', null);
      expect(movingLedger.component('web').volume, 'no record: the image found on the disks, with its stamp read').to.include({
        file: `/dat/appvolumes/web_${IDENTITY}FLUXFSVOL`, fsUuid: 'uuid-found',
      });
      const moving = await installed.byReplica('moving', null);
      expect(moving.identity).to.equal(IDENTITY);
      expect((await ledgers.byIdentifier(`web_${IDENTITY}`)).name, 'found by the ledger\'s identifier').to.equal('moving');
      sinon.assert.calledOnceWithExactly(stubs.moveStore.begin, 'moving', null, 'idnext', 7);
      expect(await installed.legacyMoves(), 'the move left the record with the put').to.deep.equal([]);
      const [stored] = await provider.find(installed.constructor.STORE, { nameKey: 'moving' });
      expect(stored).to.not.have.any.keys('move', 'componentIdentifiers');
      sinon.assert.calledWithMatch(stubs.log.info, /2 of 2 installed instance\(s\) adopted a ledger/);
    });

    it('keeps the component keys the node derived when it names an identity-less instance', async () => {
      const { installed, provider } = await inMemoryInstalled();
      await inMemoryLedgers();
      await provider.insert(installed.constructor.STORE, [legacyRow((await v8Spec({ name: 'legacy' })).serialize(), { componentKeys: { web: 'web' } })]);
      await installed.completeDerivedFields();
      buildsRealDeployments();
      host.files.add('/dat/appvolumes/legacy');

      await installedLedger.adoptInstalledLedgers();

      const legacy = await installed.byReplica('legacy', null);
      expect(legacy.identity, 'the record was rewritten').to.equal('legacy');
      expect([...legacy.componentKeys]).to.deep.equal([['web', 'web']]);
    });

    it('leaves an instance it cannot adopt as it is, says so, and adopts the rest', async () => {
      const { installed, provider } = await inMemoryInstalled();
      const { ledgers } = await inMemoryLedgers();
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
      expect((await ledgers.keys()).map((k) => k.name)).to.deep.equal(['good']);
      sinon.assert.calledWithMatch(stubs.log.warn, /bad not adopted: cannot decrypt/);
    });

    it('does nothing on a node whose every instance has a ledger', async () => {
      const { installed } = await inMemoryInstalled();
      const { ledgers } = await inMemoryLedgers();
      const { InstalledSpec, InstalledLedger } = flux;
      const record = await instantiatedSpec(await v8Spec({ name: 'Done' }), { identity: 'done' });
      await installed.put(new InstalledSpec({ record, replica: 'r1' }));
      await ledgers.put(new InstalledLedger({ name: 'done', replica: 'r1', network: { name: 'n' }, components: { web: { identifier: 'web_done' } } }));
      expect(await installedLedger.adoptInstalledLedgers()).to.deep.equal({ adopted: [], skipped: [] });
      sinon.assert.notCalled(stubs.deploymentProvider.buildDeployment);
      sinon.assert.notCalled(stubs.log.info);
    });

    it('writes the ledger of an instance whose sibling replica has one', async () => {
      const { installed, provider } = await inMemoryInstalled();
      const { ledgers } = await inMemoryLedgers();
      const { InstalledLedger } = flux;
      const v8 = (await v8Spec({ name: 'pair' })).serialize();
      await provider.insert(installed.constructor.STORE, [
        legacyRow(v8, { identity: IDENTITY, replica: 'r1' }), legacyRow(v8, { identity: IDENTITY, replica: 'r2' }),
      ]);
      await installed.completeDerivedFields();
      await ledgers.put(new InstalledLedger({ name: 'pair', replica: 'r1' }));
      buildsRealDeployments();

      const results = await installedLedger.adoptInstalledLedgers();

      expect(results.adopted).to.deep.equal([{ name: 'pair', replica: 'r2' }]);
      expect((await ledgers.byInstance('pair', 'r1')).components, 'the sibling\'s ledger is left').to.deep.equal({});
      expect((await ledgers.byInstance('pair', 'r2')).identifiers()).to.have.length(1);
    });
  });
});
