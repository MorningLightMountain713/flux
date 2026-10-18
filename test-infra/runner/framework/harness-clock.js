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
//
// Each node reads a file of its own: the suite's offset plus that node's skew,
// zero until setNodeClockSkew sets one. A skewed node is a node whose clock is
// wrong - it judges every message by its own time, and stamps what it sends
// with it - while the chain, the stubs and every other node keep the suite's.

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { advanceBlock } from './daemon-control.js';

// Where each image installs the library (test-infra Dockerfiles).
const LIBFAKETIME = '/usr/local/lib/libfaketime.so.1';
const MOUNT = '/harness-clock';
// How long a shifted process keeps an offset before reading the file again.
// libfaketime counts it in whole seconds, so a process reads a new offset up
// to twice this after it is written.
const REREAD_SECONDS = 1;

let offsetSeconds = 0;
let dir = null;
// Every node's skew by its index, a node entered when its container is made.
const skewSeconds = new Map();

/** The time on the suite's clock, ms: the wall clock plus every advance. */
export function harnessNow() {
  return Date.now() + offsetSeconds * 1000;
}

/** The time on node `index`'s clock, ms: the suite's plus the node's skew. */
export function harnessNodeNow(index) {
  return harnessNow() + (skewSeconds.get(index) ?? 0) * 1000;
}

function writeFile(name, seconds) {
  const next = join(dir, `${name}.next`);
  writeFileSync(next, `${seconds < 0 ? '-' : '+'}${Math.abs(seconds)}\n`);
  renameSync(next, join(dir, name));
}

function nodeFile(index) {
  return `node-${index}`;
}

function writeOffset() {
  writeFile('offset', offsetSeconds);
  for (const [index, skew] of skewSeconds) writeFile(nodeFile(index), offsetSeconds + skew);
}

function settle() {
  return new Promise((resolve) => { setTimeout(resolve, 2 * REREAD_SECONDS * 1000 + 500); });
}

/**
 * The clock a new env runs on: null, and the runner back on the wall clock,
 * for a suite without one; otherwise the bind mount and the environment that
 * put a container on it: `environment` for a stub, `nodeEnvironment(index)`
 * for node `index`.
 *
 * @param {string} networkName - the env's network, which names the clock's directory
 * @param {boolean} enabled
 * @returns {?{bindMount: object, environment: object, nodeEnvironment: (index: number) => object}}
 */
export function harnessClockFor(networkName, enabled) {
  offsetSeconds = 0;
  dir = null;
  skewSeconds.clear();
  if (!enabled) return null;
  dir = join(tmpdir(), `flux-harness-clock-${networkName}`);
  mkdirSync(dir, { recursive: true });
  writeOffset();
  const environment = (file) => ({
    LD_PRELOAD: LIBFAKETIME,
    FAKETIME_TIMESTAMP_FILE: `${MOUNT}/${file}`,
    FAKETIME_CACHE_DURATION: String(REREAD_SECONDS),
    DONT_FAKE_MONOTONIC: '1',
  });
  return {
    bindMount: { source: dir, target: MOUNT, mode: 'ro' },
    environment: environment('offset'),
    nodeEnvironment(index) {
      if (!skewSeconds.has(index)) {
        skewSeconds.set(index, 0);
        writeFile(nodeFile(index), offsetSeconds);
      }
      return environment(nodeFile(index));
    },
  };
}

/**
 * Set node `index`'s clock `seconds` ahead of the suite's (behind when
 * negative; 0 puts it back). The node reads it within two re-read periods;
 * nothing else moves.
 *
 * @param {number} index - the node's index in the env
 * @param {number} seconds - a whole number
 * @returns {Promise<number>} the node's time after the change, ms
 */
export async function setNodeClockSkew(index, seconds) {
  if (dir === null) throw new Error('setNodeClockSkew: this suite has no harness clock - createTestEnv({ harnessClock: true })');
  if (!skewSeconds.has(index)) throw new Error(`setNodeClockSkew: node ${index} is not on this suite's clock`);
  if (!Number.isSafeInteger(seconds)) throw new Error(`setNodeClockSkew: ${seconds} is not a whole number of seconds`);
  skewSeconds.set(index, seconds);
  writeFile(nodeFile(index), offsetSeconds + seconds);
  await settle();
  return harnessNodeNow(index);
}

/**
 * Move the suite's clock forward: every shifted process reads the new time
 * within two re-read periods, and with `mine` one block is made so the chain's
 * tip carries it.
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
  await settle();
  if (mine) await advanceBlock();
  return harnessNow();
}
