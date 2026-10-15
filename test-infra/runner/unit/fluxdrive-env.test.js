// The real FluxDrive's environment, sized to the fleet. `npm run test:unit`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fluxDriveEnv } from '../framework/fluxdrive-env.js';

const NODE_URLS = ['http://10.0.0.11:16127', 'http://10.0.0.12:16127', 'http://10.0.0.13:16127', 'http://10.0.0.14:16127', 'http://10.0.0.15:16127'];
const KEY = Buffer.alloc(32, 7).toString('base64');

function envFor(nodeUrls, arcanePublicKey = KEY) {
  return fluxDriveEnv({ mongoUrl: 'mongodb://10.0.0.20:27017', ipfsHost: '10.0.0.21', nodeUrls, arcanePublicKey });
}

describe('fluxDriveEnv', () => {
  it('reads app owners and the node list from the fleet', () => {
    const env = envFor(NODE_URLS);
    assert.equal(env.FLUX_API_GLOBAL_SPECS, 'http://10.0.0.11:16127/apps/globalappsspecifications');
    assert.equal(env.CONTENT_GC_NODELIST_URLS, NODE_URLS.join(','));
  });

  it('verifies the arcane signature against the key it is given', () => {
    assert.equal(envFor(NODE_URLS).BLOB_ARCANE_PUBLIC_KEY, KEY);
  });

  it('asks every node and decides by a majority of the fleet', () => {
    for (const [size, majority] of [[1, 1], [2, 2], [3, 2], [4, 3], [5, 3]]) {
      const env = envFor(NODE_URLS.slice(0, size));
      assert.equal(env.CONTENT_GC_SAMPLE_SIZE, String(size), `sample of ${size}`);
      assert.equal(env.CONTENT_PENDING_MAX_ASKED, String(size), `asked of ${size}`);
      assert.equal(env.CONTENT_GC_MIN_RESPONDERS, String(majority), `responders of ${size}`);
      assert.equal(env.CONTENT_PENDING_ANSWERS, String(majority), `answers of ${size}`);
    }
  });

  it('runs no cron and no rate limit', () => {
    const env = envFor(NODE_URLS);
    assert.equal(env.TEST_MODE, 'true');
    assert.equal(env.NODE_ENV, 'test');
  });

  it('refuses a fleet of no nodes', () => {
    assert.throws(() => envFor([]), /at least one node/);
  });

  it('refuses a key that is not a raw Ed25519 public key', () => {
    assert.throws(() => envFor(NODE_URLS, null), /32-byte Ed25519 public key/);
    assert.throws(() => envFor(NODE_URLS, Buffer.alloc(31).toString('base64')), /32-byte Ed25519 public key/);
  });
});
