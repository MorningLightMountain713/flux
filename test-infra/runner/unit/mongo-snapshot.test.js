import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishSnapshot, pruneDeadSnapshots } from '../framework/mongo-snapshot.js';

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
