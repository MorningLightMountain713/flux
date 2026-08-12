'use strict';

const { expect } = require('chai');

const {
  nextEpoch,
  adoptFrom,
  highestEpochSeen,
  prepareOutcome,
  acceptOutcome,
  safeUntilMs,
  holderStateAt,
  coastVerdict,
} = require('../../ZelBack/src/services/quorumGrant/grantClientCore');
const { nowMs, Deadline } = require('../../ZelBack/src/services/utils/monotonicClock');

describe('monotonicClock', () => {
  it('advances and never steps backward across readings', () => {
    const a = nowMs();
    const b = nowMs();
    expect(b).to.be.at.least(a);
  });

  it('deadlines are arithmetic over an injectable origin', () => {
    const deadline = new Deadline(1000, 5000);
    expect(deadline.atMs).to.equal(6000);
    expect(deadline.expired(5999)).to.equal(false);
    expect(deadline.expired(6001)).to.equal(true);
    expect(deadline.remainingMs(5400)).to.equal(600);
    expect(deadline.remainingMs(7000)).to.equal(0);
  });
});

describe('quorumGrant grantClientCore', () => {
  describe('epochs and adoption', () => {
    it('proposes one past the highest epoch the world has taught', () => {
      expect(nextEpoch(0)).to.equal(1);
      expect(nextEpoch(7)).to.equal(8);
      expect(nextEpoch(undefined)).to.equal(1);
    });

    it('adopts the highest-epoch recorded grant, from refusals as readily as from promises', () => {
      const replies = [
        { ok: true, promised: true, accepted: { epoch: 2, grantee: 'a:0' } },
        { ok: false, code: 'superseded', accepted: { epoch: 6, grantee: 'b:0' } },
        { ok: true, promised: true, accepted: null },
      ];
      expect(adoptFrom(replies).grantee).to.equal('b:0');
    });

    it('adopts nothing from an unwritten world', () => {
      expect(adoptFrom([{ ok: true, promised: true, accepted: null }])).to.equal(null);
      expect(adoptFrom([])).to.equal(null);
    });

    it('the highest epoch counts promises and records alike', () => {
      const replies = [
        { ok: false, code: 'superseded', promisedEpoch: 9, accepted: null },
        { ok: true, promised: true, promisedEpoch: 3, accepted: { epoch: 5, grantee: 'a:0' } },
      ];
      expect(highestEpochSeen(replies)).to.equal(9);
    });
  });

  describe('round outcomes', () => {
    it('a prepare quorum is promises, not politeness', () => {
      const promise = { ok: true, promised: true, promisedEpoch: 4, accepted: null };
      const refusal = { ok: false, code: 'superseded', promisedEpoch: 8, accepted: null };
      expect(prepareOutcome([promise, promise, promise, refusal], 3).promised).to.equal(true);
      expect(prepareOutcome([promise, promise, refusal, refusal], 3).promised).to.equal(false);
      expect(prepareOutcome([promise, promise], 3).promised).to.equal(false);
    });

    it('carries the largest lock-delay any grantor taught', () => {
      const replies = [
        { ok: false, code: 'lock_delay', retryAfterMs: 4000 },
        { ok: false, code: 'lock_delay', retryAfterMs: 9000 },
        { ok: true, promised: true },
      ];
      expect(prepareOutcome(replies, 3).retryAfterMs).to.equal(9000);
    });

    it('granted means a quorum of durable accepts, nothing less', () => {
      const yes = { ok: true, accepted: { epoch: 3, grantee: 'a:0' } };
      const no = { ok: false, code: 'superseded', promisedEpoch: 5 };
      expect(acceptOutcome([yes, yes, yes], 3).granted).to.equal(true);
      expect(acceptOutcome([yes, yes, no], 3).granted).to.equal(false);
    });
  });

  describe('safe-until — the median rule', () => {
    it('is the quorum-th largest per-grantor expiry, counted from send', () => {
      const acks = [
        { sentMs: 1000, ttlMs: 60_000 }, // 61_000
        { sentMs: 5000, ttlMs: 60_000 }, // 65_000
        { sentMs: 9000, ttlMs: 60_000 }, // 69_000
        { sentMs: 13_000, ttlMs: 60_000 }, // 73_000
        { sentMs: 17_000, ttlMs: 60_000 }, // 77_000
      ];
      expect(safeUntilMs(acks, 3)).to.equal(69_000);
    });

    it('errs safe where the max and the mean err unsafe', () => {
      // Two fresh acks and three ancient ones: a quorum of grants is NOT live
      // late in the window, whatever the freshest two say.
      const acks = [
        { sentMs: 100_000, ttlMs: 60_000 }, // 160_000
        { sentMs: 99_000, ttlMs: 60_000 }, // 159_000
        { sentMs: 1000, ttlMs: 60_000 }, // 61_000
        { sentMs: 900, ttlMs: 60_000 }, // 60_900
        { sentMs: 800, ttlMs: 60_000 }, // 60_800
      ];
      const median = safeUntilMs(acks, 3);
      expect(median).to.equal(61_000);
      // the max (160_000) and the mean (~100_340) would both claim safety at
      // t=100_000; the median correctly does not
      expect(median).to.be.below(100_000);
    });

    it('fewer than a quorum of acks is no safety at all', () => {
      const acks = [
        { sentMs: 1000, ttlMs: 60_000 },
        { sentMs: 2000, ttlMs: 60_000 },
      ];
      expect(safeUntilMs(acks, 3)).to.equal(null);
      expect(safeUntilMs([], 3)).to.equal(null);
    });

    it('ignores malformed acks rather than counting them as live', () => {
      const acks = [
        { sentMs: 1000, ttlMs: 60_000 },
        { sentMs: NaN, ttlMs: 60_000 },
        { sentMs: 2000 },
      ];
      expect(safeUntilMs(acks, 2)).to.equal(null);
    });
  });

  describe('holder state', () => {
    it('held, jeopardy, lost — in that order and no other', () => {
      expect(holderStateAt(50, 100, 200)).to.equal('held');
      expect(holderStateAt(150, 100, 200)).to.equal('jeopardy');
      expect(holderStateAt(250, 100, 200)).to.equal('lost');
      expect(holderStateAt(50, null, 200)).to.equal('jeopardy');
      expect(holderStateAt(50, null, null)).to.equal('lost');
    });
  });

  describe('the witness coast — unanimity or demotion', () => {
    const deny = { quorumReachable: false, holding: false, acquiring: false };

    it('coasts only on every standby affirming', () => {
      const replies = new Map([['s1:0', deny], ['s2:0', deny]]);
      expect(coastVerdict(['s1:0', 's2:0'], replies).coast).to.equal(true);
    });

    it('one unaccounted-for standby is a possible challenger', () => {
      const replies = new Map([['s1:0', deny]]);
      const verdict = coastVerdict(['s1:0', 's2:0'], replies);
      expect(verdict.coast).to.equal(false);
      expect(verdict.reason).to.contain('s2:0');
      expect(verdict.reason).to.contain('unaccounted');
    });

    it('a standby that can reach quorum ends the coast', () => {
      const replies = new Map([
        ['s1:0', deny],
        ['s2:0', { quorumReachable: true, holding: false, acquiring: false }],
      ]);
      expect(coastVerdict(['s1:0', 's2:0'], replies).coast).to.equal(false);
    });

    it('a standby that holds or is acquiring ends the coast', () => {
      const holding = new Map([['s1:0', { quorumReachable: false, holding: true, acquiring: false }]]);
      const acquiring = new Map([['s1:0', { quorumReachable: false, holding: false, acquiring: true }]]);
      expect(coastVerdict(['s1:0'], holding).coast).to.equal(false);
      expect(coastVerdict(['s1:0'], acquiring).coast).to.equal(false);
    });

    it('an app with no standbys coasts on its own word', () => {
      // single-instance mastership: there is no possible challenger
      expect(coastVerdict([], new Map()).coast).to.equal(true);
    });
  });
});
