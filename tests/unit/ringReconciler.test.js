'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');

const { RingReconciler } = require('../../ZelBack/src/services/utils/ringReconciler');
const { FlapLadder, DIAL_PLAN, FLAP_WINDOW_BLOCKS } = require('../../ZelBack/src/services/utils/flapLadder');

const tick = () => new Promise((resolve) => { setImmediate(() => setImmediate(resolve)); });

// Every side effect faked: dials resolve only when the test says so, so the
// pending/connected/failed accounting is driven explicitly.
function makeWorld({ duties = [], jury = [], successors = [] } = {}) {
  const world = {
    duties: [...duties],
    jury: [...jury],
    successors: [...successors],
    held: new Map(), // socketAddress -> 'outbound' | 'inbound'
    dials: [], // { socketAddress, witness, resolve }
    asks: [],
    drops: [],
    backoff: new Set(),
    inbound: 0,
    listed: true,
  };
  const asNodes = (outpoints) => outpoints.map((outpoint) => ({ outpoint }));
  world.deps = {
    topology: () => ({
      duties: () => (world.listed ? asNodes(world.duties) : null),
      jury: () => asNodes(world.jury),
      ringSuccessors: (me, want, exclude) => {
        const picked = [];
        world.successors.forEach((outpoint) => {
          if (picked.length >= want || exclude.has(outpoint)) return;
          exclude.add(outpoint);
          picked.push({ outpoint });
        });
        return picked;
      },
    }),
    myOutpoint: () => 'me:0',
    resolveOutpoint: (outpoint) => `addr-${outpoint}`,
    isHeld: (socketAddress) => world.held.has(socketAddress),
    heldDirection: (socketAddress) => world.held.get(socketAddress) || null,
    mayDial: (socketAddress) => !world.backoff.has(socketAddress),
    dial: (socketAddress, { witness }) => new Promise((resolve) => {
      world.dials.push({ socketAddress, witness, resolve });
    }),
    drop: (socketAddress) => {
      world.drops.push(socketAddress);
      world.held.delete(socketAddress);
    },
    ask: (socketAddress) => world.asks.push(socketAddress),
    inboundCount: () => world.inbound,
  };
  return world;
}

function makeReconciler(world, options = {}) {
  const reconciler = new RingReconciler(world.deps, {
    sweepIntervalMs: 3_600_000,
    ...options,
  });
  reconciler.start();
  return reconciler;
}

describe('ringReconciler', () => {
  let reconciler;
  afterEach(() => { if (reconciler) reconciler.stop(); });

  it('dials every unheld duty as a witness and reconciles against held PEERS, either direction', async () => {
    const world = makeWorld({ duties: ['a:0', 'b:0', 'c:0', 'd:0'] });
    world.inbound = 99; // silence the ask path
    world.held.set('addr-b:0', 'outbound');
    world.held.set('addr-c:0', 'inbound');
    reconciler = makeReconciler(world);
    await tick();

    expect(world.dials.map((d) => d.socketAddress).sort()).to.deep.equal(['addr-a:0', 'addr-d:0']);
    world.dials.forEach((d) => expect(d.witness).to.equal(true));
    const snap = reconciler.snapshot();
    expect(snap.duties['b:0']).to.equal('connected');
    expect(snap.duties['c:0']).to.equal('connected');
    expect(snap.duties['a:0']).to.equal('pending');
  });

  it('pending dials count toward the floor — no top-up fires while they are in flight', async () => {
    const duties = Array.from({ length: 12 }, (_, i) => `d${i}:0`);
    const world = makeWorld({ duties, successors: ['s1:0', 's2:0'] });
    world.inbound = 99;
    reconciler = makeReconciler(world);
    await tick();

    expect(world.dials.length).to.equal(12);
    world.dials.forEach((d) => expect(d.witness).to.equal(true));
    expect(reconciler.snapshot().outboundStanding).to.equal(12);
  });

  it('a resolved failure discounts from the floor and the top-up walks PAST the corpse', async () => {
    const world = makeWorld({
      duties: ['d1:0', 'd2:0', 'd3:0', 'd4:0'],
      successors: ['d1:0', 's1:0', 's2:0', 's3:0'],
    });
    world.inbound = 99;
    reconciler = makeReconciler(world, { floor: 4 });
    await tick();
    expect(world.dials.length).to.equal(4); // all duties pending, no shortfall

    // two duties resolve failed; their dial resolution is the trigger
    world.held.set('addr-d3:0', 'outbound');
    world.held.set('addr-d4:0', 'outbound');
    world.dials[0].resolve(false);
    world.dials[1].resolve(false);
    world.dials[2].resolve(true);
    world.dials[3].resolve(true);
    await tick();
    await tick();

    // the corpses are still owed their duty dials (witness), but they no
    // longer count: the shortfall fires and the top-ups walk PAST them
    const after = world.dials.slice(4).map((d) => [d.socketAddress, d.witness]).sort();
    expect(after).to.deep.equal([
      ['addr-d1:0', true],
      ['addr-d2:0', true],
      ['addr-s1:0', false],
      ['addr-s2:0', false],
    ]);
  });

  it('a duty held INBOUND clears no gate: it is not dialed, and the floor tops up past it', async () => {
    const world = makeWorld({ duties: ['x:0', 'y:0', 'z:0'], successors: ['s1:0'] });
    world.inbound = 99;
    world.held.set('addr-x:0', 'outbound');
    world.held.set('addr-y:0', 'inbound');
    world.held.set('addr-z:0', 'outbound');
    reconciler = makeReconciler(world, { floor: 3 });
    await tick();

    expect(world.dials.map((d) => d.socketAddress)).to.deep.equal(['addr-s1:0']);
    expect(world.dials[0].witness).to.equal(false);
  });

  it('releases top-ups hysteretically: only what stands above floor + margin, never on recovery alone', async () => {
    const world = makeWorld({ duties: ['x:0'], successors: ['s1:0', 's2:0'] });
    world.inbound = 99;
    world.held.set('addr-x:0', 'outbound');
    reconciler = makeReconciler(world, { floor: 3, releaseMargin: 1 });
    await tick();

    // shortfall 2 → both successors dialed; connect them
    expect(world.dials.map((d) => d.socketAddress)).to.deep.equal(['addr-s1:0', 'addr-s2:0']);
    world.held.set('addr-s1:0', 'outbound');
    world.held.set('addr-s2:0', 'outbound');
    world.dials[0].resolve(true);
    world.dials[1].resolve(true);
    await tick();

    // standing 3 = floor, under floor+margin: nothing released
    await reconciler.schedule('test');
    expect(world.drops).to.deep.equal([]);

    // three more duties connect: standing 6, floor+margin 4 → two top-ups go
    world.duties.push('y:0', 'z:0', 'w:0');
    world.held.set('addr-y:0', 'outbound');
    world.held.set('addr-z:0', 'outbound');
    world.held.set('addr-w:0', 'outbound');
    await reconciler.schedule('test');
    expect(world.drops.sort()).to.deep.equal(['addr-s1:0', 'addr-s2:0']);
    expect(Object.keys(reconciler.snapshot().topups)).to.deep.equal([]);
  });

  it('asks unheld jury members when inbound is short, and stops when it is not', async () => {
    const world = makeWorld({ jury: ['j1:0', 'j2:0', 'j3:0'] });
    world.inbound = 3;
    world.held.set('addr-j2:0', 'inbound');
    reconciler = makeReconciler(world);
    await tick();
    expect(world.asks.sort()).to.deep.equal(['addr-j1:0', 'addr-j3:0']);

    world.asks.length = 0;
    world.inbound = 12;
    await reconciler.schedule('test');
    expect(world.asks).to.deep.equal([]);
  });

  it('a node off the list owes nothing and dials nothing', async () => {
    const world = makeWorld({ duties: ['a:0'], successors: ['s1:0'] });
    world.listed = false;
    reconciler = makeReconciler(world);
    await tick();
    expect(world.dials).to.deep.equal([]);
    expect(world.asks).to.deep.equal([]);
  });

  it('respects the per-target backoff: no dial, the duty discounts, the walk substitutes', async () => {
    const world = makeWorld({ duties: ['a:0'], successors: ['s1:0'] });
    world.inbound = 99;
    world.backoff.add('addr-a:0');
    reconciler = makeReconciler(world, { floor: 1 });
    await tick();

    expect(world.dials.map((d) => d.socketAddress)).to.deep.equal(['addr-s1:0']);
    expect(reconciler.snapshot().duties['a:0']).to.equal('failed');
  });

  it('a certified-down duty leaves the dial plan and a substitute covers its slot', async () => {
    const world = makeWorld({ duties: ['a:0', 'b:0'], successors: ['s1:0'] });
    world.inbound = 99;
    world.held.set('addr-b:0', 'outbound');
    const stood = new Set(['a:0']);
    world.deps.stoodDown = (outpoint) => Promise.resolve(stood.has(outpoint));
    reconciler = makeReconciler(world, { floor: 2 });
    await tick();

    // a is never dialed; the shortfall its absence opens is covered non-witness
    expect(world.dials.map((d) => [d.socketAddress, d.witness]))
      .to.deep.equal([['addr-s1:0', false]]);
    expect(reconciler.snapshot().duties['a:0']).to.equal('stood_down');

    // the subject returns (record cleared): the duty is dialed again
    stood.clear();
    await reconciler.schedule('cleared');
    expect(world.dials.some((d) => d.socketAddress === 'addr-a:0' && d.witness)).to.equal(true);
  });

  it('a stood-down successor is never a top-up: the walk looks past it to the next', async () => {
    const world = makeWorld({ duties: ['a:0'], successors: ['s1:0', 's2:0', 's3:0'] });
    world.inbound = 99;
    const stood = new Set(['a:0', 's1:0']);
    world.deps.stoodDown = (outpoint) => Promise.resolve(stood.has(outpoint));
    reconciler = makeReconciler(world, { floor: 2 });
    await tick();
    await tick();

    // the duty is stood down, so the whole floor is a shortfall; s1 is held
    // out of the network and s2, s3 cover the two slots
    expect(world.dials.map((d) => [d.socketAddress, d.witness]).sort())
      .to.deep.equal([['addr-s2:0', false], ['addr-s3:0', false]]);
  });

  describe('the mild tier orders dials, never excludes a duty', () => {
    it('a damped duty is dialed lazily: not while the floor is short, yes once it is covered without it', async () => {
      const world = makeWorld({ duties: ['a:0', 'b:0'] });
      world.inbound = 99;
      world.deps.dialPlan = (outpoint) => (outpoint === 'a:0' ? DIAL_PLAN.LAZY : DIAL_PLAN.EAGER);
      reconciler = makeReconciler(world, { floor: 1 });
      await tick();
      expect(world.dials.map((d) => d.socketAddress)).to.deep.equal(['addr-b:0']);
      expect(reconciler.snapshot().duties['a:0']).to.equal('failed');

      // b connects: the floor is covered, so the damped duty gets its dial
      world.held.set('addr-b:0', 'outbound');
      world.dials[0].resolve(true);
      await tick();
      await reconciler.schedule('covered');
      expect(world.dials.map((d) => [d.socketAddress, d.witness])).to.deep.equal([['addr-b:0', true], ['addr-a:0', true]]);
    });

    it('a due duty is dialed whatever the floor says', async () => {
      const world = makeWorld({ duties: ['a:0', 'b:0'] });
      world.inbound = 99;
      world.deps.dialPlan = (outpoint) => (outpoint === 'a:0' ? DIAL_PLAN.DUE : DIAL_PLAN.EAGER);
      reconciler = makeReconciler(world, { floor: 5 });
      await tick();
      expect(world.dials.map((d) => d.socketAddress).sort()).to.deep.equal(['addr-a:0', 'addr-b:0']);
    });

    it('reports contact for every duty dialed or held, so the ladder\'s clock is the reconciler\'s', async () => {
      const world = makeWorld({ duties: ['a:0', 'b:0', 'c:0'] });
      world.inbound = 99;
      world.held.set('addr-b:0', 'inbound');
      world.backoff.add('addr-c:0');
      const contacts = [];
      world.deps.noteContact = (outpoint) => contacts.push(outpoint);
      reconciler = makeReconciler(world);
      await tick();
      expect(contacts.sort()).to.deep.equal(['a:0', 'b:0']);
    });

    // The harness obligation in unit form: a node parked at the deepest rung
    // and held stable is still dialed inside every window, so its watchers'
    // contact gap — the input the confirmation check runs on — never exceeds
    // W. The e2e replay asserts dosState never moves on a real fleet.
    it('a duty parked at the deepest rung, stable and unheld, is dialed at least once per window', async () => {
      const world = makeWorld({ duties: ['x:0', 'b:0'], successors: ['s1:0', 's2:0'] });
      world.inbound = 99;
      world.height = 1000;
      const ladder = new FlapLadder({ currentHeight: () => world.height });
      const flap = () => {
        ladder.noteDrop('x:0');
        world.height += 1;
        ladder.noteReturn('x:0');
        world.height += 1;
      };
      for (let trip = 0; trip < 5; trip += 1) {
        for (let i = 0; i < 4; i += 1) flap();
        world.height += 480;
      }
      for (let i = 0; i < 4; i += 1) flap();
      expect(ladder.snapshot('x:0')).to.include({ rung: 5, damped: true, requiredClean: 480 });
      // x drops for good this time and stays down: it never re-holds, the
      // floor is short (b alone), so every eager pass would have written x off
      ladder.noteDrop('x:0');

      world.deps.dialPlan = (outpoint) => ladder.dialPlan(outpoint);
      world.deps.noteContact = (outpoint) => ladder.noteContact(outpoint);
      reconciler = makeReconciler(world, { floor: 5 });
      const dialHeights = [];
      world.deps.dial = (socketAddress) => {
        if (socketAddress === 'addr-x:0') dialHeights.push(world.height);
        return Promise.resolve(false);
      };
      await tick();

      const start = world.height;
      while (world.height < start + 4 * FLAP_WINDOW_BLOCKS) {
        world.height += 7;
        await reconciler.schedule('block'); // eslint-disable-line no-await-in-loop
      }
      expect(dialHeights.length).to.be.at.least(4);
      const gaps = dialHeights.slice(1).map((at, i) => at - dialHeights[i]);
      gaps.forEach((gap) => expect(gap).to.be.at.most(FLAP_WINDOW_BLOCKS + 7));
      expect(ladder.snapshot('x:0').damped).to.equal(true); // still parked: the dials are the floor, not a lift
    });
  });

  it('coalesces schedules while a pass runs instead of stacking them', async () => {
    const world = makeWorld({ duties: ['a:0'] });
    world.inbound = 99;
    reconciler = makeReconciler(world);
    await tick();
    const dialsAfterStart = world.dials.length;
    await Promise.all([
      reconciler.schedule('one'),
      reconciler.schedule('two'),
      reconciler.schedule('three'),
    ]);
    await tick();
    // duty already pending: no duplicate dials however many schedules landed
    expect(world.dials.length).to.equal(dialsAfterStart);
  });
});
