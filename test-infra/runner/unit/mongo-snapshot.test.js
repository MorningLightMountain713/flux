import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishSnapshot, pruneDeadSnapshots, capSnapshots } from '../framework/mongo-snapshot.js';

const cache = () => mkdtempSync(join(tmpdir(), 'snapshot-cache-'));
const meta = (nodeImageId) => JSON.stringify({ nodeImageId, nodes: 5, mongoImage: 'mongo:8' });

test('a snapshot is published sidecar first, so a tar is never visible without the record that keeps it', () => {
  const dir = cache();
  const tarPath = join(dir, 'k.tar');
  const metaPath = join(dir, 'k.json');
  // The rename fails: what is on disk at that moment is the order of the two writes.
  assert.throws(() => publishSnapshot({ built: join(dir, 'absent.tar'), tarPath, metaPath, meta: { nodeImageId: 'img' } }));
  assert.equal(existsSync(metaPath), true, 'the sidecar was written before the tar was published');
  assert.equal(existsSync(tarPath), false);

  const built = join(dir, 'built.tar');
  writeFileSync(built, 'tar bytes');
  publishSnapshot({ built, tarPath, metaPath, meta: { nodeImageId: 'img' } });
  assert.equal(existsSync(tarPath), true);
  assert.equal(existsSync(built), false);
  rmSync(dir, { recursive: true, force: true });
});

test('the prune removes a tar without a sidecar, one whose image is gone, and leaves one whose image is present', async () => {
  const dir = cache();
  writeFileSync(join(dir, 'orphan.tar'), 'x');
  writeFileSync(join(dir, 'kept.tar'), 'x');
  writeFileSync(join(dir, 'kept.json'), meta('sha256:present'));
  writeFileSync(join(dir, 'stale.tar'), 'x');
  writeFileSync(join(dir, 'stale.json'), meta('sha256:gone'));
  // What docker leaves when a bind-mount source is missing at container start: a
  // directory where the tar should be, which no fleet can unpack.
  mkdirSync(join(dir, 'ghost.tar'));

  const removed = await pruneDeadSnapshots(dir, { imageLive: async (id) => id === 'sha256:present' });

  assert.deepEqual(removed.sort(), ['ghost', 'orphan', 'stale']);
  assert.equal(existsSync(join(dir, 'kept.tar')), true);
  assert.equal(existsSync(join(dir, 'kept.json')), true);
  assert.equal(existsSync(join(dir, 'stale.json')), false);
  assert.equal(existsSync(join(dir, 'ghost.tar')), false);
  rmSync(dir, { recursive: true, force: true });
});

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-10-12T12:00:00Z');

// A snapshot of `bytes` last used `ageMs` before NOW, with its sidecar.
function snapshot(dir, key, bytes, ageMs) {
  const tar = join(dir, `${key}.tar`);
  writeFileSync(tar, Buffer.alloc(bytes));
  writeFileSync(join(dir, `${key}.json`), meta(`sha256:${key}`));
  const at = new Date(NOW - ageMs);
  utimesSync(tar, at, at);
}

test('the cap evicts the least recently used snapshots, with their sidecars, until the cache fits', () => {
  const dir = cache();
  snapshot(dir, 'oldest', 400, 5 * HOUR);
  snapshot(dir, 'older', 400, 4 * HOUR);
  snapshot(dir, 'recent', 400, 3 * HOUR);

  const removed = capSnapshots(dir, { capBytes: 800, now: NOW });

  assert.deepEqual(removed, ['oldest']);
  assert.equal(existsSync(join(dir, 'oldest.tar')), false);
  assert.equal(existsSync(join(dir, 'oldest.json')), false);
  assert.equal(existsSync(join(dir, 'older.tar')), true);
  assert.equal(existsSync(join(dir, 'recent.tar')), true);
  rmSync(dir, { recursive: true, force: true });
});

test('the cap never evicts a snapshot used within the hour, even over the cap', () => {
  const dir = cache();
  snapshot(dir, 'idle', 400, 2 * HOUR);
  snapshot(dir, 'booting', 400, 10 * 60 * 1000);
  snapshot(dir, 'just-built', 400, 0);

  const removed = capSnapshots(dir, { capBytes: 100, now: NOW });

  assert.deepEqual(removed, ['idle']);
  assert.equal(existsSync(join(dir, 'booting.tar')), true);
  assert.equal(existsSync(join(dir, 'just-built.tar')), true);
  rmSync(dir, { recursive: true, force: true });
});

test('a cache under the cap is left alone', () => {
  const dir = cache();
  snapshot(dir, 'a', 300, 5 * HOUR);
  snapshot(dir, 'b', 300, 6 * HOUR);
  assert.deepEqual(capSnapshots(dir, { capBytes: 600, now: NOW }), []);
  rmSync(dir, { recursive: true, force: true });
});
