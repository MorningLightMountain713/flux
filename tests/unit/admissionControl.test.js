'use strict';

const { expect } = require('chai');
const admissionControl = require('../../ZelBack/src/services/utils/admissionControl');

// A minimal DeploymentSpec stand-in: reserve() only calls these two.
const deploymentOf = (cpu, memory, hdd) => ({
  resourceTotals: () => ({ cpu, memoryMb: memory }),
  reservableHostDiskGb: () => hdd,
});

describe('admissionControl', () => {
  afterEach(() => admissionControl.clear());

  describe('reserve / release / pendingResources', () => {
    it('empty pendingResources is all zero', () => {
      expect(admissionControl.pendingResources()).to.deep.equal({ cpu: 0, memory: 0, hdd: 0 });
    });

    it('reserve records a footprint that pendingResources reports', () => {
      admissionControl.reserve('web', deploymentOf(2, 4000, 50));
      expect(admissionControl.pendingResources()).to.deep.equal({ cpu: 2, memory: 4000, hdd: 50 });
    });

    it('pendingResources sums multiple reservations', () => {
      admissionControl.reserve('web', deploymentOf(2, 4000, 50));
      admissionControl.reserve('db', deploymentOf(1, 2000, 25));
      expect(admissionControl.pendingResources()).to.deep.equal({ cpu: 3, memory: 6000, hdd: 75 });
    });

    it('reserve is idempotent per app — re-reserve overwrites, never double-counts', () => {
      admissionControl.reserve('web', deploymentOf(2, 4000, 50));
      admissionControl.reserve('web', deploymentOf(3, 6000, 60));
      expect(admissionControl.pendingResources()).to.deep.equal({ cpu: 3, memory: 6000, hdd: 60 });
    });

    it('release drops a reservation', () => {
      admissionControl.reserve('web', deploymentOf(2, 4000, 50));
      expect(admissionControl.release('web')).to.equal(true);
      expect(admissionControl.pendingResources()).to.deep.equal({ cpu: 0, memory: 0, hdd: 0 });
    });

    it('release is idempotent (false for an unknown app)', () => {
      expect(admissionControl.release('nope')).to.equal(false);
    });
  });

  describe('withLock (the check-and-reserve mutex)', () => {
    it('serializes critical sections — the second starts only after the first completes', async () => {
      const order = [];
      let releaseFirst;
      const firstHeld = new Promise((r) => { releaseFirst = r; });

      const first = admissionControl.withLock(async () => {
        order.push('first-start');
        await firstHeld; // hold the lock until released
        order.push('first-end');
      });
      // let `first` acquire the lock and run up to its await
      await new Promise((r) => { setImmediate(r); });

      const second = admissionControl.withLock(async () => {
        order.push('second-start');
      });

      // second must be queued behind first, not interleaved
      expect(order).to.deep.equal(['first-start']);
      releaseFirst();
      await Promise.all([first, second]);
      expect(order).to.deep.equal(['first-start', 'first-end', 'second-start']);
    });

    it('releases the lock even if the critical section throws', async () => {
      await admissionControl.withLock(async () => { throw new Error('boom'); }).catch(() => {});
      let ran = false;
      await admissionControl.withLock(async () => { ran = true; });
      expect(ran).to.equal(true);
    });

    it('a check inside the lock sees a prior reservation — closes the double-admit race', async () => {
      // app A admits and reserves under the lock
      await admissionControl.withLock(async () => {
        admissionControl.reserve('A', deploymentOf(2, 4000, 50));
      });
      // app B's check (under the lock) now sees A's in-flight footprint
      let seenByB;
      await admissionControl.withLock(async () => {
        seenByB = admissionControl.pendingResources();
      });
      expect(seenByB).to.deep.equal({ cpu: 2, memory: 4000, hdd: 50 });
    });
  });

  // Some of what a node has committed is free, interruptible work. Paid work
  // that cannot otherwise fit asks for it back rather than being refused —
  // a refusal costs the app seven days in the spawner's error cache.
  describe('reclaimable reservations', () => {
    it('counts a reclaimable reservation in the pending total like any other', () => {
      admissionControl.reserve('op_s1', deploymentOf(2, 4000, 50), { reclaimable: true });
      // It IS committed capacity — a second session must not be admitted against it.
      expect(admissionControl.pendingResources()).to.deep.equal({ cpu: 2, memory: 4000, hdd: 50 });
    });

    it('reports only the reclaimable share separately', () => {
      admissionControl.reserve('paidapp', deploymentOf(4, 8000, 100));
      admissionControl.reserve('op_s1', deploymentOf(2, 4000, 50), { reclaimable: true });

      expect(admissionControl.pendingResources()).to.deep.equal({ cpu: 6, memory: 12000, hdd: 150 });
      expect(admissionControl.reclaimableResources()).to.deep.equal({ cpu: 2, memory: 4000, hdd: 50 });
    });

    it('treats an unclassified reservation as not reclaimable', () => {
      admissionControl.reserve('paidapp', deploymentOf(4, 8000, 100));
      expect(admissionControl.reclaimableResources()).to.deep.equal({ cpu: 0, memory: 0, hdd: 0 });
    });

    it('stops counting a reclaimable reservation once it is released', () => {
      admissionControl.reserve('op_s1', deploymentOf(2, 4000, 50), { reclaimable: true });
      admissionControl.release('op_s1');
      expect(admissionControl.reclaimableResources()).to.deep.equal({ cpu: 0, memory: 0, hdd: 0 });
    });
  });

  describe('requestReclaim', () => {
    afterEach(() => admissionControl.setReclaimer(null));

    it('asks the registered reclaimer for what the caller could not fit', async () => {
      const asked = [];
      admissionControl.setReclaimer(async (totals) => { asked.push(totals); });

      const totals = { cpu: 2, memoryMb: 4000, hostDiskGb: 50 };
      expect(await admissionControl.requestReclaim(totals)).to.equal(true);
      expect(asked).to.deep.equal([totals]);
    });

    // A node with no reclaimable work registered must still answer, so the
    // caller can tell "nothing to reclaim" from "reclaim failed".
    it('answers false when nothing has registered', async () => {
      expect(await admissionControl.requestReclaim({ cpu: 1 })).to.equal(false);
    });
  });
});
