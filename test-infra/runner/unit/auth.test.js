// The runner signs what a suite builds as a Bitcoin message, and a node checks
// the signature with FluxOS's own bitcoinMessage, so the two must agree on every
// message length, past the two-byte length prefix too.
// `npm run test:unit`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { signBtcMessage, privkeyToZelid } from '../auth.js';
import { appOwnerKey } from '../framework/keys.js';

const require = createRequire(import.meta.url);
const bitcoinMessage = require('../../../ZelBack/src/services/utils/bitcoinMessage.js');

describe('a message the runner signs', () => {
  const key = appOwnerKey();
  const address = privkeyToZelid(key.privkey);

  for (const length of [100, 70_000]) {
    it(`verifies as FluxOS verifies it, at ${length} bytes`, async () => {
      const message = 'x'.repeat(length);
      const signature = await signBtcMessage(message, key.privkey);
      assert.equal(bitcoinMessage.verify(message, address, signature), true);
    });
  }
});
