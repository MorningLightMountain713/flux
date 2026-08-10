'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('limitCounterRecords tests', () => {
  let records;
  let stubs;
  const KEY = 'b'.repeat(64);

  function load(opts = {}) {
    const coll = {
      createIndex: sinon.stub().resolves(),
      updateOne: opts.updateOne ?? sinon.stub().resolves(),
      countDocuments: opts.countDocuments ?? sinon.stub().resolves(opts.count ?? 0),
    };
    stubs = {
      coll,
      collection: sinon.stub().returns(coll),
      adoptWindowUsage: sinon.stub(),
      log: { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
    };
    return proxyquire('../../ZelBack/src/services/utils/limitCounterRecords', {
      config: {
        database: {
          appsglobal: { database: 'g', collections: { limitCounterRecords: 'limitcounterrecords' } },
        },
      },
      '../dbHelper': {
        databaseConnection: opts.noDb
          ? () => null
          : () => ({ db: () => ({ collection: stubs.collection }) }),
      },
      './limitCounterStore': {
        limitsFor: () => ({ windowMs: opts.windowMs ?? 86400000 }),
        adoptWindowUsage: stubs.adoptWindowUsage,
      },
      '../../lib/log': stubs.log,
    });
  }

  beforeEach(() => { records = load(); });
  afterEach(() => sinon.restore());

  const record = (over = {}) => ({
    purpose: 'playground', key: KEY, sessionId: 'op_1', startedAt: Date.now(), endsAt: Date.now() + 60000, ...over,
  });

  describe('store', () => {
    it('upserts on the record identity, so the same start twice is one row', async () => {
      // A start reaches a node from several peers and can be re-broadcast. Counting
      // those as separate sessions would spend a caller's allowance on one session.
      await records.store(record());

      const [query, , options] = stubs.coll.updateOne.firstCall.args;
      expect(query).to.deep.equal({ purpose: 'playground', key: KEY, sessionId: 'op_1' });
      expect(options).to.deep.equal({ upsert: true });
    });

    it('stores endsAt as a Date, which is what the TTL index reaps on', async () => {
      await records.store(record());

      expect(stubs.coll.updateOne.firstCall.args[1].$set.endsAt).to.be.an.instanceOf(Date);
    });

    it('refuses a record missing its identity', async () => {
      expect(await records.store({ purpose: 'playground', key: KEY })).to.be.false;
      expect(stubs.coll.updateOne.called).to.be.false;
    });

    it('answers false rather than throwing when the database is unavailable', async () => {
      records = load({ noDb: true });
      expect(await records.store(record())).to.be.false;
    });

    it('answers false rather than throwing when the write fails', async () => {
      records = load({ updateOne: sinon.stub().rejects(new Error('mongo gone')) });
      expect(await records.store(record())).to.be.false;
    });
  });

  describe('windowUsage', () => {
    it('counts only starts inside the current window', async () => {
      const now = 1_000_000_000_000;
      records = load({ windowMs: 1000, count: 2 });

      const used = await records.windowUsage('playground', KEY, 1000, now);

      expect(used).to.equal(2);
      const query = stubs.coll.countDocuments.firstCall.args[0];
      expect(query.startedAt.$gte).to.equal(Math.floor(now / 1000) * 1000);
    });

    it('answers zero rather than throwing when the read fails', async () => {
      records = load({ countDocuments: sinon.stub().rejects(new Error('mongo gone')) });
      expect(await records.windowUsage('playground', KEY, 1000)).to.equal(0);
    });
  });

  describe('reconcile', () => {
    it('raises the in-memory tally to what the records already know', async () => {
      // The point of the whole record: a counter that restarted, or has just taken
      // this key over, must not start the caller's day again.
      records = load({ count: 4 });

      await records.reconcile('playground', KEY);

      sinon.assert.calledOnceWithExactly(stubs.adoptWindowUsage, 'playground', KEY, 4);
    });

    it('leaves the tally alone when the records show nothing', async () => {
      records = load({ count: 0 });

      await records.reconcile('playground', KEY);

      expect(stubs.adoptWindowUsage.called).to.be.false;
    });
  });

  describe('prepareCollection', () => {
    it('reaps on the record\'s own endsAt, so it expires with nothing further arriving', async () => {
      await records.prepareCollection();

      const ttl = stubs.coll.createIndex.getCalls().find((c) => c.args[1] && 'expireAfterSeconds' in c.args[1]);
      expect(ttl.args[0]).to.deep.equal({ endsAt: 1 });
      expect(ttl.args[1].expireAfterSeconds).to.equal(0);
    });

    it('makes the record identity unique', async () => {
      await records.prepareCollection();

      const unique = stubs.coll.createIndex.getCalls().find((c) => c.args[1] && c.args[1].unique);
      expect(unique.args[0]).to.deep.equal({ purpose: 1, key: 1, sessionId: 1 });
    });

    it('does nothing when the database is unavailable', async () => {
      records = load({ noDb: true });
      await records.prepareCollection();
      expect(stubs.coll.createIndex.called).to.be.false;
    });
  });
});
