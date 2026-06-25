const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const express = require('express');
const request = require('supertest');

describe('appSubmission tests', () => {
  let appSubmission;
  let stubs;

  // Builds a cleartext v9 spec instance shape (the thing validateSubmissionSpec returns).
  function v9Spec(overrides = {}) {
    return {
      name: 'myapp',
      owner: 'owner1',
      version: 9,
      serialize: sinon.stub().returns({ form: 'cleartext-v9' }),
      toCanonical: sinon.stub().returns({ canonical: true }),
      contentHash: sinon.stub().returns('HASH123'),
      ...overrides,
    };
  }

  function load() {
    return proxyquire('../../ZelBack/src/services/appRequirements/appSubmission', {
      config: { fluxapps: { latestSupportedSpecVersion: 9, minOutgoing: 0, minIncoming: 0 } },
      '../utils/transportHelper': stubs.transportHelper,
      '../utils/specCutover': stubs.specCutover,
      '../utils/specLibs': stubs.specLibs,
      '../appSecurity/imageArchitectureValidator': stubs.imageArchitectureValidator,
      '../entitlementsState': stubs.entitlementsState,
      '../marketplace/marketplaceTemplateCache': stubs.marketplaceTemplateCache,
      '../appDatabase/registryManager': stubs.registryManager,
      '../daemonService/daemonServiceMiscRpcs': stubs.daemonServiceMiscRpcs,
      '../appDatabase/appSpecHistory': stubs.appSpecHistory,
      '../appDatabase/appsRepository': {},
      '../appMessaging/messageVerifier': {},
      '../appMessaging/appEventVerifier': {},
      '../fluxCommunicationMessagesSender': {},
      '../verificationHelper': {},
      '../utils/peerState': { peerManager: {} },
      '../../lib/log': { warn: sinon.stub(), info: sinon.stub(), error: sinon.stub() },
    });
  }

  beforeEach(() => {
    stubs = {
      transportHelper: { openTransportEnvelope: sinon.stub() },
      specCutover: { deserializeSpec: sinon.stub() },
      specLibs: {
        validateSubmissionSpec: sinon.stub(),
        getSpec: sinon.stub().resolves({ FluxAppSpecV9: { fromSubmission: sinon.stub().returns({ templateSpec: true }) } }),
        getSpecBackend: sinon.stub(),
        assertUpdateInvariants: sinon.stub().resolves(),
      },
      imageArchitectureValidator: { verifyImageRegistryAndArchitectures: sinon.stub().resolves() },
      entitlementsState: { assertSpecEntitled: sinon.stub().resolves() },
      marketplaceTemplateCache: { getTemplate: sinon.stub().resolves({ spec: { version: 9 }, userConfigurable: [] }) },
      registryManager: { checkApplicationRegistrationNameConflicts: sinon.stub().resolves() },
      daemonServiceMiscRpcs: { isDaemonSynced: sinon.stub().returns({ data: { synced: true, height: 100 } }) },
      appSpecHistory: { getPreviousSpec: sinon.stub() },
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('resolveSubmission', () => {
    it('validates a cleartext v9 submission and broadcasts the cleartext wire form', async () => {
      appSubmission = load();
      const spec = v9Spec();
      const submission = { version: 9, name: 'myapp', owner: 'owner1' };
      stubs.transportHelper.openTransportEnvelope.resolves(submission);
      stubs.specCutover.deserializeSpec.resolves({ isEncrypted: false });
      stubs.specLibs.validateSubmissionSpec.resolves(spec);

      const result = await appSubmission.resolveSubmission(submission, {
        contentHash: 'HASH123', timestamp: 1, type: 'fluxappregister', daemonHeight: 100,
      });

      expect(result.isEncrypted).to.be.false;
      expect(result.broadcastBlob).to.deep.equal({ form: 'cleartext-v9' });
      // v9 cleartext is gated and not backend-encrypted
      sinon.assert.calledOnce(stubs.entitlementsState.assertSpecEntitled);
      sinon.assert.notCalled(stubs.specLibs.getSpecBackend);
    });

    it('backend-encrypts a transport-encrypted v9 submission and never broadcasts cleartext', async () => {
      appSubmission = load();
      const spec = v9Spec();
      const sparse = { version: 9, name: 'myapp', owner: 'owner1' };
      const submission = {
        version: 9, name: 'myapp', owner: 'owner1', transportEncrypted: { algorithm: 'x' },
      };
      stubs.transportHelper.openTransportEnvelope.resolves(sparse);
      stubs.specCutover.deserializeSpec.resolves({ isEncrypted: false });
      stubs.specLibs.validateSubmissionSpec.resolves(spec);
      const encryptedSpec = { serialize: sinon.stub().returns({ form: 'EncryptedSpecV9' }) };
      const sealForStorage = sinon.stub().resolves(encryptedSpec);
      stubs.specLibs.getSpecBackend.resolves({ sealForStorage });

      const result = await appSubmission.resolveSubmission(submission, {
        contentHash: 'HASH123', timestamp: 1, type: 'fluxappregister', daemonHeight: 100,
      });

      expect(result.isEncrypted).to.be.true;
      expect(result.broadcastBlob).to.deep.equal({ form: 'EncryptedSpecV9' });
      // the cleartext serialize must never become the wire form
      sinon.assert.notCalled(spec.serialize);
      sinon.assert.calledOnce(sealForStorage);
      sinon.assert.calledWith(sealForStorage, spec);
    });

    it('decrypts a v8 enterprise blob, validates the inner spec, and keeps the encrypted wire form', async () => {
      appSubmission = load();
      const innerSerialize = sinon.stub().returns({ inner: 'cleartext' });
      const decrypted = { spec: { serialize: innerSerialize, version: 8 }, name: 'myapp', owner: 'owner1' };
      const wireSpec = {
        isEncrypted: true,
        createProvider: sinon.stub().resolves({ p: 1 }),
        decrypt: sinon.stub().resolves(decrypted),
        serialize: sinon.stub().returns({ form: 'v8-enterprise-blob' }),
      };
      const submission = { version: 8, name: 'myapp' };
      stubs.transportHelper.openTransportEnvelope.resolves(submission);
      stubs.specCutover.deserializeSpec.resolves(wireSpec);

      const result = await appSubmission.resolveSubmission(submission, {
        timestamp: 1, type: 'fluxappregister', daemonHeight: 100,
      });

      expect(result.isEncrypted).to.be.true;
      expect(result.broadcastBlob).to.deep.equal({ form: 'v8-enterprise-blob' });
      sinon.assert.calledOnce(wireSpec.decrypt);
      sinon.assert.calledWith(stubs.specLibs.validateSubmissionSpec, { inner: 'cleartext' }, { height: 100 });
      // the entitlements gate runs for every version now (no version branch); v8
      // carries no gated features, so it is a no-op rather than skipped
      sinon.assert.calledOnce(stubs.entitlementsState.assertSpecEntitled);
    });

    it('runs the entitlements gate for a legacy v8 spec without a version branch', async () => {
      appSubmission = load();
      const spec = {
        name: 'myapp', owner: 'owner1', version: 8, serialize: sinon.stub().returns({ form: 'v8-cleartext' }),
      };
      stubs.transportHelper.openTransportEnvelope.resolves({ version: 8, name: 'myapp', owner: 'owner1' });
      stubs.specCutover.deserializeSpec.resolves({ isEncrypted: false });
      stubs.specLibs.validateSubmissionSpec.resolves(spec);

      const result = await appSubmission.resolveSubmission({ version: 8, name: 'myapp', owner: 'owner1' }, {
        timestamp: 1, type: 'fluxappregister', daemonHeight: 100,
      });

      expect(result.broadcastBlob).to.deep.equal({ form: 'v8-cleartext' });
      // the gate executes for v8 (proving no version branch) and no-ops: it is
      // entitlement-checked but carries no marketplace block to verify
      sinon.assert.calledOnceWithExactly(stubs.entitlementsState.assertSpecEntitled, spec, 'owner1', 100, false);
      sinon.assert.notCalled(stubs.marketplaceTemplateCache.getTemplate);
    });

    it('rejects when the signed contentHash does not match the decrypted content', async () => {
      appSubmission = load();
      const spec = v9Spec({ contentHash: sinon.stub().returns('ACTUAL') });
      stubs.transportHelper.openTransportEnvelope.resolves({ version: 9 });
      stubs.specCutover.deserializeSpec.resolves({ isEncrypted: false });
      stubs.specLibs.validateSubmissionSpec.resolves(spec);

      try {
        await appSubmission.resolveSubmission({ version: 9 }, { contentHash: 'EXPECTED', daemonHeight: 100 });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('contentHash does not match');
        expect(err.code).to.equal('DECRYPT_FAILED');
      }
    });

    it('propagates a feature-entitlement denial from the STAGE 4 gate', async () => {
      appSubmission = load();
      const spec = v9Spec();
      stubs.transportHelper.openTransportEnvelope.resolves({ version: 9 });
      stubs.specCutover.deserializeSpec.resolves({ isEncrypted: false });
      stubs.specLibs.validateSubmissionSpec.resolves(spec);
      const denial = new Error('feature networkSharing not entitled');
      denial.code = 'FEATURE_NOT_ENTITLED';
      stubs.entitlementsState.assertSpecEntitled.rejects(denial);

      try {
        await appSubmission.resolveSubmission({ version: 9 }, { contentHash: 'HASH123', daemonHeight: 100 });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.code).to.equal('FEATURE_NOT_ENTITLED');
      }
    });
  });

  describe('validateAppUpdate', () => {
    it('enforces registration-locked invariants via assertUpdateInvariants', async () => {
      appSubmission = load();
      const spec = v9Spec();
      stubs.transportHelper.openTransportEnvelope.resolves({ version: 9 });
      stubs.specCutover.deserializeSpec.resolves({ isEncrypted: false });
      stubs.specLibs.validateSubmissionSpec.resolves(spec);
      stubs.appSpecHistory.getPreviousSpec.resolves(v9Spec());
      const lockErr = new Error('referral is registration-locked and cannot change');
      stubs.specLibs.assertUpdateInvariants.rejects(lockErr);

      try {
        await appSubmission.validateAppUpdate({ version: 9 }, { contentHash: 'HASH123' });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('registration-locked');
        sinon.assert.calledOnce(stubs.specLibs.assertUpdateInvariants);
      }
    });

    it('rejects when the app to update does not exist', async () => {
      appSubmission = load();
      const spec = v9Spec();
      stubs.transportHelper.openTransportEnvelope.resolves({ version: 9 });
      stubs.specCutover.deserializeSpec.resolves({ isEncrypted: false });
      stubs.specLibs.validateSubmissionSpec.resolves(spec);
      stubs.appSpecHistory.getPreviousSpec.resolves(null);

      try {
        await appSubmission.validateAppUpdate({ version: 9 }, { contentHash: 'HASH123' });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('does not exist and cannot be updated');
      }
    });

    it('delegates the version-transition gate to UpdatePolicy and propagates its rejection', async () => {
      const assertVersionTransition = sinon.stub().throws(
        new Error('Application update rejected: Version changes are only allowed when updating to version 9 (current latest supported version).'),
      );
      stubs.specLibs.getSpec = sinon.stub().resolves({
        FluxAppSpecV9: { fromSubmission: sinon.stub().returns({ templateSpec: true }) },
        UpdatePolicy: { assertVersionTransition },
      });
      appSubmission = load();
      const updateSpec = {
        name: 'myapp', owner: 'owner1', version: 8, serialize: sinon.stub().returns({ form: 'v8' }),
      };
      const previousSpec = { name: 'myapp', owner: 'owner1', version: 7 };
      stubs.transportHelper.openTransportEnvelope.resolves({ version: 8 });
      stubs.specCutover.deserializeSpec.resolves({ isEncrypted: false });
      stubs.specLibs.validateSubmissionSpec.resolves(updateSpec);
      stubs.appSpecHistory.getPreviousSpec.resolves(previousSpec);

      try {
        await appSubmission.validateAppUpdate({ version: 8 }, {});
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('Version changes are only allowed');
      }
      // the gate is delegated to flux-spec with the prior spec, the proposed
      // spec, and the network's latest supported version.
      sinon.assert.calledOnceWithExactly(assertVersionTransition, previousSpec, updateSpec, 9);
    });
  });

  describe('marketplace template verification', () => {
    function marketplaceSpec(matchesResult) {
      return v9Spec({
        marketplace: { templateId: 'uuid-1', templateVersion: 2 },
        matchesTemplate: sinon.stub().returns(matchesResult),
        toCanonical: sinon.stub().returns({ name: 'myapp', owner: 'owner1', contacts: { email: ['a@b.co'] } }),
      });
    }

    async function submit(spec, submission = { version: 9, name: 'myapp', owner: 'owner1' }) {
      appSubmission = load();
      stubs.transportHelper.openTransportEnvelope.resolves(submission);
      stubs.specCutover.deserializeSpec.resolves({ isEncrypted: false });
      stubs.specLibs.validateSubmissionSpec.resolves(spec);
      return appSubmission.resolveSubmission(submission, {
        contentHash: 'HASH123', timestamp: 1, type: 'fluxappregister', daemonHeight: 100,
      });
    }

    it('accepts a marketplace app whose spec matches the template', async () => {
      const spec = marketplaceSpec({ matches: true, mismatches: [] });
      const result = await submit(spec);
      sinon.assert.calledWith(stubs.marketplaceTemplateCache.getTemplate, 'uuid-1', 2);
      sinon.assert.calledOnce(spec.matchesTemplate);
      expect(result.spec).to.equal(spec);
    });

    it('hard-rejects when the spec does not match the template', async () => {
      const spec = marketplaceSpec({ matches: false, mismatches: ['components.web.cpu'] });
      let err;
      try { await submit(spec); } catch (e) { err = e; }
      expect(err).to.exist;
      expect(err.message).to.match(/does not match marketplace template/);
      expect(err.message).to.include('components.web.cpu');
    });

    it('rejects (retry) when the template is unavailable', async () => {
      const spec = marketplaceSpec({ matches: true, mismatches: [] });
      stubs.marketplaceTemplateCache.getTemplate = sinon.stub().rejects(new Error('Marketplace template uuid-1 v2 not available, try again later'));
      let err;
      try { await submit(spec); } catch (e) { err = e; }
      expect(err).to.exist;
      expect(err.message).to.match(/not available/);
    });

    it('skips verification for a non-marketplace app', async () => {
      const spec = v9Spec();
      await submit(spec);
      sinon.assert.notCalled(stubs.marketplaceTemplateCache.getTemplate);
    });

    describe('tiered templates (configs)', () => {
      function tieredTemplate(extra = {}) {
        return {
          spec: { version: 9 },
          useConfig: true,
          configs: [{ id: 'tier-heavy', overrides: { instances: 2 } }],
          userConfigurable: [],
          ...extra,
        };
      }

      function configuredSpec(configId, matchesResult) {
        return v9Spec({
          marketplace: { templateId: 'uuid-1', templateVersion: 2, configId },
          matchesTemplate: sinon.stub().returns(matchesResult),
          toCanonical: sinon.stub().returns({ name: 'myapp', owner: 'owner1', contacts: { email: ['a@b.co'] } }),
        });
      }

      it('verifies against the merged base+override spec for the deployed tier', async () => {
        const deepMerge = sinon.stub().returns({ version: 9, merged: true });
        const fromSubmission = sinon.stub().returns({ templateSpec: true });
        stubs.specLibs.getSpec = sinon.stub().resolves({ FluxAppSpecV9: { fromSubmission }, deepMerge });
        stubs.marketplaceTemplateCache.getTemplate = sinon.stub().resolves(tieredTemplate());

        const spec = configuredSpec('tier-heavy', { matches: true, mismatches: [] });
        const result = await submit(spec);

        sinon.assert.calledWith(deepMerge, { version: 9 }, { instances: 2 });
        sinon.assert.calledOnce(spec.matchesTemplate);
        expect(result.spec).to.equal(spec);
      });

      it('hard-rejects a tiered template deploy with no configId', async () => {
        stubs.marketplaceTemplateCache.getTemplate = sinon.stub().resolves(tieredTemplate());
        const spec = configuredSpec(null, { matches: true, mismatches: [] });
        let err;
        try { await submit(spec); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.code).to.equal('TEMPLATE_MISMATCH');
        expect(err.message).to.match(/configId is required/);
      });

      it('hard-rejects an unknown configId', async () => {
        stubs.marketplaceTemplateCache.getTemplate = sinon.stub().resolves(tieredTemplate());
        const spec = configuredSpec('tier-nope', { matches: true, mismatches: [] });
        let err;
        try { await submit(spec); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.code).to.equal('TEMPLATE_MISMATCH');
        expect(err.message).to.match(/no config tier-nope/);
      });

      it('hard-rejects a configId on a non-tiered template', async () => {
        stubs.marketplaceTemplateCache.getTemplate = sinon.stub().resolves({ spec: { version: 9 }, useConfig: false, userConfigurable: [] });
        const spec = configuredSpec('tier-heavy', { matches: true, mismatches: [] });
        let err;
        try { await submit(spec); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.code).to.equal('TEMPLATE_MISMATCH');
        expect(err.message).to.match(/not tiered/);
      });
    });
  });

  describe('parseMultipartSubmission', () => {
    // Drive a real multipart request through formidable to confirm the wire
    // contract: the `spec` field, `blob:sha256:<hex>` file parts keyed by hash,
    // and the `ownerSigs` JSON map.
    function appWithParser() {
      appSubmission = load();
      const app = express();
      app.post('/submit', (req, res) => {
        appSubmission.parseMultipartSubmission(req).then((parsed) => res.json({
          spec: parsed.spec,
          blobHashes: [...parsed.blobs.keys()],
          blobBytes: Object.fromEntries([...parsed.blobs.entries()].map(([h, b]) => [h, b.toString()])),
          ownerSigs: Object.fromEntries(parsed.ownerSigs),
        })).catch((err) => res.status(500).json({ error: err.message }));
      });
      return app;
    }

    it('extracts the spec field, blob parts by hash, and the ownerSigs map', async () => {
      const specJson = JSON.stringify({ type: 'fluxappregister', version: 2 });
      const ha = `sha256:${'a'.repeat(64)}`;
      const ownerSigs = JSON.stringify({ [ha]: { sig: 'owner-sig', timestamp: '1700000000' } });

      const res = await request(appWithParser())
        .post('/submit')
        .field('spec', specJson)
        .field('ownerSigs', ownerSigs)
        .attach(`blob:${ha}`, Buffer.from('blob-bytes'), { filename: 'content' });

      expect(res.status).to.equal(200);
      expect(res.body.spec).to.equal(specJson);
      expect(res.body.blobHashes).to.deep.equal([ha]);
      expect(res.body.blobBytes[ha]).to.equal('blob-bytes');
      expect(res.body.ownerSigs[ha]).to.deep.equal({ sig: 'owner-sig', timestamp: '1700000000' });
    });

    it('returns no blobs and an empty ownerSigs map for a spec-only multipart post', async () => {
      const res = await request(appWithParser())
        .post('/submit')
        .field('spec', JSON.stringify({ type: 'fluxappregister' }));

      expect(res.status).to.equal(200);
      expect(res.body.blobHashes).to.deep.equal([]);
      expect(res.body.ownerSigs).to.deep.equal({});
    });
  });
});
