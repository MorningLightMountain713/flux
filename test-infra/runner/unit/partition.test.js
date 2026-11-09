// A partition cuts a pocket from every other fleet address - a stub peer and a
// node not yet booted are fleet addresses too - except those a suite names
// reachable. `npm run test:unit`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { partitionTargets } from '../framework/partition.js';
import { getSubnetConfig } from '../framework/subnet-config.js';

const ip = (index) => getSubnetConfig().nodeIp(index + 1);

describe('a partition', () => {
  it('cuts the pocket from every other index of the fleet', () => {
    assert.deepEqual(partitionTargets(4, [3]), [ip(0), ip(1), ip(2)]);
  });

  it('leaves the indices named reachable', () => {
    assert.deepEqual(partitionTargets(6, [5], [4]), [ip(0), ip(1), ip(2), ip(3)]);
  });
});
