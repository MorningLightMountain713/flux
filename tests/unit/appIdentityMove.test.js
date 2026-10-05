'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const operationRegistry = require('../../ZelBack/src/services/utils/operationRegistry');
const { loadSpecLibrary } = require('./fixtures/fluxSpec');

const APPS = '/apps/';
const UUID = 'ab'.repeat(32);
const NAME = 'myapp';

describe('appIdentityMove tests', () => {
  let flux;
  let IDENTITY;
  let stubs;
  let appIdentityMove;
  // The world the move acts on, as the stubs hold it.
  let db; // `${name}|${replica}` -> installed row
  let moves; // `${name}|${replica}` -> the move in progress
  let containers; // docker names present -> { running }
  let mounts; // mounted directories
  let backing; // mounted directory -> the file the kernel mounts there
  let files; // paths that exist
  let records; // identifier -> {path, fsUuid}
  let folders; // syncthing folder id -> {id, path}
  let calls; // every call that matters, in order
  let failing; // command -> how many more times it fails

  before(async function loadLibrary() {
    this.timeout(30_000);
    flux = await loadSpecLibrary();
    IDENTITY = flux.appIdentityFromUuid(UUID);
  });

  const key = (name, replica) => `${name}|${replica ?? ''}`;
  const record = (what, ...args) => calls.push([what, ...args]);
  const indexOf = (what, matcher = () => true) => calls.findIndex(([w, ...args]) => w === what && matcher(...args));
  const indicesOf = (what) => calls.map(([w], i) => (w === what ? i : -1)).filter((i) => i >= 0);
  const newIdentifier = () => `${NAME}_${IDENTITY}`;

  function comp(name, identity, { stateless = false, syncthing = true, daemonStop = false } = {}) {
    return {
      name,
      appName: name,
      identity,
      identifier: `${name}_${identity}`,
      isStateless: stateless,
      hasSyncthing: () => syncthing,
      syncFolderId: `flux${name}_${name}`,
      qualifiedNetworkAliases: [`${name}.${name}`],
      requiresDaemonShutdown: () => daemonStop,
    };
  }

  function deployment(name, identity, compOpts) {
    const c = comp(name, identity, compOpts);
    return {
      appName: name,
      networkName: `fluxDockerNetwork_${identity}`,
      linkedApps: [],
      componentEntries: () => [[name, c]],
      getComponent: () => c,
    };
  }

  function installedRow(overrides = {}) {
    const name = overrides.name ?? NAME;
    return {
      name, replica: null, identity: name, hash: 'h1', owner: 'owner', version: 8, uuid: null, ...overrides,
    };
  }

  // The stored row as the installed collection hands it back: the registered
  // fields, the record beneath them.
  function rowView(row) {
    return {
      ...row, record: row, owed: null, serialize: () => ({ ...row }),
    };
  }

  beforeEach(() => {
    db = new Map();
    moves = new Map();
    containers = new Map();
    mounts = new Set();
    backing = new Map();
    files = new Set();
    records = new Map();
    folders = new Map();
    calls = [];
    failing = new Map();
    let compOpts = {};

    stubs = {
      compOpts: (o) => { compOpts = o; },
      log: { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
      installed: {
        all: async () => [...db.values()].map(rowView),
        byReplica: async (name, replica) => {
          record('byReplica', name, replica);
          const row = db.get(key(name, replica));
          return row ? rowView(row) : null;
        },
        put: async (rec) => {
          record('put', rec.record.name, rec.replica, rec.record.identity);
          Object.assign(db.get(key(rec.record.name, rec.replica)), rec.record);
        },
      },
      ledgers: {
        put: async (ledger) => { record('putLedger', ledger.name, ledger.replica, ledger.network, ledger.components); },
      },
      moveStore: {
        begin: async (name, replica, to) => { record('begin', name, replica, to); moves.set(key(name, replica), { to }); },
        end: async (name, replica) => { record('end', name, replica); moves.delete(key(name, replica)); },
      },
      installedLedger: {
        observeLedger: async (dep, volumeOf) => {
          record('observeLedger', dep.networkName, volumeOf);
          return {
            network: { name: dep.networkName },
            components: Object.fromEntries(dep.componentEntries().map(([n, c]) => [n, { identifier: c.identifier }])),
          };
        },
        // The move's own former-image lookup stands in: the ledger's record, else
        // the file mounted at the former directory, else the 8.x and bare names.
        discoverVolumeImage: async (identifier, recorded, dirs) => {
          // eslint-disable-next-line no-restricted-syntax
          for (const dir of dirs) {
            if (mounts.has(dir) && backing.has(dir)) {
              const path = backing.get(dir);
              return { path, fsUuid: recorded?.path === path ? recorded.fsUuid : 'uuid-probed' };
            }
          }
          if (recorded && files.has(recorded.path)) return recorded;
          // eslint-disable-next-line no-restricted-syntax
          for (const named of [identifier, `flux${identifier}`]) {
            const candidate = `/vol/${named}FLUXFSVOL`;
            if (files.has(candidate)) return { path: candidate, fsUuid: 'uuid-probed' };
          }
          return null;
        },
      },
      // The record classes stand in as plain objects: the rows here are not
      // deserializable specs, and what the move writes is what is asserted.
      specLibrary: {
        loaded: () => ({
          InstalledSpec: function InstalledSpec(fields) { Object.assign(this, fields); },
          InstalledLedger: function InstalledLedger(fields) { Object.assign(this, fields); },
          InstantiatedSpec: { deserialize: (doc) => ({ ...doc }) },
        }),
      },
      appHistory: {
        appliedMessages: sinon.stub().resolves([{ message: {}, decision: { hash: 'h1', uuid: UUID } }]),
        // The version the app was registered with, as its registration message states it.
        registrationVersionOf: sinon.stub().resolves(8),
      },
      deploymentProvider: {
        buildDeployment: async (installed, opts) => {
          record('buildDeployment', installed.identity, opts);
          return deployment(installed.name, opts.identity ?? installed.identity, compOpts);
        },
      },
      dockerService: {
        getDockerContainer: async (name) => (containers.has(name) ? { name } : null),
        appDockerStop: async (name) => { record('appDockerStop', name); containers.get(name).running = false; },
        appDockerRemove: async (name) => {
          record('appDockerRemove', name);
          const left = failing.get('appDockerRemove') ?? 0;
          if (left > 0) { failing.set('appDockerRemove', left - 1); return; }
          containers.delete(name);
        },
        appDockerForceRemove: async (name) => {
          record('appDockerForceRemove', name);
          const left = failing.get('appDockerForceRemove') ?? 0;
          if (left > 0) { failing.set('appDockerForceRemove', left - 1); return; }
          containers.delete(name);
        },
        removeFluxAppDockerNetwork: async (name) => { record('removeFluxAppDockerNetwork', name); },
      },
      volumeService: {
        isPathMounted: async (dir) => mounts.has(dir),
        mountedImagePath: async (dir) => backing.get(dir) ?? null,
        imageFsUuid: async () => 'uuid-probed',
        getVolumeFilePath: async (named) => {
          const candidate = `/vol/${named}FLUXFSVOL`;
          return files.has(candidate) ? { path: candidate, conclusive: true, blocked: null } : { path: null, conclusive: true, blocked: null };
        },
        recordedVolumeImage: async (identifier) => records.get(identifier) ?? null,
        ensureAppVolumeMounted: async (identifier) => {
          record('ensureAppVolumeMounted', identifier);
          return { mounted: true };
        },
      },
      appsRuntimeState: {
        rekey: async (from, to) => { record('rekey', from, to); return true; },
      },
      appInspector: { stopAppMonitoring: (identifier, drop) => record('stopAppMonitoring', identifier, drop) },
      syncthingService: {
        getConfigFolders: async (id) => {
          if (!folders.has(id)) throw Object.assign(new Error('not found'), { httpStatus: 404 });
          return folders.get(id);
        },
        adjustConfigFolders: async (options) => { record('adjustConfigFolders', options); },
      },
      appDockerNetwork: { ensureAppDockerNetwork: async (name, options) => { record('ensureAppDockerNetwork', name, options); } },
      componentProvisioner: {
        installComponent: async (component, options) => {
          record('installComponent', component.identifier, options, operationRegistry.isHeld(component.appName));
          containers.set(component.identifier, { running: false });
        },
      },
      appNetworkLinker: { connectComponentToLinkedApps: async (identifier, dep, aliases) => { record('connectComponentToLinkedApps', identifier, aliases); } },
      appOperations: { requestComponentDaemonStop: sinon.stub().resolves(false) },
      shutdownPlan: { appRequiresDaemonShutdown: sinon.stub().returns(false), buildShutdownPlan: sinon.stub().returns({ plan: true }) },
      fluxShutdowndClient: { upsertAppPlanBestEffort: sinon.stub().resolves() },
      serviceHelper: {
        runCommand: async (command, { params }) => {
          record(command, ...params);
          const left = failing.get(command) ?? 0;
          if (left > 0) { failing.set(command, left - 1); return { error: new Error(`${command} refused`) }; }
          if (command === 'umount') mounts.delete(params[0]);
          if (command === 'mv') { files.delete(params[0]); files.add(params[1]); }
          return { error: null };
        },
        delay: async (ms) => { record('delay', ms); },
      },
      fluxEventBus: { publish: sinon.stub() },
      specLibs: { getSpec: async () => ({ isAppIdentity: flux.isAppIdentity, appIdentityFromUuid: flux.appIdentityFromUuid }) },
      fs: { access: async (p) => { if (!files.has(p)) throw new Error(`ENOENT ${p}`); } },
    };

    appIdentityMove = proxyquire('../../ZelBack/src/services/appLifecycle/appIdentityMove', {
      'node:fs/promises': stubs.fs,
      '../appDatabase/appRecords': { installed: () => stubs.installed, ledgers: () => stubs.ledgers },
      './appIdentityMoveStore': stubs.moveStore,
      './installedLedger': stubs.installedLedger,
      '../utils/specLibrary': stubs.specLibrary,
      '../appDecisions/appHistory': stubs.appHistory,
      '../appRuntime/deploymentProvider': stubs.deploymentProvider,
      '../dockerService': stubs.dockerService,
      '../utils/volumeService': stubs.volumeService,
      '../appManagement/appsRuntimeState': stubs.appsRuntimeState,
      '../appManagement/appInspector': stubs.appInspector,
      '../syncthingService': stubs.syncthingService,
      '../appNetwork/appDockerNetwork': stubs.appDockerNetwork,
      './componentProvisioner': stubs.componentProvisioner,
      './appNetworkLinker': stubs.appNetworkLinker,
      './appOperations': stubs.appOperations,
      './shutdownPlan': stubs.shutdownPlan,
      '../utils/fluxShutdowndClient': stubs.fluxShutdowndClient,
      '../utils/operationRegistry': operationRegistry,
      '../serviceHelper': stubs.serviceHelper,
      '../utils/fluxEventBus': stubs.fluxEventBus,
      '../utils/specLibs': stubs.specLibs,
      '../utils/appConstants': { appsFolder: APPS },
      '../../lib/log': stubs.log,
    });
  });

  afterEach(() => {
    appIdentityMove.resetForTests();
    operationRegistry.clear();
    sinon.restore();
  });

  // One app under its name, running under its 8.x container name on a mounted volume.
  function seedRunningUnderName(name = NAME, overrides = {}) {
    db.set(key(name, null), installedRow({ name, ...overrides }));
    containers.set(`flux${name}_${name}`, { running: true });
    mounts.add(`${APPS}${name}_${name}`);
    backing.set(`${APPS}${name}_${name}`, `/vol/flux${name}_${name}FLUXFSVOL`);
    files.add(`/vol/flux${name}_${name}FLUXFSVOL`);
    files.add(`${APPS}${name}_${name}`);
    folders.set(`flux${name}_${name}`, { id: `flux${name}_${name}`, path: `${APPS}${name}_${name}` });
  }

  describe('which rows move', () => {
    it('leaves a row already on its identity alone', async () => {
      db.set(key(NAME, null), installedRow({ identity: IDENTITY, uuid: UUID }));

      const results = await appIdentityMove.moveInstalledAppsOntoIdentity();

      expect(results).to.deep.equal({
        moved: [], deferred: [], skipped: [], held: [],
      });
      expect(indexOf('byReplica')).to.equal(-1);
    });

    it('reads the uuid off the applied decision of the row\'s message and records it on the row', async () => {
      seedRunningUnderName();

      const results = await appIdentityMove.moveInstalledAppsOntoIdentity();

      expect(results.moved).to.deep.equal([{ name: NAME, replica: null, to: IDENTITY }]);
      expect(calls[indexOf('put')].slice(1, 4), 'the record carries them before anything is planned').to.deep.equal([NAME, null, NAME]);
      expect(indexOf('put')).to.be.lessThan(indexOf('buildDeployment'));
      expect(db.get(key(NAME, null))).to.include({ uuid: UUID });
      expect(db.get(key(NAME, null)), 'the row carries no registration version').to.not.have.property('registrationVersion');
      expect(flux.isAppIdentity(IDENTITY)).to.equal(true);
    });

    // The names under the identity are fixed by the version the app was
    // registered with, which the registration message states and no row holds.
    it('names the view under the identity by the version the registration message states', async () => {
      seedRunningUnderName(NAME, { uuid: UUID });

      await appIdentityMove.moveInstalledAppsOntoIdentity();

      sinon.assert.calledWith(stubs.appHistory.registrationVersionOf, NAME, UUID);
      const next = calls.filter((call) => call[0] === 'buildDeployment').find((call) => call[2].identity === IDENTITY);
      expect(next, 'the view under the identity').to.not.equal(undefined);
      expect(next[2].registrationVersion).to.equal(8);
      const former = calls.filter((call) => call[0] === 'buildDeployment').find((call) => call[2].identity === undefined);
      expect(former[2], 'the view under the name reads what exists').to.not.have.property('registrationVersion');
    });

    it('skips a row whose app no applied message registers, touching nothing', async () => {
      seedRunningUnderName(NAME, { uuid: UUID });
      stubs.appHistory.registrationVersionOf.resolves(null);

      const results = await appIdentityMove.moveInstalledAppsOntoIdentity();

      expect(results.skipped).to.deep.equal([{ name: NAME, replica: null, reason: 'no applied registration names its uuid and version' }]);
      expect(containers.has(`flux${NAME}_${NAME}`), 'the container is left').to.equal(true);
    });

    it('takes the uuid off the row when it carries it', async () => {
      seedRunningUnderName(NAME, { uuid: UUID });

      const results = await appIdentityMove.moveInstalledAppsOntoIdentity();

      expect(results.moved).to.have.lengthOf(1);
      expect(stubs.appHistory.appliedMessages.called).to.equal(false);
      expect(calls.filter((call) => call[0] === 'put'), 'the one write names the identity').to.have.lengthOf(1);
      expect(calls[indexOf('put')][3]).to.equal(IDENTITY);
    });

    it('skips a row whose message no applied decision names, touching nothing', async () => {
      seedRunningUnderName();
      stubs.appHistory.appliedMessages.resolves([{ message: {}, decision: { hash: 'other', uuid: UUID } }]);

      const results = await appIdentityMove.moveInstalledAppsOntoIdentity();

      expect(results.skipped).to.deep.equal([{ name: NAME, replica: null, reason: 'no applied registration names its uuid and version' }]);
      expect(containers.has(`flux${NAME}_${NAME}`), 'the container is left').to.equal(true);
      expect(db.get(key(NAME, null)).identity).to.equal(NAME);
      expect(operationRegistry.isHeld(NAME)).to.equal(false);
    });

    it('refuses an app another operation holds, and holds nothing itself afterwards', async () => {
      seedRunningUnderName(NAME, { uuid: UUID });
      const token = operationRegistry.acquire(NAME, 'install', 'test');

      const results = await appIdentityMove.moveInstalledAppsOntoIdentity();

      expect(results.skipped).to.deep.equal([{ name: NAME, replica: null, reason: 'held by another operation' }]);
      expect(containers.has(`flux${NAME}_${NAME}`)).to.equal(true);
      operationRegistry.release(NAME, token);
      expect(operationRegistry.isHeld(NAME)).to.equal(false);
    });

    it('releases the lease of a row whose deployment cannot be built, and skips it', async () => {
      seedRunningUnderName(NAME, { uuid: UUID });
      stubs.deploymentProvider.buildDeployment = async () => { throw new Error('sealed spec cannot open'); };

      const results = await appIdentityMove.moveInstalledAppsOntoIdentity();

      expect(results.skipped[0].reason).to.match(/cannot be built/);
      expect(operationRegistry.isHeld(NAME)).to.equal(false);
    });

    it('moves each replica\'s row on its own', async () => {
      db.set(key(NAME, 'r1'), installedRow({ replica: 'r1', uuid: UUID }));
      stubs.compOpts({ stateless: true, syncthing: false });

      const results = await appIdentityMove.moveInstalledAppsOntoIdentity();

      expect(results.moved).to.deep.equal([{ name: NAME, replica: 'r1', to: IDENTITY }]);
      expect(calls[indexOf('buildDeployment')].slice(1)).to.deep.equal([NAME, { replica: 'r1' }]);
      expect(calls[indexOf('buildDeployment', (id, o) => o.identity)].slice(1)).to.deep.equal([NAME, { replica: 'r1', identity: IDENTITY, registrationVersion: 8 }]);
    });
  });

  describe('the former containers', () => {
    it('are all stopped before any is removed, so the node pays one grace', async () => {
      seedRunningUnderName('alpha', { hash: 'h1' });
      seedRunningUnderName('beta', { hash: 'h1' });

      const results = await appIdentityMove.moveInstalledAppsOntoIdentity();

      expect(results.moved.map((m) => m.name)).to.deep.equal(['alpha', 'beta']);
      const firstRemove = Math.min(...indicesOf('appDockerRemove'));
      const stoppedFirst = calls.filter(([w], i) => w === 'appDockerStop' && i < firstRemove).map(([, n]) => n);
      expect([...new Set(stoppedFirst)], 'every app is stopped before the first is removed').to.deep.equal(['fluxalpha_alpha', 'fluxbeta_beta']);
    });

    it('is stopped locally when its shutdown does not go through the daemon, removed under its 8.x name, and its monitoring dropped', async () => {
      seedRunningUnderName();

      await appIdentityMove.moveInstalledAppsOntoIdentity();

      expect(calls[indexOf('stopAppMonitoring')].slice(1)).to.deep.equal([`${NAME}_${NAME}`, true]);
      expect(calls[indexOf('appDockerStop')].slice(1)).to.deep.equal([`flux${NAME}_${NAME}`]);
      expect(calls[indexOf('appDockerRemove')].slice(1)).to.deep.equal([`flux${NAME}_${NAME}`]);
      expect(containers.has(`flux${NAME}_${NAME}`)).to.equal(false);
    });

    it('is stopped through the shutdown daemon when its shutdown does', async () => {
      seedRunningUnderName();
      stubs.appOperations.requestComponentDaemonStop.resolves(true);

      await appIdentityMove.moveInstalledAppsOntoIdentity();

      expect(stubs.appOperations.requestComponentDaemonStop.firstCall.args.slice(0, 3)).to.deep.equal(['owner', NAME, null]);
      expect(indexOf('appDockerStop')).to.equal(-1);
      expect(indexOf('appDockerRemove')).to.be.greaterThan(-1);
    });

    it('is removed under the zel name and under the bare identifier as well', async () => {
      seedRunningUnderName();
      containers.clear();
      containers.set(`zel${NAME}_${NAME}`, { running: true });
      containers.set(`${NAME}_${NAME}`, { running: true });

      await appIdentityMove.moveInstalledAppsOntoIdentity();

      expect(calls.filter(([w]) => w === 'appDockerRemove').map(([, n]) => n)).to.deep.equal([`zel${NAME}_${NAME}`, `${NAME}_${NAME}`]);
      expect(containers.has(`zel${NAME}_${NAME}`)).to.equal(false);
      expect(containers.has(`${NAME}_${NAME}`)).to.equal(false);
    });

    it('is force-removed when it stays', async () => {
      seedRunningUnderName();
      failing.set('appDockerRemove', 1);

      const results = await appIdentityMove.moveInstalledAppsOntoIdentity();

      expect(indexOf('appDockerForceRemove')).to.be.greaterThan(indexOf('appDockerRemove'));
      expect(results.moved).to.have.lengthOf(1);
    });

    it('a former container that is not there is a step already taken', async () => {
      seedRunningUnderName();
      containers.clear();

      const results = await appIdentityMove.moveInstalledAppsOntoIdentity();

      expect(results.moved).to.have.lengthOf(1);
      expect(indexOf('appDockerRemove')).to.equal(-1);
    });
  });

  describe('the volume', () => {
    it('is unmounted, its image renamed from the file the kernel mounts and recorded with its stamp, its directory renamed, and mounted under the identity', async () => {
      seedRunningUnderName();
      records.set(`${NAME}_${NAME}`, { path: `/vol/flux${NAME}_${NAME}FLUXFSVOL`, fsUuid: 'uuid-recorded' });

      await appIdentityMove.moveInstalledAppsOntoIdentity();

      const umount = indexOf('umount');
      const mvImage = indexOf('mv', (from) => from.startsWith('/vol/'));
      const mvDir = indexOf('mv', (from) => from.startsWith(APPS));
      expect(calls[umount].slice(1)).to.deep.equal([`${APPS}${NAME}_${NAME}`]);
      expect(calls[mvImage].slice(1)).to.deep.equal([`/vol/flux${NAME}_${NAME}FLUXFSVOL`, `/vol/${newIdentifier()}FLUXFSVOL`]);
      expect(umount, 'unmounted before the image moves').to.be.lessThan(mvImage);
      expect(calls[indexOf('chattr')].slice(1)).to.deep.equal(['-i', `${APPS}${NAME}_${NAME}`]);
      expect(calls[mvDir].slice(1)).to.deep.equal([`${APPS}${NAME}_${NAME}`, `${APPS}${newIdentifier()}`]);
      expect(indexOf('chattr')).to.be.lessThan(mvDir);
      // The ledger names the image under the identity with the stamp it carries,
      // and the volume is mounted only once it does.
      const volumeOf = calls[indexOf('observeLedger')][2];
      expect(await volumeOf(newIdentifier())).to.deep.equal({ path: `/vol/${newIdentifier()}FLUXFSVOL`, fsUuid: 'uuid-recorded' });
      expect(await volumeOf('nothing')).to.equal(null);
      expect(calls[indexOf('ensureAppVolumeMounted')].slice(1)).to.deep.equal([newIdentifier()]);
      expect(indexOf('ensureAppVolumeMounted')).to.be.greaterThan(indexOf('putLedger'));
      expect(indexOf('cp'), 'nothing is copied').to.equal(-1);
    });

    it('finds the image by the record, then by its 8.x filename, then by its bare one, when nothing is mounted', async () => {
      const cases = [
        { name: 'record', setup: () => { records.set(`${NAME}_${NAME}`, { path: '/elsewhere/img', fsUuid: 'u' }); files.add('/elsewhere/img'); }, from: '/elsewhere/img', to: `/elsewhere/${newIdentifier()}FLUXFSVOL`, stamp: 'u' },
        { name: '8.x filename', setup: () => { files.add(`/vol/flux${NAME}_${NAME}FLUXFSVOL`); }, from: `/vol/flux${NAME}_${NAME}FLUXFSVOL`, to: `/vol/${newIdentifier()}FLUXFSVOL`, stamp: 'uuid-probed' },
        { name: 'bare filename', setup: () => { files.add(`/vol/${NAME}_${NAME}FLUXFSVOL`); }, from: `/vol/${NAME}_${NAME}FLUXFSVOL`, to: `/vol/${newIdentifier()}FLUXFSVOL`, stamp: 'uuid-probed' },
      ];
      // eslint-disable-next-line no-restricted-syntax
      for (const c of cases) {
        db.clear(); files.clear(); records.clear(); calls = []; containers.clear(); mounts.clear();
        appIdentityMove.resetForTests();
        db.set(key(NAME, null), installedRow({ uuid: UUID }));
        c.setup();
        // eslint-disable-next-line no-await-in-loop
        const results = await appIdentityMove.moveInstalledAppsOntoIdentity();
        expect(results.moved, c.name).to.have.lengthOf(1);
        expect(indexOf('umount'), `${c.name}: nothing to unmount`).to.equal(-1);
        expect(calls[indexOf('mv')].slice(1), c.name).to.deep.equal([c.from, c.to]);
        // eslint-disable-next-line no-await-in-loop
        expect(await calls[indexOf('observeLedger')][2](newIdentifier()), c.name).to.deep.equal({ path: c.to, fsUuid: c.stamp });
      }
    });

    it('rekeys the runtime state before the ledger is written under the identity', async () => {
      seedRunningUnderName();

      await appIdentityMove.moveInstalledAppsOntoIdentity();

      expect(calls[indexOf('rekey')].slice(1)).to.deep.equal([`${NAME}_${NAME}`, newIdentifier()]);
      expect(indexOf('rekey')).to.be.lessThan(indexOf('putLedger'));
    });

    it('names and mounts an image already in place without renaming it', async () => {
      db.set(key(NAME, null), installedRow({ uuid: UUID }));
      files.add(`/vol/${newIdentifier()}FLUXFSVOL`);
      files.add(`${APPS}${newIdentifier()}`);

      const results = await appIdentityMove.moveInstalledAppsOntoIdentity();

      expect(results.moved).to.have.lengthOf(1);
      expect(indexOf('mv')).to.equal(-1);
      expect(await calls[indexOf('observeLedger')][2](newIdentifier())).to.deep.equal({ path: `/vol/${newIdentifier()}FLUXFSVOL`, fsUuid: 'uuid-probed' });
      expect(indexOf('ensureAppVolumeMounted')).to.be.greaterThan(indexOf('putLedger'));
    });

    // FluxOS 8.x names a component's container, its directory and its image
    // flux<component>_<name>; that is the layout a node upgrading from a release holds.
    it('moves a released node\'s volume from the 8.x directory and image', async () => {
      db.set(key(NAME, null), installedRow({ name: NAME }));
      containers.set(`flux${NAME}_${NAME}`, { running: true });
      mounts.add(`${APPS}flux${NAME}_${NAME}`);
      backing.set(`${APPS}flux${NAME}_${NAME}`, `/vol/flux${NAME}_${NAME}FLUXFSVOL`);
      files.add(`/vol/flux${NAME}_${NAME}FLUXFSVOL`);
      files.add(`${APPS}flux${NAME}_${NAME}`);

      const results = await appIdentityMove.moveInstalledAppsOntoIdentity();

      expect(results.moved).to.have.lengthOf(1);
      expect(calls[indexOf('umount')].slice(1)).to.deep.equal([`${APPS}flux${NAME}_${NAME}`]);
      expect(calls[indexOf('mv', (from) => from.startsWith(APPS))].slice(1))
        .to.deep.equal([`${APPS}flux${NAME}_${NAME}`, `${APPS}${newIdentifier()}`]);
      expect(files.has(`${APPS}${NAME}_${NAME}`), 'a directory under the bare name was made').to.equal(false);
    });

    it('a stateless component moves no volume and keeps its runtime state', async () => {
      seedRunningUnderName();
      stubs.compOpts({ stateless: true, syncthing: false });

      const results = await appIdentityMove.moveInstalledAppsOntoIdentity();

      expect(results.moved).to.have.lengthOf(1);
      expect(indexOf('umount')).to.equal(-1);
      expect(indexOf('mv')).to.equal(-1);
      expect(indexOf('ensureAppVolumeMounted')).to.equal(-1);
      expect(indexOf('rekey')).to.be.greaterThan(-1);
    });

    it('leaves a volume that will not mount to the reconciler: the row is on its identity, no container is created, nothing is held', async () => {
      seedRunningUnderName();
      stubs.volumeService.ensureAppVolumeMounted = async (identifier) => {
        record('ensureAppVolumeMounted', identifier);
        return { mounted: false, reason: 'volume_image_unrecognised' };
      };

      const results = await appIdentityMove.moveInstalledAppsOntoIdentity();

      expect(results.deferred).to.deep.equal([{
        name: NAME, replica: null, to: IDENTITY, reason: `${newIdentifier()}: volume_image_unrecognised`,
      }]);
      expect(results.held).to.deep.equal([]);
      expect(db.get(key(NAME, null)).identity).to.equal(IDENTITY);
      expect(indexOf('installComponent')).to.equal(-1);
      expect(operationRegistry.isHeld(NAME)).to.equal(false);
      expect(stubs.fluxEventBus.publish.firstCall.args[1].deferred).to.equal(true);
    });
  });

  describe('the syncthing folder', () => {
    it('keeps its id and is pointed at the directory the identity names', async () => {
      seedRunningUnderName();

      await appIdentityMove.moveInstalledAppsOntoIdentity();

      expect(calls[indexOf('adjustConfigFolders')][1]).to.deep.equal({
        method: 'patch', id: `flux${NAME}_${NAME}`, config: { path: `${APPS}${newIdentifier()}` },
      });
    });

    it('is left alone when syncthing does not hold it, or already has the path', async () => {
      seedRunningUnderName();
      folders.clear();
      await appIdentityMove.moveInstalledAppsOntoIdentity();
      expect(indexOf('adjustConfigFolders')).to.equal(-1);

      calls = [];
      appIdentityMove.resetForTests();
      seedRunningUnderName();
      folders.set(`flux${NAME}_${NAME}`, { id: `flux${NAME}_${NAME}`, path: `${APPS}${newIdentifier()}` });
      await appIdentityMove.moveInstalledAppsOntoIdentity();
      expect(indexOf('adjustConfigFolders')).to.equal(-1);
    });

    it('costs the move nothing when syncthing cannot answer', async () => {
      seedRunningUnderName();
      stubs.syncthingService.getConfigFolders = async () => { throw new Error('ECONNREFUSED'); };

      const results = await appIdentityMove.moveInstalledAppsOntoIdentity();

      expect(results.moved).to.have.lengthOf(1);
    });
  });

  describe('the row, the network and the recreate', () => {
    it('records the move before anything goes, names the identity, and writes the ledger of what it left before the containers are recreated', async () => {
      seedRunningUnderName();

      await appIdentityMove.moveInstalledAppsOntoIdentity();

      expect(calls[indexOf('begin')].slice(1)).to.deep.equal([NAME, null, IDENTITY]);
      expect(indexOf('begin')).to.be.lessThan(indexOf('appDockerRemove'));
      const flip = indexOf('put', (name, replica, identity) => identity === IDENTITY);
      expect(calls[flip].slice(1)).to.deep.equal([NAME, null, IDENTITY]);
      const ledger = indexOf('putLedger');
      expect(calls[ledger].slice(1)).to.deep.equal([NAME, null, { name: `fluxDockerNetwork_${IDENTITY}` }, { [NAME]: { identifier: newIdentifier() } }]);
      expect(await calls[indexOf('observeLedger')][2](newIdentifier()), 'observed with the volume the move left').to.deep.equal({ path: `/vol/${newIdentifier()}FLUXFSVOL`, fsUuid: 'uuid-probed' });
      expect(ledger).to.be.greaterThan(flip);
      expect(ledger).to.be.lessThan(indexOf('installComponent'));
      expect(indexOf('end'), 'the move record ends with the ledger').to.be.greaterThan(ledger);
      expect(moves.has(key(NAME, null))).to.equal(false);
    });

    it('recreates each container from the image on this node, on its kept volume, under the lease, and attaches the linked networks', async () => {
      seedRunningUnderName();

      await appIdentityMove.moveInstalledAppsOntoIdentity();

      const [, identifier, options, heldDuring] = calls[indexOf('installComponent')];
      expect(identifier).to.equal(newIdentifier());
      expect(options).to.deep.include({
        createVolumes: false, skipPorts: true, localImageFirst: true, allowLocalImageFallback: true, owner: 'owner', uuid: UUID, specVersion: 8,
      });
      expect(heldDuring, 'the app is leased while its containers are recreated').to.equal(true);
      expect(calls[indexOf('buildDeployment', (id, o) => id === IDENTITY && !o.identity)].slice(1), 'the recreate builds from the row the identity is on').to.deep.equal([IDENTITY, { replica: null }]);
      expect(calls[indexOf('connectComponentToLinkedApps')].slice(1)).to.deep.equal([newIdentifier(), [`${NAME}.${NAME}`]]);
      expect(operationRegistry.isHeld(NAME)).to.equal(false);
      expect(stubs.fluxShutdowndClient.upsertAppPlanBestEffort.called).to.equal(false);
    });

    it('leaves a container that is already there', async () => {
      seedRunningUnderName();
      containers.set(newIdentifier(), { running: false });

      const results = await appIdentityMove.moveInstalledAppsOntoIdentity();

      expect(results.moved).to.have.lengthOf(1);
      expect(indexOf('installComponent')).to.equal(-1);
    });

    it('hands the shutdown daemon the plan when the app needs one', async () => {
      seedRunningUnderName();
      stubs.shutdownPlan.appRequiresDaemonShutdown.returns(true);

      await appIdentityMove.moveInstalledAppsOntoIdentity();

      expect(stubs.fluxShutdowndClient.upsertAppPlanBestEffort.calledOnceWith({ plan: true })).to.equal(true);
      expect(calls[indexOf('installComponent')][2].requiresEncryption).to.equal(true);
    });

    it('makes the network under the identity before the row flips, and removes the one named by the name once the containers are recreated', async () => {
      seedRunningUnderName();

      await appIdentityMove.moveInstalledAppsOntoIdentity();

      expect(calls[indexOf('ensureAppDockerNetwork')].slice(1)).to.deep.equal([NAME, { networkName: `fluxDockerNetwork_${IDENTITY}` }]);
      expect(indexOf('ensureAppDockerNetwork')).to.be.lessThan(indexOf('put', (name, replica, identity) => identity === IDENTITY));
      expect(calls[indexOf('removeFluxAppDockerNetwork')].slice(1)).to.deep.equal([NAME]);
      expect(indexOf('removeFluxAppDockerNetwork')).to.be.greaterThan(indexOf('installComponent'));
    });

    it('publishes the move', async () => {
      seedRunningUnderName();

      await appIdentityMove.moveInstalledAppsOntoIdentity();

      expect(stubs.fluxEventBus.publish.calledOnceWith('app:movedOntoIdentity', {
        name: NAME, replica: null, from: NAME, to: IDENTITY, deferred: false,
      })).to.equal(true);
    });
  });

  describe('a step that fails', () => {
    it('is tried again on the spot, and the move completes', async () => {
      seedRunningUnderName();
      failing.set('mv', 2);

      const results = await appIdentityMove.moveInstalledAppsOntoIdentity();

      expect(results.moved).to.have.lengthOf(1);
      expect(indicesOf('delay')).to.have.lengthOf(2);
      expect(results.held).to.deep.equal([]);
    });

    it('holds the app with its lease when it still fails, keeps its move record, and moves the next app', async () => {
      seedRunningUnderName('alpha', { hash: 'h1' });
      seedRunningUnderName('beta', { hash: 'h1' });
      failing.set('appDockerRemove', 99);
      failing.set('appDockerForceRemove', 99);
      containers.delete('fluxbeta_beta');

      const results = await appIdentityMove.moveInstalledAppsOntoIdentity();

      expect(results.held.map((h) => h.name)).to.deep.equal(['alpha']);
      expect(results.held[0].error).to.match(/still present/);
      expect(results.moved.map((m) => m.name)).to.deep.equal(['beta']);
      expect(operationRegistry.isHeld('alpha'), 'the held app keeps its lease').to.equal(true);
      expect(operationRegistry.get('alpha').type).to.equal('move');
      expect(operationRegistry.isHeld('beta')).to.equal(false);
      expect(db.get(key('alpha', null)).identity).to.equal('alpha');
      expect(moves.get(key('alpha', null)).to, 'the move record stays while the app is held').to.equal(flux.appIdentityFromUuid(UUID));
      expect(appIdentityMove.heldRows()).to.deep.equal(['alpha|']);
    });

    it('is retried on a timer until it completes, and the lease is released then', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        seedRunningUnderName();
        failing.set('appDockerRemove', 99);
        failing.set('appDockerForceRemove', 99);
        const first = await appIdentityMove.moveInstalledAppsOntoIdentity();
        expect(first.held).to.have.lengthOf(1);

        // the world heals: the container can be removed now
        failing.clear();
        await clock.tickAsync(60_000);

        expect(appIdentityMove.heldRows()).to.deep.equal([]);
        expect(operationRegistry.isHeld(NAME)).to.equal(false);
        expect(db.get(key(NAME, null)).identity).to.equal(IDENTITY);
        expect(indexOf('installComponent')).to.be.greaterThan(-1);
      } finally {
        clock.restore();
      }
    });

    it('a retry finds a row that reached its identity by another path and lets it go', async () => {
      seedRunningUnderName();
      failing.set('appDockerRemove', 99);
      failing.set('appDockerForceRemove', 99);
      await appIdentityMove.moveInstalledAppsOntoIdentity();
      db.get(key(NAME, null)).identity = IDENTITY;

      const retried = await appIdentityMove.retryHeldApps();

      expect(retried.moved).to.deep.equal([{ name: NAME, replica: null, to: IDENTITY }]);
      expect(appIdentityMove.heldRows()).to.deep.equal([]);
      expect(operationRegistry.isHeld(NAME)).to.equal(false);
    });

    it('keeps holding an app that fails again on the retry', async () => {
      seedRunningUnderName();
      failing.set('appDockerRemove', 99);
      failing.set('appDockerForceRemove', 99);
      await appIdentityMove.moveInstalledAppsOntoIdentity();

      const retried = await appIdentityMove.retryHeldApps();

      expect(retried.held).to.have.lengthOf(1);
      expect(appIdentityMove.heldRows()).to.deep.equal([`${NAME}|`]);
      expect(operationRegistry.isHeld(NAME)).to.equal(true);
    });
  });
});
