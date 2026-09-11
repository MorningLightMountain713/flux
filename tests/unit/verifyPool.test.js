'use strict';

const chai = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
const EventEmitter = require('events');

const { expect } = chai;

const verificationHelper = require('../../ZelBack/src/services/verificationHelper');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const verifyPool = require('../../ZelBack/src/services/utils/verifyPool');
const { asConfig } = require('./fixtures/config');

const TEST_PUBKEY = '0474eb4690689bb408139249eda7f361b7881c4254ccbe303d3b4d58c2b48897d0f070b44944941998551f9ea0e1befd96f13adf171c07c885e62d0c2af56d3dab';
const TEST_PRIVKEY = '5JTeg79dTLzzHXoJPALMWuoGDM8QmLj4n5f6MeFjx8dzsirvjAh';

function createSignedBroadcast(data) {
  const version = 1;
  const timestamp = Date.now();
  const message = serviceHelper.ensureString(data);
  const messageToSign = version + message + timestamp;
  const signature = verificationHelper.signMessage(messageToSign, TEST_PRIVKEY);
  return {
    messageToVerify: String(version) + message + String(timestamp),
    pubKey: TEST_PUBKEY,
    signature,
  };
}

// Real worker threads and real secp256k1, so these are CPU-bound and their wall
// clock is set by contention rather than by the code under test. Measured idle
// on an 8-physical-core laptop the slowest is 1007ms against mocha's 2000ms
// default; with R runnable threads on C cores each gets C/R of a core, so the
// budget has to satisfy
//
//   worst_idle_ms * (R / C) < budget
//
// One test already carried a 10000 of its own - the same problem met once and
// solved for one case. Both now read the same number, because they are the same
// statement: this work is real, and the box is shared.
const REAL_WORK_MS = 20000;

describe('verifyPool tests', () => {
  before(() => {
    verifyPool.start(2);
  });

  after(() => {
    verifyPool.stop();
  });

  it('should verify a single valid broadcast', async () => {
    const item = createSignedBroadcast({ type: 'fluxappinstallingerror', ip: '1.2.3.4', name: 'testapp' });
    const results = await verifyPool.verify([item]);
    expect(results).to.deep.equal([true]);
  });

  it('settles a batch that cannot be handed to a worker at all', async function () {
    // The handover, not the verification, is what fails here: a function cannot
    // be structured-cloned, so postMessage throws and the job goes back on the
    // queue with the slot still free. Every other way back into dispatch is a
    // worker event, and no worker is holding anything to raise one - so before
    // this was fixed the job sat there and verify() never settled, with an idle
    // worker and a queued job. It is bounded by the attempt count instead.
    this.timeout(REAL_WORK_MS);
    const unclonable = { messageToVerify: () => {}, pubKey: TEST_PUBKEY, signature: 'x' };

    const settled = verifyPool.verify([unclonable]).then(
      () => 'resolved',
      () => 'rejected',
    );
    const outcome = await Promise.race([
      settled,
      new Promise((resolve) => { setTimeout(() => resolve('STILL PENDING'), 5000); }),
    ]);

    expect(outcome, 'verify() never settled - the queue has no way back into dispatch').to.not.equal('STILL PENDING');
  });

  it('should verify a batch of valid broadcasts', async () => {
    const items = [];
    for (let i = 0; i < 20; i++) {
      items.push(createSignedBroadcast({ type: 'fluxappinstallingerror', ip: `1.2.3.${i}`, name: 'testapp' }));
    }
    const results = await verifyPool.verify(items);
    expect(results.length).to.equal(20);
    expect(results.every(Boolean)).to.equal(true);
  });

  it('should return false for broadcasts with tampered data', async () => {
    const item = createSignedBroadcast({ type: 'fluxappinstallingerror', ip: '1.2.3.4', name: 'testapp' });
    item.messageToVerify = item.messageToVerify.replace('testapp', 'hackedapp');
    const results = await verifyPool.verify([item]);
    expect(results).to.deep.equal([false]);
  });

  it('should return false for broadcasts with invalid signature', async () => {
    const item = createSignedBroadcast({ type: 'fluxappinstallingerror', ip: '1.2.3.4', name: 'testapp' });
    item.signature = 'invalidsignature';
    const results = await verifyPool.verify([item]);
    expect(results).to.deep.equal([false]);
  });

  it('should handle mixed valid and invalid broadcasts', async () => {
    const valid = createSignedBroadcast({ type: 'fluxappinstallingerror', ip: '1.2.3.4', name: 'app1' });
    const invalid = createSignedBroadcast({ type: 'fluxappinstallingerror', ip: '5.6.7.8', name: 'app2' });
    invalid.signature = 'bad';
    const results = await verifyPool.verify([valid, invalid, valid]);
    expect(results).to.deep.equal([true, false, true]);
  });

  it('should handle concurrent verify calls without mixing results', async () => {
    const batchA = [];
    const batchB = [];
    for (let i = 0; i < 10; i++) {
      batchA.push(createSignedBroadcast({ type: 'fluxappinstallingerror', ip: `10.0.0.${i}`, name: 'appA' }));
      batchB.push(createSignedBroadcast({ type: 'fluxappinstallingerror', ip: `20.0.0.${i}`, name: 'appB' }));
    }
    // Tamper with batch B items 5-9
    for (let i = 5; i < 10; i++) {
      batchB[i].signature = 'bad';
    }

    const [resultsA, resultsB] = await Promise.all([
      verifyPool.verify(batchA),
      verifyPool.verify(batchB),
    ]);

    expect(resultsA.every(Boolean)).to.equal(true);
    expect(resultsB.slice(0, 5).every(Boolean)).to.equal(true);
    expect(resultsB.slice(5).every((r) => r === false)).to.equal(true);
  });

  it('should handle empty input', async () => {
    const results = await verifyPool.verify([]);
    expect(results).to.deep.equal([]);
  });

  describe('elastic sizing', function () {
    // Every test here raises and retires real workers, which is the subject
    // rather than setup for it.
    this.timeout(REAL_WORK_MS);

    // 256 items per chunk, so this batch is five chunks of work
    const CHUNKS_IN_LARGE_BATCH = 5;
    const LARGE_BATCH = 256 * CHUNKS_IN_LARGE_BATCH;

    function repeatedBatch(size) {
      const item = createSignedBroadcast({ type: 'fluxappinstallingerror', ip: '1.2.3.4', name: 'bulk' });
      return Array.from({ length: size }, () => item);
    }

    it('should raise workers to match the chunks a batch splits into', async () => {
      const { maxWorkers } = verifyPool.stats();
      const pending = verifyPool.verify(repeatedBatch(LARGE_BATCH));

      // sizing happens before the first await, so the pool is already scaled.
      // Read it now, but always drain before asserting - an assertion thrown
      // with work in flight would leave the pool dirty for the next test
      const scaledTo = verifyPool.stats().workers;
      const results = await pending;

      expect(scaledTo).to.equal(Math.min(maxWorkers, CHUNKS_IN_LARGE_BATCH));
      expect(results.length).to.equal(LARGE_BATCH);
      expect(results.every(Boolean)).to.equal(true);
    });

    it('should not raise more workers than there are spare cores', async () => {
      const { maxWorkers } = verifyPool.stats();
      const item = createSignedBroadcast({ type: 'fluxappinstallingerror', ip: '1.2.3.4', name: 'depth' });

      // queue depth, not batch size, is what drives sizing here: nothing can
      // complete while these calls are still being issued
      const pending = [];
      for (let i = 0; i < maxWorkers + 5; i++) {
        pending.push(verifyPool.verify([item]));
      }

      const scaledTo = verifyPool.stats().workers;
      const results = await Promise.all(pending);

      expect(scaledTo).to.equal(maxWorkers);
      expect(results.every((result) => result[0] === true)).to.equal(true);
    });

    it('should preserve item order across chunk boundaries', async () => {
      const items = repeatedBatch(LARGE_BATCH).map((item) => ({ ...item }));
      const tampered = [0, 255, 256, 700, LARGE_BATCH - 1];
      tampered.forEach((index) => { items[index].signature = 'bad'; });

      const results = await verifyPool.verify(items);

      expect(results.length).to.equal(LARGE_BATCH);
      results.forEach((result, index) => {
        expect(result).to.equal(!tampered.includes(index));
      });
    });

    it('should release the extra workers once the burst is over', async () => {
      const clock = sinon.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout'],
        shouldClearNativeTimers: true,
      });
      try {
        await verifyPool.verify(repeatedBatch(LARGE_BATCH));
        expect(verifyPool.stats().workers).to.be.above(1);

        clock.tick(60001);

        expect(verifyPool.stats().workers).to.equal(1);
        expect(verifyPool.stats().busy).to.equal(0);
      } finally {
        clock.restore();
      }
    });
  });

  describe('failure handling', () => {
    const crashingWorker = require('path').join(__dirname, 'fixtures', 'workers', 'crashingVerifyWorker.js');

    afterEach(() => {
      verifyPool.stop();
      verifyPool.start(2);
    });

    it('should give up on a batch that keeps killing its worker instead of retrying for ever', async () => {
      verifyPool.stop();
      verifyPool.start(1, { workerPath: crashingWorker });

      const results = await verifyPool.verify([
        { messageToVerify: 'a', pubKey: 'b', signature: 'c' },
        { messageToVerify: 'd', pubKey: 'e', signature: 'f' },
      ]);

      // a signature we could not check is one we do not trust
      expect(results).to.deep.equal([false, false]);
    });

    it('should leave the pool usable after abandoning a batch', async () => {
      verifyPool.stop();
      verifyPool.start(1, { workerPath: crashingWorker });
      await verifyPool.verify([{ messageToVerify: 'a', pubKey: 'b', signature: 'c' }]);

      const stats = verifyPool.stats();
      expect(stats.queued).to.equal(0);
      expect(stats.busy).to.equal(0);
    });

    it('should settle callers waiting on work when the pool is stopped', async () => {
      verifyPool.stop();
      verifyPool.start(1, { workerPath: crashingWorker });

      const pending = verifyPool.verify([{ messageToVerify: 'a', pubKey: 'b', signature: 'c' }]);
      verifyPool.stop();

      expect(await pending).to.deep.equal([false]);
    });
  });
});

// The real worker replies once per batch, in order, with a length-matched
// array - so against it the failure modes below are unreachable. They are what
// happens when that stops being true, which nothing in the worker enforces.
describe('verifyPool worker protocol', () => {
  const ITEM = { messageToVerify: 'm', pubKey: 'p', signature: 's' };

  function makePool() {
    const workers = [];

    class FakeWorker extends EventEmitter {
      constructor() {
        super();
        this.posted = [];
        this.terminated = false;
        workers.push(this);
      }

      postMessage(msg) {
        this.posted.push(msg);
      }

      terminate() {
        this.terminated = true;
      }
    }

    const pool = proxyquire('../../ZelBack/src/services/utils/verifyPool', {
      worker_threads: { Worker: FakeWorker },
      '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
    });

    return { pool, workers };
  }

  it('matches a reply to its own batch, not to whichever arrived first', async () => {
    // The defect this closes: resolving by arrival order means one extra
    // postMessage in the worker shifts every later reply onto the wrong batch,
    // and the caller maps results back positionally - so the node accepts
    // signatures it never verified.
    const { pool, workers } = makePool();
    pool.start(1);

    // A slot holds one batch at a time, so the second raises a second worker.
    const first = pool.verify([ITEM]);
    const second = pool.verify([ITEM]);
    expect(workers).to.have.lengthOf(2);
    const [w1, w2] = workers;
    expect(w1.posted).to.have.lengthOf(1);
    expect(w2.posted).to.have.lengthOf(1);

    // Answer them the wrong way round.
    w2.emit('message', { id: w2.posted[0].id, results: [true] });
    w1.emit('message', { id: w1.posted[0].id, results: [false] });

    expect(await first).to.deep.equal([false]);
    expect(await second).to.deep.equal([true]);

    pool.stop();
  });

  it('ignores a reply for a batch it is not waiting on', async () => {
    const { pool, workers } = makePool();
    pool.start(1);

    const result = pool.verify([ITEM]);
    const [w] = workers;

    w.emit('message', { id: 9999, results: [true] });
    w.emit('message', { id: w.posted[0].id, results: [false] });

    expect(await result).to.deep.equal([false]);

    pool.stop();
  });

  it('refuses a reply carrying the wrong number of verdicts', async () => {
    // A short array would leave the tail of the batch reading as unverified,
    // so fail closed rather than hand the caller something to index into.
    // Closed here means every item unverified — this pool never rejects, so one
    // bad reply costs its own batch and not the sync response it arrived in.
    const { pool, workers } = makePool();
    pool.start(1);

    const result = pool.verify([ITEM, ITEM]);
    const [w] = workers;
    w.emit('message', { id: w.posted[0].id, results: [true] });

    expect(await result).to.deep.equal([false, false]);

    pool.stop();
  });

  it('resubmits an outstanding batch when its worker exits CLEANLY', async () => {
    // The defect this closes: only a non-zero exit resubmitted, so a clean one
    // left the promise unsettled, verify()'s Promise.all never settled, and the
    // gossip handler awaiting it hung forever holding its references.
    const { pool, workers } = makePool();
    pool.start(1);

    const result = pool.verify([ITEM]);
    workers[0].emit('exit', 0);

    expect(workers).to.have.lengthOf(2);
    const replacement = workers[1];
    expect(replacement.posted).to.have.lengthOf(1);

    replacement.emit('message', { id: replacement.posted[0].id, results: [true] });
    expect(await result).to.deep.equal([true]);

    pool.stop();
  });

  it('gives up on a batch that keeps killing its worker', async () => {
    const { pool, workers } = makePool();
    pool.start(1);

    const result = pool.verify([ITEM]);
    workers[0].emit('exit', 1);
    workers[1].emit('exit', 1);
    workers[2].emit('exit', 1);

    // Abandoned, not rejected: MAX_JOB_ATTEMPTS reached, and a signature this
    // node could not check is one it does not trust.
    expect(await result).to.deep.equal([false]);

    pool.stop();
  });

  it('settles outstanding batches when the pool is stopped', async () => {
    const { pool, workers } = makePool();
    pool.start(1);

    const result = pool.verify([ITEM]);
    pool.stop();

    expect(await result).to.deep.equal([false]);
    expect(workers[0].terminated).to.equal(true);
  });

  it('does not respawn a worker that exits after the pool was stopped', async () => {
    const { pool, workers } = makePool();
    pool.start(1);
    pool.stop();

    workers[0].emit('exit', 1);

    expect(workers).to.have.lengthOf(1);
  });
});

describe('verifyPool sizing', () => {
  const ITEM = { messageToVerify: 'm', pubKey: 'p', signature: 's' };

  function sizedPool(fluxapps, cores) {
    const workers = [];
    class FakeWorker extends EventEmitter {
      constructor() { super(); workers.push(this); }

      postMessage() {}

      terminate() {}
    }
    const pool = proxyquire('../../ZelBack/src/services/utils/verifyPool', {
      worker_threads: { Worker: FakeWorker },
      config: asConfig({ fluxapps }),
      os: { cpus: () => new Array(cores) },
      '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
    });
    return { pool, workers };
  }

  // The knob caps the CEILING, not the resident count, because that is where the
  // incident is. The pool starts at one resident worker and climbs on demand, so
  // sizing only start() would be inert: ten nodes of a fleet on one host each
  // climb to cpus-1 under the same gossip burst - 150 verifier threads on 16
  // cores in one second (1203 on chud, 2026-09-07), and a 96-node gate is 1,440
  // of them. This asserts the scale-up path, which is the one that gets there.
  // The commit that introduced the knob asserted start()'s own size,
  // against a pool that had no resident/scaling split at the time.
  it('caps the scale-up at config.fluxapps.verifyPoolSize, not at the host size', () => {
    const { pool, workers } = sizedPool({ verifyPoolSize: 3 }, 16);
    pool.start();
    // Ten batches outstanding: uncapped this pool would raise ten workers.
    for (let i = 0; i < 10; i++) pool.verify([ITEM]);
    expect(workers).to.have.lengthOf(3);
    pool.stop();
  });

  it('keeps cpus-1 when production leaves the knob unset', () => {
    const { pool, workers } = sizedPool({}, 4);
    pool.start();
    for (let i = 0; i < 10; i++) pool.verify([ITEM]);
    expect(workers).to.have.lengthOf(3);
    pool.stop();
  });
});
