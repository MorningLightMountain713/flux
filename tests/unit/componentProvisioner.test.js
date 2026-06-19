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

  describe('install-time start hold for syncing components', () => {
    it('holds an activeStandby component on a hard install', async () => {
      await installWith('activeStandby', true);
      expect(appDockerStartStub.called).to.be.false;
    });

    it('holds an activeStandby component on a soft install', async () => {
      await installWith('activeStandby', false);
      expect(appDockerStartStub.called).to.be.false;
    });

    it('holds a sync-before-start component on a hard install (fresh empty volume)', async () => {
      await installWith('syncFirst', true);
      expect(createAppVolumeStub.calledOnce).to.be.true;
      expect(appDockerStartStub.called).to.be.false;
    });

    it('starts a sync-before-start component on a soft install (volume already has data)', async () => {
      await installWith('syncFirst', false);
      expect(appDockerStartStub.calledOnce).to.be.true;
    });

    it('starts a plain-sync component even on a hard install', async () => {
      await installWith('sync', true);
      expect(appDockerStartStub.calledOnce).to.be.true;
    });

    it('starts a component without sync on a hard install', async () => {
      await installWith(null, true);
      expect(appDockerStartStub.calledOnce).to.be.true;
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
});
