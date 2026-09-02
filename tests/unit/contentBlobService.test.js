'use strict';

const { expect } = require('chai');
const crypto = require('node:crypto');
const contentBlobService = require('../../ZelBack/src/services/appLifecycle/contentBlobService');
const { aeadEncrypt } = require('../../ZelBack/src/services/utils/aeadCrypto');
const {
  loadSpecLibrary, V9_SUBMISSION, v9Spec, decryptedV9Spec,
} = require('./fixtures/fluxSpec');

const {
  encryptAndUploadBlob, encryptAndUploadBlobs, decryptAndVerifyBlob, resolveBlob, provisionContentBlobs,
  serveBlob, fetchBlobFromPeer, maxBlobBytes, maxFramedBlobBytes,
} = contentBlobService;

const KEY = crypto.randomBytes(32);
const NOW_MS = 1_700_000_000_000;
const now = () => NOW_MS;
const freshTs = String(NOW_MS);

const APP = V9_SUBMISSION.name;
const OWNER = V9_SUBMISSION.owner;
const APPS_FOLDER = '/dat/var/lib/fluxos/flux-apps';

const hashOf = (buf) => `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;
// executeCall shape: { status: 'success', data: { status: 'ok', <field> } }
const ok = (obj) => ({ status: 'success', data: { status: 'ok', ...obj } });

// The spec library is REAL here, not stubbed — see tests/unit/fixtures/fluxSpec.js
// for why. What stays stubbed is I/O: the FluxDrive uploader, the benchmark channel,
// peer HTTP, and the on-disk artifact store.
let flux;

// ── Real spec fixtures ────────────────────────────────────────────────────
//
// flux-spec's own rules shape these, not test convention: a contentRef is legal
// only on a `type: 'file'` mount, every mount needs its container destination,
// a contentRef hash is `sha256:<64 lowercase hex>`, and contentRef/contentSlot
// are mutually exclusive. The hand-written double this file used to carry
// (`{ source: 'mount0', contentRef: { hash } }`, owner `'1id'`) satisfied none
// of them.

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
 * The cleartext FluxAppSpecV9 that reaches encryptAndUploadBlobs. The submission
 * path (appSubmission.resolveSubmission) transport-opens the HPKE envelope and
 * validates the blob, then hands that cleartext instance straight to
 * uploadSealedContent -> encryptAndUploadBlobs — nothing is sealed yet, so this
 * is a plain FluxAppSpecV9, `isEncrypted === false`.
 */
// Every spec here carries a contentRef, which only works on the encrypted path,
// so the envelope is stated once for the whole file.
const submissionSpec = (...mounts) => v9Spec({ components: webWith(...mounts) }, { encrypted: true });

/**
 * The `priorSpec` an UPDATE carries — a different class from the one above.
 * appOperations reads the superseded spec off the registry (sealed, because any
 * content mount forces encryption) and decrypts it before forwarding, so what
 * arrives is a DecryptedCanonicalSpec: `isEncrypted === true`, `sealed === false`.
 */
const priorSpecOf = (...mounts) => decryptedV9Spec({ components: webWith(...mounts) });

/** The contentRef hashes a real spec declares, read through flux-spec's own
 * accessor — the production traversal's counterpart, never a test literal. */
const declaredHashes = (spec) => spec.componentEntries()
  .flatMap(([, comp]) => comp.persistentStorage.getMountsWithContentRef())
  .map((m) => m.contentRef.hash);

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

async function expectReject(promise, regex) {
  try {
    await promise;
  } catch (e) {
    expect(e.message).to.match(regex);
    return;
  }
  throw new Error('expected promise to reject');
}

// In-memory stand-in for the on-disk artifact store (contentStore) — resolve
// and serve tests inject it so no test touches the real filesystem.
function memStore(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    puts: [],
    removes: [],
    async get(app, hash) { return map.get(`${app}/${hash}`) ?? null; },
    async put(app, hash, framed) { this.puts.push({ app, hash }); map.set(`${app}/${hash}`, framed); return true; },
    async remove(app, hash) { this.removes.push({ app, hash }); map.delete(`${app}/${hash}`); },
    async list(app) {
      return [...map.keys()].filter((k) => k.startsWith(`${app}/`)).map((k) => k.slice(app.length + 1));
    },
  };
}

describe('contentBlobService', () => {
  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(30000);
    flux = await loadSpecLibrary();
  });

  describe('encryptAndUploadBlob', () => {
    it('encrypts, signs, and uploads a blob and returns its locator', async () => {
      const bytes = Buffer.from('hello content');
      const contentHash = hashOf(bytes);
      const uploader = makeUploader();

      const out = await encryptAndUploadBlob(
        {
          appName: APP, fluxID: OWNER, contentHash, bytes, ownerSig: 'owner-sig', timestamp: freshTs,
        },
        { benchmark: makeBenchmark(), uploader, now },
      );

      expect(out.locator).to.equal('a'.repeat(64));
      expect(uploader.calls.length).to.equal(1);
      const { framed, headers } = uploader.calls[0];
      expect(headers).to.include({
        locator: 'a'.repeat(64), appName: APP, ownerSig: 'owner-sig', arcaneSig: 'arcane-sig-b64', source: 'blob', timestamp: freshTs,
      });
      // ciphertext is nonce || ciphertext || tag (plaintext + 28) and hides the plaintext
      expect(framed.length).to.equal(bytes.length + 28);
      expect(framed.includes(bytes)).to.equal(false);
    });

    it('rejects a hash mismatch', async () => {
      const bytes = Buffer.from('data');
      await expectReject(encryptAndUploadBlob(
        {
          appName: APP, fluxID: OWNER, contentHash: `sha256:${'0'.repeat(64)}`, bytes, ownerSig: 's', timestamp: freshTs,
        },
        { benchmark: makeBenchmark(), uploader: makeUploader(), now },
      ), /hash mismatch/);
    });

    it('rejects an oversized blob', async () => {
      const bytes = Buffer.alloc(await maxBlobBytes() + 1);
      await expectReject(encryptAndUploadBlob(
        {
          appName: APP, fluxID: OWNER, contentHash: hashOf(bytes), bytes, ownerSig: 's', timestamp: freshTs,
        },
        { benchmark: makeBenchmark(), uploader: makeUploader(), now },
      ), /exceeds/);
    });

    it('rejects a stale owner timestamp', async () => {
      const bytes = Buffer.from('data');
      await expectReject(encryptAndUploadBlob(
        {
          appName: APP, fluxID: OWNER, contentHash: hashOf(bytes), bytes, ownerSig: 's', timestamp: String(NOW_MS - 6 * 60 * 1000),
        },
        { benchmark: makeBenchmark(), uploader: makeUploader(), now },
      ), /stale/);
    });

    it('surfaces a benchmark-channel rejection', async () => {
      const bytes = Buffer.from('data');
      const benchmark = makeBenchmark({ contentKey: async () => ({ status: 'error', data: 'boom' }) });
      await expectReject(encryptAndUploadBlob(
        {
          appName: APP, fluxID: OWNER, contentHash: hashOf(bytes), bytes, ownerSig: 's', timestamp: freshTs,
        },
        { benchmark, uploader: makeUploader(), now },
      ), /benchmark channel/);
    });
  });

  describe('encryptAndUploadBlobs', () => {
    const a = Buffer.from('content-a');
    const b = Buffer.from('content-b');
    const c = Buffer.from('content-c');
    const ha = hashOf(a);
    const hb = hashOf(b);
    const hc = hashOf(c);
    const stray = Buffer.from('stray');
    const hs = hashOf(stray);

    // Real specs, built once: the cleartext submission spec on the way in, and
    // the DECRYPTED superseded spec an update carries alongside it.
    let specA; // declares ha
    let specAB; // declares ha + hb
    let priorA; // decrypted, declares ha
    let priorB; // decrypted, declares hb
    let priorC; // decrypted, declares hc

    before(async function buildSpecs() {
      this.timeout(30000);
      specA = await submissionSpec(blobMount('cfg', ha));
      specAB = await submissionSpec(blobMount('cfg', ha), blobMount('seed', hb));
      priorA = await priorSpecOf(blobMount('cfg', ha));
      priorB = await priorSpecOf(blobMount('seed', hb));
      priorC = await priorSpecOf(blobMount('cfg', hc));
    });

    it('uploads every declared blob, matched to its mount by hash', async () => {
      const uploader = makeUploader();
      const ownerSigs = new Map([
        [ha, { sig: 'sig-a', timestamp: freshTs }],
        [hb, { sig: 'sig-b', timestamp: freshTs }],
      ]);
      const blobs = new Map([[ha, a], [hb, b]]);

      const out = await encryptAndUploadBlobs(
        { spec: specAB, blobs, ownerSigs },
        { benchmark: makeBenchmark(), uploader, now },
      );

      // The uploaded set is exactly what flux-spec says the spec declares — the
      // production traversal (componentEntries -> getMountsWithContentRef) is
      // checked against the library accessor, not against a literal.
      expect(out.map((u) => u.hash)).to.have.members(declaredHashes(specAB));
      expect(uploader.calls.length).to.equal(2);
      expect(uploader.calls.map((c2) => c2.headers.ownerSig)).to.have.members(['sig-a', 'sig-b']);
      // appName/fluxID are read off the real spec, so every upload is filed under
      // the app identity the submission actually carries.
      expect(uploader.calls.every((c2) => c2.headers.appName === specAB.name)).to.equal(true);
    });

    it('rejects when a declared contentRef has no blob part (no prior spec)', async () => {
      await expectReject(encryptAndUploadBlobs(
        { spec: specA, blobs: new Map(), ownerSigs: new Map([[ha, { sig: 's', timestamp: freshTs }]]) },
        { benchmark: makeBenchmark(), uploader: makeUploader(), now },
      ), /missing blob part/);
    });

    it('rejects a missing blob part the prior spec does not declare either', async () => {
      await expectReject(encryptAndUploadBlobs(
        {
          spec: specA,
          priorSpec: priorC,
          blobs: new Map(),
          ownerSigs: new Map(),
        },
        { benchmark: makeBenchmark(), uploader: makeUploader(), now },
      ), /missing blob part/);
    });

    it('carries over a prior-spec hash: presence-checked, not re-uploaded, no owner sig needed', async () => {
      const uploader = makeUploader({ exists: true });

      // The two arguments are DIFFERENT classes in production and here: the
      // incoming spec is cleartext, the superseded one was decrypted out of the
      // registry's sealed row. specContentHashes has to read both.
      expect(specAB.isEncrypted, 'the submission spec is cleartext').to.equal(false);
      expect(priorB.isEncrypted, 'the superseded spec is an encrypted app...').to.equal(true);
      expect(priorB.sealed, '...but readable right now').to.equal(false);

      const out = await encryptAndUploadBlobs(
        {
          spec: specAB,
          priorSpec: priorB,
          blobs: new Map([[ha, a]]),
          ownerSigs: new Map([[ha, { sig: 'sig-a', timestamp: freshTs }]]),
        },
        { benchmark: makeBenchmark(), uploader, now },
      );

      expect(out.map((u) => u.hash)).to.have.members([ha]);
      expect(uploader.calls.length).to.equal(1);
      expect(uploader.calls[0].headers.ownerSig).to.equal('sig-a');
      expect(uploader.headCalls.length).to.equal(1);
    });

    it('rejects a carried-over hash that is no longer in storage', async () => {
      await expectReject(encryptAndUploadBlobs(
        {
          spec: specA,
          priorSpec: priorA,
          blobs: new Map(),
          ownerSigs: new Map(),
        },
        { benchmark: makeBenchmark(), uploader: makeUploader({ exists: false }), now },
      ), /not in storage/);
    });

    it('uploads a carried-over hash anyway when its bytes are attached', async () => {
      const uploader = makeUploader();

      const out = await encryptAndUploadBlobs(
        {
          spec: specA,
          priorSpec: priorA,
          blobs: new Map([[ha, a]]),
          ownerSigs: new Map([[ha, { sig: 'sig-a', timestamp: freshTs }]]),
        },
        { benchmark: makeBenchmark(), uploader, now },
      );

      expect(out.map((u) => u.hash)).to.have.members([ha]);
      expect(uploader.calls.length).to.equal(1);
      expect(uploader.headCalls.length).to.equal(0);
    });

    it('rejects a stray blob the spec does not reference', async () => {
      await expectReject(encryptAndUploadBlobs(
        {
          spec: specA,
          blobs: new Map([[ha, a], [hs, stray]]),
          ownerSigs: new Map([[ha, { sig: 's', timestamp: freshTs }], [hs, { sig: 's', timestamp: freshTs }]]),
        },
        { benchmark: makeBenchmark(), uploader: makeUploader(), now },
      ), /not referenced by the spec/);
    });

    it('rejects a declared blob with no owner signature', async () => {
      await expectReject(encryptAndUploadBlobs(
        { spec: specA, blobs: new Map([[ha, a]]), ownerSigs: new Map() },
        { benchmark: makeBenchmark(), uploader: makeUploader(), now },
      ), /missing owner signature/);
    });
  });

  describe('decryptAndVerifyBlob', () => {
    it('round-trips an uploaded blob back to verified plaintext', async () => {
      const bytes = Buffer.from('round trip me');
      const contentHash = hashOf(bytes);
      const uploader = makeUploader();
      await encryptAndUploadBlob(
        {
          appName: APP, fluxID: OWNER, contentHash, bytes, ownerSig: 's', timestamp: freshTs,
        },
        { benchmark: makeBenchmark(), uploader, now },
      );
      const { framed } = uploader.calls[0];

      const out = await decryptAndVerifyBlob(
        {
          appName: APP, fluxID: OWNER, contentHash, framed,
        },
        { benchmark: makeBenchmark() },
      );
      expect(out.equals(bytes)).to.equal(true);
    });

    it('rejects ciphertext that fails authentication (wrong key)', async () => {
      const bytes = Buffer.from('data');
      const contentHash = hashOf(bytes);
      const uploader = makeUploader();
      await encryptAndUploadBlob(
        {
          appName: APP, fluxID: OWNER, contentHash, bytes, ownerSig: 's', timestamp: freshTs,
        },
        { benchmark: makeBenchmark(), uploader, now },
      );
      const { framed } = uploader.calls[0];

      const wrongKey = makeBenchmark({ contentKey: async () => ok({ key: crypto.randomBytes(32).toString('base64') }) });
      await expectReject(decryptAndVerifyBlob(
        {
          appName: APP, fluxID: OWNER, contentHash, framed,
        },
        { benchmark: wrongKey },
      ), /./);
    });
  });

  describe('resolveBlob', () => {
    const bytes = Buffer.from('install me');
    const contentHash = hashOf(bytes);
    const validFramed = () => aeadEncrypt(KEY, bytes, Buffer.from(contentHash));
    const noFluxDrive = { fetchBlobByLocator: async () => null };

    it('resolves from the first healthy peer and stores the verified ciphertext', async () => {
      const framed = validFramed();
      const store = memStore();
      const out = await resolveBlob(
        {
          appName: APP, fluxID: OWNER, contentHash, peers: ['p1', 'p2'],
        },
        {
          benchmark: makeBenchmark(), peerFetch: async () => framed, fluxDrive: noFluxDrive, store,
        },
      );
      expect(out.equals(bytes)).to.equal(true);
      expect(store.puts).to.deep.equal([{ app: APP, hash: contentHash }]);
      expect(store.map.get(`${APP}/${contentHash}`).equals(framed)).to.equal(true);
    });

    it('resolves from the artifact store without touching the network', async () => {
      const store = memStore({ [`${APP}/${contentHash}`]: validFramed() });
      const peerFetch = async () => { throw new Error('network must not be touched'); };
      const out = await resolveBlob(
        {
          appName: APP, fluxID: OWNER, contentHash, peers: ['p1'],
        },
        {
          benchmark: makeBenchmark(), peerFetch, fluxDrive: { fetchBlobByLocator: peerFetch }, store,
        },
      );
      expect(out.equals(bytes)).to.equal(true);
      expect(store.puts).to.deep.equal([]);
    });

    it('drops a corrupt store entry and re-fetches from a peer', async () => {
      const store = memStore({ [`${APP}/${contentHash}`]: Buffer.alloc(40, 7) });
      const framed = validFramed();
      const out = await resolveBlob(
        {
          appName: APP, fluxID: OWNER, contentHash, peers: ['p1'],
        },
        {
          benchmark: makeBenchmark(), peerFetch: async () => framed, fluxDrive: noFluxDrive, store,
        },
      );
      expect(out.equals(bytes)).to.equal(true);
      expect(store.removes).to.deep.equal([{ app: APP, hash: contentHash }]);
      expect(store.map.get(`${APP}/${contentHash}`).equals(framed)).to.equal(true);
    });

    it('falls through a failing peer to the next', async () => {
      const framed = validFramed();
      let n = 0;
      const peerFetch = async () => { n += 1; if (n === 1) throw new Error('peer down'); return framed; };
      const out = await resolveBlob(
        {
          appName: APP, fluxID: OWNER, contentHash, peers: ['p1', 'p2'],
        },
        {
          benchmark: makeBenchmark(), peerFetch, fluxDrive: noFluxDrive, store: memStore(),
        },
      );
      expect(out.equals(bytes)).to.equal(true);
      expect(n).to.equal(2);
    });

    it('skips a peer returning garbage, uses the FluxDrive backstop, and stores the result', async () => {
      const fluxDrive = { fetchBlobByLocator: async () => validFramed() };
      const store = memStore();
      const out = await resolveBlob(
        {
          appName: APP, fluxID: OWNER, contentHash, peers: ['p1'],
        },
        {
          benchmark: makeBenchmark(), peerFetch: async () => Buffer.alloc(40, 7), fluxDrive, store,
        },
      );
      expect(out.equals(bytes)).to.equal(true);
      expect(store.puts).to.deep.equal([{ app: APP, hash: contentHash }]);
    });

    it('throws when no source yields verified content', async () => {
      await expectReject(resolveBlob(
        {
          appName: APP, fluxID: OWNER, contentHash, peers: ['p1'],
        },
        {
          benchmark: makeBenchmark(), peerFetch: async () => null, fluxDrive: noFluxDrive, store: memStore(),
        },
      ), /no source/);
    });
  });

  describe('provisionContentBlobs', () => {
    const cfg = Buffer.from('config bytes');
    const seed = Buffer.from('seed bytes');
    const hCfg = hashOf(cfg);
    const hSeed = hashOf(seed);

    // A real DeploymentSpec — the projection appInstaller hands this function.
    // The mount's HOST path and its hash both come from flux-spec (compDir +
    // mount source, and the signed contentRef), never from a literal here.
    let deployment;
    let mounts; // [{ source, hash }] as flux-spec derived them

    before(async function buildDeployment() {
      this.timeout(30000);
      const decrypted = await decryptedV9Spec({
        components: {
          web: component('web', [blobMount('config', hCfg), blobMount('seed', hSeed)]),
          // A second component declaring no content: contentBlobMounts() is empty
          // and the loop must skip it rather than fail on it.
          db: component('db', [], { hostPort: 31001, containerPort: 5432 }),
        },
      });
      deployment = flux.DeploymentSpec.fromSpec(decrypted, APPS_FOLDER, { replica: null });
      mounts = deployment.componentEntries().flatMap(([, comp]) => comp.contentBlobMounts());
    });

    it('resolves and writes every content-blob mount, in order', async () => {
      const writes = [];
      const resolved = [];
      const resolve = async (req) => { resolved.push(req); return Buffer.from(`plain:${req.contentHash}`); };
      await provisionContentBlobs(
        deployment,
        { appName: APP, fluxID: OWNER, peers: ['p1'] },
        { resolve, writeFile: async (s, b) => writes.push({ source: s, body: b }) },
      );

      expect(mounts.length).to.equal(2);
      expect(writes.map((w) => w.source)).to.deep.equal(mounts.map((m) => m.source));
      expect(writes[0].body.toString()).to.equal(`plain:${mounts[0].hash}`);
      // The write target is the resolved HOST path under the apps folder, not the
      // in-container destination the spec declares.
      expect(writes[0].source.startsWith(`${APPS_FOLDER}/`)).to.equal(true);
      expect(writes[0].source).to.not.equal('/etc/app/config');

      // resolveBlob stays stubbed, so nothing here exercises what it does with the
      // request it is handed. The real one keys the benchmark locator/key derivation
      // AND the AEAD AAD on contentHash, and reads appName/fluxID/peers — so assert
      // the handed request actually carries them.
      expect(resolved.map((r) => r.contentHash)).to.deep.equal(mounts.map((m) => m.hash));
      expect(resolved[0]).to.include({ appName: APP, fluxID: OWNER });
      expect(resolved[0].peers).to.deep.equal(['p1']);
    });

    it('feeds the real resolver: the spec-derived hash verifies against the stored ciphertext', async () => {
      // The hash comes off the real DeploymentSpec and goes into the real
      // resolveBlob, whose AAD is Buffer.from(contentHash) — a hash that does not
      // survive the projection byte-for-byte cannot decrypt. Only I/O is faked:
      // the benchmark channel, the peer fetch, and the artifact store.
      const bytesFor = new Map([[hCfg, cfg], [hSeed, seed]]);
      const store = memStore();
      const writes = [];
      const resolve = (req, deps) => resolveBlob(req, {
        ...deps,
        benchmark: makeBenchmark(),
        peerFetch: async () => aeadEncrypt(KEY, bytesFor.get(req.contentHash), Buffer.from(req.contentHash)),
        fluxDrive: { fetchBlobByLocator: async () => null },
        store,
      });

      await provisionContentBlobs(
        deployment,
        { appName: APP, fluxID: OWNER, peers: ['p1'] },
        { resolve, writeFile: async (s, b) => writes.push({ source: s, body: b }) },
      );

      expect(writes.map((w) => w.body.toString())).to.deep.equal([cfg.toString(), seed.toString()]);
      expect(store.puts.map((p) => p.hash)).to.deep.equal(mounts.map((m) => m.hash));
    });

    it('propagates a resolve failure (app not installable without its content)', async () => {
      const resolve = async () => { throw new Error(`contentBlob: no source for ${hCfg}`); };
      await expectReject(provisionContentBlobs(
        deployment,
        { appName: APP, fluxID: OWNER, peers: [] },
        { resolve, writeFile: async () => {} },
      ), /no source/);
    });
  });

  describe('serveBlob', () => {
    const bytes = Buffer.from('served content');
    const contentHash = hashOf(bytes);
    const storedFramed = aeadEncrypt(KEY, bytes, Buffer.from(contentHash));

    it('serves the stored artifact ciphertext verbatim for a matching locator', async () => {
      const store = memStore({ [`${APP}/${contentHash}`]: storedFramed });
      const framed = await serveBlob(
        { appName: APP, fluxID: OWNER, locator: 'a'.repeat(64) },
        { benchmark: makeBenchmark(), store },
      );
      expect(framed.equals(storedFramed)).to.equal(true); // verbatim — never re-read or re-encrypted
      const out = await decryptAndVerifyBlob({
        appName: APP, fluxID: OWNER, contentHash, framed,
      }, { benchmark: makeBenchmark() });
      expect(out.equals(bytes)).to.equal(true);
    });

    it('returns null when no stored artifact matches the locator', async () => {
      const store = memStore({ [`${APP}/${contentHash}`]: storedFramed });
      const framed = await serveBlob(
        { appName: APP, fluxID: OWNER, locator: 'b'.repeat(64) },
        { benchmark: makeBenchmark(), store },
      );
      expect(framed).to.equal(null);
    });

    it('returns null when the app has no stored artifacts', async () => {
      const framed = await serveBlob(
        { appName: APP, fluxID: OWNER, locator: 'a'.repeat(64) },
        { benchmark: makeBenchmark(), store: memStore() },
      );
      expect(framed).to.equal(null);
    });
  });

  describe('fetchBlobFromPeer', () => {
    it('returns the framed bytes on success', async () => {
      const http = { get: async () => ({ data: Buffer.from('framed-cipher') }) };
      const out = await fetchBlobFromPeer('1.2.3.4:16127', APP, 'loc', { http });
      expect(out.toString()).to.equal('framed-cipher');
    });

    it('returns null on any error', async () => {
      const http = { get: async () => { throw new Error('refused'); } };
      expect(await fetchBlobFromPeer('1.2.3.4:16127', APP, 'loc', { http })).to.equal(null);
    });

    it('bounds the response size to the framed-blob ceiling', async () => {
      let opts;
      const http = { get: async (url, options) => { opts = options; return { data: Buffer.from('x') }; } };
      await fetchBlobFromPeer('1.2.3.4:16127', APP, 'loc', { http });
      expect(opts.maxContentLength).to.equal(await maxFramedBlobBytes());
    });
  });

  describe('deriveLocator', () => {
    const { deriveLocator } = contentBlobService;

    it('unwraps the benchmark blobLocator reply for the given content hash', async () => {
      const calls = [];
      const benchmark = makeBenchmark({
        blobLocator: async (ref) => { calls.push(ref); return ok({ locator: 'L'.repeat(64) }); },
      });
      const contentHash = hashOf(Buffer.from('locate me'));
      const locator = await deriveLocator(benchmark, { appName: APP, fluxID: OWNER, contentHash });
      expect(locator).to.equal('L'.repeat(64));
      expect(calls).to.deep.equal([{ appName: APP, fluxID: OWNER, contentHash }]);
    });

    it('throws when the benchmark channel rejects the request', async () => {
      const benchmark = makeBenchmark({ blobLocator: async () => ({ status: 'error' }) });
      await expectReject(
        deriveLocator(benchmark, { appName: APP, fluxID: OWNER, contentHash: hashOf(Buffer.from('x')) }),
        /benchmark channel/,
      );
    });
  });
});
