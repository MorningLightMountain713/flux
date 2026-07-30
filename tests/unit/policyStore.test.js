const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('policyStore tests', () => {
  let store;
  let serviceHelperStub;
  let repositoryStub;
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

      Object.keys(store.DOCUMENTS).forEach((name) => {
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
});
