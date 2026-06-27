const { expect } = require('chai');
const sinon = require('sinon');
const crypto = require('node:crypto');
const proxyquire = require('proxyquire').noCallThru();

const hashOf = (buf) => `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;
// executeCall shape the benchmark channel returns: { status: 'success', data: { status: 'ok', <field> } }
const ok = (obj) => ({ status: 'success', data: { status: 'ok', ...obj } });
const KEY = crypto.randomBytes(32);
const NOW_MS = 1_700_000_000_000;
const now = () => NOW_MS;
const freshTs = String(NOW_MS / 1000);

// flux-spec is ESM-only; FluxOS reaches it through the async getSpec() loader.
// Stub it (the FluxOS test convention) with simple deterministic fakes — the real
// canonicalization/validation is exercised in flux-spec's own suite.
function defaultSpecStub() {
  return {
    canonicalContentManifest: (m) => { const { ownerSignature, ...rest } = m; return JSON.stringify(rest); },
    assertValidContentManifest: sinon.stub().callsFake((m) => m),
  };
}

function load(specStub = defaultSpecStub()) {
  const service = proxyquire('../../ZelBack/src/services/appLifecycle/contentSlotService', {
    '../utils/specLibs': { getSpec: sinon.stub().resolves(specStub) },
  });
  return { service, specStub };
}

function makeBenchmark(overrides = {}) {
  return {
    blobLocator: async () => ok({ locator: 'a'.repeat(64) }),
    contentKey: async () => ok({ key: KEY.toString('base64') }),
    signBlobUpload: async () => ok({ signature: 'arcane-sig-b64' }),
    ...overrides,
  };
}

function makeUploader() {
  const calls = [];
  return { calls, uploadBlob: async (framed, headers) => { calls.push({ framed, headers }); } };
}

// A deterministic, reversible stand-in for the app-secret seal/unseal provider.
function fakeProvider() {
  return {
    encrypt: async (buf) => ({ algorithm: 'fake', ciphertext: buf.toString('base64'), nonce: 'n', tag: 't' }),
    decrypt: async (env) => Buffer.from(env.ciphertext, 'base64'),
  };
}

function specWithSlots(names) {
  const comp = { persistentStorage: { getMountsWithContentSlot: () => names.map((n) => ({ contentSlot: n })) } };
  return { name: 'app', owner: '1id', componentEntries: () => [['web', comp]] };
}

const CFG = Buffer.from('slot content');
const CFG_HASH = hashOf(CFG);

function manifest(overrides = {}) {
  return {
    appName: 'app',
    version: 2,
    slots: { 'app-config': { hash: CFG_HASH } },
    rollout: { strategy: 'immediate' },
    timestamp: NOW_MS / 1000,
    ownerSignature: 'owner-sig',
    ...overrides,
  };
}

function fakeDb(canned = {}) {
  const calls = [];
  return {
    calls,
    collection() {
      return {
        async updateOne(query, update, opts) {
          calls.push({ op: 'updateOne', query, update, opts });
          if (canned.updateThrows) throw canned.updateThrows;
          return { acknowledged: true };
        },
        async findOne(query) {
          calls.push({ op: 'findOne', query });
          return canned.findOne ?? null;
        },
      };
    },
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
  describe('specSlotNames', () => {
    it('collects every declared contentSlot name', () => {
      const { service } = load();
      const names = service.specSlotNames(specWithSlots(['a', 'b']));
      expect([...names]).to.have.members(['a', 'b']);
    });
  });

  describe('verifyManifest', () => {
    it('accepts a valid, owner-signed manifest whose slots are all declared', async () => {
      const { service, specStub } = load();
      await service.verifyManifest(manifest(), { owner: '1id', spec: specWithSlots(['app-config']) }, { verify: () => true });
      sinon.assert.calledOnce(specStub.assertValidContentManifest);
    });

    it('rejects an invalid owner signature', async () => {
      const { service } = load();
      await expectReject(
        service.verifyManifest(manifest(), { owner: '1id', spec: specWithSlots(['app-config']) }, { verify: () => false }),
        /invalid owner signature/,
      );
    });

    it('rejects a manifest whose appName does not match the spec', async () => {
      const { service } = load();
      await expectReject(
        service.verifyManifest(manifest({ appName: 'other' }), { owner: '1id', spec: specWithSlots(['app-config']) }, { verify: () => true }),
        /does not match the spec/,
      );
    });

    it('rejects a slot the spec does not declare', async () => {
      const { service } = load();
      await expectReject(
        service.verifyManifest(manifest(), { owner: '1id', spec: specWithSlots(['something-else']) }, { verify: () => true }),
        /not declared in the spec/,
      );
    });
  });

  describe('seal/openManifestSlots', () => {
    it('round-trips an encrypted app\'s slots through the app secret', async () => {
      const { service } = load();
      const provider = fakeProvider();
      const sealed = await service.sealManifestSlots(manifest(), { owner: '1id', encrypted: true }, { provider });
      expect(sealed.slots).to.have.property('sealed');
      expect(sealed.slots['app-config']).to.equal(undefined);
      const opened = await service.openManifestSlots(sealed, { owner: '1id', encrypted: true }, { provider });
      expect(opened.slots).to.deep.equal(manifest().slots);
    });

    it('leaves a plaintext app\'s slots untouched', async () => {
      const { service } = load();
      const out = await service.sealManifestSlots(manifest(), { owner: '1id', encrypted: false }, {});
      expect(out.slots).to.deep.equal(manifest().slots);
    });
  });

  describe('processManifestSubmission', () => {
    function baseInput(overrides = {}) {
      return {
        manifest: manifest(),
        spec: specWithSlots(['app-config']),
        owner: '1id',
        encrypted: true,
        blobs: new Map([[CFG_HASH, CFG]]),
        ownerSigs: new Map([[CFG_HASH, { sig: 'osig', timestamp: freshTs }]]),
        ...overrides,
      };
    }
    function baseDeps(overrides = {}) {
      return {
        db: {}, getLatest: async () => null, uploader: makeUploader(), benchmark: makeBenchmark(), now, verify: () => true, provider: fakeProvider(),
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

    it('rejects a manifest no newer than the stored one', async () => {
      const { service } = load();
      await expectReject(
        service.processManifestSubmission(baseInput(), baseDeps({ getLatest: async () => ({ version: 5 }) })),
        /not newer than stored/,
      );
    });

    it('rejects a declared slot with no blob part', async () => {
      const { service } = load();
      await expectReject(
        service.processManifestSubmission(baseInput({ blobs: new Map() }), baseDeps()),
        /missing blob part/,
      );
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

  describe('storeManifest / getLatestManifest', () => {
    it('a verified store advances a higher version OR promotes a same-version quarantined row', async () => {
      const { service } = load();
      const db = fakeDb();
      const stored = await service.storeManifest(db, manifest()); // default confirmed:true
      expect(stored).to.equal(true);
      const c = db.calls[0];
      expect(c.op).to.equal('updateOne');
      expect(c.query).to.deep.equal({ appName: 'app', $or: [{ version: { $lt: 2 } }, { version: 2, confirmed: false }] });
      expect(c.opts.upsert).to.equal(true);
      expect(c.update.$set.confirmed).to.equal(true);
      expect(c.update.$set.version).to.equal(2);
      expect(c.update.$unset).to.deep.equal({ expireAt: '' });
    });

    it('quarantines an unverified manifest with a TTL (confirmed:false)', async () => {
      const { service } = load();
      const db = fakeDb();
      const stored = await service.storeManifest(db, manifest(), { confirmed: false, now: 1000 });
      expect(stored).to.equal(true);
      const c = db.calls[0];
      expect(c.query).to.deep.equal({ appName: 'app', version: { $lt: 2 } });
      expect(c.update.$set.confirmed).to.equal(false);
      expect(c.update.$set.expireAt).to.be.instanceOf(Date);
    });

    it('maps a unique-index collision (stale version) to false', async () => {
      const { service } = load();
      const err = new Error('E11000 duplicate key');
      err.code = 11000;
      const stored = await service.storeManifest(fakeDb({ updateThrows: err }), manifest());
      expect(stored).to.equal(false);
    });

    it('reads the latest manifest by appName', async () => {
      const { service } = load();
      const db = fakeDb({ findOne: { appName: 'app', version: 2 } });
      const out = await service.getLatestManifest(db, 'app');
      expect(out.version).to.equal(2);
      expect(db.calls[0].query).to.deep.equal({ appName: 'app' });
    });
  });

  function msg(gossipManifest = manifest()) {
    return { data: { type: 'fluxappcontentmanifest', appName: gossipManifest.appName, manifest: gossipManifest } };
  }
  function recvDeps(overrides = {}) {
    return {
      db: fakeDb(),
      getApp: async () => ({ owner: '1id', isEncrypted: false, spec: specWithSlots(['app-config']) }),
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
      expect(deps.schedule.firstCall.args[0].appName).to.equal('app');
    });

    it('stores and rebroadcasts but does not schedule when the app is not installed here', async () => {
      const { service } = load();
      const deps = recvDeps({ isInstalledHere: async () => null });
      await service.receiveManifest(msg(), deps);
      sinon.assert.calledOnce(deps.rebroadcast);
      sinon.assert.notCalled(deps.schedule);
    });

    it('drops a manifest no newer than the stored version', async () => {
      const { service } = load();
      const deps = recvDeps({ db: fakeDb({ findOne: { appName: 'app', version: 5 } }) });
      await service.receiveManifest(msg(manifest({ version: 2 })), deps);
      sinon.assert.notCalled(deps.rebroadcast);
      sinon.assert.notCalled(deps.schedule);
    });

    it('quarantines a manifest whose spec has not yet arrived (manifest-before-spec)', async () => {
      const { service } = load();
      const db = fakeDb();
      const deps = recvDeps({ db, getApp: async () => null });
      await service.receiveManifest(msg(), deps);
      sinon.assert.notCalled(deps.rebroadcast); // not yet verified -> not promoted/rebroadcast
      const quarantine = db.calls.find((x) => x.op === 'updateOne');
      expect(quarantine.update.$set.confirmed).to.equal(false); // held quarantined for the spec
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

  describe('promoteQuarantinedManifest (spec-confirm hook for non-running nodes)', () => {
    const info = { owner: '1id', isEncrypted: true, spec: specWithSlots(['app-config']) };

    it('promotes a quarantined manifest once the spec is available', async () => {
      const { service } = load();
      const provider = fakeProvider();
      const store = sinon.stub().resolves(true);
      const sealed = await service.sealManifestSlots(manifest(), { owner: '1id', encrypted: true }, { provider });
      const ok = await service.promoteQuarantinedManifest('app', {
        db: fakeDb(),
        getApp: async () => info,
        getLatest: async () => ({ manifest: sealed, version: 2, confirmed: false }),
        store,
        provider,
        verify: () => true,
      });
      expect(ok).to.equal(true);
      sinon.assert.calledWith(store, sinon.match.any, sealed, { confirmed: true });
    });

    it('is a no-op when nothing is quarantined (already confirmed or absent)', async () => {
      const { service } = load();
      const store = sinon.spy();
      const ok = await service.promoteQuarantinedManifest('app', {
        db: fakeDb(),
        getLatest: async () => ({ manifest: {}, version: 2, confirmed: true }),
        store,
      });
      expect(ok).to.equal(false);
      sinon.assert.notCalled(store);
    });

    it('is a no-op when the spec is still absent', async () => {
      const { service } = load();
      const store = sinon.spy();
      const ok = await service.promoteQuarantinedManifest('app', {
        db: fakeDb(),
        getApp: async () => null,
        getLatest: async () => ({ manifest: {}, version: 2, confirmed: false }),
        store,
      });
      expect(ok).to.equal(false);
      sinon.assert.notCalled(store);
    });

    it('drops a quarantined manifest that fails verification (a squatter\'s)', async () => {
      const { service } = load();
      const provider = fakeProvider();
      const drop = sinon.spy();
      const store = sinon.spy();
      const sealed = await service.sealManifestSlots(manifest(), { owner: '1id', encrypted: true }, { provider });
      const ok = await service.promoteQuarantinedManifest('app', {
        db: fakeDb(),
        getApp: async () => info,
        getLatest: async () => ({ manifest: sealed, version: 2, confirmed: false }),
        drop,
        store,
        provider,
        verify: () => false,
      });
      expect(ok).to.equal(false);
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
        appName: 'app',
        version: 2,
        timestamp: NOW_MS / 1000,
        content: { algorithm: 'x', encapsulatedKey: 'k', nonce: 'n', ciphertext: 'c' },
        ownerSigs: { [CFG_HASH]: { sig: 'osig', timestamp: freshTs } },
        ...overrides,
      };
    }
    function subDeps(overrides = {}) {
      return {
        db: fakeDb(),
        getApp: async () => ({ owner: '1id', isEncrypted: true, spec: specWithSlots(['app-config']) }),
        isInstalledHere: async () => null,
        openEnvelope: async () => sealedPayload(),
        broadcast: sinon.spy(),
        schedule: sinon.spy(),
        uploader: makeUploader(),
        benchmark: makeBenchmark(),
        now,
        verify: () => true,
        provider: fakeProvider(),
        ...overrides,
      };
    }

    it('transport-opens, processes, stores, and gossips the sealed manifest', async () => {
      const { service } = load();
      const deps = subDeps();
      const out = await service.submitContentUpdate(subBody(), deps);
      expect(out.slots).to.have.property('sealed'); // at-rest sealed for gossip
      sinon.assert.calledOnce(deps.broadcast);
      expect(deps.broadcast.firstCall.args[0]).to.include({ type: 'fluxappcontentmanifest', appName: 'app' });
      expect(deps.uploader.calls[0].headers.source).to.equal('slot');
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
      const { service } = load();
      const deps = subDeps({ isInstalledHere: async () => ({ name: 'app' }) });
      await service.submitContentUpdate(subBody(), deps);
      sinon.assert.calledOnce(deps.schedule);
      expect(deps.schedule.firstCall.args[0].appName).to.equal('app'); // plaintext manifest
    });

    it('PUTs the manifest to the FluxDrive backstop with the owner PUT-sig from the sealed payload', async () => {
      const { service } = load();
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
      expect(ctx).to.include({ appName: 'app', version: 2, manifestPutSig: 'owner-put-sig' });
      expect(gossipManifest.slots).to.have.property('sealed'); // the gossip-form (sealed) manifest
    });
  });

  describe('backstopManifest', () => {
    it('mints the arcane sig and PUTs the manifest with the owner PUT-sig', async () => {
      const { service } = load();
      const put = sinon.spy();
      const sign = sinon.stub().resolves('arcane-sig');
      const okPut = await service.backstopManifest(
        { appName: 'app', version: 2, slots: { sealed: {} } },
        { appName: 'app', version: 2, timestamp: 1_700_000_000, manifestPutSig: 'owner-sig' },
        { put, sign },
      );
      expect(okPut).to.equal(true);
      sinon.assert.calledOnce(put);
      const [appName, body] = put.firstCall.args;
      expect(appName).to.equal('app');
      expect(body).to.include({ version: 2, ownerSig: 'owner-sig', arcaneSig: 'arcane-sig' });
    });

    it('skips the PUT when the frontend supplied no operational owner sig', async () => {
      const { service } = load();
      const put = sinon.spy();
      const okPut = await service.backstopManifest(
        {}, { appName: 'app', version: 2, timestamp: 1, manifestPutSig: undefined }, { put },
      );
      expect(okPut).to.equal(false);
      sinon.assert.notCalled(put);
    });

    it('is best-effort: a failed PUT returns false and never throws', async () => {
      const { service } = load();
      const put = sinon.stub().rejects(new Error('fluxdrive down'));
      const sign = sinon.stub().resolves('arcane-sig');
      const okPut = await service.backstopManifest(
        {}, { appName: 'app', version: 2, timestamp: 1, manifestPutSig: 'sig' }, { put, sign },
      );
      expect(okPut).to.equal(false);
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
    const manifestSlots = { appName: 'app', slots: { cfg: { hash: HCFG }, data: { hash: HDATA } } };
    const ctx = { appName: 'app', owner: '1id', peers: [] };
    function deployment(mounts) {
      return { componentEntries: () => [['web', { identifier: 'web_app', contentSlotMounts: () => mounts }]] };
    }
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
      const dep = deployment([
        { slot: 'cfg', source: '/dat/app/cfg', atomic: false, onUpdate: { action: 'signal', signal: 'SIGHUP' } },
        { slot: 'data', source: '/io.runonflux/data', atomic: true, onUpdate: null },
      ]);
      await service.applyManifest(dep, manifestSlots, ctx, deps);
      sinon.assert.calledWith(deps.writeFile, '/dat/app/cfg', Buffer.from(`bytes:${HCFG}`));
      sinon.assert.calledWith(deps.writeFile, '/io.runonflux/data.flux-content-tmp', Buffer.from(`bytes:${HDATA}`));
      sinon.assert.calledWith(deps.rename, '/io.runonflux/data.flux-content-tmp', '/io.runonflux/data');
      sinon.assert.calledOnceWithExactly(deps.signal, 'web_app', 'SIGHUP');
      sinon.assert.notCalled(deps.restart);
    });

    it('applies nothing when any slot fails to stage (stage-all-then-apply)', async () => {
      const { service } = load();
      const deps = applyDeps({ resolve: async ({ contentHash }) => { if (contentHash === HDATA) throw new Error('no source'); return Buffer.from('x'); } });
      const dep = deployment([
        { slot: 'cfg', source: '/dat/app/cfg', atomic: false, onUpdate: { action: 'restart' } },
        { slot: 'data', source: '/io.runonflux/data', atomic: true, onUpdate: null },
      ]);
      await expectReject(service.applyManifest(dep, manifestSlots, ctx, deps), /no source/);
      sinon.assert.notCalled(deps.writeFile);
      sinon.assert.notCalled(deps.restart);
    });

    it('restart subsumes signal within a component', async () => {
      const { service } = load();
      const deps = applyDeps();
      const dep = deployment([
        { slot: 'cfg', source: '/dat/app/cfg', atomic: false, onUpdate: { action: 'signal', signal: 'SIGHUP' } },
        { slot: 'data', source: '/io.runonflux/data', atomic: true, onUpdate: { action: 'restart' } },
      ]);
      await service.applyManifest(dep, manifestSlots, ctx, deps);
      sinon.assert.calledOnceWithExactly(deps.restart, 'web_app');
      sinon.assert.notCalled(deps.signal);
    });

    it('a failed reaction never throws (content stays on disk)', async () => {
      const { service } = load();
      const deps = applyDeps({ restart: sinon.stub().rejects(new Error('daemon busy')) });
      const dep = deployment([{ slot: 'cfg', source: '/dat/app/cfg', atomic: false, onUpdate: { action: 'restart' } }]);
      await service.applyManifest(dep, { slots: { cfg: { hash: HCFG } } }, ctx, deps);
      sinon.assert.calledWith(deps.writeFile, '/dat/app/cfg', Buffer.from(`bytes:${HCFG}`));
    });
  });

  describe('scheduleContentApplication', () => {
    it('applies via the installed deployment and the app\'s running peers', async () => {
      const { service } = load();
      const apply = sinon.spy();
      const dep = { componentEntries: () => [] };
      await service.scheduleContentApplication(
        { appName: 'app', slots: {} }, { owner: '1id' },
        { getDeployment: async () => dep, getPeers: async () => ['1.2.3.4:16127'], apply },
      );
      sinon.assert.calledOnce(apply);
      expect(apply.firstCall.args[0]).to.equal(dep);
      expect(apply.firstCall.args[2]).to.deep.equal({ appName: 'app', owner: '1id', peers: ['1.2.3.4:16127'] });
    });

    it('does nothing when the app is not installed here', async () => {
      const { service } = load();
      const apply = sinon.spy();
      await service.scheduleContentApplication(
        { appName: 'app', slots: {} }, { owner: '1id' },
        { getDeployment: async () => null, apply },
      );
      sinon.assert.notCalled(apply);
    });
  });

  describe('fetchManifestFromPeers', () => {
    const ctx = { owner: '1id', encrypted: false, spec: specWithSlots(['app-config']) };

    it('adopts the highest valid version and rejects an invalid candidate', async () => {
      const { service } = load();
      const byPeer = { p1: manifest({ version: 2 }), p2: manifest({ version: 3 }), p3: manifest({ version: 5 }) };
      const fetch = async (peer) => byPeer[peer];
      // canonical excludes ownerSignature; reject the version-5 candidate (e.g. forged)
      const verify = (signed) => !signed.includes('"version":5');
      const best = await service.fetchManifestFromPeers('app', ['p1', 'p2', 'p3'], ctx, { fetch, verify });
      expect(best.gossip.version).to.equal(3);
    });

    it('returns null when no peer yields a valid manifest', async () => {
      const { service } = load();
      const best = await service.fetchManifestFromPeers('app', ['p1'], ctx, { fetch: async () => null });
      expect(best).to.equal(null);
    });

    it('only queries up to maxPeers', async () => {
      const { service } = load();
      const seen = [];
      const fetch = async (peer) => { seen.push(peer); return null; };
      await service.fetchManifestFromPeers('app', ['p1', 'p2', 'p3', 'p4'], ctx, { fetch, maxPeers: 2 });
      expect(seen).to.deep.equal(['p1', 'p2']);
    });
  });

  describe('provisionContentSlots', () => {
    function deployment(slots = ['app-config']) {
      const comp = {
        hasContentSlots: () => slots.length > 0,
        contentSlotMounts: () => slots.map((s) => ({ slot: s, source: `/dat/${s}`, atomic: false, onUpdate: null })),
      };
      return { componentEntries: () => [['web', comp]] };
    }
    const info = { owner: '1id', isEncrypted: true, spec: specWithSlots(['app-config']) };

    it('stages from this node\'s stored manifest when present (no catch-up)', async () => {
      const { service } = load();
      const provider = fakeProvider();
      const stageApply = sinon.spy();
      const fetchPeers = sinon.spy();
      const sealed = await service.sealManifestSlots(manifest(), { owner: '1id', encrypted: true }, { provider });

      await service.provisionContentSlots(deployment(), { appName: 'app', peers: ['p1'] }, {
        db: fakeDb(),
        getApp: async () => info,
        getLatest: async () => ({ manifest: sealed, version: 2 }),
        fetchPeers,
        stageApply,
        provider,
      });

      sinon.assert.notCalled(fetchPeers);
      sinon.assert.calledOnce(stageApply);
      expect(stageApply.firstCall.args[1].slots).to.deep.equal(manifest().slots);
      expect(stageApply.firstCall.args[2]).to.deep.equal({ appName: 'app', owner: '1id', peers: ['p1'] });
    });

    it('verifies and promotes a locally-quarantined manifest at install (no catch-up round-trip)', async () => {
      const { service } = load();
      const provider = fakeProvider();
      const stageApply = sinon.spy();
      const fetchPeers = sinon.spy();
      const store = sinon.spy();
      const sealed = await service.sealManifestSlots(manifest(), { owner: '1id', encrypted: true }, { provider });

      await service.provisionContentSlots(deployment(), { appName: 'app', peers: ['p1'] }, {
        db: fakeDb(),
        getApp: async () => info,
        getLatest: async () => ({ manifest: sealed, version: 2, confirmed: false }), // quarantined
        fetchPeers,
        store,
        stageApply,
        provider,
        verify: () => true,
      });

      sinon.assert.notCalled(fetchPeers); // promoted locally — no catch-up
      sinon.assert.calledWith(store, sinon.match.any, sealed, { confirmed: true }); // promoted in place
      sinon.assert.calledOnce(stageApply);
    });

    it('falls through to catch-up when a quarantined manifest fails verification (a squatter\'s)', async () => {
      const { service } = load();
      const provider = fakeProvider();
      const stageApply = sinon.spy();
      const fetched = { gossip: manifest(), plaintext: manifest() };
      const sealed = await service.sealManifestSlots(manifest(), { owner: '1id', encrypted: true }, { provider });

      await service.provisionContentSlots(deployment(), { appName: 'app', peers: ['p1'] }, {
        db: fakeDb(),
        getApp: async () => info,
        getLatest: async () => ({ manifest: sealed, version: 2, confirmed: false }),
        fetchPeers: async () => fetched,
        store: sinon.spy(),
        stageApply,
        provider,
        verify: () => false, // quarantined manifest does not verify -> catch up instead
      });

      sinon.assert.calledOnce(stageApply);
      expect(stageApply.firstCall.args[1]).to.equal(fetched.plaintext); // used the caught-up manifest
    });

    it('catches up from a running peer when nothing is stored, then stores + stages', async () => {
      const { service } = load();
      const store = sinon.spy();
      const stageApply = sinon.spy();
      const fetched = { gossip: manifest(), plaintext: manifest() };

      await service.provisionContentSlots(deployment(), { appName: 'app', peers: ['p1'] }, {
        db: fakeDb(),
        getApp: async () => info,
        getLatest: async () => null,
        fetchPeers: async () => fetched,
        store,
        stageApply,
      });

      sinon.assert.calledWith(store, sinon.match.any, fetched.gossip);
      sinon.assert.calledOnce(stageApply);
      expect(stageApply.firstCall.args[1]).to.equal(fetched.plaintext);
    });

    it('holds the install (throws) when no manifest is stored and no peer yields one', async () => {
      const { service } = load();
      await expectReject(
        service.provisionContentSlots(deployment(), { appName: 'app', peers: [] }, {
          db: fakeDb(),
          getApp: async () => info,
          getLatest: async () => null,
          fetchPeers: async () => null,
          stageApply: sinon.spy(),
        }),
        /no manifest available/,
      );
    });

    it('is a no-op for an app that declares no slots', async () => {
      const { service } = load();
      const stageApply = sinon.spy();
      const getApp = sinon.spy();
      await service.provisionContentSlots(deployment([]), { appName: 'app' }, { getApp, stageApply });
      sinon.assert.notCalled(stageApply);
      sinon.assert.notCalled(getApp);
    });
  });
});
