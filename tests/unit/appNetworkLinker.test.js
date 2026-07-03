const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

chai.use(chaiAsPromised);
const { expect } = chai;

describe('appNetworkLinker tests', () => {
  let appNetworkLinker;
  let appsRepositoryStub;
  let deploymentProviderStub;
  let dockerServiceStub;
  let logStub;

  // Build a minimal InstantiatedSpec-shaped object whose spec mimics the
  // domain-class surface (linkedAppNames per FluxAppSpecBase/V9; validation
  // owns dedupe/self-reference invariants, so the list is returned as-is).
  // activation is the v9 follower toggle; placement mimics the
  // InstantiatedSpec delegating getter.
  function instSpec({
    name, owner = 'owner1', shareWith, encrypted = false, activation, placement,
  } = {}) {
    const spec = {
      linkedAppNames: () => (Array.isArray(shareWith) ? [...shareWith] : []),
    };
    if (shareWith !== undefined) spec.network = { shareWith };
    if (activation !== undefined) spec.activation = activation;
    return {
      name,
      owner,
      isEncrypted: encrypted,
      spec,
      placement,
      // InstantiatedSpec sealed-vantage accessor: none when encrypted, else the spec's.
      linkedAppNames() { return encrypted ? [] : spec.linkedAppNames(); },
    };
  }

  // A follower app: no independent run decision, reaped when orphaned.
  function follower(opts) {
    return instSpec({ ...opts, activation: { standalone: false, stopWhenUnneeded: true } });
  }

  // The resolved (decrypted) link map computeRequiredDependencyNames now takes as
  // input; built here from the plaintext mocks the same way the async caller does.
  function linksMap(apps) {
    const m = new Map();
    apps.forEach((a) => { if (a && a.name) m.set(a.name.toLowerCase(), a.linkedAppNames()); });
    return m;
  }

  // Build a DeploymentSpec-shaped object whose componentEntries expose the
  // given component env arrays via toDockerEnv(). linkedApps is the DECRYPTED
  // link view the log-collector resolution reads.
  function deployment(components, linkedApps = []) {
    return {
      linkedApps,
      componentEntries() {
        return components.map(([cname, env]) => [cname, { toDockerEnv: () => env }]);
      },
    };
  }

  // Loads the module against the shared stubs. The real config (flag off) is used
  // unless fluxappsOverrides supplies e.g. { manageCollectorLifecycle: true }.
  function loadLinker(fluxappsOverrides) {
    const stubs = {
      '../appDatabase/appsRepository': appsRepositoryStub,
      '../appRuntime/deploymentProvider': deploymentProviderStub,
      '../dockerService': dockerServiceStub,
      '../../lib/log': logStub,
    };
    if (fluxappsOverrides) {
      stubs.config = { fluxapps: fluxappsOverrides };
    }
    return proxyquire('../../ZelBack/src/services/appLifecycle/appNetworkLinker', stubs);
  }

  beforeEach(() => {
    appsRepositoryStub = {
      getInstalledApp: sinon.stub(),
      listInstalledApps: sinon.stub(),
      listGlobalAppInfo: sinon.stub(),
    };
    deploymentProviderStub = {
      getInstalledDeployment: sinon.stub(),
      // The decrypt bridge: plaintext reads the sealed accessor, encrypted would
      // decrypt (returns null here unless a test overrides for a specific app).
      resolveLinkedAppNames: sinon.stub().callsFake(async (app) => (app.isEncrypted ? null : app.linkedAppNames())),
    };
    dockerServiceStub = {
      appDockerNetworkConnect: sinon.stub().resolves(),
      appDockerNetworkDisconnect: sinon.stub().resolves(),
      isFluxAppNetwork: sinon.stub().resolves(false),
      fluxDockerNetworkExists: sinon.stub().resolves(true),
      getAppContainerNames: sinon.stub().resolves([]),
      getAppContainerObjects: sinon.stub().resolves([]),
    };
    logStub = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };

    appNetworkLinker = loadLinker();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('checkAppNetworkRequirements', () => {
    it('resolves true and touches no database when there are no linked apps', async () => {
      const result = await appNetworkLinker.checkAppNetworkRequirements(instSpec({ name: 'appB' }));
      expect(result).to.equal(true);
      sinon.assert.notCalled(appsRepositoryStub.getInstalledApp);
    });

    it('throws NETWORK_DEPENDENCY_NOT_READY when a linked app is not installed locally', async () => {
      appsRepositoryStub.getInstalledApp.resolves(null);
      const error = await expect(appNetworkLinker.checkAppNetworkRequirements(instSpec({ name: 'appB', shareWith: ['appA'] })))
        .to.be.rejectedWith(/is not installed on this node/);
      expect(error.code).to.equal('NETWORK_DEPENDENCY_NOT_READY');
    });

    it('throws a code-less hard failure when a linked app is owned by a different owner', async () => {
      appsRepositoryStub.getInstalledApp.resolves(instSpec({ name: 'appA', owner: 'owner2' }));
      const error = await expect(appNetworkLinker.checkAppNetworkRequirements(instSpec({ name: 'appB', owner: 'owner1', shareWith: ['appA'] })))
        .to.be.rejectedWith(/owned by a different owner/);
      expect(error.code).to.equal(undefined);
    });

    it('resolves true when every linked app is installed with the same owner', async () => {
      appsRepositoryStub.getInstalledApp.resolves(instSpec({ name: 'appA', owner: 'owner1' }));
      const result = await appNetworkLinker.checkAppNetworkRequirements(instSpec({ name: 'appB', owner: 'owner1', shareWith: ['appA'] }));
      expect(result).to.equal(true);
    });

    it('flag off (default): an installed but not-running linked app still satisfies the check', async () => {
      appsRepositoryStub.getInstalledApp.resolves(instSpec({ name: 'appA', owner: 'owner1' }));
      dockerServiceStub.getAppContainerObjects.resolves([{ State: 'exited' }]);
      const result = await appNetworkLinker.checkAppNetworkRequirements(instSpec({ name: 'appB', owner: 'owner1', shareWith: ['appA'] }));
      expect(result).to.equal(true);
      sinon.assert.notCalled(dockerServiceStub.getAppContainerObjects);
    });
  });

  describe('checkAppNetworkRequirements with manageCollectorLifecycle on', () => {
    it('throws NETWORK_DEPENDENCY_NOT_READY when a linked app is installed but not running', async () => {
      const linker = loadLinker({ manageCollectorLifecycle: true });
      appsRepositoryStub.getInstalledApp.resolves(instSpec({ name: 'appA', owner: 'owner1' }));
      dockerServiceStub.getAppContainerObjects.resolves([{ State: 'running' }, { State: 'exited' }]);
      const error = await expect(linker.checkAppNetworkRequirements(instSpec({ name: 'appB', owner: 'owner1', shareWith: ['appA'] })))
        .to.be.rejectedWith(/installed but not running yet/);
      expect(error.code).to.equal('NETWORK_DEPENDENCY_NOT_READY');
    });

    it('resolves true when every linked app is installed and running', async () => {
      const linker = loadLinker({ manageCollectorLifecycle: true });
      appsRepositoryStub.getInstalledApp.resolves(instSpec({ name: 'appA', owner: 'owner1' }));
      dockerServiceStub.getAppContainerObjects.resolves([{ State: 'running' }, { State: 'running' }]);
      const result = await linker.checkAppNetworkRequirements(instSpec({ name: 'appB', owner: 'owner1', shareWith: ['appA'] }));
      expect(result).to.equal(true);
    });
  });

  describe('isAppRunning', () => {
    it('is true when every container of the app is running', async () => {
      dockerServiceStub.getAppContainerObjects.resolves([{ State: 'running' }, { State: 'running' }]);
      expect(await appNetworkLinker.isAppRunning('appA')).to.equal(true);
    });

    it('is false when any container of the app is not running', async () => {
      dockerServiceStub.getAppContainerObjects.resolves([{ State: 'running' }, { State: 'exited' }]);
      expect(await appNetworkLinker.isAppRunning('appA')).to.equal(false);
    });

    it('is false when the app has no containers', async () => {
      dockerServiceStub.getAppContainerObjects.resolves([]);
      expect(await appNetworkLinker.isAppRunning('appA')).to.equal(false);
    });
  });

  describe('connectComponentToLinkedApps', () => {
    it('does nothing when the app declares no network links', async () => {
      await appNetworkLinker.connectComponentToLinkedApps('fluxweb_appB', instSpec({ name: 'appB' }));
      sinon.assert.notCalled(dockerServiceStub.appDockerNetworkConnect);
    });

    it('connects the container to every linked app network', async () => {
      await appNetworkLinker.connectComponentToLinkedApps('fluxweb_appB', instSpec({ name: 'appB', shareWith: ['appA', 'appC'] }));
      sinon.assert.calledWith(dockerServiceStub.appDockerNetworkConnect, 'fluxweb_appB', 'fluxDockerNetwork_appA');
      sinon.assert.calledWith(dockerServiceStub.appDockerNetworkConnect, 'fluxweb_appB', 'fluxDockerNetwork_appC');
    });

    it('propagates a raw connection failure (network present) so the install is rolled back', async () => {
      dockerServiceStub.appDockerNetworkConnect.rejects(new Error('docker boom'));
      dockerServiceStub.fluxDockerNetworkExists.resolves(true);
      await expect(appNetworkLinker.connectComponentToLinkedApps('c', instSpec({ name: 'appB', shareWith: ['appA'] })))
        .to.be.rejectedWith('docker boom');
    });

    it('tags an attach failure as NETWORK_DEPENDENCY_NOT_READY when the linked network vanished mid-install', async () => {
      dockerServiceStub.appDockerNetworkConnect.rejects(new Error('network not found'));
      dockerServiceStub.fluxDockerNetworkExists.resolves(false); // the dependency was torn down
      try {
        await appNetworkLinker.connectComponentToLinkedApps('c', instSpec({ name: 'appB', shareWith: ['appA'] }));
        expect.fail('should have thrown');
      } catch (error) {
        expect(error.code).to.equal('NETWORK_DEPENDENCY_NOT_READY');
      }
    });
  });

  describe('follower predicates (activation)', () => {
    it('isPureFollower is true only for activation.standalone === false', () => {
      expect(appNetworkLinker.isPureFollower(follower({ name: 'c' }))).to.equal(true);
      expect(appNetworkLinker.isPureFollower(instSpec({ name: 'c', activation: { standalone: false, stopWhenUnneeded: false } }))).to.equal(true);
      expect(appNetworkLinker.isPureFollower(instSpec({ name: 'c', activation: { standalone: true, stopWhenUnneeded: true } }))).to.equal(false);
      expect(appNetworkLinker.isPureFollower(instSpec({ name: 'c' }))).to.equal(false);
      expect(appNetworkLinker.isPureFollower(null)).to.equal(false);
    });

    it('isPureFollower is false for an encrypted spec (activation unreadable here)', () => {
      const enc = instSpec({ name: 'c', encrypted: true, activation: { standalone: false, stopWhenUnneeded: true } });
      expect(appNetworkLinker.isPureFollower(enc)).to.equal(false);
    });

    it('isReapableFollower requires BOTH standalone false and stopWhenUnneeded', () => {
      expect(appNetworkLinker.isReapableFollower(follower({ name: 'c' }))).to.equal(true);
      expect(appNetworkLinker.isReapableFollower(instSpec({ name: 'c', activation: { standalone: false, stopWhenUnneeded: false } }))).to.equal(false);
      // a standalone app is never reaped - it justifies its own presence
      expect(appNetworkLinker.isReapableFollower(instSpec({ name: 'c', activation: { standalone: true, stopWhenUnneeded: true } }))).to.equal(false);
    });
  });

  describe('computeRequiredDependencyNames', () => {
    it('marks a follower required when a workload links to it', () => {
      const apps = [instSpec({ name: 'game', shareWith: ['collector'] }), follower({ name: 'collector' })];
      expect([...appNetworkLinker.computeRequiredDependencyNames(apps, linksMap(apps))]).to.eql(['collector']);
    });

    it('follows the closure transitively through follower-to-follower links', () => {
      const apps = [
        instSpec({ name: 'game', shareWith: ['datadog'] }),
        follower({ name: 'datadog', shareWith: ['alloy'] }),
        follower({ name: 'alloy' }),
      ];
      const required = appNetworkLinker.computeRequiredDependencyNames(apps, linksMap(apps));
      expect(required.has('datadog')).to.equal(true);
      expect(required.has('alloy')).to.equal(true);
    });

    it('a follower cannot keep itself (or a sibling) alive - closure starts from standalone apps only', () => {
      const apps = [follower({ name: 'datadog', shareWith: ['alloy'] }), follower({ name: 'alloy' })];
      expect(appNetworkLinker.computeRequiredDependencyNames(apps, linksMap(apps)).size).to.equal(0);
    });

    it('ignores cross-owner links', () => {
      const apps = [instSpec({ name: 'game', owner: 'owner1', shareWith: ['collector'] }), follower({ name: 'collector', owner: 'owner2' })];
      expect(appNetworkLinker.computeRequiredDependencyNames(apps, linksMap(apps)).size).to.equal(0);
    });
  });

  describe('findInstalledWorkloadsRequiring', () => {
    it('returns workloads that transitively require the follower, never sibling followers', async () => {
      appsRepositoryStub.listInstalledApps.resolves([
        instSpec({ name: 'game', shareWith: ['datadog'] }),
        follower({ name: 'datadog', shareWith: ['alloy'] }),
        follower({ name: 'alloy' }),
        instSpec({ name: 'unrelated' }),
      ]);
      const requiring = await appNetworkLinker.findInstalledWorkloadsRequiring('alloy');
      expect(requiring.map((a) => a.name)).to.eql(['game']);
    });
  });

  describe('getRequiredDependencyNamesForNode', () => {
    function placementStub(matches) {
      return { hasTargets: () => true, matchesTarget: sinon.stub().returns(matches) };
    }

    it('computes the closure over global apps whose placement targets this node', async () => {
      appsRepositoryStub.listGlobalAppInfo.resolves([
        instSpec({ name: 'game', shareWith: ['collector'], placement: placementStub(true) }),
        follower({ name: 'collector', placement: placementStub(true) }),
        instSpec({ name: 'elsewhere', shareWith: ['othercol'], placement: placementStub(false) }),
        follower({ name: 'othercol', placement: placementStub(false) }),
      ]);
      const required = await appNetworkLinker.getRequiredDependencyNamesForNode({ ip: '7.7.7.7:16127' });
      expect(required.has('collector')).to.equal(true);
      expect(required.has('othercol')).to.equal(false);
    });

    it('returns an empty set when no node identity is known', async () => {
      const required = await appNetworkLinker.getRequiredDependencyNamesForNode({});
      expect(required.size).to.equal(0);
      sinon.assert.notCalled(appsRepositoryStub.listGlobalAppInfo);
    });
  });

  describe('findUnrequiredInstalledDependencies', () => {
    it('returns only reapable followers that no workload requires', async () => {
      appsRepositoryStub.listInstalledApps.resolves([
        instSpec({ name: 'game', shareWith: ['datadog'] }),
        follower({ name: 'datadog' }),
        follower({ name: 'orphaned' }),
        instSpec({ name: 'persistent', activation: { standalone: false, stopWhenUnneeded: false } }),
      ]);
      const orphans = await appNetworkLinker.findUnrequiredInstalledDependencies();
      expect(orphans.map((a) => a.name)).to.eql(['orphaned']);
    });

    it('orphans the follower once its last workload is gone', async () => {
      appsRepositoryStub.listInstalledApps.resolves([follower({ name: 'datadog' })]);
      const orphans = await appNetworkLinker.findUnrequiredInstalledDependencies();
      expect(orphans.map((a) => a.name)).to.eql(['datadog']);
    });
  });

  describe('resolveLogCollector', () => {
    it('prefers the app\'s own LOG=COLLECT component (no cross-app lookup)', async () => {
      const own = deployment([
        ['web', ['FOO=BAR']],
        ['logsink', ['LOG=COLLECT']],
      ], ['appA']);
      const result = await appNetworkLinker.resolveLogCollector(own);
      expect(result).to.eql({ syslogTarget: 'logsink', crossAppLogCollector: null });
      sinon.assert.notCalled(deploymentProviderStub.getInstalledDeployment);
    });

    it('falls back to a linked app\'s collector, read from the DECRYPTED deployment links', async () => {
      // The links come from deployment.linkedApps (the decrypted view), so an
      // encrypted consumer - whose sealed spec would report no links - still
      // resolves its cross-app collector. That is the cross-4 fix.
      deploymentProviderStub.getInstalledDeployment.withArgs('appA').resolves(deployment([
        ['collector', ['LOG=COLLECT']],
      ]));
      const own = deployment([['web', ['FOO=BAR']]], ['appA']);
      const result = await appNetworkLinker.resolveLogCollector(own);
      expect(result).to.eql({ syslogTarget: null, crossAppLogCollector: { linkedAppName: 'appA', collectorComponentName: 'collector' } });
    });

    it('resolves to nothing for an app with no collector anywhere', async () => {
      const own = deployment([['web', ['FOO=BAR']]], []);
      const result = await appNetworkLinker.resolveLogCollector(own);
      expect(result).to.eql({ syslogTarget: null, crossAppLogCollector: null });
    });
  });

  describe('attach serialization under the host mutation lock', () => {
    // eslint-disable-next-line global-require
    const { withHostMutationLock } = require('../../ZelBack/src/services/utils/hostMutationLock');

    it('queues a cross-app attach behind a held teardown lock instead of racing it', async () => {
      let releaseTeardown;
      const teardownGate = new Promise((resolve) => { releaseTeardown = resolve; });
      // The proxyquired module shares the real lock singleton with this holder,
      // standing in for a linked app's teardown worker mid-removal.
      const teardownHold = withHostMutationLock(() => teardownGate);
      await new Promise((resolve) => { setImmediate(resolve); });

      const attach = appNetworkLinker.connectComponentToLinkedApps('fluxweb_appB', instSpec({ name: 'appB', shareWith: ['appA'] }));
      await new Promise((resolve) => { setImmediate(resolve); });
      expect(dockerServiceStub.appDockerNetworkConnect.called, 'attach must wait for the held lock, never race the teardown').to.equal(false);

      releaseTeardown();
      await attach;
      await teardownHold;
      sinon.assert.calledWith(dockerServiceStub.appDockerNetworkConnect, 'fluxweb_appB', 'fluxDockerNetwork_appA');
    });
  });

  describe('ensureContainerNetworkMembership', () => {
    it('connects every desired network the container is missing', async () => {
      const result = await appNetworkLinker.ensureContainerNetworkMembership(
        'fluxweb_myapp',
        ['fluxDockerNetwork_myapp', 'fluxDockerNetwork_collector'],
        ['fluxDockerNetwork_myapp'],
      );
      sinon.assert.calledOnceWithExactly(dockerServiceStub.appDockerNetworkConnect, 'fluxweb_myapp', 'fluxDockerNetwork_collector');
      sinon.assert.notCalled(dockerServiceStub.appDockerNetworkDisconnect);
      expect(result.connected).to.eql(['fluxDockerNetwork_collector']);
    });

    it('disconnects a stale flux app network (ownership label) that is no longer desired', async () => {
      dockerServiceStub.isFluxAppNetwork.withArgs('fluxDockerNetwork_dropped').resolves(true);
      const result = await appNetworkLinker.ensureContainerNetworkMembership(
        'fluxweb_myapp',
        ['fluxDockerNetwork_myapp'],
        ['fluxDockerNetwork_myapp', 'fluxDockerNetwork_dropped'],
      );
      sinon.assert.calledOnceWithExactly(dockerServiceStub.appDockerNetworkDisconnect, 'fluxweb_myapp', 'fluxDockerNetwork_dropped');
      sinon.assert.notCalled(dockerServiceStub.appDockerNetworkConnect);
      expect(result.disconnected).to.eql(['fluxDockerNetwork_dropped']);
    });

    it('never touches a network without the ownership label (docker defaults, user networks)', async () => {
      await appNetworkLinker.ensureContainerNetworkMembership(
        'fluxweb_myapp',
        ['fluxDockerNetwork_myapp'],
        ['fluxDockerNetwork_myapp', 'bridge', 'host'],
      );
      sinon.assert.notCalled(dockerServiceStub.appDockerNetworkConnect);
      sinon.assert.notCalled(dockerServiceStub.appDockerNetworkDisconnect);
    });

    it('disconnects an UNLABELLED pre-upgrade fluxDockerNetwork_ no longer desired (membership-3 fallback)', async () => {
      dockerServiceStub.isFluxAppNetwork.withArgs('fluxDockerNetwork_old').resolves(false); // pre-label, unlabelled
      const result = await appNetworkLinker.ensureContainerNetworkMembership(
        'fluxweb_myapp',
        ['fluxDockerNetwork_myapp'],
        ['fluxDockerNetwork_myapp', 'fluxDockerNetwork_old'],
      );
      sinon.assert.calledOnceWithExactly(dockerServiceStub.appDockerNetworkDisconnect, 'fluxweb_myapp', 'fluxDockerNetwork_old');
      expect(result.disconnected).to.eql(['fluxDockerNetwork_old']);
    });

    it('makes no docker calls when memberships already match', async () => {
      const result = await appNetworkLinker.ensureContainerNetworkMembership(
        'fluxweb_myapp',
        ['fluxDockerNetwork_myapp', 'fluxDockerNetwork_collector'],
        ['fluxDockerNetwork_myapp', 'fluxDockerNetwork_collector'],
      );
      sinon.assert.notCalled(dockerServiceStub.appDockerNetworkConnect);
      sinon.assert.notCalled(dockerServiceStub.appDockerNetworkDisconnect);
      expect(result).to.eql({ connected: [], disconnected: [], failed: [] });
    });

    it('collects a failed change and continues with the rest (best-effort)', async () => {
      dockerServiceStub.appDockerNetworkConnect
        .withArgs('fluxweb_myapp', 'fluxDockerNetwork_gone').rejects(new Error('network not found'));
      const result = await appNetworkLinker.ensureContainerNetworkMembership(
        'fluxweb_myapp',
        ['fluxDockerNetwork_gone', 'fluxDockerNetwork_collector'],
        [],
      );
      expect(result.failed).to.eql(['fluxDockerNetwork_gone']);
      expect(result.connected).to.eql(['fluxDockerNetwork_collector']);
    });
  });

  describe('reconnectLinkedApps', () => {
    it('reconnects only the apps that are networked with the given app', async () => {
      appsRepositoryStub.listInstalledApps.resolves([
        instSpec({ name: 'appB', shareWith: ['appA'] }),
        instSpec({ name: 'appC', shareWith: [] }),
        instSpec({ name: 'appA', shareWith: ['appA'] }),
      ]);
      dockerServiceStub.getAppContainerNames.withArgs('appB').resolves(['fluxweb_appB', 'fluxapi_appB']);
      dockerServiceStub.getAppContainerNames.withArgs('appC').resolves(['fluxweb_appC']);

      await appNetworkLinker.reconnectLinkedApps('appA');

      sinon.assert.calledWith(dockerServiceStub.appDockerNetworkConnect, 'fluxweb_appB', 'fluxDockerNetwork_appA');
      sinon.assert.calledWith(dockerServiceStub.appDockerNetworkConnect, 'fluxapi_appB', 'fluxDockerNetwork_appA');
      expect(dockerServiceStub.appDockerNetworkConnect.calledWith('fluxweb_appC')).to.equal(false);
    });

    it('does not reconnect a consumer owned by a different owner (name changed hands)', async () => {
      appsRepositoryStub.listInstalledApps.resolves([
        instSpec({ name: 'appB', owner: 'attacker', shareWith: ['appA'] }),
        instSpec({ name: 'appA', owner: 'owner1' }),
      ]);
      dockerServiceStub.getAppContainerNames.withArgs('appB').resolves(['fluxweb_appB']);

      await appNetworkLinker.reconnectLinkedApps('appA');

      sinon.assert.notCalled(dockerServiceStub.appDockerNetworkConnect);
    });

    it('does not throw when the database read fails', async () => {
      appsRepositoryStub.listInstalledApps.rejects(new Error('db down'));
      await expect(appNetworkLinker.reconnectLinkedApps('appA')).to.not.be.rejected;
    });
  });

  describe('reconcileAllAppNetworkLinks', () => {
    it('connects only to links that resolve to an installed same-owner app', async () => {
      appsRepositoryStub.listInstalledApps.resolves([
        instSpec({ name: 'appB', shareWith: ['appA'] }),
        instSpec({ name: 'appC', shareWith: [] }),
      ]);
      appsRepositoryStub.getInstalledApp.withArgs('appA').resolves(instSpec({ name: 'appA', owner: 'owner1' }));
      dockerServiceStub.getAppContainerNames.withArgs('appB').resolves(['fluxweb_appB']);

      await appNetworkLinker.reconcileAllAppNetworkLinks();

      sinon.assert.calledWith(dockerServiceStub.appDockerNetworkConnect, 'fluxweb_appB', 'fluxDockerNetwork_appA');
    });

    it('does not connect to a link that changed hands (different owner)', async () => {
      appsRepositoryStub.listInstalledApps.resolves([instSpec({ name: 'appB', shareWith: ['appA'] })]);
      appsRepositoryStub.getInstalledApp.withArgs('appA').resolves(instSpec({ name: 'appA', owner: 'attacker' }));
      dockerServiceStub.getAppContainerNames.withArgs('appB').resolves(['fluxweb_appB']);

      await appNetworkLinker.reconcileAllAppNetworkLinks();

      sinon.assert.notCalled(dockerServiceStub.appDockerNetworkConnect);
    });

    it('does not throw when the database read fails', async () => {
      appsRepositoryStub.listInstalledApps.rejects(new Error('db down'));
      await expect(appNetworkLinker.reconcileAllAppNetworkLinks()).to.not.be.rejected;
    });
  });

  describe('resolveActiveLinkedNetworks', () => {
    it('keeps a link resolving to an installed same-owner app', async () => {
      appsRepositoryStub.getInstalledApp.withArgs('collector').resolves(instSpec({ name: 'collector', owner: 'owner1' }));
      expect(await appNetworkLinker.resolveActiveLinkedNetworks('owner1', ['collector'])).to.eql(['fluxDockerNetwork_collector']);
    });

    it('uses the installed app\'s registered casing for the network name', async () => {
      appsRepositoryStub.getInstalledApp.withArgs('collector').resolves(instSpec({ name: 'Collector', owner: 'owner1' }));
      expect(await appNetworkLinker.resolveActiveLinkedNetworks('owner1', ['collector'])).to.eql(['fluxDockerNetwork_Collector']);
    });

    it('drops a link whose target is not installed (gone)', async () => {
      appsRepositoryStub.getInstalledApp.withArgs('gone').resolves(null);
      expect(await appNetworkLinker.resolveActiveLinkedNetworks('owner1', ['gone'])).to.eql([]);
    });

    it('drops a link whose target changed hands (different owner) - the cross-1 fix', async () => {
      appsRepositoryStub.getInstalledApp.withArgs('collector').resolves(instSpec({ name: 'collector', owner: 'attacker' }));
      expect(await appNetworkLinker.resolveActiveLinkedNetworks('owner1', ['collector'])).to.eql([]);
    });
  });

  describe('isDisconnectEligibleFluxNetwork', () => {
    it('is eligible when the ownership label is present', async () => {
      dockerServiceStub.isFluxAppNetwork.withArgs('fluxDockerNetwork_x').resolves(true);
      expect(await appNetworkLinker.isDisconnectEligibleFluxNetwork('fluxDockerNetwork_x')).to.equal(true);
    });

    it('is eligible for an unlabelled pre-upgrade fluxDockerNetwork_ network (transitional fallback)', async () => {
      dockerServiceStub.isFluxAppNetwork.withArgs('fluxDockerNetwork_old').resolves(false);
      expect(await appNetworkLinker.isDisconnectEligibleFluxNetwork('fluxDockerNetwork_old')).to.equal(true);
    });

    it('is not eligible for a non-flux network', async () => {
      dockerServiceStub.isFluxAppNetwork.withArgs('bridge').resolves(false);
      expect(await appNetworkLinker.isDisconnectEligibleFluxNetwork('bridge')).to.equal(false);
    });
  });

  describe('findLinkedAppLogCollector', () => {
    it('returns null when there are no linked apps', async () => {
      const result = await appNetworkLinker.findLinkedAppLogCollector([]);
      expect(result).to.equal(null);
      sinon.assert.notCalled(deploymentProviderStub.getInstalledDeployment);
    });

    it('returns the first linked app exposing a LOG=COLLECT component', async () => {
      deploymentProviderStub.getInstalledDeployment.withArgs('appA').resolves(deployment([
        ['web', ['FOO=BAR']],
        ['logsink', ['LOG=COLLECT']],
      ]));

      const result = await appNetworkLinker.findLinkedAppLogCollector(['appA']);
      expect(result).to.eql({ linkedAppName: 'appA', collectorComponentName: 'logsink' });
    });

    it('skips linked apps whose deployment cannot be built (encrypted on non-Arcane)', async () => {
      deploymentProviderStub.getInstalledDeployment.withArgs('appA').resolves(null);
      deploymentProviderStub.getInstalledDeployment.withArgs('appC').resolves(deployment([
        ['collector', ['LOG=COLLECT']],
      ]));

      const result = await appNetworkLinker.findLinkedAppLogCollector(['appA', 'appC']);
      expect(result).to.eql({ linkedAppName: 'appC', collectorComponentName: 'collector' });
    });

    it('returns null when no linked app exposes a LOG=COLLECT component', async () => {
      deploymentProviderStub.getInstalledDeployment.withArgs('appA').resolves(deployment([
        ['web', ['FOO=BAR']],
      ]));

      const result = await appNetworkLinker.findLinkedAppLogCollector(['appA']);
      expect(result).to.equal(null);
    });

    it('continues past a deployment build that throws', async () => {
      deploymentProviderStub.getInstalledDeployment.withArgs('appA').rejects(new Error('db down'));
      deploymentProviderStub.getInstalledDeployment.withArgs('appC').resolves(deployment([
        ['collector', ['LOG=COLLECT']],
      ]));

      const result = await appNetworkLinker.findLinkedAppLogCollector(['appA', 'appC']);
      expect(result).to.eql({ linkedAppName: 'appC', collectorComponentName: 'collector' });
    });
  });

  describe('resolver-4: graph reads the decrypted link view', () => {
    it('keeps a follower required by an ENCRYPTED consumer (sealed view would reap it)', async () => {
      const encWorkload = instSpec({ name: 'game', shareWith: ['collector'], encrypted: true });
      appsRepositoryStub.listInstalledApps.resolves([encWorkload, follower({ name: 'collector' })]);
      // The bridge decrypts the encrypted consumer's real link to the collector;
      // the sealed accessor (encWorkload.linkedAppNames()) reports none.
      deploymentProviderStub.resolveLinkedAppNames.withArgs(encWorkload).resolves(['collector']);
      const orphans = await appNetworkLinker.findUnrequiredInstalledDependencies();
      expect(orphans.map((a) => a.name)).to.eql([]);
    });

    it('does not reap when link visibility is incomplete (undecryptable app)', async () => {
      const encWorkload = instSpec({ name: 'game', encrypted: true });
      appsRepositoryStub.listInstalledApps.resolves([encWorkload, follower({ name: 'orphaned' })]);
      deploymentProviderStub.resolveLinkedAppNames.withArgs(encWorkload).resolves(null);
      const orphans = await appNetworkLinker.findUnrequiredInstalledDependencies();
      expect(orphans).to.eql([]);
    });

    it('refuses the required-set (falls back to not suppressing) when an assigned app is undecryptable', async () => {
      const enc = instSpec({ name: 'game', encrypted: true, placement: { hasTargets: () => true, matchesTarget: () => true } });
      appsRepositoryStub.listGlobalAppInfo.resolves([enc]);
      deploymentProviderStub.resolveLinkedAppNames.withArgs(enc).resolves(null);
      await expect(appNetworkLinker.getRequiredDependencyNamesForNode({ ip: '7.7.7.7:16127' })).to.be.rejected;
    });
  });
});
