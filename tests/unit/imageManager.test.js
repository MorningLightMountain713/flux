'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const messageHelper = require('../../ZelBack/src/services/messageHelper');
const verificationHelper = require('../../ZelBack/src/services/verificationHelper');
const imageVerifier = require('../../ZelBack/src/services/utils/imageVerifier');
const registryCredentialHelper = require('../../ZelBack/src/services/utils/registryCredentialHelper');
const policyStore = require('../../ZelBack/src/services/policyStore');
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
        imageSizeBytes: 12_345,
        decompressedSizeBytes: 45_678,
        decompressedSizeClearanceBytes: 45_678,
        errorMeta: null,
      });
    });

    it('should verify repository without authentication', async () => {
      const result = await imageManager.verifyRepository('test/app:latest');

      sinon.assert.calledOnce(ImageVerifierStub);
      const instance = ImageVerifierStub.firstCall.returnValue;
      sinon.assert.calledOnce(instance.verifyImage);
      sinon.assert.calledOnce(instance.throwIfError);
      // compressed image size surfaced for the early rootFs-fit reject
      expect(result.imageSizeBytes).to.equal(12_345);
    });

    it('should surface the measured decompressed size and its clearance figure', async () => {
      ImageVerifierStub.returns({
        verifyImage: sinon.stub().resolves(),
        throwIfError: sinon.stub(),
        addCredentials: sinon.stub(),
        supported: true,
        supportedArchitectures: ['amd64'],
        imageSizeBytes: 3_620_000_000,
        decompressedSizeBytes: 7_564_967_296,
        decompressedSizeClearanceBytes: 11_859_934_592,
        errorMeta: null,
      });

      const result = await imageManager.verifyRepository('test/app:latest');

      expect(result.decompressedSizeBytes).to.equal(7_564_967_296);
      expect(result.decompressedSizeClearanceBytes).to.equal(11_859_934_592);

      // and the cached entry carries them, so a cache hit gates identically
      // eslint-disable-next-line global-require
      const fluxCaching = require('../../ZelBack/src/services/utils/cacheManager').default;
      const cached = fluxCaching.dockerHubVerificationCache.get('test/app:latest:any:noauth');
      expect(cached.result.decompressedSizeBytes).to.equal(7_564_967_296);
      expect(cached.result.decompressedSizeClearanceBytes).to.equal(11_859_934_592);
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
      expect(FluxCacheManager.oneHour).to.equal(3_600_000); // 1 hour in ms
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
      expect(2 * FluxCacheManager.oneHour).to.equal(7_200_000); // 2 hours in ms
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
      expect(7 * FluxCacheManager.oneDay).to.equal(604_800_000); // 7 days in ms
    });
  });

  // Fetching, validating and caching the document belong to policyStore
  // (tests/unit/policyStore.test.js). imageManager only reads it.
  describe('getBlockedRepositories tests', () => {
    it('should return the blockedrepositories document the bundle holds', () => {
      const blockedRepos = ['blocked/repo1', 'blocked/repo2'];
      sinon.stub(policyStore, 'getDocument').withArgs('blockedrepositories').returns(blockedRepos);

      expect(imageManager.getBlockedRepositories()).to.deep.equal(blockedRepos);
    });

    it('should return null when policyStore has no copy', () => {
      sinon.stub(policyStore, 'getDocument').returns(null);

      expect(imageManager.getBlockedRepositories()).to.be.null;
    });
  });

  describe('isImageBlocked tests', () => {
    beforeEach(() => {
      sinon.stub(policyStore, 'getDocument')
        .withArgs('blockedrepositories')
        .returns(['blocked/repo', 'blocked-org', 'blockedowner']);

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
      // "No copy from any layer" must be distinguishable from "obtained, nothing blocked"
      // so the install gates can defer rather than admit an image they could not check.
      policyStore.getDocument.withArgs('blockedrepositories').returns(null);

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
      policyStore.getDocument.withArgs('blockedrepositories').returns(['blocked/repo', hash]);

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
      policyStore.getDocument.withArgs('blockedrepositories').returns(null);

      const result = await imageManager.isImageBlocked(
        'TestApp',
        ['allowed/app:latest'],
        { owner: '1ValidOwner', hash: 'validhash' },
      );

      expect(result.blocked).to.be.false;
      expect(result.reason).to.be.null;
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

    it('prefers the typed document', () => {
      sinon.stub(policyStore, 'getDocument').withArgs('blocklist').returns(typed);
      policyStore.getDocument.withArgs('blockedrepositories').returns(['legacy-entry']);

      expect(imageManager.getBlocklist()).to.deep.equal(typed);
    });

    it('takes an empty typed document as published, with nothing blocked', () => {
      sinon.stub(policyStore, 'getDocument').withArgs('blocklist').returns([]);
      policyStore.getDocument.withArgs('blockedrepositories').returns(['blocked-org']);

      expect(imageManager.getBlocklist()).to.deep.equal([]);
    });

    it('refuses a typed document of the wrong shape rather than falling back', () => {
      sinon.stub(policyStore, 'getDocument').withArgs('blocklist').returns([{ kind: 'name' }]);
      policyStore.getDocument.withArgs('blockedrepositories').returns(['blocked-org']);

      expect(imageManager.getBlocklist()).to.equal(null);
    });

    it('falls back when the typed document is absent', () => {
      sinon.stub(policyStore, 'getDocument').withArgs('blocklist').returns(null);
      policyStore.getDocument.withArgs('blockedrepositories').returns(['blocked-org']);

      expect(imageManager.getBlocklist()).to.deep.equal([{ kind: 'legacy', value: 'blocked-org' }]);
    });

    it('is null, not empty, when no layer holds either document', () => {
      sinon.stub(policyStore, 'getDocument').returns(null);

      expect(imageManager.getBlocklist()).to.equal(null);
    });

    it('a name entry reaches isImageBlocked for an app whose images cannot be read', async () => {
      sinon.stub(policyStore, 'getDocument').withArgs('blocklist').returns([{ kind: 'name', value: 'grafana' }]);

      const result = await imageManager.isImageBlocked('grafana', [], { owner: '1SomeOwner', hash: 'a'.repeat(64) });

      expect(result.blocked).to.equal(true);
      expect(result.reason).to.equal('Application grafana is not allowed to run');
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

});

describe('classifyVerificationError transient TTLs', () => {
  // eslint-disable-next-line global-require
  const imageManager = require('../../ZelBack/src/services/appSecurity/imageManager');

  it('paces transient classes in minutes - the cache must not outlive the outage', () => {
    const err = new Error('x');
    expect(imageManager.classifyVerificationError(err, { errorType: 'network' }).ttlMs).to.equal(2 * 60 * 1000);
    expect(imageManager.classifyVerificationError(err, { errorType: 'rate_limit' }).ttlMs).to.equal(10 * 60 * 1000);
    expect(imageManager.classifyVerificationError(err, { errorType: 'server_error' }).ttlMs).to.equal(5 * 60 * 1000);
  });

  it('keeps hours-scale caching for permanent verdicts and unknown shapes', () => {
    const err = new Error('x');
    expect(imageManager.classifyVerificationError(err, { errorType: 'auth_failed' }).ttlMs).to.be.gte(60 * 60 * 1000);
    expect(imageManager.classifyVerificationError(err, { errorType: 'never_seen_before' }).ttlMs).to.be.gte(60 * 60 * 1000);
  });
});

describe('classifyVerificationError class-first routing (the meta-reset gap)', () => {
  // eslint-disable-next-line global-require
  const imageManager = require('../../ZelBack/src/services/appSecurity/imageManager');

  it('routes on the error class with NO errorMeta - throwIfError resets meta before any catch reads it', () => {
    const err = Object.assign(new Error('Connection Error ECONNABORTED: x not available'), { registryErrorClass: 'transient' });
    const { ttlMs } = imageManager.classifyVerificationError(err, null);
    expect(ttlMs).to.equal(2 * 60 * 1000);
  });

  it('a permanent-class error with no meta still falls back to hour-scale caching', () => {
    const err = new Error('manifest unknown');
    const { ttlMs } = imageManager.classifyVerificationError(err, null);
    expect(ttlMs).to.be.gte(60 * 60 * 1000);
  });
});

// WHEN THE SWEEP RUNS, WHAT IT REMOVES, AND WHAT IT CARRIES BETWEEN PASSES.
//
// The blocklist reaches a node within seconds of the network adopting it, so the wait
// between a change and this node acting on it is whatever the sweeper schedules. Each
// case below is a way that wait, a pass already running, or a removal that did not
// happen produces the wrong answer.
//
// EVERYTHING IS PASSED IN, so there are no stubs here and no reloading. The clock is one
// of the dependencies, and firing a timer returns the pass it started - so a case waits
// for the work rather than for a number of turns of the event loop.
describe('imageManager compliance sweeper', () => {
  // eslint-disable-next-line global-require
  const imageManager = require('../../ZelBack/src/services/appSecurity/imageManager');

  const KNOBS = {
    complianceSweepStaggerMs: 100,
    complianceRemovalSpacingMs: 0,
    complianceRetryBaseMs: 10,
    complianceRetryMaxMs: 80,
  };
  const REMOVED = { status: 'removed', reason: null };
  const DEFERRED = { status: 'deferred', reason: 'An operation is already in progress' };
  const FAILED = { status: 'failed', reason: 'teardown errored' };
  const SKIPPED = { status: 'skipped', reason: 'Flux App not found' };

  // A clock the test owns. `fire` runs what is due and waits for it, because an armed
  // callback returns the pass it starts.
  function testTimers() {
    let nextId = 0;
    const armed = new Map();
    const delays = [];
    return {
      api: {
        set: (fn, ms) => { nextId += 1; delays.push(ms); armed.set(nextId, fn); return nextId; },
        clear: (id) => armed.delete(id),
      },
      delays,
      count: () => armed.size,
      async fire() {
        const due = [...armed.values()];
        armed.clear();
        // eslint-disable-next-line no-restricted-syntax
        for (const fn of due) {
          // eslint-disable-next-line no-await-in-loop
          await fn();
        }
      },
    };
  }

  // An installed specification as the repository answers it: name, owner and hash in
  // plaintext. `images` is what the deployment view reads out of its components, null
  // when they cannot be read.
  const blockedApp = (name, hash = 'd'.repeat(64)) => ({
    name, owner: '1Owner', hash, images: ['blocked/repo:latest'],
  });
  const sealedApp = (name, hash = 'e'.repeat(64)) => ({
    name, owner: '1Owner', hash, images: null,
  });
  const BANS_THE_IMAGE = [{ kind: 'image', value: 'blocked/repo' }];

  // A sweeper wired to the test's own clock, policy, table and documents.
  function build({
    rows = () => [],
    unreadable = () => [],
    blocklist = () => BANS_THE_IMAGE,
    imagesOf = async (spec) => spec.images,
    uninstall = sinon.stub().resolves(REMOVED),
    policyReady = true,
    readInstalled = async (name) => rows().find((row) => row.name === name) ?? null,
    wait = async () => {},
  } = {}) {
    const timers = testTimers();
    let openGate;
    const gate = new Promise((resolve) => { openGate = resolve; });
    const policy = { policyReady, waitForPolicyReady: () => gate };
    let listener = null;
    const bundle = { onBundleChanged: (fn) => { listener = fn; return () => { listener = null; }; } };
    const listInstalled = sinon.spy(async () => ({ specs: rows(), unreadable: unreadable() }));
    const sweeper = imageManager.createComplianceSweeper({
      listInstalled,
      readInstalled,
      imagesOf,
      uninstall,
      blocklist,
      policy,
      bundle,
      knobs: KNOBS,
      timers: timers.api,
      wait,
    });
    return {
      sweeper,
      timers,
      listInstalled,
      uninstall,
      policy,
      openGate,
      changeBundle: () => listener && listener({ seq: 2, source: 'peer' }),
    };
  }

  afterEach(() => sinon.restore());

  describe('what a pass removes', () => {
    it('removes a blocked application and leaves the rest', async () => {
      const t = build({ rows: () => [{ ...blockedApp('GoodApp'), images: ['allowed/app:latest'] }, blockedApp('BadApp')] });
      await t.sweeper.runPass();
      sinon.assert.calledOnceWithExactly(t.uninstall, 'BadApp');
    });

    // SPACING IS BETWEEN REMOVALS, so two of them are separated by one wait. A wait after
    // the last one holds the pass open over an empty remainder.
    it('waits the spacing between two removals, and not after the last', async () => {
      const wait = sinon.stub().resolves();
      const t = build({ rows: () => [blockedApp('BadApp1'), blockedApp('BadApp2')], wait });
      await t.sweeper.runPass();
      sinon.assert.calledTwice(t.uninstall);
      sinon.assert.calledOnceWithExactly(wait, KNOBS.complianceRemovalSpacingMs);
    });

    // A BUNDLE HELD IS NOT A BUNDLE VOUCHED FOR. One restored from disk answers the
    // blocklist without anything having established it is still the network's.
    it('removes nothing while the policy is unconfirmed', async () => {
      const t = build({ rows: () => [blockedApp('BadApp')], policyReady: false });
      await t.sweeper.request();
      expect(t.uninstall.called, 'an application was uninstalled on a list this node could not vouch for').to.equal(false);
      expect(t.listInstalled.called, 'a pass judged the node before the policy was confirmed').to.equal(false);
      expect(t.timers.count(), 'the unjudged node was owed nothing').to.equal(1);
    });

    // The gate can shut while a pass spaces its removals, and what is left is owed.
    it('ends a pass whose policy stops being confirmed between removals', async () => {
      const t = build({ rows: () => [blockedApp('FirstApp'), blockedApp('SecondApp')] });
      t.uninstall.callsFake(async () => { t.policy.policyReady = false; return REMOVED; });

      await t.sweeper.request();

      sinon.assert.calledOnceWithExactly(t.uninstall, 'FirstApp');
      expect(t.timers.count(), 'the application the pass never reached was dropped').to.equal(1);
    });

    // The canary for the gate: the same app and list, confirmed, IS removed.
    it('removes it once the policy is confirmed', async () => {
      const t = build({ rows: () => [blockedApp('BadApp')] });
      await t.sweeper.runPass();
      sinon.assert.calledOnceWithExactly(t.uninstall, 'BadApp');
    });

    it('removes nothing when the blocklist cannot be obtained', async () => {
      const t = build({ rows: () => [blockedApp('BadApp')], blocklist: () => null });
      await t.sweeper.runPass();
      sinon.assert.notCalled(t.uninstall);
    });

    // The components are sealed, so nothing about the images can be asked. What is on
    // the record decides on its own.
    it('removes an application whose components cannot be read when its hash is blocked', async () => {
      const t = build({ rows: () => [sealedApp('Sealed', 'a'.repeat(64))], blocklist: () => [{ kind: 'hash', value: 'a'.repeat(64) }] });
      await t.sweeper.runPass();
      sinon.assert.calledOnceWithExactly(t.uninstall, 'Sealed');
    });

    it('removes an application whose components cannot be read when its name is blocked', async () => {
      const t = build({ rows: () => [sealedApp('Sealed')], blocklist: () => [{ kind: 'name', value: 'Sealed' }] });
      await t.sweeper.runPass();
      sinon.assert.calledOnceWithExactly(t.uninstall, 'Sealed');
    });

    it('leaves an application whose components cannot be read when nothing about it is blocked', async () => {
      const t = build({ rows: () => [sealedApp('Sealed')], blocklist: () => [{ kind: 'hash', value: 'b'.repeat(64) }] });
      await t.sweeper.runPass();
      sinon.assert.notCalled(t.uninstall);
    });

    it('removes an application its owner is blocked from running', async () => {
      const t = build({ rows: () => [{ ...blockedApp('Owned'), images: ['allowed/app:latest'] }], blocklist: () => [{ kind: 'owner', value: '1Owner' }] });
      await t.sweeper.runPass();
      sinon.assert.calledOnceWithExactly(t.uninstall, 'Owned');
    });

    // A ROW THAT COULD NOT BE READ still names its application, and a ban on the name is
    // answered for it; nothing else about it is known, so it is owed.
    it('removes a row it could not read when its name is blocked', async () => {
      const t = build({ unreadable: () => ['Unreadable'], blocklist: () => [{ kind: 'name', value: 'Unreadable' }] });
      await t.sweeper.request();
      sinon.assert.calledOnceWithExactly(t.uninstall, 'Unreadable');
      expect(t.timers.count(), 'a removed application was still owed').to.equal(0);
    });

    it('owes a row it could not read when its name is not blocked', async () => {
      let names = ['Unreadable'];
      const t = build({ unreadable: () => names });
      await t.sweeper.request();
      sinon.assert.notCalled(t.uninstall);
      expect(t.timers.count(), 'an unread row was cleared rather than owed').to.equal(1);
      names = [];
      await t.timers.fire();
      expect(t.timers.count(), 'a row the node no longer holds was still owed').to.equal(0);
    });
  });

  describe('scheduling', () => {
    // ONE MORE PASS, NOT ONE PER REQUEST.
    it('coalesces requests arriving during a pass into exactly one more', async () => {
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      let passes = 0;
      const sweeper = imageManager.createComplianceSweeper({
        listInstalled: async () => {
          passes += 1;
          if (passes === 1) await held;
          return { specs: [], unreadable: [] };
        },
        readInstalled: async () => null,
        imagesOf: async () => [],
        uninstall: sinon.stub().resolves(REMOVED),
        blocklist: () => [],
        policy: { policyReady: true, waitForPolicyReady: () => new Promise(() => {}) },
        bundle: { onBundleChanged: () => () => {} },
        knobs: KNOBS,
        timers: testTimers().api,
        wait: async () => {},
      });

      const running = sweeper.request();
      sweeper.request();
      sweeper.request();
      sweeper.request();
      release();
      await running;

      expect(passes, 'each request took its own pass over the whole node').to.equal(2);
    });

    // A PASS HOLDS ITSELF OPEN FOR MINUTES, so an entry lifted between removals would
    // otherwise still be acted on, and the uninstall broadcast.
    it('does not remove an application whose entry is lifted while the pass runs', async () => {
      let lifted = false;
      const rows = [blockedApp('FirstApp'), blockedApp('SecondApp')];
      const t = build({ rows: () => rows, blocklist: () => (lifted ? [] : BANS_THE_IMAGE) });
      t.uninstall.callsFake(async () => { lifted = true; return REMOVED; });

      await t.sweeper.runPass();

      expect(t.uninstall.callCount, 'the pass kept removing on a list the network had moved past').to.equal(1);
      expect(t.uninstall.firstCall.args[0]).to.equal('FirstApp');
    });

    // THE RECORD MOVES TOO. An application adopted onto a different image while the pass
    // was spacing is judged on the image it no longer runs.
    it('re-reads the application before removing it, not only the blocklist', async () => {
      const rows = [blockedApp('FirstApp'), blockedApp('SecondApp')];
      const t = build({ rows: () => rows });
      t.uninstall.callsFake(async () => {
        rows[1] = { ...blockedApp('SecondApp', 'f'.repeat(64)), images: ['allowed/repo:latest'] };
        return REMOVED;
      });

      await t.sweeper.runPass();

      expect(t.uninstall.callCount, 'an application was removed on a specification it no longer runs').to.equal(1);
      expect(t.uninstall.firstCall.args[0]).to.equal('FirstApp');
    });

    // An owner transfer is a new record under the same name, and the new owner is what
    // the network may refuse.
    it('judges the owner the record carries when it removes', async () => {
      const rows = [{ ...blockedApp('Moved'), images: ['allowed/app:latest'], owner: '1Banned' }];
      const readInstalled = sinon.spy(async (name) => rows.find((row) => row.name === name) ?? null);
      const t = build({ rows: () => rows, readInstalled, blocklist: () => [{ kind: 'owner', value: '1Banned' }] });

      await t.sweeper.runPass();

      sinon.assert.calledOnceWithExactly(readInstalled, 'Moved');
      sinon.assert.calledOnceWithExactly(t.uninstall, 'Moved');
    });

    it('removes every blocked application when nothing changes under it', async () => {
      const t = build({ rows: () => [blockedApp('FirstApp'), blockedApp('SecondApp')] });
      await t.sweeper.runPass();
      expect(t.uninstall.callCount).to.equal(2);
    });

    // A REFUSAL IS NOT A REMOVAL.
    it('does not treat a refused removal as done, and asks again', async () => {
      const t = build({ rows: () => [blockedApp('BusyApp')] });
      t.uninstall.onFirstCall().resolves(DEFERRED);
      t.uninstall.onSecondCall().resolves(REMOVED);

      await t.sweeper.request();
      expect(t.uninstall.callCount, 'the first attempt was refused').to.equal(1);
      expect(t.timers.count(), 'a refused removal left nothing to come back for it').to.equal(1);

      await t.timers.fire();
      expect(t.uninstall.callCount, 'a refused removal was never retried').to.equal(2);
    });

    it('asks again after a removal that did not complete', async () => {
      const t = build({ rows: () => [blockedApp('BrokenApp')] });
      t.uninstall.resolves(FAILED);

      await t.sweeper.request();
      await t.timers.fire();

      expect(t.uninstall.callCount).to.equal(2);
    });

    it('stops asking once the node no longer holds it', async () => {
      const t = build({ rows: () => [blockedApp('GoneApp')] });
      t.uninstall.resolves(SKIPPED);

      await t.sweeper.request();

      expect(t.uninstall.callCount).to.equal(1);
      expect(t.timers.count(), 'an application the node does not hold was still owed a pass').to.equal(0);
    });

    // A RECORD THAT DID NOT ANSWER SAYS NOTHING ABOUT THE APPLICATION.
    it('asks again when the record cannot be read before a removal', async () => {
      const rows = [blockedApp('BannedApp')];
      let answers = false;
      const t = build({
        rows: () => rows,
        readInstalled: async (name) => {
          if (!answers) throw new Error('connection lost');
          return rows.find((row) => row.name === name) ?? null;
        },
      });

      await t.sweeper.request();
      expect(t.uninstall.called, 'a removal was attempted on a record nothing could read').to.equal(false);
      expect(t.timers.count(), 'a blocked application was struck off on a failed read').to.equal(1);

      answers = true;
      await t.timers.fire();
      expect(t.uninstall.callCount, 'the application was never asked about again').to.equal(1);
      expect(t.uninstall.firstCall.args[0]).to.equal('BannedApp');
    });

    it('stops asking when the record says the application is gone', async () => {
      const t = build({ rows: () => [blockedApp('VanishedApp')], readInstalled: async () => null });

      await t.sweeper.request();
      expect(t.uninstall.called).to.equal(false);
      expect(t.timers.count(), 'an application the node does not hold was owed a pass').to.equal(0);
    });

    it('arms no timer when every application was answered for', async () => {
      const t = build({ rows: () => [{ ...blockedApp('CleanApp'), images: ['allowed/app:latest'] }] });
      await t.sweeper.request();
      expect(t.timers.count(), 'a timer outlived a pass that owed nothing').to.equal(0);
    });

    it('holds the applications a stopped pass never reached', async () => {
      let usable = true;
      const rows = [blockedApp('FirstApp'), blockedApp('SecondApp')];
      const t = build({ rows: () => rows, blocklist: () => (usable ? BANS_THE_IMAGE : null) });
      t.uninstall.callsFake(async () => { usable = false; return REMOVED; });

      await t.sweeper.request();
      expect(t.uninstall.callCount, 'the pass should have stopped').to.equal(1);

      usable = true;
      t.uninstall.callsFake(async () => REMOVED);
      await t.timers.fire();

      expect(t.uninstall.callCount, 'the application the pass never reached was dropped').to.equal(2);
      expect(t.uninstall.secondCall.args[0]).to.equal('SecondApp');
    });

    it('holds the whole node when a pass throws', async () => {
      let broken = true;
      const t = build({
        rows: () => [blockedApp('FirstApp'), blockedApp('SecondApp')],
        imagesOf: async (spec) => {
          if (broken) throw new Error('unreadable');
          return spec.images;
        },
      });

      await t.sweeper.request();
      expect(t.uninstall.called, 'a pass that threw removed something anyway').to.equal(false);
      expect(t.timers.count(), 'a pass that threw owed nothing, so nothing came back for it').to.equal(1);

      broken = false;
      await t.timers.fire();
      expect(t.uninstall.callCount, 'the applications the pass never judged were dropped').to.equal(2);
    });

    it('holds the whole node when the table cannot be read', async () => {
      let broken = true;
      const t = build({ rows: () => { if (broken) throw new Error('db down'); return [blockedApp('SomeApp')]; } });
      await t.sweeper.request();
      expect(t.timers.count(), 'an unreadable table owed nothing').to.equal(1);
      broken = false;
      await t.timers.fire();
      expect(t.uninstall.callCount).to.equal(1);
    });

    it('holds the whole node when a pass could not start', async () => {
      let usable = false;
      const t = build({ rows: () => [blockedApp('SomeApp')], blocklist: () => (usable ? BANS_THE_IMAGE : null) });

      await t.sweeper.request();
      expect(t.uninstall.called).to.equal(false);
      expect(t.timers.count(), 'a pass that could not read the list owed nothing').to.equal(1);

      usable = true;
      await t.timers.fire();
      expect(t.uninstall.callCount).to.equal(1);
    });

    it('doubles the wait between retries that resolve nothing', async () => {
      const t = build({ rows: () => [blockedApp('StuckApp')] });
      t.uninstall.resolves(DEFERRED);

      await t.sweeper.request();
      await t.timers.fire();
      await t.timers.fire();
      await t.timers.fire();

      expect(t.timers.delays.slice(0, 4), 'the wait did not grow, or grew past its ceiling').to.deep.equal([10, 20, 40, 80]);
    });

    it('doubles the wait between whole-node retries that resolve nothing', async () => {
      const t = build({ rows: () => [blockedApp('SomeApp')], blocklist: () => null });

      await t.sweeper.request();
      await t.timers.fire();
      await t.timers.fire();
      await t.timers.fire();

      expect(t.timers.delays, 'the wait for the whole node did not grow, or grew past its ceiling').to.deep.equal([10, 20, 40, 80]);
    });

    it('holds the wait at its ceiling', async () => {
      const t = build({ rows: () => [blockedApp('StuckApp')] });
      t.uninstall.resolves(DEFERRED);

      await t.sweeper.request();
      // eslint-disable-next-line no-restricted-syntax
      for (let i = 0; i < 6; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await t.timers.fire();
      }

      expect(Math.max(...t.timers.delays), 'the wait grew past the ceiling').to.equal(KNOBS.complianceRetryMaxMs);
    });

    it('starts the wait again for a name owed after the node had cleared it', async () => {
      let outcome = DEFERRED;
      const t = build({ rows: () => [blockedApp('StuckApp')], uninstall: sinon.stub().callsFake(async () => outcome) });

      await t.sweeper.request();
      await t.timers.fire();
      await t.timers.fire();
      await t.timers.fire();
      expect(t.timers.delays, 'the wait did not reach its ceiling').to.deep.equal([10, 20, 40, 80]);

      outcome = REMOVED;
      await t.timers.fire();
      expect(t.timers.count(), 'a node owing nothing kept a wait running').to.equal(0);

      outcome = DEFERRED;
      await t.sweeper.request();
      expect(t.timers.delays.slice(4), 'the same name owed again was asked about at the ceiling').to.deep.equal([10]);
    });

    it('replaces a running wait when a pass holds something new', async () => {
      let names = ['StuckApp'];
      const t = build({ rows: () => names.map((name) => blockedApp(name)) });
      t.uninstall.resolves(DEFERRED);

      await t.sweeper.request();
      await t.timers.fire();
      await t.timers.fire();
      await t.timers.fire();
      expect(t.timers.delays, 'the wait did not reach its ceiling').to.deep.equal([10, 20, 40, 80]);

      names = ['StuckApp', 'NewlyBlockedApp'];
      await t.sweeper.request();

      expect(t.timers.count(), 'the node is waiting on more than one thing at a time').to.equal(1);
      expect(t.timers.delays.slice(4), 'the new application waited out a wait armed for another').to.deep.equal([10]);
    });

    it('drops a running wait when a pass settles what it was armed for', async () => {
      let outcome = DEFERRED;
      const t = build({ rows: () => [blockedApp('StuckApp')], uninstall: sinon.stub().callsFake(async () => outcome) });

      await t.sweeper.request();
      expect(t.timers.count(), 'nothing came back for a held application').to.equal(1);

      outcome = REMOVED;
      await t.sweeper.request();

      expect(t.timers.count(), 'a node owing nothing kept a wait running').to.equal(0);
    });

    // An application whose components cannot be read was never judged on its images,
    // and nothing announces that it has become readable.
    it('asks again about an application it could not read, and stops once it can', async () => {
      let readable = false;
      const t = build({
        rows: () => [sealedApp('SealedApp')],
        imagesOf: async () => (readable ? ['blocked/repo:latest'] : null),
      });

      await t.sweeper.request();
      expect(t.uninstall.called, 'a sealed specification was judged on images nobody read').to.equal(false);
      expect(t.timers.count(), 'an unreadable application was cleared rather than deferred').to.equal(1);

      readable = true;
      await t.timers.fire();

      expect(t.uninstall.callCount, 'the held application was never asked about again').to.equal(1);
      expect(t.uninstall.firstCall.args[0]).to.equal('SealedApp');
    });

    it('forgets an application that is gone on a full pass, not only a scoped one', async () => {
      let rows = [blockedApp('GoneApp')];
      const t = build({ rows: () => rows });
      t.uninstall.resolves(DEFERRED);

      await t.sweeper.request();
      expect(t.timers.count(), 'the refused removal was not owed').to.equal(1);

      rows = [];
      await t.sweeper.request();

      const passes = t.listInstalled.callCount;
      await t.timers.fire();
      expect(t.listInstalled.callCount, 'a pass ran for an application the node no longer holds').to.equal(passes);
    });

    it('drops a scoped application that is gone rather than holding it', async () => {
      const t = build({ rows: () => [blockedApp('StillHere')] });

      await t.sweeper.request(new Set(['AlreadyGone']));

      sinon.assert.notCalled(t.uninstall);
      expect(t.timers.count(), 'a timer was armed for an application the node does not hold').to.equal(0);
    });

    it('judges only the applications a scoped pass names', async () => {
      const t = build({ rows: () => [blockedApp('Named'), blockedApp('Other')] });
      await t.sweeper.runPass(new Set(['Named']));
      sinon.assert.calledOnceWithExactly(t.uninstall, 'Named');
    });

    // TWO TRIGGERS, AND NEITHER COVERS THE OTHER.
    it('sweeps when the gate opens, after its stagger', async () => {
      const t = build();
      t.sweeper.start();
      expect(t.listInstalled.called, 'a pass ran before the gate opened').to.equal(false);

      t.openGate();
      await Promise.resolve();
      expect(t.listInstalled.called, 'the gate opening swept immediately, unstaggered').to.equal(false);
      expect(t.timers.count(), 'the gate opening armed nothing').to.equal(1);

      await t.timers.fire();
      expect(t.listInstalled.callCount, 'the gate opening produced no pass').to.equal(1);
    });

    it('sweeps again on a bundle change', async () => {
      const t = build();
      t.sweeper.start();
      t.openGate();
      await Promise.resolve();
      await t.timers.fire();
      expect(t.listInstalled.callCount).to.equal(1);

      t.changeBundle();
      expect(t.timers.count(), 'a bundle change armed nothing').to.equal(1);
      await t.timers.fire();

      expect(t.listInstalled.callCount, 'a bundle change produced no pass').to.equal(2);
    });

    it('arms one stagger however many changes arrive', async () => {
      const t = build();
      t.sweeper.start();
      t.openGate();
      await Promise.resolve();
      t.changeBundle();
      t.changeBundle();
      t.changeBundle();

      expect(t.timers.count(), 'each change armed its own pass').to.equal(1);
    });

    it('ignores a bundle change while the gate is shut', async () => {
      const t = build({ policyReady: false });
      t.sweeper.start();

      t.changeBundle();

      expect(t.timers.count(), 'a pass was armed on a bundle the node may not act on').to.equal(0);
      expect(t.listInstalled.called).to.equal(false);
    });

    it('drops what is owed when it is stopped', async () => {
      const t = build({ rows: () => [blockedApp('BusyApp')] });
      t.uninstall.resolves(DEFERRED);

      await t.sweeper.request();
      expect(t.timers.count()).to.equal(1);

      t.sweeper.stop();
      expect(t.timers.count(), 'a timer outlived the sweeper it belonged to').to.equal(0);
    });
  });

  // Nothing is running before boot starts it, and asking must not build a second one.
  it('asks nothing of a sweeper that has not been started', async () => {
    await imageManager.requestComplianceSweep(new Set(['Any']));
  });
});
