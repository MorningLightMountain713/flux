// Unit tests for the framework itself, which the gate never runs: run-all.sh globs
// tests/*.js and npm test globs tests/**/*.js, so nothing under unit/ can be swept
// into a fleet run. `npm run test:unit`.
//
// node:test and node:assert, deliberately - no chai, no mocha, no .mocharc (which
// preloads the e2e failure-dump hook and with it the whole container stack). These
// run on a laptop with nothing installed, which is the point: a check on the
// harness must not be gated on the harness's own install state.
//
// The derivations here decide boot-time config for every suite that declares any
// physics, so a mistake in them is a mistake in several suites at once — and the
// failure it produces (a link declared dead, a premise that cannot be reached) does
// not look like a framework bug from the outside. That is what these pin.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  confirmationOffsetBlocks, wireRttMs, deriveTiming, validateTiming,
} from '../framework/timing.js';

const CTX = { initialHeight: 2100000 };

describe('framework timing derivation', () => {
  describe('confirmationOffsetBlocks', () => {
    it('reads the offset out of the node list the runner actually renders', () => {
      // Derived, not asserted as a constant: the point of the helper is that this
      // answer follows the fixture. A change to deterministic-list.json should move
      // every suite's window with it rather than making two comments wrong.
      const offset = confirmationOffsetBlocks(CTX.initialHeight);
      assert.equal(typeof offset, 'number');
      assert.ok(offset > 0, `offset should be positive, got ${offset}`);
    });

    it('refuses a tip below the seeded confirmation rather than deriving a negative window', () => {
      const offset = confirmationOffsetBlocks(CTX.initialHeight);
      assert.throws(() => confirmationOffsetBlocks(CTX.initialHeight - offset - 1), /AHEAD of the starting tip/);
    });
  });

  describe('wireRttMs', () => {
    it('counts the delay twice and includes the jitter, because shaping is per-egress', () => {
      assert.equal(wireRttMs('4000ms 200ms'), 8400);
      assert.equal(wireRttMs('80ms 20ms'), 200);
    });

    it('treats a missing jitter as zero', () => {
      assert.equal(wireRttMs('50ms'), 100);
    });

    it('refuses a spec it cannot read rather than shaping something unintended', () => {
      assert.throws(() => wireRttMs('4s'), /expected milliseconds/);
      assert.throws(() => wireRttMs('fast'), /expected milliseconds/);
    });
  });

  describe('deriveTiming', () => {
    it('is inert for a suite that declared nothing', () => {
      assert.deepEqual(deriveTiming(null, CTX), { overrides: {}, wire: null });
    });

    it('puts the liveness budget clear of the declared round trip', () => {
      const { overrides, wire } = deriveTiming({ wireLatency: { delay: '4000ms 200ms' } }, CTX);
      const { wsPingIntervalMs: ping, wsMaxMissedPongs: pongs } = overrides.peers;
      assert.ok(ping * pongs >= 3 * wireRttMs('4000ms 200ms'),
        `budget ${ping * pongs}ms must clear 3x the ${wireRttMs('4000ms 200ms')}ms round trip`);
      assert.deepEqual(wire, { delay: '4000ms 200ms' });
    });

    it('scales the budget with the wire rather than holding one constant', () => {
      const slow = deriveTiming({ wireLatency: { delay: '4000ms 200ms' } }, CTX).overrides.peers;
      const fast = deriveTiming({ wireLatency: { delay: '80ms 20ms' } }, CTX).overrides.peers;
      assert.ok(slow.wsPingIntervalMs > fast.wsPingIntervalMs,
        `a slower wire must buy a longer interval: ${slow.wsPingIntervalMs} vs ${fast.wsPingIntervalMs}`);
    });

    it('compresses the budget for a partitioning suite instead of raising it', () => {
      const { overrides } = deriveTiming({ partitions: true }, CTX);
      const { wsPingIntervalMs: ping, wsMaxMissedPongs: pongs } = overrides.peers;
      assert.ok(ping * pongs < 30000, `partition budget ${ping * pongs}ms should stay well inside the sever timeout`);
      assert.equal(pongs, 3);
    });

    it('refuses a suite that wants both, because one budget cannot serve both', () => {
      assert.throws(() => deriveTiming({ wireLatency: { delay: '80ms 20ms' }, partitions: true }, CTX), /cannot declare both/);
    });

    it('derives the confirmation window from the fixture offset plus what is owed', () => {
      const offset = confirmationOffsetBlocks(CTX.initialHeight);
      const { overrides } = deriveTiming({ confirmation: { blocksOwed: 1 } }, CTX);
      assert.equal(overrides.confirmation.confirmExpirationBlocks, offset + 1);
      assert.ok(overrides.confirmation.blockIntervalMs > 0);
    });

    it('refuses blocksOwed that would leave nothing owed to wait for', () => {
      assert.throws(() => deriveTiming({ confirmation: { blocksOwed: 0 } }, CTX), /positive integer/);
      assert.throws(() => deriveTiming({ confirmation: { blocksOwed: 1.5 } }, CTX), /positive integer/);
    });
  });

  describe('validateTiming', () => {
    const wire = { wireLatency: { delay: '4000ms 200ms' } };

    it('passes the config the derivation itself produced', () => {
      const { overrides } = deriveTiming(wire, CTX);
      assert.doesNotThrow(() => validateTiming(wire, overrides, CTX));
    });

    it('catches a suite override that drops the budget under the wire, naming both numbers', () => {
      assert.throws(() => validateTiming(wire, { peers: { wsPingIntervalMs: 2000, wsMaxMissedPongs: 2 } }, CTX),
        (e) => /8400ms/.test(e.message) && /4000ms \(2000 x 2\)/.test(e.message) && /declared dead/.test(e.message));
    });

    it('catches a budget so long a partitioning suite would sit waiting for sockets', () => {
      assert.throws(() => validateTiming({ partitions: true }, { peers: { wsPingIntervalMs: 30000, wsMaxMissedPongs: 3 } }, CTX),
        /waiting for sockets/);
    });

    it('catches a window the node list has already passed', () => {
      const offset = confirmationOffsetBlocks(CTX.initialHeight);
      assert.throws(() => validateTiming(
        { confirmation: { blocksOwed: 1 } },
        { confirmation: { confirmExpirationBlocks: offset } },
        CTX,
      ), /already expired/);
    });

    it('polices only what the suite declared', () => {
      // A suite with no declaration keeps whatever the fleet gives it - the check
      // exists to hold a declaration together, not to start governing suites that
      // never opted in and are green on their own numbers.
      assert.doesNotThrow(() => validateTiming(null, { peers: { wsPingIntervalMs: 1, wsMaxMissedPongs: 1 } }, CTX));
      assert.doesNotThrow(() => validateTiming({ partitions: true }, { peers: { wsPingIntervalMs: 2000, wsMaxMissedPongs: 3 } }, CTX));
    });
  });
});
