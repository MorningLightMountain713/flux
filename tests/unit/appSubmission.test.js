'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const express = require('express');
const request = require('supertest');
const {
  loadSpecLibrary, V9_SUBMISSION, V8_SUBMISSION, v8Spec, sealedV9Spec, assertAnswers,
} = require('./fixtures/fluxSpec');

// The spec library is real here, not stubbed — see tests/unit/fixtures/fluxSpec.js
// for why. What stays stubbed is I/O and FluxOS policy.
let flux;

// What a marketplace template stores: a v9 spec body with no owner, name or
// contacts, which the gate completes from the deployed spec before comparing.
const TEMPLATE_BODY = (() => {
  const body = { ...V9_SUBMISSION };
  // A template carries the app's shape, not its identity: the gate fills name,
  // owner and contacts in from the deployed spec before comparing.
  delete body.name;
  delete body.owner;
  delete body.contacts;
  return body;
})();

const TEMPLATE_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8';
const UNKNOWN_CONFIG_ID = '00000000-1111-4222-8333-444444444444';
const CONFIG_ID = '9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a';

describe('appSubmission tests', () => {
  let appSubmission;
  let stubs;

  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(30000);
    flux = await loadSpecLibrary();
  });

  /** A real FluxAppSpecV9, with serialize spied so a test can assert it was never called. */
  function v9Spec(overrides = {}) {
    const spec = flux.FluxAppSpecV9.fromSubmission({ ...V9_SUBMISSION, ...overrides });
    sinon.spy(spec, 'serialize');
    return spec;
  }

  function load() {
    return proxyquire('../../ZelBack/src/services/appRequirements/appSubmission', {
      config: { fluxapps: { latestSupportedSpecVersion: 9, minOutgoing: 0, minIncoming: 0 } },
      '../appLifecycle/contentBlobService': stubs.contentBlobService,
      '../utils/transportHelper': stubs.transportHelper,
      '../utils/specCutover': stubs.specCutover,
      '../utils/specLibs': stubs.specLibs,
      '../appSecurity/imageArchitectureValidator': stubs.imageArchitectureValidator,
      '../entitlementsState': stubs.entitlementsState,
      '../marketplace/marketplaceTemplateCache': stubs.marketplaceTemplateCache,
      '../appDatabase/registryManager': stubs.registryManager,
      '../daemonService/daemonServiceMiscRpcs': stubs.daemonServiceMiscRpcs,
      '../appDatabase/appsRepository': stubs.appsRepository,
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
      contentBlobService: {
        maxContentBytes: sinon.stub().resolves(64 * 1024 * 1024),
        maxBlobBytes: sinon.stub().resolves(2 * 1024 * 1024),
        specContentHashes: sinon.stub().returns(new Set()),
        encryptAndUploadBlobs: sinon.stub().resolves([]),
      },
      transportHelper: { openTransportEnvelope: sinon.stub(), openContentEnvelope: sinon.stub() },
      specCutover: {
        ensureProvidersRegistered: sinon.stub().resolves(),
        // the row's spec, cleartext — an update's prior state comes from the
        // active registry row, sealed for an enterprise app
        resolveInstantiatedSpec: sinon.stub().callsFake((row) => Promise.resolve(row?.spec ?? null)),
      },
      specLibs: {
        // Real library behind FluxOS's own wrappers. assertVersionActivated stays
        // stubbed because it is FluxOS policy about fork heights, not spec shape.
        validateSubmissionSpec: sinon.stub().callsFake(async (blob) => (
          flux.FluxAppSpecBase.getVersionClass(blob.version).fromSubmission(blob)
        )),
        getSpec: sinon.stub().callsFake(async () => flux),
        getSpecBackend: sinon.stub(),
        assertUpdateInvariants: sinon.stub().resolves(),
        assertVersionActivated: sinon.stub(),
      },
      imageArchitectureValidator: { verifyImageRegistryAndArchitectures: sinon.stub().resolves() },
      entitlementsState: { assertSpecEntitled: sinon.stub().resolves() },
      marketplaceTemplateCache: {
        getTemplate: sinon.stub().resolves({ spec: TEMPLATE_BODY, userConfigurable: [] }),
      },
      registryManager: { checkApplicationRegistrationNameConflicts: sinon.stub().resolves() },
      daemonServiceMiscRpcs: { isDaemonSynced: sinon.stub().returns({ data: { synced: true, height: 100 } }) },
      appsRepository: { getGlobalAppInfo: sinon.stub().resolves(null) },
    };
    // resolveSubmission parses via the strict backend deserializer; the default
    // backend carries only that (a test needing sealForStorage adds it).
    stubs.parseSpec = sinon.stub();
    stubs.specLibs.getSpecBackend.resolves({ deserializeSpec: stubs.parseSpec });
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
      stubs.parseSpec.resolves({ isEncrypted: false });
      stubs.specLibs.validateSubmissionSpec.resolves(spec);

      const result = await appSubmission.resolveSubmission(submission, {
        contentHash: spec.contentHash(), timestamp: 1, type: 'fluxappregister', daemonHeight: 100,
      });

      expect(result.isEncrypted).to.be.false;
      // v9 cleartext is gated and not backend-encrypted: the wire form is the
      // spec's own serialization (the stubbed backend has no sealForStorage,
      // so reaching it would throw).
      expect(result.broadcastBlob).to.deep.equal(spec.serialize());
      expect(result.broadcastBlob.components, 'a cleartext app broadcasts its components')
        .to.have.property('web');
      expect(result.broadcastBlob).to.not.have.property('encrypted');
      sinon.assert.calledOnce(stubs.entitlementsState.assertSpecEntitled);
    });

    it('backend-encrypts a transport-encrypted v9 submission and never broadcasts cleartext', async () => {
      appSubmission = load();
      const spec = v9Spec();
      const sparse = { version: 9, name: 'myapp', owner: 'owner1' };
      const submission = {
        version: 9, name: 'myapp', owner: 'owner1', transportEncrypted: { algorithm: 'x' },
      };
      stubs.transportHelper.openTransportEnvelope.resolves(sparse);
      stubs.parseSpec.resolves({ isEncrypted: false });
      stubs.specLibs.validateSubmissionSpec.resolves(spec);
      // The real sealed form the node broadcasts, not a marker object.
      const encryptedSpec = await sealedV9Spec({ name: V9_SUBMISSION.name });
      const sealForStorage = sinon.stub().resolves(encryptedSpec);
      stubs.specLibs.getSpecBackend.resolves({ deserializeSpec: stubs.parseSpec, sealForStorage });

      const result = await appSubmission.resolveSubmission(submission, {
        contentHash: spec.contentHash(), timestamp: 1, type: 'fluxappregister', daemonHeight: 100,
      });

      expect(result.isEncrypted).to.be.true;
      expect(result.broadcastBlob).to.deep.equal(encryptedSpec.serialize());
      expect(result.broadcastBlob.encrypted, 'the sealed form carries ciphertext').to.be.an('object');
      expect(result.broadcastBlob, 'and never the components').to.not.have.property('components');
      // the cleartext serialize must never become the wire form
      sinon.assert.notCalled(spec.serialize);
      sinon.assert.calledOnce(sealForStorage);
      sinon.assert.calledWith(sealForStorage, spec);
    });

    it('decrypts a v8 enterprise blob, validates the inner spec, and keeps the encrypted wire form', async () => {
      appSubmission = load();
      // A REAL sealed v8, decrypted by the real classes through the registered
      // provider. The double this replaced gave its inner spec only `serialize`
      // and `version`, and appSubmission grew `spec.spec || spec` to cope with a
      // wrapper shaped like that — a shape the real DecryptedCanonicalSpec has
      // never had.
      const cleartext = flux.FluxAppSpecV8.fromSubmission(V8_SUBMISSION);
      const wireSpec = await flux.EncryptedSpecV8.fromSpec(
        cleartext, await flux.EncryptedSpecV8.createProviderFor(cleartext.name, cleartext.owner),
      );
      const validateContents = sinon.spy(flux.DecryptedCanonicalSpec.prototype, 'validateContents');
      const submission = wireSpec.serialize();
      stubs.transportHelper.openTransportEnvelope.resolves(submission);
      stubs.parseSpec.resolves(wireSpec);

      // With a signed contentHash, so the guard actually runs against a
      // DecryptedCanonicalSpec — the only path that uses its contentHash
      // delegation, and otherwise unexercised anywhere in this repo.
      const result = await appSubmission.resolveSubmission(submission, {
        contentHash: cleartext.contentHash(),
        timestamp: 1,
        type: 'fluxappregister',
        daemonHeight: 100,
      });

      expect(result.isEncrypted).to.be.true;
      // The submitted blob IS the stored form for v8 — the owner sealed it, so
      // the node re-broadcasts those exact bytes rather than resealing.
      expect(result.broadcastBlob).to.deep.equal(submission);
      expect(result.broadcastBlob.enterprise, 'the ciphertext is the wire form')
        .to.be.a('string').and.not.equal('');
      expect(result.broadcastBlob.compose, 'cleartext components never reach the wire')
        .to.deep.equal([]);
      // Submission rules applied through the wrapper, and the height gate
      // separately — the node owns enforcement heights, flux-spec does not.
      sinon.assert.calledWith(validateContents, { purpose: 'submission' });
      sinon.assert.calledWith(stubs.specLibs.assertVersionActivated, 8, 100);
      // A decrypted spec has no wire form at all; the real class enforces that.
      expect(() => result.spec.serialize()).to.throw();
      // the entitlements gate runs for every version now (no version branch); v8
      // carries no gated features, so it is a no-op rather than skipped
      sinon.assert.calledOnce(stubs.entitlementsState.assertSpecEntitled);

      // Stubbing a collaborator hides whether what we hand it is usable. The
      // gate calls toCanonical() on whatever arrives, and what arrives here is a
      // DecryptedCanonicalSpec — so assert it can answer, or a delegation could
      // disappear from flux-spec with this suite still green. It did, and this
      // suite was.
      //
      // All three of these collaborators receive the spec object, and all three
      // are stubbed here. assertAnswers calls what the real ones call.
      const [gated] = stubs.entitlementsState.assertSpecEntitled.firstCall.args;
      assertAnswers(gated, ['toCanonical']);
      expect(gated.toCanonical()).to.have.property('version', 8);

      const [imaged] = stubs.imageArchitectureValidator
        .verifyImageRegistryAndArchitectures.firstCall.args;
      assertAnswers(imaged, ['allImages', 'componentEntries']);
    });

    it('runs the entitlements gate for a legacy v8 spec without a version branch', async () => {
      appSubmission = load();
      const spec = await v8Spec();
      stubs.transportHelper.openTransportEnvelope.resolves(V8_SUBMISSION);
      stubs.parseSpec.resolves({ isEncrypted: false });
      stubs.specLibs.validateSubmissionSpec.resolves(spec);

      const result = await appSubmission.resolveSubmission(V8_SUBMISSION, {
        timestamp: 1, type: 'fluxappregister', daemonHeight: 100,
      });

      expect(result.broadcastBlob).to.deep.equal(spec.serialize());
      // the gate executes for v8 (proving no version branch) and no-ops: it is
      // entitlement-checked but carries no marketplace block to verify
      sinon.assert.calledOnceWithExactly(
        stubs.entitlementsState.assertSpecEntitled, spec, spec.owner, 100, false,
      );
      sinon.assert.notCalled(stubs.marketplaceTemplateCache.getTemplate);
    });

    it('rejects when the signed contentHash does not match the decrypted content', async () => {
      appSubmission = load();
      // A real spec computes a real hash; the envelope claims a different one.
      const spec = v9Spec();
      stubs.transportHelper.openTransportEnvelope.resolves({ version: 9 });
      stubs.parseSpec.resolves({ isEncrypted: false });
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
      stubs.parseSpec.resolves({ isEncrypted: false });
      stubs.specLibs.validateSubmissionSpec.resolves(spec);
      const denial = new Error('feature networkSharing not entitled');
      denial.code = 'FEATURE_NOT_ENTITLED';
      stubs.entitlementsState.assertSpecEntitled.rejects(denial);

      try {
        await appSubmission.resolveSubmission({ version: 9 }, { daemonHeight: 100 });
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
      stubs.parseSpec.resolves({ isEncrypted: false });
      stubs.specLibs.validateSubmissionSpec.resolves(spec);
      stubs.appsRepository.getGlobalAppInfo.resolves({ spec: v9Spec() });
      const lockErr = new Error('referral is registration-locked and cannot change');
      stubs.specLibs.assertUpdateInvariants.rejects(lockErr);

      try {
        await appSubmission.validateAppUpdate({ version: 9 }, {});
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
      stubs.parseSpec.resolves({ isEncrypted: false });
      stubs.specLibs.validateSubmissionSpec.resolves(spec);
      stubs.appsRepository.getGlobalAppInfo.resolves(null);

      try {
        await appSubmission.validateAppUpdate({ version: 9 }, {});
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
      const updateSpec = await v8Spec();
      const previousSpec = flux.FluxAppSpecBase.getVersionClass(7)
        .fromSubmission({ ...V8_SUBMISSION, version: 7 });
      stubs.transportHelper.openTransportEnvelope.resolves({ version: 8 });
      stubs.parseSpec.resolves({ isEncrypted: false });
      stubs.specLibs.validateSubmissionSpec.resolves(updateSpec);
      stubs.appsRepository.getGlobalAppInfo.resolves({ spec: previousSpec });

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
    // A real spec carrying a real marketplace block. Only the COMPARISON is
    // stubbed, and on the instance — these tests are about how appSubmission
    // reacts to a match or a mismatch, not about flux-spec's matching rules.
    // Stubbing the method on a real object keeps the member set honest.
    function marketplaceSpec(matchesResult) {
      const spec = v9Spec({ marketplace: { templateId: TEMPLATE_ID, templateVersion: 2 } });
      sinon.stub(spec, 'matchesTemplate').returns(matchesResult);
      return spec;
    }

    async function submit(spec, submission = { version: 9, name: 'myapp', owner: 'owner1' }) {
      appSubmission = load();
      stubs.transportHelper.openTransportEnvelope.resolves(submission);
      stubs.parseSpec.resolves({ isEncrypted: false });
      stubs.specLibs.validateSubmissionSpec.resolves(spec);
      return appSubmission.resolveSubmission(submission, {
        contentHash: spec.contentHash(), timestamp: 1, type: 'fluxappregister', daemonHeight: 100,
      });
    }

    it('accepts a marketplace app whose spec matches the template', async () => {
      const spec = marketplaceSpec({ matches: true, mismatches: [] });
      const result = await submit(spec);
      sinon.assert.calledWith(stubs.marketplaceTemplateCache.getTemplate, TEMPLATE_ID, 2);
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
      stubs.marketplaceTemplateCache.getTemplate = sinon.stub().rejects(new Error(`Marketplace template ${TEMPLATE_ID} v2 not available, try again later`));
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
          spec: TEMPLATE_BODY,
          useConfig: true,
          configs: [{ id: CONFIG_ID, overrides: { instances: 2 } }],
          userConfigurable: [],
          ...extra,
        };
      }

      function configuredSpec(configId, matchesResult) {
        const spec = v9Spec({
          marketplace: { templateId: TEMPLATE_ID, templateVersion: 2, configId },
        });
        sinon.stub(spec, 'matchesTemplate').returns(matchesResult);
        return spec;
      }

      it('verifies against the merged base+override spec for the deployed tier', async () => {
        const deepMerge = sinon.stub().returns({ version: 9, merged: true });
        const fromSubmission = sinon.stub().returns({ templateSpec: true });
        stubs.specLibs.getSpec = sinon.stub().resolves({ FluxAppSpecV9: { fromSubmission }, deepMerge });
        stubs.marketplaceTemplateCache.getTemplate = sinon.stub().resolves(tieredTemplate());

        const spec = configuredSpec(CONFIG_ID, { matches: true, mismatches: [] });
        const result = await submit(spec);

        sinon.assert.calledWith(deepMerge, TEMPLATE_BODY, { instances: 2 });
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
        const spec = configuredSpec(UNKNOWN_CONFIG_ID, { matches: true, mismatches: [] });
        let err;
        try { await submit(spec); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.code).to.equal('TEMPLATE_MISMATCH');
        expect(err.message).to.include(UNKNOWN_CONFIG_ID);
      });

      it('hard-rejects a configId on a non-tiered template', async () => {
        stubs.marketplaceTemplateCache.getTemplate = sinon.stub().resolves({ spec: { version: 9 }, useConfig: false, userConfigurable: [] });
        const spec = configuredSpec(CONFIG_ID, { matches: true, mismatches: [] });
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
    // contract: the `spec` field, ONE sealed `content` file part (an HPKE
    // TransportEnvelope over { blobs, manifest? } — never plaintext content), and
    // the `ownerSigs` JSON map.
    function appWithParser() {
      appSubmission = load();
      const app = express();
      app.post('/submit', (req, res) => {
        appSubmission.parseMultipartSubmission(req).then((parsed) => res.json({
          spec: parsed.spec,
          content: parsed.content,
          ownerSigs: Object.fromEntries(parsed.ownerSigs),
        })).catch((err) => res.status(500).json({ error: err.message }));
      });
      return app;
    }

    it('extracts the spec field, the sealed content envelope, and the ownerSigs map', async () => {
      const specJson = JSON.stringify({ type: 'fluxappregister', version: 2 });
      const ha = `sha256:${'a'.repeat(64)}`;
      const ownerSigs = JSON.stringify({ [ha]: { sig: 'owner-sig', timestamp: '1700000000' } });
      // A stand-in TransportEnvelope; parseMultipartSubmission does not open it.
      const envelope = { algorithm: 'x', encapsulatedKey: 'k', nonce: 'n', ciphertext: 'c' };

      const res = await request(appWithParser())
        .post('/submit')
        .field('spec', specJson)
        .field('ownerSigs', ownerSigs)
        .attach('content', Buffer.from(JSON.stringify(envelope)), { filename: 'content.json' });

      expect(res.status).to.equal(200);
      expect(res.body.spec).to.equal(specJson);
      expect(res.body.content).to.deep.equal(envelope);
      expect(res.body.ownerSigs[ha]).to.deep.equal({ sig: 'owner-sig', timestamp: '1700000000' });
    });

    it('returns null content and an empty ownerSigs map for a spec-only multipart post', async () => {
      const res = await request(appWithParser())
        .post('/submit')
        .field('spec', JSON.stringify({ type: 'fluxappregister' }));

      expect(res.status).to.equal(200);
      expect(res.body.content).to.equal(null);
      expect(res.body.ownerSigs).to.deep.equal({});
    });
  });

  describe('uploadSealedContent', () => {
    const HA = `sha256:${'a'.repeat(64)}`;
    const HSLOT = `sha256:${'b'.repeat(64)}`;
    const envelope = { algorithm: 'x', encapsulatedKey: 'k', nonce: 'n', ciphertext: 'c' };
    const spec = { name: 'myapp', owner: '1id' };

    it('transport-opens the sealed envelope (never plaintext) bound to the submission, and uploads only contentRef blobs', async () => {
      appSubmission = load();
      // Sealed payload carries a contentRef blob (HA) and a slot blob (HSLOT).
      stubs.transportHelper.openContentEnvelope.resolves(Buffer.from(JSON.stringify({
        blobs: { [HA]: Buffer.from('ref-bytes').toString('base64'), [HSLOT]: Buffer.from('slot-bytes').toString('base64') },
      })));
      stubs.contentBlobService.specContentHashes.returns(new Set([HA])); // only HA is a contentRef

      const ownerSigs = new Map([[HA, { sig: 's', timestamp: '1700000000' }]]);
      const out = await appSubmission.uploadSealedContent(spec, envelope, ownerSigs, { ref: 'HASH123', timestamp: 1 });

      // Opened toward this node's per-app transport key, AAD-bound to the submission.
      sinon.assert.calledOnceWithExactly(stubs.transportHelper.openContentEnvelope, envelope, {
        appName: 'myapp', owner: '1id', ref: 'HASH123', timestamp: 1,
      });
      // Only the contentRef blob (HA) is uploaded; the slot blob (HSLOT) is left for the slot path.
      sinon.assert.calledOnce(stubs.contentBlobService.encryptAndUploadBlobs);
      const { blobs: refBlobs, priorSpec } = stubs.contentBlobService.encryptAndUploadBlobs.firstCall.args[0];
      expect([...refBlobs.keys()]).to.deep.equal([HA]);
      expect(refBlobs.get(HA).toString()).to.equal('ref-bytes');
      expect(priorSpec).to.equal(undefined); // register — nothing carried over
      // The full opened payload (incl. the slot blob) is returned for the manifest path.
      expect([...out.blobs.keys()]).to.have.members([HA, HSLOT]);
    });

    it('forwards the superseded spec on update so unchanged content is carried over', async () => {
      appSubmission = load();
      stubs.transportHelper.openContentEnvelope.resolves(Buffer.from(JSON.stringify({ blobs: {} })));
      stubs.contentBlobService.specContentHashes.returns(new Set([HA]));

      const prior = { name: 'myapp', owner: '1id' };
      await appSubmission.uploadSealedContent(spec, envelope, new Map(), { ref: 'HASH123', timestamp: 1, priorSpec: prior });

      const input = stubs.contentBlobService.encryptAndUploadBlobs.firstCall.args[0];
      expect(input.priorSpec).to.equal(prior);
    });
  });
});
