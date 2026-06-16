const fs = require('node:fs/promises');
const log = require('../../lib/log');
const serviceHelper = require('../serviceHelper');
const deviceHelper = require('../deviceHelper');

// Managed-storage docker data-root: a fixed contract path (the Arcane image puts
// docker on the encrypted xfs /dat). On any other host this path is absent, so the
// xfs/prjquota checks below fail and the node reads as unmanaged — no env proxy.
const MANAGED_DOCKER_ROOT = '/dat/var/lib/docker';
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
 * Whether this host is provisioned to run v9 managed storage — the host-swap fence
 * + flux-apps.slice + dedicated swap pool dir + xfs/prjquota docker root. A
 * real-state check of the running host (NOT the spoofable env proxy and NOT the
 * attestation verdict): a node on an older image, or any non-Arcane host, fails it
 * and falls back to the unmanaged path. Cached for the process lifetime — host
 * config does not change while running.
 * @returns {Promise<boolean>}
 */
function supportsManagedStorage() {
  if (!capabilityPromise) {
    capabilityPromise = (async () => {
      const [systemd, cgroupV2, xfs, prjquota, fenced, sliceUnit, swapDir] = await Promise.all([
        pathExists('/run/systemd/system'),
        pathExists('/sys/fs/cgroup/cgroup.controllers'),
        fsTypeIsXfs(MANAGED_DOCKER_ROOT),
        deviceHelper.hasQuotaOptionForMountTarget(MANAGED_DOCKER_ROOT),
        hostSwapFenced(),
        pathExists('/etc/systemd/system/flux-apps.slice'),
        pathExists(APP_SWAP_DIR),
      ]);
      const supported = systemd && cgroupV2 && xfs && prjquota && fenced && sliceUnit && swapDir;
      if (!supported) {
        log.info(`hostStorageCapability - managed storage unsupported (systemd=${systemd} cgroupv2=${cgroupV2} xfs=${xfs} prjquota=${prjquota} fenced=${fenced} slice=${sliceUnit} swapdir=${swapDir})`);
      } else {
        log.info('hostStorageCapability - managed storage supported (fence + flux-apps.slice + swap pool + xfs/prjquota)');
      }
      return supported;
    })().catch((error) => {
      log.warn(`hostStorageCapability - capability check failed, assuming unmanaged storage: ${error.message}`);
      return false;
    });
  }
  return capabilityPromise;
}

module.exports = {
  supportsManagedStorage,
  APP_SWAP_DIR,
};
