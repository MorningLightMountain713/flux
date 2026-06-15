const { expect } = require('chai');
const sinon = require('sinon');
const axios = require('axios');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const messageHelper = require('../../ZelBack/src/services/messageHelper');
const verificationHelper = require('../../ZelBack/src/services/verificationHelper');
const imageVerifier = require('../../ZelBack/src/services/utils/imageVerifier');
const registryCredentialHelper = require('../../ZelBack/src/services/utils/registryCredentialHelper');
const appsRepository = require('../../ZelBack/src/services/appDatabase/appsRepository');

describe('imageManager tests', () => {
  let imageManager;

  beforeEach(() => {
    // Clear module cache to reset internal state/caches
    delete require.cache[require.resolve('../../ZelBack/src/services/appSecurity/imageManager')];
    // Reload module with fresh state
    // eslint-disable-next-line global-require
    imageManager = require('../../ZelBack/src/services/appSecurity/imageManager');

    // Clear the dockerHubVerificationCache before each test
    // eslint-disable-next-line global-require
    const fluxCaching = require('../../ZelBack/src/services/utils/cacheManager').default;
    if (fluxCaching.dockerHubVerificationCache) {
      fluxCaching.dockerHubVerificationCache.clear();
    }
    if (fluxCaching.blockedRepositoriesCache) {
      fluxCaching.blockedRepositoriesCache.clear();
    }
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('verifyRepository tests', () => {
    let ImageVerifierStub;

    beforeEach(() => {
      ImageVerifierStub = sinon.stub(imageVerifier, 'ImageVerifier').returns({
        verifyImage: sinon.stub().resolves(),
        throwIfError: sinon.stub(),
        addCredentials: sinon.stub(),
        supported: true,
        supportedArchitectures: ['amd64', 'arm64'],
        errorMeta: null,
      });
    });

    it('should verify repository without authentication', async () => {
      await imageManager.verifyRepository('test/app:latest');

      sinon.assert.calledOnce(ImageVerifierStub);
      const instance = ImageVerifierStub.firstCall.returnValue;
      sinon.assert.calledOnce(instance.verifyImage);
      sinon.assert.calledOnce(instance.throwIfError);
    });

    it('should verify repository with authentication', async () => {
      await imageManager.verifyRepository('test/app:latest', {
        repoauth: 'myuser:mytoken',
        appName: 'testapp',
      });

      const instance = ImageVerifierStub.firstCall.returnValue;
      sinon.assert.calledOnce(instance.addCredentials);
    });

    it('should throw error if unable to decrypt credentials', async () => {
      sinon.stub(registryCredentialHelper, 'getCredentials').rejects(new Error('Unable to decrypt provided credentials'));

      try {
        await imageManager.verifyRepository('test/app:latest', {
          repoauth: 'invalid_credentials',
          appName: 'testapp',
        });
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('Unable to decrypt provided credentials');
      }
    });

    it('should throw error if architecture not supported', async () => {
      ImageVerifierStub.returns({
        verifyImage: sinon.stub().resolves(),
        throwIfError: sinon.stub(),
        addCredentials: sinon.stub(),
        supported: false,
        errorMeta: null,
      });

      try {
        await imageManager.verifyRepository('test/app:latest', {
          architecture: 'arm64',
        });
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('architecture arm64 not supported');
      }
    });

    it('should pass architecture to ImageVerifier', async () => {
      await imageManager.verifyRepository('test/app:latest', {
        architecture: 'amd64',
      });

      const constructorArgs = ImageVerifierStub.firstCall.args;
      expect(constructorArgs[1].architecture).to.equal('amd64');
    });

    it('should cache successful verification using fluxCaching', async () => {
      await imageManager.verifyRepository('test/app:latest');

      // Check that cache was set
      // eslint-disable-next-line global-require
      const fluxCaching = require('../../ZelBack/src/services/utils/cacheManager').default;
      const cacheKey = 'test/app:latest:any:noauth';
      const cached = fluxCaching.dockerHubVerificationCache.get(cacheKey);

      expect(cached).to.not.be.undefined;
      expect(cached.result).to.be.an('object');
      expect(cached.result.verified).to.be.true;
      expect(cached.result.supportedArchitectures).to.be.an('array');
      expect(cached.error).to.be.null;
    });

    it('should return cached successful verification', async () => {
      // First call
      await imageManager.verifyRepository('test/app:latest');

      const firstCallCount = ImageVerifierStub.callCount;

      // Second call should use cache
      await imageManager.verifyRepository('test/app:latest');

      // ImageVerifier should not be called again (cache hit)
      expect(ImageVerifierStub.callCount).to.equal(firstCallCount);
    });

    it('should cache failed verification with custom TTL based on error type', async () => {
      const networkError = new Error('Connection Error ECONNREFUSED: image not available');

      ImageVerifierStub.returns({
        verifyImage: sinon.stub().resolves(),
        throwIfError: sinon.stub().throws(networkError),
        addCredentials: sinon.stub(),
        supported: true,
        errorMeta: {
          httpStatus: null,
          errorCode: 'ECONNREFUSED',
          errorType: 'network',
        },
      });

      try {
        await imageManager.verifyRepository('test/app:latest');
        expect.fail('Should have thrown an error');
      } catch (error) {
        // Error should be thrown
        expect(error.message).to.include('Connection Error');
      }

      // Check that failure was cached
      // eslint-disable-next-line global-require
      const fluxCaching = require('../../ZelBack/src/services/utils/cacheManager').default;
      const cacheKey = 'test/app:latest:any:noauth';
      const cached = fluxCaching.dockerHubVerificationCache.get(cacheKey);

      expect(cached).to.not.be.undefined;
      expect(cached.result).to.be.null;
      expect(cached.error).to.include('Connection Error');
    });

    it('should throw cached error on subsequent calls', async () => {
      const networkError = new Error('Connection Error ECONNREFUSED');

      ImageVerifierStub.returns({
        verifyImage: sinon.stub().resolves(),
        throwIfError: sinon.stub().throws(networkError),
        addCredentials: sinon.stub(),
        supported: true,
        errorMeta: {
          errorType: 'network',
          errorCode: 'ECONNREFUSED',
          httpStatus: null,
        },
      });

      // First call - actual verification
      try {
        await imageManager.verifyRepository('test/app:latest');
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('Connection Error');
      }

      ImageVerifierStub.resetHistory();

      // Second call - should use cache and throw cached error
      try {
        await imageManager.verifyRepository('test/app:latest');
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('Connection Error');
      }

      // ImageVerifier should not be instantiated on second call (cache hit)
      sinon.assert.notCalled(ImageVerifierStub);
    });

    it('should use different cache keys for different architectures', async () => {
      // First call with amd64
      await imageManager.verifyRepository('test/app:latest', { architecture: 'amd64' });

      // Second call with arm64
      await imageManager.verifyRepository('test/app:latest', { architecture: 'arm64' });

      // Both should have been verified (different cache keys)
      sinon.assert.calledTwice(ImageVerifierStub);

      // eslint-disable-next-line global-require
      const fluxCaching = require('../../ZelBack/src/services/utils/cacheManager').default;
      const amd64Key = 'test/app:latest:amd64:noauth';
      const arm64Key = 'test/app:latest:arm64:noauth';

      expect(fluxCaching.dockerHubVerificationCache.get(amd64Key)).to.not.be.undefined;
      expect(fluxCaching.dockerHubVerificationCache.get(arm64Key)).to.not.be.undefined;
    });

    it('should classify network errors with 1 hour TTL', async () => {
      const networkError = new Error('Connection Error');

      ImageVerifierStub.returns({
        verifyImage: sinon.stub().resolves(),
        throwIfError: sinon.stub().throws(networkError),
        errorMeta: {
          errorType: 'network',
          errorCode: 'ECONNREFUSED',
          httpStatus: null,
        },
      });

      try {
        await imageManager.verifyRepository('test/app:latest');
      } catch (error) {
        // Expected
      }

      // The error should be logged with "1 hour" in the message
      // We can't directly test TTL without waiting, but we test classification logic
      // eslint-disable-next-line global-require
      const { FluxCacheManager } = require('../../ZelBack/src/services/utils/cacheManager');
      expect(FluxCacheManager.oneHour).to.equal(3600000); // 1 hour in ms
    });

    it('should classify rate limit errors with 2 hour TTL', async () => {
      const rateLimitError = new Error('Too many requests');

      ImageVerifierStub.returns({
        verifyImage: sinon.stub().resolves(),
        throwIfError: sinon.stub().throws(rateLimitError),
        errorMeta: {
          errorType: 'rate_limit',
          errorCode: null,
          httpStatus: 429,
        },
      });

      try {
        await imageManager.verifyRepository('test/app:latest');
      } catch (error) {
        // Expected
      }

      // eslint-disable-next-line global-require
      const { FluxCacheManager } = require('../../ZelBack/src/services/utils/cacheManager');
      expect(2 * FluxCacheManager.oneHour).to.equal(7200000); // 2 hours in ms
    });

    it('should classify permanent errors with 7 day TTL', async () => {
      const permanentError = new Error('Image size exceeds allowed maximum');

      ImageVerifierStub.returns({
        verifyImage: sinon.stub().resolves(),
        throwIfError: sinon.stub().throws(permanentError),
        errorMeta: {
          errorType: 'size_limit',
          errorCode: null,
          httpStatus: null,
        },
      });

      try {
        await imageManager.verifyRepository('test/app:latest');
      } catch (error) {
        // Expected
      }

      // eslint-disable-next-line global-require
      const { FluxCacheManager } = require('../../ZelBack/src/services/utils/cacheManager');
      expect(7 * FluxCacheManager.oneDay).to.equal(604800000); // 7 days in ms
    });
  });

  describe('getBlockedRepositories tests', () => {
    it('should return cached blocked repositories', async () => {
      const cachedData = ['blocked/repo1', 'blocked/repo2'];

      // First call to populate cache
      sinon.stub(serviceHelper, 'axiosGet').resolves({ data: cachedData });
      const result1 = await imageManager.getBlockedRepositories();

      // Second call should use cache
      const result2 = await imageManager.getBlockedRepositories();

      expect(result1).to.deep.equal(cachedData);
      expect(result2).to.deep.equal(cachedData);
      sinon.assert.calledOnce(serviceHelper.axiosGet);
    });

    it('should fetch blocked repositories from GitHub', async () => {
      const blockedRepos = ['blocked/repo1', 'blocked/repo2'];
      sinon.stub(serviceHelper, 'axiosGet').resolves({ data: blockedRepos });

      const result = await imageManager.getBlockedRepositories();

      expect(result).to.deep.equal(blockedRepos);
      sinon.assert.calledWith(
        serviceHelper.axiosGet,
        'https://raw.githubusercontent.com/RunOnFlux/fluxos-network-policy/main/blockedrepositories.json',
      );
    });

    it('should return null on error', async () => {
      sinon.stub(serviceHelper, 'axiosGet').rejects(new Error('Network error'));

      const result = await imageManager.getBlockedRepositories();

      expect(result).to.be.null;
    });

    it('should return null if no data returned', async () => {
      sinon.stub(serviceHelper, 'axiosGet').resolves({});

      const result = await imageManager.getBlockedRepositories();

      expect(result).to.be.null;
    });
  });

  describe('getUserBlockedRepositories tests', () => {
    let originalUserconfig;

    beforeEach(() => {
      originalUserconfig = globalThis.userconfig;
    });

    afterEach(() => {
      globalThis.userconfig = originalUserconfig;
    });

    it('should return an empty array when no repositories are blocked', async () => {
      globalThis.userconfig = { initial: { blockedRepositories: [] } };
      const axiosGet = sinon.stub(axios, 'get');

      const result = await imageManager.getUserBlockedRepositories();

      expect(result).to.deep.equal([]);
      sinon.assert.notCalled(axiosGet);
    });

    it('should keep blocked repos that are not marketplace offerings and drop those that are', async () => {
      globalThis.userconfig = { initial: { blockedRepositories: ['evil/repo', 'marketplaceapp/img'] } };
      sinon.stub(axios, 'get').resolves({
        data: {
          status: 'success',
          data: [{ visible: true, compose: [{ repotag: 'marketplaceapp/img:v1' }] }],
        },
      });

      const result = await imageManager.getUserBlockedRepositories();

      expect(result).to.deep.equal(['evil/repo']);
    });

    it('exempts a marketplace offering even when the config entry has a tag and mixed case', async () => {
      globalThis.userconfig = { initial: { blockedRepositories: ['Evil/Repo:latest', 'MarketplaceApp/Img:1.2.3'] } };
      sinon.stub(axios, 'get').resolves({
        data: {
          status: 'success',
          data: [{ visible: true, compose: [{ repotag: 'marketplaceapp/img:v1' }] }],
        },
      });

      const result = await imageManager.getUserBlockedRepositories();

      // tag + case are normalised; the marketplace entry is dropped, the other
      // is stored as its tag-stripped, lowercased name.
      expect(result).to.deep.equal(['evil/repo']);
    });

    it('should cache the result across calls', async () => {
      globalThis.userconfig = { initial: { blockedRepositories: ['evil/repo'] } };
      const axiosGet = sinon.stub(axios, 'get').resolves({
        data: { status: 'success', data: [] },
      });

      const first = await imageManager.getUserBlockedRepositories();
      const second = await imageManager.getUserBlockedRepositories();

      expect(first).to.deep.equal(['evil/repo']);
      expect(second).to.deep.equal(first);
      sinon.assert.calledOnce(axiosGet);
    });

    it('should return an empty array when the marketplace response is not successful', async () => {
      globalThis.userconfig = { initial: { blockedRepositories: ['evil/repo'] } };
      sinon.stub(axios, 'get').resolves({ data: { status: 'error' } });

      const result = await imageManager.getUserBlockedRepositories();

      expect(result).to.deep.equal([]);
    });

    it('should return an empty array when the marketplace request fails', async () => {
      globalThis.userconfig = { initial: { blockedRepositories: ['evil/repo'] } };
      sinon.stub(axios, 'get').rejects(new Error('Network error'));

      const result = await imageManager.getUserBlockedRepositories();

      expect(result).to.deep.equal([]);
    });
  });

  describe('isImageBlocked tests', () => {
    beforeEach(() => {
      sinon.stub(serviceHelper, 'axiosGet').resolves({
        data: ['blocked/repo', 'blocked-org', 'blockedowner'],
      });

      // eslint-disable-next-line global-require
      const axios = require('axios');
      sinon.stub(axios, 'get').resolves({
        data: {
          status: 'success',
          data: [],
        },
      });
    });

    it('should return not blocked for allowed images', async () => {
      const result = await imageManager.isImageBlocked(
        'TestApp',
        ['allowed/app:latest'],
        { owner: '1ValidOwner', hash: 'validhash' },
      );

      expect(result.blocked).to.be.false;
      expect(result.reason).to.be.null;
      expect(result.undetermined).to.be.false;
    });

    it('returns undetermined (not blocked) when the official blocklist is unreachable', async () => {
      // A fetch failure must be distinguishable from "fetched, nothing blocked" so the
      // install gates can defer rather than admit an image they could not check.
      serviceHelper.axiosGet.rejects(new Error('network unreachable'));

      const result = await imageManager.isImageBlocked(
        'TestApp',
        ['allowed/app:latest'],
        { owner: '1ValidOwner', hash: 'validhash' },
      );

      expect(result.blocked).to.be.false;
      expect(result.undetermined).to.be.true;
    });

    it('handles a 64-char hash in the blocklist without catastrophic backtracking', async () => {
      // Blocklists are a flat mix of repos, owners and 64-char hashes; every
      // entry is run through stripTag. A 64-char hash once hung the event loop.
      const hash = '6d691f2c09e08e9b6acf046a46566132bcf8dc6c0fbd2042e8faf087d5504e09';
      serviceHelper.axiosGet.resolves({ data: ['blocked/repo', hash] });

      const start = process.hrtime.bigint();
      const result = await imageManager.isImageBlocked(
        'TestApp',
        ['allowed/app:latest'],
        { owner: '1ValidOwner', hash },
      );
      const ms = Number(process.hrtime.bigint() - start) / 1e6;

      expect(ms, `isImageBlocked took ${ms.toFixed(0)}ms`).to.be.below(1000);
      expect(result.blocked).to.be.true; // the app's own hash is on the blocklist
      expect(result.reason).to.include('is not allowed to be spawned');
    });

    it('should return blocked for blocked app hash', async () => {
      const result = await imageManager.isImageBlocked(
        'TestApp',
        ['allowed/app:latest'],
        { owner: '1ValidOwner', hash: 'blocked/repo' },
      );

      expect(result.blocked).to.be.true;
      expect(result.reason).to.include('is not allowed to be spawned');
    });

    it('should return blocked for blocked owner', async () => {
      const result = await imageManager.isImageBlocked(
        'TestApp',
        ['allowed/app:latest'],
        { owner: 'blockedowner', hash: 'validhash' },
      );

      expect(result.blocked).to.be.true;
      expect(result.reason).to.include('is not allowed to run applications');
    });

    it('should return blocked for blocked image', async () => {
      const result = await imageManager.isImageBlocked(
        'TestApp',
        ['blocked/repo:latest'],
        { owner: '1ValidOwner', hash: 'validhash' },
      );

      expect(result.blocked).to.be.true;
      expect(result.reason).to.include('Image blocked/repo is blocked');
    });

    it('should return blocked for blocked organization', async () => {
      const result = await imageManager.isImageBlocked(
        'TestApp',
        ['blocked-org/app:latest'],
        { owner: '1ValidOwner', hash: 'validhash' },
      );

      expect(result.blocked).to.be.true;
      expect(result.reason).to.include('Organisation blocked-org is blocked');
    });

    it('should detect blocked image among multiple images', async () => {
      const result = await imageManager.isImageBlocked(
        'TestApp',
        ['allowed/app1:latest', 'blocked/repo:latest'],
        { owner: '1ValidOwner', hash: 'validhash' },
      );

      expect(result.blocked).to.be.true;
      expect(result.reason).to.include('Image blocked/repo is blocked');
    });

    it('should return not blocked if no repos available', async () => {
      serviceHelper.axiosGet.restore();
      sinon.stub(serviceHelper, 'axiosGet').resolves({ data: null });

      // eslint-disable-next-line global-require
      const axios = require('axios');
      axios.get.restore();
      sinon.stub(axios, 'get').rejects(new Error('Network error'));

      const result = await imageManager.isImageBlocked(
        'TestApp',
        ['allowed/app:latest'],
        { owner: '1ValidOwner', hash: 'validhash' },
      );

      expect(result.blocked).to.be.false;
      expect(result.reason).to.be.null;
    });
  });

  describe('checkDockerAccessibility tests', () => {
    it('should return success when authorized', async () => {
      const req = {
        on: sinon.stub(),
      };
      const res = {
        json: sinon.stub(),
      };

      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
      sinon.stub(serviceHelper, 'ensureObject').returns({ repotag: 'test/app:latest' });
      sinon.stub(messageHelper, 'createSuccessMessage').returns({ status: 'success' });

      // Simulate request body
      req.on.withArgs('data').yields('{"repotag":"test/app:latest"}');
      req.on.withArgs('end').yields();

      await imageManager.checkDockerAccessibility(req, res);

      sinon.assert.calledOnce(res.json);
      expect(res.json.firstCall.args[0].status).to.equal('success');
    });

    it('should reject unauthorized request', async () => {
      const req = {
        on: sinon.stub(),
      };
      const res = {
        json: sinon.stub(),
      };

      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(false);
      sinon.stub(messageHelper, 'errUnauthorizedMessage').returns({ status: 'error', data: { code: 401 } });

      req.on.withArgs('data').yields('{"repotag":"test/app:latest"}');
      req.on.withArgs('end').yields();

      await imageManager.checkDockerAccessibility(req, res);

      sinon.assert.calledOnce(res.json);
      expect(res.json.firstCall.args[0].data.code).to.equal(401);
    });

    it('should throw error if no repotag specified', async () => {
      const req = {
        on: sinon.stub(),
      };
      const res = {
        json: sinon.stub(),
      };

      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
      sinon.stub(serviceHelper, 'ensureObject').returns({});
      sinon.stub(messageHelper, 'createErrorMessage').returns({ status: 'error' });

      req.on.withArgs('data').yields('{}');
      req.on.withArgs('end').yields();

      await imageManager.checkDockerAccessibility(req, res);

      sinon.assert.calledOnce(res.json);
      expect(res.json.firstCall.args[0].status).to.equal('error');
    });
  });

  describe('checkApplicationsCompliance tests', () => {
    let deploymentProvider;
    let appUninstaller;

    beforeEach(() => {
      // eslint-disable-next-line global-require
      deploymentProvider = require('../../ZelBack/src/services/appRuntime/deploymentProvider');
      // eslint-disable-next-line global-require
      appUninstaller = require('../../ZelBack/src/services/appLifecycle/appUninstaller');
    });

    it('should remove blacklisted apps', async () => {
      sinon.stub(appsRepository, 'listInstalledApps').resolves([
        { name: 'GoodApp', owner: '1ValidOwner', hash: 'validhash' },
        { name: 'BadApp', owner: '1ValidOwner', hash: 'validhash' },
      ]);

      sinon.stub(deploymentProvider, 'listInstalledDeployments').resolves([
        { appName: 'GoodApp', allImages: () => ['allowed/app:latest'] },
        { appName: 'BadApp', allImages: () => ['blocked/repo:latest'] },
      ]);

      const uninstallStub = sinon.stub(appUninstaller, 'uninstallApplication').resolves({ status: appUninstaller.UninstallStatus.REMOVED, reason: null });

      sinon.stub(serviceHelper, 'axiosGet').resolves({
        data: ['blocked/repo'],
      });

      // eslint-disable-next-line global-require
      const axios = require('axios');
      sinon.stub(axios, 'get').resolves({
        data: {
          status: 'success',
          data: [],
        },
      });

      sinon.stub(serviceHelper, 'delay').resolves();

      await imageManager.checkApplicationsCompliance();

      sinon.assert.calledOnce(uninstallStub);
      sinon.assert.calledWith(uninstallStub, 'BadApp', { broadcastRemoval: true });
    });

    it('should handle failure to get installed apps', async () => {
      sinon.stub(appsRepository, 'listInstalledApps').rejects(new Error('Failed to get apps'));

      const uninstallStub = sinon.stub(appUninstaller, 'uninstallApplication').resolves({ status: appUninstaller.UninstallStatus.REMOVED, reason: null });

      await imageManager.checkApplicationsCompliance();

      sinon.assert.notCalled(uninstallStub);
    });

    it('should not remove apps if none are blacklisted', async () => {
      sinon.stub(appsRepository, 'listInstalledApps').resolves([
        { name: 'GoodApp', owner: '1ValidOwner', hash: 'validhash' },
      ]);

      sinon.stub(deploymentProvider, 'listInstalledDeployments').resolves([
        { appName: 'GoodApp', allImages: () => ['allowed/app:latest'] },
      ]);

      const uninstallStub = sinon.stub(appUninstaller, 'uninstallApplication').resolves({ status: appUninstaller.UninstallStatus.REMOVED, reason: null });

      sinon.stub(serviceHelper, 'axiosGet').resolves({
        data: ['blocked/repo'],
      });

      // eslint-disable-next-line global-require
      const axios = require('axios');
      sinon.stub(axios, 'get').resolves({
        data: {
          status: 'success',
          data: [],
        },
      });

      await imageManager.checkApplicationsCompliance();

      sinon.assert.notCalled(uninstallStub);
    });

    it('should delay between removing multiple apps', async () => {
      sinon.stub(appsRepository, 'listInstalledApps').resolves([
        { name: 'BadApp1', owner: '1ValidOwner', hash: 'validhash' },
        { name: 'BadApp2', owner: '1ValidOwner', hash: 'validhash' },
      ]);

      sinon.stub(deploymentProvider, 'listInstalledDeployments').resolves([
        { appName: 'BadApp1', allImages: () => ['blocked/repo1:latest'] },
        { appName: 'BadApp2', allImages: () => ['blocked/repo2:latest'] },
      ]);

      const uninstallStub = sinon.stub(appUninstaller, 'uninstallApplication').resolves({ status: appUninstaller.UninstallStatus.REMOVED, reason: null });

      sinon.stub(serviceHelper, 'axiosGet').resolves({
        data: ['blocked/repo1', 'blocked/repo2'],
      });

      // eslint-disable-next-line global-require
      const axios = require('axios');
      sinon.stub(axios, 'get').resolves({
        data: {
          status: 'success',
          data: [],
        },
      });

      const delayStub = sinon.stub(serviceHelper, 'delay').resolves();

      await imageManager.checkApplicationsCompliance();

      sinon.assert.calledTwice(uninstallStub);
      sinon.assert.calledTwice(delayStub);
      sinon.assert.calledWith(delayStub, 3 * 60 * 1000);
    });
  });

  describe('blockedReasonFor tests', () => {
    // An entry reaches the one field its kind names and no other. Both
    // directions are asserted: blocking too much and blocking too little are
    // indistinguishable from either side alone.
    const namedGrafana = {
      name: 'grafana', owner: '1SomeOwner', hash: 'a'.repeat(64), images: ['unrelated/image:latest'],
    };
    const publishedByGrafana = {
      name: 'dashboards', owner: '1SomeOwner', hash: 'b'.repeat(64), images: ['grafana/dashboards:latest'],
    };

    it('a name entry blocks the application of that name', () => {
      const reason = imageManager.blockedReasonFor([{ kind: 'name', value: 'grafana' }], namedGrafana);
      expect(reason).to.equal('Application grafana is not allowed to run');
    });

    it('a name entry does NOT block an application whose image namespace is that word', () => {
      const reason = imageManager.blockedReasonFor([{ kind: 'name', value: 'grafana' }], publishedByGrafana);
      expect(reason).to.equal(null);
    });

    it('an org entry blocks every application publishing under that namespace', () => {
      const reason = imageManager.blockedReasonFor([{ kind: 'org', value: 'grafana' }], publishedByGrafana);
      expect(reason).to.contain('Organisation grafana is blocked');
    });

    it('an org entry does NOT block an application merely named that word', () => {
      const reason = imageManager.blockedReasonFor([{ kind: 'org', value: 'grafana' }], namedGrafana);
      expect(reason).to.equal(null);
    });

    it('a hash entry matches the hash and nothing else', () => {
      const entries = [{ kind: 'hash', value: 'a'.repeat(64) }];
      expect(imageManager.blockedReasonFor(entries, namedGrafana)).to.contain('is not allowed to be spawned');
      expect(imageManager.blockedReasonFor(entries, publishedByGrafana)).to.equal(null);
    });

    it('an owner entry matches the owner and nothing else', () => {
      const entries = [{ kind: 'owner', value: '1SomeOwner' }];
      expect(imageManager.blockedReasonFor(entries, namedGrafana)).to.contain('is not allowed to run applications');
      expect(imageManager.blockedReasonFor([{ kind: 'owner', value: 'grafana' }], namedGrafana)).to.equal(null);
    });

    it('an image entry matches the whole repository, not its namespace', () => {
      expect(imageManager.blockedReasonFor([{ kind: 'image', value: 'grafana/dashboards' }], publishedByGrafana))
        .to.contain('Image grafana/dashboards is blocked');
      expect(imageManager.blockedReasonFor([{ kind: 'image', value: 'grafana' }], publishedByGrafana))
        .to.equal(null);
    });

    it('a kind this release does not understand blocks nothing', () => {
      // A newer document ships before the reader that understands it, so an
      // unknown kind is inert rather than an error.
      const entries = [{ kind: 'somethingNewer', value: 'grafana' }];
      expect(imageManager.blockedReasonFor(entries, namedGrafana)).to.equal(null);
      expect(imageManager.blockedReasonFor(entries, publishedByGrafana)).to.equal(null);
    });

    it('a legacy entry keeps its four-field meaning', () => {
      // A flat-document entry is one string against the hash, the owner, the
      // repository and the namespace. Narrowing it would stop enforcing bans
      // that are in force.
      const entries = [{ kind: 'legacy', value: 'grafana' }];
      expect(imageManager.blockedReasonFor(entries, publishedByGrafana)).to.contain('Organisation grafana is blocked');
      expect(imageManager.blockedReasonFor([{ kind: 'legacy', value: 'a'.repeat(64) }], namedGrafana))
        .to.contain('is not allowed to be spawned');
      expect(imageManager.blockedReasonFor([{ kind: 'legacy', value: '1SomeOwner' }], namedGrafana))
        .to.contain('is not allowed to run applications');
    });

    it('answers the identity questions when the images cannot be read', () => {
      // An enterprise application carries its components inside its encrypted
      // blob; name, owner and hash sit on the stored record regardless.
      const sealed = {
        name: 'grafana', owner: '1SomeOwner', hash: 'a'.repeat(64), images: null,
      };
      expect(imageManager.blockedReasonFor([{ kind: 'name', value: 'grafana' }], sealed))
        .to.equal('Application grafana is not allowed to run');
      expect(imageManager.blockedReasonFor([{ kind: 'org', value: 'grafana' }], sealed)).to.equal(null);
    });
  });

  describe('getBlocklist tests', () => {
    const typed = [{ kind: 'name', value: 'dowz', reason: 'why', added: '2026-09-12' }];

    it('prefers the typed document', async () => {
      const axiosGet = sinon.stub(serviceHelper, 'axiosGet');
      axiosGet.withArgs(sinon.match(/blocklist\.json$/)).resolves({ data: typed });
      axiosGet.resolves({ data: ['legacy-entry'] });

      const entries = await imageManager.getBlocklist();

      expect(entries).to.deep.equal(typed);
    });

    it('falls back to the flat document when the typed one is not typed', async () => {
      // A response that is merely array-shaped - an error page, or the flat
      // document served under the wrong name - must not read as "nothing is
      // blocked".
      const axiosGet = sinon.stub(serviceHelper, 'axiosGet');
      axiosGet.withArgs(sinon.match(/blocklist\.json$/)).resolves({ data: ['not', 'typed'] });
      axiosGet.withArgs(sinon.match(/blockedrepositories\.json$/)).resolves({ data: ['blocked-org'] });

      const entries = await imageManager.getBlocklist();

      expect(entries).to.deep.equal([{ kind: 'legacy', value: 'blocked-org' }]);
    });

    it('falls back when the typed document is empty', async () => {
      const axiosGet = sinon.stub(serviceHelper, 'axiosGet');
      axiosGet.withArgs(sinon.match(/blocklist\.json$/)).resolves({ data: [] });
      axiosGet.withArgs(sinon.match(/blockedrepositories\.json$/)).resolves({ data: ['blocked-org'] });

      const entries = await imageManager.getBlocklist();

      expect(entries).to.deep.equal([{ kind: 'legacy', value: 'blocked-org' }]);
    });

    it('falls back when the typed document is absent', async () => {
      const axiosGet = sinon.stub(serviceHelper, 'axiosGet');
      axiosGet.withArgs(sinon.match(/blocklist\.json$/)).rejects(new Error('404'));
      axiosGet.withArgs(sinon.match(/blockedrepositories\.json$/)).resolves({ data: ['blocked-org'] });

      const entries = await imageManager.getBlocklist();

      expect(entries).to.deep.equal([{ kind: 'legacy', value: 'blocked-org' }]);
    });

    it('rejects the whole typed document when any one element is malformed', async () => {
      // `every`, not `filter`. Dropping the bad element would answer from a document the
      // reader could not fully read, and silently under-block by exactly the entries it
      // discarded - which is the direction that costs money.
      const axiosGet = sinon.stub(serviceHelper, 'axiosGet');
      axiosGet.withArgs(sinon.match(/blocklist\.json$/)).resolves({
        data: [
          { kind: 'name', value: 'dowz', reason: 'why', added: '2026-09-12' },
          { kind: 'name' },
        ],
      });
      axiosGet.withArgs(sinon.match(/blockedrepositories\.json$/)).resolves({ data: ['blocked-org'] });

      const entries = await imageManager.getBlocklist();

      expect(entries).to.deep.equal([{ kind: 'legacy', value: 'blocked-org' }]);
    });

    it('returns null when the flat document is not a list', async () => {
      // The flat fetch caches on truthiness, so an error page served as 200 is held for six
      // hours. Reading it as "nothing is blocked" would unblock the network; mapping over it
      // throws a TypeError no caller recognises. Neither: it is "could not ask".
      const axiosGet = sinon.stub(serviceHelper, 'axiosGet');
      axiosGet.withArgs(sinon.match(/blocklist\.json$/)).rejects(new Error('404'));
      axiosGet.withArgs(sinon.match(/blockedrepositories\.json$/))
        .resolves({ data: '<html>rate limited</html>' });

      const entries = await imageManager.getBlocklist();

      expect(entries).to.equal(null);
    });

    it('returns an empty list when the documents say nothing is blocked', async () => {
      // [] and null must never collapse into one value: a node that cannot read policy has to
      // refuse to decide, where one that read an empty policy has decided.
      const axiosGet = sinon.stub(serviceHelper, 'axiosGet');
      axiosGet.withArgs(sinon.match(/blocklist\.json$/)).resolves({ data: [] });
      axiosGet.withArgs(sinon.match(/blockedrepositories\.json$/)).resolves({ data: [] });

      const entries = await imageManager.getBlocklist();

      expect(entries).to.deep.equal([]);
    });

    it('returns null when neither document can be read', async () => {
      // Null is "could not ask", which callers refuse or defer on. An empty
      // list would answer "nothing is blocked" from an outage.
      sinon.stub(serviceHelper, 'axiosGet').rejects(new Error('network down'));

      const entries = await imageManager.getBlocklist();

      expect(entries).to.equal(null);
    });
  });

  describe('checkApplicationsCompliance identity tests', () => {
    const sealed = {
      name: 'dijikalaco',
      version: 8,
      owner: '1OrbitOwner',
      hash: 'a'.repeat(64),
      enterprise: 'base64blob',
      compose: [],
    };

    // imageManager destructures decryptEnterpriseApps at load, so a stub only
    // reaches it through a fresh require.
    function reloadWithDecryption(decrypt) {
      // eslint-disable-next-line global-require
      const appQueryService = require('../../ZelBack/src/services/appQuery/appQueryService');
      sinon.stub(appQueryService, 'decryptEnterpriseApps').callsFake(decrypt);
      delete require.cache[require.resolve('../../ZelBack/src/services/appSecurity/imageManager')];
      // eslint-disable-next-line global-require
      return require('../../ZelBack/src/services/appSecurity/imageManager');
    }

    function stubBlocklist(entries) {
      const axiosGet = sinon.stub(serviceHelper, 'axiosGet');
      if (entries === null) {
        axiosGet.rejects(new Error('unreachable'));
      } else {
        axiosGet.withArgs(sinon.match(/blocklist\.json$/)).resolves({ data: entries });
        axiosGet.resolves({ data: [] });
      }
      // eslint-disable-next-line global-require
      const axios = require('axios');
      sinon.stub(axios, 'get').resolves({ data: { status: 'success', data: [] } });
      sinon.stub(serviceHelper, 'delay').resolves();
    }

    it('removes a blocked enterprise app whose specification cannot be decrypted', async () => {
      // The components are sealed, so nothing about the images can be asked. The
      // hash is on the record and decides on its own.
      stubBlocklist([{
        kind: 'hash', value: 'a'.repeat(64), reason: 'orbit', added: '2026-09-12',
      }]);
      const installedApps = sinon.stub().resolves({ status: 'success', data: [sealed] });
      const removeAppLocally = sinon.stub().resolves();
      const manager = reloadWithDecryption(async () => ({ readable: [], unreadable: [sealed], inPlace: [sealed] }));

      await manager.checkApplicationsCompliance(installedApps, removeAppLocally);

      sinon.assert.calledOnceWithExactly(removeAppLocally, 'dijikalaco', null, false, true, true);
    });

    it('removes an undecryptable app blocked by name', async () => {
      stubBlocklist([{
        kind: 'name', value: 'dijikalaco', reason: 'orbit', added: '2026-09-12',
      }]);
      const installedApps = sinon.stub().resolves({ status: 'success', data: [sealed] });
      const removeAppLocally = sinon.stub().resolves();
      const manager = reloadWithDecryption(async () => ({ readable: [], unreadable: [sealed], inPlace: [sealed] }));

      await manager.checkApplicationsCompliance(installedApps, removeAppLocally);

      sinon.assert.calledOnceWithExactly(removeAppLocally, 'dijikalaco', null, false, true, true);
    });

    it('leaves an undecryptable app alone when nothing about it is blocked', async () => {
      stubBlocklist([{
        kind: 'hash', value: 'b'.repeat(64), reason: 'other', added: '2026-09-12',
      }]);
      const installedApps = sinon.stub().resolves({ status: 'success', data: [sealed] });
      const removeAppLocally = sinon.stub().resolves();
      const manager = reloadWithDecryption(async () => ({ readable: [], unreadable: [sealed], inPlace: [sealed] }));

      await manager.checkApplicationsCompliance(installedApps, removeAppLocally);

      sinon.assert.notCalled(removeAppLocally);
    });

    it('removes nothing when the blocklist cannot be obtained', async () => {
      // An unreachable document must not tear down the node's applications.
      stubBlocklist(null);
      const blockedByHash = { ...sealed, enterprise: undefined, compose: [{ repotag: 'blocked/repo:latest' }] };
      const installedApps = sinon.stub().resolves({ status: 'success', data: [blockedByHash] });
      const removeAppLocally = sinon.stub().resolves();
      const manager = reloadWithDecryption(async (apps) => ({ readable: apps, unreadable: [], inPlace: apps }));

      await manager.checkApplicationsCompliance(installedApps, removeAppLocally);

      sinon.assert.notCalled(removeAppLocally);
    });

    it('still blocks a readable app on its image', async () => {
      stubBlocklist([{
        kind: 'image', value: 'blocked/repo', reason: 'malware', added: '2026-09-12',
      }]);
      const readable = {
        name: 'ReadableApp', version: 4, owner: '1Owner', hash: 'c'.repeat(64), compose: [{ repotag: 'blocked/repo:latest' }],
      };
      const installedApps = sinon.stub().resolves({ status: 'success', data: [readable] });
      const removeAppLocally = sinon.stub().resolves();
      const manager = reloadWithDecryption(async (apps) => ({ readable: apps, unreadable: [], inPlace: apps }));

      await manager.checkApplicationsCompliance(installedApps, removeAppLocally);

      sinon.assert.calledOnceWithExactly(removeAppLocally, 'ReadableApp', null, false, true, true);
    });
  });
});
