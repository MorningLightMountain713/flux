'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

const {
  loadSpecLibrary, V8_SUBMISSION, V9_SUBMISSION, v8Spec, v9Spec, decryptedV9Spec,
  assertAnswers,
} = require('./fixtures/fluxSpec');

// The spec library is real here, not stubbed — see tests/unit/fixtures/fluxSpec.js.
//
// It matters for this file more than most, because BOTH of the answers the
// validator acts on used to come from a hand-written literal:
//
//   * `allImages: () => [...]`. The blocklist gate is asked about exactly this
//     list. A double is free to hand it an empty one, and an empty list is how
//     the gate silently decides about nothing — the defect that hid in
//     appInstaller's suite.
//   * `imageFitsRootFs: () => false` on a spec declaring `version: 8`. No such
//     component exists. Legacy treats rootFsGb as a writable-layer floor that
//     EXCLUDES the image, so a real v1-v8 component always fits, whatever the
//     measurement (AppComponentBase.imageFitsRootFs, `rootFsIncludesImage`).
//     Only v9 budgets rootFsGb as image + writable layer, so every rootFs
//     rejection below is a real v9 spec with a real declared budget, decided by
//     the class's own arithmetic rather than by a literal.
//
// What stays stubbed is I/O: imageManager talks to docker registries over HTTP
// and reads the blocked-repository list off disk/network.
describe('imageArchitectureValidator.verifyImageRegistryAndArchitectures', () => {
  let flux;
  let verifyImageRegistryAndArchitectures;
  let verifyRepositoryStub;
  let isImageBlockedStub;

  const WEB = V9_SUBMISSION.components.web;

  before(async () => {
    flux = await loadSpecLibrary();
  });

  /**
   * A single-component v9 `components` map built from the shared blob. Keyed by
   * the component's own name because the real class refuses any other key
   * ("Must match component key") — a hand-written double never noticed.
   */
  function oneComponent(overrides = {}) {
    const name = overrides.name || WEB.name;
    return { [name]: { ...WEB, ...overrides, name } };
  }

  /** A real FluxAppSpecV9 with a single component built from the shared blob. */
  function v9One(overrides = {}) {
    return v9Spec({ components: oneComponent(overrides) });
  }

  /** A real FluxAppSpecV9 with two components (distinct hostPorts, as v9 requires). */
  function v9Two() {
    return v9Spec({
      components: {
        web: { ...WEB, name: 'web', image: 'nginx:latest' },
        api: {
          ...WEB,
          name: 'api',
          image: 'redis:latest',
          ports: { tcp: { containerPort: 6379, hostPort: 31001 } },
        },
      },
    });
  }

  /**
   * A real FluxAppSpecV7 — the only version the imageAuth short-circuit applies
   * to, and one the shared fixture has no factory for. Derived from the shared
   * v8 submission blob, which v7 accepts key-for-key (same knownKeys), rather
   * than invented here.
   */
  function v7Spec(compose) {
    return flux.FluxAppSpecBase.getVersionClass(7).fromSubmission({
      ...V8_SUBMISSION,
      version: 7,
      compose,
    });
  }

  /** A legacy compose entry off the shared blob. */
  function legacyComponent(overrides = {}) {
    return { ...V8_SUBMISSION.compose[0], ...overrides };
  }

  /**
   * GUARD. The blocklist gate is handed the spec's OWN images and nothing else
   * is what decides whether an app is admitted. An empty list is not a benign
   * default: the gate iterates it, finds nothing, and admits everything.
   */
  function expectBlocklistAskedAboutRealImages(spec) {
    const [appName, images] = isImageBlockedStub.firstCall.args;
    expect(appName).to.equal(spec.name);
    expect(images, 'the blocklist was handed an empty image list — it decided about nothing')
      .to.not.be.empty;
    expect(images, 'the blocklist was asked about images the spec does not declare')
      .to.deep.equal(spec.allImages());
  }

  /**
   * GUARD. Every registry probe carries the component's real image and its real
   * credentials field. `comp.imageAuth || null` is production's normalisation —
   * the real classes answer '' (v1-v8) or null (v9) when there are none, never
   * undefined, so a probe that arrived with `undefined` would mean the property
   * was read off something that is not a component.
   */
  function expectRepositoryProbedFor(spec, componentNames) {
    const expected = spec.componentEntries()
      .filter(([name]) => componentNames.includes(name))
      .map(([, comp]) => [comp.image, { repoauth: comp.imageAuth || null, appName: spec.name }]);
    const actual = verifyRepositoryStub.getCalls().map((call) => call.args);
    expect(actual).to.deep.equal(expected);
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
      // A real encrypted app: sealed by the node, then opened. isEncrypted is
      // supplied by the caller because the decrypted view reports false itself.
      const spec = await decryptedV9Spec();

      await verifyImageRegistryAndArchitectures(spec, { owner: spec.owner, isEncrypted: true });

      expectBlocklistAskedAboutRealImages(spec);
      expectRepositoryProbedFor(spec, ['web']);
    });

    it('rejects when any component lacks amd64 support', async () => {
      verifyRepositoryStub.resolves({
        verified: true, supportedArchitectures: ['arm64'],
      });
      const spec = await decryptedV9Spec({
        components: oneComponent({ name: 'c1', image: 'arm-only:latest' }),
      });
      try {
        await verifyImageRegistryAndArchitectures(spec, { owner: spec.owner, isEncrypted: true });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('amd64');
        expect(err.message).to.include('Arcane');
        // named off the real spec/component, not off the test's literals
        expect(err.message).to.include(spec.name);
        expect(err.message).to.include('c1 (arm-only:latest)');
      }
    });
  });

  describe('enterprise v7 apps (short-circuit on imageAuth)', () => {
    it('returns early without registry probe when a component has imageAuth set', async () => {
      const spec = v7Spec([legacyComponent({ name: 'c1', repoauth: 'pgp-encrypted-blob' })]);
      expect(spec.version).to.equal(7);
      expect(spec.componentEntries()[0][1].imageAuth).to.equal('pgp-encrypted-blob');

      await verifyImageRegistryAndArchitectures(spec);

      expect(verifyRepositoryStub.called).to.be.false;
      // The short-circuit skips the REGISTRY, never the blocklist: the gate is
      // still asked about every image the spec declares.
      expectBlocklistAskedAboutRealImages(spec);
    });

    it('verifies every image when no component has imageAuth set', async () => {
      const spec = v7Spec([
        legacyComponent({
          name: 'a', repotag: 'nginx:latest', ports: [31443], containerPorts: [443],
        }),
        legacyComponent({
          name: 'b', repotag: 'redis:latest', ports: [31444], containerPorts: [6379],
        }),
      ]);

      await verifyImageRegistryAndArchitectures(spec);

      expect(verifyRepositoryStub.callCount).to.equal(2);
      expectRepositoryProbedFor(spec, ['a', 'b']);
      expectBlocklistAskedAboutRealImages(spec);
    });
  });

  describe('non-enterprise apps', () => {
    it('accepts when all components share at least one architecture', async () => {
      verifyRepositoryStub.resolves({
        verified: true, supportedArchitectures: ['amd64', 'arm64'],
      });
      const spec = await v8Spec({
        compose: [
          legacyComponent({
            name: 'a', repotag: 'nginx:latest', ports: [31443], containerPorts: [443],
          }),
          legacyComponent({
            name: 'b', repotag: 'redis:latest', ports: [31444], containerPorts: [6379],
          }),
        ],
      });

      await verifyImageRegistryAndArchitectures(spec, { owner: spec.owner });

      expectRepositoryProbedFor(spec, ['a', 'b']);
      expectBlocklistAskedAboutRealImages(spec);
    });

    it('rejects when components have no common architecture', async () => {
      verifyRepositoryStub.onFirstCall().resolves({
        verified: true, supportedArchitectures: ['amd64'],
      });
      verifyRepositoryStub.onSecondCall().resolves({
        verified: true, supportedArchitectures: ['arm64'],
      });
      const spec = await v9Two();
      try {
        await verifyImageRegistryAndArchitectures(spec, { owner: spec.owner });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('common architecture');
        // the refusal names the real components and their real images
        expect(err.message).to.include('web (nginx:latest): amd64');
        expect(err.message).to.include('api (redis:latest): arm64');
      }
    });
  });

  describe('rootFs fit (measured decompressed size)', () => {
    it('checks the fit against the decompressed size, not the compressed one', async () => {
      verifyRepositoryStub.resolves({
        verified: true,
        supportedArchitectures: ['amd64'],
        imageSizeBytes: 2e9,
        decompressedSizeBytes: 5.4e9,
        decompressedSizeClearanceBytes: 5.4e9,
      });
      // Real budget, real arithmetic: 5.4e9 <= 6 * 1e9, so the class says it fits.
      const spec = await v9One({ rootFsGb: 6 });
      const [, comp] = spec.componentEntries()[0];
      // spy, not stub — the answer stays the class's own
      const fits = sinon.spy(comp, 'imageFitsRootFs');

      await verifyImageRegistryAndArchitectures(spec, { owner: spec.owner });

      expect(fits.calledOnceWithExactly(5.4e9)).to.be.true;
      expect(fits.returnValues[0]).to.be.true;
    });

    it('rejects an image whose compressed size fits but whose decompressed size does not', async () => {
      verifyRepositoryStub.resolves({
        verified: true,
        supportedArchitectures: ['amd64'],
        imageSizeBytes: 1.5e9,
        decompressedSizeBytes: 4.2e9,
        decompressedSizeClearanceBytes: 4.2e9,
      });
      // 1.5e9 fits a 2GB budget; 4.2e9 does not. The real component decides.
      const spec = await v9One({ name: 'c', image: 'big:latest', rootFsGb: 2 });

      try {
        await verifyImageRegistryAndArchitectures(spec, { owner: spec.owner });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include("Component 'c' image (big:latest)");
        expect(err.message).to.include('decompresses to 4.20GB');
        expect(err.message).to.include('rootFsGb budget of 2GB');
        expect(err.message).to.include('Declare a rootFsGb of at least 5');
        expect(err.message).to.include('zstd');
        expect(err.message).to.include('split the oversized layer');
      }
    });

    it('requires the next candidate up when the measurement was ambiguous', async () => {
      // pytorch-shaped: 7.56GB measured, 11.86GB if the trailer wrapped twice.
      verifyRepositoryStub.resolves({
        verified: true,
        supportedArchitectures: ['amd64'],
        imageSizeBytes: 3.62e9,
        decompressedSizeBytes: 7_564_967_296,
        decompressedSizeClearanceBytes: 11_859_934_592,
      });
      // 8GB clears the measurement but not the clearance — the real component
      // refuses on the larger candidate, which is the whole point of the rule.
      const spec = await v9One({ name: 'c', image: 'pytorch:latest', rootFsGb: 8 });
      const [, comp] = spec.componentEntries()[0];
      const fits = sinon.spy(comp, 'imageFitsRootFs');

      try {
        await verifyImageRegistryAndArchitectures(spec, { owner: spec.owner });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(fits.calledOnceWithExactly(11_859_934_592)).to.be.true;
        expect(fits.returnValues[0]).to.be.false;
        expect(err.message).to.include('at least 7.56GB');
        expect(err.message).to.include('may be as large as 11.86GB');
        expect(err.message).to.include('Declare a rootFsGb of at least 12');
      }
    });

    it('accepts an ambiguous measurement whose next candidate still fits', async () => {
      verifyRepositoryStub.resolves({
        verified: true,
        supportedArchitectures: ['amd64'],
        imageSizeBytes: 3.62e9,
        decompressedSizeBytes: 7_564_967_296,
        decompressedSizeClearanceBytes: 11_859_934_592,
      });
      const spec = await v9One({ name: 'c', image: 'pytorch:latest', rootFsGb: 12 });
      const [, comp] = spec.componentEntries()[0];
      const fits = sinon.spy(comp, 'imageFitsRootFs');

      await verifyImageRegistryAndArchitectures(spec, { owner: spec.owner });

      expect(fits.calledOnceWithExactly(11_859_934_592)).to.be.true;
      expect(fits.returnValues[0]).to.be.true;
    });
  });

  describe('rootFs fit (unmeasured, compressed-size fallback)', () => {
    it('rejects when the component reports the image does not fit its rootFs budget', async () => {
      verifyRepositoryStub.resolves({
        verified: true, supportedArchitectures: ['amd64'], imageSizeBytes: 5e9,
      });
      const spec = await v9One({ name: 'big', image: 'big:latest', rootFsGb: 2 });
      try {
        await verifyImageRegistryAndArchitectures(spec, { owner: spec.owner });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include("Component 'big' image (big:latest) is 5.00GB compressed");
        expect(err.message).to.include('rootFsGb');
        expect(err.message).to.include('exceeds');
      }
    });

    it('skips the fit check when the image size is unknown', async () => {
      verifyRepositoryStub.resolves({ verified: true, supportedArchitectures: ['amd64'] });
      // rootFsGb 2 against an unknown size: the component would refuse if asked,
      // so "not called" is the only thing that lets this pass.
      const spec = await v9One({ name: 'c', rootFsGb: 2 });
      const [, comp] = spec.componentEntries()[0];
      const fits = sinon.spy(comp, 'imageFitsRootFs');

      await verifyImageRegistryAndArchitectures(spec, { owner: spec.owner });

      expect(fits.called).to.be.false;
    });

    it('accepts when the component reports the image fits', async () => {
      verifyRepositoryStub.resolves({
        verified: true, supportedArchitectures: ['amd64'], imageSizeBytes: 1e9,
      });
      const spec = await v9One({ name: 'c', rootFsGb: 10 });
      const [, comp] = spec.componentEntries()[0];
      const fits = sinon.spy(comp, 'imageFitsRootFs');

      await verifyImageRegistryAndArchitectures(spec, { owner: spec.owner });

      expect(fits.calledOnceWithExactly(1e9)).to.be.true;
      expect(fits.returnValues[0]).to.be.true;
    });

    it('never charges a legacy component for the image — rootFsGb is a writable-layer floor there', async () => {
      verifyRepositoryStub.resolves({
        verified: true,
        supportedArchitectures: ['amd64'],
        imageSizeBytes: 40e9,
        decompressedSizeBytes: 90e9,
        decompressedSizeClearanceBytes: 90e9,
      });
      const spec = await v8Spec();
      const [, comp] = spec.componentEntries()[0];
      expect(comp.rootFsIncludesImage, 'legacy rootFsGb excludes the image').to.be.false;
      const fits = sinon.spy(comp, 'imageFitsRootFs');

      await verifyImageRegistryAndArchitectures(spec, { owner: spec.owner });

      // Asked, and the real class answered yes to 90GB against a 10GB budget.
      expect(fits.calledOnceWithExactly(90e9)).to.be.true;
      expect(fits.returnValues[0]).to.be.true;
    });
  });

  describe('blocked images', () => {
    it('throws when isImageBlocked returns blocked', async () => {
      const spec = await v9One();
      isImageBlockedStub.resolves({ blocked: true, reason: 'image is blacklisted' });
      try {
        await verifyImageRegistryAndArchitectures(spec, { owner: spec.owner });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('blacklisted');
      }
      // the refusal was reached from the spec's real images, not from an empty list
      expectBlocklistAskedAboutRealImages(spec);
      expect(verifyRepositoryStub.called, 'a blocked spec is never probed').to.be.false;
    });
  });

  describe('the spec contract the validator reads', () => {
    it('answers every delegation the validator depends on', async () => {
      const spec = await v9One();

      // spec-level: the blocklist list and the component iteration
      assertAnswers(spec, ['allImages', 'componentEntries']);
      expect(spec.allImages()).to.deep.equal(['nginx:latest']);
      expect(spec.version).to.equal(9);

      // component-level: everything the loop reads off each entry
      const [name, comp] = spec.componentEntries()[0];
      expect(name).to.equal('web');
      assertAnswers(comp, ['imageFitsRootFs']);
      expect(comp.name).to.equal('web');
      expect(comp.image).to.equal('nginx:latest');
      expect(comp.rootFsGb).to.equal(2);
      // production normalises with `comp.imageAuth || null`. The real classes
      // answer null (v9) or '' (v1-v8) when unset — never undefined, which is
      // what reading the property off a non-component would give.
      expect(comp.imageAuth).to.satisfy((value) => value === null || value === '');
    });
  });
});
