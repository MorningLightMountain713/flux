const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

chai.use(chaiAsPromised);
const { expect } = chai;

const jobRegistry = require('../../ZelBack/src/services/utils/jobRegistry');

describe('imagePreflight tests', () => {
  let verifyRepositoryStub;
  let openTransportEnvelopeStub;
  let parseImageReferenceStub;

  const preflightConfig = {
    fluxapps: {
      preflightMaxComponents: 3,
      preflightMaxQueuedJobs: 2,
      preflightEnvelopeMaxAgeMs: 300000,
      preflightJobRetentionMs: 600000,
    },
  };

  function build(configOverride) {
    verifyRepositoryStub = sinon.stub();
    // The real helper is a no-op on the cleartext form and only opens an
    // envelope when transportEncrypted is present - mirror that, or the
    // cleartext tests would exercise a path the production code never takes.
    openTransportEnvelopeStub = sinon.stub().callsFake(async (body) => body);
    parseImageReferenceStub = sinon.stub().callsFake((image) => (
      typeof image === 'string' && image.includes('/')
        ? { reference: image }
        : { error: `Image tag: ${image} is not in valid format` }
    ));

    return proxyquire('../../ZelBack/src/services/appSecurity/imagePreflight', {
      config: configOverride || preflightConfig,
      './imageManager': { verifyRepository: verifyRepositoryStub },
      '../utils/transportHelper': { openTransportEnvelope: openTransportEnvelopeStub },
      '../utils/imageVerifier': { ImageVerifier: { parseImageReference: parseImageReferenceStub } },
      '../utils/specLibs': { getSpec: async () => ({ imageFitsRootFs: (gb, bytes) => bytes <= gb * 1e9 }) },
    });
  }

  function measurement(overrides = {}) {
    return {
      verified: true,
      supportedArchitectures: ['amd64', 'arm64'],
      imageSizeBytes: 3_000_000_000,
      decompressedSizeBytes: 7_560_000_000,
      decompressedSizeClearanceBytes: 7_560_000_000,
      ...overrides,
    };
  }

  // The job runs off the request, so tests wait for it rather than sleeping.
  async function settle(preflight, jobId) {
    for (let i = 0; i < 200; i += 1) {
      const view = preflight.getPreflight(jobId, 'F1');
      if (view && view.status !== 'Running') return view;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setImmediate(resolve); });
    }
    throw new Error('preflight job did not settle');
  }

  const CALLER = { fluxId: 'F1', sourceIp: '203.0.113.5' };

  async function run(preflight, body, caller = CALLER) {
    const { jobId } = await preflight.submitPreflight(body, caller);
    return settle(preflight, jobId);
  }

  afterEach(() => {
    sinon.restore();
    // The operation registry is a process-level singleton shared by every
    // endpoint that answers 202, so jobs would otherwise leak between tests.
    jobRegistry.reset();
  });

  describe('measurement results', () => {
    it('reports the minimum declaration and the writable headroom left inside it', async () => {
      const preflight = build();
      verifyRepositoryStub.resolves(measurement({
        decompressedSizeBytes: 3_200_000_000,
        decompressedSizeClearanceBytes: 3_200_000_000,
      }));

      const view = await run(preflight, {
        components: [{ name: 'web', image: 'library/nginx:1.27', rootFsGb: 20 }],
      });

      const { web } = view.detail.components;
      expect(web.status).to.equal('ok');
      expect(web.measured).to.equal(true);
      expect(web.decompressedBytes).to.equal(3_200_000_000);
      expect(web.fits).to.equal(true);
      // The point of the endpoint: 20 was declared, 4 would do, and the other
      // 16.8 GB is being paid for and not used.
      expect(web.minimumRootFsGb).to.equal(4);
      expect(web.writableHeadroomBytes).to.equal(16_800_000_000);
    });

    it('fails the fit and names the minimum when the declaration is too small', async () => {
      const preflight = build();
      verifyRepositoryStub.resolves(measurement());

      const view = await run(preflight, {
        components: [{ name: 'ml', image: 'library/pytorch:latest', rootFsGb: 5 }],
      });

      expect(view.detail.components.ml.fits).to.equal(false);
      expect(view.detail.components.ml.minimumRootFsGb).to.equal(8);
    });

    it('judges the fit on the clearance figure, not the lower bound, when a size record wrapped', async () => {
      const preflight = build();
      // Ambiguous wrap: at least 3.26 GB, possibly 7.56 GB. A declaration of 5
      // clears the lower bound but not the candidate above it.
      verifyRepositoryStub.resolves(measurement({
        decompressedSizeBytes: 3_265_000_000,
        decompressedSizeClearanceBytes: 7_560_000_000,
      }));

      const view = await run(preflight, {
        components: [{ name: 'ml', image: 'library/pytorch:latest', rootFsGb: 5 }],
      });

      expect(view.detail.components.ml.ambiguous).to.equal(true);
      expect(view.detail.components.ml.fits).to.equal(false);
      expect(view.detail.components.ml.minimumRootFsGb).to.equal(8);
    });

    it('leaves every verdict null for an unmeasured image rather than reading absence as a pass', async () => {
      const preflight = build();
      verifyRepositoryStub.resolves(measurement({
        decompressedSizeBytes: 0,
        decompressedSizeClearanceBytes: 0,
      }));

      const view = await run(preflight, {
        components: [{ name: 'legacy', image: 'didstopia/ark-server:latest', rootFsGb: 5 }],
      });

      const { legacy } = view.detail.components;
      expect(legacy.status).to.equal('ok');
      expect(legacy.measured).to.equal(false);
      expect(legacy.fits).to.equal(null);
      expect(legacy.minimumRootFsGb).to.equal(null);
      expect(legacy.writableHeadroomBytes).to.equal(null);
    });

    it('refuses an unmeasured image whose compressed sum alone overruns the budget', async () => {
      const preflight = build();
      // The registration gate refuses on the compressed sum when nothing could be
      // measured (imageArchitectureValidator's fallback branch) - the preflight has
      // to report that same refusal or an owner could act on a pass it would not get.
      verifyRepositoryStub.resolves(measurement({
        imageSizeBytes: 8_000_000_000,
        decompressedSizeBytes: 0,
        decompressedSizeClearanceBytes: 0,
      }));

      const view = await run(preflight, {
        components: [{ name: 'private', image: 'mycorp/big:1', rootFsGb: 5 }],
      });

      expect(view.detail.components.private.measured).to.equal(false);
      expect(view.detail.components.private.fits).to.equal(false);
      expect(view.detail.components.private.minimumRootFsGb).to.equal(8);
    });

    it('gives an unmeasured image that clears its compressed sum no verdict, not a pass', async () => {
      const preflight = build();
      verifyRepositoryStub.resolves(measurement({
        imageSizeBytes: 1_000_000_000,
        decompressedSizeBytes: 0,
        decompressedSizeClearanceBytes: 0,
      }));

      const view = await run(preflight, {
        components: [{ name: 'private', image: 'mycorp/small:1', rootFsGb: 5 }],
      });

      // Compressed fitting proves nothing about decompressed; the install-time
      // inspect stays the authority, so this must not read as approval.
      expect(view.detail.components.private.fits).to.equal(null);
      expect(view.detail.components.private.minimumRootFsGb).to.equal(null);
    });

    it('reports the minimum even when no rootFsGb was declared', async () => {
      const preflight = build();
      verifyRepositoryStub.resolves(measurement());

      const view = await run(preflight, {
        components: [{ name: 'web', image: 'library/nginx:1.27' }],
      });

      expect(view.detail.components.web.rootFsGb).to.equal(null);
      expect(view.detail.components.web.fits).to.equal(null);
      expect(view.detail.components.web.minimumRootFsGb).to.equal(8);
    });
  });

  describe('per-component failures', () => {
    it('reports a failing component as its answer and still measures the rest', async () => {
      const preflight = build();
      const boom = new Error('Connection Error ECONNREFUSED: not available');
      boom.registryErrorClass = 'transient';
      verifyRepositoryStub.onFirstCall().rejects(boom);
      verifyRepositoryStub.onSecondCall().resolves(measurement());

      const view = await run(preflight, {
        components: [
          { name: 'broken', image: 'library/gone:1', rootFsGb: 5 },
          { name: 'web', image: 'library/nginx:1.27', rootFsGb: 10 },
        ],
      });

      expect(view.status).to.equal('Succeeded');
      expect(view.detail.components.broken.status).to.equal('error');
      expect(view.detail.components.broken.errorClass).to.equal('transient');
      // The whole reason this is not the registration verify: one dead registry
      // must not blank the facts for every other component.
      expect(view.detail.components.web.status).to.equal('ok');
      expect(view.detail.components.web.fits).to.equal(true);
    });

    it('classes an unlabelled failure permanent so it is not read as retryable', async () => {
      const preflight = build();
      verifyRepositoryStub.rejects(new Error('Authentication rejected'));

      const view = await run(preflight, {
        components: [{ name: 'private', image: 'mycorp/thing:1' }],
      });

      expect(view.detail.components.private.errorClass).to.equal('permanent');
    });
  });

  describe('the image is never echoed', () => {
    it('keys results by component name and returns no image reference', async () => {
      const preflight = build();
      verifyRepositoryStub.resolves(measurement());

      const view = await run(preflight, {
        components: [{ name: 'web', image: 'mycorp/internal-secret:1' }],
      });

      expect(Object.keys(view.detail.components)).to.deep.equal(['web']);
      expect(JSON.stringify(view)).to.not.include('internal-secret');
    });
  });

  describe('input validation', () => {
    it('rejects a component with no name, since results are keyed by it', async () => {
      const preflight = build();
      await expect(preflight.submitPreflight({
        components: [{ image: 'library/nginx:1.27' }],
      }, CALLER)).to.be.rejectedWith(/needs a name/);
    });

    it('rejects duplicate component names', async () => {
      const preflight = build();
      await expect(preflight.submitPreflight({
        components: [
          { name: 'web', image: 'library/nginx:1.27' },
          { name: 'web', image: 'library/redis:7' },
        ],
      }, CALLER)).to.be.rejectedWith(/Duplicate component name: web/);
    });

    it('rejects an unparseable image reference', async () => {
      const preflight = build();
      await expect(preflight.submitPreflight({
        components: [{ name: 'web', image: 'not a tag' }],
      }, CALLER)).to.be.rejectedWith(/is not in valid format/);
    });

    it('rejects a non-positive rootFsGb', async () => {
      const preflight = build();
      await expect(preflight.submitPreflight({
        components: [{ name: 'web', image: 'library/nginx:1.27', rootFsGb: 0 }],
      }, CALLER)).to.be.rejectedWith(/rootFsGb must be a positive number/);
    });

    it('rejects more components than the cap allows', async () => {
      const preflight = build();
      const components = [1, 2, 3, 4].map((n) => ({ name: `c${n}`, image: 'library/nginx:1.27' }));
      await expect(preflight.submitPreflight({ components }, CALLER))
        .to.be.rejectedWith(/Too many components to preflight: 4, maximum 3/);
    });

    it('rejects an empty component list', async () => {
      const preflight = build();
      await expect(preflight.submitPreflight({ components: [] }, CALLER))
        .to.be.rejectedWith(/No components to preflight/);
    });

    it('refuses a job before creating it, so a bad request never becomes a poll', async () => {
      const preflight = build();
      await expect(preflight.submitPreflight({ components: [] }, CALLER)).to.be.rejected;
      expect(verifyRepositoryStub.called).to.equal(false);
    });
  });

  describe('the sealed form', () => {
    it('opens the envelope under the preflight AAD type and measures what was inside', async () => {
      const preflight = build();
      verifyRepositoryStub.resolves(measurement());
      openTransportEnvelopeStub.resolves({
        components: [{ name: 'web', image: 'mycorp/private:1', imageAuth: 'user:pass', rootFsGb: 10 }],
      });

      const view = await run(preflight, {
        name: 'myapp',
        owner: '1FluxOwner',
        contentHash: 'abc123',
        timestamp: Date.now(),
        transportEncrypted: { algorithm: 'x', ciphertext: 'y' },
      });

      const [, meta] = openTransportEnvelopeStub.firstCall.args;
      // Binding the type stops a captured registration envelope being replayed
      // here, and vice versa.
      expect(meta.type).to.equal('fluxapppreflight');
      expect(view.detail.components.web.status).to.equal('ok');
      expect(verifyRepositoryStub.firstCall.args[1].repoauth).to.equal('user:pass');
    });

    it('refuses a stale envelope timestamp', async () => {
      const preflight = build();
      await expect(preflight.submitPreflight({
        name: 'myapp',
        owner: '1FluxOwner',
        contentHash: 'abc123',
        timestamp: Date.now() - 400000,
        transportEncrypted: { algorithm: 'x', ciphertext: 'y' },
      }, CALLER)).to.be.rejectedWith(/outside the accepted window/);
      expect(openTransportEnvelopeStub.called).to.equal(false);
    });

    it('refuses a sealed request missing its envelope metadata', async () => {
      const preflight = build();
      await expect(preflight.submitPreflight({
        name: 'myapp',
        owner: '1FluxOwner',
        timestamp: Date.now(),
        transportEncrypted: { algorithm: 'x', ciphertext: 'y' },
      }, CALLER)).to.be.rejectedWith(/non-empty contentHash/);
    });

    it('refuses envelope metadata sent without an envelope', async () => {
      const preflight = build();
      await expect(preflight.submitPreflight({
        name: 'myapp',
        owner: '1FluxOwner',
        components: [{ name: 'web', image: 'library/nginx:1.27' }],
      }, CALLER)).to.be.rejectedWith(/belong to a sealed preflight/);
    });
  });

  describe('admission', () => {
    it('measures components concurrently and leaves the pacing to the governor', async () => {
      const preflight = build();
      let inFlight = 0;
      let maxInFlight = 0;
      verifyRepositoryStub.callsFake(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => { setImmediate(resolve); });
        inFlight -= 1;
        return measurement();
      });

      const view = await run(preflight, {
        components: [
          { name: 'a', image: 'library/nginx:1.27' },
          { name: 'b', image: 'library/redis:7' },
          { name: 'c', image: 'library/postgres:16' },
        ],
      });

      // Politeness is the registry governor's concern - a concurrency slot per
      // registry host - not this job's. Serialising here would only make a
      // preflight cost the sum of its components instead of the slowest one.
      expect(maxInFlight).to.equal(3);
      expect(Object.keys(view.detail.components)).to.have.members(['a', 'b', 'c']);
    });

    it('refuses a second concurrent job from the same address', async () => {
      const preflight = build();
      verifyRepositoryStub.callsFake(async () => {
        await new Promise((resolve) => { setTimeout(resolve, 20); });
        return measurement();
      });

      await preflight.submitPreflight({
        components: [{ name: 'web', image: 'library/nginx:1.27' }],
      }, CALLER);

      await expect(preflight.submitPreflight({
        components: [{ name: 'web', image: 'library/redis:7' }],
      }, CALLER)).to.be.rejectedWith(/already in progress/);
    });

    it('refuses once the queue is full, with a busy kind the handler can map to 503', async () => {
      const preflight = build();
      verifyRepositoryStub.callsFake(async () => {
        await new Promise((resolve) => { setTimeout(resolve, 20); });
        return measurement();
      });

      await preflight.submitPreflight({ components: [{ name: 'a', image: 'library/a:1' }] }, { fluxId: 'A', sourceIp: '198.51.100.1' });
      await preflight.submitPreflight({ components: [{ name: 'b', image: 'library/b:1' }] }, { fluxId: 'B', sourceIp: '198.51.100.2' });

      const err = await preflight.submitPreflight(
        { components: [{ name: 'c', image: 'library/c:1' }] }, { fluxId: 'C', sourceIp: '198.51.100.3' },
      ).catch((e) => e);

      expect(err.kind).to.equal('busy');
      expect(err.message).to.match(/as many preflights as it accepts/);
    });

    it('reports progress while a job is still running', async () => {
      const preflight = build();
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      verifyRepositoryStub.onFirstCall().resolves(measurement());
      verifyRepositoryStub.onSecondCall().callsFake(async () => {
        await gate;
        return measurement();
      });

      const { jobId } = await preflight.submitPreflight({
        components: [
          { name: 'a', image: 'library/nginx:1.27' },
          { name: 'b', image: 'library/redis:7' },
        ],
      }, CALLER);

      // Let the first component land.
      for (let i = 0; i < 50 && preflight.getPreflight(jobId, 'F1').detail.completed === 0; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => { setImmediate(resolve); });
      }

      const midway = preflight.getPreflight(jobId, 'F1');
      expect(midway.status).to.equal('Running');
      expect(midway.detail.completed).to.equal(1);
      expect(midway.detail.total).to.equal(2);
      expect(midway.detail.components.a.status).to.equal('ok');

      release();
      const view = await settle(preflight, jobId);
      expect(view.detail.completed).to.equal(2);
    });
  });

  describe('authentication and ownership', () => {
    it('refuses a submission with no authenticated FluxID', async () => {
      const preflight = build();
      await expect(preflight.submitPreflight({
        components: [{ name: 'web', image: 'library/nginx:1.27' }],
      }, { sourceIp: '203.0.113.5' })).to.be.rejectedWith(/authenticated FluxID/);
    });

    it('hides a preflight from another identity', async () => {
      // A preflight names the images an owner is considering, so it is readable
      // only by whoever asked for it - and an unknown job and someone else's give
      // the same answer, or a jobId becomes a probe.
      const preflight = build();
      verifyRepositoryStub.resolves(measurement());

      const { jobId } = await preflight.submitPreflight({
        components: [{ name: 'web', image: 'mycorp/private:1' }],
      }, CALLER);

      expect(preflight.getPreflight(jobId, 'SOMEONE_ELSE')).to.equal(null);
      expect(preflight.getPreflight(jobId, null)).to.equal(null);
      expect(preflight.getPreflight(jobId, 'F1')).to.not.equal(null);
    });

    it('separates callers by identity as well as address', async () => {
      // Neither half is enough alone: FluxIDs are free to mint, and an address is
      // one request from elsewhere away from looking like a different caller.
      // A roomier queue than the default fixture, so the per-caller check is what
      // refuses rather than the node-busy one.
      const preflight = build({
        fluxapps: { ...preflightConfig.fluxapps, preflightMaxQueuedJobs: 6 },
      });
      verifyRepositoryStub.callsFake(async () => {
        await new Promise((resolve) => { setTimeout(resolve, 20); });
        return measurement();
      });

      await preflight.submitPreflight(
        { components: [{ name: 'a', image: 'library/a:1' }] },
        { fluxId: 'F1', sourceIp: '203.0.113.5' },
      );

      // Same address, different signer - not the same caller.
      const other = await preflight.submitPreflight(
        { components: [{ name: 'b', image: 'library/b:1' }] },
        { fluxId: 'F2', sourceIp: '203.0.113.5' },
      );
      expect(other.jobId).to.be.a('string');

      // Same signer AND address - refused.
      await expect(preflight.submitPreflight(
        { components: [{ name: 'c', image: 'library/c:1' }] },
        { fluxId: 'F1', sourceIp: '203.0.113.5' },
      )).to.be.rejectedWith(/already in progress/);
    });
  });

  describe('job lookup', () => {
    it('returns null for an unknown job', () => {
      const preflight = build();
      expect(preflight.getPreflight('op_11111111-2222-3333-4444-555555555555', 'F1')).to.equal(null);
    });

    it('throws when no jobId is supplied at all', () => {
      const preflight = build();
      expect(() => preflight.getPreflight('')).to.throw(/Missing jobId/);
    });
  });
});
