const http = require('node:http');
const { expect } = require('chai');
const sinon = require('sinon');
const axios = require('axios');

const registryResponses = require('./data/registryResponses');

// stub out axiosGet, axiosInstance
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');

const { ImageVerifier } = require('../../ZelBack/src/services/utils/imageVerifier');
const registryGovernor = require('../../ZelBack/src/services/utils/registryGovernor');

describe('imageVerifier tests', () => {
  afterEach(() => {
    sinon.restore();
    // The governor is a process-level singleton keyed by registry host, so its
    // rate budget and cooldowns would otherwise carry from one test to the next.
    registryGovernor.reset();
  });

  describe('parse repoTag tests', () => {
    it('should parse complex repository correctly', async () => {
      const repotag = 'example.repository.com:50000/complex/namespace/split/image:latest';

      const verifier = new ImageVerifier(repotag);

      expect(verifier.provider).to.eql('example.repository.com:50000');
      expect(verifier.namespace).to.eql('complex/namespace');
      expect(verifier.repository).to.eql('split/image');
      expect(verifier.tag).to.eql('latest');
    });

    it('should parse basic repository correctly', async () => {
      const repotag = 'runonflux/website:latest';

      const verifier = new ImageVerifier(repotag);

      expect(verifier.provider).to.eql('registry-1.docker.io');
      expect(verifier.namespace).to.eql('runonflux');
      expect(verifier.repository).to.eql('website');
      expect(verifier.tag).to.eql('latest');
    });

    it('should parse basic repository correctly B', async () => {
      const repotag = 'runonflux/web_site:latest';

      const verifier = new ImageVerifier(repotag);

      expect(verifier.provider).to.eql('registry-1.docker.io');
      expect(verifier.namespace).to.eql('runonflux');
      expect(verifier.repository).to.eql('web_site');
      expect(verifier.tag).to.eql('latest');
    });

    it('should parse dockerhub library images correctly', async () => {
      const repotag = 'mysql:latest';

      const verifier = new ImageVerifier(repotag);

      expect(verifier.provider).to.eql('registry-1.docker.io');
      expect(verifier.namespace).to.eql('library');
      expect(verifier.repository).to.eql('mysql');
      expect(verifier.tag).to.eql('latest');
    });

    it('should parse basic registry api correctly', async () => {
      const repotag = 'ghcr.io/iron-fish/ironfish:mytag';

      const verifier = new ImageVerifier(repotag);

      expect(verifier.provider).to.eql('ghcr.io');
      expect(verifier.namespace).to.eql('iron-fish');
      expect(verifier.repository).to.eql('ironfish');
      expect(verifier.tag).to.eql('mytag');
    });

    it('should parse namespace of registry api correctly', async () => {
      const repotag = 'public.ecr.aws/docker/library/mongo:latest';

      const verifier = new ImageVerifier(repotag);

      expect(verifier.provider).to.eql('public.ecr.aws');
      expect(verifier.namespace).to.eql('docker/library');
      expect(verifier.repository).to.eql('mongo');
      expect(verifier.tag).to.eql('latest');
    });

    it('should handle leading backslahes correctly', async () => {
      const repotag = '/nginx:latest';

      const verifier = new ImageVerifier(repotag);
      console.log(verifier);

      expect(
        () => verifier.throwIfError(),
      ).to.throw('Image tag: "/nginx:latest" cannot start or end with a backslash.');

      expect(verifier.provider).to.eql(null);
      expect(verifier.namespace).to.eql(null);
      expect(verifier.repository).to.eql(null);
      expect(verifier.tag).to.eql(null);
    });

    it('should handle trailing backslahes correctly', async () => {
      const repotag = 'nginx:latest/';

      const verifier = new ImageVerifier(repotag);
      console.log(verifier);

      expect(
        () => verifier.throwIfError(),
      ).to.throw('Image tag: "nginx:latest/" cannot start or end with a backslash.');

      expect(verifier.provider).to.eql(null);
      expect(verifier.namespace).to.eql(null);
      expect(verifier.repository).to.eql(null);
      expect(verifier.tag).to.eql(null);
    });

    it('should handle unparseable repotags correctly', async () => {
      const repotags = ['@nginx:latest'];

      repotags.forEach((tag) => {
        const verifier = new ImageVerifier(tag);
        expect(
          () => verifier.throwIfError(),
        ).to.throw(`Image tag: ${tag} is not in valid format [HOST[:PORT_NUMBER]/][NAMESPACE/]REPOSITORY[:TAG]`);

        expect(verifier.provider).to.eql(null);
        expect(verifier.namespace).to.eql(null);
        expect(verifier.repository).to.eql(null);
        expect(verifier.tag).to.eql(null);
      });
    });
  });

  describe('parseImageReference tests', () => {
    const parse = (ref) => ImageVerifier.parseImageReference(ref);
    const digest = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

    it('parses a Docker Hub image with a tag', () => {
      const r = parse('nginx:latest');
      expect(r.error).to.be.undefined;
      expect(r.repository).to.equal('nginx');
      expect(r.tag).to.equal('latest');
      expect(r.digest).to.equal(null);
      expect(r.reference).to.equal('nginx');
    });

    it('reports a tagless reference with a null tag', () => {
      const r = parse('library/nginx');
      expect(r.tag).to.equal(null);
      expect(r.reference).to.equal('library/nginx');
    });

    it('does not mistake a registry port for a tag when tagged', () => {
      const r = parse('myregistry.com:5000/team/app:v1');
      expect(r.provider).to.equal('myregistry.com:5000');
      expect(r.tag).to.equal('v1');
      expect(r.reference).to.equal('myregistry.com:5000/team/app');
    });

    it('does not mistake a registry port for a tag when untagged', () => {
      const r = parse('myregistry.com:5000/team/app');
      expect(r.tag).to.equal(null);
      expect(r.reference).to.equal('myregistry.com:5000/team/app');
    });

    it('captures a digest and excludes it from the reference', () => {
      const r = parse(`library/redis:7@${digest}`);
      expect(r.tag).to.equal('7');
      expect(r.digest).to.equal(digest);
      expect(r.reference).to.equal('library/redis');
    });

    it('handles a digest with no tag', () => {
      const r = parse(`nginx@${digest}`);
      expect(r.tag).to.equal(null);
      expect(r.digest).to.equal(digest);
      expect(r.reference).to.equal('nginx');
    });

    it('rejects trailing content after the tag (end-anchored)', () => {
      expect(parse('nginx:latest:junk').error).to.be.a('string');
      expect(parse('nginx:tag@notadigest').error).to.be.a('string');
    });

    it('rejects malformed references', () => {
      expect(parse('Foo/Bar:latest').error).to.be.a('string'); // uppercase
      expect(parse('has space:tag').error).to.be.a('string');
      expect(parse('/leadingslash').error).to.be.a('string');
      expect(parse(42).error).to.equal('Invalid Docker Image Tag');
    });
  });

  describe('parseImageReference ReDoS safety', () => {
    // The blocklist/vetted lists are a flat mix of image repos, owner addresses,
    // and 64-char message/app hashes — all flow through the parser. A 64-char
    // hash once triggered catastrophic backtracking (event loop hung for minutes).
    // A safe parse is sub-millisecond; budget is generous to avoid CI flakiness
    // while still being orders of magnitude below any ReDoS (which is seconds+).
    const BUDGET_MS = 250;

    const realWorldTokens = [
      '6d691f2c09e08e9b6acf046a46566132bcf8dc6c0fbd2042e8faf087d5504e09', // the original culprit hash
      '36dfd682482f4d6d529b7164f3f6eda8c9862a6abbdcfa9f19b65282eed3e827',
      '1G3bo7vckii4hfDCM6ywagzvhQcWhSGVjB', // owner zelid (base58)
      '1BiVdDVq5qywspqiRuHPFk8NnJ2hDCT66Q',
      'tornadocash',
      'yurinnick/folding-at-home:latest',
      'registry.gitlab.com:443/group/sub/img:tag',
    ];

    // Generators that target the historical (a+)+ blow-up: long runs of each
    // name character class, then a tail that forces a full-string backtrack.
    const adversarial = [
      (n) => `${'a'.repeat(n)}!`,
      (n) => `${'a.'.repeat(n)}!`,
      (n) => `${'a-'.repeat(n)}!`,
      (n) => `${'a__'.repeat(n)}b!`,
      (n) => `${'a.-_'.repeat(n)}!`,
      (n) => `${'a-'.repeat(n)}/!`,
      (n) => '0123456789abcdef'.repeat(Math.ceil(n / 16)).slice(0, n),
    ];

    function parseMs(input) {
      const start = process.hrtime.bigint();
      ImageVerifier.parseImageReference(input);
      return Number(process.hrtime.bigint() - start) / 1e6;
    }

    it('parses real-world blocklist tokens (incl. hashes) within budget', () => {
      for (const token of realWorldTokens) {
        const ms = parseMs(token);
        expect(ms, `parsing ${token} took ${ms.toFixed(1)}ms`).to.be.below(BUDGET_MS);
      }
    });

    it('stays linear on adversarial inputs (no catastrophic backtracking)', () => {
      for (const gen of adversarial) {
        for (const n of [40, 64, 100]) {
          const input = gen(n);
          const ms = parseMs(input);
          expect(ms, `len=${input.length} took ${ms.toFixed(1)}ms`).to.be.below(BUDGET_MS);
        }
      }
    });
  });

  describe('parseAuthHeader tests', () => {
    it('should parse auth header correctly', async () => {
      const authHeader = 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:runonflux/secretwebsite:pull"';

      const result = ImageVerifier.parseAuthHeader(authHeader);

      expect(result.realm).to.eql('https://auth.docker.io/token');
      expect(result.service).to.eql('registry.docker.io');
      expect(result.scope).to.eql('repository:runonflux/secretwebsite:pull');
    });
    it('should parse auth header with underscores correctly', async () => {
      const authHeader = 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:jeffvaderflux/helloworld_params:pull"';

      const result = ImageVerifier.parseAuthHeader(authHeader);

      expect(result.realm).to.eql('https://auth.docker.io/token');
      expect(result.service).to.eql('registry.docker.io');
      expect(result.scope).to.eql('repository:jeffvaderflux/helloworld_params:pull');
    });
  });

  describe('errorClass taxonomy tests', () => {
    let axiosGetStub;

    beforeEach(() => {
      axiosGetStub = sinon.stub(serviceHelper, 'axiosGet');
      sinon.stub(serviceHelper, 'axiosInstance').returns({ get: axiosGetStub, interceptors: { request: { use: sinon.stub() } } });
    });

    const failWith = (mutate) => async () => {
      const error = new Error('Test Error');
      mutate(error);
      throw error;
    };

    it('classifies a timeout as transient (a socket failure is connectivity, not a registry verdict)', async () => {
      axiosGetStub.callsFake(failWith((e) => { e.code = 'ETIMEDOUT'; }));
      const verifier = new ImageVerifier('megachips/ipshow:web');
      await verifier.verifyImage();
      expect(verifier.errorClass).to.equal('transient');
      expect(verifier.errorMeta.errorType).to.equal('network');
    });

    it('classifies a no-response failure with an unlisted code as transient', async () => {
      axiosGetStub.callsFake(failWith((e) => { e.code = 'EPROTO'; e.request = {}; }));
      const verifier = new ImageVerifier('megachips/ipshow:web');
      await verifier.verifyImage();
      expect(verifier.errorClass).to.equal('transient');
    });

    it('classifies a rate limit (429) as transient', async () => {
      axiosGetStub.callsFake(failWith((e) => { e.response = { status: 429 }; }));
      const verifier = new ImageVerifier('megachips/ipshow:web');
      await verifier.verifyImage();
      expect(verifier.errorClass).to.equal('transient');
    });

    it('classifies an HTTP rejection (404) as permanent - the registry answered', async () => {
      axiosGetStub.callsFake(failWith((e) => { e.response = { status: 404 }; }));
      const verifier = new ImageVerifier('megachips/ipshow:web');
      await verifier.verifyImage();
      expect(verifier.errorClass).to.equal('permanent');
    });

    it('classifies a malformed tag as permanent and reads null with no error', () => {
      const bad = new ImageVerifier('not a valid tag at all');
      expect(bad.errorClass).to.equal('permanent');
      const fine = new ImageVerifier('megachips/ipshow:web');
      expect(fine.errorClass).to.equal(null);
    });

    it('throwIfError carries the class on the thrown error', async () => {
      axiosGetStub.callsFake(failWith((e) => { e.code = 'ECONNREFUSED'; }));
      const verifier = new ImageVerifier('megachips/ipshow:web');
      await verifier.verifyImage();
      try {
        verifier.throwIfError();
        expect.fail('throwIfError should have thrown');
      } catch (err) {
        expect(err.registryErrorClass).to.equal('transient');
      }
    });
  });

  describe('verifyImage tests', async () => {
    let axiosGetStub;
    let axiosInterceptorsUse;

    const unauthorizedError = (auth) => {
      const error = new Error('AxiosError: Request failed with status code 401');
      error.code = 'ERR_BAD_REQUEST';
      error.response = {
        status: 401,
        statusText: 'Unauthorized',
        headers: {
          'www-authenticate': auth,
        },
      };
      return error;
    };

    beforeEach(() => {
      axiosInterceptorsUse = sinon.stub().returns();
      axiosGetStub = sinon.stub(serviceHelper, 'axiosGet');
      sinon.stub(serviceHelper, 'axiosInstance').returns({ get: axiosGetStub, interceptors: { request: { use: axiosInterceptorsUse } } });
    });

    it('should throw if connection error', async () => {
      const repotag = 'megachips/ipshow:web';

      axiosGetStub.callsFake(async (url) => {
        if (url === 'megachips/ipshow/manifests/web') {
          const error = new Error('Test Error');
          error.code = 'ENETUNREACH';
          throw error;
        }

        return { data: null };
      });

      const verifier = new ImageVerifier(repotag);

      await verifier.verifyImage();

      expect(() => verifier.throwIfError()).to.throw(`Connection Error ENETUNREACH: ${repotag} not available`);
    });

    it('should throw if HTTP error other than 401', async () => {
      const repotag = 'megachips/ipshow:web';

      axiosGetStub.callsFake(async (url) => {
        if (url === 'megachips/ipshow/manifests/web') {
          const error = new Error('Test Error');
          error.code = 'ERR_BAD_REQUEST';
          error.response = {
            status: 500,
            statusText: 'It is busted',
          };
          throw error;
        }

        return { data: null };
      });

      const verifier = new ImageVerifier(repotag);

      await verifier.verifyImage();

      expect(() => verifier.throwIfError()).to.throw(`Bad HTTP Status 500: ${repotag} not available`);
    });

    it('should throw if www-authenticate header is malformed', async () => {
      const repotag = 'megachips/ipshow:web';

      axiosGetStub.callsFake(async (url) => {
        const authHeader = 'Bearer MalformedHeader';

        if (url === 'megachips/ipshow/manifests/web') {
          throw unauthorizedError(authHeader);
        }

        return { data: null };
      });

      const verifier = new ImageVerifier(repotag);

      await verifier.verifyImage();

      expect(() => verifier.throwIfError()).to.throw(`Malformed Auth Header: ${repotag} not available`);
    });

    it('should call auth endpoint with correct url params, and set auth details if authed', async () => {
      const repotag = 'megachips/ipshow:web';
      const authHeader = 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:megachips/ipshow:pull"';
      const expected = 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:megachips/ipshow:pull';

      axiosGetStub.callsFake(async (url) => {
        if (url.match('https://auth.docker.io')) {
          return { data: { token: 'myToken' } };
        }

        if (url === 'megachips/ipshow/manifests/web') {
          throw unauthorizedError(authHeader);
        }

        return { data: null };
      });

      const verifier = new ImageVerifier(repotag);

      await verifier.verifyImage();

      sinon.assert.calledWith(axiosGetStub, expected);
      expect(verifier.authConfigured).to.equal(true);
      expect(verifier.authVerified).to.equal(true);
    });

    it('should call auth endpoint with correct url params, and not set auth details if not authed', async () => {
      const repotag = 'megachips/ipshow:web';
      const authHeader = 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:megachips/ipshow:pull"';
      const expected = 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:megachips/ipshow:pull';

      axiosGetStub.callsFake(async (url) => {
        if (url.match('https://auth.docker.io')) {
          const error = new Error('Test auauthorized');
          error.response = { status: 401 };
          throw error;
        }

        if (url === 'megachips/ipshow/manifests/web') {
          throw unauthorizedError(authHeader);
        }

        return { data: null };
      });

      const verifier = new ImageVerifier(repotag);

      await verifier.verifyImage();

      sinon.assert.calledWith(axiosGetStub, expected);
      expect(verifier.authConfigured).to.equal(false);
      expect(verifier.authVerified).to.equal(false);
      expect(() => verifier.throwIfError()).to.throw(`Authentication rejected for: ${repotag}`);
    });

    it('should throw if unknown image tag', async () => {
      const repotag = 'unknown/image:tag';

      // the way this works with the registry (docker at least) is that it will deny
      // any request first off, even to non existent. It will then let you auth to a non existent
      // repository, and tell you that you're non authorized again.

      axiosGetStub.callsFake(async (url) => {
        const authHeader = 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:unknown/image:pull"';

        if (url.match('https://auth.docker.io')) {
          return { data: { token: 'mytoken' } };
        }

        if (url === 'unknown/image/manifests/tag') {
          throw unauthorizedError(authHeader);
        }

        return { data: null };
      });

      const verifier = new ImageVerifier(repotag);
      await verifier.verifyImage();

      expect(() => verifier.throwIfError()).to.throw(`Authentication failed: ${repotag} not available or doesn't exist`);
    });

    it('should not throw if a docker manifest arch matches the Flux network arches and under max size', async () => {
      const repotag = 'megachips/ipshow:web';

      axiosGetStub.callsFake(async (url) => {
        if (url === 'megachips/ipshow/manifests/web') {
          return { data: registryResponses.distributionManifestAmd64 };
        }
        if (url === 'megachips/ipshow/blobs/sha256:87a2490a12aed4100891be53b521da77508dafef1d49422f7eb5088c6eb1631a') {
          return { data: registryResponses.imageConfigAmd64 };
        }

        return { data: null };
      });

      const verifier = new ImageVerifier(repotag);
      const result = await verifier.verifyImage();

      expect(result).to.equal(true);
      expect(() => verifier.throwIfError()).to.not.throw();
      // compressed layer sum surfaced for the early rootFs-fit reject
      expect(verifier.imageSizeBytes).to.equal(193911453);
    });

    it('should throw if a docker manifest arch does not match the Flux network', async () => {
      const repotag = 'megachips/ipshow:web';

      axiosGetStub.callsFake(async (url) => {
        if (url === 'megachips/ipshow/manifests/web') {
          return { data: registryResponses.distributionManifestListUnsupported };
        }

        return { data: null };
      });

      const verifier = new ImageVerifier(repotag);
      const result = await verifier.verifyImage();

      expect(result).to.equal(false);
      expect(() => verifier.throwIfError()).to.throw(`Docker image: ${repotag} does not have a valid architecture`);
    });

    it('should throw if a docker manifest arch is over max size', async () => {
      const repotag = 'megachips/ipshow:web';

      axiosGetStub.callsFake(async (url) => {
        if (url === 'megachips/ipshow/manifests/web') {
          return { data: registryResponses.oversizeDistributionManifestAmd64 };
        }
        if (url === 'megachips/ipshow/blobs/sha256:87a2490a12aed4100891be53b521da77508dafef1d49422f7eb5088c6eb1631a') {
          return { data: registryResponses.imageConfigAmd64 };
        }

        return { data: null };
      });

      const verifier = new ImageVerifier(repotag);
      const result = await verifier.verifyImage();

      expect(result).to.equal(false);
      expect(() => verifier.throwIfError()).to.throw(`Docker image: ${repotag} size is over Flux limit`);
    });

    it('should not throw if an oci manifest arch matches the Flux network and under max size', async () => {
      const repotag = 'megachips/ipshow:web';

      axiosGetStub.callsFake(async (url) => {
        if (url === 'megachips/ipshow/manifests/web') {
          return { data: registryResponses.ociManifestAmd64 };
        }
        if (url === 'megachips/ipshow/blobs/sha256:05247af918647d8d063d2e880cc65c1546a7d616cde1e6c6f5dab1ca091f6cf8') {
          return { data: registryResponses.imageConfigAmd64 };
        }

        return { data: null };
      });

      const verifier = new ImageVerifier(repotag);
      const result = await verifier.verifyImage();

      expect(result).to.equal(true);
      expect(() => verifier.throwIfError()).to.not.throw();
    });

    it('should throw if an oci manifest arch does not match the Flux network', async () => {
      const repotag = 'megachips/ipshow:web';

      axiosGetStub.callsFake(async (url) => {
        if (url === 'megachips/ipshow/manifests/web') {
          return { data: registryResponses.ociIndexUnsupported };
        }

        return { data: null };
      });

      const verifier = new ImageVerifier(repotag);
      const result = await verifier.verifyImage();

      expect(result).to.equal(false);
      expect(() => verifier.throwIfError()).to.throw(`Docker image: ${repotag} does not have a valid architecture`);
    });

    it('should throw if an oci manifest arch is not under max size', async () => {
      const repotag = 'megachips/ipshow:web';

      axiosGetStub.callsFake(async (url) => {
        if (url === 'megachips/ipshow/manifests/web') {
          return { data: registryResponses.oversizeOciManifestAmd64 };
        }
        if (url === 'megachips/ipshow/blobs/sha256:05247af918647d8d063d2e880cc65c1546a7d616cde1e6c6f5dab1ca091f6cf8') {
          return { data: registryResponses.imageConfigAmd64 };
        }

        return { data: null };
      });

      const verifier = new ImageVerifier(repotag);
      const result = await verifier.verifyImage();

      expect(result).to.equal(false);
      expect(() => verifier.throwIfError()).to.throw(`Docker image: ${repotag} size is over Flux limit`);
    });

    it('should not throw if valid distribution list and manifests received', async () => {
      const repotag = 'megachips/ipshow:web';

      const amd64Sha = 'sha256:2c62993fdc4eef2077030894893391a8d1b4b785106f25495af734e474c7c019';
      const arm64Sha = 'sha256:fe983a72f65856381bbf5376f5bd1f3a6961ee83bfd7f0d35e087ac655b3688a';

      axiosGetStub.callsFake(async (url) => {
        if (url === 'megachips/ipshow/manifests/web') {
          return { data: registryResponses.distributionManifestList };
        }

        if (url === `megachips/ipshow/manifests/${amd64Sha}`) {
          return { data: registryResponses.distributionManifestAmd64 };
        }

        if (url === `megachips/ipshow/manifests/${arm64Sha}`) {
          return { data: registryResponses.distributionManifestArm64 };
        }

        return { data: null };
      });

      const verifier = new ImageVerifier(repotag);
      const result = await verifier.verifyImage();

      // Docker Hub is count-capped, not rate-capped, so the governor paces
      // nothing here and the architectures are walked back to back - this used
      // to cost a second of sleep each. Per architecture: one manifest plus one
      // layer size read, which this stub answers without a 206, so the layer is
      // unmeasured and the remaining layers are not asked for.
      expect(result).to.equal(true);
      expect(axiosGetStub.callCount).to.equal(5);
      expect(verifier.decompressedSizeBytes).to.equal(0);
      expect(() => verifier.throwIfError()).to.not.throw();
    });

    it('should not throw if valid oci index and manifests received', async () => {
      const repotag = 'megachips/ipshow:web';

      const amd64Sha = 'sha256:d4990507327f4d08aaf57d9c7e2e0250260e9f6ef7fa0e0bfe822c37ad2e1b2f';
      const arm64Sha = 'sha256:dcc6b4356cc567e868a96085402ecc10555a3d2a5b4a7d5e86172b21fe2a7890';

      axiosGetStub.callsFake(async (url) => {
        if (url === 'megachips/ipshow/manifests/web') {
          return { data: registryResponses.ociIndex };
        }

        if (url === `megachips/ipshow/manifests/${amd64Sha}`) {
          return { data: registryResponses.ociManifestAmd64 };
        }

        if (url === `megachips/ipshow/manifests/${arm64Sha}`) {
          return { data: registryResponses.ociManifestArm64 };
        }

        return { data: null };
      });

      const verifier = new ImageVerifier(repotag);
      const result = await verifier.verifyImage();

      // Docker Hub is count-capped, not rate-capped, so the governor paces
      // nothing here and the architectures are walked back to back - this used
      // to cost a second of sleep each. Per architecture: one manifest plus one
      // layer size read, which this stub answers without a 206, so the layer is
      // unmeasured and the remaining layers are not asked for.
      expect(result).to.equal(true);
      expect(axiosGetStub.callCount).to.equal(5);
      expect(verifier.decompressedSizeBytes).to.equal(0);
      expect(() => verifier.throwIfError()).to.not.throw();
    });

    it('should mark image as useable if image validates and an arch matches local system', async () => {
      const clock = sinon.useFakeTimers();

      const repotag = 'megachips/ipshow:web';

      const amd64Sha = 'sha256:d4990507327f4d08aaf57d9c7e2e0250260e9f6ef7fa0e0bfe822c37ad2e1b2f';
      const arm64Sha = 'sha256:dcc6b4356cc567e868a96085402ecc10555a3d2a5b4a7d5e86172b21fe2a7890';

      axiosGetStub.callsFake(async (url) => {
        if (url === 'megachips/ipshow/manifests/web') {
          return { data: registryResponses.ociIndex };
        }

        if (url === `megachips/ipshow/manifests/${amd64Sha}`) {
          return { data: registryResponses.ociManifestAmd64 };
        }

        if (url === `megachips/ipshow/manifests/${arm64Sha}`) {
          return { data: registryResponses.ociManifestArm64 };
        }

        return { data: null };
      });

      const verifier = new ImageVerifier(repotag, { architecture: 'arm64' });
      const promise = verifier.verifyImage();

      // because of aws ratelimiting, we send one per second
      await clock.tickAsync(2000);

      const result = await promise;

      expect(result).to.equal(true);
      expect(() => verifier.throwIfError()).to.not.throw();
      expect(verifier.supported).to.equal(true);
    });

    it('should mark image as not useable if image validates and an arch does not match local system', async () => {
      const clock = sinon.useFakeTimers();

      const repotag = 'megachips/ipshow:web';

      const amd64Sha = 'sha256:d4990507327f4d08aaf57d9c7e2e0250260e9f6ef7fa0e0bfe822c37ad2e1b2f';
      const arm64Sha = 'sha256:dcc6b4356cc567e868a96085402ecc10555a3d2a5b4a7d5e86172b21fe2a7890';

      axiosGetStub.callsFake(async (url) => {
        if (url === 'megachips/ipshow/manifests/web') {
          return { data: registryResponses.ociIndex };
        }

        if (url === `megachips/ipshow/manifests/${amd64Sha}`) {
          return { data: registryResponses.ociManifestAmd64 };
        }

        if (url === `megachips/ipshow/manifests/${arm64Sha}`) {
          return { data: registryResponses.ociManifestArm64 };
        }

        return { data: null };
      });

      const verifier = new ImageVerifier(repotag, { architecture: 'mips64' });
      const promise = verifier.verifyImage();

      // because of aws ratelimiting, we send one per second
      await clock.tickAsync(2000);

      const result = await promise;

      expect(result).to.equal(true);
      expect(() => verifier.throwIfError()).to.not.throw();
      expect(verifier.supported).to.equal(false);
    });
  });

  describe('decompressed size measurement tests', () => {
    const repotag = 'megachips/ipshow:web';
    const configDigest = 'sha256:c0f1900000000000000000000000000000000000000000000000000000000000';
    const layerDigest = 'sha256:1a4e000000000000000000000000000000000000000000000000000000000000';
    const secondLayerDigest = 'sha256:2b5f000000000000000000000000000000000000000000000000000000000000';
    const gzipMediaType = 'application/vnd.docker.image.rootfs.diff.tar.gzip';
    const zstdMediaType = 'application/vnd.oci.image.layer.v1.tar+zstd';
    const ISIZE_MODULUS = 2 ** 32;
    // what every production caller passes (config.fluxapps.maxImageSize)
    const maxImageSize = 5_000_000_000;

    let axiosGetStub;

    const manifestOf = (layers) => ({
      schemaVersion: 2,
      mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
      config: { mediaType: 'application/vnd.docker.container.image.v1+json', size: 4096, digest: configDigest },
      layers,
    });

    const gzipTrailer = (isize) => {
      const buffer = Buffer.alloc(4);
      buffer.writeUInt32LE(isize);
      return buffer;
    };

    // RFC 8878 frame header: magic, a descriptor asking for the 8-byte
    // Frame_Content_Size with no dictionary, the window descriptor, then the size.
    const zstdFrameHeader = (contentSize) => {
      const buffer = Buffer.alloc(14);
      buffer.writeUInt32LE(0xfd2fb528, 0);
      buffer.writeUInt8(0xc0, 4);
      buffer.writeUInt8(0x73, 5);
      buffer.writeBigUInt64LE(BigInt(contentSize), 6);
      return buffer;
    };

    // Answers the manifest and the image config, and hands every blob range read
    // to `blobs` - a digest -> axios response map. Anything else reads as a
    // registry that did not answer the range.
    const serveManifest = (manifest, blobs) => {
      axiosGetStub.callsFake(async (url, requestConfig) => {
        if (url === 'megachips/ipshow/manifests/web') return { data: manifest };
        if (url === `megachips/ipshow/blobs/${configDigest}`) return { data: registryResponses.imageConfigAmd64 };

        const digest = url.replace('megachips/ipshow/blobs/', '');
        const blob = blobs[digest];
        if (blob) return typeof blob === 'function' ? blob(requestConfig) : blob;

        return { data: null };
      });
    };

    beforeEach(() => {
      axiosGetStub = sinon.stub(serviceHelper, 'axiosGet');
      sinon.stub(serviceHelper, 'axiosInstance').returns({
        get: axiosGetStub,
        interceptors: { request: { use: sinon.stub() } },
      });
    });

    it('reads a single gzip member exactly and asks only for the trailer', async () => {
      // alpine:3.20 as measured against Docker Hub: one layer, no wrap possible.
      const compressed = 3_630_321;
      let requestedRange = null;

      serveManifest(
        manifestOf([{ mediaType: gzipMediaType, size: compressed, digest: layerDigest }]),
        {
          [layerDigest]: (requestConfig) => {
            requestedRange = requestConfig.headers.Range;
            return { status: 206, data: gzipTrailer(8_092_160) };
          },
        },
      );

      const verifier = new ImageVerifier(repotag, { maxImageSize });
      await verifier.verifyImage();

      expect(requestedRange).to.equal(`bytes=${compressed - 4}-${compressed - 1}`);
      expect(verifier.decompressedSizeBytes).to.equal(8_092_160);
      expect(verifier.decompressedSizeClearanceBytes).to.equal(8_092_160);
      expect(verifier.decompressedSizeAmbiguous).to.equal(false);
      expect(verifier.imageSizeBytes).to.equal(compressed);
    });

    it('sums the layers of a multi-layer image', async () => {
      serveManifest(
        manifestOf([
          { mediaType: gzipMediaType, size: 3_630_321, digest: layerDigest },
          { mediaType: gzipMediaType, size: 2_206_402, digest: secondLayerDigest },
        ]),
        {
          [layerDigest]: { status: 206, data: gzipTrailer(8_092_160) },
          [secondLayerDigest]: { status: 206, data: gzipTrailer(4_648_960) },
        },
      );

      const verifier = new ImageVerifier(repotag, { maxImageSize });
      await verifier.verifyImage();

      expect(verifier.decompressedSizeBytes).to.equal(8_092_160 + 4_648_960);
    });

    it('corrects a wrapped trailer upwards to the smallest plausible candidate', async () => {
      // pytorch-shaped: a 3.62 GB compressed layer whose trailer reads 3.27 GB,
      // which is less than the compressed form - it wrapped once.
      const compressed = 3_620_000_000;
      const rawTrailer = 3_270_000_000;

      serveManifest(
        manifestOf([{ mediaType: gzipMediaType, size: compressed, digest: layerDigest }]),
        { [layerDigest]: { status: 206, data: gzipTrailer(rawTrailer) } },
      );

      const verifier = new ImageVerifier(repotag, { maxImageSize });
      await verifier.verifyImage();

      expect(verifier.decompressedSizeBytes).to.equal(rawTrailer + ISIZE_MODULUS);
      expect(verifier.decompressedSizeBytes).to.be.above(7.5e9);
      expect(verifier.decompressedSizeBytes).to.be.below(7.6e9);
    });

    it('carries the next candidate when the wrapped trailer is ambiguous', async () => {
      const compressed = 3_620_000_000;
      const rawTrailer = 3_270_000_000;

      serveManifest(
        manifestOf([{ mediaType: gzipMediaType, size: compressed, digest: layerDigest }]),
        { [layerDigest]: { status: 206, data: gzipTrailer(rawTrailer) } },
      );

      const verifier = new ImageVerifier(repotag, { maxImageSize });
      await verifier.verifyImage();

      // 7.56 GB at 2.09x and 11.86 GB at 3.28x are both realistic for one layer,
      // so the larger is what a declaration has to clear.
      expect(verifier.decompressedSizeAmbiguous).to.equal(true);
      expect(verifier.decompressedSizeClearanceBytes)
        .to.equal(rawTrailer + ISIZE_MODULUS * 2);
      expect(Math.ceil(verifier.decompressedSizeClearanceBytes / 1e9)).to.equal(12);
    });

    it('leaves a wrapped trailer unambiguous when the next candidate is implausible', async () => {
      // 1 GB compressed: 4.79 GB is plausible, the 9.09 GB after it is not.
      const compressed = 1_000_000_000;
      const rawTrailer = 500_000_000;

      serveManifest(
        manifestOf([{ mediaType: gzipMediaType, size: compressed, digest: layerDigest }]),
        { [layerDigest]: { status: 206, data: gzipTrailer(rawTrailer) } },
      );

      const verifier = new ImageVerifier(repotag, { maxImageSize });
      await verifier.verifyImage();

      expect(verifier.decompressedSizeBytes).to.equal(rawTrailer + ISIZE_MODULUS);
      expect(verifier.decompressedSizeAmbiguous).to.equal(false);
      expect(verifier.decompressedSizeClearanceBytes).to.equal(rawTrailer + ISIZE_MODULUS);
    });

    it('trusts a small layer trailer that reads below its compressed size', async () => {
      // Under 2^32/1032 no amount of deflate can reach the modulus, so a low ratio
      // is just an incompressible layer, not a wrap.
      serveManifest(
        manifestOf([{ mediaType: gzipMediaType, size: 4_000_000, digest: layerDigest }]),
        { [layerDigest]: { status: 206, data: gzipTrailer(3_900_000) } },
      );

      const verifier = new ImageVerifier(repotag, { maxImageSize });
      await verifier.verifyImage();

      expect(verifier.decompressedSizeBytes).to.equal(3_900_000);
      expect(verifier.decompressedSizeAmbiguous).to.equal(false);
    });

    it('reads Frame_Content_Size from a zstd layer and asks only for the header', async () => {
      let requestedRange = null;

      serveManifest(
        manifestOf([{ mediaType: zstdMediaType, size: 4_000_000_000, digest: layerDigest }]),
        {
          [layerDigest]: (requestConfig) => {
            requestedRange = requestConfig.headers.Range;
            return { status: 206, data: zstdFrameHeader(12_000_000_000) };
          },
        },
      );

      const verifier = new ImageVerifier(repotag, { maxImageSize });
      await verifier.verifyImage();

      expect(requestedRange).to.equal('bytes=0-17');
      // 64-bit and exact - no modulus, so a zstd layer is never ambiguous.
      expect(verifier.decompressedSizeBytes).to.equal(12_000_000_000);
      expect(verifier.decompressedSizeAmbiguous).to.equal(false);
    });

    it('leaves the image unmeasured when a zstd layer omits Frame_Content_Size', async () => {
      // Descriptor 0x00: no Frame_Content_Size, which a streaming compressor is
      // entitled to omit. The readable layer alongside it must not be reported as
      // if it were the whole image.
      const header = Buffer.alloc(14);
      header.writeUInt32LE(0xfd2fb528, 0);
      header.writeUInt8(0x00, 4);
      header.writeUInt8(0x73, 5);

      serveManifest(
        manifestOf([
          { mediaType: gzipMediaType, size: 3_630_321, digest: layerDigest },
          { mediaType: zstdMediaType, size: 4_000_000_000, digest: secondLayerDigest },
        ]),
        {
          [layerDigest]: { status: 206, data: gzipTrailer(8_092_160) },
          [secondLayerDigest]: { status: 206, data: header },
        },
      );

      const verifier = new ImageVerifier(repotag, { maxImageSize });
      await verifier.verifyImage();

      expect(verifier.decompressedSizeBytes).to.equal(0);
      expect(verifier.decompressedSizeClearanceBytes).to.equal(0);
    });

    it('leaves the layer unmeasured when the range is answered 200 rather than 206', async () => {
      serveManifest(
        manifestOf([{ mediaType: gzipMediaType, size: 3_630_321, digest: layerDigest }]),
        { [layerDigest]: { status: 200, data: gzipTrailer(8_092_160) } },
      );

      const verifier = new ImageVerifier(repotag, { maxImageSize });
      const result = await verifier.verifyImage();

      expect(result).to.equal(true);
      expect(verifier.decompressedSizeBytes).to.equal(0);
      expect(() => verifier.throwIfError()).to.not.throw();
    });

    it('leaves the layer unmeasured when the blob request fails', async () => {
      serveManifest(
        manifestOf([{ mediaType: gzipMediaType, size: 3_630_321, digest: layerDigest }]),
        { [layerDigest]: () => { throw new Error('CDN unavailable'); } },
      );

      const verifier = new ImageVerifier(repotag, { maxImageSize });
      const result = await verifier.verifyImage();

      // A blob that cannot be read is not a verdict on the image.
      expect(result).to.equal(true);
      expect(verifier.decompressedSizeBytes).to.equal(0);
      expect(() => verifier.throwIfError()).to.not.throw();
    });

    it('leaves the image unmeasured on an unknown layer media type, and stops reading', async () => {
      serveManifest(
        manifestOf([
          { mediaType: 'application/vnd.oci.image.layer.v1.tar', size: 1_000, digest: layerDigest },
          { mediaType: gzipMediaType, size: 3_630_321, digest: secondLayerDigest },
        ]),
        { [secondLayerDigest]: { status: 206, data: gzipTrailer(8_092_160) } },
      );

      const verifier = new ImageVerifier(repotag, { maxImageSize });
      await verifier.verifyImage();

      expect(verifier.decompressedSizeBytes).to.equal(0);
      const blobReads = axiosGetStub.getCalls()
        .filter((call) => call.args[0].includes('/blobs/') && call.args[1]);
      expect(blobReads).to.have.lengthOf(0);
    });

    it('leaves the image unmeasured when one architecture cannot be read', async () => {
      const clock = sinon.useFakeTimers();
      const amd64Sha = 'sha256:2c62993fdc4eef2077030894893391a8d1b4b785106f25495af734e474c7c019';
      const arm64Sha = 'sha256:fe983a72f65856381bbf5376f5bd1f3a6961ee83bfd7f0d35e087ac655b3688a';

      axiosGetStub.callsFake(async (url) => {
        if (url === 'megachips/ipshow/manifests/web') return { data: registryResponses.distributionManifestList };
        if (url === `megachips/ipshow/manifests/${amd64Sha}`) {
          return { data: manifestOf([{ mediaType: gzipMediaType, size: 3_630_321, digest: layerDigest }]) };
        }
        if (url === `megachips/ipshow/manifests/${arm64Sha}`) {
          return { data: manifestOf([{ mediaType: gzipMediaType, size: 2_206_402, digest: secondLayerDigest }]) };
        }
        if (url === `megachips/ipshow/blobs/${layerDigest}`) return { status: 206, data: gzipTrailer(8_092_160) };

        return { data: null };
      });

      const verifier = new ImageVerifier(repotag, { maxImageSize });
      const promise = verifier.verifyImage();
      await clock.tickAsync(2000);
      await promise;

      // amd64 measured, arm64 not - the image runs on either, so nothing is known.
      expect(verifier.decompressedSizeBytes).to.equal(0);
    });
  });

  describe('decompressed size measurement over a redirect', () => {
    const trailerIsize = 8_092_160;
    const compressed = 3_630_321;
    const configDigest = 'sha256:c0f1900000000000000000000000000000000000000000000000000000000000';
    const layerDigest = 'sha256:1a4e000000000000000000000000000000000000000000000000000000000000';

    let registry;
    let cdn;
    let cdnRequest;

    // Blob GETs are redirected to object storage in practice, so the Range header
    // has to survive the hop follow-redirects makes. Two real servers on different
    // ports, so the redirect is cross-origin as it is against a real registry.
    beforeEach(async () => {
      cdnRequest = null;

      cdn = http.createServer((req, res) => {
        cdnRequest = { url: req.url, range: req.headers.range };
        if (!req.headers.range) {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(Buffer.alloc(1024));
          return;
        }
        const trailer = Buffer.alloc(4);
        trailer.writeUInt32LE(trailerIsize);
        res.writeHead(206, {
          'Content-Type': 'application/octet-stream',
          'Content-Range': `bytes ${compressed - 4}-${compressed - 1}/${compressed}`,
        });
        res.end(trailer);
      });
      await new Promise((resolve) => { cdn.listen(0, '127.0.0.1', resolve); });

      registry = http.createServer((req, res) => {
        if (req.url === '/v2/megachips/ipshow/manifests/web') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            schemaVersion: 2,
            mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
            config: { mediaType: 'application/vnd.docker.container.image.v1+json', size: 4096, digest: configDigest },
            layers: [{ mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip', size: compressed, digest: layerDigest }],
          }));
          return;
        }
        if (req.url === `/v2/megachips/ipshow/blobs/${configDigest}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ architecture: 'amd64' }));
          return;
        }
        if (req.url === `/v2/megachips/ipshow/blobs/${layerDigest}`) {
          res.writeHead(302, { Location: `http://127.0.0.1:${cdn.address().port}/storage/layer` });
          res.end();
          return;
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise((resolve) => { registry.listen(0, '127.0.0.1', resolve); });
    });

    afterEach(async () => {
      await new Promise((resolve) => { registry.close(resolve); });
      await new Promise((resolve) => { cdn.close(resolve); });
    });

    it('keeps the Range header across the redirect to object storage', async () => {
      sinon.stub(serviceHelper, 'axiosInstance').returns(axios.create({
        baseURL: `http://127.0.0.1:${registry.address().port}/v2/`,
        timeout: 5_000,
      }));

      const verifier = new ImageVerifier('megachips/ipshow:web');
      await verifier.verifyImage();

      expect(cdnRequest).to.eql({ url: '/storage/layer', range: `bytes=${compressed - 4}-${compressed - 1}` });
      expect(verifier.decompressedSizeBytes).to.equal(trailerIsize);
    });
  });

  describe('errorMeta tests', () => {
    let axiosInstanceStub;

    beforeEach(() => {
      axiosInstanceStub = sinon.stub(serviceHelper, 'axiosInstance');
    });

    it('should return null errorMeta when no error occurs', async () => {
      const repotag = 'megachips/ipshow:web';

      axiosInstanceStub.returns({
        get: sinon.stub().resolves({ data: registryResponses.dockerManifestV2 }),
        interceptors: { request: { use: sinon.stub() } },
      });

      const verifier = new ImageVerifier(repotag);
      await verifier.verifyImage();

      expect(verifier.errorMeta).to.be.null;
    });

    it('should populate errorMeta with network error type', async () => {
      const repotag = 'megachips/ipshow:web';

      const networkError = new Error('Connection Error ECONNREFUSED: image not available');
      networkError.code = 'ECONNREFUSED';

      axiosInstanceStub.returns({
        get: sinon.stub().rejects(networkError),
        interceptors: { request: { use: sinon.stub() } },
      });

      const verifier = new ImageVerifier(repotag);
      await verifier.verifyImage();

      expect(verifier.errorMeta).to.not.be.null;
      expect(verifier.errorMeta.errorType).to.equal('network');
      expect(verifier.errorMeta.errorCode).to.equal('ECONNREFUSED');
      expect(verifier.errorMeta.httpStatus).to.be.null;
    });

    it('should populate errorMeta with rate_limit error type for 429', async () => {
      const repotag = 'megachips/ipshow:web';

      const rateLimitError = new Error('Too many requests');
      rateLimitError.response = { status: 429 };

      axiosInstanceStub.returns({
        get: sinon.stub().rejects(rateLimitError),
        interceptors: { request: { use: sinon.stub() } },
      });

      const verifier = new ImageVerifier(repotag);
      await verifier.verifyImage();

      expect(verifier.errorMeta).to.not.be.null;
      expect(verifier.errorMeta.errorType).to.equal('rate_limit');
      expect(verifier.errorMeta.httpStatus).to.equal(429);
      expect(verifier.errorMeta.errorCode).to.be.null;
    });

    it('should populate errorMeta with server_error type for 5xx', async () => {
      const repotag = 'megachips/ipshow:web';

      const serverError = new Error('Server error');
      serverError.response = { status: 503 };

      axiosInstanceStub.returns({
        get: sinon.stub().rejects(serverError),
        interceptors: { request: { use: sinon.stub() } },
      });

      const verifier = new ImageVerifier(repotag);
      await verifier.verifyImage();

      expect(verifier.errorMeta).to.not.be.null;
      expect(verifier.errorMeta.errorType).to.equal('server_error');
      expect(verifier.errorMeta.httpStatus).to.equal(503);
    });

    it('should populate errorMeta with size_limit error type', async () => {
      const repotag = 'megachips/ipshow:web';

      // Create manifest with oversized image
      const oversizedManifest = {
        schemaVersion: 2,
        mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
        config: {
          digest: 'sha256:test',
        },
        layers: [
          { size: 3_000_000_000 }, // 3GB - over the 2GB limit
        ],
      };

      axiosInstanceStub.returns({
        get: sinon.stub().resolves({ data: oversizedManifest }),
        interceptors: { request: { use: sinon.stub() } },
      });

      const verifier = new ImageVerifier(repotag, { maxImageSize: 2_000_000_000 });
      await verifier.verifyImage();

      expect(verifier.errorMeta).to.not.be.null;
      expect(verifier.errorMeta.errorType).to.equal('size_limit');
    });

    it('should populate errorMeta with unsupported_architecture error type', async () => {
      const repotag = 'megachips/ipshow:web';

      // Create manifest list with only arm64
      const arm64OnlyIndex = {
        schemaVersion: 2,
        mediaType: 'application/vnd.docker.distribution.manifest.list.v2+json',
        manifests: [
          {
            digest: 'sha256:test',
            platform: { architecture: 'arm64' },
          },
        ],
      };

      axiosInstanceStub.returns({
        get: sinon.stub().resolves({ data: arm64OnlyIndex }),
        interceptors: { request: { use: sinon.stub() } },
      });

      const verifier = new ImageVerifier(repotag, { architectureSet: ['amd64'] }); // Only allow amd64
      await verifier.verifyImage();

      expect(verifier.errorMeta).to.not.be.null;
      expect(verifier.errorMeta.errorType).to.equal('unsupported_architecture');
    });

    it('should reset errorMeta when resetErrors is called', async () => {
      const repotag = 'megachips/ipshow:web';

      const networkError = new Error('Connection Error');
      networkError.code = 'ECONNREFUSED';

      axiosInstanceStub.returns({
        get: sinon.stub().rejects(networkError),
        interceptors: { request: { use: sinon.stub() } },
      });

      const verifier = new ImageVerifier(repotag);
      await verifier.verifyImage();

      expect(verifier.errorMeta).to.not.be.null;

      verifier.resetErrors();

      expect(verifier.errorMeta).to.be.null;
    });
  });

  describe('SSRF guard', () => {
    // No axios stub here on purpose: the guard is in the transport itself, so
    // stubbing it would test nothing. Nor is any connection attempted - an
    // address literal is refused before a request exists, which is the point.
    it('refuses a registry that resolves to a loopback address', async () => {
      const verifier = new ImageVerifier('127.0.0.1:9999/ns/repo:tag');

      const result = await verifier.verifyImage();

      expect(result).to.equal(false);
      expect(() => verifier.throwIfError()).to.throw(/private or reserved address/);
    });

    it('refuses a private-range registry', async () => {
      const verifier = new ImageVerifier('10.0.0.5:5000/ns/repo:tag');

      await verifier.verifyImage();

      expect(verifier.error).to.equal(true);
      expect(verifier.errorDetail).to.match(/private or reserved address/);
    });

    it('classes a refusal permanent, so it is never retried as a flaky registry', async () => {
      // The name resolved and we declined to dial it. Reading that as a network
      // blip would retry a spec pointing at an internal address forever.
      const verifier = new ImageVerifier('169.254.169.254:80/ns/repo:tag');

      await verifier.verifyImage();

      expect(verifier.errorClass).to.equal('permanent');
      expect(verifier.errorMeta.errorCode).to.equal('EBLOCKEDADDRESS');
    });
  });
});
