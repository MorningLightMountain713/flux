'use strict';

// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const sinon = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();
// Real registry singleton - un-stubbed in proxyquire, so the module under test
// and the test drive the same instance.
const operationRegistry = require('../../ZelBack/src/services/utils/operationRegistry');
// The spec library is real here, not stubbed — see tests/unit/fixtures/fluxSpec.js.
// Everything this service reads off a deployment (appName, componentEntries, and
// per-component identifier / image / imageAuth / autoUpdate, plus allImages after
// a redeploy) is answered by the REAL DeploymentSpec the real deploymentProvider
// would build for the app on this node, not by a literal. The double this
// replaced was free to invent an identifier, to answer '' for a credential it
// never had, and — the shape that matters — to hand the post-redeploy image
// cache an empty image list.
const {
  loadSpecLibrary, v1Spec, v8Spec, v9Spec, V8_SUBMISSION, V9_SUBMISSION,
} = require('./fixtures/fluxSpec');

// What deploymentProvider passes as the apps root; only volume paths derive from
// it, and nothing in this service reads one.
const APPS_FOLDER = '/dat/var/lib/fluxos/flux-apps';

// A digest the service can actually parse. getLocalImageDigest matches
// /@(sha256:[a-f0-9]+)$/, so a readable-looking placeholder like 'sha256:same'
// is silently unparseable ('m' is not hex) and every component is skipped before
// the registry is ever asked — a cycle test can pass having polled nothing.
const SAME_DIGEST = 'sha256:5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a';

let flux;

// Create all stubs upfront
const dockerServiceStub = {
  dockerListContainers: sinon.stub(),
  dockerListImages: sinon.stub(),
  dockerContainerInspect: sinon.stub(),
  getDockerContainerHandle: sinon.stub(),
  getAppIdentifier: sinon.stub(),
};

const deploymentProviderStub = {
  listInstalledDeployments: sinon.stub(),
  getInstalledDeployment: sinon.stub(),
};

const imageCacheServiceStub = {
  reconcilePinnedImage: sinon.stub(),
};

const imageReaperStub = {
  pruneUnusedImages: sinon.stub(),
};


const appOperationsStub = {
  redeployApplication: sinon.stub(),
};

const registryCredentialHelperStub = {
  getCredentials: sinon.stub(),
};

const serviceHelperStub = {
  delay: sinon.stub().resolves(),
};

const logStub = {
  info: sinon.stub(),
  warn: sinon.stub(),
  error: sinon.stub(),
  debug: sinon.stub(),
};

// Mock ImageVerifier class — the registry HTTP client, which stays stubbed.
let mockVerifierParseError = false;
let mockVerifierError = false;
let mockVerifierErrorDetail = '';
let mockVerifierErrorMeta = null;
let mockDigestToReturn = null;
// Every verifier the service constructed, so a test can read back the image
// string it was actually handed.
const constructedVerifiers = [];

class MockImageVerifier {
  constructor(repotag, options) {
    this.repotag = repotag;
    this.options = options;
    this.parseError = mockVerifierParseError;
    this.error = mockVerifierError;
    this.errorDetail = mockVerifierErrorDetail;
    this.errorMeta = mockVerifierErrorMeta;
    constructedVerifiers.push(this);
  }

  async fetchManifestDigestOnly() {
    if (this.parseError || this.error) return null;
    return mockDigestToReturn;
  }
}

// Load module with stubs using noCallThru
const imageUpdateService = proxyquire('../../ZelBack/src/services/imageUpdateService', {
  '../lib/log': logStub,
  './dockerService': dockerServiceStub,
  './appRuntime/deploymentProvider': deploymentProviderStub,
  './appLifecycle/appOperations': appOperationsStub,
  './appLifecycle/imageCacheService': imageCacheServiceStub,
  './appLifecycle/imageReaper': imageReaperStub,
  './utils/registryCredentialHelper': registryCredentialHelperStub,
  './utils/imageVerifier': { ImageVerifier: MockImageVerifier },
  './serviceHelper': serviceHelperStub,
});

describe('imageUpdateService tests', () => {
  before(async () => {
    flux = await loadSpecLibrary();
  });

  /**
   * The REAL DeploymentSpec deploymentProvider would build for this spec on this
   * node — the loose (unreplicated) identity, which is what an ordinary app has.
   */
  function deploymentFor(spec) {
    return flux.DeploymentSpec.fromSpec(spec, APPS_FOLDER, { replica: null });
  }

  /** A legacy compose entry off the shared submission blob. */
  function legacyComponent(overrides = {}) {
    return { ...V8_SUBMISSION.compose[0], ...overrides };
  }

  /**
   * GUARD. The digest poll is driven by the deployment's OWN identifiers and
   * images. dockerContainerInspect is handed the bare identifier (it prefixes
   * internally) and the registry verifier is constructed on the component's
   * image — neither is re-derived from the app name here, and an empty or
   * invented list would mean the poll examined something other than the app.
   */
  function expectPolledFrom(deployment, componentNames) {
    const entries = deployment.componentEntries()
      .filter(([name]) => componentNames.includes(name));
    expect(entries, 'no component was selected — the guard would assert nothing')
      .to.not.be.empty;
    expect(dockerServiceStub.dockerContainerInspect.getCalls().map((c) => c.args[0]))
      .to.deep.equal(entries.map(([, comp]) => comp.identifier));
    expect(constructedVerifiers.map((v) => v.repotag))
      .to.deep.equal(entries.map(([, comp]) => comp.image));
  }

  beforeEach(() => {
    // Reset all stubs
    dockerServiceStub.dockerListContainers.reset();
    dockerServiceStub.dockerListImages.reset();
    dockerServiceStub.dockerContainerInspect.reset();
    dockerServiceStub.getDockerContainerHandle.reset();
    dockerServiceStub.getAppIdentifier.reset();

    deploymentProviderStub.listInstalledDeployments.reset();
    deploymentProviderStub.listInstalledDeployments.resolves([]);
    deploymentProviderStub.getInstalledDeployment.reset();
    deploymentProviderStub.getInstalledDeployment.resolves(null);
    imageCacheServiceStub.reconcilePinnedImage.reset();
    imageCacheServiceStub.reconcilePinnedImage.resolves();
    imageReaperStub.pruneUnusedImages.reset();
    imageReaperStub.pruneUnusedImages.resolves();

    appOperationsStub.redeployApplication.reset();

    registryCredentialHelperStub.getCredentials.reset();

    serviceHelperStub.delay.reset();

    logStub.info.reset();
    logStub.warn.reset();
    logStub.error.reset();
    logStub.debug.reset();

    operationRegistry.clear();

    // Reset mock verifier state
    mockVerifierParseError = false;
    mockVerifierError = false;
    mockVerifierErrorDetail = '';
    mockVerifierErrorMeta = null;
    mockDigestToReturn = null;
    constructedVerifiers.length = 0;
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('removeWatchtowerContainer tests', () => {
    it('should return false when no watchtower container exists', async () => {
      dockerServiceStub.dockerListContainers.resolves([
        { Names: ['/fluxMyApp'], Id: 'abc123', State: 'running' },
      ]);

      const result = await imageUpdateService.removeWatchtowerContainer();

      expect(result).to.equal(false);
      sinon.assert.calledOnce(dockerServiceStub.dockerListContainers);
      sinon.assert.calledWith(dockerServiceStub.dockerListContainers, true);
    });

    it('should stop and remove watchtower container when found running', async () => {
      const mockContainer = {
        stop: sinon.stub().resolves(),
        remove: sinon.stub().resolves(),
      };

      dockerServiceStub.dockerListContainers.resolves([
        { Names: ['/flux_watchtower'], Id: 'watchtower123', State: 'running' },
      ]);
      dockerServiceStub.getDockerContainerHandle.returns(mockContainer);
      dockerServiceStub.dockerListImages.resolves([]);

      const result = await imageUpdateService.removeWatchtowerContainer();

      expect(result).to.equal(true);
      sinon.assert.calledOnce(mockContainer.stop);
      sinon.assert.calledOnce(mockContainer.remove);
    });

    it('should remove watchtower container when found stopped', async () => {
      const mockContainer = {
        stop: sinon.stub().resolves(),
        remove: sinon.stub().resolves(),
      };

      dockerServiceStub.dockerListContainers.resolves([
        { Names: ['/flux_watchtower'], Id: 'watchtower123', State: 'exited' },
      ]);
      dockerServiceStub.getDockerContainerHandle.returns(mockContainer);
      dockerServiceStub.dockerListImages.resolves([]);

      const result = await imageUpdateService.removeWatchtowerContainer();

      expect(result).to.equal(true);
      sinon.assert.notCalled(mockContainer.stop);
      sinon.assert.calledOnce(mockContainer.remove);
    });

    it('should force remove container when stop fails', async () => {
      const mockContainer = {
        stop: sinon.stub().rejects(new Error('Container already stopped')),
        remove: sinon.stub().resolves(),
      };

      dockerServiceStub.dockerListContainers.resolves([
        { Names: ['/flux_watchtower'], Id: 'watchtower123', State: 'running' },
      ]);
      dockerServiceStub.getDockerContainerHandle.returns(mockContainer);
      dockerServiceStub.dockerListImages.resolves([]);

      const result = await imageUpdateService.removeWatchtowerContainer();

      expect(result).to.equal(true);
      sinon.assert.calledWith(mockContainer.remove, { force: true });
    });

    it('should return false when dockerListContainers throws error', async () => {
      dockerServiceStub.dockerListContainers.rejects(new Error('Docker not available'));

      const result = await imageUpdateService.removeWatchtowerContainer();

      expect(result).to.equal(false);
      sinon.assert.calledOnce(logStub.error);
    });
  });

  describe('getLocalImageDigest tests', () => {
    it('should return digest when container and image exist', async () => {
      const containerInfo = { Image: 'sha256:imageId123' };
      const images = [
        {
          Id: 'sha256:imageId123',
          RepoDigests: ['nginx@sha256:abc123def456'],
        },
      ];

      dockerServiceStub.dockerContainerInspect.resolves(containerInfo);
      dockerServiceStub.dockerListImages.resolves(images);

      const result = await imageUpdateService.getLocalImageDigest('fluxMyApp');

      expect(result).to.equal('sha256:abc123def456');
    });

    it('should return null when container not found', async () => {
      dockerServiceStub.dockerContainerInspect.rejects(new Error('Container not found'));

      const result = await imageUpdateService.getLocalImageDigest('fluxMissingApp');

      expect(result).to.equal(null);
    });

    it('should return null when container has no image', async () => {
      dockerServiceStub.dockerContainerInspect.resolves({ Image: null });

      const result = await imageUpdateService.getLocalImageDigest('fluxMyApp');

      expect(result).to.equal(null);
    });

    it('should return null when image not found in local images', async () => {
      const containerInfo = { Image: 'sha256:imageId123' };
      const images = [
        { Id: 'sha256:differentImage', RepoDigests: ['other@sha256:xyz'] },
      ];

      dockerServiceStub.dockerContainerInspect.resolves(containerInfo);
      dockerServiceStub.dockerListImages.resolves(images);

      const result = await imageUpdateService.getLocalImageDigest('fluxMyApp');

      expect(result).to.equal(null);
    });

    it('should return null when RepoDigests is empty', async () => {
      const containerInfo = { Image: 'sha256:imageId123' };
      const images = [
        { Id: 'sha256:imageId123', RepoDigests: [] },
      ];

      dockerServiceStub.dockerContainerInspect.resolves(containerInfo);
      dockerServiceStub.dockerListImages.resolves(images);

      const result = await imageUpdateService.getLocalImageDigest('fluxMyApp');

      expect(result).to.equal(null);
    });
  });

  describe('getRemoteManifestDigest tests', () => {
    it('should return digest for public image without auth', async () => {
      mockDigestToReturn = 'sha256:remote123';

      const result = await imageUpdateService.getRemoteManifestDigest('nginx:latest', null, 'testApp');

      expect(result).to.deep.equal({ error: null, digest: 'sha256:remote123' });
    });

    it('should return null when image tag parse fails', async () => {
      mockVerifierParseError = true;
      mockVerifierErrorDetail = 'Invalid tag';

      const result = await imageUpdateService.getRemoteManifestDigest('invalid tag', null, 'testApp');

      expect(result).to.deep.equal({ error: 'parse_error', digest: null });
    });

    it('should get credentials for authenticated repos', async () => {
      registryCredentialHelperStub.getCredentials.resolves({
        username: 'user',
        password: 'pass',
      });
      mockDigestToReturn = 'sha256:auth123';

      const result = await imageUpdateService.getRemoteManifestDigest(
        'private/image:v1',
        'encrypted_auth',
        'privateApp',
      );

      expect(result).to.deep.equal({ error: null, digest: 'sha256:auth123' });
      sinon.assert.calledOnce(registryCredentialHelperStub.getCredentials);
      sinon.assert.calledWith(
        registryCredentialHelperStub.getCredentials,
        'private/image:v1',
        'encrypted_auth',
        'privateApp',
      );
    });

    it('should return null when credentials fail', async () => {
      registryCredentialHelperStub.getCredentials.rejects(new Error('Decryption failed'));

      const result = await imageUpdateService.getRemoteManifestDigest(
        'private/image:v1',
        'bad_auth',
        'privateApp',
      );

      expect(result).to.deep.equal({ error: 'credentials_failed', digest: null });
    });
  });

  describe('checkAppForUpdates tests', () => {
    beforeEach(() => {
      dockerServiceStub.getAppIdentifier.callsFake((name) => `flux${name}`);
    });

    it('should detect update needed for v1-v3 app', async () => {
      // A real v1 spec: the oldest stored form, one flat component whose
      // container identifier IS the app name — nothing else produces that shape.
      const deployment = deploymentFor(await v1Spec({ name: 'TestApp' }));
      expect(deployment.componentEntries().map(([name, comp]) => [name, comp.identifier]))
        .to.deep.equal([['TestApp', 'TestApp']]);

      const localDigest = 'sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abcd';
      const remoteDigest = 'sha256:fed987cba654fed987cba654fed987cba654fed987cba654fed987cba654fedc';

      dockerServiceStub.dockerContainerInspect.resolves({ Image: 'sha256:local123' });
      dockerServiceStub.dockerListImages.resolves([
        { Id: 'sha256:local123', RepoDigests: [`nginx@${localDigest}`] },
      ]);

      mockDigestToReturn = remoteDigest;

      const result = await imageUpdateService.checkAppForUpdates(deployment);

      expect(result.needsUpdate).to.equal(true);
      expect(result.components).to.have.lengthOf(1);
      expect(result.components[0].name).to.equal('TestApp');
      expect(result.components[0].repotag).to.equal('nginx:latest');
      expect(result.components[0].localDigest).to.equal(localDigest);
      expect(result.components[0].remoteDigest).to.equal(remoteDigest);
      expectPolledFrom(deployment, ['TestApp']);
    });

    it('should not detect update when digests match for v1-v3 app', async () => {
      const deployment = deploymentFor(await v1Spec({ name: 'TestApp' }));

      const sameDigest = 'sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abcd';

      dockerServiceStub.dockerContainerInspect.resolves({ Image: 'sha256:local123' });
      dockerServiceStub.dockerListImages.resolves([
        { Id: 'sha256:local123', RepoDigests: [`nginx@${sameDigest}`] },
      ]);

      mockDigestToReturn = sameDigest;

      const result = await imageUpdateService.checkAppForUpdates(deployment);

      expect(result.needsUpdate).to.equal(false);
      expect(result.components).to.have.lengthOf(0);
    });

    it('inspects by the bare identifier - dockerContainerInspect prefixes internally', async () => {
      const deployment = deploymentFor(await v8Spec({
        name: 'ComposedApp',
        compose: [legacyComponent({ name: 'web', repotag: 'nginx:latest' })],
      }));
      const digest = 'sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abcd';
      dockerServiceStub.dockerContainerInspect.resolves({ Image: 'sha256:webImage' });
      dockerServiceStub.dockerListImages.resolves([
        { Id: 'sha256:webImage', RepoDigests: [`nginx@${digest}`] },
      ]);
      mockDigestToReturn = digest;

      await imageUpdateService.checkAppForUpdates(deployment);

      // The identifier is the class's own (component_appName), not a name the
      // test invented and not the fluxXxx form getAppIdentifier would return.
      sinon.assert.calledWith(dockerServiceStub.dockerContainerInspect, 'web_ComposedApp');
      expectPolledFrom(deployment, ['web']);
    });

    it('should check all components for v4+ compose app', async () => {
      const deployment = deploymentFor(await v8Spec({
        name: 'ComposedApp',
        compose: [
          legacyComponent({
            name: 'web', repotag: 'nginx:latest', ports: [31443], containerPorts: [443],
          }),
          legacyComponent({
            name: 'api', repotag: 'node:18', ports: [31444], containerPorts: [8080],
          }),
        ],
      }));

      const webLocalDigest = 'sha256:111111111111111111111111111111111111111111111111111111111111aaaa';
      const webRemoteDigest = 'sha256:222222222222222222222222222222222222222222222222222222222222bbbb';
      const apiDigest = 'sha256:333333333333333333333333333333333333333333333333333333333333cccc';

      dockerServiceStub.dockerContainerInspect
        .onFirstCall().resolves({ Image: 'sha256:webImage' })
        .onSecondCall().resolves({ Image: 'sha256:apiImage' });

      dockerServiceStub.dockerListImages.resolves([
        { Id: 'sha256:webImage', RepoDigests: [`nginx@${webLocalDigest}`] },
        { Id: 'sha256:apiImage', RepoDigests: [`node@${apiDigest}`] },
      ]);

      mockDigestToReturn = webRemoteDigest;

      const result = await imageUpdateService.checkAppForUpdates(deployment);

      expect(result.needsUpdate).to.equal(true);
      expect(result.components.length).to.be.at.least(1);
      expect(result.components[0].name).to.equal('web');
      // Both components were reached, each by its own identifier and image.
      expectPolledFrom(deployment, ['web', 'api']);
    });

    it('should skip component when local digest cannot be retrieved', async () => {
      const deployment = deploymentFor(await v1Spec({ name: 'TestApp' }));

      dockerServiceStub.dockerContainerInspect.rejects(new Error('Container not found'));

      const result = await imageUpdateService.checkAppForUpdates(deployment);

      expect(result.needsUpdate).to.equal(false);
    });

    it('does not poll or update a component pinned with autoUpdate false even when a newer image exists', async () => {
      // autoUpdate is a v9 field — no legacy component can express the pin, so
      // this has to be a real v9 spec for the opt-out to exist at all.
      const deployment = deploymentFor(await v9Spec({
        components: {
          web: { ...V9_SUBMISSION.components.web, autoUpdate: false },
        },
      }));
      expect(deployment.componentEntries()[0][1].autoUpdate).to.equal(false);

      const localDigest = 'sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abcd';
      const remoteDigest = 'sha256:fed987cba654fed987cba654fed987cba654fed987cba654fed987cba654fedc';

      dockerServiceStub.dockerContainerInspect.resolves({ Image: 'sha256:local123' });
      dockerServiceStub.dockerListImages.resolves([
        { Id: 'sha256:local123', RepoDigests: [`nginx@${localDigest}`] },
      ]);
      mockDigestToReturn = remoteDigest;

      const result = await imageUpdateService.checkAppForUpdates(deployment);

      expect(result.needsUpdate).to.equal(false);
      expect(result.components).to.have.lengthOf(0);
      // pinned: never even polled the local digest
      expect(dockerServiceStub.dockerContainerInspect.called).to.equal(false);
    });

    it('polls an unpinned v9 component - autoUpdate defaults to true on the real class', async () => {
      const deployment = deploymentFor(await v9Spec());
      expect(deployment.componentEntries()[0][1].autoUpdate).to.equal(true);

      const digest = 'sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abcd';
      dockerServiceStub.dockerContainerInspect.resolves({ Image: 'sha256:local123' });
      dockerServiceStub.dockerListImages.resolves([
        { Id: 'sha256:local123', RepoDigests: [`nginx@${digest}`] },
      ]);
      mockDigestToReturn = digest;

      await imageUpdateService.checkAppForUpdates(deployment);

      expectPolledFrom(deployment, ['web']);
    });

    it('carries the component real imageAuth into the registry credential lookup', async () => {
      const deployment = deploymentFor(await v8Spec({
        name: 'PrivateApp',
        compose: [legacyComponent({
          name: 'web', repotag: 'private/image:v1', repoauth: 'encrypted_auth_blob',
        })],
      }));
      const [, comp] = deployment.componentEntries()[0];
      expect(comp.imageAuth).to.equal('encrypted_auth_blob');

      const digest = 'sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abcd';
      dockerServiceStub.dockerContainerInspect.resolves({ Image: 'sha256:local123' });
      dockerServiceStub.dockerListImages.resolves([
        { Id: 'sha256:local123', RepoDigests: [`private/image@${digest}`] },
      ]);
      registryCredentialHelperStub.getCredentials.resolves({ username: 'u', password: 'p' });
      mockDigestToReturn = digest;

      await imageUpdateService.checkAppForUpdates(deployment);

      // The credential lookup is keyed on the component's own image and its own
      // credential blob, and the app's own name — all read off the real class.
      sinon.assert.calledOnceWithExactly(
        registryCredentialHelperStub.getCredentials,
        comp.image,
        comp.imageAuth,
        deployment.appName,
      );
      expect(constructedVerifiers[0].options.credentials)
        .to.deep.equal({ username: 'u', password: 'p' });
    });
  });

  describe('triggerAppUpdate tests', () => {
    it('should call redeployApplication when no operation in progress', async () => {
      appOperationsStub.redeployApplication.resolves();
      // After the redeploy the service re-reconciles the app's pinned images,
      // and the list it reconciles is the deployment's OWN — an empty one
      // silently leaves every pin pointing at the superseded digest.
      const deployment = deploymentFor(await v8Spec({
        name: 'TestApp',
        compose: [
          legacyComponent({
            name: 'web', repotag: 'nginx:latest', ports: [31443], containerPorts: [443],
          }),
          legacyComponent({
            name: 'api', repotag: 'node:18', ports: [31444], containerPorts: [8080],
          }),
        ],
      }));
      deploymentProviderStub.getInstalledDeployment.resolves(deployment);

      const result = await imageUpdateService.triggerAppUpdate('TestApp');

      expect(result).to.equal(true);
      sinon.assert.calledOnce(appOperationsStub.redeployApplication);
      sinon.assert.calledWith(appOperationsStub.redeployApplication, 'TestApp', { createVolumes: false });

      const reconciled = imageCacheServiceStub.reconcilePinnedImage.getCalls()
        .map((call) => call.args[0]);
      expect(reconciled, 'the image cache was reconciled against an empty list — it re-pinned nothing')
        .to.not.be.empty;
      expect(reconciled).to.deep.equal(deployment.allImages());
      expect(reconciled).to.deep.equal(['nginx:latest', 'node:18']);
      sinon.assert.calledOnce(imageReaperStub.pruneUnusedImages);
    });

    it('should return false when the app holds an operation lease', async () => {
      operationRegistry.acquire('TestApp', 'install', 'test');

      const result = await imageUpdateService.triggerAppUpdate('TestApp');

      expect(result).to.equal(false);
      sinon.assert.notCalled(appOperationsStub.redeployApplication);
    });

    it('should still redeploy when a DIFFERENT app holds a lease (per-app, no node-wide freeze)', async () => {
      operationRegistry.acquire('OtherApp', 'install', 'test');
      appOperationsStub.redeployApplication.resolves();

      const result = await imageUpdateService.triggerAppUpdate('TestApp');

      expect(result).to.equal(true);
      sinon.assert.calledOnce(appOperationsStub.redeployApplication);
    });

    it('should return false and log error when redeployApplication throws', async () => {
      appOperationsStub.redeployApplication.rejects(new Error('Redeploy failed'));

      const result = await imageUpdateService.triggerAppUpdate('TestApp');

      expect(result).to.equal(false);
      sinon.assert.calledOnce(logStub.error);
    });
  });

  describe('checkForImageUpdates tests', () => {
    it('runs the check even while another operation is in progress (no node-wide freeze)', async () => {
      operationRegistry.acquire('SomeBusyApp', 'install', 'test');

      await imageUpdateService.checkForImageUpdates();

      // The cycle is no longer gated node-wide; it proceeds and lists deployments.
      sinon.assert.calledOnce(deploymentProviderStub.listInstalledDeployments);
    });

    async function singleComponentDeployment(appName, repotag) {
      return deploymentFor(await v8Spec({
        name: appName,
        compose: [legacyComponent({ name: appName, repotag })],
      }));
    }

    it('should process all installed apps', async () => {
      const app1 = await singleComponentDeployment('App1', 'nginx:latest');
      const app2 = await singleComponentDeployment('App2', 'redis:latest');
      deploymentProviderStub.listInstalledDeployments.resolves([app1, app2]);

      dockerServiceStub.getAppIdentifier.callsFake((name) => `flux${name}`);
      dockerServiceStub.dockerContainerInspect.resolves({ Image: 'sha256:img' });
      dockerServiceStub.dockerListImages.resolves([
        { Id: 'sha256:img', RepoDigests: [`repo@${SAME_DIGEST}`] },
      ]);
      mockDigestToReturn = SAME_DIGEST;

      await imageUpdateService.checkForImageUpdates();

      sinon.assert.calledOnce(deploymentProviderStub.listInstalledDeployments);
      sinon.assert.calledWith(logStub.info, sinon.match(/Checking 2 installed apps/));
      // Each app was polled through its own identifiers and images.
      expect(dockerServiceStub.dockerContainerInspect.getCalls().map((c) => c.args[0]))
        .to.deep.equal(['App1_App1', 'App2_App2']);
      expect(constructedVerifiers.map((v) => v.repotag))
        .to.deep.equal([...app1.allImages(), ...app2.allImages()]);
      // no update: digests matched, so nothing was redeployed
      sinon.assert.notCalled(appOperationsStub.redeployApplication);
    });

    it('does not abort the cycle when an operation starts mid-check (processes every app)', async () => {
      deploymentProviderStub.listInstalledDeployments.resolves([
        await singleComponentDeployment('App1', 'nginx:latest'),
        await singleComponentDeployment('App2', 'redis:latest'),
      ]);

      dockerServiceStub.getAppIdentifier.callsFake((name) => `flux${name}`);

      let callCount = 0;
      dockerServiceStub.dockerContainerInspect.callsFake(() => {
        callCount += 1;
        if (callCount === 1) {
          // An operation starting on another app no longer aborts the cycle.
          operationRegistry.acquire('OtherApp', 'install', 'test');
        }
        return Promise.resolve({ Image: 'sha256:img' });
      });

      dockerServiceStub.dockerListImages.resolves([
        { Id: 'sha256:img', RepoDigests: [`repo@${SAME_DIGEST}`] },
      ]);
      mockDigestToReturn = SAME_DIGEST;

      await imageUpdateService.checkForImageUpdates();

      // Both apps inspected - the loop ran to completion, no early break.
      expect(callCount).to.equal(2);
    });
  });

  describe('startImageUpdateService and stopImageUpdateService tests', () => {
    let clock;

    beforeEach(() => {
      // Specs are built before the clock is faked elsewhere in this file; nothing
      // in this block builds one, so installing fake timers here is safe.
      clock = sinon.useFakeTimers();
    });

    afterEach(() => {
      clock.restore();
      imageUpdateService.stopImageUpdateService();
    });

    it('should start the service and log startup message', () => {
      imageUpdateService.startImageUpdateService();

      sinon.assert.calledWith(logStub.info, 'Starting native image update service');
      sinon.assert.calledWith(logStub.info, sinon.match(/Image update service started/));
    });

    it('should run initial check after delay', async () => {
      imageUpdateService.startImageUpdateService();

      // Initial delay is random between 10-30 minutes, so advance by 30 minutes to ensure callback runs
      await clock.tickAsync(30 * 60 * 1000);

      sinon.assert.calledWith(logStub.info, 'Running initial image update check');
      sinon.assert.calledOnce(deploymentProviderStub.listInstalledDeployments);
    });

    it('should stop the service and clear interval', () => {
      imageUpdateService.startImageUpdateService();
      imageUpdateService.stopImageUpdateService();

      sinon.assert.calledWith(logStub.info, 'Image update service stopped');
    });

    // A second start must replace the first entirely. Clearing only the
    // interval left the first initial-delay timeout alive: it fired, started an
    // interval, and the second timeout then overwrote the slot — orphaning the
    // first interval, which nothing could clear again. Two checks per period,
    // forever. The old test here asserted only that stop() logged a line.
    it('a second start leaves exactly one schedule, and stop clears all of it', async () => {
      imageUpdateService.startImageUpdateService();
      imageUpdateService.startImageUpdateService();
      // Past the longest initial delay: every surviving timeout has fired and
      // started its interval.
      await clock.tickAsync(30 * 60 * 1000);

      imageUpdateService.stopImageUpdateService();
      expect(clock.countTimers(), 'an interval survived stop').to.equal(0);
    });

    // The same slot raced from the other side: stop() during the initial check
    // found no timeout to clear — it had already fired — and the check then
    // installed an interval on a service that had been stopped.
    it('a stop during the initial check leaves no interval behind', async () => {
      let finishCheck;
      deploymentProviderStub.listInstalledDeployments
        .returns(new Promise((resolve) => { finishCheck = resolve; }));
      imageUpdateService.startImageUpdateService();
      // The initial check is now in flight, awaiting the deployments.
      await clock.tickAsync(30 * 60 * 1000);

      imageUpdateService.stopImageUpdateService();
      finishCheck([]);
      await clock.tickAsync(0);
      expect(clock.countTimers(), 'the stopped service started an interval').to.equal(0);
    });
  });
});
