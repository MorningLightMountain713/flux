'use strict';

// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
// Real registry singleton - un-stubbed in proxyquire, so the module and the test share it.
const operationRegistry = require('../../ZelBack/src/services/utils/operationRegistry');
// Real registry singleton for the same reason: the janitor and the test must
// agree on which playground sessions are live.
const playgroundSessionRegistry = require('../../ZelBack/src/services/appPlayground/playgroundSessionRegistry');
const {
  loadSpecLibrary, v9Spec, registeredSpec,
} = require('./fixtures/fluxSpec');
const { inMemoryHostedInstances, installedRecord } = require('./fixtures/appRecords');

// The spec library is real here, not stubbed - see tests/unit/fixtures/fluxSpec.js
// for why. Every registry and installed row below is a real RegisteredSpec, so
// the expiry sweep runs the LIBRARY's rule (v9: registeredAt + ttl against the
// tip block time; v1-v8: the block height, with the PON fork's 4x) rather than a
// hand-written `isExpired: () => true` that can only ever agree with itself.
// What stays stubbed is I/O: mongo through appsRepository/registryManager,
// docker through dockerService/appQueryService, and the uninstaller.
let flux;

describe('appJanitor tests', () => {
  let appJanitor;
  let logStub;
  let dockerServiceStub;
  let fluxNetworkHelperStub;
  let fluxEventBusStub;
  let appsRepositoryStub;
  let contentSlotServiceStub;
  let appQueryServiceStub;
  let appDockerNetworkStub;
  let appUninstallerStub;
  let hostedInstances;

  // V9_SUBMISSION's ttl is 30 days, so a row registered at this timestamp
  // (2025-07-04) is long past it against wall-clock time.
  const LONG_EXPIRED_AT = 1_751_628_800;

  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(30_000);
    flux = await loadSpecLibrary();
  });

  /**
   * A real global-registry row: an RegisteredSpec. Its isExpired(tipBlockTime,
   * currentHeight) adapts the two numbers appJanitor has into the
   * {state},{clock} pair the inner spec wants - the adaptation the sweep
   * depends on and a literal cannot have.
   */
  async function v9Row(name, { registeredAt = LONG_EXPIRED_AT, height = 2_500_000, identity = null } = {}) {
    return registeredSpec(await v9Spec({ name }), { registeredAt, height, identity });
  }

  /**
   * A real hosted instance over a real RegisteredSpec, stored in the in-memory
   * collection the janitor reads, so the name and identity it matches on are
   * the record's own.
   */
  async function host(name, { identity = null } = {}) {
    const record = await v9Row(name, { registeredAt: Math.floor(Date.now() / 1000), identity });
    await hostedInstances.put(installedRecord(record));
  }

  const container = (name, labels = null) => ({
    Names: [name],
    ...(labels ? { Labels: labels } : {}),
  });

  beforeEach(async () => {
    ({ installed: hostedInstances } = await inMemoryHostedInstances());
    logStub = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };
    dockerServiceStub = {
      isManagedContainer: ({ labels, name }, labelKeys) => {
        if (labels && labels[labelKeys.IDENTIFIER]) return true;
        if (!name) return false;
        const bare = name.startsWith('/') ? name.slice(1) : name;
        return bare.startsWith('flux') || bare.startsWith('zel');
      },
      // mirrors the real helper: the app label is authoritative, the name is read
      // only for pre-label containers, and BOTH prefixes are stripped by width
      containerAppName: ({ labels, name }, labelKeys) => {
        const labelled = labels && labels[labelKeys.APP];
        if (labelled) return labelled;
        if (!name) return null;
        let bare = name.startsWith('/') ? name.slice(1) : name;
        if (bare.startsWith('flux')) bare = bare.slice(4);
        else if (bare.startsWith('zel')) bare = bare.slice(3);
        return bare.split('_')[1] || bare;
      },

      appDockerForceRemove: sinon.stub().resolves(),
    };
    appDockerNetworkStub = {
      removeUnownedAppNetworks: sinon.stub().resolves({ removed: [], unidentified: 0 }),
    };
    fluxNetworkHelperStub = {
      getLocalSocketAddress: sinon.stub().resolves('192.168.1.1:16127'),
    };
    fluxEventBusStub = { publish: sinon.stub() };
    appsRepositoryStub = {
      appLocationFromEvents: sinon.stub().resolves([]),
      removeAppInstallingErrorRecords: sinon.stub().resolves(),
    };
    contentSlotServiceStub = { reapDisplacedManifests: sinon.stub().resolves({ reaped: 0, orphans: [] }) };
    appQueryServiceStub = {
      listAllApps: sinon.stub().resolves({ status: 'success', data: [] }),
      listRunningApps: sinon.stub().resolves({ status: 'success', data: [] }),
    };
    appUninstallerStub = {
      uninstallApplication: sinon.stub().resolves({ status: 'removed', reason: null }),
    };

    appJanitor = proxyquire.noCallThru()('../../ZelBack/src/services/appLifecycle/appJanitor', {
      '../../lib/log': logStub,
      '../dockerService': dockerServiceStub,
      '../fluxNetworkHelper': fluxNetworkHelperStub,
      '../utils/fluxEventBus': fluxEventBusStub,
      '../appDatabase/appsRepository': appsRepositoryStub,
      '../appQuery/appQueryService': appQueryServiceStub,
      '../appNetwork/appDockerNetwork': appDockerNetworkStub,
      './appUninstaller': appUninstallerStub,
      './contentSlotService': contentSlotServiceStub,
    });
  });

  afterEach(() => {
    operationRegistry.clear();
    playgroundSessionRegistry.reset();
    sinon.restore();
  });

  describe('sweepDockerOrphans', () => {
    it('skips while any operation is in flight', async () => {
      operationRegistry.acquire('someapp', 'install', 'test');
      appQueryServiceStub.listAllApps.resolves({ status: 'success', data: [container('/fluxcomp_ghost')] });

      const result = await appJanitor.sweepDockerOrphans();

      expect(result.skipped).to.equal('operation in flight');
      expect(appUninstallerStub.uninstallApplication.called).to.be.false;
    });

    it('resolves the app from the runonflux.app label, not the container name', async () => {
      appQueryServiceStub.listAllApps.resolves({
        status: 'success',
        // The label KEY is a flux-spec contract that the janitor reads out of the
        // library, so the fixture takes it from the same place - a hardcoded
        // 'io.runonflux.app' would survive a rename and quietly stop matching.
        data: [container('/fluxweb_misleading', { [flux.LABEL_KEYS.APP]: 'labelapp' })],
      });

      await appJanitor.sweepDockerOrphans();

      sinon.assert.calledOnceWithMatch(appUninstallerStub.uninstallApplication, 'labelapp');
    });

    it('falls back to name parsing for pre-label containers', async () => {
      appQueryServiceStub.listAllApps.resolves({
        status: 'success',
        data: [container('/fluxcomp_legacyapp'), container('/fluxbareapp')],
      });

      await appJanitor.sweepDockerOrphans();

      sinon.assert.calledWithMatch(appUninstallerStub.uninstallApplication, 'legacyapp');
      sinon.assert.calledWithMatch(appUninstallerStub.uninstallApplication, 'bareapp');
    });

    it('leaves apps with an installed row alone', async () => {
      appQueryServiceStub.listAllApps.resolves({
        status: 'success',
        data: [container('/fluxweb_owned', { [flux.LABEL_KEYS.APP]: 'owned' })],
      });
      await host('owned');

      const result = await appJanitor.sweepDockerOrphans();

      expect(appUninstallerStub.uninstallApplication.called).to.be.false;
      expect(result.removed).to.equal(0);
    });

    it('skips, removing nothing, when the installed set cannot be read - every container would look orphaned', async () => {
      appQueryServiceStub.listAllApps.resolves({
        status: 'success',
        data: [container('/fluxweb_owned', { [flux.LABEL_KEYS.APP]: 'owned' })],
      });
      await host('owned');
      sinon.stub(hostedInstances, 'apps').rejects(new Error('mongo down'));

      const result = await appJanitor.sweepDockerOrphans();

      expect(result.skipped).to.equal('installed list failed');
      expect(appUninstallerStub.uninstallApplication.called).to.be.false;
    });

    it('removes gracefully and backgrounded, broadcasting only with a location row', async () => {
      appQueryServiceStub.listAllApps.resolves({
        status: 'success',
        data: [
          container('/fluxweb_located', { [flux.LABEL_KEYS.APP]: 'located' }),
          container('/fluxweb_unlocated', { [flux.LABEL_KEYS.APP]: 'unlocated' }),
        ],
      });
      appsRepositoryStub.appLocationFromEvents.callsFake(async ({ appname }) => (appname === 'located' ? [{ name: appname }] : []));

      await appJanitor.sweepDockerOrphans();

      sinon.assert.calledWithMatch(
        appUninstallerStub.uninstallApplication,
        'located',
        sinon.match({ forceKill: false, skipGuard: true, broadcastRemoval: true, background: true }),
      );
      sinon.assert.calledWithMatch(
        appUninstallerStub.uninstallApplication,
        'unlocated',
        sinon.match({ forceKill: false, broadcastRemoval: false, background: true }),
      );
    });

    it('publishes the sweep result for harness observability', async () => {
      await appJanitor.sweepDockerOrphans();

      sinon.assert.calledWithMatch(fluxEventBusStub.publish, 'janitor:sweep', sinon.match({ sweep: 'dockerOrphans' }));
    });
  });

  describe('sweepContentManifests', () => {
    it('reaps the manifests of identities another registration of their name displaced, and reports them', async () => {
      contentSlotServiceStub.reapDisplacedManifests.resolves({ reaped: 2, orphans: ['x', 'y'] });

      const result = await appJanitor.sweepContentManifests();

      expect(result).to.deep.equal({ manifestsReaped: 2 });
      expect(appUninstallerStub.uninstallApplication.called).to.be.false;
    });
  });

  describe('sweepDockerDebris', () => {
    it('skips while any operation is in flight', async () => {
      operationRegistry.acquire('someapp', 'install', 'test');

      const result = await appJanitor.sweepDockerDebris();

      expect(result.skipped).to.equal('operation in flight');
      expect(appDockerNetworkStub.removeUnownedAppNetworks.called).to.be.false;
      expect(dockerServiceStub.appDockerForceRemove.called).to.be.false;
    });

    it('runs while an installed app sits stopped - ownership decides, not run state', async () => {
      // The old guard skipped the whole sweep whenever any installed component
      // was down, which on a real node meant it never ran at all.
      await host('stoppedapp');
      appQueryServiceStub.listAllApps.resolves({
        status: 'success', data: [{ ...container('/fluxweb_stoppedapp'), State: 'exited' }],
      });

      const result = await appJanitor.sweepDockerDebris();

      expect(result.skipped).to.equal(undefined);
      sinon.assert.calledOnce(appDockerNetworkStub.removeUnownedAppNetworks);
      // and the stopped app's own network is not up for collection
      const [ownedNetworks] = appDockerNetworkStub.removeUnownedAppNetworks.firstCall.args;
      expect(ownedNetworks.has('fluxDockerNetwork_stoppedapp')).to.be.true;
    });

    it('hands the installed apps\' network names, built from their identities, to the network reap', async () => {
      await host('liveapp', { identity: 'bcccccccccccccccccccccccccccccccccccccccccccccccccccc' });
      await host('stoppedapp');
      appDockerNetworkStub.removeUnownedAppNetworks.resolves({ removed: ['fluxDockerNetwork_goneapp'], unidentified: 0 });

      const result = await appJanitor.sweepDockerDebris();

      const [ownedNetworks] = appDockerNetworkStub.removeUnownedAppNetworks.firstCall.args;
      expect([...ownedNetworks].sort()).to.deep.equal(['fluxDockerNetwork_bcccccccccccccccccccccccccccccccccccccccccccccccccccc', 'fluxDockerNetwork_stoppedapp']);
      expect(result.networksRemoved).to.equal(1);
    });

    // A session's network is named and stamped for the SESSION, so this sweep
    // cannot see it and needs no exception for it. The protected set is the
    // installed apps and nothing else - a live session no longer contributes a
    // name to defend, because there is no longer a name to defend.
    it('protects only installed apps, and never names a live session', async () => {
      await host('liveapp');
      playgroundSessionRegistry.add({ sessionId: 'op_1', appName: 'guestapp' });

      await appJanitor.sweepDockerDebris();

      const [ownedNetworks] = appDockerNetworkStub.removeUnownedAppNetworks.firstCall.args;
      expect([...ownedNetworks]).to.deep.equal(['fluxDockerNetwork_liveapp']);
    });
  });

  describe('playground containers are not app debris', () => {
    const playgroundContainer = (name, sessionId) => ({
      Names: [name],
      Labels: {
        [flux.LABEL_KEYS.APP]: 'guestapp',
        [flux.LABEL_KEYS.PLAYGROUND_SESSION]: sessionId,
      },
    });

    // The orphan sweep removes containers with no installed-app row by running a
    // full app uninstall - ports, mounts, crontab, data - against an app that was
    // never installed. A playground session is exactly that shape by design.
    it('never hands a playground container to the uninstaller', async () => {
      appQueryServiceStub.listAllApps.resolves({
        status: 'success',
        data: [playgroundContainer('/fluxweb_guestapp', 'op_1')],
      });

      await appJanitor.sweepDockerOrphans();

      expect(appUninstallerStub.uninstallApplication.called).to.be.false;
    });

    // Even after the session is gone: its containers are the playground reaper's
    // to collect, and the uninstaller would still be the wrong tool.
    it('leaves an abandoned playground container to the playground reaper', async () => {
      appQueryServiceStub.listAllApps.resolves({
        status: 'success',
        data: [playgroundContainer('/fluxweb_guestapp', 'op_gone')],
      });
      playgroundSessionRegistry.reset();

      await appJanitor.sweepDockerOrphans();

      expect(appUninstallerStub.uninstallApplication.called).to.be.false;
    });

    it('still removes a genuine orphan sitting alongside a playground container', async () => {
      appQueryServiceStub.listAllApps.resolves({
        status: 'success',
        data: [
          playgroundContainer('/fluxweb_guestapp', 'op_1'),
          container('/fluxweb_realghost', { [flux.LABEL_KEYS.APP]: 'realghost' }),
        ],
      });

      await appJanitor.sweepDockerOrphans();

      sinon.assert.calledOnceWithMatch(appUninstallerStub.uninstallApplication, 'realghost');
    });

    it('leaves containers to the orphan sweep - it removes them through the uninstaller', async () => {
      // The debris sweep never actuates container run-state: a container with no
      // installed app is the orphan sweep's, which tears it down with its volumes,
      // ports and shutdown budget instead of pulling it out from under docker.
      appQueryServiceStub.listAllApps.resolves({
        status: 'success', data: [{ ...container('/fluxweb_goneapp'), State: 'exited' }],
      });

      await appJanitor.sweepDockerDebris();

      expect(appUninstallerStub.uninstallApplication.called).to.be.false;
      expect(dockerServiceStub.appDockerForceRemove.called).to.be.false;
    });

    it('reports what it declined to attribute rather than removing it', async () => {
      appDockerNetworkStub.removeUnownedAppNetworks.resolves({ removed: [], unidentified: 2 });

      const result = await appJanitor.sweepDockerDebris();

      expect(result.unidentified).to.equal(2);
      expect(result.networksRemoved).to.equal(0);
    });

    it('skips entirely when the installed set cannot be read - everything would look unowned', async () => {
      sinon.stub(hostedInstances, 'apps').rejects(new Error('mongo down'));

      const result = await appJanitor.sweepDockerDebris();

      expect(result.skipped).to.equal('installed list failed');
      expect(appDockerNetworkStub.removeUnownedAppNetworks.called).to.be.false;
    });

    it('logs and absorbs a failure instead of throwing', async () => {
      appDockerNetworkStub.removeUnownedAppNetworks.rejects(new Error('docker down'));

      const result = await appJanitor.sweepDockerDebris();

      expect(result).to.equal(null);
      expect(logStub.error.calledWithMatch(sinon.match(/dockerDebris sweep failed/))).to.be.true;
    });
  });

  describe('single-flight', () => {
    it('a sweep call while the same sweep runs is absorbed', async () => {
      let release;
      appQueryServiceStub.listAllApps.returns(new Promise((resolve) => {
        release = () => resolve({ status: 'success', data: [] });
      }));

      const first = appJanitor.sweepDockerOrphans();
      const second = await appJanitor.sweepDockerOrphans();
      expect(second).to.equal(null);

      release();
      const firstResult = await first;
      expect(firstResult.removed).to.equal(0);
    });
  });
});
