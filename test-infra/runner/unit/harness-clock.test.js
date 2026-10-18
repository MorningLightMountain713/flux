// What each container's clock reads is the file it is pointed at, so a wrong
// file here moves the wrong clock, or none, in every suite on the harness
// clock. These pin the files and the environment that names them.
// `npm run test:unit`.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  advanceHarnessClock, harnessClockFor, harnessNodeNow, harnessNow, setNodeClockSkew,
} from '../framework/harness-clock.js';

let clock;
const read = (name) => readFileSync(join(clock.bindMount.source, name), 'utf8');

describe('the harness clock', () => {
  beforeEach(() => {
    clock = harnessClockFor(`unit-${process.pid}-${Date.now()}`, true);
  });

  it('puts a stub on the suite\'s offset and a node on a file of its own', () => {
    assert.equal(clock.environment.FAKETIME_TIMESTAMP_FILE, '/harness-clock/offset');
    assert.equal(clock.nodeEnvironment(2).FAKETIME_TIMESTAMP_FILE, '/harness-clock/node-2');
    assert.equal(read('offset'), '+0\n');
    assert.equal(read('node-2'), '+0\n');
  });

  it('moves one node\'s clock by its skew and nothing else', async () => {
    clock.nodeEnvironment(0);
    clock.nodeEnvironment(2);
    await setNodeClockSkew(2, 3600);
    assert.equal(read('node-2'), '+3600\n');
    assert.equal(read('node-0'), '+0\n');
    assert.equal(read('offset'), '+0\n');
    assert.ok(Math.abs(harnessNodeNow(2) - harnessNow() - 3600000) < 1000);
  });

  it('carries a node\'s skew through an advance', async () => {
    clock.nodeEnvironment(0);
    clock.nodeEnvironment(2);
    await setNodeClockSkew(2, -120);
    await advanceHarnessClock(60, { mine: false });
    assert.equal(read('offset'), '+60\n');
    assert.equal(read('node-0'), '+60\n');
    assert.equal(read('node-2'), '-60\n');
  });

  it('puts a node back on the suite\'s clock with a skew of 0', async () => {
    clock.nodeEnvironment(1);
    await setNodeClockSkew(1, 600);
    await setNodeClockSkew(1, 0);
    assert.equal(read('node-1'), '+0\n');
  });

  it('refuses a node not on the clock and a skew that is not whole', async () => {
    clock.nodeEnvironment(1);
    await assert.rejects(setNodeClockSkew(4, 60), /node 4 is not on this suite's clock/);
    await assert.rejects(setNodeClockSkew(1, 1.5), /not a whole number/);
  });

  it('starts a new env with no skew', async () => {
    clock.nodeEnvironment(1);
    await setNodeClockSkew(1, 600);
    clock = harnessClockFor(`unit-${process.pid}-${Date.now()}-next`, true);
    await assert.rejects(setNodeClockSkew(1, 60), /node 1 is not on this suite's clock/);
    clock.nodeEnvironment(1);
    assert.equal(read('node-1'), '+0\n');
  });

  it('refuses a skew in a suite with no harness clock', async () => {
    assert.equal(harnessClockFor('unit-off', false), null);
    await assert.rejects(setNodeClockSkew(0, 60), /no harness clock/);
  });
});
