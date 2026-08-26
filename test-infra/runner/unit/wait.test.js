// Framework unit tests: node:test, no chai/mocha/.mocharc, no fleet. `npm run test:unit`.
//
// waitFor's contract is the one every suite leans on and none of them state, so it is
// pinned here rather than rediscovered per suite: an absence is the wait's not-yet, a
// fault is the wait's failure, and giving up must still say what was missing.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from '../framework/wait.js';
import { NotPresentError } from '../framework/errors.js';

const FAST = { timeout: 300, interval: 10 };

describe('waitFor', () => {
  it('returns once the condition holds', async () => {
    let n = 0;
    assert.equal(await waitFor(async () => { n += 1; return n >= 3; }, FAST), true);
    assert.equal(n, 3);
  });

  it('treats an absence as not-yet and keeps polling', async () => {
    // The gate-8 shape: the resource is missing for the first few polls and then
    // appears. Before this, the first throw aborted the whole wait.
    let n = 0;
    const found = await waitFor(async () => {
      n += 1;
      if (n < 3) throw new NotPresentError(`nothing yet (poll ${n})`);
      return true;
    }, FAST);
    assert.equal(found, true);
    assert.ok(n >= 3, `should have polled past the absences, polled ${n}`);
  });

  it('aborts immediately on any other error, rather than grinding it into a timeout', async () => {
    let n = 0;
    await assert.rejects(
      () => waitFor(async () => { n += 1; throw new Error('genuinely broken'); }, FAST),
      /genuinely broken/,
    );
    assert.equal(n, 1, `a fault must not be retried, polled ${n} times`);
  });

  it('carries the last absence into the timeout, so waiting the window out costs no diagnosis', async () => {
    await assert.rejects(
      () => waitFor(async () => { throw new NotPresentError('no container on this node'); },
        { ...FAST, label: 'the SRV set' }),
      (e) => /Timeout after/.test(e.message)
        && /the SRV set/.test(e.message)
        && /no container on this node/.test(e.message),
    );
  });

  it('says so plainly when it timed out with nothing absent', async () => {
    await assert.rejects(
      () => waitFor(async () => false, { ...FAST, label: 'never true' }),
      (e) => /Timeout after/.test(e.message) && /never true/.test(e.message) && !/last:/.test(e.message),
    );
  });

  it('is a real Error outside a wait — an assertion must still fail on it', () => {
    const err = new NotPresentError('no container');
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'NotPresentError');
  });
});
