'use strict';

const { expect } = require('chai');
const admissionControl = require('../../ZelBack/src/services/utils/admissionControl');
const {
  loadSpecLibrary, V9_SUBMISSION, v9Spec, assertAnswers,
} = require('./fixtures/fluxSpec');

// The spec library is real here, not stubbed — see tests/unit/fixtures/fluxSpec.js
// for why. admissionControl is the module the hand-written deployment double hurt
// most: reserve() calls resourceTotals() AND reservableHostDiskGb(), and a double
// carrying only the first is exactly what let playgroundService's suite stay green
// while the real reserve would have thrown. A double also gets to STATE its disk
// figure; a real DeploymentSpec derives it, so a fixture cannot claim a footprint
// its own parts do not add up to.
let flux;

const APPS_FOLDER = '/tmp/apps';

/**
 * A real v9 components blob, resized. Every size is inside the schema's own caps
 * — cpu 0.1-14 in steps of 0.1, memory a multiple of 100 in 100-57000, rootFsGb
 * > 0, persistentStorage.sizeGb <= 780.
 */
function sizedComponents({
  cpu, memory, storageGb, rootFsGb, swapGb = 0,
}) {
  const components = JSON.parse(JSON.stringify(V9_SUBMISSION.components));
  const { web } = components;
  web.cpu = cpu;
  web.memory = memory;
  web.rootFsGb = rootFsGb;
  web.swapGb = swapGb;
  web.persistentStorage.sizeGb = storageGb;
  return components;
}

/**
 * A real DeploymentSpec — the object appInstaller and playgroundService hand to
 * reserve(). Its disk figure is DERIVED (persistent storage + rootFs + swap), so
 * the split below is deliberate: `storageGb` is the declared persistent size and
 * the reserved `hdd` is the larger host footprint.
 */
async function deploymentOf(size) {
  const spec = await v9Spec({ components: sizedComponents(size) });
  return flux.DeploymentSpec.fromSpec(spec, APPS_FOLDER, { replica: null });
}

describe('admissionControl', () => {
  // Four real apps, sized so their host footprints are 50, 25, 60 and 100 GB.
  let web; // cpu 2, 4000 MB, 40 + 10 = 50 GB
  let db; // cpu 1, 2000 MB, 20 + 5 = 25 GB
  let webBigger; // cpu 3, 6000 MB, 50 + 10 = 60 GB
  let paidapp; // cpu 4, 8000 MB, 90 + 10 = 100 GB

  before(async function buildDeployments() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(30000);
    flux = await loadSpecLibrary();
    web = await deploymentOf({
      cpu: 2, memory: 4000, storageGb: 40, rootFsGb: 10,
    });
    db = await deploymentOf({
      cpu: 1, memory: 2000, storageGb: 20, rootFsGb: 5,
    });
    webBigger = await deploymentOf({
      cpu: 3, memory: 6000, storageGb: 50, rootFsGb: 10,
    });
    paidapp = await deploymentOf({
      cpu: 4, memory: 8000, storageGb: 90, rootFsGb: 10,
    });
  });

  afterEach(() => admissionControl.clear());

  describe('reserve / release / pendingResources', () => {
    it('empty pendingResources is all zero', () => {
      expect(admissionControl.pendingResources()).to.deep.equal({ cpu: 0, memory: 0, hdd: 0 });
    });

    // The two members reserve() reads, on the class that actually arrives. A
    // double missing either one reserves NaN or throws, and neither shows up in
    // a suite that hands over a literal.
    it('a real DeploymentSpec answers both members reserve() reads', () => {
      assertAnswers(web, ['resourceTotals', 'reservableHostDiskGb']);
    });

    it('reserve records a footprint that pendingResources reports', () => {
      admissionControl.reserve('web', web);
      expect(admissionControl.pendingResources()).to.deep.equal({ cpu: 2, memory: 4000, hdd: 50 });
    });

    // The disk figure a node must hold is the FULL host footprint — persistent
    // storage plus the container root filesystem plus swap — not the declared
    // persistent size. They differ by 10 GB here, so reserving the wrong one is
    // visible. A hand-written double stated one number and could not tell them
    // apart.
    it('reserves the host footprint, not the declared persistent storage', () => {
      admissionControl.reserve('web', web);
      expect(web.resourceTotals().storageGb, 'the declared persistent size').to.equal(40);
      expect(web.reservableHostDiskGb(), 'the host footprint the node commits').to.equal(50);
      expect(admissionControl.pendingResources().hdd).to.equal(web.reservableHostDiskGb());
    });

    it('pendingResources sums multiple reservations', () => {
      admissionControl.reserve('web', web);
      admissionControl.reserve('db', db);
      expect(admissionControl.pendingResources()).to.deep.equal({ cpu: 3, memory: 6000, hdd: 75 });
    });

    it('reserve is idempotent per app — re-reserve overwrites, never double-counts', () => {
      admissionControl.reserve('web', web);
      admissionControl.reserve('web', webBigger);
      expect(admissionControl.pendingResources()).to.deep.equal({ cpu: 3, memory: 6000, hdd: 60 });
    });

    it('release drops a reservation', () => {
      admissionControl.reserve('web', web);
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
        admissionControl.reserve('A', web);
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
      admissionControl.reserve('op_s1', web, { reclaimable: true });
      // It IS committed capacity — a second session must not be admitted against it.
      expect(admissionControl.pendingResources()).to.deep.equal({ cpu: 2, memory: 4000, hdd: 50 });
    });

    it('reports only the reclaimable share separately', () => {
      admissionControl.reserve('paidapp', paidapp);
      admissionControl.reserve('op_s1', web, { reclaimable: true });

      expect(admissionControl.pendingResources()).to.deep.equal({ cpu: 6, memory: 12000, hdd: 150 });
      expect(admissionControl.reclaimableResources()).to.deep.equal({ cpu: 2, memory: 4000, hdd: 50 });
    });

    it('treats an unclassified reservation as not reclaimable', () => {
      admissionControl.reserve('paidapp', paidapp);
      expect(admissionControl.reclaimableResources()).to.deep.equal({ cpu: 0, memory: 0, hdd: 0 });
    });

    it('stops counting a reclaimable reservation once it is released', () => {
      admissionControl.reserve('op_s1', web, { reclaimable: true });
      admissionControl.release('op_s1');
      expect(admissionControl.reclaimableResources()).to.deep.equal({ cpu: 0, memory: 0, hdd: 0 });
    });
  });

  describe('requestReclaim', () => {
    afterEach(() => admissionControl.setReclaimer(null));

    it('asks the registered reclaimer for what the caller could not fit', async () => {
      const asked = [];
      admissionControl.setReclaimer(async (totals) => { asked.push(totals); });

      // What appInstaller passes: the real ResourceTotals of the deployment that
      // would not fit, not a hand-written triple.
      const totals = paidapp.resourceTotals();
      expect(await admissionControl.requestReclaim(totals)).to.equal(true);
      expect(asked).to.deep.equal([totals]);
    });

    // playgroundService.reclaimFor reads three PROPERTIES off whatever it is
    // handed — cpu, memoryMb and hostDiskGb — and stops evicting sessions once
    // it has freed that much. An absent field reads as undefined, every
    // comparison against it is false, and the reclaimer evicts every live
    // session. So assert the properties the real reclaimer reads survive the
    // hand-off.
    it('hands the reclaimer totals carrying every field the real reclaimer reads', async () => {
      let handed;
      admissionControl.setReclaimer(async (totals) => { handed = totals; });

      await admissionControl.requestReclaim(paidapp.resourceTotals());

      for (const field of ['cpu', 'memoryMb', 'hostDiskGb']) {
        expect(handed[field], `reclaimFor compares against ${field}`).to.be.a('number');
      }
      expect(handed.hostDiskGb, 'the host footprint, not the declared storage').to.equal(100);
    });

    // A node with no reclaimable work registered must still answer, so the
    // caller can tell "nothing to reclaim" from "reclaim failed".
    it('answers false when nothing has registered', async () => {
      expect(await admissionControl.requestReclaim(paidapp.resourceTotals())).to.equal(false);
    });
  });
});
