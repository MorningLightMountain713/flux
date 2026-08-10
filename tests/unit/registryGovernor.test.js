'use strict';

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');

chai.use(chaiAsPromised);
const { expect } = chai;

const registryGovernor = require('../../ZelBack/src/services/utils/registryGovernor');

describe('registryGovernor tests', () => {
  afterEach(() => {
    sinon.restore();
    registryGovernor.reset();
  });

  describe('provider normalization', () => {
    it('folds every name Docker Hub answers to onto one key', () => {
      expect(registryGovernor.normalizeProvider('registry-1.docker.io')).to.equal('docker.io');
      expect(registryGovernor.normalizeProvider('index.docker.io')).to.equal('docker.io');
      expect(registryGovernor.normalizeProvider('docker.io')).to.equal('docker.io');
    });

    it('folds per-account cloud registry subdomains onto their suffix', () => {
      // These are per-account hosts, so an exact-match table alone would drop
      // every real caller onto the conservative default.
      expect(registryGovernor.normalizeProvider('123456789012.dkr.ecr.eu-west-1.amazonaws.com')).to.equal('amazonaws.com');
      expect(registryGovernor.normalizeProvider('myregistry.azurecr.io')).to.equal('azurecr.io');
    });

    it('keeps public ECR distinct from private ECR', () => {
      // They have different limits: 1/s versus per-account quotas well above it.
      expect(registryGovernor.normalizeProvider('public.ecr.aws')).to.equal('public.ecr.aws');
    });

    it('strips the port and lowercases', () => {
      expect(registryGovernor.normalizeProvider('MyRegistry.Example.COM:5000')).to.equal('myregistry.example.com');
    });

    it('answers for a missing provider rather than throwing', () => {
      expect(registryGovernor.normalizeProvider(undefined)).to.equal('unknown');
      expect(registryGovernor.normalizeProvider('')).to.equal('unknown');
    });
  });

  describe('policy', () => {
    it('gives the count-capped registries concurrency and no rate cap', () => {
      // Docker Hub caps how MANY manifest GETs per 6h, not how fast, so spacing
      // them out buys nothing and costs latency.
      const hub = registryGovernor.policyFor('registry-1.docker.io');
      expect(hub.concurrency).to.equal(8);
      expect(hub.ratePerSec).to.equal(null);

      const ghcr = registryGovernor.policyFor('ghcr.io');
      expect(ghcr.ratePerSec).to.equal(null);
    });

    it('gives public ECR the per-second cap that the deleted sleep was hand-rolling', () => {
      const policy = registryGovernor.policyFor('public.ecr.aws');
      expect(policy.concurrency).to.equal(1);
      expect(policy.ratePerSec).to.equal(1);
    });

    it('raises the rate for a credentialed caller where the registry publishes one', () => {
      expect(registryGovernor.policyFor('public.ecr.aws', true).ratePerSec).to.equal(10);
    });

    it('does not invent a higher rate from credentials where none is published', () => {
      expect(registryGovernor.policyFor('registry-1.docker.io', true).ratePerSec).to.equal(null);
    });

    it('bounds an unknown registry by concurrency but invents no rate cap', () => {
      // An unknown registry is almost always self-hosted, and CNCF Distribution
      // has no request rate limiting at all - so a per-second cap here would be
      // throttling infrastructure that has no limit, usually the app owner's own.
      const policy = registryGovernor.policyFor('someones-private-registry.example.com');
      expect(policy.concurrency).to.equal(2);
      expect(policy.ratePerSec).to.equal(null);
    });
  });

  describe('concurrency', () => {
    it('lets a count-capped registry run its full concurrency at once', async () => {
      const releases = [];
      for (let i = 0; i < 8; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        releases.push(await registryGovernor.acquire('registry-1.docker.io'));
      }

      let ninthAcquired = false;
      (async () => {
        await registryGovernor.acquire('registry-1.docker.io');
        ninthAcquired = true;
      })();

      await new Promise((r) => { setTimeout(r, 0); });
      expect(ninthAcquired).to.be.false;

      releases[0]();
      await new Promise((r) => { setTimeout(r, 0); });
      expect(ninthAcquired).to.be.true;
    });

    it('keeps providers independent, so one busy registry does not stall another', async () => {
      const release = await registryGovernor.acquire('public.ecr.aws');

      // ECR Public is concurrency 1 and now fully occupied; Docker Hub must not care.
      const hubRelease = await registryGovernor.acquire('registry-1.docker.io');
      expect(hubRelease).to.be.a('function');

      release();
      hubRelease();
    });
  });

  describe('rate pacing', () => {
    it('paces a rate-capped registry and leaves an uncapped one alone', async () => {
      const clock = sinon.useFakeTimers();

      // Burst of 1, so the second request has to wait a second.
      const first = await registryGovernor.acquire('public.ecr.aws');
      first();

      let secondAt = null;
      const second = (async () => {
        const release = await registryGovernor.acquire('public.ecr.aws');
        secondAt = Date.now();
        release();
      })();

      await clock.tickAsync(999);
      expect(secondAt).to.equal(null);

      await clock.tickAsync(1);
      await second;
      expect(secondAt).to.equal(1000);
    });

    it('does not pace Docker Hub at all', async () => {
      const clock = sinon.useFakeTimers();

      const releases = [];
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        releases.push(await registryGovernor.acquire('registry-1.docker.io'));
      }

      // No clock advance was needed for any of them.
      expect(Date.now()).to.equal(0);
      releases.forEach((release) => release());
      await clock.tickAsync(0);
    });
  });

  describe('cooldown after a 429', () => {
    it('believes the registry\'s own Retry-After', async () => {
      await registryGovernor.acquire('registry-1.docker.io').then((r) => r());

      registryGovernor.recordResponse('registry-1.docker.io', {
        status: 429,
        headers: { 'retry-after': '900' },
      });

      expect(registryGovernor.cooldownRemaining('registry-1.docker.io')).to.be.closeTo(900000, 50);
    });

    it('falls back to the reset header, then to a bounded default', async () => {
      await registryGovernor.acquire('ghcr.io').then((r) => r());
      registryGovernor.recordResponse('ghcr.io', {
        status: 429,
        headers: { 'ratelimit-reset': '120' },
      });
      expect(registryGovernor.cooldownRemaining('ghcr.io')).to.be.closeTo(120000, 50);

      await registryGovernor.acquire('registry-1.docker.io').then((r) => r());
      registryGovernor.recordResponse('registry-1.docker.io', { status: 429, headers: {} });
      // Minutes, not hours: a cooldown is a could-not-ask answer that expires
      // with the registry's window, not a verdict on the image.
      expect(registryGovernor.cooldownRemaining('registry-1.docker.io')).to.be.closeTo(900000, 50);
    });

    it('caps an implausible Retry-After rather than believing it', async () => {
      await registryGovernor.acquire('ghcr.io').then((r) => r());
      registryGovernor.recordResponse('ghcr.io', {
        status: 429,
        headers: { 'retry-after': '86400' },
      });

      expect(registryGovernor.cooldownRemaining('ghcr.io')).to.be.closeTo(3600000, 50);
    });

    it('does not cool down on a non-429', async () => {
      await registryGovernor.acquire('ghcr.io').then((r) => r());
      registryGovernor.recordResponse('ghcr.io', { status: 500, headers: { 'retry-after': '900' } });

      expect(registryGovernor.cooldownRemaining('ghcr.io')).to.equal(0);
    });

    it('waits out a cooldown when the caller has no deadline', async () => {
      const clock = sinon.useFakeTimers();

      await registryGovernor.acquire('ghcr.io').then((r) => r());
      registryGovernor.recordResponse('ghcr.io', { status: 429, headers: { 'retry-after': '10' } });

      let acquired = false;
      const waiter = (async () => {
        const release = await registryGovernor.acquire('ghcr.io');
        acquired = true;
        release();
      })();

      await clock.tickAsync(9000);
      expect(acquired).to.be.false;

      await clock.tickAsync(1000);
      await waiter;
      expect(acquired).to.be.true;
    });

    it('refuses immediately, with the number, when the caller cannot outwait it', async () => {
      await registryGovernor.acquire('ghcr.io').then((r) => r());
      registryGovernor.recordResponse('ghcr.io', { status: 429, headers: { 'retry-after': '900' } });

      // A caller holding an HTTP request open would otherwise sit there until
      // its own deadline expired, having learned nothing.
      const error = await registryGovernor.acquire('ghcr.io', { timeoutMs: 5000 }).catch((err) => err);

      expect(error.code).to.equal('REGISTRY_BUSY');
      // Transient: it says the registry could not be asked, never that the
      // image is bad. Classing it permanent would cache a throttle as a verdict.
      expect(error.registryErrorClass).to.equal('transient');
      expect(error.retryAfterMs).to.be.closeTo(900000, 50);
    });
  });

  describe('advisory budget', () => {
    it('parses the count and window a registry advertises', async () => {
      // Docker Hub sends these on every valid manifest request, not only on a
      // refusal, so the budget is readable long before anything goes wrong.
      await registryGovernor.acquire('registry-1.docker.io').then((r) => r());
      registryGovernor.recordResponse('registry-1.docker.io', {
        status: 200,
        headers: { 'ratelimit-limit': '100;w=21600', 'ratelimit-remaining': '87;w=21600' },
      });

      expect(registryGovernor.budgetFor('registry-1.docker.io')).to.deep.equal({
        limit: 100, remaining: 87, windowSeconds: 21600,
      });
    });

    it('reads the older X- spellings and a bare count with no window', async () => {
      await registryGovernor.acquire('ghcr.io').then((r) => r());
      registryGovernor.recordResponse('ghcr.io', {
        status: 200,
        headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999' },
      });

      expect(registryGovernor.budgetFor('ghcr.io')).to.deep.equal({
        limit: 5000, remaining: 4999, windowSeconds: null,
      });
    });

    it('never turns a count-over-a-window into pacing', async () => {
      // 100 per 6 hours read as a rate would space requests 3.6 minutes apart.
      // It is a budget to observe, not a bucket to drain.
      const clock = sinon.useFakeTimers();
      await registryGovernor.acquire('registry-1.docker.io').then((r) => r());
      registryGovernor.recordResponse('registry-1.docker.io', {
        status: 200,
        headers: { 'ratelimit-limit': '100;w=21600', 'ratelimit-remaining': '1;w=21600' },
      });

      const release = await registryGovernor.acquire('registry-1.docker.io');
      expect(Date.now()).to.equal(0);
      release();
      await clock.tickAsync(0);
    });

    it('records the remaining count without gating on it', async () => {
      // The budget can never gate: Docker Hub's count is mostly consumed by the
      // docker daemon's own pulls, which never pass through here, and the cap is
      // per-IPv4 so co-located nodes share a number none of them can see.
      const release = await registryGovernor.acquire('registry-1.docker.io');
      release();

      registryGovernor.recordResponse('registry-1.docker.io', {
        status: 200,
        headers: { 'ratelimit-remaining': '0;w=21600' },
      });

      const next = await registryGovernor.acquire('registry-1.docker.io');
      expect(next).to.be.a('function');
      next();
    });
  });
});
