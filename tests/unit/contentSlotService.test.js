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
// The app's identity, as the registry lists it: a manifest is signed for it.
const IDENTITY = `b${'a'.repeat(52)}`;
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

function component(name, mounts, { hostPort = 31_000, containerPort = 80 } = {}) {
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
  return flux.DeploymentSpec.fromSpec(decrypted, APPS_FOLDER, { replica: null, identity: IDENTITY });
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
    getGlobalAppInfoByIdentity: sinon.stub().resolves(null),
    getInstalledApp: sinon.stub().resolves(null),
    getContentManifests: sinon.stub().resolves([]),
    getContentManifest: sinon.stub().resolves(null),
    putContentManifest: sinon.stub().resolves({ inserted: true }),
    resolveContentManifest: sinon.stub().resolves(),
    deleteContentManifest: sinon.stub().resolves(),
    markContentManifestApplied: sinon.stub().resolves(),
    listInstalledApps: sinon.stub().resolves([]),
    carriedManifestRanks: sinon.stub().resolves([]),
    ...overrides,
  };
}

// The standing derivation is a leaf the service reads; its own suite proves it.
// Here it is a seam: by default nothing stands, and a test that needs a standing
// manifest hands one in through deps or through load().
const manifestStanding = require('../../ZelBack/src/services/appLifecycle/manifestStanding');

// The real library, with assertValidContentManifest SPIED over the real
// implementation (never replaced) so a test can still assert the manifest actually
// went through flux-spec's validator.
function specLibNamespace() {
  return { ...flux, assertValidContentManifest: sinon.spy(flux.assertValidContentManifest) };
}

function load(repo = fakeRepo(), {
  standing = async () => ({ app: null, row: null, aside: false, rows: [] }),
  ownerships = async () => [],
  latestAppliedState = async () => null,
} = {}) {
  const bus = { publish: sinon.stub() };
  const specLib = specLibNamespace();
  const service = proxyquire('../../ZelBack/src/services/appLifecycle/contentSlotService', {
    '../utils/specLibs': { getSpec: sinon.stub().resolves(specLib) },
    '../appDatabase/appsRepository': repo,
    '../appDecisions/appHistory': { ownerships },
    '../appDatabase/appSpecHistory': { latestAppliedState },
    '../chainState': { getScannedHeight: async () => 0 },
    '../appMessaging/temporaryPoolSweep': { MAX_REORG_LENGTH: 40 },
    './manifestStanding': { ...manifestStanding, standingManifest: standing },
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
    identity: IDENTITY,
    version: 2,
    ownedFrom: 2_400_000,
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
    this.timeout(30_000);
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
      await service.verifyManifest(manifest(), { owner: OWNER, spec: slotSpec, identity: IDENTITY }, { verify: () => true });
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
        manifest(), { owner: OWNER, spec: decrypted, identity: IDENTITY }, { verify: () => true },
      );
    });

    it('rejects an invalid owner signature', async () => {
      const { service } = load();
      await expectReject(
        service.verifyManifest(manifest(), { owner: OWNER, spec: slotSpec, identity: IDENTITY }, { verify: () => false }),
        /invalid owner signature/,
      );
    });

    it('rejects a manifest whose appName does not match the spec', async () => {
      const { service } = load();
      await expectReject(
        service.verifyManifest(manifest({ appName: 'other' }), { owner: OWNER, spec: slotSpec, identity: IDENTITY }, { verify: () => true }),
        /does not match the spec/,
      );
    });

    it('rejects a manifest signed for another registration of the name', async () => {
      const { service } = load();
      await expectReject(
        service.verifyManifest(manifest({ identity: `b${'c'.repeat(52)}` }), { owner: OWNER, spec: slotSpec, identity: IDENTITY }, { verify: () => true }),
        /another registration of this app name/,
      );
    });

    it('takes a manifest listing a slot the spec does not declare: the slot is ignored, not refused', async () => {
      const { service } = load();
      const otherSpec = cleartextSpec(webWith(slotMount('something-else')));
      await service.verifyManifest(manifest(), { owner: OWNER, spec: otherSpec, identity: IDENTITY }, { verify: () => true });
    });

    it('takes a manifest the spec names though the listed owner did not sign it, and refuses one it does not name', async () => {
      const { service } = load();
      const named = flux.FluxAppSpecV9.fromSubmission({
        ...V9_SUBMISSION, name: APP, components: webWith(slotMount('app-config')), content: { manifest: flux.contentManifestHash(manifest()) },
      }, { encrypted: true });
      await service.verifyManifest(manifest(), { owner: OWNER, spec: named, identity: IDENTITY }, { verify: () => false });
      await expectReject(
        service.verifyManifest(manifest({ version: 3 }), { owner: OWNER, spec: named, identity: IDENTITY }, { verify: () => false }),
        /neither signed by the listed owner nor the one the spec names/,
      );
      // the named one is refused all the same for another registration of the name
      await expectReject(
        service.verifyManifest(manifest({ identity: `b${'c'.repeat(51)}a` }), { owner: OWNER, spec: named, identity: IDENTITY }, { verify: () => false }),
        /another registration/,
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
          { owner: OWNER, spec: slotSpec, identity: IDENTITY }, { verify },
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
      await service.verifyManifest(manifest(), { owner: OWNER, spec: slotSpecSealed, identity: IDENTITY }, { verify: () => true });
    });
  });

  describe('seal/openManifestSlots', () => {
    it('round-trips an encrypted app\'s slots through the content key', async () => {
      const { service } = load();
      const provider = fakeProvider();
      const sealed = await service.sealManifestSlots(manifest(), { encrypted: true }, { provider });
      expect(sealed.slots).to.have.property('sealed');
      expect(sealed.slots['app-config']).to.equal(undefined);
      const opened = await service.openManifestSlots(sealed, { encrypted: true }, { provider });
      expect(opened.slots).to.deep.equal(manifest().slots);
    });

    it('seals and opens under the provider keyed by the manifest\'s identity, never by name and owner', async () => {
      const provider = fakeProvider();
      const forIdentity = sinon.stub().resolves(provider);
      const create = sinon.stub().rejects(new Error('the name-and-owner key is the spec\'s, not the content\'s'));
      const service = proxyquire('../../ZelBack/src/services/appLifecycle/contentSlotService', {
        '../utils/specLibs': { getSpec: sinon.stub().resolves(specLibNamespace()) },
        '../appDatabase/appsRepository': fakeRepo(),
        '../utils/fluxEventBus': { publish: sinon.stub() },
        '../providers/FluxOSCryptoProvider': { forIdentity, create },
      });

      const sealed = await service.sealManifestSlots(manifest(), { owner: OWNER, encrypted: true });
      const opened = await service.openManifestSlots(sealed, { owner: OWNER, encrypted: true });

      expect(opened.slots).to.deep.equal(manifest().slots);
      sinon.assert.alwaysCalledWithExactly(forIdentity, IDENTITY);
      sinon.assert.calledTwice(forIdentity);
      sinon.assert.notCalled(create);
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
    // The ownership the fixture manifest is signed under: OWNER took the app at the
    // height the manifest's ownedFrom carries.
    const OWNED_FROM = 2_400_000;
    function baseInput(overrides = {}) {
      return {
        manifest: manifest(),
        // The register path hands the cleartext instance it just validated.
        spec: slotSpec,
        owner: OWNER,
        encrypted: true,
        identity: IDENTITY,
        ownedFrom: OWNED_FROM,
        blobs: new Map([[CFG_HASH, CFG]]),
        ownerSigs: new Map([[CFG_HASH, { sig: 'osig', timestamp: freshTs }]]),
        ...overrides,
      };
    }
    function baseDeps(overrides = {}) {
      return {
        // One row stands, version 1 under this ownership and no slots, so the
        // fixture manifest (version 2) is its successor. refresh defaults inert — a
        // test that wants the catch-up path injects its own. Nothing waits in the pool.
        getRows: async () => [storedRow(1, {})],
        pendingRanks: async () => [],
        standing: async () => ({ row: storedRow(1, {}) }),
        refresh: async () => {},
        uploader: makeUploader(),
        benchmark: makeBenchmark(),
        now,
        verify: () => true,
        provider: fakeProvider(),
        ...overrides,
      };
    }

    it('reads the rows held for the app the submission is for, by its identity', async () => {
      const { service } = load();
      const getRows = sinon.stub().resolves([]);
      await service.processManifestSubmission(baseInput({ manifest: manifest({ version: 1 }) }), baseDeps({ getRows, standing: async () => ({ row: null }) }));
      sinon.assert.calledWith(getRows, IDENTITY);
    });

    it('uploads each slot blob (source \'slot\') and returns the sealed manifest', async () => {
      const { service } = load();
      const uploader = makeUploader();
      const out = await service.processManifestSubmission(baseInput(), baseDeps({ uploader }));
      expect(uploader.calls.length).to.equal(1);
      expect(uploader.calls[0].headers.source).to.equal('slot');
      expect(out.slots).to.have.property('sealed');
    });

    it('requires the next version within the ownership: one above the highest this owner signed under it', async () => {
      const { service } = load();
      await expectReject(
        service.processManifestSubmission(baseInput(), baseDeps({ getRows: async () => [storedRow(5, {})] })),
        /must be 6 within this ownership/,
      );
    });

    it('accepts the first manifest at version 1 when nothing is held, and refuses a higher first one', async () => {
      const { service } = load();
      const uploader = makeUploader();
      const none = { getRows: async () => [], standing: async () => ({ row: null }) };
      const out = await service.processManifestSubmission(baseInput({ manifest: manifest({ version: 1 }) }), baseDeps({ uploader, ...none }));
      expect(uploader.calls.length).to.equal(1);
      expect(out.slots).to.have.property('sealed');
      await expectReject(
        service.processManifestSubmission(baseInput(), baseDeps(none)),
        /must be 1 within this ownership/,
      );
    });

    it('rejects a version jump past the successor', async () => {
      const { service } = load();
      await expectReject(
        service.processManifestSubmission(baseInput({ manifest: manifest({ version: 5 }) }), baseDeps()),
        /must be 2 within this ownership/,
      );
    });

    it('counts versions per ownership: what an earlier owner signed, or this owner signed under an earlier ownership, is not in the sequence', async () => {
      const { service } = load();
      const uploader = makeUploader();
      // The seller's 7 and this owner's 3 from a first ownership rank below, and
      // the incoming owner's first manifest under the new ownership is 1.
      const getRows = async () => [
        storedRow(7, {}, { signer: '1seller', ownedFrom: 100 }),
        storedRow(3, {}, { ownedFrom: 100 }),
      ];
      const out = await service.processManifestSubmission(
        baseInput({ manifest: manifest({ version: 1 }) }),
        baseDeps({ uploader, getRows, standing: async () => ({ row: storedRow(7, {}, { signer: '1seller', ownedFrom: 100 }) }) }),
      );
      expect(out.version).to.equal(1);
      await expectReject(
        service.processManifestSubmission(baseInput({ manifest: manifest({ version: 8 }) }), baseDeps({ getRows })),
        /must be 1 within this ownership/,
      );
    });

    it('requires the manifest to carry the ownership height the submission names', async () => {
      const { service } = load();
      await expectReject(
        service.processManifestSubmission(baseInput({ manifest: manifest({ ownedFrom: 100 }) }), baseDeps()),
        /ownedFrom must be 2400000/,
      );
      await expectReject(
        service.processManifestSubmission(baseInput({ ownedFrom: undefined }), baseDeps()),
        /names no ownership height/,
      );
    });

    it('counts the manifests waiting in the pool with the app\'s unpaid updates under this ownership: the next number follows the highest of them and the stored ones', async () => {
      const { service } = load();
      const pendingRanks = sinon.stub().resolves([
        { version: 2, ownedFrom: OWNED_FROM }, { version: 3, ownedFrom: OWNED_FROM }, { version: 9, ownedFrom: 100 },
      ]);
      await expectReject(
        service.processManifestSubmission(baseInput({ manifest: manifest({ version: 2 }) }), baseDeps({ pendingRanks })),
        /must be 4 within this ownership/,
      );
      sinon.assert.calledWith(pendingRanks, IDENTITY);

      const uploader = makeUploader();
      const out = await service.processManifestSubmission(baseInput({ manifest: manifest({ version: 4 }) }), baseDeps({ pendingRanks, uploader }));
      expect(out.version).to.equal(4);
      expect(uploader.calls.length).to.equal(1);
    });

    it('catches up a stale view once before enforcing, reading the rows and the pool again', async () => {
      const { service } = load();
      const uploader = makeUploader();
      let refreshed = false;
      const refresh = sinon.stub().callsFake(async () => { refreshed = true; });
      const getRows = sinon.stub().callsFake(async () => (refreshed ? [storedRow(1, {}), storedRow(2, {})] : [storedRow(1, {})]));
      const pendingRanks = sinon.stub().callsFake(async () => (refreshed ? [{ version: 3, ownedFrom: OWNED_FROM }] : []));
      const out = await service.processManifestSubmission(
        baseInput({ manifest: manifest({ version: 4 }) }),
        baseDeps({ uploader, refresh, getRows, pendingRanks }),
      );
      expect(out.version).to.equal(4);
      sinon.assert.calledOnceWithExactly(refresh, APP, IDENTITY, sinon.match.object);
      sinon.assert.calledTwice(pendingRanks);
      expect(uploader.calls.length).to.equal(1);
    });

    it('rejects a declared slot with no blob part', async () => {
      const { service } = load();
      await expectReject(
        service.processManifestSubmission(baseInput({ blobs: new Map() }), baseDeps()),
        /missing blob part/,
      );
    });

    it('carries over an unchanged slot hash from the standing manifest: presence-checked, not re-uploaded, no owner sig needed', async () => {
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
      const standingRow = storedRow(1, { 'app-config': { hash: CFG_HASH } });
      const deps = baseDeps({ uploader, getRows: async () => [standingRow], standing: async () => ({ row: standingRow }) });

      const out = await service.processManifestSubmission(input, deps);

      expect(uploader.calls.length).to.equal(1);
      expect(uploader.calls[0].headers.ownerSig).to.equal('osig-new');
      expect(uploader.headCalls.length).to.equal(1);
      expect(out.slots).to.have.property('sealed');
    });

    it('rejects a carried-over slot hash that is no longer in storage', async () => {
      const { service } = load();
      const input = baseInput({ blobs: new Map(), ownerSigs: new Map() });
      const standingRow = storedRow(1, { 'app-config': { hash: CFG_HASH } });
      const deps = baseDeps({
        uploader: makeUploader({ exists: false }),
        getRows: async () => [standingRow],
        standing: async () => ({ row: standingRow }),
      });
      await expectReject(service.processManifestSubmission(input, deps), /not in storage/);
    });

    it('rejects a missing blob part the standing manifest does not cover', async () => {
      const { service } = load();
      const input = baseInput({ blobs: new Map(), ownerSigs: new Map() });
      const standingRow = storedRow(1, { 'app-config': { hash: hashOf(Buffer.from('older content')) } });
      const deps = baseDeps({ getRows: async () => [standingRow], standing: async () => ({ row: standingRow }) });
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

  describe('refreshManifests', () => {
    it('takes every manifest each running peer holds, and the one FluxDrive serves, counting those newly stored', async () => {
      const { service } = load();
      const take = sinon.stub()
        .onFirstCall().resolves({ outcome: 'stored' })
        .onSecondCall().resolves({ outcome: 'duplicate' })
        .onThirdCall().resolves({ outcome: 'stored' });
      const peers = { p1: [manifest({ version: 2 }), manifest({ version: 3 })], p2: [] };
      const fetchFromDrive = sinon.stub().resolves({ version: 4, manifest: manifest({ version: 4 }) });
      const stored = await service.refreshManifests(APP, IDENTITY, {
        getPeers: async () => ['p1', 'p2'],
        fetchPeer: async (peer) => peers[peer],
        fetchFromDrive,
        take,
      });
      expect(stored).to.equal(2);
      sinon.assert.calledThrice(take);
      expect(take.thirdCall.args[0].version).to.equal(4);
    });

    it('judges nothing that names another identity, asks at most maxPeers, and swallows a failing source', async () => {
      const { service } = load();
      const take = sinon.stub().resolves({ outcome: 'stored' });
      const seen = [];
      const stored = await service.refreshManifests(APP, IDENTITY, {
        getPeers: async () => ['p1', 'p2', 'p3'],
        fetchPeer: async (peer) => { seen.push(peer); return [manifest({ identity: `b${'c'.repeat(52)}` })]; },
        fetchFromDrive: async () => { throw new Error('drive down'); },
        take,
        maxPeers: 2,
      });
      expect(seen).to.deep.equal(['p1', 'p2']);
      sinon.assert.notCalled(take);
      expect(stored).to.equal(0);
    });
  });

  // A stored row as the registry hands it: the manifest sealed in its gossip form.
  function sealedGossip(overrides = {}, slots = manifest().slots) {
    return {
      ...manifest(overrides),
      slots: { sealed: { algorithm: 'fake', ciphertext: Buffer.from(JSON.stringify(slots)).toString('base64'), nonce: 'n', tag: 't' } },
    };
  }
  function storedRow(version, slots, { signer = OWNER, ownedFrom = 2_400_000, applied = false, hash = `h${version}` } = {}) {
    return {
      identity: IDENTITY, hash, version, ownedFrom, signer, applied,
      data: { type: 'fluxappcontentmanifest', appName: APP, manifest: sealedGossip({ version, ownedFrom }, slots) },
    };
  }

  describe('takeManifest', () => {
    const owners = [{ owner: '1seller', from: 100 }, { owner: OWNER, from: 2_400_000 }];
    function takeDeps(overrides = {}) {
      return {
        getApp: async () => ({
          name: APP, owner: OWNER, isEncrypted: true, spec: slotSpecSealed, identity: IDENTITY,
        }),
        getRow: async () => null,
        put: sinon.stub().resolves({ inserted: true }),
        ownerships: async () => owners,
        verify: async (signed, owner) => owner === OWNER,
        provider: fakeProvider(),
        ...overrides,
      };
    }

    it('keeps a manifest the listed owner signed, resolved, keyed by its hash and ranked by the ownership height and version', async () => {
      const { service, specLib, bus } = load();
      const deps = takeDeps();
      const taken = await service.takeManifest(sealedGossip(), {}, deps);
      expect(taken.outcome).to.equal('stored');
      expect(taken.signer).to.equal(OWNER);
      expect(taken.hash).to.equal(specLib.contentManifestHash(manifest()));
      const [row] = deps.put.firstCall.args;
      expect(row).to.include({
        identity: IDENTITY, hash: taken.hash, version: 2, ownedFrom: 2_400_000, signer: OWNER,
      });
      expect(row.data.manifest).to.deep.equal(sealedGossip());
      expect(row.expireAt).to.equal(undefined);
      sinon.assert.calledWith(bus.publish, 'content:manifestStored', sinon.match({ identity: IDENTITY, version: 2, resolved: true }));
    });

    it('resolves the signer among every owner of the app\'s applied history, with the height that owner took the app', async () => {
      const { service } = load();
      const deps = takeDeps({ verify: async (signed, owner) => owner === '1seller' });
      const taken = await service.takeManifest(sealedGossip({ ownedFrom: 100 }), {}, deps);
      expect(taken.outcome).to.equal('stored');
      expect(taken.signer).to.equal('1seller');
      expect(deps.put.firstCall.args[0]).to.include({ signer: '1seller', ownedFrom: 100 });
    });

    it('drops a manifest no owner of the app signed, keeping nothing', async () => {
      const { service, bus } = load();
      const deps = takeDeps({ verify: async () => false });
      const taken = await service.takeManifest(sealedGossip(), {}, deps);
      expect(taken).to.include({ outcome: 'dropped', reason: 'forged_signature' });
      sinon.assert.notCalled(deps.put);
      sinon.assert.calledWith(bus.publish, 'content:manifestDropped', { appName: APP, reason: 'forged_signature' });
    });

    it('drops a manifest whose ownership height is not one at which its signer took the app', async () => {
      const { service } = load();
      const deps = takeDeps();
      const taken = await service.takeManifest(sealedGossip({ ownedFrom: 2_400_001 }), {}, deps);
      expect(taken).to.include({ outcome: 'dropped', reason: 'wrong_ownership_height' });
      sinon.assert.notCalled(deps.put);
    });

    it('reads ownership height 0 as the registration\'s, from the first owner alone', async () => {
      const { service } = load();
      const first = takeDeps({ verify: async (signed, owner) => owner === '1seller' });
      expect((await service.takeManifest(sealedGossip({ ownedFrom: 0 }), {}, first)).outcome).to.equal('stored');
      const later = takeDeps();
      expect(await service.takeManifest(sealedGossip({ ownedFrom: 0 }), {}, later)).to.include({ outcome: 'dropped', reason: 'wrong_ownership_height' });
    });

    it('holds a manifest for an app not yet listed, unresolved with an expiry, and keeps the broadcast it arrived in', async () => {
      const { service, bus } = load();
      const deps = takeDeps({ getApp: async () => null });
      const broadcast = msg(sealedGossip());
      const taken = await service.takeManifest(sealedGossip(), { broadcast, now: 1000 }, deps);
      expect(taken.outcome).to.equal('held');
      const [row, opts] = deps.put.firstCall.args;
      expect(row.signer).to.equal(null);
      expect(row.expireAt).to.be.instanceOf(Date);
      expect(row.data).to.equal(broadcast.data);
      expect(row.envelope).to.deep.equal({
        version: 1, timestamp: NOW_MS, pubKey: 'node-pubkey', signature: 'node-sig',
      });
      expect(opts.now).to.equal(1000);
      sinon.assert.calledWith(bus.publish, 'content:manifestStored', sinon.match({ identity: IDENTITY, resolved: false }));
    });

    it('a second arrival of a resolved manifest is a duplicate that refreshes the row, and one of a held manifest stays held', async () => {
      const { service } = load();
      const resolved = takeDeps({ getRow: async () => ({ signer: OWNER }) });
      expect((await service.takeManifest(sealedGossip(), {}, resolved)).outcome).to.equal('duplicate');
      sinon.assert.calledOnce(resolved.put);
      const held = takeDeps({ getApp: async () => null, put: sinon.stub().resolves({ inserted: false }) });
      expect((await service.takeManifest(sealedGossip(), {}, held)).outcome).to.equal('duplicate');
    });

    it('drops an unreadable manifest and one that names a name the identity\'s app does not carry', async () => {
      const { service } = load();
      const garbage = { ...sealedGossip(), slots: { sealed: { algorithm: 'fake', ciphertext: '%%%', nonce: 'n', tag: 't' } } };
      expect(await service.takeManifest(garbage, {}, takeDeps())).to.include({ outcome: 'dropped', reason: 'invalid' });
      const otherName = takeDeps({ getApp: async () => ({ name: 'other', owner: OWNER, identity: IDENTITY, isEncrypted: true, spec: slotSpecSealed }) });
      expect(await service.takeManifest(sealedGossip(), {}, otherName)).to.include({ outcome: 'dropped', reason: 'another_name' });
    });

    it('drops a malformed manifest before opening anything', async () => {
      const { service } = load();
      const deps = takeDeps();
      for (const bad of [null, {}, { appName: APP }, { ...sealedGossip(), ownedFrom: undefined }]) {
        // eslint-disable-next-line no-await-in-loop
        expect(await service.takeManifest(bad, {}, deps)).to.include({ outcome: 'dropped', reason: 'malformed' });
      }
      sinon.assert.notCalled(deps.put);
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
      take: sinon.stub().resolves({
        outcome: 'stored', plaintext: manifest(), app: { spec: slotSpec, owner: OWNER }, hash: 'h2',
      }),
      isInstalledHere: async () => true,
      rebroadcast: sinon.spy(),
      schedule: sinon.spy(),
      ...overrides,
    };
  }

  describe('receiveManifest', () => {
    it('takes the manifest with the broadcast it arrived in, rebroadcasts it, and schedules apply when the app is installed here', async () => {
      const { service, bus } = load();
      const deps = recvDeps();
      const broadcast = msg();
      await service.receiveManifest(broadcast, deps);
      sinon.assert.calledOnce(deps.take);
      expect(deps.take.firstCall.args[0]).to.deep.equal(manifest());
      expect(deps.take.firstCall.args[1].broadcast).to.equal(broadcast);
      sinon.assert.calledOnce(deps.rebroadcast);
      sinon.assert.calledOnce(deps.schedule);
      expect(deps.schedule.firstCall.args[0].appName).to.equal(APP);
      // scheduleContentApplication is stubbed here; the real one reads the app's
      // fleet target and owner off the spec it is handed.
      const [, handedSpec] = deps.schedule.firstCall.args;
      expect(handedSpec.owner).to.equal(OWNER);
      expect(handedSpec.instances).to.be.a('number');
      sinon.assert.calledWith(bus.publish, 'content:manifestReceived', { appName: APP, version: 2 });
    });

    it('rebroadcasts but does not schedule when the app is not installed here', async () => {
      const { service } = load();
      const deps = recvDeps({ isInstalledHere: async () => null });
      await service.receiveManifest(msg(), deps);
      sinon.assert.calledOnce(deps.rebroadcast);
      sinon.assert.notCalled(deps.schedule);
    });

    it('a manifest held for an app not yet listed, a duplicate and a dropped one travel no further', async () => {
      const { service } = load();
      for (const outcome of ['held', 'duplicate', 'dropped']) {
        const deps = recvDeps({ take: sinon.stub().resolves({ outcome }) });
        // eslint-disable-next-line no-await-in-loop
        await service.receiveManifest(msg(), deps);
        sinon.assert.notCalled(deps.rebroadcast);
        sinon.assert.notCalled(deps.schedule);
      }
    });

    it('ignores a message carrying no manifest', async () => {
      const { service } = load();
      const deps = recvDeps();
      await service.receiveManifest({ data: {} }, deps);
      sinon.assert.notCalled(deps.take);
    });

    it('propagates an unexpected infrastructure failure (so the boundary can surface it)', async () => {
      const { service } = load();
      const deps = recvDeps({ take: sinon.stub().rejects(new Error('mongo down')) });
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

    it('takes each broadcast with its envelope and counts the manifests stored or held', async () => {
      const { service } = load();
      const take = sinon.stub()
        .onFirstCall().resolves({ outcome: 'stored' })
        .onSecondCall().resolves({ outcome: 'held' })
        .onThirdCall().resolves({ outcome: 'dropped' })
        .onCall(3).resolves({ outcome: 'duplicate' });
      const broadcasts = [bc(), bc(manifest({ version: 3 })), bc(manifest({ version: 4 })), bc(manifest({ version: 5 }))];
      const { stored } = await service.storeBatchContentManifests(broadcasts, { take });
      expect(stored).to.equal(2);
      expect(take.firstCall.args[0]).to.deep.equal(manifest());
      expect(take.firstCall.args[1]).to.deep.equal({ broadcast: broadcasts[0] });
    });

    it('skips a broadcast carrying no manifest', async () => {
      const { service } = load();
      const take = sinon.stub().resolves({ outcome: 'stored' });
      const { stored } = await service.storeBatchContentManifests([{ data: {} }, null, bc()], { take });
      expect(stored).to.equal(1);
      sinon.assert.calledOnce(take);
    });
  });

  describe('storeCarriedManifest (the manifest an applied update carries)', () => {
    const instance = { name: APP, identity: IDENTITY };

    it('keeps the manifest, judged for the row the update wrote, and says so', async () => {
      const { service, bus } = load();
      const take = sinon.stub().resolves({ outcome: 'stored' });
      const kept = await service.storeCarriedManifest(instance, sealedGossip(), { take });
      expect(kept).to.equal(true);
      sinon.assert.calledOnceWithExactly(take, sealedGossip(), {}, { take });
      sinon.assert.calledWith(bus.publish, 'content:manifestApplied', { appName: APP, identity: IDENTITY, version: 2 });
    });

    it('keeps nothing no owner of the app signed, and says why', async () => {
      const { service, bus } = load();
      const kept = await service.storeCarriedManifest(instance, sealedGossip(), { take: sinon.stub().resolves({ outcome: 'dropped', reason: 'forged_signature' }) });
      expect(kept).to.equal(false);
      sinon.assert.calledWith(bus.publish, 'content:manifestDropped', { appName: APP, reason: 'carried_invalid' });
    });
  });

  describe('resolveHeldManifests and rejudgeManifests (the row write)', () => {
    const info = {
      name: APP, owner: OWNER, isEncrypted: true, spec: slotSpecSealed, identity: IDENTITY,
    };
    const held = (version) => ({ ...storedRow(version, {}), signer: null, expireAt: new Date() });

    it('resolves a held manifest to the owner who signed it once the app is listed, and drops one no owner signed', async () => {
      const { service, bus } = load();
      const resolve = sinon.spy();
      const drop = sinon.spy();
      const resolved = await service.resolveHeldManifests(IDENTITY, {
        getApp: async () => info,
        getRows: async () => [held(1), held(2), storedRow(3, {})],
        ownerships: async () => [{ owner: OWNER, from: 2_400_000 }],
        verify: async (signed) => !signed.includes('"version":2'),
        resolve,
        drop,
        provider: fakeProvider(),
      });
      expect(resolved).to.equal(1);
      sinon.assert.calledOnceWithExactly(resolve, IDENTITY, 'h1', OWNER);
      sinon.assert.calledOnceWithExactly(drop, IDENTITY, 'h2');
      sinon.assert.calledWith(bus.publish, 'content:manifestPromoted', { appName: APP, identity: IDENTITY, version: 1 });
      sinon.assert.calledWith(bus.publish, 'content:manifestDropped', { appName: APP, reason: 'forged_signature' });
    });

    it('resolves nothing while the app is not listed', async () => {
      const { service } = load();
      const resolve = sinon.spy();
      expect(await service.resolveHeldManifests(IDENTITY, { getApp: async () => null, getRows: async () => [held(1)], resolve })).to.equal(0);
      sinon.assert.notCalled(resolve);
    });

    it('at a row write: resolves held rows, asks peers when the spec changed, says what stands, and brings a running app to it', async () => {
      const { service, bus } = load();
      const resolveHeld = sinon.stub().resolves(1);
      const refresh = sinon.stub().resolves(0);
      const applyBehind = sinon.stub().resolves(true);
      const standing = sinon.stub().resolves({ row: storedRow(2, {}) });
      await service.rejudgeManifests({ name: APP, identity: IDENTITY }, { specChanged: true }, {
        resolveHeld, refresh, applyBehind, standing,
      });
      sinon.assert.calledOnceWithExactly(resolveHeld, IDENTITY, sinon.match.object);
      sinon.assert.calledOnceWithExactly(refresh, APP, IDENTITY, sinon.match.object);
      sinon.assert.calledOnceWithExactly(applyBehind, APP, sinon.match.object);
      sinon.assert.callOrder(resolveHeld, refresh, standing, applyBehind);
      sinon.assert.calledWith(bus.publish, 'content:manifestsRejudged', { appName: APP, identity: IDENTITY, standing: 2 });
    });

    it('asks no peer when the spec did not change', async () => {
      const { service } = load();
      const refresh = sinon.stub().resolves(0);
      await service.rejudgeManifests({ name: APP, identity: IDENTITY }, {}, {
        resolveHeld: async () => 0, refresh, applyBehind: async () => false, standing: async () => ({ row: null }),
      });
      sinon.assert.notCalled(refresh);
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
        getApp: async () => ({
          owner: OWNER, isEncrypted: true, spec: slotSpecSealed, identity: IDENTITY,
        }),
        ownerships: async () => [{ owner: OWNER, from: 2_400_000 }],
        isInstalledHere: async () => null,
        openEnvelope: async () => sealedPayload(),
        broadcast: sinon.spy(),
        take: sinon.stub().resolves({ outcome: 'stored' }),
        schedule: sinon.stub().resolves(),
        uploader: makeUploader(),
        benchmark: makeBenchmark(),
        now,
        verify: () => true,
        provider: fakeProvider(),
        ...overrides,
      };
    }
    // The register already stored this app's initial manifest (version 1) under
    // this ownership, so the fixture update (version 2) is its successor.
    const loadSub = () => load(fakeRepo({ getContentManifests: sinon.stub().resolves([storedRow(1, {})]) }), { standing: async () => ({ row: storedRow(1, {}) }) });

    it('transport-opens, processes, stores, and gossips the sealed manifest', async () => {
      const { service } = loadSub();
      const deps = subDeps();
      const out = await service.submitContentUpdate(subBody(), deps);
      expect(out.slots).to.have.property('sealed'); // at-rest sealed for gossip
      sinon.assert.calledOnce(deps.broadcast);
      expect(deps.broadcast.firstCall.args[0]).to.include({ type: 'fluxappcontentmanifest', appName: APP });
      expect(deps.uploader.calls[0].headers.source).to.equal('slot');
    });

    it('takes the manifest with the exact signed broadcast it gossiped, for boot-sync re-serving', async () => {
      const { service } = loadSub();
      const data = { type: 'fluxappcontentmanifest', appName: APP, manifest: { sealed: true } };
      const signed = {
        version: 1, timestamp: 7, pubKey: 'pk', signature: 's', data,
      };
      const deps = subDeps({ broadcast: sinon.stub().resolves(signed) });
      const out = await service.submitContentUpdate(subBody(), deps);
      sinon.assert.calledOnce(deps.take);
      const [taken, opts] = deps.take.firstCall.args;
      expect(taken).to.equal(out);
      expect(opts.broadcast).to.equal(signed);
    });

    it('signs under the listed ownership: the manifest carries the height the owner took the app, and refuses an owner with none', async () => {
      const { service } = loadSub();
      const processSubmission = sinon.stub().resolves({ slots: { sealed: {} }, version: 2 });
      await service.submitContentUpdate(subBody(), subDeps({ processSubmission }));
      expect(processSubmission.firstCall.args[0]).to.include({ owner: OWNER, ownedFrom: 2_400_000 });
      await expectReject(
        service.submitContentUpdate(subBody(), subDeps({ ownerships: async () => [{ owner: '1other', from: 5 }] })),
        /no applied ownership/,
      );
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
          appName: APP, identity: IDENTITY, version: 2, timestamp: 1_700_000_000_000, manifestPutSig: 'owner-sig',
        },
        { put, sign },
      );
      expect(okPut).to.equal(true);
      // The signer is handed the text's fields: the identity, never the name.
      sinon.assert.calledWithMatch(sign, {
        identity: IDENTITY, version: 2, timestamp: 1_700_000_000_000, pendingMessageHash: null,
      });
      sinon.assert.calledOnce(put);
      const [appName, body] = put.firstCall.args;
      expect(appName).to.equal(APP);
      expect(body).to.include({
        version: 2, ownerSig: 'owner-sig', arcaneSig: 'arcane-sig', pendingMessageHash: null,
      });
    });

    it('names the message a carried manifest rides in, to the signer and to FluxDrive', async () => {
      const { service } = load();
      const put = sinon.spy();
      const sign = sinon.stub().resolves('arcane-sig');
      const pending = 'f'.repeat(64);
      await service.backstopManifest(
        { appName: APP, version: 2, slots: { sealed: {} } },
        {
          appName: APP, identity: IDENTITY, version: 2, timestamp: 1, manifestPutSig: 'owner-sig', pendingMessageHash: pending,
        },
        { put, sign },
      );
      sinon.assert.calledWithMatch(sign, { pendingMessageHash: pending });
      expect(put.firstCall.args[1].pendingMessageHash).to.equal(pending);
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
          appName: APP, identity: IDENTITY, version: 3, reconcileSig: 'owner-rsig',
        },
        { reconcile, sign, deriveLocator },
      );
      expect(pushed).to.equal(true);
      sinon.assert.calledWithMatch(deriveLocator, sinon.match.any, { identity: IDENTITY, contentHash: CFG_HASH });
      // The signer binds the kept list by its hash, so it is handed the very list sent.
      sinon.assert.calledWithMatch(sign, {
        identity: IDENTITY, source: 'slot', version: 3, keptLocators: ['loc-cfg'], pendingMessageHash: null,
      });
      sinon.assert.calledOnce(reconcile);
      const [appName, body] = reconcile.firstCall.args;
      expect(appName).to.equal(APP);
      expect(body).to.deep.equal({
        source: 'slot', version: 3, arcaneSig: 'arcane-sig', ownerSig: 'owner-rsig', liveLocators: ['loc-cfg'], pendingMessageHash: null,
      });
    });

    it('names the message a carried reconcile rides in, to the signer and to FluxDrive', async () => {
      const { service } = load();
      const reconcile = sinon.spy();
      const sign = sinon.stub().resolves('arcane-sig');
      const pending = 'f'.repeat(64);
      await service.reconcileSlots(
        manifest({ version: 3 }),
        {
          appName: APP, identity: IDENTITY, version: 3, reconcileSig: 'owner-rsig', pendingMessageHash: pending,
        },
        { reconcile, sign, deriveLocator: sinon.stub().resolves('loc-cfg') },
      );
      sinon.assert.calledWithMatch(sign, { pendingMessageHash: pending });
      expect(reconcile.firstCall.args[1].pendingMessageHash).to.equal(pending);
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
          appName: APP, identity: IDENTITY, version: 3, reconcileSig: 'sig',
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
          appName: APP, identity: IDENTITY, version: 3, reconcileSig: undefined,
        }, { reconcile },
      );
      expect(pushed).to.equal(false);
      sinon.assert.notCalled(reconcile);
    });

    it('sends nothing for a registration\'s first manifest, which supersedes nothing, and sends an incoming owner\'s first', async () => {
      const { service } = load();
      const reconcile = sinon.spy();
      const sign = sinon.stub().resolves('arcane-sig');
      const deriveLocator = sinon.stub().resolves('loc-cfg');
      const registrations = await service.reconcileSlots(
        manifest({ version: 1, ownedFrom: 0 }), {
          appName: APP, identity: IDENTITY, version: 1, reconcileSig: 'sig',
        }, { reconcile, sign, deriveLocator },
      );
      expect(registrations).to.equal(false);
      sinon.assert.notCalled(reconcile);
      const buyers = await service.reconcileSlots(
        manifest({ version: 1, ownedFrom: 2_400_000 }), {
          appName: APP, identity: IDENTITY, version: 1, reconcileSig: 'sig',
        }, { reconcile, sign, deriveLocator },
      );
      expect(buyers).to.equal(true);
      sinon.assert.calledOnce(reconcile);
    });

    it('never pushes an empty live set (would tombstone every slot blob)', async () => {
      const { service } = load();
      const reconcile = sinon.spy();
      const deriveLocator = sinon.stub().resolves('x');
      const pushed = await service.reconcileSlots(
        { ...manifest({ version: 3 }), slots: {} },
        {
          appName: APP, identity: IDENTITY, version: 3, reconcileSig: 'sig',
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
          appName: APP, identity: IDENTITY, version: 3, reconcileSig: 'sig',
        }, { reconcile, sign, deriveLocator },
      );
      expect(pushed).to.equal(false);
    });
  });

  describe('handleIncomingManifest (fire-and-forget boundary)', () => {
    it('swallows an unexpected failure without rejecting and without rebroadcasting', async () => {
      const { service } = load();
      const deps = recvDeps({ take: sinon.stub().rejects(new Error('mongo down')) });
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

    it('applies a manifest at most once (submitter apply vs its gossip echo)', async () => {
      const { service } = load();
      const deps = applyDeps();
      const m = { appName: APP, version: 2, slots: { cfg: { hash: HCFG } } };
      await service.applyManifest(cfgSignal, m, ctx, deps);
      await service.applyManifest(cfgSignal, m, ctx, deps);
      sinon.assert.calledOnce(deps.signal);
    });

    it('applies a manifest that ranks below the one applied last: after a transfer the named one stands again', async () => {
      const { service } = load();
      const deps = applyDeps();
      await service.applyManifest(cfgSignal, { appName: APP, version: 3, ownedFrom: 100, slots: { cfg: { hash: HCFG } } }, ctx, deps);
      await service.applyManifest(cfgSignal, { appName: APP, version: 2, ownedFrom: 100, slots: { cfg: { hash: HCFG } } }, ctx, deps);
      sinon.assert.calledTwice(deps.signal);
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
      const [identity, keep] = store.retainOnly.firstCall.args;
      expect(identity, 'the store is keyed by the installed app\'s identity').to.equal(IDENTITY);
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
      this.timeout(30_000);
      dep = await deploymentOf(webWith(slotMount('app-config')));
      spec = slotSpecSealed;
      tenInstanceSpec = await sealedSpec(webWith(slotMount('app-config')), { instances: 10 });
    });
    // The app stands on the manifest being scheduled, unless a test says otherwise.
    const standsOn = (m) => async () => ({ row: { hash: flux.contentManifestHash(m) } });
    const ANY = { appName: APP, slots: {} };

    it('applies via the installed deployment and the app\'s running peers', async () => {
      const { service } = load();
      const apply = sinon.spy();
      await service.scheduleContentApplication(
        ANY, spec,
        {
          getDeployment: async () => dep, getPeers: async () => ['1.2.3.4:16127'], apply, inspect: up, standing: standsOn(ANY),
        },
      );
      sinon.assert.calledOnce(apply);
      expect(apply.firstCall.args[0]).to.equal(dep);
      expect(apply.firstCall.args[2]).to.deep.equal({ appName: APP, peers: ['1.2.3.4:16127'] });
      // applyManifest stays stubbed here; the real one walks the deployment's
      // components for their slot and blob mounts.
      assertAnswers(apply.firstCall.args[0], ['componentEntries']);
    });

    it('does nothing when the app is not installed here', async () => {
      const { service } = load();
      const apply = sinon.spy();
      await service.scheduleContentApplication(
        ANY, spec,
        { getDeployment: async () => null, apply, inspect: up, standing: standsOn(ANY) },
      );
      sinon.assert.notCalled(apply);
    });

    it('skips a manifest that is no longer the one the app stands on when its moment comes', async () => {
      const { service, bus } = load();
      const apply = sinon.spy();
      await service.scheduleContentApplication(
        ANY, spec,
        {
          getDeployment: async () => dep, getPeers: async () => [], apply, inspect: up, standing: async () => ({ row: { hash: 'another' } }),
        },
      );
      sinon.assert.notCalled(apply);
      sinon.assert.calledWith(bus.publish, 'content:slotApplySkipped', sinon.match({ appName: APP, reason: 'not_standing' }));
    });

    // An install has an installed record long before it has a mounted volume: the container
    // doesn't exist while the component's filesystem is still being made, and writing a slot
    // then lands on an unmounted path. The installer stages the content itself once the
    // volume is there, so skipping costs nothing.
    it('does not apply while the app is installed but not yet up (mid-install)', async () => {
      const { service } = load();
      const apply = sinon.spy();
      await service.scheduleContentApplication(
        ANY, spec,
        {
          getDeployment: async () => dep,
          getPeers: async () => [],
          apply,
          standing: standsOn(ANY),
          inspect: async () => { throw new Error('No such container: web_app'); },
        },
      );
      sinon.assert.notCalled(apply);
    });

    it('does not apply when the container exists but is stopped (the start path stages it)', async () => {
      const { service } = load();
      const apply = sinon.spy();
      await service.scheduleContentApplication(
        ANY, spec,
        {
          getDeployment: async () => dep,
          getPeers: async () => [],
          apply,
          standing: standsOn(ANY),
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
    const schedDeps = (sched, m, over = {}) => ({
      getDeployment: async () => dep,
      getPeers: async () => [],
      inspect: up,
      now: sched.now,
      setTimer: sched.setTimer,
      standing: standsOn(m),
      ...over,
    });

    it('immediate rollout applies now, no timer', async () => {
      const { service } = load();
      const apply = sinon.spy();
      const sched = fakeScheduler(1000);
      const m = manifest({ rollout: { strategy: 'immediate' } });
      await service.scheduleContentApplication(m, spec, schedDeps(sched, m, { apply }));
      sinon.assert.calledOnce(apply);
      expect(sched.timers.length).to.equal(0);
    });

    it('scheduled rollout defers to activateAt, then applies', async () => {
      const { service } = load();
      const apply = sinon.spy();
      const sched = fakeScheduler(1000); // now = 1000ms
      const m = manifest({ rollout: { strategy: 'scheduled', activateAt: 2000 } }); // activateAt = 2000ms
      await service.scheduleContentApplication(m, spec, schedDeps(sched, m, { apply }));
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
      await service.scheduleContentApplication(m, spec, schedDeps(sched, m, { apply }));
      sinon.assert.calledOnce(apply);
      expect(sched.timers.length).to.equal(0);
    });

    it('staggered rollout computes the ordinal slot at activateAt and applies after it', async () => {
      const { service } = load();
      const apply = sinon.spy();
      const computeDelay = sinon.stub().resolves(5000); // this node's slot is 5s into the window
      const sched = fakeScheduler(1000);
      const m = manifest({ rollout: { strategy: 'staggered', activateAt: 2000, staggerSeconds: 30 } });
      await service.scheduleContentApplication(m, tenInstanceSpec, schedDeps(sched, m, { apply, computeDelay }));
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
      const sched = fakeScheduler(40_000); // past activateAt + staggerSeconds
      const m = manifest({ rollout: { strategy: 'staggered', activateAt: 2000, staggerSeconds: 30 } });
      await service.scheduleContentApplication(m, tenInstanceSpec, schedDeps(sched, m, { apply, computeDelay }));
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
      await service.scheduleContentApplication(m, spec, schedDeps(sched, m, {
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
      expect(await service.computeStaggerDelayMs(APP, 4, 40, deps)).to.equal(20_000);
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
      expect(await service.computeStaggerDelayMs(APP, 2, 40, deps)).to.equal(30_000);
    });
  });

  describe('applyManifest records the delivered manifest', () => {
    const HCFG = `sha256:${'1'.repeat(64)}`;
    const m = { appName: APP, version: 4, slots: { cfg: { hash: HCFG } } };
    let dep;

    before(async () => { dep = await deploymentOf(webWith(slotMount('cfg'))); });

    it('marks the manifest delivered, by its hash, after a successful apply', async () => {
      const { service, specLib } = load();
      const recordApplied = sinon.spy();
      await service.applyManifest(dep, m, { appName: APP, owner: OWNER, peers: [] }, {
        resolve: async () => Buffer.from('x'), writeFile: sinon.spy(), applyPerms: sinon.spy(), signal: sinon.spy(), recordApplied,
      });
      sinon.assert.calledOnceWithExactly(recordApplied, IDENTITY, specLib.contentManifestHash(m));
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
        db: component('db', [], { hostPort: 31_001, containerPort: 5432 }),
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

  describe('applyStoredIfBehind (bring a running container to the manifest the app stands on)', () => {
    let slotDeployment;
    before(async () => { slotDeployment = await deploymentOf(webWith(slotMount('app-config'))); });
    const app = () => ({
      name: APP, owner: OWNER, isEncrypted: true, spec: slotSpecSealed, identity: IDENTITY,
    });

    function baseDeps(overrides = {}) {
      return {
        standing: async () => ({ app: app(), row: storedRow(2, manifest().slots) }),
        getDeployment: async () => slotDeployment,
        componentsRunning: async () => true,
        schedule: sinon.spy(),
        provider: fakeProvider(),
        ...overrides,
      };
    }

    it('applies when the standing manifest is not the one delivered and the container is running', async () => {
      const { service } = load();
      const deps = baseDeps();
      expect(await service.applyStoredIfBehind(APP, deps)).to.equal(true);
      sinon.assert.calledOnce(deps.schedule);
      const [plaintext, handedSpec] = deps.schedule.firstCall.args;
      expect(plaintext.slots).to.deep.equal(manifest().slots);
      // scheduleContentApplication stays stubbed; the real one reads the fleet target
      // and owner off the spec it is handed.
      expect(handedSpec.owner).to.equal(OWNER);
      expect(handedSpec.instances).to.be.a('number');
    });

    it('reads the standing manifest by the installed app identity, and applies nothing to an install the registry no longer lists', async () => {
      const { service } = load();
      const standing = sinon.stub().resolves({ app: null, row: null });
      const deps = baseDeps({ standing });
      expect(await service.applyStoredIfBehind(APP, deps)).to.equal(false);
      sinon.assert.calledOnceWithExactly(standing, IDENTITY, sinon.match.object);
      sinon.assert.notCalled(deps.schedule);
    });

    it('is a no-op when the standing manifest is the one delivered', async () => {
      const { service } = load();
      const deps = baseDeps({ standing: async () => ({ app: app(), row: storedRow(2, {}, { applied: true }) }) });
      expect(await service.applyStoredIfBehind(APP, deps)).to.equal(false);
      sinon.assert.notCalled(deps.schedule);
    });

    it('is a no-op when the container is not running (leaves it for the start path)', async () => {
      const { service } = load();
      const deps = baseDeps({ componentsRunning: async () => false });
      expect(await service.applyStoredIfBehind(APP, deps)).to.equal(false);
      sinon.assert.notCalled(deps.schedule);
    });

    it('is a no-op when the app is not installed here, or nothing stands', async () => {
      const { service } = load();
      const notInstalled = baseDeps({ getDeployment: async () => null });
      expect(await service.applyStoredIfBehind(APP, notInstalled)).to.equal(false);
      const nothing = baseDeps({ standing: async () => ({ app: app(), row: null }) });
      expect(await service.applyStoredIfBehind(APP, nothing)).to.equal(false);
      sinon.assert.notCalled(nothing.schedule);
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

    // A cleartext slot app: its manifests travel with plaintext slots.
    const app = () => ({
      name: APP, owner: OWNER, isEncrypted: false, spec: slotSpec, identity: IDENTITY,
    });
    const standsOn = (m, extra = {}) => async () => ({
      app: app(),
      row: {
        identity: IDENTITY, hash: `h${m.version}`, version: m.version, ownedFrom: m.ownedFrom, signer: OWNER, applied: false, data: { manifest: m }, ...extra,
      },
    });

    it('mounts each slot component\'s volume before provisioning (the immutable mountpoint EPERMs an unmounted write)', async () => {
      const { service } = load();
      const provision = sinon.spy();
      const ensureMounted = sinon.stub().resolves({ mounted: true });
      await service.reconcileBootContent(APP, {
        getDeployment: async () => slotDeployment,
        standing: standsOn(manifest({ rollout: { strategy: 'immediate' } })),
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
        standing: standsOn(manifest({ rollout: { strategy: 'immediate' } })),
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

    it('provisions the current content before start when the standing rollout is due', async () => {
      const { service } = load();
      const provision = sinon.spy();
      const schedule = sinon.spy();
      await service.reconcileBootContent(APP, {
        getDeployment: async () => slotDeployment,
        standing: standsOn(manifest({ rollout: { strategy: 'immediate' } })),
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
        standing: standsOn(future),
        provision,
        schedule,
        now: () => 0,
      });
      sinon.assert.notCalled(provision); // not applied early
      sinon.assert.calledOnce(schedule); // re-armed to land at activateAt
      expect(schedule.firstCall.args[0].rollout.strategy).to.equal('scheduled');
      expect(schedule.firstCall.args[1]).to.equal(slotSpec);
    });

    it('reads the standing manifest by the installed app identity, and re-arms nothing for an install the registry no longer lists', async () => {
      const { service } = load();
      const schedule = sinon.spy();
      const standing = sinon.stub().resolves({ app: null, row: null });
      await service.reconcileBootContent(APP, {
        getDeployment: async () => slotDeployment,
        standing,
        getPeers: async () => [],
        provision: sinon.spy(),
        ensureMounted: async () => ({ mounted: true }),
        schedule,
        now: () => 0,
      });
      sinon.assert.calledWith(standing, IDENTITY);
      sinon.assert.notCalled(schedule);
    });

    it('provisions a past-due rollout (activateAt passed during downtime) before start', async () => {
      const { service } = load();
      const provision = sinon.spy();
      const schedule = sinon.spy();
      const past = manifest({ rollout: { strategy: 'scheduled', activateAt: 1000 } }); // 1000ms, past (now=5000)
      await service.reconcileBootContent(APP, {
        getDeployment: async () => slotDeployment,
        standing: standsOn(past),
        getPeers: async () => [],
        provision,
        ensureMounted: async () => ({ mounted: true }),
        schedule,
        now: () => 5000, // past activateAt
      });
      sinon.assert.calledOnce(provision);
      sinon.assert.notCalled(schedule);
    });

    it('re-arms a surviving container\'s future rollout without re-provisioning its running mount', async () => {
      const { service } = load();
      const provision = sinon.spy();
      const schedule = sinon.spy();
      const future = manifest({ rollout: { strategy: 'scheduled', activateAt: 1_000_000 } });
      await service.reconcileBootContent(APP, {
        getDeployment: async () => slotDeployment,
        standing: standsOn(future),
        provision,
        schedule,
        now: () => 0,
        restarting: false, // FluxOS process restart, container survived
      });
      sinon.assert.calledOnce(schedule); // re-armed (its in-memory timer died with the process)
      sinon.assert.notCalled(provision); // running mount not re-written
    });

    it('brings a surviving container to a standing manifest that is not the one delivered, in place (never re-provisions)', async () => {
      const { service } = load();
      const provision = sinon.spy();
      const schedule = sinon.spy();
      await service.reconcileBootContent(APP, {
        getDeployment: async () => slotDeployment,
        standing: standsOn(manifest({ version: 3, rollout: { strategy: 'immediate' } })),
        componentsRunning: async () => true,
        provision,
        schedule,
        now: () => 0,
        restarting: false,
      });
      sinon.assert.notCalled(provision); // running mount is never re-provisioned
      sinon.assert.calledOnce(schedule); // caught up in place (a during-downtime update won't re-gossip)
    });

    it('leaves a surviving container that is already on the standing manifest untouched', async () => {
      const { service } = load();
      const provision = sinon.spy();
      const schedule = sinon.spy();
      await service.reconcileBootContent(APP, {
        getDeployment: async () => slotDeployment,
        standing: standsOn(manifest({ version: 3, rollout: { strategy: 'immediate' } }), { applied: true }),
        componentsRunning: async () => true,
        provision,
        schedule,
        now: () => 0,
        restarting: false,
      });
      sinon.assert.notCalled(provision);
      sinon.assert.notCalled(schedule);
    });
  });

  describe('provisionContentSlots', () => {
    let slotDeployment;
    let twoSlotDeployment;
    let noSlotDeployment;
    let info;

    before(async () => {
      slotDeployment = await deploymentOf(webWith(slotMount('app-config')));
      twoSlotDeployment = await deploymentOf(webWith(slotMount('app-config'), slotMount('tls-cert')));
      noSlotDeployment = await deploymentOf(webWith());
      // Install-time provisioning reads the app off the registry: the sealed spec.
      info = {
        owner: OWNER, isEncrypted: true, spec: slotSpecSealed, identity: IDENTITY,
      };
    });
    const standsOn = (row) => async () => ({ app: info, row });

    it('stages from the standing manifest when it covers every declared slot, asking nobody', async () => {
      const { service } = load();
      const stageApply = sinon.spy();
      const refresh = sinon.spy();
      const recordApplied = sinon.spy();

      await service.provisionContentSlots(slotDeployment, { appName: APP, peers: ['p1'] }, {
        getApp: async () => info,
        standing: standsOn(storedRow(2, manifest().slots)),
        refresh,
        stageApply,
        recordApplied,
        provider: fakeProvider(),
      });

      sinon.assert.notCalled(refresh);
      sinon.assert.calledOnce(stageApply);
      expect(stageApply.firstCall.args[1].slots).to.deep.equal(manifest().slots);
      expect(stageApply.firstCall.args[2]).to.deep.equal({ appName: APP, peers: ['p1'] });
      // stageAndApplySlots stays stubbed; the real one walks the deployment's
      // components for their contentSlotMounts.
      assertAnswers(stageApply.firstCall.args[0], ['componentEntries']);
      // Without this mark, applyStoredIfBehind sees the node "behind" and re-applies the
      // just-provisioned content to the now-running container THROUGH applyManifest, firing
      // the onUpdate reaction — a spurious install-time restart/signal.
      sinon.assert.calledOnceWithExactly(recordApplied, IDENTITY, 'h2');
    });

    it('refuses to provision an install the registry no longer lists under its name', async () => {
      const { service } = load();
      const stageApply = sinon.spy();
      await expectReject(service.provisionContentSlots(slotDeployment, { appName: APP, peers: [] }, {
        getApp: async () => ({ ...info, identity: `b${'c'.repeat(52)}` }),
        standing: standsOn(null),
        stageApply,
      }), /another registration of the name/);
      sinon.assert.notCalled(stageApply);
    });

    it('resolves each slot into the store of the install being provisioned', async () => {
      const { service } = load();
      const resolve = sinon.stub().resolves(CFG);
      await service.stageAndApplySlots(slotDeployment, manifest(), { appName: APP, peers: [] }, {
        resolve, writeFile: async () => {}, rename: async () => {}, applyPerms: async () => {},
      });
      expect(resolve.firstCall.args[0]).to.include({ appName: APP, identity: IDENTITY, contentHash: CFG_HASH });
    });

    it('reads the standing manifest by the app identity', async () => {
      const { service } = load();
      const standing = sinon.stub().resolves({ app: info, row: storedRow(2, manifest().slots) });
      await service.provisionContentSlots(slotDeployment, { appName: APP, peers: [] }, {
        getApp: async () => info, standing, stageApply: sinon.spy(), recordApplied: sinon.spy(), provider: fakeProvider(),
      });
      sinon.assert.calledWith(standing, IDENTITY);
    });

    it('asks the nodes running the app and FluxDrive when nothing stands, then stages what then stands', async () => {
      const { service } = load();
      const stageApply = sinon.spy();
      let asked = false;
      const refresh = sinon.stub().callsFake(async () => { asked = true; return 1; });
      const standing = async () => ({ app: info, row: asked ? storedRow(2, manifest().slots) : null });

      await service.provisionContentSlots(slotDeployment, { appName: APP, peers: ['p1'] }, {
        getApp: async () => info, standing, refresh, stageApply, recordApplied: sinon.spy(), provider: fakeProvider(),
      });

      sinon.assert.calledOnceWithExactly(refresh, APP, IDENTITY, sinon.match({ peers: ['p1'] }));
      sinon.assert.calledOnce(stageApply);
      expect(stageApply.firstCall.args[1].slots).to.deep.equal(manifest().slots);
    });

    it('a standing manifest short of a declared slot counts as none: asks, and holds the install if still short', async () => {
      const { service } = load();
      const stageApply = sinon.spy();
      const refresh = sinon.stub().resolves(0);
      await expectReject(
        service.provisionContentSlots(twoSlotDeployment, { appName: APP, peers: [] }, {
          getApp: async () => info,
          standing: standsOn(storedRow(2, manifest().slots)), // app-config only; tls-cert is declared too
          refresh,
          stageApply,
          provider: fakeProvider(),
        }),
        /covering every declared slot/,
      );
      sinon.assert.calledOnce(refresh);
      sinon.assert.notCalled(stageApply);
    });

    it('holds the install (throws) when nothing stands after the ask', async () => {
      const { service } = load();
      const stageApply = sinon.spy();
      await expectReject(
        service.provisionContentSlots(slotDeployment, { appName: APP, peers: [] }, {
          getApp: async () => info, standing: standsOn(null), refresh: async () => 0, stageApply,
        }),
        /holding install until content is present/,
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

  describe('getContentManifestApi and getContentManifestsApi', () => {
    const res = () => { const r = { json: sinon.stub(), status: sinon.stub() }; r.status.returns(r); return r; };

    it('serves the manifest the app the registry lists under the name stands on, read by its identity', async () => {
      const standing = sinon.stub().resolves({ row: storedRow(2, {}) });
      const { service } = load(fakeRepo({ getGlobalAppInfo: sinon.stub().resolves({ name: APP, identity: IDENTITY }) }), { standing });
      const r = res();
      await service.getContentManifestApi({ params: { appname: APP } }, r);
      sinon.assert.calledOnceWithExactly(standing, IDENTITY);
      expect(r.json.firstCall.args[0].data).to.deep.equal(storedRow(2, {}).data.manifest);
    });

    it('answers 404 when nothing stands', async () => {
      const { service } = load(fakeRepo({ getGlobalAppInfo: sinon.stub().resolves({ name: APP, identity: IDENTITY }) }), { standing: async () => ({ row: null }) });
      const r = res();
      await service.getContentManifestApi({ params: { appname: APP } }, r);
      sinon.assert.calledWith(r.status, 404);
    });

    it('serves every resolved manifest held, the standing one, the listed ownership and the next version to sign', async () => {
      const rows = [storedRow(1, {}), storedRow(2, {}), { ...storedRow(3, {}), signer: null }];
      const standing = sinon.stub().resolves({ row: rows[1], rows });
      const repo = fakeRepo({
        getGlobalAppInfo: sinon.stub().resolves({ name: APP, identity: IDENTITY }),
        getContentManifests: sinon.stub().resolves(rows),
        carriedManifestRanks: sinon.stub().resolves([{ version: 3, ownedFrom: 2_400_000 }]),
      });
      const { service } = load(repo, { standing, ownerships: async () => [{ owner: OWNER, from: 2_400_000 }] });
      const r = res();
      await service.getContentManifestsApi({ params: { appname: APP } }, r);
      const { data } = r.json.firstCall.args[0];
      expect(data.identity).to.equal(IDENTITY);
      expect(data.ownership).to.deep.equal({ owner: OWNER, from: 2_400_000 });
      expect(data.standing).to.deep.equal({ hash: 'h2', version: 2, ownedFrom: 2_400_000 });
      expect(data.nextVersion, 'one above the highest held or waiting under the ownership').to.equal(4);
      expect(data.manifests.map((m) => m.version)).to.deep.equal([1, 2]);
    });

    it('answers for an expired app from the state it last held: its ownership, the rows kept and the next version, standing on nothing', async () => {
      const rows = [storedRow(1, {}), storedRow(2, {})];
      const standing = sinon.stub().resolves({ app: null, row: null, aside: false, rows });
      const latestAppliedState = sinon.stub().resolves({ name: APP, identity: IDENTITY, owner: OWNER });
      const repo = fakeRepo({
        getGlobalAppInfo: sinon.stub().resolves(null),
        getContentManifests: sinon.stub().resolves(rows),
      });
      const { service } = load(repo, { standing, ownerships: async () => [{ owner: OWNER, from: 2_400_000 }], latestAppliedState });
      const r = res();
      await service.getContentManifestsApi({ params: { appname: APP } }, r);
      sinon.assert.calledOnceWithExactly(latestAppliedState, APP);
      const { data } = r.json.firstCall.args[0];
      expect(data.identity).to.equal(IDENTITY);
      expect(data.ownership).to.deep.equal({ owner: OWNER, from: 2_400_000 });
      expect(data.standing).to.equal(null);
      expect(data.nextVersion, 'the owner numbers a renewal\'s file list above what the node kept').to.equal(3);
      expect(data.manifests.map((m) => m.version)).to.deep.equal([1, 2]);
    });

    it('answers 404 for a name no app is listed under or ever held', async () => {
      const latestAppliedState = sinon.stub().resolves(null);
      const { service } = load(fakeRepo({ getGlobalAppInfo: sinon.stub().resolves(null) }), { latestAppliedState });
      const r = res();
      await service.getContentManifestsApi({ params: { appname: APP } }, r);
      sinon.assert.calledOnceWithExactly(latestAppliedState, APP);
      sinon.assert.calledWith(r.status, 404);
    });
  });

  // An identity's manifest rows outlive its row: an expired app renews on
  // them. They are dead once another registration of the name holds it, and
  // reaped once that registration is beyond the chain's reorg cap.
  describe('reapDisplacedManifests', () => {
    const OTHER = `b${'c'.repeat(52)}`;
    const registrationOf = (identity, height) => ({ decision: { identity, height, type: 'registration' } });

    function reaperDeps(overrides = {}) {
      return {
        listHeld: async () => [{ identity: IDENTITY, appName: APP }],
        latestRegistration: sinon.stub().resolves(registrationOf(OTHER, 1000)),
        scannedHeight: async () => 1040,
        remove: sinon.stub().resolves(2),
        ...overrides,
      };
    }

    it('reaps the rows of an identity another registration of its name displaced, once that registration is a reorg cap deep', async () => {
      const { service, bus } = load();
      const deps = reaperDeps();
      const out = await service.reapDisplacedManifests(deps);
      expect(out).to.deep.equal({ reaped: 2, orphans: [IDENTITY] });
      sinon.assert.calledOnceWithExactly(deps.latestRegistration, APP);
      sinon.assert.calledOnceWithExactly(deps.remove, IDENTITY);
      sinon.assert.calledWithMatch(bus.publish, 'content:manifestReaped', { count: 2, identities: [IDENTITY] });
    });

    it('keeps the rows while the displacing registration is within the reorg cap', async () => {
      const { service, bus } = load();
      const deps = reaperDeps({ scannedHeight: async () => 1039 });
      expect(await service.reapDisplacedManifests(deps)).to.deep.equal({ reaped: 0, orphans: [] });
      sinon.assert.notCalled(deps.remove);
      sinon.assert.neverCalledWith(bus.publish, 'content:manifestReaped');
    });

    it('keeps the rows of the identity the name\'s latest registration made: an expired app renews on them', async () => {
      const { service } = load();
      const deps = reaperDeps({ latestRegistration: sinon.stub().resolves(registrationOf(IDENTITY, 1000)) });
      expect(await service.reapDisplacedManifests(deps)).to.deep.equal({ reaped: 0, orphans: [] });
      sinon.assert.notCalled(deps.remove);
    });

    it('keeps the rows of a name with no applied registration: an empty history is not evidence', async () => {
      const { service } = load();
      const deps = reaperDeps({ latestRegistration: sinon.stub().resolves(null) });
      expect(await service.reapDisplacedManifests(deps)).to.deep.equal({ reaped: 0, orphans: [] });
      sinon.assert.notCalled(deps.remove);
    });

    it('reads nothing further when no resolved row is held', async () => {
      const { service } = load();
      const deps = reaperDeps({ listHeld: async () => [] });
      expect(await service.reapDisplacedManifests(deps)).to.deep.equal({ reaped: 0, orphans: [] });
      sinon.assert.notCalled(deps.latestRegistration);
      sinon.assert.notCalled(deps.remove);
    });
  });
});
