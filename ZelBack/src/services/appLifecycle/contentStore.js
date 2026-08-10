'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const appConstants = require('../utils/appConstants');
const log = require('../../lib/log');

// Node-owned store of an app's declared content blobs: one framed-ciphertext
// file per content hash, under <contentStorePath>/<appName>/<sha256hex>. This
// is the artifact copy — the app's live mount is its mutable working copy and
// is never trusted as a source of the declared bytes. Peer-serving reads the
// store verbatim; provisioning fills it as blobs are fetched and verified. The
// store is process-owned (0700/0600) and lives outside every bind-mounted
// tree, so no container can reach it.
//
// Every operation is per-app + per-hash; both path segments are validated
// before any filesystem call so a crafted name can never traverse the store.

const HASH_PATTERN = /^sha256:([a-f0-9]{64})$/;
// Matches the app-name superset (legacy alphanumeric + v8 hyphens) with no
// path metacharacters possible.
const APP_DIR_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

function appDir(appName) {
  if (!APP_DIR_PATTERN.test(appName)) throw new Error(`contentStore: invalid app name "${appName}"`);
  return path.join(appConstants.contentStorePath, appName);
}

function blobPath(appName, contentHash) {
  const match = HASH_PATTERN.exec(contentHash);
  if (!match) throw new Error(`contentStore: invalid content hash "${contentHash}"`);
  return path.join(appDir(appName), match[1]);
}

/**
 * Persist a verified framed ciphertext. Best-effort by design: the store is
 * the peer-serving artifact copy, and FluxDrive remains the durable backstop,
 * so a write failure must never fail the install/apply that produced the
 * bytes. Written via temp + rename so a crash never leaves a torn file.
 *
 * @param {string} appName
 * @param {string} contentHash - "sha256:<64hex>" of the plaintext
 * @param {Buffer} framed - verified nonce||ciphertext||tag
 * @returns {Promise<boolean>} true when stored
 */
async function put(appName, contentHash, framed) {
  const target = blobPath(appName, contentHash);
  try {
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, framed, { mode: 0o600 });
    await fs.rename(tmp, target);
    return true;
  } catch (error) {
    log.warn(`contentStore: could not store ${contentHash} for ${appName} - ${error.message ?? error}`);
    return false;
  }
}

/**
 * Read a stored framed ciphertext. Null when absent (or unreadable — the
 * caller falls through to peers/FluxDrive either way).
 *
 * @param {string} appName
 * @param {string} contentHash
 * @returns {Promise<Buffer|null>}
 */
async function get(appName, contentHash) {
  const target = blobPath(appName, contentHash);
  try {
    return await fs.readFile(target);
  } catch {
    return null;
  }
}

/**
 * Content hashes stored for an app ("sha256:<hex>" form). Empty when the app
 * has no store directory.
 *
 * @param {string} appName
 * @returns {Promise<string[]>}
 */
async function list(appName) {
  const dir = appDir(appName);
  try {
    const names = await fs.readdir(dir);
    return names.filter((n) => /^[a-f0-9]{64}$/.test(n)).map((n) => `sha256:${n}`);
  } catch {
    return [];
  }
}

/**
 * Drop one stored blob (no-op when absent).
 *
 * @param {string} appName
 * @param {string} contentHash
 */
async function remove(appName, contentHash) {
  await fs.rm(blobPath(appName, contentHash), { force: true });
}

/**
 * Drop an app's whole store directory — the uninstall reap.
 *
 * @param {string} appName
 */
async function removeApp(appName) {
  await fs.rm(appDir(appName), { recursive: true, force: true });
}

/**
 * Reap store entries no longer declared by the app: keep exactly `keepHashes`
 * (spec contentRef hashes + the current manifest's slot hashes), delete the
 * rest. Superseded slot versions age out here on the next apply.
 *
 * @param {string} appName
 * @param {Iterable<string>} keepHashes - "sha256:<hex>" values to retain
 */
async function retainOnly(appName, keepHashes) {
  const keep = new Set(keepHashes);
  const stored = await list(appName);
  for (const hash of stored) {
    // eslint-disable-next-line no-await-in-loop
    if (!keep.has(hash)) await remove(appName, hash);
  }
}

module.exports = {
  put,
  get,
  list,
  remove,
  removeApp,
  retainOnly,
};
