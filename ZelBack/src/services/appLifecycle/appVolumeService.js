'use strict';

const config = require('config');
const fs = require('node:fs/promises');
const path = require('node:path');
const serviceHelper = require('../serviceHelper');
const dockerService = require('../dockerService');
const messageHelper = require('../messageHelper');
const volumeService = require('../utils/volumeService');
const { withHostMutationLock } = require('../utils/hostMutationLock');
const appsRuntimeState = require('../appManagement/appsRuntimeState');
const pendingTeardownStore = require('./pendingTeardownStore');
const { getSpecBackend } = require('../utils/specLibs');
const log = require('../../lib/log');

const fluxDirPath = process.env.FLUXOS_PATH || path.join(process.env.HOME, 'zelflux');
const appsFolderPath = process.env.FLUX_APPS_FOLDER || path.join(fluxDirPath, 'ZelApps');
const appsFolder = `${appsFolderPath}/`;

function emitStatus(res, status) {
  // the human text goes to the journal; the object shape is the stream's contract
  log.info(typeof status === 'string' ? status : status.status);
  if (res) {
    res.write(serviceHelper.ensureString(status));
    if (res.flush) res.flush();
  }
}

async function createAppVolume(deployComp, res) {
  const { identifier } = deployComp;
  const appId = dockerService.getAppIdentifier(identifier);
  const requiredGb = deployComp.storage;

  // Defensive: the provisioner already skips stateless components. Returning
  // here rather than allocating means a future caller cannot accidentally
  // fallocate a 0G file and hand mke2fs an empty image.
  if (deployComp.isStateless) {
    emitStatus(res, { status: 'Stateless component — no volume required' });
    return;
  }

  emitStatus(res, { status: 'Searching available space...' });

  // The disks an image may be placed on, emptiest first (volumeService decides
  // which disks qualify). Logical resource admission already ran
  // (admissionControl.checkNodeResources, before createAppVolume is reached), so
  // this only picks a disk that physically has room: the first with space for the
  // volume and a small reserve, so the system is never left on a disk with no
  // headroom.
  const reserveGb = config.get('lockedSystemResources.extrahdd');
  const candidates = await volumeService.placementVolumesInGib();
  const useThisVolume = candidates.find((volume) => volume.available >= requiredGb + reserveGb);
  if (!useThisVolume) {
    throw new Error(`Insufficient space for ${identifier}: needs ${requiredGb}GB + ${reserveGb}GB reserve, no usable disk has room (${candidates.map((v) => `${v.mount} ${v.available}GB`).join(', ') || 'no usable disk'})`);
  }

  emitStatus(res, { status: 'Space found' });

  try {
    emitStatus(res, { status: 'Allocating space...' });

    let volumeFile;
    if (useThisVolume.mount === '/') {
      await serviceHelper.runCommand('mkdir', { params: ['-p', `${fluxDirPath}appvolumes`], runAsRoot: true });
      volumeFile = `${fluxDirPath}appvolumes/${appId}FLUXFSVOL`;
    } else {
      volumeFile = `${useThisVolume.mount}/${appId}FLUXFSVOL`;
    }

    // Build the loop-mounted FLUXFSVOL under the node-wide host-mutation lock — the same
    // lock a same-app cancel's teardown holds for its umount + rm -rf of this volume.
    // Without it, a register racing a cancel could mke2fs a volume the teardown is mid
    // rm -rf'ing (byte-level corruption). Re-check condemned/teardown-owed at the top of
    // the locked region: if the cancel won the lock first, abort rather than recreate a
    // volume its teardown already passed (componentProvisioner's pre-create backstop
    // covers the reverse order). These are bounded host ops (seconds) — the same class
    // the teardown holds the lock across — so the lock's no-unbounded-wait rule holds;
    // createAppVolume's only caller is a bare call, so it never nests the lock.
    await withHostMutationLock(async () => {
      if (await appsRuntimeState.isCondemned(identifier) || await pendingTeardownStore.teardownOwedFor(deployComp.appName)) {
        throw new Error(`createAppVolume of ${identifier} aborted: a removal/cancel of ${deployComp.appName} arrived before volume creation`);
      }
      await serviceHelper.runCommand('fallocate', { params: ['-l', `${requiredGb}G`, volumeFile], runAsRoot: true });
      emitStatus(res, { status: 'Space allocated' });

      emitStatus(res, { status: 'Creating filesystem...' });
      await serviceHelper.runCommand('mke2fs', { params: ['-t', 'ext4', volumeFile], runAsRoot: true });
      emitStatus(res, { status: 'Filesystem created' });

      emitStatus(res, { status: 'Making directory...' });
      await serviceHelper.runCommand('mkdir', { params: ['-p', appsFolder + appId], runAsRoot: true });
      emitStatus(res, { status: 'Directory made' });

      // Lock the empty bare mountpoint immutable BEFORE mounting so writes through
      // it while the volume is unmounted (the first-reboot-after-install window,
      // before the boot mount pass remounts) fail with EPERM instead of silently
      // landing on the host filesystem. The mounted volume shadows the flag;
      // uninstall clears it. Defense-in-depth on top of the mount, so a failure
      // (unexpected on ext4/XFS) must never fail the install.
      const chattr = await serviceHelper.runCommand('chattr', { runAsRoot: true, params: ['+i', appsFolder + appId], logError: false });
      if (chattr.error) {
        log.error(`createAppVolume - could not set ${appsFolder + appId} immutable (unexpected on ext4/XFS): ${chattr.error.message}`);
      }

      emitStatus(res, { status: 'Mounting volume...' });
      await serviceHelper.runCommand('mount', { params: ['-o', 'loop', volumeFile, appsFolder + appId], runAsRoot: true });
      emitStatus(res, { status: 'Volume mounted' });
    });

    emitStatus(res, { status: 'Making application data directories and files...' });
    const compDir = `${appsFolder}${appId}`;
    log.info(`Creating ${deployComp.mounts.length} mount source(s) for ${appId}`);

    for (const mount of deployComp.mounts) {
      const sourceName = mount.Source.replace(`${compDir}/`, '');
      if (mount.sourceType === 'file') {
        emitStatus(res, { status: `Creating file mount: ${sourceName}...` });
        // eslint-disable-next-line no-await-in-loop
        await serviceHelper.runCommand('touch', { params: [mount.Source], runAsRoot: true });
        emitStatus(res, { status: `File mount created: ${sourceName}` });
      } else {
        emitStatus(res, { status: `Creating directory: ${sourceName}...` });
        // eslint-disable-next-line no-await-in-loop
        await serviceHelper.runCommand('mkdir', { params: ['-p', mount.Source], runAsRoot: true });
        emitStatus(res, { status: `Directory created: ${sourceName}` });
      }
    }
    emitStatus(res, { status: 'Application data directories and files created' });

    emitStatus(res, { status: 'Adjusting permissions...' });
    await serviceHelper.runCommand('chmod', { params: ['777', compDir], runAsRoot: true });
    for (const mount of deployComp.mounts) {
      // eslint-disable-next-line no-await-in-loop
      await applyMountPerms(mount);
    }
    emitStatus(res, { status: 'Permissions adjusted' });

    if (deployComp.sync) {
      emitStatus(res, { status: 'Creating .stfolder for syncthing...' });
      await serviceHelper.runCommand('mkdir', { params: ['-p', `${compDir}/.stfolder`], runAsRoot: true });
      emitStatus(res, { status: '.stfolder created' });

      await writeStignore(deployComp);
      emitStatus(res, { status: '.stignore created' });
    }

    // No @reboot crontab entry: FluxOS owns mounting (boot pass in
    // crontabAndMountsCleanup + the reconciler). crontabAndMountsCleanup only
    // idempotently removes legacy entries older versions left behind.
    return messageHelper.createSuccessMessage('Flux App volume creation completed.');
  } catch (error) {
    clearInterval(global.allocationInterval);
    clearInterval(global.verificationInterval);
    emitStatus(res, { status: 'ERROR OCCURED: Pre-removal cleaning...' });
    const umountResult = await serviceHelper.runCommand('umount', { params: [appsFolder + appId], runAsRoot: true, logError: false });
    if (umountResult.error) {
      log.warn('Volume not mounted or already unmounted during cleanup');
    }
    let volumeFilePath;
    if (useThisVolume.mount === '/') {
      volumeFilePath = `${fluxDirPath}appvolumes/${appId}FLUXFSVOL`;
    } else {
      volumeFilePath = `${useThisVolume.mount}/${appId}FLUXFSVOL`;
    }
    await serviceHelper.runCommand('rm', { params: ['-rf', volumeFilePath], runAsRoot: true });
    // clear the immutable flag set on the bare mountpoint before mounting, or the removal below fails
    await serviceHelper.runCommand('chattr', { params: ['-i', appsFolder + appId], runAsRoot: true, logError: false });
    await serviceHelper.runCommand('rm', { params: ['-rf', appsFolder + appId], runAsRoot: true });
    emitStatus(res, { status: 'Pre-removal cleaning completed. Forcing removal.' });
    throw error;
  }
}

/**
 * Apply a bind-mount source's effective ownership/permissions, resolved by
 * flux-spec into `mount.perms`. `null` is the data-mount role default — world-
 * writable, today's behavior (no regression). An object pins owner + mode so
 * injected content (root-owned `0644` default) is never left world-writable in the
 * container. One helper for every site, so the rule lives in exactly one place.
 *
 * @param {object} mount - a DeploymentComponent mount ({ Source, perms })
 */
async function applyMountPerms(mount) {
  if (!mount.perms) {
    await serviceHelper.runCommand('chmod', { params: ['777', mount.Source], runAsRoot: true });
    return;
  }
  const { uid, gid, mode } = mount.perms;
  await serviceHelper.runCommand('chown', { params: [`${uid}:${gid}`, mount.Source], runAsRoot: true });
  await serviceHelper.runCommand('chmod', { params: [mode, mount.Source], runAsRoot: true });
}

/**
 * (Re)generate a component's `.stignore` from its current spec — the single source
 * of truth, idempotent (full overwrite, skipped when the content is already
 * current), so it never goes stale across a redeploy that keeps the volume
 * (where `createAppVolume` does not run). Returns true when an EXISTING ignore
 * file's content changed — syncthing reloads patterns only before its next
 * scan/sync, so the caller should follow with a targeted folder scan
 * (`syncthingMonitorHelpers.requestFolderScan`). False on a first write (the
 * folder is not registered yet; syncthing loads the patterns when it adds the
 * folder), when the content is unchanged, and when sync is off. Reserved entries
 * come FIRST (syncthing is first-match-wins), so the owner's `sync.exclude` can
 * extend the set but can never un-exclude a platform entry or an injected
 * content path. The platform's entries at the volume root are the spec
 * library's list, and none of them is the app's data. Injected content is
 * node-local — content delivery writes it on every node — and must never
 * replicate. Without sync it instead removes any lingering
 * `.stignore`/`.stfolder` from the kept volume (idempotent), so dropping sync in
 * a spec update leaves no stale syncthing bookkeeping behind.
 *
 * @param {object} deployComp - DeploymentComponent (carries dir, sync, injected views)
 */
async function writeStignore(deployComp) {
  if (!deployComp.dir) return false;
  const compDir = deployComp.dir;
  if (!deployComp.sync) {
    // No sync (never had it, or a spec update dropped it on a kept volume):
    // remove the syncthing bookkeeping files so they don't linger. The monitor
    // prunes the folder registration separately; a briefly missing .stfolder
    // marker on a folder that is about to be pruned is harmless.
    await fs.rm(`${compDir}/.stignore`, { force: true });
    await fs.rm(`${compDir}/.stfolder`, { recursive: true, force: true });
    return false;
  }
  const { PLATFORM_VOLUME_ENTRIES } = await getSpecBackend();
  const platform = PLATFORM_VOLUME_ENTRIES.map((name) => `/${name}`);
  const injected = deployComp.injectedSyncExcludes().map((source) => `/${path.relative(compDir, source)}`);
  const ownerExcludes = deployComp.sync.exclude || [];
  const lines = [...new Set([...platform, ...injected, ...ownerExcludes].filter(Boolean))];
  const content = `${lines.join('\n')}\n`;
  const stignorePath = `${compDir}/.stignore`;
  const existing = await fs.readFile(stignorePath, 'utf8').catch(() => null);
  if (existing === content) return false;
  await fs.writeFile(stignorePath, content);
  return existing !== null;
}

/**
 * Delete injected content a spec update dropped. A volume-keeping redeploy reuses
 * the old mount sources, so a removed `contentRef`/`contentSlot` would otherwise
 * keep being served from the kept volume — including a stale slot file left inside
 * a still-mounted shared atomic managed dir. Diffs the OLD vs NEW injected FILE set
 * and removes only what was injected and no longer is, never owner data.
 *
 * @param {object} oldComp - the pre-update DeploymentComponent
 * @param {object} newComp - the post-update DeploymentComponent
 */
async function removeOrphanedInjectedContent(oldComp, newComp) {
  const keep = new Set(newComp.injectedContentFiles());
  const orphans = oldComp.injectedContentFiles().filter((source) => !keep.has(source));
  for (const source of orphans) {
    // eslint-disable-next-line no-await-in-loop
    await serviceHelper.runCommand('rm', { params: ['-f', source], runAsRoot: true });
  }
}

/**
 * Ensure every bind-mount source for a component exists before its container is
 * (re)created on the volume-reuse path. The operations are unconditional and
 * idempotent (`mkdir -p` / `touch`), so there is no check-then-act (TOCTOU) window
 * inside this helper. Also regenerates `.stignore` so a volume-keeping redeploy
 * picks up an added/removed injected exclude (decoupled from `createAppVolume`).
 * Passes writeStignore's verdict through: true when an existing ignore set
 * changed and the caller should request a targeted syncthing folder scan.
 */
async function ensureMountSourcesExist(deployComp) {
  for (const mount of deployComp.mounts) {
    if (mount.sourceType === 'file') {
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.runCommand('touch', { params: [mount.Source], runAsRoot: true });
    } else {
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.runCommand('mkdir', { params: ['-p', mount.Source], runAsRoot: true });
    }
    // eslint-disable-next-line no-await-in-loop
    await applyMountPerms(mount);
  }
  const stignoreChanged = await writeStignore(deployComp);
  return stignoreChanged;
}

module.exports = {
  createAppVolume,
  ensureMountSourcesExist,
  applyMountPerms,
  writeStignore,
  removeOrphanedInjectedContent,
};
