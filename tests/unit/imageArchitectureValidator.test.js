const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

// Tests for imageArchitectureValidator.verifyImageRegistryAndArchitectures.
//
// Extracted from appValidator.verifyAppSpecifications during Stage 3.4
// of the v9 migration. The function composes two imageManager probes
// (verifyRepository + checkApplicationImagesCompliance) with the
// network-wide architecture rules (enterprise = amd64 everywhere;
// non-enterprise = common arch across components). Proxyquire stubs
// imageManager cleanly since the dependency is now a real import.

describe('imageArchitectureValidator.verifyImageRegistryAndArchitectures', () => {
  let verifyImageRegistryAndArchitectures;
  let verifyRepositoryStub;
  let checkApplicationImagesComplianceStub;

  function makeComponent(overrides = {}) {
    return {
      name: 'component1',
      description: 'Component 1',
      repotag: 'nginx:latest',
      repoauth: '',
      ports: [],
      domains: [],
      environmentParameters: [],
      commands: [],
      containerPorts: [],
      containerData: '/data',
      cpu: 0.5,
      ram: 500,
      hdd: 5,
      ...overrides,
    };
  }

  function makeSpec(overrides = {}) {
    return {
      name: 'testapp',
      version: 8,
      description: 'Test app',
      owner: '1owner',
      enterprise: false,
      contacts: ['contact@example.com'],
      geolocation: [],
      expire: 88000,
      nodes: [],
      staticip: false,
      datacenter: false,
      compose: [makeComponent()],
      instances: 3,
      ...overrides,
    };
  }

  beforeEach(() => {
    verifyRepositoryStub = sinon.stub().resolves({
      verified: true,
      supportedArchitectures: ['amd64', 'arm64'],
    });
    checkApplicationImagesComplianceStub = sinon.stub().resolves(true);

    ({ verifyImageRegistryAndArchitectures } = proxyquire(
      '../../ZelBack/src/services/appSecurity/imageArchitectureValidator',
      {
        './imageManager': {
          verifyRepository: verifyRepositoryStub,
          checkApplicationImagesCompliance: checkApplicationImagesComplianceStub,
        },
      },
    ));
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('enterprise Arcane (v8+) apps', () => {
    it('accepts when every component supports amd64', async () => {
      verifyRepositoryStub.resolves({
        verified: true, supportedArchitectures: ['amd64', 'arm64'],
      });
      await verifyImageRegistryAndArchitectures(makeSpec({ enterprise: true }));
    });

    it('rejects when any component lacks amd64 support', async () => {
      verifyRepositoryStub.resolves({
        verified: true, supportedArchitectures: ['arm64'],
      });
      const spec = makeSpec({
        enterprise: true,
        compose: [makeComponent({ repotag: 'arm-only:latest' })],
      });
      try {
        await verifyImageRegistryAndArchitectures(spec);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('amd64');
        expect(err.message).to.include('Arcane');
      }
    });
  });

  describe('enterprise v7 apps (short-circuit on repoauth)', () => {
    it('returns early without registry probe when a component has repoauth set', async () => {
      const spec = makeSpec({
        version: 7,
        enterprise: true,
        compose: [makeComponent({ repoauth: 'pgp-encrypted-blob' })],
      });
      await verifyImageRegistryAndArchitectures(spec);
      expect(verifyRepositoryStub.called).to.be.false;
    });

    it('verifies every repotag when no component has repoauth set', async () => {
      const spec = makeSpec({
        version: 7,
        enterprise: false,
        compose: [
          makeComponent({ name: 'a', repotag: 'nginx:latest' }),
          makeComponent({ name: 'b', repotag: 'redis:latest' }),
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
        compose: [makeComponent({ name: 'a' }), makeComponent({ name: 'b' })],
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
        compose: [makeComponent({ name: 'a' }), makeComponent({ name: 'b' })],
      });
      try {
        await verifyImageRegistryAndArchitectures(spec);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('common architecture');
      }
    });
  });

  describe('v1-v3 flat specs', () => {
    it('uses the spec-level repotag (no compose array) and collects its architectures', async () => {
      verifyRepositoryStub.resolves({
        verified: true, supportedArchitectures: ['amd64'],
      });
      await verifyImageRegistryAndArchitectures({
        name: 'flat',
        version: 2,
        repotag: 'legacy:v2',
      });
      expect(verifyRepositoryStub.calledOnce).to.be.true;
      expect(verifyRepositoryStub.firstCall.args[0]).to.equal('legacy:v2');
    });

    it('propagates blocked-repo failures from checkApplicationImagesCompliance', async () => {
      checkApplicationImagesComplianceStub.rejects(new Error('image is blacklisted'));
      try {
        await verifyImageRegistryAndArchitectures(makeSpec());
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('blacklisted');
      }
    });
  });
});
