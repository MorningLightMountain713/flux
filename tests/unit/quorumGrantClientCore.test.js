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
  recoverOutcome,
  timingIsSafe,
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

  // The one inequality the whole plane rests on, and until 2026-08-28 the code
  // stated it in a comment and never checked it. The holder stops at
  // safeUntil + slack and then takes the container down; a challenger may be
  // granted at the grantors' expiry + lockDelay. If the stop is not finished
  // first, both are running.
  describe('the timing inequality - slack + stop < lock-delay', () => {
    it('accepts the shipped values', () => {
      const out = timingIsSafe({ demotionSlackMs: 15_000, hardStopMs: 2_000, lockDelayMs: 30_000 });
      expect(out.safe).to.equal(true);
      expect(out.marginMs).to.equal(13_000);
    });

    it('accepts what every harness suite sets', () => {
      expect(timingIsSafe({ demotionSlackMs: 5_000, hardStopMs: 2_000, lockDelayMs: 10_000 }).safe).to.equal(true);
    });

    it('REFUSES a slack that leaves no room for the stop', () => {
      const out = timingIsSafe({ demotionSlackMs: 28_000, hardStopMs: 2_000, lockDelayMs: 30_000 });
      expect(out.safe).to.equal(false);
      expect(out.marginMs).to.equal(0);
    });

    it('REFUSES a slack past the lock-delay outright', () => {
      expect(timingIsSafe({ demotionSlackMs: 40_000, hardStopMs: 2_000, lockDelayMs: 30_000 }).safe).to.equal(false);
    });

    // STRICT, not <=. At equality the stop and the challenger's grant race in
    // continuous time; the model works in whole ticks and cannot see that.
    it('REFUSES equality - the two events race at the boundary', () => {
      const out = timingIsSafe({ demotionSlackMs: 28_000, hardStopMs: 2_000, lockDelayMs: 30_000 });
      expect(out.safe).to.equal(false);
    });

    // Lowering the lock-delay is the regression this exists to catch: it is the
    // only value carrying the clock-rate-skew budget now.
    it('REFUSES a lock-delay lowered under the shipped slack', () => {
      expect(timingIsSafe({ demotionSlackMs: 15_000, hardStopMs: 2_000, lockDelayMs: 15_000 }).safe).to.equal(false);
    });

    it('names every term it used, so a refusal is actionable', () => {
      const out = timingIsSafe({ demotionSlackMs: 40_000, hardStopMs: 2_000, lockDelayMs: 30_000 });
      expect(out.reason).to.contain('40000');
      expect(out.reason).to.contain('2000');
      expect(out.reason).to.contain('30000');
    });
  });

  // A restarted holder re-learns its term from the grantors, and every rule
  // below was forced by a violation trace in formal/held-term-lifecycle. The
  // shape a reply carries is what GET /flux/quorumgrant/record answers:
  // { grantee, epoch, remainingMs } - a DURATION on the grantor's own clock,
  // never a deadline, because a deadline crossing machines is exactly what §7
  // forbids and what defect D4 was.
  describe('term recovery from a quorum of registers', () => {
    const SELF = `${'a'.repeat(64)}:0`;
    const OTHER = `${'b'.repeat(64)}:0`;

    it('recovers when a quorum names this node at ONE epoch', () => {
      const out = recoverOutcome([
        { grantee: SELF, epoch: 4, remainingMs: 90_000 },
        { grantee: SELF, epoch: 4, remainingMs: 80_000 },
        { grantee: SELF, epoch: 4, remainingMs: 95_000 },
      ], SELF, 2, 200);
      expect(out.recovered).to.equal(true);
      expect(out.epoch).to.equal(4);
    });

    // R1. A round that reached ONE grantor and then died leaves an orphan row
    // naming a node that never won. Recovering from it seated a SECOND writer
    // beside a legitimate master at depth 18. This is also why local
    // persistence is the wrong primitive: a local file is one record.
    it('REFUSES a single record even when nothing contradicts it', () => {
      const out = recoverOutcome([
        { grantee: SELF, epoch: 4, remainingMs: 90_000 },
      ], SELF, 2, 200);
      expect(out.recovered).to.equal(false);
      expect(out.reason).to.match(/quorum/i);
    });

    it('REFUSES when the naming rows do not agree on one epoch', () => {
      const out = recoverOutcome([
        { grantee: SELF, epoch: 4, remainingMs: 90_000 },
        { grantee: SELF, epoch: 5, remainingMs: 90_000 },
      ], SELF, 2, 200);
      expect(out.recovered).to.equal(false);
      expect(out.reason).to.match(/epoch/i);
    });

    it('REFUSES when the quorum names somebody else', () => {
      const out = recoverOutcome([
        { grantee: OTHER, epoch: 4, remainingMs: 90_000 },
        { grantee: OTHER, epoch: 4, remainingMs: 90_000 },
      ], SELF, 2, 200);
      expect(out.recovered).to.equal(false);
    });

    // The EARLIEST expiry in the quorum bounds the term: it is live only while
    // a quorum still says so, so the shortest remainder is the real one.
    it('takes the SHORTEST remainder in the quorum, not the longest', () => {
      const out = recoverOutcome([
        { grantee: SELF, epoch: 4, remainingMs: 90_000 },
        { grantee: SELF, epoch: 4, remainingMs: 40_000 },
        { grantee: SELF, epoch: 4, remainingMs: 95_000 },
      ], SELF, 2, 0);
      expect(out.safeForMs).to.equal(40_000);
    });

    // D4. The grantor computed remainingMs at an unknown instant inside the
    // read window, so the only sound assumption is the earliest one: the whole
    // round trip is already spent. Without this the recovered deadline outlives
    // the grantor's expiry and the model produced two writers at EVERY margin -
    // the flaw is the cross-machine conversion, not the size of any gap.
    it('discounts the measured round trip before the duration lands locally', () => {
      const out = recoverOutcome([
        { grantee: SELF, epoch: 4, remainingMs: 10_000 },
        { grantee: SELF, epoch: 4, remainingMs: 10_000 },
      ], SELF, 2, 1_500);
      expect(out.safeForMs).to.equal(8_500);
    });

    // The model's MinOf({SafeRemaining}) > 0: a recovery whose discounted
    // remainder is zero refuses rather than adopting a term it cannot serve.
    it('REFUSES when the discounted remainder is gone', () => {
      const out = recoverOutcome([
        { grantee: SELF, epoch: 4, remainingMs: 400 },
        { grantee: SELF, epoch: 4, remainingMs: 400 },
      ], SELF, 2, 900);
      expect(out.recovered).to.equal(false);
      expect(out.reason).to.match(/remain/i);
    });

    it('REFUSES on no replies at all - silence is not a term', () => {
      const out = recoverOutcome([], SELF, 2, 200);
      expect(out.recovered).to.equal(false);
    });

    // A row whose remainder the grantor reports as already gone cannot count
    // toward the quorum that says the term is live.
    it('does not count a lapsed row toward the quorum', () => {
      const out = recoverOutcome([
        { grantee: SELF, epoch: 4, remainingMs: 90_000 },
        { grantee: SELF, epoch: 4, remainingMs: 0 },
      ], SELF, 2, 0);
      expect(out.recovered).to.equal(false);
      // the REASON is the assertion. Counting the lapsed row and then failing
      // the zero-remainder guard also yields recovered:false, so asserting
      // only that cannot tell the two apart - and did not, under mutation.
      expect(out.reason).to.match(/quorum/i);
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
