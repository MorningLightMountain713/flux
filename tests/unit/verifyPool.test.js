'use strict';

const chai = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
const EventEmitter = require('events');

const { expect } = chai;

const verificationHelper = require('../../ZelBack/src/services/verificationHelper');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const verifyPool = require('../../ZelBack/src/services/utils/verifyPool');

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

  async function rejection(promise) {
    try {
      await promise;
    } catch (error) {
      return error;
    }

    return null;
  }

  it('matches a reply to its own batch, not to whichever arrived first', async () => {
    // The defect this closes: resolving by arrival order means one extra
    // postMessage in the worker shifts every later reply onto the wrong batch,
    // and the caller maps results back positionally - so the node accepts
    // signatures it never verified.
    const { pool, workers } = makePool();
    pool.start(1);

    const first = pool.verify([ITEM]);
    const second = pool.verify([ITEM]);
    const [w] = workers;
    expect(w.posted).to.have.lengthOf(2);

    // Answer them the wrong way round.
    w.emit('message', { id: w.posted[1].id, results: [true] });
    w.emit('message', { id: w.posted[0].id, results: [false] });

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
    const { pool, workers } = makePool();
    pool.start(1);

    const result = pool.verify([ITEM, ITEM]);
    const [w] = workers;
    w.emit('message', { id: w.posted[0].id, results: [true] });

    const error = await rejection(result);
    expect(error).to.be.an('error');
    expect(error.message).to.include('1 results for a batch of 2');

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

    const error = await rejection(result);
    expect(error).to.be.an('error');
    expect(error.message).to.include('gave up after 3 attempts');

    pool.stop();
  });

  it('settles outstanding batches when the pool is stopped', async () => {
    const { pool, workers } = makePool();
    pool.start(1);

    const result = pool.verify([ITEM]);
    pool.stop();

    const error = await rejection(result);
    expect(error).to.be.an('error');
    expect(error.message).to.include('stopped');
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
