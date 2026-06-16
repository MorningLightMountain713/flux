const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('imageArchitectureValidator.verifyImageRegistryAndArchitectures', () => {
  let verifyImageRegistryAndArchitectures;
  let verifyRepositoryStub;
  let isImageBlockedStub;

  function makeComponent(overrides = {}) {
    return {
      name: overrides.name || 'component1',
      image: overrides.image || overrides.repotag || 'nginx:latest',
      imageAuth: overrides.imageAuth || overrides.repoauth || '',
      rootFsGb: overrides.rootFsGb !== undefined ? overrides.rootFsGb : 2,
      // The fit decision is the component's (real logic lives + is tested in
      // flux-spec); the validator just acts on the boolean. Default to "fits".
      imageFitsRootFs: overrides.imageFitsRootFs || (() => true),
    };
  }

  function makeSpec(overrides = {}) {
    const comps = (overrides.compose || [makeComponent()]).map((c) => makeComponent(c));
    const spec = {
      name: overrides.name || 'testapp',
      version: overrides.version || 8,
      owner: overrides.owner || '1owner',
      isEncrypted: overrides.isEncrypted || false,
      allImages: () => comps.map((c) => c.image),
      componentEntries: () => comps.map((c) => [c.name, c]),
    };
    return spec;
  }

  beforeEach(() => {
    verifyRepositoryStub = sinon.stub().resolves({
      verified: true,
      supportedArchitectures: ['amd64', 'arm64'],
    });
    isImageBlockedStub = sinon.stub().resolves({ blocked: false, reason: null });

    ({ verifyImageRegistryAndArchitectures } = proxyquire(
      '../../ZelBack/src/services/appSecurity/imageArchitectureValidator',
      {
        './imageManager': {
          verifyRepository: verifyRepositoryStub,
          isImageBlocked: isImageBlockedStub,
        },
      },
    ));
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('encrypted apps (run on Arcane, amd64-only)', () => {
    it('accepts when every component supports amd64', async () => {
      verifyRepositoryStub.resolves({
        verified: true, supportedArchitectures: ['amd64', 'arm64'],
      });
      await verifyImageRegistryAndArchitectures(makeSpec(), { isEncrypted: true });
    });

    it('rejects when any component lacks amd64 support', async () => {
      verifyRepositoryStub.resolves({
        verified: true, supportedArchitectures: ['arm64'],
      });
      const spec = makeSpec({
        compose: [{ name: 'c1', image: 'arm-only:latest' }],
      });
      try {
        await verifyImageRegistryAndArchitectures(spec, { isEncrypted: true });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('amd64');
        expect(err.message).to.include('Arcane');
      }
    });
  });

  describe('enterprise v7 apps (short-circuit on imageAuth)', () => {
    it('returns early without registry probe when a component has imageAuth set', async () => {
      const spec = makeSpec({
        version: 7,
        isEncrypted: true,
        compose: [{ name: 'c1', imageAuth: 'pgp-encrypted-blob' }],
      });
      await verifyImageRegistryAndArchitectures(spec);
      expect(verifyRepositoryStub.called).to.be.false;
    });

    it('verifies every image when no component has imageAuth set', async () => {
      const spec = makeSpec({
        version: 7,
        enterprise: false,
        compose: [
          { name: 'a', image: 'nginx:latest' },
          { name: 'b', image: 'redis:latest' },
        ],
      });
      await verifyImageRegistryAndArchitectures(spec);
      expect(verifyRepositoryStub.callCount).to.equal(2);
    });
  });

  describe('non-enterprise apps', () => {
    it('accepts when all components share at least one architecture', async () => {
      verifyRepositoryStub.resolves({
        verified: true, supportedArchitectures: ['amd64', 'arm64'],
      });
      await verifyImageRegistryAndArchitectures(makeSpec({
        compose: [{ name: 'a' }, { name: 'b' }],
      }));
    });

    it('rejects when components have no common architecture', async () => {
      verifyRepositoryStub.onFirstCall().resolves({
        verified: true, supportedArchitectures: ['amd64'],
      });
      verifyRepositoryStub.onSecondCall().resolves({
        verified: true, supportedArchitectures: ['arm64'],
      });
      const spec = makeSpec({
        compose: [{ name: 'a' }, { name: 'b' }],
      });
      try {
        await verifyImageRegistryAndArchitectures(spec);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('common architecture');
      }
    });
  });

  describe('rootFs fit (early compressed-size reject)', () => {
    it('rejects when the component reports the image does not fit its rootFs budget', async () => {
      verifyRepositoryStub.resolves({
        verified: true, supportedArchitectures: ['amd64'], imageSizeBytes: 5e9,
      });
      const spec = makeSpec({
        compose: [{ name: 'big', image: 'big:latest', rootFsGb: 2, imageFitsRootFs: () => false }],
      });
      try {
        await verifyImageRegistryAndArchitectures(spec);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('rootFsGb');
        expect(err.message).to.include('exceeds');
      }
    });

    it('skips the fit check when the image size is unknown', async () => {
      verifyRepositoryStub.resolves({ verified: true, supportedArchitectures: ['amd64'] });
      const fits = sinon.stub().returns(false);
      const spec = makeSpec({ compose: [{ name: 'c', imageFitsRootFs: fits }] });
      await verifyImageRegistryAndArchitectures(spec);
      expect(fits.called).to.be.false;
    });

    it('accepts when the component reports the image fits', async () => {
      verifyRepositoryStub.resolves({
        verified: true, supportedArchitectures: ['amd64'], imageSizeBytes: 1e9,
      });
      const spec = makeSpec({
        compose: [{ name: 'c', rootFsGb: 10, imageFitsRootFs: () => true }],
      });
      await verifyImageRegistryAndArchitectures(spec);
    });
  });

  describe('blocked images', () => {
    it('throws when isImageBlocked returns blocked', async () => {
      isImageBlockedStub.resolves({ blocked: true, reason: 'image is blacklisted' });
      try {
        await verifyImageRegistryAndArchitectures(makeSpec());
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('blacklisted');
      }
    });
  });
});
