'use strict';

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');

chai.use(chaiAsPromised);
const { expect } = chai;

const { AsyncLock } = require('../../ZelBack/src/services/utils/asyncLock');

describe('asyncLock tests', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('acquisition', () => {
    it('should instantiate and not be locked', () => {
      const asyncLock = new AsyncLock();

      expect(asyncLock.locked).to.be.false;
    });

    it('should set locked when acquired', async () => {
      const asyncLock = new AsyncLock();

      await asyncLock.acquire();

      expect(asyncLock.locked).to.be.true;
    });

    it('should unlock when the release is called', async () => {
      const asyncLock = new AsyncLock();

      const release = await asyncLock.acquire();
      release();

      expect(asyncLock.locked).to.be.false;
      await asyncLock.waitReady();
    });

    it('should block a second acquire on a mutex until the first releases', async () => {
      const asyncLock = new AsyncLock();
      let secondAcquired = false;

      const release = await asyncLock.acquire();

      const second = (async () => {
        await asyncLock.acquire();
        secondAcquired = true;
      })();

      await new Promise((r) => { setTimeout(r, 0); });
      expect(secondAcquired).to.be.false;

      release();
      await second;
      expect(secondAcquired).to.be.true;
    });

    it('should allow maxConcurrent holders at once and block the next', async () => {
      const asyncLock = new AsyncLock(3);
      const acquired = [false, false, false, false];
      const releases = [];

      const take = async (index) => {
        releases[index] = await asyncLock.acquire();
        acquired[index] = true;
      };

      await Promise.all([take(0), take(1), take(2)]);
      expect(acquired.slice(0, 3)).to.deep.equal([true, true, true]);

      const fourth = take(3);
      await new Promise((r) => { setTimeout(r, 0); });
      expect(acquired[3]).to.be.false;

      releases[0]();
      await fourth;
      expect(acquired[3]).to.be.true;
    });

    it('should serve waiters first-in first-out', async () => {
      const clock = sinon.useFakeTimers();
      const asyncLock = new AsyncLock();
      const order = [];

      const take = async (id) => {
        const release = await asyncLock.acquire();
        await new Promise((r) => { setTimeout(r, 1000); });
        order.push(id);
        release();
      };

      const running = [take(1), take(2), take(3)];
      expect(asyncLock.waiterCount).to.equal(2);

      await clock.tickAsync(3000);
      await Promise.all(running);

      expect(order).to.deep.equal([1, 2, 3]);
    });
  });

  describe('the release is bound to its own acquisition', () => {
    // The reason this class owns the guarantee rather than its callers: both of
    // these failures are silent, and both leave the semaphore reporting a limit
    // it has stopped enforcing.
    it('should not free another holder when a release is called twice', async () => {
      const asyncLock = new AsyncLock(2);

      const releaseFirst = await asyncLock.acquire();
      await asyncLock.acquire();

      let thirdAcquired = false;
      const third = (async () => {
        await asyncLock.acquire();
        thirdAcquired = true;
      })();

      releaseFirst();
      await new Promise((r) => { setTimeout(r, 0); });
      expect(thirdAcquired).to.be.true;

      // The double call must be a no-op: the second holder still has its slot,
      // so a fourth caller has to wait for it.
      releaseFirst();
      let fourthAcquired = false;
      (async () => {
        await asyncLock.acquire();
        fourthAcquired = true;
      })();

      await new Promise((r) => { setTimeout(r, 0); });
      expect(fourthAcquired).to.be.false;
      await third;
    });

    it('should attribute a leak to the holder that leaked it, not to whoever released next', async () => {
      const clock = sinon.useFakeTimers();
      // eslint-disable-next-line global-require
      const log = require('../../ZelBack/src/lib/log');
      const errorStub = sinon.stub(log, 'error');

      const asyncLock = new AsyncLock(2, { maxHoldMs: 1000 });

      // With acquire and release strictly paired, a release that frees the
      // wrong slot is only a permutation — the free-slot COUNT stays right, so
      // nothing observable changes. It takes an unpaired release to expose it.
      // Here the first holder leaks and the second releases normally: if the
      // second's release freed the first's slot, it would also cancel the
      // first's watchdog, and the leak would go unreported forever while the
      // second's slot was never returned.
      await asyncLock.acquire({ label: 'leaker' });
      const releaseTidy = await asyncLock.acquire({ label: 'tidy' });

      await clock.tickAsync(500);
      releaseTidy();

      await clock.tickAsync(500);

      expect(errorStub.calledOnce).to.be.true;
      expect(errorStub.firstCall.args[0]).to.include('leaker');
      expect(errorStub.firstCall.args[0]).to.not.include('tidy');
      // Both slots are back: the tidy holder returned its own, and the
      // watchdog reclaimed the leaked one.
      expect(asyncLock.locked).to.be.false;
    });
  });

  describe('acquisition timeout', () => {
    it('should wait indefinitely by default', async () => {
      const clock = sinon.useFakeTimers();
      // Watchdog off: with it on, a wait past maxHoldMs is not observable —
      // the holder gets force-released and the waiter is handed the slot.
      const asyncLock = new AsyncLock(1, { maxHoldMs: 0 });
      let acquired = false;

      const release = await asyncLock.acquire();
      const waiter = (async () => {
        await asyncLock.acquire();
        acquired = true;
      })();

      await clock.tickAsync(600000);
      expect(acquired).to.be.false;

      release();
      await waiter;
      expect(acquired).to.be.true;
    });

    it('should reject with LOCK_TIMEOUT when a slot does not free up in time', async () => {
      const clock = sinon.useFakeTimers();
      const asyncLock = new AsyncLock();

      await asyncLock.acquire();
      const waiter = asyncLock.acquire({ timeoutMs: 5000 });

      await clock.tickAsync(5000);

      const error = await waiter.catch((err) => err);
      // Consumers must class this retryable: it says the node was busy, never
      // that the operation was invalid.
      expect(error.code).to.equal('LOCK_TIMEOUT');
      expect(error.message).to.match(/Timed out after 5000ms/);
    });

    it('should stop counting a timed-out waiter, so it cannot be handed a slot later', async () => {
      const clock = sinon.useFakeTimers();
      const asyncLock = new AsyncLock();

      const release = await asyncLock.acquire();
      const doomed = asyncLock.acquire({ timeoutMs: 1000 });
      expect(asyncLock.waiterCount).to.equal(1);

      await clock.tickAsync(1000);
      await doomed.catch(() => {});
      expect(asyncLock.waiterCount).to.equal(0);

      // Releasing must not resurrect the abandoned waiter into a held slot.
      release();
      expect(asyncLock.locked).to.be.false;
    });

    it('should not time out an acquisition that was granted first', async () => {
      const clock = sinon.useFakeTimers();
      const asyncLock = new AsyncLock();

      const release = await asyncLock.acquire();
      const waiter = asyncLock.acquire({ timeoutMs: 5000 });

      await clock.tickAsync(1000);
      release();

      const secondRelease = await waiter;
      await clock.tickAsync(10000);

      expect(asyncLock.locked).to.be.true;
      secondRelease();
      expect(asyncLock.locked).to.be.false;
    });
  });

  describe('max-hold watchdog', () => {
    it('should force-release a slot held past the limit and log the leak', async () => {
      const clock = sinon.useFakeTimers();
      // eslint-disable-next-line global-require
      const log = require('../../ZelBack/src/lib/log');
      const errorStub = sinon.stub(log, 'error');

      const asyncLock = new AsyncLock(1, { maxHoldMs: 1000 });

      await asyncLock.acquire({ label: 'leaky' });
      expect(asyncLock.locked).to.be.true;

      await clock.tickAsync(1000);

      expect(asyncLock.locked).to.be.false;
      expect(errorStub.calledOnce).to.be.true;
      expect(errorStub.firstCall.args[0]).to.match(/force-releasing a slot held over/);
      expect(errorStub.firstCall.args[0]).to.include('leaky');
    });

    it('should hand the reclaimed slot to a waiter', async () => {
      const clock = sinon.useFakeTimers();
      // eslint-disable-next-line global-require
      const log = require('../../ZelBack/src/lib/log');
      sinon.stub(log, 'error');

      const asyncLock = new AsyncLock(1, { maxHoldMs: 1000 });
      let acquired = false;

      await asyncLock.acquire();
      (async () => {
        await asyncLock.acquire();
        acquired = true;
      })();

      await clock.tickAsync(1000);
      expect(acquired).to.be.true;
    });

    it('should make the real holder\'s later release a no-op after a force-release', async () => {
      const clock = sinon.useFakeTimers();
      // eslint-disable-next-line global-require
      const log = require('../../ZelBack/src/lib/log');
      sinon.stub(log, 'error');

      const asyncLock = new AsyncLock(1, { maxHoldMs: 1000 });

      const release = await asyncLock.acquire();
      await clock.tickAsync(1000);

      // Another caller has the slot now; the leaked holder returning must not
      // take it away from them.
      await asyncLock.acquire();
      release();

      expect(asyncLock.locked).to.be.true;
    });

    it('should not fire for a holder that releases in time', async () => {
      const clock = sinon.useFakeTimers();
      // eslint-disable-next-line global-require
      const log = require('../../ZelBack/src/lib/log');
      const errorStub = sinon.stub(log, 'error');

      const asyncLock = new AsyncLock(1, { maxHoldMs: 1000 });

      const release = await asyncLock.acquire();
      await clock.tickAsync(500);
      release();
      await clock.tickAsync(5000);

      expect(errorStub.called).to.be.false;
    });

    it('should be disabled by maxHoldMs 0', async () => {
      const clock = sinon.useFakeTimers();
      // eslint-disable-next-line global-require
      const log = require('../../ZelBack/src/lib/log');
      const errorStub = sinon.stub(log, 'error');

      const asyncLock = new AsyncLock(1, { maxHoldMs: 0 });

      await asyncLock.acquire();
      await clock.tickAsync(600000);

      expect(asyncLock.locked).to.be.true;
      expect(errorStub.called).to.be.false;
    });
  });

  describe('waitReady', () => {
    it('should resolve immediately when nothing is outstanding', async () => {
      const asyncLock = new AsyncLock();
      await asyncLock.waitReady();
    });

    it('should resolve once the holder releases', async () => {
      const clock = sinon.useFakeTimers();
      const asyncLock = new AsyncLock();
      let ready = false;

      const release = await asyncLock.acquire();
      const waiter = (async () => {
        await asyncLock.waitReady();
        ready = true;
      })();

      setTimeout(() => release(), 5000);

      await clock.tickAsync(4000);
      expect(ready).to.be.false;
      await clock.tickAsync(1000);
      expect(ready).to.be.true;
      await waiter;
    });

    it('should wait only for what was outstanding at the call when waitAll is false', async () => {
      const clock = sinon.useFakeTimers();
      const asyncLock = new AsyncLock();
      let ready = false;

      const take = async () => {
        const release = await asyncLock.acquire();
        await new Promise((r) => { setTimeout(r, 1000); });
        release();
      };

      const first = take();
      const second = take();
      const third = take();
      const waiter = (async () => {
        await asyncLock.waitReady({ waitAll: false });
        ready = true;
      })();
      const fourth = take();

      await clock.tickAsync(3000);
      await Promise.all([first, second, third]);
      await waiter;
      expect(ready).to.be.true;

      await clock.tickAsync(1000);
      await fourth;
    });

    it('should also wait for work that arrives while waiting when waitAll is true', async () => {
      const clock = sinon.useFakeTimers();
      const asyncLock = new AsyncLock();
      let ready = false;

      const take = async () => {
        const release = await asyncLock.acquire();
        await new Promise((r) => { setTimeout(r, 1000); });
        release();
      };

      const first = take();
      const second = take();
      const third = take();
      const waiter = (async () => {
        await asyncLock.waitReady({ waitAll: true });
        ready = true;
      })();
      const fourth = take();

      await clock.tickAsync(3000);
      await Promise.all([first, second, third]);
      expect(ready).to.be.false;

      await clock.tickAsync(1000);
      await fourth;
      await waiter;
      expect(ready).to.be.true;
    });
  });

  describe('counters', () => {
    it('should count only blocked acquisitions as waiters', async () => {
      const asyncLock = new AsyncLock(2);

      const first = await asyncLock.acquire();
      expect(asyncLock.waiterCount).to.equal(0);
      await asyncLock.acquire();
      expect(asyncLock.waiterCount).to.equal(0);

      asyncLock.acquire();
      expect(asyncLock.waiterCount).to.equal(1);
      asyncLock.acquire();
      expect(asyncLock.waiterCount).to.equal(2);

      first();
      await new Promise((r) => { setTimeout(r, 0); });
      expect(asyncLock.waiterCount).to.equal(1);
    });
  });
});
