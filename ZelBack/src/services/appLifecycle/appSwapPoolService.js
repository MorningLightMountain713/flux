const path = require('node:path');
const fs = require('node:fs/promises');
const log = require('../../lib/log');
const serviceHelper = require('../serviceHelper');
const hostMechanism = require('../utils/hostMechanism');
const deploymentProvider = require('../appRuntime/deploymentProvider');

const POOL_DIR = hostMechanism.APP_SWAP_DIR;
const GB = 1024 * 1024 * 1024;
const MIN_CHUNK_GB = 8;
// Leave headroom under the kernel MAX_SWAPFILES (~24) for the host swapfile and
// migration/device-private reservations. A pool that needs more than this is a
// mis-sized node — we log rather than silently under-provision.
const MAX_CHUNKS = 20;

// Serialize reconciles: concurrent install/uninstall/boot must not race fallocate
// /swapon against a shared chunk set. Each call chains after the previous one;
// the chain survives an individual failure.
let reconcileChain = Promise.resolve();

async function rootCmd(cmd, params, logError = true) {
  const res = await serviceHelper.runCommand(cmd, { runAsRoot: true, params, logError });
  if (res.error) throw new Error(`${cmd} ${params.join(' ')} failed: ${res.error.message || res.error}`);
  return res;
}

async function listChunks() {
  let entries;
  try {
    entries = await fs.readdir(POOL_DIR);
  } catch {
    return [];
  }
  const chunks = [];
  for (const name of entries.filter((n) => /^chunk-\d+\.swap$/.test(n))) {
    const fullPath = path.join(POOL_DIR, name);
    // eslint-disable-next-line no-await-in-loop
    const stat = await fs.stat(fullPath);
    chunks.push({ name, fullPath, sizeGb: Math.round(stat.size / GB) });
  }
  return chunks.sort((a, b) => a.name.localeCompare(b.name));
}

async function activeSwapPaths() {
  const res = await serviceHelper.runCommand('swapon', { params: ['--show=NAME', '--noheadings'], logError: false });
  if (res.error || !res.stdout) return new Set();
  return new Set(res.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
}

function nextChunkName(existing) {
  const indices = existing.map((c) => Number.parseInt(c.name.slice('chunk-'.length), 10));
  const next = (indices.length ? Math.max(...indices) : -1) + 1;
  return `chunk-${String(next).padStart(4, '0')}.swap`;
}

async function addChunk(name, sizeGb) {
  const fullPath = path.join(POOL_DIR, name);
  await rootCmd('fallocate', ['-l', `${sizeGb}G`, fullPath]);
  await rootCmd('chmod', ['600', fullPath]);
  await rootCmd('mkswap', [fullPath]);
  return { name, fullPath, sizeGb };
}

async function swapOnChunk(fullPath) {
  const res = await serviceHelper.runCommand('swapon', { runAsRoot: true, params: [fullPath], logError: false });
  if (!res.error) return;
  // A file fallocate'd but never mkswap'd (crash mid-add) fails swapon — reformat
  // once and retry before giving up on it.
  await serviceHelper.runCommand('mkswap', { runAsRoot: true, params: [fullPath], logError: false });
  const retry = await serviceHelper.runCommand('swapon', { runAsRoot: true, params: [fullPath], logError: false });
  if (retry.error) log.warn(`appSwapPool - could not swapon ${fullPath}: ${retry.error.message || retry.error}`);
}

async function removeChunk(chunk, active) {
  if (active.has(chunk.fullPath)) {
    const res = await serviceHelper.runCommand('swapoff', { runAsRoot: true, params: [chunk.fullPath], logError: false });
    // swapoff fails if its pages cannot be migrated (no spare capacity). Leave the
    // chunk in place rather than risk it; a later reconcile reclaims it.
    if (res.error) {
      log.warn(`appSwapPool - swapoff deferred for ${chunk.fullPath}: ${res.error.message || res.error}`);
      return false;
    }
  }
  await serviceHelper.runCommand('rm', { runAsRoot: true, params: ['-f', chunk.fullPath], logError: false });
  return true;
}

async function computeNeed() {
  const deployments = await deploymentProvider.listInstalledDeployments();
  let totalGb = 0;
  let maxComponentGb = 0;
  for (const deployment of deployments) {
    for (const [, comp] of deployment.componentEntries()) {
      const swapGb = comp.swapGb || 0;
      totalGb += swapGb;
      if (swapGb > maxComponentGb) maxComponentGb = swapGb;
    }
  }
  return { totalGb, maxComponentGb };
}

async function doReconcile() {
  if (!(await hostMechanism.isNewMechanismCapable())) return; // OLD nodes: no dedicated pool

  await serviceHelper.runCommand('mkdir', { runAsRoot: true, params: ['-p', POOL_DIR], logError: false });

  const { totalGb: needGb, maxComponentGb } = await computeNeed();
  // A chunk is at least MIN_CHUNK_GB and at least the largest single app's swap, so
  // the device count stays well under MAX_SWAPFILES (pages still span devices, so a
  // single app is never confined to one chunk).
  const chunkGb = Math.max(MIN_CHUNK_GB, maxComponentGb);

  let chunks = await listChunks();
  let capacityGb = chunks.reduce((sum, c) => sum + c.sizeGb, 0);

  // GROW: add chunk files until capacity covers the need.
  while (capacityGb < needGb && chunks.length < MAX_CHUNKS) {
    // eslint-disable-next-line no-await-in-loop
    const chunk = await addChunk(nextChunkName(chunks), chunkGb);
    chunks.push(chunk);
    capacityGb += chunk.sizeGb;
  }
  if (capacityGb < needGb) {
    log.error(`appSwapPool - cannot cover ${needGb}G of app swap within ${MAX_CHUNKS} chunks (capacity ${capacityGb}G); pool under-provisioned`);
  }

  // SWAPON every chunk file not already active (covers fresh chunks AND existing
  // ones not yet active after a reboot — kernel swap state does not survive a boot).
  const active = await activeSwapPaths();
  for (const chunk of chunks) {
    if (!active.has(chunk.fullPath)) {
      // eslint-disable-next-line no-await-in-loop
      await swapOnChunk(chunk.fullPath);
    }
  }

  // SHRINK: reclaim excess capacity, smallest chunks first, only while removal still
  // leaves enough to cover the need.
  const activeAfter = await activeSwapPaths();
  const removable = [...chunks].sort((a, b) => a.sizeGb - b.sizeGb);
  for (const chunk of removable) {
    if (capacityGb - chunk.sizeGb < needGb) break;
    // eslint-disable-next-line no-await-in-loop
    const removed = await removeChunk(chunk, activeAfter);
    if (removed) capacityGb -= chunk.sizeGb;
  }
}

/**
 * Reconcile the per-app swap pool to the current installed-app footprint:
 * size the requirement, add/remove chunk FILES to match, then swapon. Idempotent
 * and serialized; a no-op on nodes without the new-mechanism host config. Called
 * from install (grow), uninstall (shrink), and at boot before any app starts.
 * @returns {Promise<void>}
 */
function reconcile() {
  const run = reconcileChain.then(doReconcile, doReconcile);
  reconcileChain = run.catch(() => {});
  return run;
}

module.exports = {
  reconcile,
  // exposed for tests
  doReconcile,
  computeNeed,
};
