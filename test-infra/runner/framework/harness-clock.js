// One clock for a suite's chain, nodes and signer.
//
// A suite created with `harnessClock: true` shares an offset file with every
// node and with the daemon, peer and FluxDrive stubs. libfaketime, preloaded in
// those processes, shifts their wall clock by the offset, re-reading the file
// every second, and leaves their monotonic clock alone, so timers and durations
// run as before. The daemon stamps each block when it is made, so the chain's
// time moves with the nodes'. The runner is not shifted: it signs at
// harnessNow().
//
// FluxOS judges a message against both clocks - its timestamp against the
// node's wall clock at the door, its payment against the block stamps - so a
// suite that moves time moves all of them at once, as a real network lives
// through a month.

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { advanceBlock } from './daemon-control.js';

// Where each image installs the library (test-infra Dockerfiles).
const LIBFAKETIME = '/usr/local/lib/libfaketime.so.1';
const MOUNT = '/harness-clock';
// How long a shifted process keeps an offset before reading the file again.
const REREAD_SECONDS = 1;

let offsetSeconds = 0;
let dir = null;

/** The time on the suite's clock, ms: the wall clock plus every advance. */
export function harnessNow() {
  return Date.now() + offsetSeconds * 1000;
}

function writeOffset() {
  const next = join(dir, 'offset.next');
  writeFileSync(next, `+${offsetSeconds}\n`);
  renameSync(next, join(dir, 'offset'));
}

/**
 * The clock a new env runs on: null, and the runner back on the wall clock,
 * for a suite without one; otherwise the bind mount and the environment that
 * put a container on it.
 *
 * @param {string} networkName - the env's network, which names the clock's directory
 * @param {boolean} enabled
 * @returns {?{bindMount: object, environment: object}}
 */
export function harnessClockFor(networkName, enabled) {
  offsetSeconds = 0;
  dir = null;
  if (!enabled) return null;
  dir = join(tmpdir(), `flux-harness-clock-${networkName}`);
  mkdirSync(dir, { recursive: true });
  writeOffset();
  return {
    bindMount: { source: dir, target: MOUNT, mode: 'ro' },
    environment: {
      LD_PRELOAD: LIBFAKETIME,
      FAKETIME_TIMESTAMP_FILE: `${MOUNT}/offset`,
      FAKETIME_CACHE_DURATION: String(REREAD_SECONDS),
      DONT_FAKE_MONOTONIC: '1',
    },
  };
}

/**
 * Move the suite's clock forward: every shifted process reads the new time
 * within a second, and with `mine` one block is made so the chain's tip carries
 * it.
 *
 * @param {number} seconds - a positive whole number; the clock never goes back
 * @param {{mine?: boolean}} [options]
 * @returns {Promise<number>} the suite's time after the advance, ms
 */
export async function advanceHarnessClock(seconds, { mine = true } = {}) {
  if (dir === null) throw new Error('advanceHarnessClock: this suite has no harness clock - createTestEnv({ harnessClock: true })');
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error(`advanceHarnessClock: ${seconds} is not a positive whole number of seconds`);
  offsetSeconds += seconds;
  writeOffset();
  await new Promise((resolve) => { setTimeout(resolve, REREAD_SECONDS * 1000 + 500); });
  if (mine) await advanceBlock();
  return harnessNow();
}
