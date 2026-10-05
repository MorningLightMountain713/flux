'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('componentProvisioner tests', () => {
  let appDockerStartStub;
  let appDockerCreateStub;
  let createAppVolumeStub;
  let appDockerImageSizeStub;
  let allowPortStub;
  let mapUpnpPortStub;
  let provisionCertStub;
  let ledgersStub;
  let appDockerImageDigestStub;
  const APPS_FOLDER = '/apps/';
  // The app's identity, carried by every component the library resolves.
  const IDENTITY = `b${'a'.repeat(52)}`;

  // installComponent isolated behind its provisioning deps. noCallThru + every
  // require stubbed, so nothing touches a real service.
  function loadProvisioner(opts = {}) {
    const {
      teardownOwed = false, isCondemnedStub = null, firewallActive = false, isUPNP = false, pullError = null,
      certError = null, meshPrepareStub = null,
    } = opts;
    appDockerStartStub = sinon.stub().resolves('ok');
    appDockerCreateStub = sinon.stub().resolves();
    createAppVolumeStub = sinon.stub().resolves();
    appDockerImageSizeStub = sinon.stub().resolves(0);
    allowPortStub = sinon.stub().resolves({ status: true });
    mapUpnpPortStub = sinon.stub().resolves(true);
    provisionCertStub = certError ? sinon.stub().rejects(certError) : sinon.stub().resolves();
    appDockerImageDigestStub = sinon.stub().resolves('sha256:pulled');
    ledgersStub = { addComponent: sinon.stub().resolves(true), setComponent: sinon.stub().resolves() };
    return proxyquire.load('../../ZelBack/src/services/appLifecycle/componentProvisioner', {
      '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
      '../dockerService': {
        appDockerCreate: appDockerCreateStub,
        appDockerImageSize: appDockerImageSizeStub,
        appDockerImageDigest: appDockerImageDigestStub,
        appDockerStart: appDockerStartStub,
        dockerPullStream: sinon.stub(),
      },
      '../appDatabase/appRecords': { ledgers: () => ledgersStub },
      '../utils/appConstants': { appsFolder: APPS_FOLDER },
      '../fluxNetworkHelper': { isFirewallActive: sinon.stub().resolves(firewallActive), allowPort: allowPortStub },
      '../upnpService': { isUPNP: sinon.stub().returns(isUPNP), mapUpnpPort: mapUpnpPortStub },
      '../appRequirements/hwRequirements': { systemArchitecture: sinon.stub().resolves('amd64') },
      '../appSecurity/imageManager': { verifyRepository: sinon.stub().resolves({ verified: true, provider: 'docker.io', supportedArchitectures: ['amd64'] }) },
      '../utils/registryCredentialHelper': { getCredentials: sinon.stub().resolves(null) },
      './appVolumeService': { createAppVolume: createAppVolumeStub },
      './appSwapPoolService': { reconcile: sinon.stub().resolves() },
      './backendTlsService': { provisionCert: provisionCertStub },
      '../utils/volumeService': { verifyAppVolumeMount: sinon.stub().resolves() },
      '../telemetryIdentityService': { onComponentCreated: sinon.stub().resolves() },
      '../appManagement/appsRuntimeState': { isCondemned: isCondemnedStub || sinon.stub().resolves(false) },
      './pendingTeardownStore': { teardownOwedFor: sinon.stub().resolves(teardownOwed) },
      '../appMesh/meshReconciler': { prepareComponentMesh: meshPrepareStub || sinon.stub().resolves(null) },
      util: { promisify: () => async () => { if (pullError) throw pullError; return 'pulled'; } },
    });
  }

  function makeComponent(syncMode, overrides = {}) {
    return {
      name: 'web',
      appName: 'syncholdapp',
      identity: IDENTITY,
      identifier: 'web_syncholdapp',
      image: 'nginx:latest',
      imageAuth: null,
      hostPorts: [],
      rootFsGb: 2,
      // Fit decision delegated to the component (real logic tested in flux-spec).
      imageFitsRootFs: () => true,
      hasActiveStandbySyncthing: () => syncMode === 'activeStandby',
      requiresSyncBeforeStart: () => syncMode === 'syncFirst',
      requiresBackendTls: () => false,
      backendTlsPaths: () => null,
      hasSyncthing: () => false,
      syncFolderId: 'web_syncholdapp',
      networkAliases: ['web'],
      mounts: [],
      ...overrides,
    };
  }

  // The ledger writes of one install, as [field, value] in the order made.
  const ledgerWrites = () => ledgersStub.setComponent.getCalls().map((c) => c.args.slice(3));
  const ledgerWrite = (field) => ledgersStub.setComponent.getCalls().find((c) => c.args[3] === field);

  // A verify:required component as flux-spec resolves it. backendTlsPaths() is
  // the domain type's own accessor - the runtime never rebuilds these paths, so
  // the fixture hands back what the real method would.
  const TLS_DIR = '/host/fluxweb_syncholdapp/io.runonflux/tls';
  function makeTlsComponent(overrides = {}) {
    return makeComponent(null, {
      requiresBackendTls: () => true,
      backendTlsPaths: () => ({
        dir: TLS_DIR, certPath: `${TLS_DIR}/cert.pem`, keyPath: `${TLS_DIR}/key.pem`,
      }),
      mounts: [
        { Target: '/data', Source: '/host/fluxweb_syncholdapp/appdata' },
        { Target: '/io.runonflux/tls', Source: TLS_DIR },
      ],
      ...overrides,
    });
  }

  async function installWith(syncMode, createVolumes) {
    const provisioner = loadProvisioner();
    await provisioner.installComponent(makeComponent(syncMode), { owner: 'owner1', createVolumes });
  }

  // Every entry is in the ledger before the step that creates what it names.
  describe('the ledger', () => {
    it('adds the component\'s block before anything is provisioned, with its identifier, image reference and sync folder', async () => {
      const provisioner = loadProvisioner({ firewallActive: true });
      await provisioner.installComponent(makeComponent(null, {
        hostPorts: [31_000], hasSyncthing: () => true, syncFolderId: 'fluxweb_synchold',
      }), { owner: 'owner1', createVolumes: true });

      sinon.assert.calledOnceWithExactly(ledgersStub.addComponent, 'syncholdapp', null, 'web', {
        identifier: 'web_syncholdapp', image: 'nginx:latest', syncFolder: { id: 'fluxweb_synchold', path: '/apps/web_syncholdapp' },
      });
      expect(ledgersStub.addComponent.calledBefore(allowPortStub), 'the block precedes the first port').to.equal(true);
      expect(ledgersStub.addComponent.calledBefore(createAppVolumeStub)).to.equal(true);
      expect(ledgersStub.addComponent.calledBefore(appDockerCreateStub)).to.equal(true);
    });

    it('names no sync folder for a component without syncthing, and carries the replica of a named instance', async () => {
      const provisioner = loadProvisioner();
      await provisioner.installComponent(makeComponent(null, { replica: 'r1' }), { owner: 'owner1' });
      sinon.assert.calledOnceWithExactly(ledgersStub.addComponent, 'syncholdapp', 'r1', 'web', {
        identifier: 'web_syncholdapp', image: 'nginx:latest', syncFolder: null,
      });
      expect(ledgersStub.setComponent.getCalls().every((c) => c.args[1] === 'r1'), 'every entry is the replica\'s').to.equal(true);
    });

    it('records each port with the methods that will open it, before it is opened', async () => {
      const provisioner = loadProvisioner({ firewallActive: true, isUPNP: true });
      await provisioner.installComponent(makeComponent(null, { hostPorts: [31_000, 31_001] }), { owner: 'owner1' });

      const ports = ledgerWrite('hostPorts');
      expect(ports.args).to.deep.equal(['syncholdapp', null, 'web', 'hostPorts', [
        { port: 31_000, opened: ['ufw', 'upnp'] }, { port: 31_001, opened: ['ufw', 'upnp'] },
      ]]);
      expect(ports.calledBefore(allowPortStub.firstCall), 'recorded before opened').to.equal(true);
      expect(ports.calledBefore(mapUpnpPortStub.firstCall)).to.equal(true);
      sinon.assert.calledTwice(allowPortStub);
      sinon.assert.calledTwice(mapUpnpPortStub);
    });

    it('records a port as opened by nothing on a node with no firewall and no UPnP, and opens it by nothing', async () => {
      const provisioner = loadProvisioner();
      await provisioner.installComponent(makeComponent(null, { hostPorts: [31_000] }), { owner: 'owner1' });
      expect(ledgerWrite('hostPorts').args[4]).to.deep.equal([{ port: 31_000, opened: [] }]);
      sinon.assert.notCalled(allowPortStub);
      sinon.assert.notCalled(mapUpnpPortStub);
    });

    it('leaves the ports entry as it is on a redeploy, which opens none', async () => {
      const provisioner = loadProvisioner({ firewallActive: true });
      await provisioner.installComponent(makeComponent(null, { hostPorts: [31_000] }), { owner: 'owner1', skipPorts: true });
      expect(ledgerWrite('hostPorts')).to.equal(undefined);
      sinon.assert.notCalled(allowPortStub);
    });

    it('records the image with the digest the daemon holds after the pull, before the volume is built', async () => {
      const provisioner = loadProvisioner();
      await provisioner.installComponent(makeComponent(null), { owner: 'owner1', createVolumes: true });
      const image = ledgerWrite('image');
      expect(image.args[4]).to.deep.equal({ reference: 'nginx:latest', digest: 'sha256:pulled' });
      sinon.assert.calledOnceWithExactly(appDockerImageDigestStub, 'nginx:latest');
      expect(image.calledBefore(createAppVolumeStub.firstCall)).to.equal(true);
    });

    it('records the mount sources before the volume that holds them is created', async () => {
      const provisioner = loadProvisioner();
      await provisioner.installComponent(makeComponent(null, {
        mounts: [{ Source: '/apps/web_syncholdapp/appdata', sourceType: 'directory' }, { Source: '/apps/web_syncholdapp/conf.toml', sourceType: 'file' }],
      }), { owner: 'owner1', createVolumes: true });
      const sources = ledgerWrite('mountSources');
      expect(sources.args[4]).to.deep.equal([
        { path: '/apps/web_syncholdapp/appdata', kind: 'dir' }, { path: '/apps/web_syncholdapp/conf.toml', kind: 'file' },
      ]);
      expect(sources.calledBefore(createAppVolumeStub.firstCall)).to.equal(true);
    });

    it('records the TLS directory before the certificate is issued', async () => {
      const provisioner = loadProvisioner();
      await provisioner.installComponent(makeTlsComponent(), { owner: 'owner1', createVolumes: true });
      const tls = ledgerWrite('tls');
      expect(tls.args[4]).to.deep.equal({ dir: TLS_DIR });
      expect(tls.calledBefore(provisionCertStub.firstCall)).to.equal(true);
    });

    it('records the mesh member name once the mesh runtime answers, and the aliases the container is created with, before it is created', async () => {
      const meshPrepareStub = sinon.stub().resolves({
        presentedIp: '10.9.0.2', env: ['FLUX_MESH_SELF=web-0'], dns: ['10.9.0.1'], hostname: 'web-0', aliases: ['web', 'web-0'],
      });
      const provisioner = loadProvisioner({ meshPrepareStub });
      await provisioner.installComponent(makeComponent(null, { networkAliases: ['web', 'web.syncholdapp'] }), { owner: 'owner1' });

      const mesh = ledgerWrite('mesh');
      expect(mesh.args[4]).to.deep.equal({ name: 'web-0' });
      expect(mesh.calledBefore(appDockerCreateStub.firstCall)).to.equal(true);
      const aliases = ledgerWrite('aliases');
      expect(aliases.args[4]).to.deep.equal(['web', 'web.syncholdapp', 'web-0']);
      expect(aliases.calledBefore(appDockerCreateStub.firstCall)).to.equal(true);
      expect(appDockerCreateStub.firstCall.args[1].networkAliases, 'created with the aliases recorded').to.deep.equal(['web', 'web.syncholdapp', 'web-0']);
    });

    it('records no mesh name and no TLS directory for a component that has neither', async () => {
      const provisioner = loadProvisioner();
      await provisioner.installComponent(makeComponent(null), { owner: 'owner1' });
      expect(ledgerWrites().map(([field]) => field)).to.deep.equal(['hostPorts', 'image', 'mountSources', 'aliases']);
    });

    it('fails the install when an entry cannot be written, before the step that uses it', async () => {
      const provisioner = loadProvisioner({ firewallActive: true });
      ledgersStub.setComponent.withArgs('syncholdapp', null, 'web', 'hostPorts').rejects(new Error('ledger down'));
      let threw = null;
      await provisioner.installComponent(makeComponent(null, { hostPorts: [31_000] }), { owner: 'owner1' }).catch((e) => { threw = e; });
      expect(threw.message).to.equal('ledger down');
      sinon.assert.notCalled(allowPortStub);
      sinon.assert.notCalled(appDockerCreateStub);
    });
  });

  describe('opening host ports', () => {
    it('names the methods this node opens a port by', async () => {
      expect(await loadProvisioner({ firewallActive: true, isUPNP: true }).portOpenMethods()).to.deep.equal(['ufw', 'upnp']);
      expect(await loadProvisioner({ firewallActive: true }).portOpenMethods()).to.deep.equal(['ufw']);
      expect(await loadProvisioner({ isUPNP: true }).portOpenMethods()).to.deep.equal(['upnp']);
      expect(await loadProvisioner().portOpenMethods()).to.deep.equal([]);
    });

    it('opens by the methods it is given, not by what the node answers now', async () => {
      const provisioner = loadProvisioner({ firewallActive: true, isUPNP: true });
      await provisioner.openHostPorts([80, 81], 'app', ['upnp']);
      sinon.assert.notCalled(allowPortStub);
      sinon.assert.calledTwice(mapUpnpPortStub);
      sinon.assert.calledWithExactly(mapUpnpPortStub, 81, 'Flux_App_app');
    });

    it('throws on the first port that fails to open or map', async () => {
      const provisioner = loadProvisioner();
      allowPortStub.resolves({ status: false });
      await provisioner.openHostPorts([80], 'app', ['ufw']).then(() => { throw new Error('opened'); }, (e) => expect(e.message).to.match(/80 FAILed to open/));
      mapUpnpPortStub.resolves(false);
      await provisioner.openHostPorts([80], 'app', ['upnp']).then(() => { throw new Error('mapped'); }, (e) => expect(e.message).to.match(/80 FAILed to map/));
    });
  });

  describe('registry-unreachable local-image fallback (recreate)', () => {
    const transientPullError = () => Object.assign(new Error('dial tcp: connection refused'), { registryErrorClass: 'transient' });

    it('creates from the local image when the pull fails transient and the image is on disk', async () => {
      const provisioner = loadProvisioner({ pullError: transientPullError() });
      appDockerImageSizeStub.resolves(5e8); // image present locally
      await provisioner.installComponent(makeComponent(null), { owner: 'owner1', allowLocalImageFallback: true });
      sinon.assert.calledOnce(appDockerCreateStub);
    });

    it('still fails when the image is NOT on disk (nothing to fall back to)', async () => {
      const provisioner = loadProvisioner({ pullError: transientPullError() });
      appDockerImageSizeStub.resolves(0);
      try {
        await provisioner.installComponent(makeComponent(null), { owner: 'owner1', allowLocalImageFallback: true });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('connection refused');
      }
      sinon.assert.notCalled(appDockerCreateStub);
    });

    it('still fails on a permanent pull error even with the image on disk (pull-first, no stale-run policy)', async () => {
      const provisioner = loadProvisioner({ pullError: new Error('manifest unknown') });
      appDockerImageSizeStub.resolves(5e8);
      try {
        await provisioner.installComponent(makeComponent(null), { owner: 'owner1', allowLocalImageFallback: true });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('manifest unknown');
      }
      sinon.assert.notCalled(appDockerCreateStub);
    });

    it('never falls back on a fresh install (the flag is recreate-only)', async () => {
      const provisioner = loadProvisioner({ pullError: transientPullError() });
      appDockerImageSizeStub.resolves(5e8);
      try {
        await provisioner.installComponent(makeComponent(null), { owner: 'owner1' });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.registryErrorClass).to.equal('transient');
      }
      sinon.assert.notCalled(appDockerCreateStub);
    });
  });

  describe('a recreate from the image on this node (the move onto the identity)', () => {
    it('neither verifies nor pulls when the image is on the daemon', async () => {
      const provisioner = loadProvisioner({ pullError: new Error('registry must not be asked') });
      appDockerImageSizeStub.resolves(5e8);
      await provisioner.installComponent(makeComponent(null), { owner: 'owner1', localImageFirst: true });
      sinon.assert.calledOnce(appDockerCreateStub);
    });

    it('verifies and pulls as any install does when the image is not on the daemon', async () => {
      const provisioner = loadProvisioner({ pullError: new Error('manifest unknown') });
      appDockerImageSizeStub.resolves(0);
      try {
        await provisioner.installComponent(makeComponent(null), { owner: 'owner1', localImageFirst: true });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('manifest unknown');
      }
      sinon.assert.notCalled(appDockerCreateStub);
    });

    it('pulls first without the option, image on the daemon or not', async () => {
      const provisioner = loadProvisioner({ pullError: new Error('manifest unknown') });
      appDockerImageSizeStub.resolves(5e8);
      try {
        await provisioner.installComponent(makeComponent(null), { owner: 'owner1' });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('manifest unknown');
      }
      sinon.assert.notCalled(appDockerCreateStub);
    });
  });

  describe('owner guard', () => {
    const component = { identifier: 'web_testapp', appName: 'testapp' };

    it('rejects a real install missing the owner', async () => {
      const provisioner = loadProvisioner();
      let threw;
      try {
        await provisioner.installComponent(component, { createVolumes: false });
        threw = null;
      } catch (error) {
        threw = error;
      }
      expect(threw).to.be.an('error');
      expect(threw.message).to.contain('owner required');
    });
  });

  describe('provisions but does not start (the reconciler is the sole starter)', () => {
    it('never starts the container - the reconciler is the only starter', async () => {
      // The activeStandby / sync-before-start hold is now the reconciler's
      // controllerDesired -> awaitingController gate, and a plain install no longer
      // inline-starts at all: installComponent only provisions.
      // eslint-disable-next-line no-restricted-syntax
      for (const mode of ['activeStandby', 'syncFirst', 'sync', null]) {
        // eslint-disable-next-line no-await-in-loop
        await installWith(mode, true);
        expect(appDockerStartStub.called, `installer must not start (mode ${mode})`).to.be.false;
      }
    });

    it('still provisions the container substrate (volume + create) when it creates the volume', async () => {
      await installWith('sync', true);
      expect(createAppVolumeStub.calledOnce, 'volume provisioned').to.be.true;
      expect(appDockerStartStub.called, 'but never started by the installer').to.be.false;
    });

    it('builds no volume for a stateless component, even when asked to create one', async () => {
      // persistentStorage.sizeGb 0: there is nothing to fallocate or format,
      // and verifyAppVolumeMount would fail on a mountpoint deliberately never
      // created — so the whole block is skipped rather than made tolerant.
      const provisioner = loadProvisioner();
      await provisioner.installComponent(
        makeComponent('sync', { isStateless: true }),
        { owner: 'owner1', createVolumes: true },
      );
      expect(createAppVolumeStub.called, 'no volume for a stateless component').to.be.false;
    });

    it('rejects a component whose measured image exceeds its rootFs budget', async () => {
      const provisioner = loadProvisioner();
      appDockerImageSizeStub.resolves(5e9); // 5GB on disk, over the 2GB rootFs budget
      const component = makeComponent(null, { imageFitsRootFs: () => false });
      try {
        await provisioner.installComponent(component, { owner: 'owner1', createVolumes: true });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('rootFsGb');
        expect(err.message).to.include('exceeds');
        // registration measures the decompressed size now, so reaching this is
        // an invariant breach rather than the primary gate
        expect(err.message).to.include('should not have passed registration');
      }
      expect(appDockerStartStub.called).to.be.false;
    });
  });

  // installComponent is the only path to appDockerCreate, so writing the managed
  // cert here is what covers every recreate route (install, redeploy, update,
  // health recreate) - including a rebuild that wiped the volume.
  describe('backend-TLS certificate provisioning', () => {
    it('writes the cert into the materialized mount source before the container is created', async () => {
      const provisioner = loadProvisioner();
      await provisioner.installComponent(makeTlsComponent(), { owner: 'owner1', createVolumes: true });

      expect(provisionCertStub.calledOnce).to.be.true;
      const [appName, identity, tlsPaths] = provisionCertStub.firstCall.args;
      expect(appName).to.equal('syncholdapp');
      // the CA is the app's, keyed by its identity
      expect(identity).to.equal(IDENTITY);
      // exactly what the domain type reported - not a path the runtime rebuilt
      expect(tlsPaths).to.deep.equal(makeTlsComponent().backendTlsPaths());
      expect(provisionCertStub.calledBefore(appDockerCreateStub), 'cert written before create').to.be.true;
      // after the volume pass, which is what creates and chmods the mount source
      expect(createAppVolumeStub.calledBefore(provisionCertStub), 'cert written after the volume pass').to.be.true;
    });

    it('provisions nothing for a component that does not use platform-verified TLS', async () => {
      const provisioner = loadProvisioner();
      await provisioner.installComponent(makeComponent(null), { owner: 'owner1', createVolumes: true });

      expect(provisionCertStub.called).to.be.false;
      sinon.assert.calledOnce(appDockerCreateStub);
    });

    it('aborts the install when the cert cannot be issued, tagged as a node condition', async () => {
      // Starting anyway would leave a container that is up and serving nothing
      // while peers count it as a live instance - nothing would ever re-place it.
      // BACKEND_TLS_UNAVAILABLE tells appInstaller to defer rather than blame the app.
      const provisioner = loadProvisioner({ certError: new Error('signer unreachable') });
      try {
        await provisioner.installComponent(makeTlsComponent(), { owner: 'owner1', createVolumes: true });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.code).to.equal('BACKEND_TLS_UNAVAILABLE');
        expect(err.message).to.include('signer unreachable');
      }
      sinon.assert.notCalled(appDockerCreateStub);
    });

    it('fails outright - not as a node condition - when the TLS mount is missing', async () => {
      // Both answers come from the same resolved component, so disagreement is a
      // plumbing defect that should surface, not be retried forever.
      const provisioner = loadProvisioner();
      try {
        await provisioner.installComponent(
          makeTlsComponent({ backendTlsPaths: () => null }),
          { owner: 'owner1', createVolumes: true },
        );
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.code).to.equal(undefined);
        expect(err.message).to.include('platform TLS mount');
      }
      expect(provisionCertStub.called, 'nowhere to write it').to.be.false;
      sinon.assert.notCalled(appDockerCreateStub);
    });
  });

  // The redeploy/reconcile pre-flight: verify the new image is usable WITHOUT pulling
  // it, so a broken update can be rejected before the old version is torn down.
  describe('verifyComponentImage (redeploy pre-flight)', () => {
    it('returns the prepared pull config when the image verifies', async () => {
      const provisioner = loadProvisioner();
      const pullConfig = await provisioner.verifyComponentImage(makeComponent(null));
      expect(pullConfig).to.deep.include({ repoTag: 'nginx:latest', provider: 'docker.io' });
    });

    it('throws on an unusable image (so the pre-flight aborts before teardown)', async () => {
      const provisioner = proxyquire.load('../../ZelBack/src/services/appLifecycle/componentProvisioner', {
        '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
        '../dockerService': {},
        '../fluxNetworkHelper': {},
        '../upnpService': {},
        '../appRequirements/hwRequirements': { systemArchitecture: sinon.stub().resolves('amd64') },
        '../appSecurity/imageManager': { verifyRepository: sinon.stub().rejects(new Error('image not found in registry')) },
        '../utils/registryCredentialHelper': { getCredentials: sinon.stub().resolves(null) },
        './appVolumeService': {},
        './appSwapPoolService': {},
        '../utils/volumeService': {},
        '../telemetryIdentityService': {},
        '../appManagement/appsRuntimeState': { isCondemned: sinon.stub().resolves(false) },
        './pendingTeardownStore': { teardownOwedFor: sinon.stub().resolves(false) },
        '../appMesh/meshReconciler': {},
        util: { promisify: () => async () => 'pulled' },
      });
      let threw = false;
      try {
        await provisioner.verifyComponentImage(makeComponent(null));
      } catch (err) {
        threw = true;
        expect(err.message).to.include('image not found');
      }
      expect(threw, 'verifyComponentImage must throw on an unusable image').to.be.true;
    });
  });

  // A cancel/removal racing this install condemns its components + writes a durable
  // owed-teardown doc. These backstops abort the install AFTER the pull so it can never
  // build a volume/container the cancel's teardown is about to rm -rf.
  describe('cancel-during-install backstop', () => {
    async function tryInstall(provisioner) {
      let threw = null;
      try {
        await provisioner.installComponent(makeComponent('sync'), { owner: 'owner1', createVolumes: true });
      } catch (error) {
        threw = error;
      }
      return threw;
    }

    it('aborts after the pull (before the volume) when a teardown is owed for the app', async () => {
      const provisioner = loadProvisioner({ teardownOwed: true });
      const threw = await tryInstall(provisioner);
      expect(threw, 'install aborted').to.be.an('error');
      expect(threw.message).to.include('arrived mid-install');
      expect(createAppVolumeStub.called, 'no volume built for an app being torn down').to.be.false;
      expect(appDockerCreateStub.called, 'no container created').to.be.false;
    });

    it('aborts before container-create when a cancel condemns the app after the volume is built', async () => {
      // isCondemned: false at the post-pull check, true at the pre-create check — a cancel
      // landing in the createAppVolume -> appDockerCreate window.
      const isCondemnedStub = sinon.stub();
      isCondemnedStub.onCall(0).resolves(false);
      isCondemnedStub.resolves(true);
      const provisioner = loadProvisioner({ isCondemnedStub });
      const threw = await tryInstall(provisioner);
      expect(threw, 'install aborted').to.be.an('error');
      expect(threw.message).to.include('arrived mid-install');
      expect(createAppVolumeStub.called, 'the volume WAS built (post-pull check passed)').to.be.true;
      expect(appDockerCreateStub.called, 'but the container was NOT created').to.be.false;
    });
  });

  describe('host port management (redeploy port-delta support)', () => {
    it('openHostPorts opens each port on ufw and UPnP', async () => {
      const provisioner = loadProvisioner({ firewallActive: true, isUPNP: true });

      await provisioner.openHostPorts([8080, 9090], 'myapp', ['ufw', 'upnp']);

      expect(allowPortStub.calledWith(8080)).to.be.true;
      expect(allowPortStub.calledWith(9090)).to.be.true;
      expect(mapUpnpPortStub.calledWith(8080, 'Flux_App_myapp')).to.be.true;
      expect(mapUpnpPortStub.calledWith(9090, 'Flux_App_myapp')).to.be.true;
    });

    it('openHostPorts throws if a port fails to open', async () => {
      const provisioner = loadProvisioner({ firewallActive: true });
      allowPortStub.resolves({ status: false });

      let threw;
      try {
        await provisioner.openHostPorts([8080], 'myapp', ['ufw']);
      } catch (error) {
        threw = error;
      }
      expect(threw).to.be.an('error');
      expect(threw.message).to.include('FAILed to open');
    });

    it('installComponent opens the component ports on a normal install', async () => {
      const provisioner = loadProvisioner({ firewallActive: true });
      const component = makeComponent('none', { hostPorts: [8080] });

      await provisioner.installComponent(component, { owner: 'owner1', createVolumes: false });

      expect(allowPortStub.calledWith(8080), 'a normal install opens its ports').to.be.true;
    });

    it('installComponent leaves the ufw/UPnP rules untouched when skipPorts is set (redeploy)', async () => {
      const provisioner = loadProvisioner({ firewallActive: true, isUPNP: true });
      const component = makeComponent('none', { hostPorts: [8080] });

      await provisioner.installComponent(component, { owner: 'owner1', createVolumes: false, skipPorts: true });

      expect(allowPortStub.called, 'skipPorts must not touch ufw').to.be.false;
      expect(mapUpnpPortStub.called, 'skipPorts must not touch UPnP').to.be.false;
      // The container is still created — only the ufw/UPnP open is skipped.
      expect(appDockerCreateStub.called, 'the container is still provisioned').to.be.true;
    });
  });

  describe('mesh provisioning', () => {
    it('a mesh component is created with its presented env and the resolver chain', async () => {
      const provisioner = loadProvisioner({
        meshPrepareStub: sinon.stub().resolves({
          presentedIp: '10.127.0.1',
          env: ['FLUX_MESH_APP=syncholdapp', 'FLUX_MESH_SELF=web-aaaa1111', 'FLUX_MESH_SELF_IP=10.127.0.1'],
          dns: ['169.254.43.53', '8.8.8.8', '1.1.1.1'],
        }),
      });
      await provisioner.installComponent(makeComponent(null), { owner: 'owner1', extraEnv: ['X=1'] });
      const options = appDockerCreateStub.firstCall.args[1];
      expect(options.extraEnv).to.deep.equal([
        'X=1', 'FLUX_MESH_APP=syncholdapp', 'FLUX_MESH_SELF=web-aaaa1111', 'FLUX_MESH_SELF_IP=10.127.0.1',
      ]);
      expect(options.dns).to.deep.equal(['169.254.43.53', '8.8.8.8', '1.1.1.1']);
    });

    it('a non-mesh component is created without a dns override', async () => {
      const provisioner = loadProvisioner();
      await provisioner.installComponent(makeComponent(null), { owner: 'owner1' });
      const options = appDockerCreateStub.firstCall.args[1];
      expect(options).to.not.have.property('dns');
    });

    it('a mesh runtime that cannot be readied defers as a node condition', async () => {
      const provisioner = loadProvisioner({
        meshPrepareStub: sinon.stub().rejects(new Error('no transport port could be secured')),
      });
      let threw = null;
      try {
        await provisioner.installComponent(makeComponent(null), { owner: 'owner1' });
      } catch (error) {
        threw = error;
      }
      expect(threw).to.be.an('error');
      expect(threw.code).to.equal('MESH_UNAVAILABLE');
      expect(appDockerCreateStub.called, 'no container is created without the mesh runtime').to.be.false;
    });
  });
});
