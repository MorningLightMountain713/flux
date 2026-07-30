const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('policyStore tests', () => {
  let store;
  let serviceHelperStub;
  let repositoryStub;
  let artifactStub;
  let fsStub;
  let logStub;

  const BASE_URL = 'https://policy.example/documents';

  // Every document is loaded and refreshed by the same code path, so the layer tests use
  // one of them; the per-document differences are the filename and the validator, which
  // the registry test covers.
  const NAME = 'blockedRepositories';
  const FILE = 'blockedrepositories.json';

  function loadStore() {
    return proxyquire('../../ZelBack/src/services/policy/policyStore', {
      config: { policy: { baseUrl: BASE_URL } },
      fs: { promises: fsStub },
      '../../lib/log': logStub,
      '../serviceHelper': serviceHelperStub,
      '../appDatabase/policyDocumentRepository': repositoryStub,
      '../appDatabase/policyArtifactRepository': artifactStub,
    });
  }

  // Seeds resolve to real filenames, so the stub is keyed on the path suffix rather than
  // the absolute path, which depends on where the checkout lives.
  function seedFile(file, contents) {
    fsStub.readFile
      .withArgs(sinon.match((p) => typeof p === 'string' && p.endsWith(file)), 'utf8')
      .resolves(JSON.stringify(contents));
  }

  beforeEach(() => {
    serviceHelperStub = { axiosGet: sinon.stub().rejects(new Error('no network')) };
    artifactStub = {
      getArtifactRecord: sinon.stub().resolves(null),
      readArtifactBytes: sinon.stub().resolves(null),
      writeArtifactBytes: sinon.stub().resolves(true),
      sweepOrphanedArtifacts: sinon.stub().resolves(0),
    };
    repositoryStub = {
      getPolicyDocument: sinon.stub().resolves(null),
      setPolicyDocument: sinon.stub().resolves(true),
    };
    fsStub = { readFile: sinon.stub().rejects(new Error('ENOENT')) };
    logStub = {
      info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(),
    };
    store = loadStore();
  });

  afterEach(() => {
    store.reset();
    sinon.restore();
  });

  describe('the null contract', () => {
    it('returns null for a document no layer produced', () => {
      expect(store.get(NAME)).to.equal(null);
    });

    it('distinguishes an obtained-but-empty document from an absent one', async () => {
      serviceHelperStub.axiosGet.resolves({ data: [] });

      await store.startSync();

      expect(store.get(NAME)).to.deep.equal([]);
      expect(store.get(NAME)).to.not.equal(null);
    });
  });

  describe('layer precedence', () => {
    it('prefers the cached copy over the seed', async () => {
      repositoryStub.getPolicyDocument
        .withArgs(NAME).resolves({ payload: ['from-cache'], fetchedAt: 1, etag: null });
      seedFile(FILE, ['from-seed']);

      await store.startSync();

      expect(store.get(NAME)).to.deep.equal(['from-cache']);
    });

    it('falls back to the seed when there is no cached copy', async () => {
      seedFile(FILE, ['from-seed']);

      await store.startSync();

      expect(store.get(NAME)).to.deep.equal(['from-seed']);
    });

    it('ignores a cached copy that fails validation and uses the seed', async () => {
      repositoryStub.getPolicyDocument
        .withArgs(NAME).resolves({ payload: { notAnArray: true }, fetchedAt: 1, etag: null });
      seedFile(FILE, ['from-seed']);

      await store.startSync();

      expect(store.get(NAME)).to.deep.equal(['from-seed']);
      sinon.assert.called(logStub.error);
    });

    it('ignores a seed that fails validation', async () => {
      seedFile(FILE, { notAnArray: true });

      await store.startSync();

      expect(store.get(NAME)).to.equal(null);
    });

    it('a successful fetch replaces whatever the restore produced', async () => {
      seedFile(FILE, ['from-seed']);
      serviceHelperStub.axiosGet.resolves({ data: ['from-fetch'] });

      await store.startSync();

      expect(store.get(NAME)).to.deep.equal(['from-fetch']);
    });
  });

  describe('refresh', () => {
    it('persists a fetched document, with its etag', async () => {
      serviceHelperStub.axiosGet.resolves({ data: ['blocked'], headers: { etag: 'W/"abc"' } });

      await store.refresh(NAME);

      sinon.assert.calledWith(repositoryStub.setPolicyDocument, NAME, ['blocked'], 'W/"abc"');
    });

    it('reads each document from its own path under the configured base', async () => {
      serviceHelperStub.axiosGet.resolves({ data: [] });

      await store.refresh(NAME);

      sinon.assert.calledWith(serviceHelperStub.axiosGet, `${BASE_URL}/${FILE}`);
    });

    it('uses a bounded request timeout so boot is never stuck on it', async () => {
      serviceHelperStub.axiosGet.resolves({ data: [] });

      await store.refresh(NAME);

      const options = serviceHelperStub.axiosGet.firstCall.args[1];
      expect(options.timeout).to.be.a('number').and.to.be.above(0);
    });

    it('keeps the current value when the fetch fails', async () => {
      seedFile(FILE, ['from-seed']);
      await store.startSync();

      serviceHelperStub.axiosGet.rejects(new Error('502'));
      const replaced = await store.refresh(NAME);

      expect(replaced).to.be.false;
      expect(store.get(NAME)).to.deep.equal(['from-seed']);
    });

    it('keeps the current value when the fetch returns an invalid payload', async () => {
      seedFile(FILE, ['from-seed']);
      await store.startSync();

      serviceHelperStub.axiosGet.resolves({ data: { notAnArray: true } });
      const replaced = await store.refresh(NAME);

      expect(replaced).to.be.false;
      expect(store.get(NAME)).to.deep.equal(['from-seed']);
      sinon.assert.called(logStub.error);
    });

    it('does not persist a payload it rejected', async () => {
      serviceHelperStub.axiosGet.resolves({ data: 'not a list' });

      await store.refresh(NAME);

      sinon.assert.notCalled(repositoryStub.setPolicyDocument);
    });

    it('keeps the fetched value live even if persisting it fails', async () => {
      // The cache is an optimisation; a node with an unwritable DB must still enforce.
      serviceHelperStub.axiosGet.resolves({ data: ['blocked'] });
      repositoryStub.setPolicyDocument.rejects(new Error('mongo down'));

      const replaced = await store.refresh(NAME);

      expect(replaced).to.be.true;
      expect(store.get(NAME)).to.deep.equal(['blocked']);
    });
  });

  describe('onChange', () => {
    it('fires after a refresh that replaced the payload', async () => {
      const handler = sinon.stub();
      store.onChange(NAME, handler);
      serviceHelperStub.axiosGet.resolves({ data: ['blocked'] });

      await store.startSync();

      sinon.assert.called(handler);
    });

    it('does not fire when the fetch failed', async () => {
      const handler = sinon.stub();
      store.onChange(NAME, handler);
      seedFile(FILE, ['from-seed']);

      await store.startSync();

      sinon.assert.notCalled(handler);
    });

    it('isolates a throwing handler from the others', async () => {
      const good = sinon.stub();
      store.onChange(NAME, () => { throw new Error('handler boom'); });
      store.onChange(NAME, good);
      serviceHelperStub.axiosGet.resolves({ data: ['blocked'] });

      await store.startSync();

      sinon.assert.called(good);
      sinon.assert.called(logStub.error);
    });
  });

  describe('the enterpriseNodes validator', () => {
    it('accepts a pubkey -> owners map', async () => {
      serviceHelperStub.axiosGet.resolves({ data: { pubkey1: ['owner1', 'owner2'] } });

      await store.refresh('enterpriseNodes');

      expect(store.get('enterpriseNodes')).to.deep.equal({ pubkey1: ['owner1', 'owner2'] });
    });

    it('rejects the whole map when any value is not an array of strings', async () => {
      // Rejecting wholesale rather than coercing: one malformed value would otherwise
      // make a node host nothing and uninstall everything.
      serviceHelperStub.axiosGet.resolves({ data: { pubkey1: ['owner1'], pubkey2: 'owner2' } });

      await store.refresh('enterpriseNodes');

      expect(store.get('enterpriseNodes')).to.equal(null);
    });

    it('rejects an array', async () => {
      serviceHelperStub.axiosGet.resolves({ data: ['owner1'] });

      await store.refresh('enterpriseNodes');

      expect(store.get('enterpriseNodes')).to.equal(null);
    });
  });

  describe('startSync', () => {
    it('loads every registered document', async () => {
      serviceHelperStub.axiosGet.resolves({ data: [] });
      repositoryStub.getPolicyDocument
        .withArgs('enterpriseNodes').resolves({ payload: {}, fetchedAt: 1, etag: null });

      await store.startSync();

      // Artifacts are excluded on purpose: they are never retained here, so get() reporting
      // null for one is the contract rather than a load failure.
      Object.entries(store.DOCUMENTS)
        .filter(([, entry]) => entry.kind === 'document')
        .forEach(([name]) => {
          expect(store.get(name), name).to.not.equal(null);
        });
    });

    it('is idempotent', async () => {
      serviceHelperStub.axiosGet.resolves({ data: [] });

      await store.startSync();
      const callsAfterFirst = serviceHelperStub.axiosGet.callCount;
      await store.startSync();

      expect(serviceHelperStub.axiosGet.callCount).to.equal(callsAfterFirst);
    });

    it('schedules a refresh per document and stopSync clears them', async () => {
      const clock = sinon.useFakeTimers();
      try {
        serviceHelperStub.axiosGet.resolves({ data: [] });
        await store.startSync();
        const callsAfterStart = serviceHelperStub.axiosGet.callCount;

        // 6h advances the two documents on that interval, not the 12h tampering blocklist.
        await clock.tickAsync(6 * 60 * 60 * 1000 + 1000);
        expect(serviceHelperStub.axiosGet.callCount).to.equal(callsAfterStart + 2);

        store.stopSync();
        const callsAfterStop = serviceHelperStub.axiosGet.callCount;
        await clock.tickAsync(24 * 60 * 60 * 1000);
        expect(serviceHelperStub.axiosGet.callCount).to.equal(callsAfterStop);
      } finally {
        clock.restore();
      }
    });
  });

  describe('conditional requests', () => {
    it('sends no If-None-Match before it holds an etag', async () => {
      serviceHelperStub.axiosGet.resolves({ data: [] });

      await store.refresh(NAME);

      expect(serviceHelperStub.axiosGet.firstCall.args[1].headers).to.deep.equal({});
    });

    it('sends the etag it holds on the next fetch', async () => {
      serviceHelperStub.axiosGet.resolves({ data: [], headers: { etag: 'W/"abc"' } });
      await store.refresh(NAME);

      await store.refresh(NAME);

      expect(serviceHelperStub.axiosGet.secondCall.args[1].headers)
        .to.deep.equal({ 'If-None-Match': 'W/"abc"' });
    });

    it('restores the etag from the cache, so a restart does not re-download', async () => {
      repositoryStub.getPolicyDocument
        .withArgs(NAME).resolves({ payload: ['cached'], fetchedAt: 1, etag: 'W/"from-cache"' });

      await store.startSync();

      const call = serviceHelperStub.axiosGet.getCalls()
        .find((c) => c.args[0].endsWith(FILE));
      expect(call.args[1].headers).to.deep.equal({ 'If-None-Match': 'W/"from-cache"' });
    });

    it('treats 304 as unchanged: nothing replaced, nothing rewritten', async () => {
      seedFile(FILE, ['from-seed']);
      await store.startSync();

      serviceHelperStub.axiosGet.resolves({ status: 304, headers: {} });
      repositoryStub.setPolicyDocument.resetHistory();
      const replaced = await store.refresh(NAME);

      expect(replaced).to.be.false;
      expect(store.get(NAME)).to.deep.equal(['from-seed']);
      sinon.assert.notCalled(repositoryStub.setPolicyDocument);
    });

    it('accepts 304 as a success rather than letting axios reject it', async () => {
      serviceHelperStub.axiosGet.resolves({ data: [] });

      await store.refresh(NAME);

      const { validateStatus } = serviceHelperStub.axiosGet.firstCall.args[1];
      expect(validateStatus(200)).to.be.true;
      expect(validateStatus(304)).to.be.true;
      expect(validateStatus(404)).to.be.false;
      expect(validateStatus(500)).to.be.false;
    });
  });

  describe('artifacts', () => {
    const ARTIFACT = 'ipLocationTable';
    const ARTIFACT_FILE = 'iplocation.json';

    it('is not served by get(), even once loaded', async () => {
      const receiver = sinon.stub();
      store.onArtifact(ARTIFACT, receiver);
      serviceHelperStub.axiosGet.resolves({ data: Buffer.from('{}'), headers: {} });

      await store.refresh(ARTIFACT);

      sinon.assert.called(receiver);
      expect(store.get(ARTIFACT)).to.equal(null);
    });

    it('hands the receiver raw bytes, requested as such', async () => {
      const receiver = sinon.stub();
      store.onArtifact(ARTIFACT, receiver);
      serviceHelperStub.axiosGet.resolves({ data: Buffer.from('payload'), headers: {} });

      await store.refresh(ARTIFACT);

      expect(serviceHelperStub.axiosGet.firstCall.args[1].responseType).to.equal('arraybuffer');
      expect(Buffer.isBuffer(receiver.firstCall.args[0])).to.be.true;
      expect(receiver.firstCall.args[0].toString()).to.equal('payload');
    });

    it('uses its own timeout, not the document default', async () => {
      store.onArtifact(ARTIFACT, sinon.stub());
      serviceHelperStub.axiosGet.resolves({ data: Buffer.from('{}'), headers: {} });

      await store.refresh(ARTIFACT);

      expect(serviceHelperStub.axiosGet.firstCall.args[1].timeout)
        .to.equal(store.DOCUMENTS[ARTIFACT].timeoutMs);
      expect(store.DOCUMENTS[ARTIFACT].timeoutMs).to.be.above(10 * 1000);
    });

    it('does not cache bytes the receiver rejected', async () => {
      // The receiver is the validator, so its throw must leave the stored copy standing.
      store.onArtifact(ARTIFACT, () => { throw new Error('truncated artifact'); });
      serviceHelperStub.axiosGet.resolves({ data: Buffer.from('bad'), headers: {} });

      const replaced = await store.refresh(ARTIFACT);

      expect(replaced).to.be.false;
      sinon.assert.notCalled(artifactStub.writeArtifactBytes);
    });

    it('caches bytes the receiver accepted, with the etag', async () => {
      store.onArtifact(ARTIFACT, sinon.stub());
      serviceHelperStub.axiosGet.resolves({ data: Buffer.from('good'), headers: { etag: 'W/"x"' } });

      await store.refresh(ARTIFACT);

      const [name, bytes, etag] = artifactStub.writeArtifactBytes.firstCall.args;
      expect(name).to.equal(ARTIFACT);
      expect(bytes.toString()).to.equal('good');
      expect(etag).to.equal('W/"x"');
    });

    it('is not fetched at all without a receiver', async () => {
      serviceHelperStub.axiosGet.resolves({ data: [] });

      await store.startSync();

      const fetched = serviceHelperStub.axiosGet.getCalls()
        .some((c) => c.args[0].endsWith(ARTIFACT_FILE));
      expect(fetched).to.be.false;
    });

    it('logs loudly when cached bytes exist but nothing consumes them', async () => {
      // The consumer ships before the store does, so at that rebase the only thing between
      // a working table and one that silently stops refreshing is remembering onArtifact.
      artifactStub.getArtifactRecord.withArgs(ARTIFACT)
        .resolves({ fileId: 'fid', etag: 'W/"x"', fetchedAt: 1 });

      await store.startSync();

      sinon.assert.called(logStub.error);
      const message = logStub.error.getCalls().map((c) => c.args[0]).join(' ');
      expect(message).to.include(ARTIFACT);
      expect(message).to.include('not wired up');
    });

    it('stays quiet when there is no receiver and nothing cached', async () => {
      serviceHelperStub.axiosGet.resolves({ data: [] });

      await store.startSync();

      // Scoped to the wiring complaint: other documents log their own validation errors
      // against this blanket stub, and those are correct.
      const complaints = logStub.error.getCalls()
        .map((c) => c.args[0])
        .filter((m) => m.includes('not wired up'));
      expect(complaints).to.be.empty;
    });

    it('refuses a second receiver rather than silently replacing the first', () => {
      const first = sinon.stub();
      store.onArtifact(ARTIFACT, first);
      store.onArtifact(ARTIFACT, sinon.stub());

      sinon.assert.called(logStub.error);
    });

    describe('restore from storage', () => {
      it('sweeps orphans, then feeds the stored bytes to the receiver', async () => {
        const receiver = sinon.stub();
        store.onArtifact(ARTIFACT, receiver);
        artifactStub.getArtifactRecord.withArgs(ARTIFACT)
          .resolves({ fileId: 'fid', etag: 'W/"stored"', fetchedAt: 1 });
        artifactStub.readArtifactBytes.withArgs('fid').resolves(Buffer.from('stored'));

        await store.startSync();

        sinon.assert.calledWith(artifactStub.sweepOrphanedArtifacts, ARTIFACT);
        expect(receiver.firstCall.args[0].toString()).to.equal('stored');
      });

      it('drops the etag when the stored bytes are rejected, so the refetch is not a 304', async () => {
        // Keeping it would leave the receiver holding nothing while the store believed the
        // remote copy was already applied.
        store.onArtifact(ARTIFACT, () => { throw new Error('cannot read this build'); });
        artifactStub.getArtifactRecord.withArgs(ARTIFACT)
          .resolves({ fileId: 'fid', etag: 'W/"stored"', fetchedAt: 1 });
        artifactStub.readArtifactBytes.withArgs('fid').resolves(Buffer.from('unreadable'));

        await store.startSync();
        await store.refresh(ARTIFACT);

        const call = serviceHelperStub.axiosGet.getCalls()
          .find((c) => c.args[0].endsWith(ARTIFACT_FILE));
        expect(call.args[1].headers).to.deep.equal({});
        sinon.assert.called(logStub.error);
      });

      it('survives a record whose stored file has gone', async () => {
        const receiver = sinon.stub();
        store.onArtifact(ARTIFACT, receiver);
        artifactStub.getArtifactRecord.withArgs(ARTIFACT)
          .resolves({ fileId: 'fid', etag: null, fetchedAt: 1 });
        artifactStub.readArtifactBytes.withArgs('fid').resolves(null);

        await store.startSync();

        sinon.assert.notCalled(receiver);
      });
    });

    it('does not gate startSync on the artifact fetch', async () => {
      // A minutes-long timeout on a multi-megabyte fetch must not hold up boot, so the
      // artifact refresh is detached and startSync resolves without it.
      let releaseFetch;
      const receiver = sinon.stub();
      store.onArtifact(ARTIFACT, receiver);
      serviceHelperStub.axiosGet
        .withArgs(sinon.match((u) => u.endsWith(ARTIFACT_FILE)), sinon.match.any)
        .returns(new Promise((resolve) => { releaseFetch = resolve; }));
      serviceHelperStub.axiosGet.resolves({ data: [] });

      await store.startSync();

      sinon.assert.notCalled(receiver);
      releaseFetch({ data: Buffer.from('{}'), headers: {} });
    });
  });
});
