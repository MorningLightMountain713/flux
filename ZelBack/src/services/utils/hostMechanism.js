const fs = require('node:fs/promises');
const log = require('../../lib/log');
const serviceHelper = require('../serviceHelper');
const deviceHelper = require('../deviceHelper');

// Docker data-root: a genuine filesystem-path selection (kept on the env var, not
// the capability verdict) — the new mechanism puts docker on the encrypted /dat.
const dockerDataRoot = process.env.FLUXOS_PATH ? '/dat/var/lib/docker' : '/var/lib/docker';
const APP_SWAP_DIR = '/dat/app-swap';

let capabilityPromise = null;

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function fsTypeIsXfs(target) {
  const res = await serviceHelper.runCommand('findmnt', {
    logError: false,
    params: ['--target', target, '--output', 'FSTYPE', '--noheadings', '--first-only'],
  });
  return !res.error && res.stdout.trim() === 'xfs';
}

async function hostSwapFenced() {
  // The image's fence drop-in sets a finite MemorySwapMax on system.slice. systemd
  // reports a value for ANY slice (implicit units included), so "fenced" = the value
  // is finite, not the default 'infinity'.
  const res = await serviceHelper.runCommand('systemctl', {
    logError: false,
    params: ['show', 'system.slice', '-p', 'MemorySwapMax', '--value'],
  });
  if (res.error) return false;
  const value = res.stdout.trim();
  return value !== '' && value !== 'infinity';
}

/**
 * Whether the host actually carries the v9 new-mechanism contract — host-swap
 * fence + flux-apps.slice + dedicated swap pool dir + xfs/prjquota docker root.
 * This is a real-state check of the running host (NOT the spoofable env proxy and
 * NOT the attestation verdict): a node running an older image, or any non-Arcane
 * host, fails it and falls back to the OLD mechanism. Cached for the process
 * lifetime — host config does not change while running.
 * @returns {Promise<boolean>}
 */
function isNewMechanismCapable() {
  if (!capabilityPromise) {
    capabilityPromise = (async () => {
      const [systemd, cgroupV2, xfs, prjquota, fenced, sliceUnit, swapDir] = await Promise.all([
        pathExists('/run/systemd/system'),
        pathExists('/sys/fs/cgroup/cgroup.controllers'),
        fsTypeIsXfs(dockerDataRoot),
        deviceHelper.hasQuotaOptionForMountTarget(dockerDataRoot),
        hostSwapFenced(),
        pathExists('/etc/systemd/system/flux-apps.slice'),
        pathExists(APP_SWAP_DIR),
      ]);
      const capable = systemd && cgroupV2 && xfs && prjquota && fenced && sliceUnit && swapDir;
      if (!capable) {
        log.info(`hostMechanism - OLD mechanism (systemd=${systemd} cgroupv2=${cgroupV2} xfs=${xfs} prjquota=${prjquota} fenced=${fenced} slice=${sliceUnit} swapdir=${swapDir})`);
      } else {
        log.info('hostMechanism - NEW mechanism host config present (fence + flux-apps.slice + swap pool + xfs/prjquota)');
      }
      return capable;
    })().catch((error) => {
      log.warn(`hostMechanism - capability check failed, assuming OLD mechanism: ${error.message}`);
      return false;
    });
  }
  return capabilityPromise;
}

module.exports = {
  isNewMechanismCapable,
  APP_SWAP_DIR,
};
