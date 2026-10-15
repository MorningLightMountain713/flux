// createTestEnv's option checks run before it touches docker, so a suite that
// names an option wrongly fails at once rather than running on a fleet it did
// not ask for. `npm run test:unit`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv } from '../framework/test-env.js';

describe('createTestEnv options', () => {
  it('refuses an option it does not know, naming it', async () => {
    await assert.rejects(createTestEnv({ nodes: 1, shutdowndReal: true }), /unknown option\(s\) shutdowndReal/);
  });

  for (const [name, allowed, refused] of [
    ['syncthing', ['stub', 'real'], 'binary'],
    ['shutdownd', ['none', 'stub', 'real'], true],
    ['telemetryd', ['none', 'stub', 'real'], 'mock'],
    ['dnsd', ['none', 'real'], 'stub'],
    ['fluxDrive', ['stub', 'real'], 'mock'],
  ]) {
    it(`refuses a ${name} other than ${allowed.join(', ')}`, async () => {
      await assert.rejects(createTestEnv({ [name]: refused }), new RegExp(`${name} must be ${allowed.map((a) => `'${a}'`).join(' or ')}, got '${refused}'`));
    });
  }
});
