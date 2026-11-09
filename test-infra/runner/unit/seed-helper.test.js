// A node refuses a message carrying the timestamp of an earlier one for its app
// as a replay, so the builders never sign two messages in one millisecond,
// however fast a suite builds them.
// `npm run test:unit`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeedableApp, buildSeedableUpdate } from '../framework/seed-helper.js';

describe('the seed builders', () => {
  it('sign each message later than the last, though the clock has not moved', async (t) => {
    t.mock.method(Date, 'now', () => 1_800_000_000_000);
    const app = await buildSeedableApp({ name: `unitstamp${process.pid}` });
    const first = await buildSeedableUpdate(app, (spec) => { spec.description = 'first'; });
    const second = await buildSeedableUpdate(first, (spec) => { spec.description = 'second'; });

    const stamps = [app, first, second].map((built) => built.message.timestamp);
    assert.ok(stamps[0] < stamps[1] && stamps[1] < stamps[2], `timestamps ${stamps.join(', ')}`);
  });
});
