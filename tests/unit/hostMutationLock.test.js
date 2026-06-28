const { expect } = require('chai');

const { withHostMutationLock } = require('../../ZelBack/src/services/utils/hostMutationLock');

const flush = () => new Promise((resolve) => { setImmediate(resolve); });

describe('hostMutationLock tests', () => {
  it('runs fn while holding the lock and returns its result', async () => {
    const result = await withHostMutationLock(async () => 'done');

    expect(result).to.equal('done');
  });

  it('serializes concurrent callers (the second body waits for the first to release)', async () => {
    const order = [];
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

    const first = withHostMutationLock(async () => {
      order.push('first-start');
      await firstGate;
      order.push('first-end');
    });

    // let `first` acquire the lock before the second caller queues
    await flush();

    const second = withHostMutationLock(async () => {
      order.push('second-start');
    });

    // while `first` holds the lock, `second`'s body must not have run
    await flush();
    expect(order).to.deep.equal(['first-start']);

    releaseFirst();
    await Promise.all([first, second]);

    expect(order).to.deep.equal(['first-start', 'first-end', 'second-start']);
  });

  it('releases the lock when fn throws (does not wedge the singleton)', async () => {
    let threw = false;
    try {
      await withHostMutationLock(async () => { throw new Error('boom'); });
    } catch (err) {
      threw = true;
      expect(err.message).to.equal('boom');
    }
    expect(threw).to.be.true;

    // the lock was released in finally, so a subsequent caller still acquires
    const result = await withHostMutationLock(async () => 'after-throw');
    expect(result).to.equal('after-throw');
  });

  it('runs queued callers in FIFO order', async () => {
    const order = [];
    let releaseHead;
    const headGate = new Promise((resolve) => { releaseHead = resolve; });

    const p1 = withHostMutationLock(async () => { order.push(1); await headGate; });
    await flush();
    const p2 = withHostMutationLock(async () => { order.push(2); });
    const p3 = withHostMutationLock(async () => { order.push(3); });

    await flush();
    expect(order).to.deep.equal([1]);

    releaseHead();
    await Promise.all([p1, p2, p3]);

    expect(order).to.deep.equal([1, 2, 3]);
  });
});
