'use strict';

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

chai.use(chaiAsPromised);
const { expect } = chai;

describe('appNetworkLinker tests', () => {
  let appNetworkLinker;
  let appsRepositoryStub;
  let specCutoverStub;
  let dockerServiceStub;
  let logStub;

  // Build a minimal InstantiatedSpec-shaped object whose spec mimics the
  // domain-class surface: dependencyEntries() returns MATERIALIZED edges and
  // linkedAppNames() is the network-bearing projection, exactly as
  // FluxAppSpecBase derives it. The graph semantics live in
  // relationshipResolver (tested there); this file exercises the docker
  // attach plumbing, which only ever consumes the projection.
  function instSpec({
    name, owner = 'owner1', dependencies, encrypted = false, activation, placement,
  } = {}) {
    const entries = Object.entries(dependencies || {}).map(([target, edge]) => [target, {
      strength: 'requires', after: false, condition: 'started', network: false, onRemove: 'detach', ...edge,
    }]);
    const spec = {
      name,
      owner,
      sealed: encrypted,
      dependencyEntries: () => entries.map(([n, e]) => [n, { ...e }]),
      linkedAppNames() { return entries.filter(([, e]) => e.network === true).map(([n]) => n); },
    };
    if (activation !== undefined) spec.activation = activation;
    return {
      name,
      owner,
      isEncrypted: encrypted,
      spec,
      placement,
      linkedAppNames() { return encrypted ? [] : spec.linkedAppNames(); },
    };
  }

  // Network-bearing edges — the shareWith-fold shape.
  function linkedTo(...names) {
    return Object.fromEntries(names.map((n) => [n, { network: true, onRemove: 'detach' }]));
  }

  // Build a DeploymentSpec-shaped object. linkedApps is the DECRYPTED link
  // view the attach plumbing reads.
  function deployment(components, linkedApps = []) {
    return {
      linkedApps,
      componentEntries() {
        return components.map(([cname, env]) => [cname, { toDockerEnv: () => env }]);
      },
    };
  }

  // Loads the module against the shared stubs. The linker imports
  // buildViewsByName from the resolver, so the resolver is proxied over the
  // SAME stubs — its view resolution then honours each test's
  // resolveInstantiatedSpec behaviour rather than being separately faked.
  function loadLinker() {
    const relationshipResolver = proxyquire('../../ZelBack/src/services/appLifecycle/relationshipResolver', {
      '../appDatabase/appsRepository': appsRepositoryStub,
      '../utils/specCutover': specCutoverStub,
      '../dockerService': dockerServiceStub,
      '../../lib/log': logStub,
    });
    return proxyquire('../../ZelBack/src/services/appLifecycle/appNetworkLinker', {
      '../appDatabase/appsRepository': appsRepositoryStub,
      '../dockerService': dockerServiceStub,
      './relationshipResolver': relationshipResolver,
      '../../lib/log': logStub,
    });
  }

  beforeEach(() => {
    appsRepositoryStub = {
      getInstalledApp: sinon.stub(),
      listInstalledApps: sinon.stub(),
      listGlobalAppInfo: sinon.stub(),
    };
    specCutoverStub = {
      resolveInstantiatedSpec: sinon.stub().callsFake(async (app) => (app.isEncrypted ? null : app.spec)),
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

  describe('connectComponentToLinkedApps', () => {
    it('does nothing when the app declares no network links', async () => {
      await appNetworkLinker.connectComponentToLinkedApps('fluxweb_appB', deployment([]));
      sinon.assert.notCalled(dockerServiceStub.appDockerNetworkConnect);
    });

    it('connects the container to every linked app network', async () => {
      await appNetworkLinker.connectComponentToLinkedApps('fluxweb_appB', deployment([], ['appA', 'appC']));
      sinon.assert.calledWith(dockerServiceStub.appDockerNetworkConnect, 'fluxweb_appB', 'fluxDockerNetwork_appA');
      sinon.assert.calledWith(dockerServiceStub.appDockerNetworkConnect, 'fluxweb_appB', 'fluxDockerNetwork_appC');
    });

    it('propagates a raw connection failure (network present) so the install is rolled back', async () => {
      dockerServiceStub.appDockerNetworkConnect.rejects(new Error('docker boom'));
      dockerServiceStub.fluxDockerNetworkExists.resolves(true);
      await expect(appNetworkLinker.connectComponentToLinkedApps('c', deployment([], ['appA'])))
        .to.be.rejectedWith('docker boom');
    });

    it('tags an attach failure as NETWORK_DEPENDENCY_NOT_READY when the linked network vanished mid-install', async () => {
      dockerServiceStub.appDockerNetworkConnect.rejects(new Error('network not found'));
      dockerServiceStub.fluxDockerNetworkExists.resolves(false); // the dependency was torn down
      try {
        await appNetworkLinker.connectComponentToLinkedApps('c', deployment([], ['appA']));
        expect.fail('should have thrown');
      } catch (error) {
        expect(error.code).to.equal('NETWORK_DEPENDENCY_NOT_READY');
      }
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

      const attach = appNetworkLinker.connectComponentToLinkedApps('fluxweb_appB', deployment([], ['appA']));
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
        instSpec({ name: 'appB', dependencies: linkedTo('appA') }),
        instSpec({ name: 'appC' }),
        instSpec({ name: 'appA' }),
      ]);
      dockerServiceStub.getAppContainerNames.withArgs('appB').resolves(['fluxweb_appB', 'fluxapi_appB']);
      dockerServiceStub.getAppContainerNames.withArgs('appC').resolves(['fluxweb_appC']);

      await appNetworkLinker.reconnectLinkedApps('appA');

      sinon.assert.calledWith(dockerServiceStub.appDockerNetworkConnect, 'fluxweb_appB', 'fluxDockerNetwork_appA');
      sinon.assert.calledWith(dockerServiceStub.appDockerNetworkConnect, 'fluxapi_appB', 'fluxDockerNetwork_appA');
      expect(dockerServiceStub.appDockerNetworkConnect.calledWith('fluxweb_appC')).to.equal(false);
    });

    it('does not reconnect a consumer whose edge does not share a network', async () => {
      appsRepositoryStub.listInstalledApps.resolves([
        instSpec({ name: 'appB', dependencies: { appA: { onRemove: 'cascade' } } }),
        instSpec({ name: 'appA' }),
      ]);
      dockerServiceStub.getAppContainerNames.withArgs('appB').resolves(['fluxweb_appB']);

      await appNetworkLinker.reconnectLinkedApps('appA');

      sinon.assert.notCalled(dockerServiceStub.appDockerNetworkConnect);
    });

    it('does not reconnect a consumer owned by a different owner (name changed hands)', async () => {
      appsRepositoryStub.listInstalledApps.resolves([
        instSpec({ name: 'appB', owner: 'attacker', dependencies: linkedTo('appA') }),
        instSpec({ name: 'appA', owner: 'owner1' }),
      ]);
      dockerServiceStub.getAppContainerNames.withArgs('appB').resolves(['fluxweb_appB']);

      await appNetworkLinker.reconnectLinkedApps('appA');

      sinon.assert.notCalled(dockerServiceStub.appDockerNetworkConnect);
    });

    it('reconnects an ENCRYPTED consumer, whose edges live in the ciphertext', async () => {
      // Read off the sealed accessor an encrypted consumer declares no edges,
      // so it was never reattached when its dependency's network was recreated.
      const enc = instSpec({ name: 'appB', dependencies: linkedTo('appA'), encrypted: true });
      appsRepositoryStub.listInstalledApps.resolves([enc, instSpec({ name: 'appA' })]);
      specCutoverStub.resolveInstantiatedSpec.withArgs(enc).resolves(enc.spec);
      dockerServiceStub.getAppContainerNames.withArgs('appB').resolves(['fluxweb_appB']);

      await appNetworkLinker.reconnectLinkedApps('appA');

      sinon.assert.calledWith(dockerServiceStub.appDockerNetworkConnect, 'fluxweb_appB', 'fluxDockerNetwork_appA');
    });

    it('leaves an undecryptable consumer alone rather than guessing', async () => {
      const enc = instSpec({ name: 'appB', dependencies: linkedTo('appA'), encrypted: true });
      appsRepositoryStub.listInstalledApps.resolves([enc, instSpec({ name: 'appA' })]);
      specCutoverStub.resolveInstantiatedSpec.withArgs(enc).resolves(null);
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
        instSpec({ name: 'appB', dependencies: linkedTo('appA') }),
        instSpec({ name: 'appC' }),
      ]);
      appsRepositoryStub.getInstalledApp.withArgs('appA').resolves(instSpec({ name: 'appA', owner: 'owner1' }));
      dockerServiceStub.getAppContainerNames.withArgs('appB').resolves(['fluxweb_appB']);

      await appNetworkLinker.reconcileAllAppNetworkLinks();

      sinon.assert.calledWith(dockerServiceStub.appDockerNetworkConnect, 'fluxweb_appB', 'fluxDockerNetwork_appA');
    });

    it('does not connect to a link that changed hands (different owner)', async () => {
      appsRepositoryStub.listInstalledApps.resolves([instSpec({ name: 'appB', dependencies: linkedTo('appA') })]);
      appsRepositoryStub.getInstalledApp.withArgs('appA').resolves(instSpec({ name: 'appA', owner: 'attacker' }));
      dockerServiceStub.getAppContainerNames.withArgs('appB').resolves(['fluxweb_appB']);

      await appNetworkLinker.reconcileAllAppNetworkLinks();

      sinon.assert.notCalled(dockerServiceStub.appDockerNetworkConnect);
    });

    it('bridges an ENCRYPTED app at boot, whose edges live in the ciphertext', async () => {
      const enc = instSpec({ name: 'appB', dependencies: linkedTo('appA'), encrypted: true });
      appsRepositoryStub.listInstalledApps.resolves([enc]);
      specCutoverStub.resolveInstantiatedSpec.withArgs(enc).resolves(enc.spec);
      appsRepositoryStub.getInstalledApp.withArgs('appA').resolves(instSpec({ name: 'appA', owner: 'owner1' }));
      dockerServiceStub.getAppContainerNames.withArgs('appB').resolves(['fluxweb_appB']);

      await appNetworkLinker.reconcileAllAppNetworkLinks();

      sinon.assert.calledWith(dockerServiceStub.appDockerNetworkConnect, 'fluxweb_appB', 'fluxDockerNetwork_appA');
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
});
