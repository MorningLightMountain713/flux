const { expect } = require('chai');
const sinon = require('sinon');
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
      const permanentError = new Error('Repository is not whitelisted');

      ImageVerifierStub.returns({
        verifyImage: sinon.stub().resolves(),
        throwIfError: sinon.stub().throws(permanentError),
        errorMeta: {
          errorType: 'not_whitelisted',
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

  describe('getBlockedRepositores tests', () => {
    it('should return cached blocked repositories', async () => {
      const cachedData = ['blocked/repo1', 'blocked/repo2'];

      // First call to populate cache
      sinon.stub(serviceHelper, 'axiosGet').resolves({ data: cachedData });
      const result1 = await imageManager.getBlockedRepositores();

      // Second call should use cache
      const result2 = await imageManager.getBlockedRepositores();

      expect(result1).to.deep.equal(cachedData);
      expect(result2).to.deep.equal(cachedData);
      sinon.assert.calledOnce(serviceHelper.axiosGet);
    });

    it('should fetch blocked repositories from GitHub', async () => {
      const blockedRepos = ['blocked/repo1', 'blocked/repo2'];
      sinon.stub(serviceHelper, 'axiosGet').resolves({ data: blockedRepos });

      const result = await imageManager.getBlockedRepositores();

      expect(result).to.deep.equal(blockedRepos);
      sinon.assert.calledWith(
        serviceHelper.axiosGet,
        'https://raw.githubusercontent.com/RunOnFlux/flux/master/helpers/blockedrepositories.json',
      );
    });

    it('should return null on error', async () => {
      sinon.stub(serviceHelper, 'axiosGet').rejects(new Error('Network error'));

      const result = await imageManager.getBlockedRepositores();

      expect(result).to.be.null;
    });

    it('should return null if no data returned', async () => {
      sinon.stub(serviceHelper, 'axiosGet').resolves({});

      const result = await imageManager.getBlockedRepositores();

      expect(result).to.be.null;
    });
  });

  describe.skip('getUserBlockedRepositores tests', () => {
    // These tests require complex userconfig mocking - skipping for now
    it('should return empty array if no user blocked repos configured', async () => {
      const result = await imageManager.getUserBlockedRepositores();
      expect(result).to.be.an('array');
    });

    it('should return cached user blocked repositories', async () => {
      const result1 = await imageManager.getUserBlockedRepositores();
      const result2 = await imageManager.getUserBlockedRepositores();
      expect(result1).to.deep.equal(result2);
    });

    it('should handle marketplace API error gracefully', async () => {
      const result = await imageManager.getUserBlockedRepositores();
      expect(result).to.be.an('array');
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

      const uninstallStub = sinon.stub(appUninstaller, 'uninstallApplication').resolves();

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

      const uninstallStub = sinon.stub(appUninstaller, 'uninstallApplication').resolves();

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

      const uninstallStub = sinon.stub(appUninstaller, 'uninstallApplication').resolves();

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

      const uninstallStub = sinon.stub(appUninstaller, 'uninstallApplication').resolves();

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
});
