'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const crypto = require('node:crypto');
const proxyquire = require('proxyquire').noCallThru();
const {
  loadSpecLibrary, V9_SUBMISSION, sealedV9Spec, decryptedV9Spec, assertAnswers,
} = require('./fixtures/fluxSpec');

const hashOf = (buf) => `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;
// executeCall shape the benchmark channel returns: { status: 'success', data: { status: 'ok', <field> } }
const ok = (obj) => ({ status: 'success', data: { status: 'ok', ...obj } });
const KEY = crypto.randomBytes(32);
const NOW_MS = 1_700_000_000_000;
const now = () => NOW_MS;
// owner-sig timestamps are MILLISECONDS (like the app-message timestamp) — the
// blob freshness window compares in ms
const freshTs = String(NOW_MS);

const APP = 'app';
const OWNER = V9_SUBMISSION.owner;
const APPS_FOLDER = '/dat/var/lib/fluxos/flux-apps';

// The spec library is REAL here, not stubbed — see tests/unit/fixtures/fluxSpec.js
// for why. What stays stubbed is I/O and FluxOS policy: the registry, the event bus,
// the FluxDrive uploader, the benchmark channel, and the app-secret crypto provider.
let flux;

// ── Real spec fixtures ────────────────────────────────────────────────────
//
// flux-spec's own rules shape these, not test convention: a contentSlot is legal
// only on a `type: 'file'` mount, an atomic slot delivers into the managed
// /io.runonflux/ dir, and a self-watching slot (onUpdate: null) MUST be atomic —
// the library rejects `atomic: false` with no reaction outright.

const SIGHUP = Object.freeze({ action: 'signal', signal: 'SIGHUP' });
const RESTART = Object.freeze({ action: 'restart' });

function slotMount(slot, { atomic = false, onUpdate = SIGHUP } = {}) {
  const destination = atomic ? `/io.runonflux/${slot}` : `/etc/app/${slot}`;
  return [destination, {
    source: slot, destination, type: 'file', contentSlot: slot, atomic, onUpdate,
  }];
}

function blobMount(name, hash) {
  const destination = `/etc/app/${name}`;
  return [destination, {
    source: name, destination, type: 'file', contentRef: { hash },
  }];
}

function component(name, mounts, { hostPort = 31000, containerPort = 80 } = {}) {
  return {
    name,
    description: name,
    image: 'nginx:latest',
    cpu: 0.5,
    memory: 300,
    rootFsGb: 2,
    persistentStorage: { sizeGb: 5, mounts: Object.fromEntries(mounts) },
    ports: { svc: { containerPort, hostPort } },
  };
}

/** A one-component (`web`) v9 components block carrying the given mounts. */
const webWith = (...mounts) => ({ web: component('web', mounts) });

/**
 * The cleartext FluxAppSpecV9 the SUBMISSION path holds: appSubmission validates
 * the submission blob and hands that instance straight to processManifestSubmission
 * before anything is sealed. `isEncrypted` is false, so verifyManifest reads it
 * directly rather than decrypting.
 */
function cleartextSpec(components) {
  // contentSlot only works on the encrypted path — a slot spec exists sealed or
  // not at all, so the envelope is stated rather than left silent.
  return flux.FluxAppSpecV9.fromSubmission(
    { ...V9_SUBMISSION, name: APP, components }, { encrypted: true },
  );
}

/**
 * The sealed EncryptedSpecV9 the REGISTRY hands back — `getGlobalAppInfo().spec`
 * for an encrypted app, which every content-slot app is. Only its public metadata
 * (name/owner/instances/version) is readable; verifyManifest has to decrypt it
 * itself before it can see a single declared slot.
 */
function sealedSpec(components, overrides = {}) {
  return sealedV9Spec({ name: APP, components, ...overrides });
}

/** A real DeploymentSpec — the projection the install/apply paths receive. */
async function deploymentOf(components) {
  const decrypted = await decryptedV9Spec({ name: APP, components });
  return flux.DeploymentSpec.fromSpec(decrypted, APPS_FOLDER, { replica: null });
}

/** The resolved host path flux-spec derived for a slot — never a literal here. */
const mountSource = (dep, slot) => dep.componentEntries()
  .flatMap(([, comp]) => comp.contentSlotMounts())
  .find((m) => m.slot === slot).source;

const identifierOf = (dep, name = 'web') => dep.componentEntries()
  .find(([n]) => n === name)[1].identifier;

// All appContentManifests DB access lives in appsRepository (the registry); the
// content domain only builds the row + opts and delegates. So the manifest seam is a
// fake registry, and the mongo filter/update shaping is asserted in the appsRepository
// suite, not here.
function fakeRepo(overrides = {}) {
  return {
    getGlobalAppInfo: sinon.stub().resolves(null),
    getInstalledApp: sinon.stub().resolves(null),
    getContentManifest: sinon.stub().resolves(null),
    setContentManifestApplied: sinon.stub().resolves(),
    upsertContentManifest: sinon.stub().resolves(true),
    deleteQuarantinedContentManifest: sinon.stub().resolves(),
    listInstalledApps: sinon.stub().resolves([]),
    ...overrides,
  };
}

// The real library, with assertValidContentManifest SPIED over the real
// implementation (never replaced) so a test can still assert the manifest actually
// went through flux-spec's validator.
function specLibNamespace() {
  return { ...flux, assertValidContentManifest: sinon.spy(flux.assertValidContentManifest) };
}

function load(repo = fakeRepo()) {
  const bus = { publish: sinon.stub() };
  const specLib = specLibNamespace();
  const service = proxyquire('../../ZelBack/src/services/appLifecycle/contentSlotService', {
    '../utils/specLibs': { getSpec: sinon.stub().resolves(specLib) },
    '../appDatabase/appsRepository': repo,
    '../utils/fluxEventBus': bus,
  });
  return { service, specLib, repo, bus };
}

function makeBenchmark(overrides = {}) {
  return {
    blobLocator: async () => ok({ locator: 'a'.repeat(64) }),
    contentKey: async () => ok({ key: KEY.toString('base64') }),
    signBlobUpload: async () => ok({ signature: 'arcane-sig-b64' }),
    ...overrides,
  };
}

function makeUploader({ exists = true } = {}) {
  const calls = [];
  const headCalls = [];
  return {
    calls,
    headCalls,
    uploadBlob: async (framed, headers) => { calls.push({ framed, headers }); },
    blobExists: async (locator) => { headCalls.push(locator); return exists; },
  };
}

// A deterministic, reversible stand-in for the app-secret seal/unseal provider.
// Production's default reaches fluxbenchd over the benchmark channel, so this stays
// a fake — unlike the spec classes, it is I/O.
function fakeProvider() {
  // Binds the AAD, as AES-GCM does. A fake that accepted any AAD would make every
  // test below vacuous about the binding: a manifest whose cleartext half had
  // been rewritten would open cleanly here and fail only against a real daemon.
  const sealedUnder = new Map();
  return {
    encrypt: async (buf, aad) => {
      const ciphertext = buf.toString('base64');
      sealedUnder.set(ciphertext, aad === undefined ? null : Buffer.from(aad).toString('base64'));
      return { algorithm: 'fake', ciphertext, nonce: 'n', tag: 't' };
    },
    decrypt: async (env, aad) => {
      const expected = sealedUnder.get(env.ciphertext);
      const given = aad === undefined ? null : Buffer.from(aad).toString('base64');
      if (expected !== undefined && expected !== given) {
        throw new Error('fakeProvider: AAD mismatch — this container was sealed against a different cleartext half');
      }
      return Buffer.from(env.ciphertext, 'base64');
    },
  };
}

const CFG = Buffer.from('slot content');
const CFG_HASH = hashOf(CFG);

function manifest(overrides = {}) {
  return {
    appName: APP,
    version: 2,
    slots: { 'app-config': { hash: CFG_HASH } },
    rollout: { strategy: 'immediate' },
    timestamp: NOW_MS, // unix epoch ms
    ownerSignature: 'owner-sig',
    ...overrides,
  };
}

async function expectReject(promise, regex) {
  try {
    await promise;
  } catch (e) {
    expect(e.message).to.match(regex);
    return;
  }
  throw new Error('expected promise to reject');
}

describe('contentSlotService', () => {
  // A cleartext v9 spec declaring one slot — what the submission path carries.
  let slotSpec;
  // Two slots, for the carried-over-hash case.
  let twoSlotSpec;
  // The same app as the registry stores it: sealed, slots invisible until decrypt.
  let slotSpecSealed;

  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(30000);
    flux = await loadSpecLibrary();
    slotSpec = cleartextSpec(webWith(slotMount('app-config')));
    twoSlotSpec = cleartextSpec(webWith(slotMount('app-config'), slotMount('tls-cert')));
    slotSpecSealed = await sealedSpec(webWith(slotMount('app-config')));
  });

  describe('specSlotNames', () => {
    it('collects every declared contentSlot name', () => {
      const { service } = load();
      const spec = cleartextSpec(webWith(slotMount('a'), slotMount('b')));
      const names = service.specSlotNames(spec);
      expect([...names]).to.have.members(['a', 'b']);
    });
  });

  describe('verifyManifest', () => {
    it('accepts a valid, owner-signed manifest whose slots are all declared', async () => {
      const { service, specLib } = load();
      await service.verifyManifest(manifest(), { owner: OWNER, spec: slotSpec }, { verify: () => true });
      sinon.assert.calledOnce(specLib.assertValidContentManifest);
    });

    // verifyManifest takes its spec from the CALLER, so all three readable shapes
    // can arrive: cleartext, sealed (decrypt it), and already-decrypted. The last
    // used to throw `spec.createProvider is not a function`, because the branch
    // asked `isEncrypted` — which stays TRUE on a decrypted view — instead of
    // `sealed`, which is the readability question.
    it('accepts a spec that is already decrypted', async () => {
      const { service } = load();
      const decrypted = await slotSpecSealed.decrypt(await slotSpecSealed.createProvider());
      expect(decrypted.isEncrypted, 'stays true on the readable view').to.equal(true);
      expect(decrypted.sealed, 'but it can be read right now').to.equal(false);

      await service.verifyManifest(
        manifest(), { owner: OWNER, spec: decrypted }, { verify: () => true },
      );
    });

    it('rejects an invalid owner signature', async () => {
      const { service } = load();
      await expectReject(
        service.verifyManifest(manifest(), { owner: OWNER, spec: slotSpec }, { verify: () => false }),
        /invalid owner signature/,
      );
    });

    it('rejects a manifest whose appName does not match the spec', async () => {
      const { service } = load();
      await expectReject(
        service.verifyManifest(manifest({ appName: 'other' }), { owner: OWNER, spec: slotSpec }, { verify: () => true }),
        /does not match the spec/,
      );
    });

    it('rejects a slot the spec does not declare', async () => {
      const { service } = load();
      const otherSpec = cleartextSpec(webWith(slotMount('something-else')));
      await expectReject(
        service.verifyManifest(manifest(), { owner: OWNER, spec: otherSpec }, { verify: () => true }),
        /not declared in the spec/,
      );
    });

    it('rejects a structurally invalid manifest through flux-spec before any signature check', async () => {
      const { service } = load();
      const verify = sinon.stub().returns(true);
      // A real slot hash is sha256:<64 hex>; the library refuses anything else, and
      // it refuses it before the owner signature is ever consulted.
      await expectReject(
        service.verifyManifest(
          manifest({ slots: { 'app-config': { hash: 'not-a-hash' } } }),
          { owner: OWNER, spec: slotSpec }, { verify },
        ),
        /sha256/,
      );
      sinon.assert.notCalled(verify);
    });

    it('decrypts a sealed (isEncrypted) spec to its DecryptedCanonicalSpec before checking slots', async () => {
      const { service } = load();
      // The registry hands back the sealed EncryptedSpecV9 for an encrypted app — its
      // declared slots are visible only after decrypt -> DecryptedCanonicalSpec.
      expect(service.specSlotNames(slotSpecSealed).size, 'a sealed spec declares nothing readable')
        .to.equal(0);
      await service.verifyManifest(manifest(), { owner: OWNER, spec: slotSpecSealed }, { verify: () => true });
    });
  });

  describe('seal/openManifestSlots', () => {
    it('round-trips an encrypted app\'s slots through the app secret', async () => {
      const { service } = load();
      const provider = fakeProvider();
      const sealed = await service.sealManifestSlots(manifest(), { owner: OWNER, encrypted: true }, { provider });
      expect(sealed.slots).to.have.property('sealed');
      expect(sealed.slots['app-config']).to.equal(undefined);
      const opened = await service.openManifestSlots(sealed, { owner: OWNER, encrypted: true }, { provider });
      expect(opened.slots).to.deep.equal(manifest().slots);
    });

    // The owner's signature covers the whole plaintext manifest, and every path
    // that takes one from OUTSIDE re-verifies it after opening. These bind the
    // seal as well, for the paths that do not: a node reading its own store
    // trusts the confirmed flag it wrote earlier and has no signature check left
    // to fail if the row changed underneath it.
    it('refuses to open when the cleartext half is not the one it was sealed against', async () => {
      const { service } = load();
      const provider = fakeProvider();
      const sealed = await service.sealManifestSlots(manifest(), { owner: OWNER, encrypted: true }, { provider });

      for (const change of [
        { version: sealed.version + 1 },
        { appName: 'someone-elses-app' },
        { timestamp: sealed.timestamp + 1000 },
      ]) {
        const tampered = { ...sealed, ...change };
        let error;
        try {
          await service.openManifestSlots(tampered, { owner: OWNER, encrypted: true }, { provider });
        } catch (e) { error = e; }
        expect(error, `rewriting ${Object.keys(change)[0]} must not open`).to.exist;
        expect(error.message).to.match(/AAD mismatch/);
      }
    });

    it('seals under the manifest apart from the payload, so both ends derive it alike', async () => {
      const { service, specLib } = load();
      const provider = fakeProvider();
      const plaintext = manifest();
      const sealed = await service.sealManifestSlots(plaintext, { owner: OWNER, encrypted: true }, { provider });

      // The two forms differ only in `slots`, which is exactly what the AAD drops.
      expect(specLib.contentManifestSealAad(sealed))
        .to.equal(specLib.contentManifestSealAad(plaintext));
    });

    it('leaves a plaintext app\'s slots untouched', async () => {
      const { service } = load();
      const out = await service.sealManifestSlots(manifest(), { owner: OWNER, encrypted: false }, {});
      expect(out.slots).to.deep.equal(manifest().slots);
    });
  });

  describe('processManifestSubmission', () => {
    function baseInput(overrides = {}) {
      return {
        manifest: manifest(),
        // The register path hands the cleartext instance it just validated.
        spec: slotSpec,
        owner: OWNER,
        encrypted: true,
        blobs: new Map([[CFG_HASH, CFG]]),
        ownerSigs: new Map([[CFG_HASH, { sig: 'osig', timestamp: freshTs }]]),
        ...overrides,
      };
    }
    function baseDeps(overrides = {}) {
      return {
        // Stored view defaults to version 1 with no slots, so the fixture manifest
        // (version 2) is its strict successor. refresh defaults inert — a test that
        // wants the catch-up path injects its own.
        getLatest: async () => priorRow(1, {}),
        refresh: async () => {},
        uploader: makeUploader(),
        benchmark: makeBenchmark(),
        now,
        verify: () => true,
        provider: fakeProvider(),
        ...overrides,
      };
    }

    it('uploads each slot blob (source \'slot\') and returns the sealed manifest', async () => {
      const { service } = load();
      const uploader = makeUploader();
      const out = await service.processManifestSubmission(baseInput(), baseDeps({ uploader }));
      expect(uploader.calls.length).to.equal(1);
      expect(uploader.calls[0].headers.source).to.equal('slot');
      expect(out.slots).to.have.property('sealed');
    });

    it('rejects a version that is not the strict successor of the stored one', async () => {
      const { service } = load();
      await expectReject(
        service.processManifestSubmission(baseInput(), baseDeps({ getLatest: async () => ({ version: 5 }) })),
        /must be 6/,
      );
    });

    it('accepts the first manifest at version 1 when nothing is stored', async () => {
      const { service } = load();
      const uploader = makeUploader();
      const input = baseInput({ manifest: manifest({ version: 1 }) });
      const out = await service.processManifestSubmission(input, baseDeps({ uploader, getLatest: async () => null }));
      expect(uploader.calls.length).to.equal(1);
      expect(out.slots).to.have.property('sealed');
    });

    it('rejects a first manifest above version 1', async () => {
      const { service } = load();
      await expectReject(
        service.processManifestSubmission(baseInput(), baseDeps({ getLatest: async () => null })),
        /must be 1/,
      );
    });

    it('rejects a version jump past the successor', async () => {
      const { service } = load();
      await expectReject(
        service.processManifestSubmission(baseInput({ manifest: manifest({ version: 5 }) }), baseDeps()),
        /must be 2/,
      );
    });

    it('catches up a stale stored view once before enforcing', async () => {
      const { service } = load();
      const uploader = makeUploader();
      let refreshed = false;
      const refresh = sinon.stub().callsFake(async () => { refreshed = true; });
      const deps = baseDeps({
        uploader,
        getLatest: async () => (refreshed ? priorRow(1, {}) : null),
        refresh,
      });
      const out = await service.processManifestSubmission(baseInput(), deps);
      expect(refreshed).to.equal(true);
      expect(uploader.calls.length).to.equal(1);
      expect(out.slots).to.have.property('sealed');

      // refreshLatestManifest stays stubbed here, so nothing exercises what it does
      // with the spec it was handed. The real one forwards it to
      // fetchManifestFromPeers -> verifyManifest, which reads the declared slots off
      // it — so assert the handed object can actually answer that.
      const [refreshedApp, ctx] = refresh.firstCall.args;
      expect(refreshedApp).to.equal(APP);
      assertAnswers(ctx.spec, ['componentEntries']);
    });

    it('rejects a declared slot with no blob part', async () => {
      const { service } = load();
      await expectReject(
        service.processManifestSubmission(baseInput({ blobs: new Map() }), baseDeps()),
        /missing blob part/,
      );
    });

    // A stored prior row whose gossip-form body seals the given slots map with
    // the fakeProvider shape — what getLatest hands back for an encrypted app.
    function priorRow(version, slots) {
      return {
        version,
        data: {
          manifest: {
            appName: APP,
            version,
            slots: { sealed: { algorithm: 'fake', ciphertext: Buffer.from(JSON.stringify(slots)).toString('base64'), nonce: 'n', tag: 't' } },
            rollout: { strategy: 'immediate' },
            timestamp: NOW_MS - 1000,
            ownerSignature: 'prior-sig',
          },
        },
      };
    }

    it('carries over an unchanged slot hash: presence-checked, not re-uploaded, no owner sig needed', async () => {
      const { service } = load();
      const fresh = Buffer.from('rotated content');
      const freshHash = hashOf(fresh);
      const uploader = makeUploader({ exists: true });
      const input = baseInput({
        manifest: manifest({ slots: { 'app-config': { hash: CFG_HASH }, 'tls-cert': { hash: freshHash } } }),
        spec: twoSlotSpec,
        blobs: new Map([[freshHash, fresh]]),
        ownerSigs: new Map([[freshHash, { sig: 'osig-new', timestamp: freshTs }]]),
      });
      const deps = baseDeps({ uploader, getLatest: async () => priorRow(1, { 'app-config': { hash: CFG_HASH } }) });

      const out = await service.processManifestSubmission(input, deps);

      expect(uploader.calls.length).to.equal(1);
      expect(uploader.calls[0].headers.ownerSig).to.equal('osig-new');
      expect(uploader.headCalls.length).to.equal(1);
      expect(out.slots).to.have.property('sealed');
    });

    it('rejects a carried-over slot hash that is no longer in storage', async () => {
      const { service } = load();
      const input = baseInput({ blobs: new Map(), ownerSigs: new Map() });
      const deps = baseDeps({
        uploader: makeUploader({ exists: false }),
        getLatest: async () => priorRow(1, { 'app-config': { hash: CFG_HASH } }),
      });
      await expectReject(service.processManifestSubmission(input, deps), /not in storage/);
    });

    it('rejects a missing blob part the prior manifest does not cover', async () => {
      const { service } = load();
      const input = baseInput({ blobs: new Map(), ownerSigs: new Map() });
      const deps = baseDeps({
        getLatest: async () => priorRow(1, { 'app-config': { hash: hashOf(Buffer.from('older content')) } }),
      });
      await expectReject(service.processManifestSubmission(input, deps), /missing blob part/);
    });

    it('rejects a stray blob the manifest does not reference', async () => {
      const { service } = load();
      const stray = Buffer.from('stray');
      const input = baseInput({
        blobs: new Map([[CFG_HASH, CFG], [hashOf(stray), stray]]),
        ownerSigs: new Map([[CFG_HASH, { sig: 'o', timestamp: freshTs }], [hashOf(stray), { sig: 'o', timestamp: freshTs }]]),
      });
      await expectReject(service.processManifestSubmission(input, baseDeps()), /not referenced by the manifest/);
    });

    it('rejects a slot with no owner signature', async () => {
      const { service } = load();
      await expectReject(
        service.processManifestSubmission(baseInput({ ownerSigs: new Map() }), baseDeps()),
        /missing owner signature/,
      );
    });
  });

  describe('refreshLatestManifest', () => {
    // The catch-up ctx is built from the registry row, so its spec is the SEALED one.
    const ctx = () => ({ owner: OWNER, encrypted: true, spec: slotSpecSealed });
    const sealedSlots = (slots) => ({ sealed: { algorithm: 'fake', ciphertext: Buffer.from(JSON.stringify(slots)).toString('base64'), nonce: 'n', tag: 't' } });

    it('adopts a higher-version peer manifest through the latest-wins store', async () => {
      const { service } = load();
      const store = sinon.spy();
      const gossip = { appName: APP, version: 3 };
      const fetchPeers = sinon.stub().resolves({ gossip, plaintext: {} });
      await service.refreshLatestManifest(APP, ctx(), {
        getLatest: async () => ({ version: 1 }),
        getPeers: async () => ['1.2.3.4'],
        fetchPeers,
        fetchFromDrive: sinon.stub().resolves(null),
        store,
        verify: () => true,
        provider: fakeProvider(),
      });
      sinon.assert.calledOnceWithExactly(store, gossip);
      // fetchManifestFromPeers is stubbed, so nothing here exercises what it would do
      // with the ctx spec: the real one runs verifyManifest against it, which has to
      // decrypt the sealed spec before it can read a slot. Run that for real.
      const handedSpec = fetchPeers.firstCall.args[2].spec;
      await service.verifyManifest(manifest(), { owner: OWNER, spec: handedSpec }, { verify: () => true });
    });

    it('falls back to the FluxDrive backstop, re-verifying before adoption', async () => {
      const { service } = load();
      const store = sinon.spy();
      const driveManifest = {
        appName: APP,
        version: 4,
        slots: sealedSlots({ 'app-config': { hash: CFG_HASH } }),
        rollout: { strategy: 'immediate' },
        timestamp: NOW_MS,
        ownerSignature: 'sig',
      };
      await service.refreshLatestManifest(APP, ctx(), {
        getLatest: async () => ({ version: 1 }),
        getPeers: async () => [],
        fetchPeers: async () => null,
        fetchFromDrive: async () => ({ version: 4, manifest: driveManifest }),
        store,
        verify: () => true,
        provider: fakeProvider(),
      });
      sinon.assert.calledOnceWithExactly(store, driveManifest);
    });

    it('adopts nothing at or below the stored version and swallows source failures', async () => {
      const { service } = load();
      const store = sinon.spy();
      await service.refreshLatestManifest(APP, ctx(), {
        getLatest: async () => ({ version: 3 }),
        getPeers: async () => [],
        fetchPeers: async () => ({ gossip: { appName: APP, version: 3 }, plaintext: {} }),
        fetchFromDrive: async () => { throw new Error('drive down'); },
        store,
        verify: () => true,
        provider: fakeProvider(),
      });
      sinon.assert.notCalled(store);
    });
  });

  describe('storeManifest / getLatestManifest', () => {
    it('a refused store publishes nothing and answers false', async () => {
      const { service, repo, bus } = load();
      repo.upsertContentManifest.resolves(false);
      const stored = await service.storeManifest(manifest());
      expect(stored).to.equal(false);
      const storedEvents = bus.publish.getCalls().filter((c) => c.args[0] === 'content:manifestStored');
      expect(storedEvents).to.have.length(0);
    });

    it('builds a confirmed catch-up row and delegates the latest-wins upsert to the registry', async () => {
      const { service, repo } = load();
      const stored = await service.storeManifest(manifest()); // default confirmed:true, no broadcast
      expect(stored).to.equal(true); // returns whatever the registry returns
      const [row, opts] = repo.upsertContentManifest.firstCall.args;
      expect(row).to.deep.equal({ appName: APP, version: 2, data: { type: 'fluxappcontentmanifest', appName: APP, manifest: manifest() } });
      expect(row).to.not.have.property('envelope'); // no broadcast → no envelope
      // A catch-up body clears any stale envelope it promotes over (the registry shapes the $unset).
      expect(opts).to.include({ confirmed: true, clearEnvelope: true });
      expect(opts.expireAt).to.equal(undefined); // confirmed rows carry no TTL
    });

    it('builds a quarantine row carrying the TTL expiry, confirmed:false', async () => {
      const { service, repo } = load();
      const stored = await service.storeManifest(manifest(), { confirmed: false, now: 1000 });
      expect(stored).to.equal(true);
      const [, opts] = repo.upsertContentManifest.firstCall.args;
      expect(opts.confirmed).to.equal(false);
      expect(opts.expireAt).to.be.instanceOf(Date); // domain TTL policy, computed here
    });

    it('splits a node broadcast into verbatim data + envelope, never a second copy of the body', async () => {
      const { service, repo } = load();
      const data = { type: 'fluxappcontentmanifest', appName: APP, manifest: manifest() };
      const bc = {
        version: 1, timestamp: 7, pubKey: 'pk', signature: 'sig', data,
      };
      await service.storeManifest(manifest(), { broadcast: bc });
      const [row, opts] = repo.upsertContentManifest.firstCall.args;
      expect(row.data).to.deep.equal(data); // signed payload kept verbatim
      expect(row.envelope).to.deep.equal({
        version: 1, timestamp: 7, pubKey: 'pk', signature: 'sig',
      });
      expect(row).to.not.have.property('manifest'); // body lives only at data.manifest
      expect(opts.clearEnvelope).to.equal(false); // a broadcast store keeps its envelope
    });

    it('marks a catch-up body (no broadcast) to clear any stale envelope', async () => {
      const { service, repo } = load();
      await service.storeManifest(manifest());
      const [row, opts] = repo.upsertContentManifest.firstCall.args;
      expect(row.data.manifest).to.deep.equal(manifest());
      expect(row).to.not.have.property('envelope');
      expect(opts.clearEnvelope).to.equal(true);
    });

    it('returns the registry verdict (a stale-version collision maps to false there)', async () => {
      const repo = fakeRepo({ upsertContentManifest: sinon.stub().resolves(false) });
      const { service } = load(repo);
      const stored = await service.storeManifest(manifest());
      expect(stored).to.equal(false);
    });

    it('reads the latest manifest by appName from the registry', async () => {
      const repo = fakeRepo({ getContentManifest: sinon.stub().resolves({ appName: APP, version: 2 }) });
      const { service } = load(repo);
      const out = await service.getLatestManifest(APP);
      expect(out.version).to.equal(2);
      sinon.assert.calledWith(repo.getContentManifest, APP);
    });
  });

  function msg(gossipManifest = manifest()) {
    // A full signed node broadcast (envelope + data), as it arrives off the wire.
    return {
      version: 1,
      timestamp: NOW_MS,
      pubKey: 'node-pubkey',
      signature: 'node-sig',
      data: { type: 'fluxappcontentmanifest', appName: gossipManifest.appName, manifest: gossipManifest },
    };
  }
  // The gossip receive path reads the app's spec straight off the registry row. This
  // fixture is the cleartext-app case (isEncrypted:false → plaintext manifest slots);
  // the sealed-spec counterpart is exercised by promoteQuarantinedManifest,
  // submitContentUpdate and provisionContentSlots below.
  function recvDeps(overrides = {}) {
    return {
      getApp: async () => ({ owner: OWNER, isEncrypted: false, spec: slotSpec }),
      isInstalledHere: async () => true,
      rebroadcast: sinon.spy(),
      schedule: sinon.spy(),
      verify: () => true,
      provider: fakeProvider(),
      ...overrides,
    };
  }

  describe('receiveManifest', () => {
    it('verifies, stores, rebroadcasts, and schedules apply when the app is installed here', async () => {
      const { service } = load();
      const deps = recvDeps();
      await service.receiveManifest(msg(), deps);
      sinon.assert.calledOnce(deps.rebroadcast);
      sinon.assert.calledOnce(deps.schedule);
      expect(deps.schedule.firstCall.args[0].appName).to.equal(APP);
      // scheduleContentApplication is stubbed here; the real one reads the app's
      // fleet target and owner off the spec it is handed.
      const [, handedSpec] = deps.schedule.firstCall.args;
      expect(handedSpec.owner).to.equal(OWNER);
      expect(handedSpec.instances).to.be.a('number');
    });

    it('stores and rebroadcasts but does not schedule when the app is not installed here', async () => {
      const { service } = load();
      const deps = recvDeps({ isInstalledHere: async () => null });
      await service.receiveManifest(msg(), deps);
      sinon.assert.calledOnce(deps.rebroadcast);
      sinon.assert.notCalled(deps.schedule);
    });

    it('drops a manifest no newer than the stored version', async () => {
      const repo = fakeRepo({ getContentManifest: sinon.stub().resolves({ appName: APP, version: 5 }) });
      const { service } = load(repo);
      const deps = recvDeps();
      await service.receiveManifest(msg(manifest({ version: 2 })), deps);
      sinon.assert.notCalled(deps.rebroadcast);
      sinon.assert.notCalled(deps.schedule);
    });

    it('quarantines a manifest whose spec has not yet arrived (manifest-before-spec)', async () => {
      const { service, repo } = load();
      const deps = recvDeps({ getApp: async () => null });
      await service.receiveManifest(msg(), deps);
      sinon.assert.notCalled(deps.rebroadcast); // not yet verified -> not promoted/rebroadcast
      expect(repo.upsertContentManifest.firstCall.args[1].confirmed).to.equal(false); // held quarantined for the spec
    });

    it('drops an invalid (bad owner sig) manifest without storing or rebroadcasting, never throwing', async () => {
      const { service } = load();
      const deps = recvDeps({ verify: () => false });
      await service.receiveManifest(msg(), deps);
      sinon.assert.notCalled(deps.rebroadcast);
      sinon.assert.notCalled(deps.schedule);
    });

    it('propagates an unexpected infrastructure failure (so the boundary can surface it)', async () => {
      const { service } = load();
      const deps = recvDeps({ getApp: async () => { throw new Error('mongo down'); } });
      await expectReject(service.receiveManifest(msg(), deps), /mongo down/);
    });
  });

  describe('storeBatchContentManifests (boot-sync ingest)', () => {
    function bc(gossipManifest = manifest()) {
      return {
        version: 1,
        timestamp: NOW_MS,
        pubKey: 'pk',
        signature: 'sig',
        data: { type: 'fluxappcontentmanifest', appName: gossipManifest.appName, manifest: gossipManifest },
      };
    }
    function batchDeps(overrides = {}) {
      return {
        getApp: async () => ({ owner: OWNER, isEncrypted: false, spec: slotSpec }),
        getLatest: async () => null,
        store: sinon.stub().resolves(true),
        verify: () => true,
        provider: fakeProvider(),
        ...overrides,
      };
    }

    it('stores a verified manifest broadcast as confirmed, preserving its envelope', async () => {
      const { service } = load();
      const store = sinon.stub().resolves(true);
      const broadcast = bc();
      const { stored } = await service.storeBatchContentManifests([broadcast], batchDeps({ store }));
      expect(stored).to.equal(1);
      const [m, opts] = store.firstCall.args;
      expect(m).to.deep.equal(manifest()); // the manifest body from broadcast.data.manifest
      expect(opts).to.deep.equal({ confirmed: true, broadcast });
    });

    it('quarantines a broadcast whose spec is not local yet (confirmed:false)', async () => {
      const { service } = load();
      const store = sinon.stub().resolves(true);
      const { stored } = await service.storeBatchContentManifests([bc()], batchDeps({ store, getApp: async () => null }));
      expect(stored).to.equal(1);
      expect(store.firstCall.args[1].confirmed).to.equal(false);
    });

    it('drops a forged broadcast (owner sig fails) without storing', async () => {
      const { service } = load();
      const store = sinon.stub().resolves(true);
      const { stored } = await service.storeBatchContentManifests([bc()], batchDeps({ store, verify: () => false }));
      expect(stored).to.equal(0);
      sinon.assert.notCalled(store);
    });

    it('skips a stale broadcast (version below the stored floor)', async () => {
      const { service } = load();
      const store = sinon.stub().resolves(true);
      const { stored } = await service.storeBatchContentManifests(
        [bc(manifest({ version: 2 }))],
        batchDeps({ store, getLatest: async () => ({ version: 5, confirmed: true }) }),
      );
      expect(stored).to.equal(0);
      sinon.assert.notCalled(store);
    });

    it('counts only the manifests it stored across a mixed batch', async () => {
      const { service } = load();
      const store = sinon.stub().resolves(true);
      const good = bc(manifest());
      const bad = bc(manifest({ appName: 'other' })); // verifyManifest rejects appName != spec
      const { stored } = await service.storeBatchContentManifests([good, bad], batchDeps({ store }));
      expect(stored).to.equal(1);
    });
  });

  describe('promoteQuarantinedManifest (spec-confirm hook for non-running nodes)', () => {
    // The spec-confirm hook reads the registry row, so the spec is the sealed one and
    // verifyManifest has to decrypt it before it can see the declared slot.
    let info;
    before(() => { info = { owner: OWNER, isEncrypted: true, spec: slotSpecSealed }; });

    it('promotes a quarantined manifest once the spec is available', async () => {
      const { service } = load();
      const provider = fakeProvider();
      const store = sinon.stub().resolves(true);
      const sealed = await service.sealManifestSlots(manifest(), { owner: OWNER, encrypted: true }, { provider });
      const env = { version: 1, timestamp: 7, pubKey: 'pk', signature: 's' };
      const data = { type: 'fluxappcontentmanifest', appName: APP, manifest: sealed };
      const promoted = await service.promoteQuarantinedManifest(APP, {
        getApp: async () => info,
        getLatest: async () => ({ data, envelope: env, version: 2, confirmed: false }),
        store,
        provider,
        verify: () => true,
      });
      expect(promoted).to.equal(true);
      // Promotes in place AND rebuilds the captured node broadcast (stays sync-servable).
      sinon.assert.calledWith(store, sealed, { confirmed: true, broadcast: { ...env, data } });
    });

    it('is a no-op when nothing is quarantined (already confirmed)', async () => {
      const { service } = load();
      const store = sinon.spy();
      const promoted = await service.promoteQuarantinedManifest(APP, {
        getLatest: async () => ({ data: { manifest: {} }, version: 2, confirmed: true }),
        store,
      });
      expect(promoted).to.equal(false);
      sinon.assert.notCalled(store);
    });

    it('is a no-op when the spec is still absent', async () => {
      const { service } = load();
      const store = sinon.spy();
      const promoted = await service.promoteQuarantinedManifest(APP, {
        getApp: async () => null,
        getLatest: async () => ({ data: { manifest: {} }, version: 2, confirmed: false }),
        store,
      });
      expect(promoted).to.equal(false);
      sinon.assert.notCalled(store);
    });

    it('drops a quarantined manifest that fails verification (a squatter\'s)', async () => {
      const { service } = load();
      const provider = fakeProvider();
      const drop = sinon.spy();
      const store = sinon.spy();
      const sealed = await service.sealManifestSlots(manifest(), { owner: OWNER, encrypted: true }, { provider });
      const data = { type: 'fluxappcontentmanifest', appName: APP, manifest: sealed };
      const promoted = await service.promoteQuarantinedManifest(APP, {
        getApp: async () => info,
        getLatest: async () => ({ data, version: 2, confirmed: false }),
        drop,
        store,
        provider,
        verify: () => false,
      });
      expect(promoted).to.equal(false);
      sinon.assert.calledOnce(drop);
      sinon.assert.notCalled(store);
    });
  });

  describe('submitContentUpdate', () => {
    const sealedPayload = () => Buffer.from(JSON.stringify({
      manifest: manifest(),
      blobs: { [CFG_HASH]: CFG.toString('base64') },
    }));
    function subBody(overrides = {}) {
      return {
        appName: APP,
        version: 2,
        timestamp: NOW_MS, // unix epoch ms (must match the sealed manifest's timestamp)
        content: { algorithm: 'x', encapsulatedKey: 'k', nonce: 'n', ciphertext: 'c' },
        ownerSigs: { [CFG_HASH]: { sig: 'osig', timestamp: freshTs } },
        ...overrides,
      };
    }
    function subDeps(overrides = {}) {
      return {
        // The standalone update reads the app off the registry: sealed spec.
        getApp: async () => ({ owner: OWNER, isEncrypted: true, spec: slotSpecSealed }),
        isInstalledHere: async () => null,
        openEnvelope: async () => sealedPayload(),
        broadcast: sinon.spy(),
        schedule: sinon.stub().resolves(),
        uploader: makeUploader(),
        benchmark: makeBenchmark(),
        now,
        verify: () => true,
        provider: fakeProvider(),
        ...overrides,
      };
    }
    // The register already stored this app's initial manifest (version 1), so the
    // fixture update (version 2) is its strict successor.
    const loadSub = () => load(fakeRepo({ getContentManifest: sinon.stub().resolves({ version: 1 }) }));

    it('transport-opens, processes, stores, and gossips the sealed manifest', async () => {
      const { service } = loadSub();
      const deps = subDeps();
      const out = await service.submitContentUpdate(subBody(), deps);
      expect(out.slots).to.have.property('sealed'); // at-rest sealed for gossip
      sinon.assert.calledOnce(deps.broadcast);
      expect(deps.broadcast.firstCall.args[0]).to.include({ type: 'fluxappcontentmanifest', appName: APP });
      expect(deps.uploader.calls[0].headers.source).to.equal('slot');
    });

    it('stores the exact signed broadcast it gossiped (envelope + verbatim data) for boot-sync re-serving', async () => {
      const { service, repo } = loadSub();
      const data = { type: 'fluxappcontentmanifest', appName: APP, manifest: { sealed: true } };
      const signed = {
        version: 1, timestamp: 7, pubKey: 'pk', signature: 's', data,
      };
      const deps = subDeps({ broadcast: sinon.stub().resolves(signed) });
      await service.submitContentUpdate(subBody(), deps);
      const [row] = repo.upsertContentManifest.firstCall.args;
      expect(row.envelope).to.deep.equal({
        version: 1, timestamp: 7, pubKey: 'pk', signature: 's',
      });
      expect(row.data).to.equal(data); // the gossiped payload, verbatim
    });

    it('rejects when the cleartext meta does not match the sealed manifest', async () => {
      const { service } = load();
      await expectReject(service.submitContentUpdate(subBody({ version: 3 }), subDeps()), /meta does not match/);
    });

    it('rejects an unknown app', async () => {
      const { service } = load();
      await expectReject(service.submitContentUpdate(subBody(), subDeps({ getApp: async () => null })), /unknown app/);
    });

    it('rejects an incomplete body', async () => {
      const { service } = load();
      await expectReject(service.submitContentUpdate(subBody({ content: undefined }), subDeps()), /incomplete content-update/);
    });

    it('schedules local application when the submitter also runs the app', async () => {
      const { service } = loadSub();
      const deps = subDeps({ isInstalledHere: async () => ({ name: APP }) });
      await service.submitContentUpdate(subBody(), deps);
      sinon.assert.calledOnce(deps.schedule);
      expect(deps.schedule.firstCall.args[0].appName).to.equal(APP); // plaintext manifest
      // scheduleContentApplication stays stubbed; the real one reads owner + instances
      // off the sealed spec's public metadata.
      const [, handedSpec] = deps.schedule.firstCall.args;
      expect(handedSpec.owner).to.equal(OWNER);
      expect(handedSpec.instances).to.be.a('number');
    });

    // The submitter is the one node that applies its own update without gossip, so it is
    // also the only one where a local rollout failure could surface as the submission's
    // answer. By the time schedule runs, everything the submission promised has been done.
    it('answers success when the local application fails (the submission itself succeeded)', async () => {
      const { service } = loadSub();
      const deps = subDeps({
        isInstalledHere: async () => ({ name: APP }),
        schedule: sinon.stub().rejects(new Error('ENOENT: no such file or directory')),
      });
      const out = await service.submitContentUpdate(subBody(), deps);
      expect(out.slots).to.have.property('sealed');
      sinon.assert.calledOnce(deps.broadcast);
    });

    it('PUTs the manifest to the FluxDrive backstop with the owner PUT-sig from the sealed payload', async () => {
      const { service } = loadSub();
      const backstop = sinon.spy();
      const sealedWithSig = Buffer.from(JSON.stringify({
        manifest: manifest(),
        blobs: { [CFG_HASH]: CFG.toString('base64') },
        manifestPutSig: 'owner-put-sig',
      }));
      const deps = subDeps({ openEnvelope: async () => sealedWithSig, backstop });
      await service.submitContentUpdate(subBody(), deps);
      sinon.assert.calledOnce(backstop);
      const [gossipManifest, ctx] = backstop.firstCall.args;
      expect(ctx).to.include({ appName: APP, version: 2, manifestPutSig: 'owner-put-sig' });
      expect(gossipManifest.slots).to.have.property('sealed'); // the gossip-form (sealed) manifest
    });
  });

  describe('backstopManifest', () => {
    it('mints the arcane sig and PUTs the manifest with the owner PUT-sig', async () => {
      const { service } = load();
      const put = sinon.spy();
      const sign = sinon.stub().resolves('arcane-sig');
      const okPut = await service.backstopManifest(
        { appName: APP, version: 2, slots: { sealed: {} } },
        {
          appName: APP, version: 2, timestamp: 1_700_000_000_000, manifestPutSig: 'owner-sig',
        },
        { put, sign },
      );
      expect(okPut).to.equal(true);
      sinon.assert.calledOnce(put);
      const [appName, body] = put.firstCall.args;
      expect(appName).to.equal(APP);
      expect(body).to.include({ version: 2, ownerSig: 'owner-sig', arcaneSig: 'arcane-sig' });
    });

    it('skips the PUT when the frontend supplied no operational owner sig', async () => {
      const { service } = load();
      const put = sinon.spy();
      const okPut = await service.backstopManifest(
        {}, {
          appName: APP, version: 2, timestamp: 1, manifestPutSig: undefined,
        }, { put },
      );
      expect(okPut).to.equal(false);
      sinon.assert.notCalled(put);
    });

    it('is best-effort: a failed PUT returns false and never throws', async () => {
      const { service } = load();
      const put = sinon.stub().rejects(new Error('fluxdrive down'));
      const sign = sinon.stub().resolves('arcane-sig');
      const okPut = await service.backstopManifest(
        {}, {
          appName: APP, version: 2, timestamp: 1, manifestPutSig: 'sig',
        }, { put, sign },
      );
      expect(okPut).to.equal(false);
    });
  });

  describe('reconcileSlots', () => {
    it('derives the live slot locators, sends the typed reconcile fields to the signer, and POSTs the reconcile', async () => {
      const { service } = load();
      const reconcile = sinon.spy();
      const sign = sinon.stub().resolves('arcane-sig');
      const deriveLocator = sinon.stub().resolves('loc-cfg');
      const pushed = await service.reconcileSlots(
        manifest({ version: 3 }),
        {
          appName: APP, owner: OWNER, version: 3, reconcileSig: 'owner-rsig',
        },
        { reconcile, sign, deriveLocator },
      );
      expect(pushed).to.equal(true);
      sinon.assert.calledWithMatch(deriveLocator, sinon.match.any, { appName: APP, fluxID: OWNER, contentHash: CFG_HASH });
      sinon.assert.calledWithMatch(sign, { appName: APP, source: 'slot', version: 3 });
      sinon.assert.calledOnce(reconcile);
      const [appName, body] = reconcile.firstCall.args;
      expect(appName).to.equal(APP);
      expect(body).to.deep.equal({
        source: 'slot', version: 3, arcaneSig: 'arcane-sig', ownerSig: 'owner-rsig', liveLocators: ['loc-cfg'],
      });
    });

    it('derives one locator per slot for a multi-slot manifest', async () => {
      const { service } = load();
      const reconcile = sinon.spy();
      const sign = sinon.stub().resolves('arcane-sig');
      const deriveLocator = sinon.stub();
      deriveLocator.onFirstCall().resolves('loc-a').onSecondCall().resolves('loc-b');
      const m = manifest({
        version: 3,
        slots: { a: { hash: `sha256:${'1'.repeat(64)}` }, b: { hash: `sha256:${'2'.repeat(64)}` } },
      });
      const pushed = await service.reconcileSlots(
        m, {
          appName: APP, owner: OWNER, version: 3, reconcileSig: 'sig',
        }, { reconcile, sign, deriveLocator },
      );
      expect(pushed).to.equal(true);
      expect(reconcile.firstCall.args[1].liveLocators).to.deep.equal(['loc-a', 'loc-b']);
    });

    it('skips when the frontend supplied no owner reconcile-sig', async () => {
      const { service } = load();
      const reconcile = sinon.spy();
      const pushed = await service.reconcileSlots(
        manifest({ version: 3 }), {
          appName: APP, owner: OWNER, version: 3, reconcileSig: undefined,
        }, { reconcile },
      );
      expect(pushed).to.equal(false);
      sinon.assert.notCalled(reconcile);
    });

    it('skips the first manifest version — nothing to supersede', async () => {
      const { service } = load();
      const reconcile = sinon.spy();
      const pushed = await service.reconcileSlots(
        manifest({ version: 1 }), {
          appName: APP, owner: OWNER, version: 1, reconcileSig: 'sig',
        }, { reconcile },
      );
      expect(pushed).to.equal(false);
      sinon.assert.notCalled(reconcile);
    });

    it('never pushes an empty live set (would tombstone every slot blob)', async () => {
      const { service } = load();
      const reconcile = sinon.spy();
      const deriveLocator = sinon.stub().resolves('x');
      const pushed = await service.reconcileSlots(
        { ...manifest({ version: 3 }), slots: {} },
        {
          appName: APP, owner: OWNER, version: 3, reconcileSig: 'sig',
        },
        { reconcile, deriveLocator },
      );
      expect(pushed).to.equal(false);
      sinon.assert.notCalled(reconcile);
    });

    it('is best-effort: a failed reconcile returns false and never throws', async () => {
      const { service } = load();
      const reconcile = sinon.stub().rejects(new Error('fluxdrive down'));
      const sign = sinon.stub().resolves('arcane-sig');
      const deriveLocator = sinon.stub().resolves('loc-cfg');
      const pushed = await service.reconcileSlots(
        manifest({ version: 3 }), {
          appName: APP, owner: OWNER, version: 3, reconcileSig: 'sig',
        }, { reconcile, sign, deriveLocator },
      );
      expect(pushed).to.equal(false);
    });
  });

  describe('handleIncomingManifest (fire-and-forget boundary)', () => {
    it('swallows an unexpected failure without rejecting and without rebroadcasting', async () => {
      const { service } = load();
      const deps = recvDeps({ getApp: async () => { throw new Error('mongo down'); } });
      await service.handleIncomingManifest(msg(), deps); // must not throw
      sinon.assert.notCalled(deps.rebroadcast);
    });

    it('runs the full receipt path on a healthy manifest', async () => {
      const { service } = load();
      const deps = recvDeps();
      await service.handleIncomingManifest(msg(), deps);
      sinon.assert.calledOnce(deps.rebroadcast);
      sinon.assert.calledOnce(deps.schedule);
    });
  });

  describe('applyManifest', () => {
    const HCFG = `sha256:${'1'.repeat(64)}`;
    const HDATA = `sha256:${'2'.repeat(64)}`;
    const HBLOB = `sha256:${'9'.repeat(64)}`;
    const manifestSlots = { appName: APP, slots: { cfg: { hash: HCFG }, data: { hash: HDATA } } };
    const ctx = { appName: APP, owner: OWNER, peers: [] };

    // Real DeploymentSpecs projected from real v9 specs — the slot's host path,
    // delivery mode, reaction and perms all come from flux-spec, never from a literal.
    let signalPlusAtomic; // cfg: in-place + SIGHUP, data: atomic + self-watching
    let restartPlusAtomic; // cfg: in-place + restart, data: atomic + self-watching
    let signalPlusRestart; // cfg: in-place + SIGHUP, data: atomic + restart
    let cfgRestart; // cfg only, restart
    let cfgSignal; // cfg only, SIGHUP
    let cfgSignalWithBlob; // cfg slot + a signed contentRef blob

    before(async () => {
      signalPlusAtomic = await deploymentOf(webWith(slotMount('cfg'), slotMount('data', { atomic: true, onUpdate: null })));
      restartPlusAtomic = await deploymentOf(webWith(slotMount('cfg', { onUpdate: RESTART }), slotMount('data', { atomic: true, onUpdate: null })));
      signalPlusRestart = await deploymentOf(webWith(slotMount('cfg'), slotMount('data', { atomic: true, onUpdate: RESTART })));
      cfgRestart = await deploymentOf(webWith(slotMount('cfg', { onUpdate: RESTART })));
      cfgSignal = await deploymentOf(webWith(slotMount('cfg')));
      cfgSignalWithBlob = await deploymentOf(webWith(slotMount('cfg'), blobMount('seed', HBLOB)));
    });

    function applyDeps(overrides = {}) {
      return {
        resolve: async ({ contentHash }) => Buffer.from(`bytes:${contentHash}`),
        writeFile: sinon.spy(),
        rename: sinon.spy(),
        applyPerms: sinon.spy(),
        signal: sinon.spy(),
        restart: sinon.spy(),
        ...overrides,
      };
    }

    it('writes atomic:false in place and atomic:true via temp+rename, then signals the component', async () => {
      const { service } = load();
      const deps = applyDeps();
      const dep = signalPlusAtomic;
      await service.applyManifest(dep, manifestSlots, ctx, deps);
      const atomicSource = mountSource(dep, 'data');
      sinon.assert.calledWith(deps.writeFile, mountSource(dep, 'cfg'), Buffer.from(`bytes:${HCFG}`));
      sinon.assert.calledWith(deps.writeFile, `${atomicSource}.flux-content-tmp`, Buffer.from(`bytes:${HDATA}`));
      sinon.assert.calledWith(deps.rename, `${atomicSource}.flux-content-tmp`, atomicSource);
      sinon.assert.calledOnceWithExactly(deps.signal, identifierOf(dep), 'SIGHUP');
      sinon.assert.notCalled(deps.restart);
    });

    it('applies nothing when any slot fails to stage (stage-all-then-apply)', async () => {
      const { service } = load();
      const deps = applyDeps({ resolve: async ({ contentHash }) => { if (contentHash === HDATA) throw new Error('no source'); return Buffer.from('x'); } });
      await expectReject(service.applyManifest(restartPlusAtomic, manifestSlots, ctx, deps), /no source/);
      sinon.assert.notCalled(deps.writeFile);
      sinon.assert.notCalled(deps.restart);
    });

    it('restart subsumes signal within a component', async () => {
      const { service } = load();
      const deps = applyDeps();
      await service.applyManifest(signalPlusRestart, manifestSlots, ctx, deps);
      sinon.assert.calledOnceWithExactly(deps.restart, identifierOf(signalPlusRestart));
      sinon.assert.notCalled(deps.signal);
    });

    it('a failed reaction never throws (content stays on disk)', async () => {
      const { service } = load();
      const deps = applyDeps({ restart: sinon.stub().rejects(new Error('daemon busy')) });
      await service.applyManifest(cfgRestart, { slots: { cfg: { hash: HCFG } } }, ctx, deps);
      sinon.assert.calledWith(deps.writeFile, mountSource(cfgRestart, 'cfg'), Buffer.from(`bytes:${HCFG}`));
    });

    it('applies a version at most once (submitter apply vs its gossip echo)', async () => {
      const { service } = load();
      const deps = applyDeps();
      const m = { appName: APP, version: 2, slots: { cfg: { hash: HCFG } } };
      await service.applyManifest(cfgSignal, m, ctx, deps);
      await service.applyManifest(cfgSignal, m, ctx, deps);
      sinon.assert.calledOnce(deps.signal);
    });

    it('skips a superseded version after a newer one has applied (late rollout timer)', async () => {
      const { service } = load();
      const deps = applyDeps();
      await service.applyManifest(cfgSignal, { appName: APP, version: 3, slots: { cfg: { hash: HCFG } } }, ctx, deps);
      await service.applyManifest(cfgSignal, { appName: APP, version: 2, slots: { cfg: { hash: HCFG } } }, ctx, deps);
      sinon.assert.calledOnce(deps.signal);
    });

    it('a failed apply leaves the version retryable', async () => {
      const { service } = load();
      const resolve = sinon.stub();
      resolve.onFirstCall().rejects(new Error('peer gone'));
      resolve.resolves(Buffer.from('bytes'));
      const deps = applyDeps({ resolve });
      const m = { appName: APP, version: 2, slots: { cfg: { hash: HCFG } } };
      await expectReject(service.applyManifest(cfgSignal, m, ctx, deps), /peer gone/);
      await service.applyManifest(cfgSignal, m, ctx, deps);
      sinon.assert.calledOnce(deps.signal);
    });

    it('reaps artifact-store entries down to the spec blobs + this manifest\'s slot hashes', async () => {
      const { service } = load();
      const store = { retainOnly: sinon.stub().resolves() };
      const deps = applyDeps({ store });
      await service.applyManifest(cfgSignalWithBlob, { appName: APP, version: 5, slots: { cfg: { hash: HCFG } } }, ctx, deps);
      sinon.assert.calledOnce(store.retainOnly);
      const [app, keep] = store.retainOnly.firstCall.args;
      expect(app).to.equal(APP);
      expect([...keep].sort()).to.deep.equal([HCFG, HBLOB].sort());
    });

    it('defaults injected perms to root-owned 0644 when the mount declares none', async () => {
      const chown = sinon.stub().resolves();
      const chmod = sinon.stub().resolves();
      const service = proxyquire('../../ZelBack/src/services/appLifecycle/contentSlotService', {
        '../utils/specLibs': { getSpec: sinon.stub().resolves(specLibNamespace()) },
        '../appDatabase/appsRepository': fakeRepo(),
        'node:fs/promises': {
          chown, chmod, writeFile: sinon.stub().resolves(), rename: sinon.stub().resolves(),
        },
      });
      const deps = { resolve: async () => Buffer.from('bytes'), signal: sinon.spy(), restart: sinon.spy() };
      await service.applyManifest(cfgSignal, { appName: APP, slots: { cfg: { hash: HCFG } } }, ctx, deps);
      // flux-spec resolved the mount's perms (declared uid/gid/mode, else root 0644).
      const source = mountSource(cfgSignal, 'cfg');
      sinon.assert.calledWith(chown, source, 0, 0);
      sinon.assert.calledWith(chmod, source, 0o644);
    });
  });

  describe('scheduleContentApplication', () => {
    // An installed, content-bearing deployment whose container is up — this path only ever
    // applies to a RUNNING app, so the fixture has to be able to say it isn't one.
    let dep;
    // The stored spec the scheduler reads owner + instances off: the sealed registry
    // form, whose public metadata stays readable while its components do not.
    let spec;
    let tenInstanceSpec;
    const up = async () => ({ State: { Running: true } });

    before(async function buildFixtures() {
      this.timeout(30000);
      dep = await deploymentOf(webWith(slotMount('app-config')));
      spec = slotSpecSealed;
      tenInstanceSpec = await sealedSpec(webWith(slotMount('app-config')), { instances: 10 });
    });

    it('applies via the installed deployment and the app\'s running peers', async () => {
      const { service } = load();
      const apply = sinon.spy();
      await service.scheduleContentApplication(
        { appName: APP, slots: {} }, spec,
        {
          getDeployment: async () => dep, getPeers: async () => ['1.2.3.4:16127'], apply, inspect: up,
        },
      );
      sinon.assert.calledOnce(apply);
      expect(apply.firstCall.args[0]).to.equal(dep);
      expect(apply.firstCall.args[2]).to.deep.equal({ appName: APP, owner: OWNER, peers: ['1.2.3.4:16127'] });
      // applyManifest stays stubbed here; the real one walks the deployment's
      // components for their slot and blob mounts.
      assertAnswers(apply.firstCall.args[0], ['componentEntries']);
    });

    it('does nothing when the app is not installed here', async () => {
      const { service } = load();
      const apply = sinon.spy();
      await service.scheduleContentApplication(
        { appName: APP, slots: {} }, spec,
        { getDeployment: async () => null, apply, inspect: up },
      );
      sinon.assert.notCalled(apply);
    });

    // An install has an installed record long before it has a mounted volume: the container
    // doesn't exist while the component's filesystem is still being made, and writing a slot
    // then lands on an unmounted path. The installer stages the content itself once the
    // volume is there, so skipping costs nothing.
    it('does not apply while the app is installed but not yet up (mid-install)', async () => {
      const { service } = load();
      const apply = sinon.spy();
      await service.scheduleContentApplication(
        { appName: APP, slots: {} }, spec,
        {
          getDeployment: async () => dep,
          getPeers: async () => [],
          apply,
          inspect: async () => { throw new Error('No such container: web_app'); },
        },
      );
      sinon.assert.notCalled(apply);
    });

    it('does not apply when the container exists but is stopped (the start path stages it)', async () => {
      const { service } = load();
      const apply = sinon.spy();
      await service.scheduleContentApplication(
        { appName: APP, slots: {} }, spec,
        {
          getDeployment: async () => dep,
          getPeers: async () => [],
          apply,
          inspect: async () => ({ State: { Running: false } }),
        },
      );
      sinon.assert.notCalled(apply);
    });

    // A controllable timer harness: records timers, then fires them FIFO advancing a
    // virtual clock by each delay (flushing the detached apply between).
    function fakeScheduler(startMs = 0) {
      const state = { t: startMs, timers: [] };
      return {
        now: () => state.t,
        setTimer: (cb, ms) => { state.timers.push({ cb, ms }); },
        timers: state.timers,
        async run() {
          while (state.timers.length) {
            const { cb, ms } = state.timers.shift();
            state.t += ms;
            // eslint-disable-next-line no-await-in-loop
            await cb();
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => { setImmediate(resolve); });
          }
        },
      };
    }
    const schedDeps = (sched, over = {}) => ({
      getDeployment: async () => dep,
      getPeers: async () => [],
      inspect: up,
      now: sched.now,
      setTimer: sched.setTimer,
      ...over,
    });

    it('immediate rollout applies now, no timer', async () => {
      const { service } = load();
      const apply = sinon.spy();
      const sched = fakeScheduler(1000);
      await service.scheduleContentApplication(manifest({ rollout: { strategy: 'immediate' } }), spec, schedDeps(sched, { apply }));
      sinon.assert.calledOnce(apply);
      expect(sched.timers.length).to.equal(0);
    });

    it('scheduled rollout defers to activateAt, then applies', async () => {
      const { service } = load();
      const apply = sinon.spy();
      const sched = fakeScheduler(1000); // now = 1000ms
      const m = manifest({ rollout: { strategy: 'scheduled', activateAt: 2000 } }); // activateAt = 2000ms
      await service.scheduleContentApplication(m, spec, schedDeps(sched, { apply }));
      expect(sched.timers.length).to.equal(1);
      expect(sched.timers[0].ms).to.equal(1000); // activateAt - now
      sinon.assert.notCalled(apply);
      await sched.run();
      sinon.assert.calledOnce(apply);
    });

    it('scheduled rollout already past activateAt applies immediately (catch-up)', async () => {
      const { service } = load();
      const apply = sinon.spy();
      const sched = fakeScheduler(5000); // well past activateAt
      const m = manifest({ rollout: { strategy: 'scheduled', activateAt: 2000 } });
      await service.scheduleContentApplication(m, spec, schedDeps(sched, { apply }));
      sinon.assert.calledOnce(apply);
      expect(sched.timers.length).to.equal(0);
    });

    it('staggered rollout computes the ordinal slot at activateAt and applies after it', async () => {
      const { service } = load();
      const apply = sinon.spy();
      const computeDelay = sinon.stub().resolves(5000); // this node's slot is 5s into the window
      const sched = fakeScheduler(1000);
      const m = manifest({ rollout: { strategy: 'staggered', activateAt: 2000, staggerSeconds: 30 } });
      await service.scheduleContentApplication(m, tenInstanceSpec, schedDeps(sched, { apply, computeDelay }));
      expect(sched.timers.length).to.equal(1); // first a timer to activateAt
      sinon.assert.notCalled(computeDelay); // slot is computed only when activateAt arrives (snapshot-at-activateAt)
      await sched.run();
      sinon.assert.calledOnce(computeDelay);
      // the fleet target comes off the spec's own public metadata, not a literal
      expect(computeDelay.firstCall.args.slice(0, 3)).to.deep.equal([APP, 10, 30]);
      sinon.assert.calledOnce(apply);
    });

    it('staggered rollout past the whole window applies immediately (late joiner)', async () => {
      const { service } = load();
      const apply = sinon.spy();
      const computeDelay = sinon.stub().resolves(5000);
      const sched = fakeScheduler(40000); // past activateAt + staggerSeconds
      const m = manifest({ rollout: { strategy: 'staggered', activateAt: 2000, staggerSeconds: 30 } });
      await service.scheduleContentApplication(m, tenInstanceSpec, schedDeps(sched, { apply, computeDelay }));
      sinon.assert.calledOnce(apply);
      sinon.assert.notCalled(computeDelay);
      expect(sched.timers.length).to.equal(0);
    });

    // The running check is inside runApply, so it also covers a deferred rollout arriving
    // at a moment the app happens to be down; the catch-up sweep re-applies it once it is up.
    it('a deferred rollout whose moment arrives while the app is down does not apply', async () => {
      const { service } = load();
      const apply = sinon.spy();
      const sched = fakeScheduler(1000);
      const m = manifest({ rollout: { strategy: 'scheduled', activateAt: 2000 } });
      await service.scheduleContentApplication(m, spec, schedDeps(sched, {
        apply, inspect: async () => ({ State: { Running: false } }),
      }));
      expect(sched.timers.length).to.equal(1);
      await sched.run();
      sinon.assert.notCalled(apply);
    });
  });

  describe('computeStaggerDelayMs', () => {
    function staggerDeps(selfCollateral, locToCollateral) {
      return {
        getSelfAddress: async () => 'self:16127',
        resolveCollateral: async (addr) => (addr === 'self:16127' ? selfCollateral : (locToCollateral[addr] || null)),
        getLocations: async () => Object.keys(locToCollateral).map((ip) => ({ ip })),
      };
    }

    it('orders instances by collateral txid and returns this node\'s evenly-spaced slot', async () => {
      const { service } = load();
      // sorted collaterals: aaaa,bbbb,cccc(self),dddd → i=2 of N=4 → (2/4)*40s
      const deps = staggerDeps('cccc', { 'p1:16127': 'aaaa', 'p2:16127': 'bbbb', 'p3:16127': 'dddd' });
      expect(await service.computeStaggerDelayMs(APP, 4, 40, deps)).to.equal(20000);
    });

    it('returns 0 when this node\'s own collateral cannot be resolved (degenerate)', async () => {
      const { service } = load();
      const deps = staggerDeps(null, { 'p1:16127': 'aaaa' });
      expect(await service.computeStaggerDelayMs(APP, 4, 40, deps)).to.equal(0);
    });

    it('clamps N up to the observed count so a slot never exceeds the window', async () => {
      const { service } = load();
      // instances=2 but 4 observed (transient over-count): N=max(2,4)=4, self 'dddd' i=3 → (3/4)*40s
      const deps = staggerDeps('dddd', { 'p1:16127': 'aaaa', 'p2:16127': 'bbbb', 'p3:16127': 'cccc' });
      expect(await service.computeStaggerDelayMs(APP, 2, 40, deps)).to.equal(30000);
    });
  });

  describe('applyManifest records the delivered version', () => {
    const HCFG = `sha256:${'1'.repeat(64)}`;
    const m = { appName: APP, version: 4, slots: { cfg: { hash: HCFG } } };
    let dep;

    before(async () => { dep = await deploymentOf(webWith(slotMount('cfg'))); });

    it('write-throughs appliedVersion after a successful apply', async () => {
      const { service } = load();
      const recordApplied = sinon.spy();
      await service.applyManifest(dep, m, { appName: APP, owner: OWNER, peers: [] }, {
        resolve: async () => Buffer.from('x'), writeFile: sinon.spy(), applyPerms: sinon.spy(), signal: sinon.spy(), recordApplied,
      });
      sinon.assert.calledOnceWithExactly(recordApplied, APP, 4);
    });

    it('does not record when the apply is skipped (already-applied guard)', async () => {
      const { service } = load();
      const recordApplied = sinon.spy();
      const deps = {
        resolve: async () => Buffer.from('x'), writeFile: sinon.spy(), applyPerms: sinon.spy(), signal: sinon.spy(), recordApplied,
      };
      await service.applyManifest(dep, m, { appName: APP, owner: OWNER, peers: [] }, deps);
      await service.applyManifest(dep, m, { appName: APP, owner: OWNER, peers: [] }, deps); // echo — skipped
      sinon.assert.calledOnce(recordApplied); // only the real apply recorded
    });
  });

  describe('contentComponentsRunning', () => {
    // Two real components: one carries a content slot, one does not.
    let twoComp;
    before(async () => {
      twoComp = await deploymentOf({
        web: component('web', [slotMount('app-config')]),
        db: component('db', [], { hostPort: 31001, containerPort: 5432 }),
      });
    });

    it('is true when every content component is running (ignores non-content ones)', async () => {
      const { service } = load();
      const inspect = sinon.stub().resolves({ State: { Running: true } });
      expect(await service.contentComponentsRunning(twoComp, { inspect })).to.be.true;
      sinon.assert.calledOnceWithExactly(inspect, identifierOf(twoComp, 'web')); // db (no content) not inspected
    });

    it('is false when a content component is stopped', async () => {
      const { service } = load();
      expect(await service.contentComponentsRunning(twoComp, { inspect: async () => ({ State: { Running: false } }) })).to.be.false;
    });

    it('is false when a content component container is absent (inspect throws)', async () => {
      const { service } = load();
      expect(await service.contentComponentsRunning(twoComp, { inspect: async () => { throw new Error('no such container'); } })).to.be.false;
    });
  });

  describe('applyStoredIfBehind (catch a running container up to its stored manifest)', () => {
    let slotDeployment;
    before(async () => { slotDeployment = await deploymentOf(webWith(slotMount('app-config'))); });

    function baseDeps(overrides = {}) {
      return {
        getStored: async () => ({
          version: 2, appliedVersion: 1, confirmed: true, data: { manifest: manifest({ version: 2 }) },
        }),
        getDeployment: async () => slotDeployment,
        getApp: async () => ({ owner: OWNER, isEncrypted: false, spec: slotSpec }),
        componentsRunning: async () => true,
        schedule: sinon.spy(),
        ...overrides,
      };
    }

    it('applies when the register is ahead of the delivered version and the container is running', async () => {
      const { service } = load();
      const deps = baseDeps();
      const applied = await service.applyStoredIfBehind(APP, deps);
      expect(applied).to.be.true;
      sinon.assert.calledOnce(deps.schedule);
      // scheduleContentApplication stays stubbed; the real one reads the fleet target
      // and owner off the spec it is handed.
      const [, handedSpec] = deps.schedule.firstCall.args;
      expect(handedSpec.owner).to.equal(OWNER);
      expect(handedSpec.instances).to.be.a('number');
    });

    it('is a no-op when already delivered (appliedVersion >= version)', async () => {
      const { service } = load();
      const deps = baseDeps({ getStored: async () => ({ version: 2, appliedVersion: 2, confirmed: true, data: { manifest: manifest({ version: 2 }) } }) });
      expect(await service.applyStoredIfBehind(APP, deps)).to.be.false;
      sinon.assert.notCalled(deps.schedule);
    });

    it('is a no-op when the container is not running (leaves it for the start path)', async () => {
      const { service } = load();
      const deps = baseDeps({ componentsRunning: async () => false });
      expect(await service.applyStoredIfBehind(APP, deps)).to.be.false;
      sinon.assert.notCalled(deps.schedule);
    });

    it('is a no-op when the app is not installed here', async () => {
      const { service } = load();
      const deps = baseDeps({ getDeployment: async () => null });
      expect(await service.applyStoredIfBehind(APP, deps)).to.be.false;
      sinon.assert.notCalled(deps.schedule);
    });

    it('is a no-op when nothing is stored (or the row is unconfirmed)', async () => {
      const { service } = load();
      const missing = baseDeps({ getStored: async () => null });
      expect(await service.applyStoredIfBehind(APP, missing)).to.be.false;
      sinon.assert.notCalled(missing.schedule);

      const quarantined = baseDeps({ getStored: async () => ({ version: 2, appliedVersion: 1, confirmed: false, data: { manifest: manifest({ version: 2 }) } }) });
      expect(await service.applyStoredIfBehind(APP, quarantined)).to.be.false;
      sinon.assert.notCalled(quarantined.schedule);
    });

    it('treats a never-applied row (no appliedVersion) as behind', async () => {
      const { service } = load();
      const deps = baseDeps({ getStored: async () => ({ version: 1, confirmed: true, data: { manifest: manifest({ version: 1 }) } }) });
      expect(await service.applyStoredIfBehind(APP, deps)).to.be.true;
      sinon.assert.calledOnce(deps.schedule);
    });
  });

  describe('applyBehindContentApps (steady-state sweep)', () => {
    it('catches up every installed app that is behind, counting successes', async () => {
      const { service } = load();
      const applyBehind = sinon.stub();
      applyBehind.withArgs('a1').resolves(true);
      applyBehind.withArgs('a2').resolves(false); // current — no-op
      applyBehind.withArgs('a3').resolves(true);
      const count = await service.applyBehindContentApps({
        listInstalled: async () => [{ name: 'a1' }, { name: 'a2' }, { name: 'a3' }],
        applyBehind,
      });
      expect(count).to.equal(2);
    });

    it('a single app catch-up throwing does not abort the sweep', async () => {
      const { service } = load();
      const applyBehind = sinon.stub();
      applyBehind.withArgs('a1').rejects(new Error('docker busy'));
      applyBehind.withArgs('a2').resolves(true);
      const count = await service.applyBehindContentApps({
        listInstalled: async () => [{ name: 'a1' }, { name: 'a2' }],
        applyBehind,
      });
      expect(count).to.equal(1);
    });
  });

  describe('reconcileBootContent (boot before-start recovery)', () => {
    let slotDeployment;
    let noSlotDeployment;
    let webIdentifier;

    before(async () => {
      slotDeployment = await deploymentOf(webWith(slotMount('app-config')));
      noSlotDeployment = await deploymentOf(webWith());
      webIdentifier = identifierOf(slotDeployment);
    });

    const appInfo = () => ({ owner: OWNER, isEncrypted: false, spec: slotSpec });

    it('mounts each slot component\'s volume before provisioning (the immutable mountpoint EPERMs an unmounted write)', async () => {
      const { service } = load();
      const provision = sinon.spy();
      const ensureMounted = sinon.stub().resolves({ mounted: true });
      await service.reconcileBootContent(APP, {
        getDeployment: async () => slotDeployment,
        getLatest: async () => ({ confirmed: true, data: { manifest: manifest({ rollout: { strategy: 'immediate' } }) } }),
        getPeers: async () => ['p1'],
        provision,
        ensureMounted,
        schedule: sinon.spy(),
        now: () => 0,
      });
      sinon.assert.calledOnceWithExactly(ensureMounted, webIdentifier);
      sinon.assert.calledOnce(provision);
      sinon.assert.callOrder(ensureMounted, provision);
    });

    it('refuses to provision over a volume that cannot mount, loudly', async () => {
      const { service } = load();
      const provision = sinon.spy();
      const ensureMounted = sinon.stub().resolves({ mounted: false, reason: 'volume_file_missing' });
      let thrown = null;
      await service.reconcileBootContent(APP, {
        getDeployment: async () => slotDeployment,
        getLatest: async () => ({ confirmed: true, data: { manifest: manifest({ rollout: { strategy: 'immediate' } }) } }),
        getPeers: async () => ['p1'],
        provision,
        ensureMounted,
        schedule: sinon.spy(),
        now: () => 0,
      }).catch((err) => { thrown = err; });
      expect(thrown, 'the caller\'s best-effort catch must hear this').to.be.an('error');
      expect(thrown.message).to.include('volume_file_missing');
      sinon.assert.notCalled(provision);
    });

    it('is a no-op for an app with no content slots', async () => {
      const { service } = load();
      const provision = sinon.spy();
      const schedule = sinon.spy();
      await service.reconcileBootContent(APP, { getDeployment: async () => noSlotDeployment, provision, schedule });
      sinon.assert.notCalled(provision);
      sinon.assert.notCalled(schedule);
    });

    it('provisions the current content before start when the latest rollout is due', async () => {
      const { service } = load();
      const provision = sinon.spy();
      const schedule = sinon.spy();
      await service.reconcileBootContent(APP, {
        getDeployment: async () => slotDeployment,
        getLatest: async () => ({ confirmed: true, data: { manifest: manifest({ rollout: { strategy: 'immediate' } }) } }),
        getPeers: async () => ['p1'],
        provision,
        ensureMounted: async () => ({ mounted: true }),
        schedule,
        now: () => 0,
      });
      sinon.assert.calledOnce(provision);
      expect(provision.firstCall.args[0]).to.equal(slotDeployment);
      expect(provision.firstCall.args[1]).to.deep.equal({ appName: APP, peers: ['p1'] });
      sinon.assert.notCalled(schedule);
      // provisionContentSlots stays stubbed; the real one walks the deployment's
      // components to decide whether the app declares slots at all.
      assertAnswers(provision.firstCall.args[0], ['componentEntries']);
    });

    it('does NOT apply a future-dated rollout early — re-arms it instead (on-disk content stays)', async () => {
      const { service } = load();
      const provision = sinon.spy();
      const schedule = sinon.spy();
      const future = manifest({ rollout: { strategy: 'scheduled', activateAt: 1_000_000 } }); // far future (ms), well ahead of now=0
      await service.reconcileBootContent(APP, {
        getDeployment: async () => slotDeployment,
        getLatest: async () => ({ confirmed: true, data: { manifest: future } }),
        getApp: async () => appInfo(),
        provision,
        schedule,
        now: () => 0,
        provider: fakeProvider(),
      });
      sinon.assert.notCalled(provision); // not applied early
      sinon.assert.calledOnce(schedule); // re-armed to land at activateAt
      expect(schedule.firstCall.args[0].rollout.strategy).to.equal('scheduled');
    });

    it('provisions a past-due rollout (activateAt passed during downtime) before start', async () => {
      const { service } = load();
      const provision = sinon.spy();
      const schedule = sinon.spy();
      const past = manifest({ rollout: { strategy: 'scheduled', activateAt: 1000 } }); // 1000ms, past (now=5000)
      await service.reconcileBootContent(APP, {
        getDeployment: async () => slotDeployment,
        getLatest: async () => ({ confirmed: true, data: { manifest: past } }),
        getPeers: async () => [],
        provision,
        ensureMounted: async () => ({ mounted: true }),
        schedule,
        now: () => 5000, // past activateAt
      });
      sinon.assert.calledOnce(provision);
      sinon.assert.notCalled(schedule);
    });

    it('does NOT apply a still-quarantined future rollout early, nor re-arm it (unverified)', async () => {
      const { service } = load();
      const provision = sinon.spy();
      const schedule = sinon.spy();
      const future = manifest({ rollout: { strategy: 'scheduled', activateAt: 1_000_000 } }); // far future (ms)
      await service.reconcileBootContent(APP, {
        getDeployment: async () => slotDeployment,
        getLatest: async () => ({ confirmed: false, data: { manifest: future } }), // quarantined
        provision,
        schedule,
        now: () => 0,
      });
      sinon.assert.notCalled(provision); // read from cleartext rollout regardless of confirmed -> never applied early
      sinon.assert.notCalled(schedule); // unverified -> left for the normal confirm/gossip path
    });

    it('re-arms a surviving container\'s future rollout without re-provisioning its running mount', async () => {
      const { service } = load();
      const provision = sinon.spy();
      const schedule = sinon.spy();
      const future = manifest({ rollout: { strategy: 'scheduled', activateAt: 1_000_000 } });
      await service.reconcileBootContent(APP, {
        getDeployment: async () => slotDeployment,
        getLatest: async () => ({ confirmed: true, data: { manifest: future } }),
        getApp: async () => appInfo(),
        provision,
        schedule,
        now: () => 0,
        provider: fakeProvider(),
        restarting: false, // FluxOS process restart, container survived
      });
      sinon.assert.calledOnce(schedule); // re-armed (its in-memory timer died with the process)
      sinon.assert.notCalled(provision); // running mount not re-written
    });

    it('catches up a surviving container that is BEHIND its stored manifest, in place (never re-provisions)', async () => {
      const { service } = load();
      const provision = sinon.spy();
      const schedule = sinon.spy();
      await service.reconcileBootContent(APP, {
        getDeployment: async () => slotDeployment,
        getLatest: async () => ({ confirmed: true, data: { manifest: manifest({ version: 3, rollout: { strategy: 'immediate' } }) } }),
        // applyStoredIfBehind seam (reconcileBootContent forwards deps): register ahead of delivered
        getStored: async () => ({ version: 3, appliedVersion: 2, confirmed: true, data: { manifest: manifest({ version: 3 }) } }),
        getApp: async () => appInfo(),
        componentsRunning: async () => true,
        provision,
        schedule,
        now: () => 0,
        restarting: false,
        provider: fakeProvider(),
      });
      sinon.assert.notCalled(provision); // running mount is never re-provisioned
      sinon.assert.calledOnce(schedule); // caught up in place (a during-downtime update won't re-gossip)
    });

    it('leaves a surviving container that is already current untouched', async () => {
      const { service } = load();
      const provision = sinon.spy();
      const schedule = sinon.spy();
      await service.reconcileBootContent(APP, {
        getDeployment: async () => slotDeployment,
        getLatest: async () => ({ confirmed: true, data: { manifest: manifest({ version: 3, rollout: { strategy: 'immediate' } }) } }),
        getStored: async () => ({ version: 3, appliedVersion: 3, confirmed: true, data: { manifest: manifest({ version: 3 }) } }),
        getApp: async () => appInfo(),
        componentsRunning: async () => true,
        provision,
        schedule,
        now: () => 0,
        restarting: false,
      });
      sinon.assert.notCalled(provision);
      sinon.assert.notCalled(schedule); // appliedVersion == version -> nothing to catch up
    });
  });

  describe('fetchManifestFromPeers', () => {
    const ctx = () => ({ owner: OWNER, encrypted: false, spec: slotSpec });

    it('adopts the highest valid version and rejects an invalid candidate', async () => {
      const { service } = load();
      const byPeer = { p1: manifest({ version: 2 }), p2: manifest({ version: 3 }), p3: manifest({ version: 5 }) };
      const fetch = async (peer) => byPeer[peer];
      // flux-spec's canonical form excludes ownerSignature and key-sorts the rest;
      // reject the version-5 candidate (e.g. forged)
      const verify = (signed) => !signed.includes('"version":5');
      const best = await service.fetchManifestFromPeers(APP, ['p1', 'p2', 'p3'], ctx(), { fetch, verify });
      expect(best.gossip.version).to.equal(3);
    });

    it('returns null when no peer yields a valid manifest', async () => {
      const { service } = load();
      const best = await service.fetchManifestFromPeers(APP, ['p1'], ctx(), { fetch: async () => null });
      expect(best).to.equal(null);
    });

    it('only queries up to maxPeers', async () => {
      const { service } = load();
      const seen = [];
      const fetch = async (peer) => { seen.push(peer); return null; };
      await service.fetchManifestFromPeers(APP, ['p1', 'p2', 'p3', 'p4'], ctx(), { fetch, maxPeers: 2 });
      expect(seen).to.deep.equal(['p1', 'p2']);
    });
  });

  describe('provisionContentSlots', () => {
    let slotDeployment;
    let noSlotDeployment;
    let info;

    before(async () => {
      slotDeployment = await deploymentOf(webWith(slotMount('app-config')));
      noSlotDeployment = await deploymentOf(webWith());
      // Install-time provisioning reads the app off the registry: the sealed spec.
      info = { owner: OWNER, isEncrypted: true, spec: slotSpecSealed };
    });

    it('stages from this node\'s stored manifest when present (no catch-up)', async () => {
      const { service } = load();
      const provider = fakeProvider();
      const stageApply = sinon.spy();
      const fetchPeers = sinon.spy();
      const sealed = await service.sealManifestSlots(manifest(), { owner: OWNER, encrypted: true }, { provider });

      await service.provisionContentSlots(slotDeployment, { appName: APP, peers: ['p1'] }, {
        getApp: async () => info,
        getLatest: async () => ({ data: { manifest: sealed }, version: 2 }),
        fetchPeers,
        stageApply,
        provider,
      });

      sinon.assert.notCalled(fetchPeers);
      sinon.assert.calledOnce(stageApply);
      expect(stageApply.firstCall.args[1].slots).to.deep.equal(manifest().slots);
      expect(stageApply.firstCall.args[2]).to.deep.equal({ appName: APP, owner: OWNER, peers: ['p1'] });
      // stageAndApplySlots stays stubbed; the real one walks the deployment's
      // components for their contentSlotMounts.
      assertAnswers(stageApply.firstCall.args[0], ['componentEntries']);
    });

    it('records the provisioned version so a later behind-check does not re-apply it with a reaction', async () => {
      const { service } = load();
      const provider = fakeProvider();
      const stageApply = sinon.spy();
      const recordApplied = sinon.spy();
      const sealed = await service.sealManifestSlots(manifest(), { owner: OWNER, encrypted: true }, { provider });

      await service.provisionContentSlots(slotDeployment, { appName: APP, peers: ['p1'] }, {
        getApp: async () => info,
        getLatest: async () => ({ data: { manifest: sealed }, version: 2 }),
        stageApply,
        recordApplied,
        provider,
      });

      sinon.assert.calledOnce(stageApply);
      // Without this record, applyStoredIfBehind sees the node "behind" and re-applies the
      // just-provisioned content to the now-running container THROUGH applyManifest, firing
      // the onUpdate reaction — a spurious install-time restart/signal.
      sinon.assert.calledOnceWithExactly(recordApplied, APP, 2);
    });

    it('verifies and promotes a locally-quarantined manifest at install (no catch-up round-trip)', async () => {
      const { service } = load();
      const provider = fakeProvider();
      const stageApply = sinon.spy();
      const fetchPeers = sinon.spy();
      const store = sinon.spy();
      const sealed = await service.sealManifestSlots(manifest(), { owner: OWNER, encrypted: true }, { provider });

      const env = { version: 1, timestamp: 7, pubKey: 'pk', signature: 's' };
      const data = { type: 'fluxappcontentmanifest', appName: APP, manifest: sealed };
      await service.provisionContentSlots(slotDeployment, { appName: APP, peers: ['p1'] }, {
        getApp: async () => info,
        getLatest: async () => ({
          data, envelope: env, version: 2, confirmed: false,
        }), // quarantined
        fetchPeers,
        store,
        stageApply,
        provider,
        verify: () => true,
      });

      sinon.assert.notCalled(fetchPeers); // promoted locally — no catch-up
      sinon.assert.calledWith(store, sealed, { confirmed: true, broadcast: { ...env, data } }); // promoted in place, envelope preserved
      sinon.assert.calledOnce(stageApply);
    });

    it('falls through to catch-up when a quarantined manifest fails verification (a squatter\'s)', async () => {
      const { service } = load();
      const provider = fakeProvider();
      const stageApply = sinon.spy();
      const fetched = { gossip: manifest(), plaintext: manifest() };
      const fetchPeers = sinon.stub().resolves(fetched);
      const sealed = await service.sealManifestSlots(manifest(), { owner: OWNER, encrypted: true }, { provider });

      await service.provisionContentSlots(slotDeployment, { appName: APP, peers: ['p1'] }, {
        getApp: async () => info,
        getLatest: async () => ({ data: { manifest: sealed }, version: 2, confirmed: false }),
        fetchPeers,
        store: sinon.spy(),
        stageApply,
        provider,
        verify: () => false, // quarantined manifest does not verify -> catch up instead
      });

      sinon.assert.calledOnce(stageApply);
      expect(stageApply.firstCall.args[1]).to.equal(fetched.plaintext); // used the caught-up manifest
      // fetchManifestFromPeers stays stubbed; the real one runs verifyManifest against
      // the ctx spec, which has to decrypt the sealed registry form first. Run it.
      const handedSpec = fetchPeers.firstCall.args[2].spec;
      await service.verifyManifest(manifest(), { owner: OWNER, spec: handedSpec }, { verify: () => true });
    });

    it('catches up from a running peer when nothing is stored, then stores + stages', async () => {
      const { service } = load();
      const store = sinon.spy();
      const stageApply = sinon.spy();
      const fetched = { gossip: manifest(), plaintext: manifest() };

      await service.provisionContentSlots(slotDeployment, { appName: APP, peers: ['p1'] }, {
        getApp: async () => info,
        getLatest: async () => null,
        fetchPeers: async () => fetched,
        store,
        stageApply,
      });

      sinon.assert.calledWith(store, fetched.gossip);
      sinon.assert.calledOnce(stageApply);
      expect(stageApply.firstCall.args[1]).to.equal(fetched.plaintext);
    });

    it('falls back to the FluxDrive backstop when no running peer yields one (cold start)', async () => {
      const { service } = load();
      const provider = fakeProvider();
      const store = sinon.spy();
      const stageApply = sinon.spy();
      const sealed = await service.sealManifestSlots(manifest(), { owner: OWNER, encrypted: true }, { provider });
      const fetchFromDrive = sinon.stub().resolves({ version: 2, manifest: sealed });

      await service.provisionContentSlots(slotDeployment, { appName: APP, peers: [] }, {
        getApp: async () => info,
        getLatest: async () => null,
        fetchPeers: async () => null, // no running peer
        fetchFromDrive,
        store,
        stageApply,
        provider,
        verify: () => true,
      });

      sinon.assert.calledOnce(fetchFromDrive);
      // Stored as a catch-up body (no broadcast envelope from the FluxDrive backstop).
      sinon.assert.calledWith(store, sealed);
      sinon.assert.calledOnce(stageApply);
      expect(stageApply.firstCall.args[1].slots).to.deep.equal(manifest().slots); // verified + opened
    });

    it('rejects a forged FluxDrive backstop manifest (re-verified, untrusted) and holds the install', async () => {
      const { service } = load();
      const provider = fakeProvider();
      const stageApply = sinon.spy();
      const sealed = await service.sealManifestSlots(manifest(), { owner: OWNER, encrypted: true }, { provider });
      const fetchFromDrive = sinon.stub().resolves({ version: 2, manifest: sealed });

      await expectReject(
        service.provisionContentSlots(slotDeployment, { appName: APP, peers: [] }, {
          getApp: async () => info,
          getLatest: async () => null,
          fetchPeers: async () => null,
          fetchFromDrive,
          store: sinon.spy(),
          stageApply,
          provider,
          verify: () => false, // FluxDrive copy fails owner-sig verification -> dropped
        }),
        /no manifest available/,
      );
      sinon.assert.notCalled(stageApply);
    });

    it('holds the install (throws) when no manifest is stored, no peer, and FluxDrive 404s', async () => {
      const { service } = load();
      await expectReject(
        service.provisionContentSlots(slotDeployment, { appName: APP, peers: [] }, {
          getApp: async () => info,
          getLatest: async () => null,
          fetchPeers: async () => null,
          fetchFromDrive: async () => null, // FluxDrive has nothing either
          stageApply: sinon.spy(),
        }),
        /no manifest available/,
      );
    });

    it('holds the install when the FluxDrive backstop errors (unreachable/unconfigured -> treated as no manifest)', async () => {
      const { service } = load();
      const stageApply = sinon.spy();
      await expectReject(
        service.provisionContentSlots(slotDeployment, { appName: APP, peers: [] }, {
          getApp: async () => info,
          getLatest: async () => null,
          fetchPeers: async () => null,
          fetchFromDrive: async () => { throw new Error('fluxdrive 502'); }, // swallowed -> fall through to hold
          stageApply,
        }),
        /no manifest available/,
      );
      sinon.assert.notCalled(stageApply);
    });

    it('is a no-op for an app that declares no slots', async () => {
      const { service } = load();
      const stageApply = sinon.spy();
      const getApp = sinon.spy();
      await service.provisionContentSlots(noSlotDeployment, { appName: APP }, { getApp, stageApply });
      sinon.assert.notCalled(stageApply);
      sinon.assert.notCalled(getApp);
    });
  });
});
