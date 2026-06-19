const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('componentProvisioner tests', () => {
  let appDockerStartStub;
  let createAppVolumeStub;
  let appDockerImageSizeStub;

  // installComponent isolated behind its provisioning deps. noCallThru + every
  // require stubbed, so nothing touches a real service.
  function loadProvisioner() {
    appDockerStartStub = sinon.stub().resolves('ok');
    createAppVolumeStub = sinon.stub().resolves();
    appDockerImageSizeStub = sinon.stub().resolves(0);
    return proxyquire.load('../../ZelBack/src/services/appLifecycle/componentProvisioner', {
      config: { fluxapps: { maxImageSize: 10000000000 } },
      '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
      '../serviceHelper': { delay: sinon.stub().resolves(), axiosGet: sinon.stub().resolves({ data: {} }) },
      '../dockerService': {
        appDockerCreate: sinon.stub().resolves(),
        appDockerImageSize: appDockerImageSizeStub,
        appDockerStart: appDockerStartStub,
        dockerPullStream: sinon.stub(),
      },
      '../fluxNetworkHelper': { isFirewallActive: sinon.stub().resolves(false), allowPort: sinon.stub().resolves({ status: true }) },
      '../upnpService': { isUPNP: sinon.stub().returns(false), mapUpnpPort: sinon.stub().resolves(true) },
      '../appRequirements/hwRequirements': { systemArchitecture: sinon.stub().resolves('amd64') },
      '../utils/imageVerifier': { ImageVerifier: sinon.stub().returns({ addCredentials: sinon.stub(), verifyImage: sinon.stub().resolves(), throwIfError: sinon.stub(), supported: true, provider: 'docker.io' }) },
      '../utils/registryCredentialHelper': { getCredentials: sinon.stub().resolves(null) },
      './appVolumeService': { createAppVolume: createAppVolumeStub },
      './appSwapPoolService': { reconcile: sinon.stub().resolves() },
      '../utils/volumeService': { verifyAppVolumeMount: sinon.stub().resolves() },
      '../telemetryIdentityService': { onComponentCreated: sinon.stub().resolves() },
      '../appManagement/appInspector': { startAppMonitoring: sinon.stub() },
      util: { promisify: () => async () => 'pulled' },
    });
  }

  function makeComponent(syncMode, overrides = {}) {
    return {
      name: 'web',
      appName: 'syncholdapp',
      identifier: 'web_syncholdapp',
      image: 'nginx:latest',
      imageAuth: null,
      hostPorts: [],
      rootFsGb: 2,
      // Fit decision delegated to the component (real logic tested in flux-spec).
      imageFitsRootFs: () => true,
      hasActiveStandbySyncthing: () => syncMode === 'activeStandby',
      requiresSyncBeforeStart: () => syncMode === 'syncFirst',
      ...overrides,
    };
  }

  async function installWith(syncMode, createVolumes) {
    const provisioner = loadProvisioner();
    await provisioner.installComponent(makeComponent(syncMode), { owner: 'owner1', createVolumes });
  }

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

    it('exempts test installs from the owner requirement', async () => {
      // A test install carries no shutdown plan, so it may proceed without an
      // owner; it should get past the guard (and fail later, if at all, on the
      // install machinery rather than the guard).
      const provisioner = loadProvisioner();
      let guardError = null;
      try {
        await provisioner.installComponent(component, { test: true });
      } catch (error) {
        if (error.message.includes('owner required')) guardError = error;
      }
      expect(guardError).to.be.null;
    });
  });

  describe('provisions but does not start (the reconciler is the sole starter)', () => {
    it('never starts the container on a real install, for any sync mode', async () => {
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

    it('still provisions the container substrate (volume + create) on a hard install', async () => {
      await installWith('sync', true);
      expect(createAppVolumeStub.calledOnce, 'volume provisioned').to.be.true;
      expect(appDockerStartStub.called, 'but never started by the installer').to.be.false;
    });

    it('starts inline on a test install (synchronous, fail-fast, no handoff)', async () => {
      const provisioner = loadProvisioner();
      await provisioner.installComponent(makeComponent(null), { test: true });
      expect(appDockerStartStub.calledOnceWith('web_syncholdapp')).to.be.true;
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
      }
      expect(appDockerStartStub.called).to.be.false;
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
        config: { fluxapps: { maxImageSize: 10000000000 } },
        '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
        '../serviceHelper': { delay: sinon.stub().resolves() },
        '../dockerService': {},
        '../fluxNetworkHelper': {},
        '../upnpService': {},
        '../appRequirements/hwRequirements': { systemArchitecture: sinon.stub().resolves('amd64') },
        '../utils/imageVerifier': { ImageVerifier: sinon.stub().returns({ addCredentials: sinon.stub(), verifyImage: sinon.stub().resolves(), throwIfError: sinon.stub().throws(new Error('image not found in registry')), supported: true, provider: 'docker.io' }) },
        '../utils/registryCredentialHelper': { getCredentials: sinon.stub().resolves(null) },
        './appVolumeService': {},
        './appSwapPoolService': {},
        '../utils/volumeService': {},
        '../telemetryIdentityService': {},
        '../appManagement/appInspector': {},
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
});
