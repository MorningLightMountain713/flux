'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');

const {
  FlapLadder,
  DIAL_PLAN,
  FLAP_TRIP,
  FLAP_WINDOW_BLOCKS,
  CLEAN_LADDER_BLOCKS,
  FULL_RESET_BLOCKS,
  MASS_DROP_DUTIES,
  MASS_DROP_SPAN_BLOCKS,
} = require('../../ZelBack/src/services/utils/flapLadder');

// The mild tier's counters, driven by hand: every observation carries the
// height the world had when it was made, and nothing here ticks.
function makeLadder() {
  const world = { height: 1000 };
  world.ladder = new FlapLadder({ currentHeight: () => world.height });
  world.cycle = (outpoint) => {
    world.ladder.noteDrop(outpoint);
    world.height += 1;
    world.ladder.noteReturn(outpoint);
  };
  world.cyclesInWindow = (outpoint, count) => {
    for (let i = 0; i < count; i += 1) {
      world.cycle(outpoint);
      world.height += 1;
    }
  };
  return world;
}

describe('flapLadder — the mild tier, local by rule', () => {
  it('the stamped constants: trip at 4 in 90, ladder 30→480, full reset 640', () => {
    expect(FLAP_TRIP).to.equal(4);
    expect(FLAP_WINDOW_BLOCKS).to.equal(90);
    expect(CLEAN_LADDER_BLOCKS).to.deep.equal([30, 60, 120, 240, 480]);
    expect(FULL_RESET_BLOCKS).to.equal(640);
  });

  it('three cycles inside the window trip nothing; the fourth damps the duty', () => {
    const world = makeLadder();
    world.cyclesInWindow('x:0', 3);
    expect(world.ladder.dialPlan('x:0')).to.equal(DIAL_PLAN.EAGER);
    world.cycle('x:0');
    expect(world.ladder.dialPlan('x:0')).to.equal(DIAL_PLAN.LAZY);
    expect(world.ladder.snapshot('x:0').rung).to.equal(1);
  });

  it('cycles older than the window fall out: four spread past it never trip', () => {
    const world = makeLadder();
    world.cycle('x:0');
    world.height += 40;
    world.cycle('x:0');
    world.height += 40;
    world.cycle('x:0');
    world.height += 40;
    world.cycle('x:0');
    expect(world.ladder.dialPlan('x:0')).to.equal(DIAL_PLAN.EAGER);
  });

  it('a release is not a flapper: at least three duties and at least half of those held dropping in one span count for nothing', () => {
    const world = makeLadder();
    const fleet = Array.from({ length: MASS_DROP_DUTIES }, (unused, i) => `d${i}:0`);
    for (let round = 0; round < FLAP_TRIP; round += 1) {
      fleet.forEach((outpoint) => world.ladder.noteDrop(outpoint, 6)); // three of six held
      world.height += 1;
      fleet.forEach((outpoint) => world.ladder.noteReturn(outpoint));
      world.height += 1;
    }
    fleet.forEach((outpoint) => expect(world.ladder.dialPlan(outpoint)).to.equal(DIAL_PLAN.EAGER));
    // the same duty flapping alone, clear of the release span, is still caught
    world.height += MASS_DROP_SPAN_BLOCKS + 1;
    world.cyclesInWindow('d0:0', FLAP_TRIP);
    expect(world.ladder.dialPlan('d0:0')).to.equal(DIAL_PLAN.LAZY);
  });

  it('three duties dropping together out of fourteen held is not a release: each cycle counts', () => {
    const world = makeLadder();
    const fleet = Array.from({ length: MASS_DROP_DUTIES }, (unused, i) => `d${i}:0`);
    for (let round = 0; round < FLAP_TRIP; round += 1) {
      fleet.forEach((outpoint) => world.ladder.noteDrop(outpoint, 14));
      world.height += 1;
      fleet.forEach((outpoint) => world.ladder.noteReturn(outpoint));
      world.height += 1;
    }
    fleet.forEach((outpoint) => expect(world.ladder.dialPlan(outpoint)).to.equal(DIAL_PLAN.LAZY));
  });

  it('two duties dropping together out of two held is not a release either: three is the floor', () => {
    const world = makeLadder();
    const pair = ['d0:0', 'd1:0'];
    for (let round = 0; round < FLAP_TRIP; round += 1) {
      pair.forEach((outpoint) => world.ladder.noteDrop(outpoint, 2));
      world.height += 1;
      pair.forEach((outpoint) => world.ladder.noteReturn(outpoint));
      world.height += 1;
    }
    pair.forEach((outpoint) => expect(world.ladder.dialPlan(outpoint)).to.equal(DIAL_PLAN.LAZY));
  });

  it('the clean-period ladder: 30 clean blocks lift the first trip, the second needs 60', () => {
    const world = makeLadder();
    world.cyclesInWindow('x:0', FLAP_TRIP);
    const tripped = world.height - 1; // the last return
    world.height = tripped + 29;
    expect(world.ladder.dialPlan('x:0')).to.equal(DIAL_PLAN.LAZY);
    world.height = tripped + 30;
    expect(world.ladder.dialPlan('x:0')).to.equal(DIAL_PLAN.EAGER);

    world.cyclesInWindow('x:0', FLAP_TRIP);
    const again = world.height - 1;
    expect(world.ladder.snapshot('x:0')).to.include({ rung: 2, requiredClean: 60 });
    world.height = again + 59;
    expect(world.ladder.dialPlan('x:0')).to.equal(DIAL_PLAN.LAZY);
    world.height = again + 60;
    expect(world.ladder.dialPlan('x:0')).to.equal(DIAL_PLAN.EAGER);
  });

  it('the ladder caps at 480 and a still-flapping node never accumulates its clean period', () => {
    const world = makeLadder();
    for (let trip = 0; trip < 6; trip += 1) {
      world.cyclesInWindow('x:0', FLAP_TRIP);
      world.height += 480;
    }
    world.cyclesInWindow('x:0', FLAP_TRIP);
    expect(world.ladder.snapshot('x:0')).to.include({ rung: 5, requiredClean: 480 });
    const last = world.height - 1; // the trip's last return
    world.height = last + 478;
    world.cycle('x:0'); // returns at 479 clean, a block short of the lift: the clean count restarts
    world.height = last + 479 + 479;
    expect(world.ladder.snapshot('x:0').damped).to.equal(true);
    world.height += 1;
    expect(world.ladder.dialPlan('x:0')).to.equal(DIAL_PLAN.EAGER);
  });

  it('a full 640 clean blocks start the ladder from the bottom', () => {
    const world = makeLadder();
    world.cyclesInWindow('x:0', FLAP_TRIP);
    world.height += 60;
    world.cyclesInWindow('x:0', FLAP_TRIP);
    expect(world.ladder.snapshot('x:0').rung).to.equal(2);
    world.height += FULL_RESET_BLOCKS;
    world.cyclesInWindow('x:0', FLAP_TRIP);
    expect(world.ladder.snapshot('x:0')).to.include({ rung: 1, requiredClean: 30 });
  });

  it('the floor dial: a damped duty is due once per window, and contact resets the clock', () => {
    const world = makeLadder();
    // four trips, so the hold (240 clean blocks) outlasts two windows
    world.cyclesInWindow('x:0', FLAP_TRIP);
    world.height += 30;
    world.cyclesInWindow('x:0', FLAP_TRIP);
    world.height += 60;
    world.cyclesInWindow('x:0', FLAP_TRIP);
    world.height += 120;
    world.cyclesInWindow('x:0', FLAP_TRIP);
    expect(world.ladder.snapshot('x:0')).to.include({ rung: 4, requiredClean: 240 });
    const contact = world.height - 1; // the last return is the last contact
    world.height = contact + FLAP_WINDOW_BLOCKS - 1;
    expect(world.ladder.dialPlan('x:0')).to.equal(DIAL_PLAN.LAZY);
    world.height = contact + FLAP_WINDOW_BLOCKS;
    expect(world.ladder.dialPlan('x:0')).to.equal(DIAL_PLAN.DUE);

    world.ladder.noteContact('x:0');
    expect(world.ladder.dialPlan('x:0')).to.equal(DIAL_PLAN.LAZY);
    world.height += FLAP_WINDOW_BLOCKS;
    expect(world.ladder.dialPlan('x:0')).to.equal(DIAL_PLAN.DUE);
  });

  it('retain keeps only the duties still owed', () => {
    const world = makeLadder();
    world.cyclesInWindow('x:0', FLAP_TRIP);
    world.cyclesInWindow('y:0', FLAP_TRIP);
    world.ladder.retain(new Set(['y:0']));
    expect(world.ladder.snapshot('x:0').rung).to.equal(0);
    expect(world.ladder.snapshot('y:0').rung).to.equal(1);
  });

  it('a duty never observed is eager, and a forgotten one starts over', () => {
    const world = makeLadder();
    expect(world.ladder.dialPlan('x:0')).to.equal(DIAL_PLAN.EAGER);
    world.cyclesInWindow('x:0', FLAP_TRIP);
    world.ladder.forget('x:0');
    expect(world.ladder.dialPlan('x:0')).to.equal(DIAL_PLAN.EAGER);
    expect(world.ladder.snapshot('x:0')).to.deep.equal({
      cycles: 0, rung: 0, damped: false, lastContact: null, requiredClean: null,
    });
  });
});
