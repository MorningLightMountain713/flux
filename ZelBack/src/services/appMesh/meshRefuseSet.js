'use strict';

// The persisted refuse set: outpoints the impersonation detector has evicted
// from an app's overlay on this node. Read by the accept path — a refused
// outpoint is never admitted again, whatever it broadcasts — and written only
// by the detector and the operator surface, which is also the sole eraser: a
// false positive stays refused until an operator removes it. Lives beside the
// app's mesh material so removal of the app removes its verdicts.
const fsp = require('node:fs/promises');
const path = require('node:path');

const { meshAppDir } = require('./meshCertificates');

const REFUSE_FILE = 'refuse.json';

async function readSet(instance) {
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(meshAppDir(instance), REFUSE_FILE), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

/**
 * The refused outpoints for one app on this node.
 * @param {string} instance
 * @returns {Promise<Set<string>>}
 */
async function refusedOutpoints(instance) {
  return new Set(await readSet(instance));
}

/**
 * Record an eviction. Idempotent; the write is atomic so a crash never leaves
 * a half-written verdict file.
 *
 * @param {string} instance
 * @param {string} outpoint the evicted member's canonical outpoint
 */
async function refuseOutpoint(instance, outpoint) {
  if (typeof outpoint !== 'string' || !/^[0-9a-f]{64}:\d+$/.test(outpoint)) {
    throw new TypeError('outpoint must be a canonical "<txhash>:<outidx>" string');
  }
  const dir = meshAppDir(instance);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const current = await readSet(instance);
  if (current.includes(outpoint)) return;
  current.push(outpoint);
  const target = path.join(dir, REFUSE_FILE);
  const tmp = `${target}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(current, null, 2)}\n`);
  await fsp.rename(tmp, target);
}

/**
 * Erase a verdict — the operator's undo for a false eviction. Idempotent;
 * the next reconcile pass re-admits the outpoint if it still qualifies.
 *
 * @param {string} instance
 * @param {string} outpoint
 */
async function removeRefusedOutpoint(instance, outpoint) {
  if (typeof outpoint !== 'string' || !/^[0-9a-f]{64}:\d+$/.test(outpoint)) {
    throw new TypeError('outpoint must be a canonical "<txhash>:<outidx>" string');
  }
  const current = await readSet(instance);
  if (!current.includes(outpoint)) return;
  const remaining = current.filter((entry) => entry !== outpoint);
  const target = path.join(meshAppDir(instance), REFUSE_FILE);
  const tmp = `${target}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(remaining, null, 2)}\n`);
  await fsp.rename(tmp, target);
}

module.exports = {
  refusedOutpoints,
  refuseOutpoint,
  removeRefusedOutpoint,
};
