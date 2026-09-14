'use strict';

const fs = require('fs').promises;
const path = require('node:path');
const dockerService = require('../dockerService');
const deviceHelper = require('../deviceHelper');
const serviceHelper = require('../serviceHelper');
const log = require('../../lib/log');
const { getSpecBackend } = require('./specLibs');
const appsRepository = require('../appDatabase/appsRepository');
const {
  appsFolder, appVolumesPath, legacyAppVolumesPath, APP_VOLUME_MOUNT_OPTIONS,
} = require('./appConstants');

/**
 * The unit node capacity is counted in, which is the unit it is spent in:
 * `fallocate -l <n>G` takes 1024^3 bytes per unit, so this is what an app's
 * `hdd` actually costs the filesystem.
 */
const BYTES_PER_GIB = 1024 ** 3;

/**
 * The host filesystems eligible to hold an app's FLUXFSVOL image.
 *
 * Block-backed, and neither the root nor a boot filesystem. Loop devices are
 * excluded because a loop mount IS an app volume - treating one as a candidate
 * host would place an app's image inside another app's volume.
 *
 * Throws when the mount table cannot be read; callers narrow their search to
 * the appvolumes directories rather than treating that as "no disks".
 *
 * @returns {Promise<Array<object>>} mount rows from deviceHelper
 */
async function eligibleHostMounts() {
  const filesystems = await deviceHelper.listMountedFilesystems();
  return filesystems.filter((entry) => entry.source.includes('/dev/')
    && !entry.source.includes('loop')
    && !entry.target.includes('boot')
    && entry.target !== '/');
}

/**
 * The host volumes that count towards this node's advertised capacity, sized in
 * whole GiB.
 *
 * A wider set than eligibleHostMounts: a loop-mounted ROOT is included, because
 * on some images that is the host disk rather than an app volume. Callers that
 * place a FLUXFSVOL want the narrower set; callers that total up node capacity
 * want this one.
 *
 * GiB, because that is the unit an app's `hdd` is spent in: `createAppVolume`
 * allocates with `fallocate -l <hdd>G`, and util-linux reads a bare `G` as
 * 1024^3. nodeSpecs.ssdStorage is GiB for the same reason - fluxbench reports
 * the disk that way - so every side of a capacity check speaks one unit.
 *
 * @returns {Promise<Array<{filesystem: string, mount: string, size: number,
 *   used: number, available: number}>>}
 */
async function capacityVolumesInGib() {
  const mounts = await deviceHelper.listMountedFilesystems();
  return mounts
    .filter((volume) => (volume.source.includes('/dev/') && !volume.source.includes('loop') && !volume.target.includes('boot'))
      || (volume.source.includes('loop') && volume.target === '/'))
    .map((volume) => ({
      filesystem: volume.source,
      mount: volume.target,
      size: Math.round(volume.sizeBytes / BYTES_PER_GIB),
      used: Math.round(volume.usedBytes / BYTES_PER_GIB),
      available: Math.round(volume.availableBytes / BYTES_PER_GIB),
    }));
}

/**
 * Every mounted app volume on this node belonging to one component, tagged with
 * the identity that owns it.
 *
 * A co-located app mounts one volume per replica, so (app, component) stopped
 * naming a single thing — the replica rides on each row instead of being lost.
 *
 * Derived FORWARD: the row states the app-identity its volumes were named from
 * and which replicas are installed here, so this builds the paths it expects and
 * looks them up. It used to walk the mount table and decode each directory name
 * back into an app and component, which asks a filesystem path to answer a
 * question only the app's row can — and stops working entirely once an identity
 * is no longer the app's name.
 *
 * @param {string} appName
 * @param {string} componentName - the component, or the app name for the
 *   v1-3 flat single-component form
 * @returns {Promise<Array<{replica: string|null, identifier: string, mount: string,
 *   filesystem: string, sizeBytes: number, usedBytes: number,
 *   availableBytes: number, capacity: number}>>}
 */
async function listComponentVolumeMounts(appName, componentName) {
  const { DeploymentSpec } = await getSpecBackend();
  const installed = await appsRepository.getInstalledApp(appName);
  if (!installed) return [];

  // Null identity is an app installed before identities were stored: its
  // artifacts are named from the app name, which is exactly what fromSpec falls
  // back to, so the same expression covers both.
  const identity = installed.identity ?? appName;
  const replicas = await appsRepository.listInstalledIdentities(appName);

  const filesystems = await deviceHelper.listMountedFilesystems();
  // Matched on the mount's own directory name, not on its full path: the apps
  // folder differs between node layouts (Arcane sets FLUX_APPS_FOLDER, a legacy
  // node does not), so which component a row belongs to is decided by what it
  // is called.
  //
  // Never last-wins. Building the Map straight from the list would let two rows
  // sharing a directory name silently resolve to whichever came second, and
  // every caller here addresses real data - reading from the wrong one is
  // confusing, writing into it overwrites what is live. One name meaning two
  // filesystems breaks the assumption the lookup rests on, so it is an error.
  const byName = new Map();
  for (const entry of filesystems) {
    const name = path.basename(entry.target);
    const seen = byName.get(name);
    if (seen) {
      throw new Error(`${name} is mounted at both ${seen.target} and ${entry.target}; refusing to guess which is ${appName}'s`);
    }
    byName.set(name, entry);
  }

  return replicas.flatMap((replica) => {
    // Two shapes are possible and only one exists on disk. A v4+ component is
    // `component_identity`; a v1-3 flat app IS its single component, so its
    // identifier is the bare identity. The two are told apart by looking, not by
    // guessing from the name — a compose app may legitimately have a component
    // named after itself, which no rule about the string can distinguish.
    const candidates = [DeploymentSpec.containerIdentifierFor(componentName, identity, replica)];
    if (componentName === appName) {
      candidates.push(replica != null ? `${identity}_${replica}` : identity);
    }
    const identifier = candidates.find((id) => byName.has(dockerService.getAppIdentifier(id)));
    if (!identifier) return [];
    const entry = byName.get(dockerService.getAppIdentifier(identifier));
    // A row outside the apps folder is not an app volume, whatever its basename
    // says. Refused rather than skipped: every caller here addresses real data,
    // and "no volume" would read as an app with nothing mounted.
    if (!entry.target.startsWith(appsFolder)) {
      throw new Error(`${identifier} is mounted at ${entry.target}, outside the apps folder; refusing to use it`);
    }
    return [{
      replica,
      identifier,
      mount: entry.target,
      filesystem: entry.source,
      sizeBytes: entry.sizeBytes,
      usedBytes: entry.usedBytes,
      availableBytes: entry.availableBytes,
      capacity: entry.usePercent / 100,
    }];
  });
}

/**
 * Whether a path currently has a filesystem mounted on it. Reads
 * /proc/self/mountinfo - one silent file read instead of forking
 * mountpoint(1), so callers can probe freely without process-spawn cost or
 * log noise. Falls back to the mountpoint binary if the read fails.
 * @param {string} dirPath Directory path to check.
 * @returns {Promise<boolean>} True if the path is a mountpoint.
 */
async function isPathMounted(dirPath) {
  const mountinfo = await fs.readFile('/proc/self/mountinfo', 'utf8').catch(() => null);
  if (mountinfo === null) {
    const result = await serviceHelper.runCommand('mountpoint', { params: ['-q', dirPath], logError: false });
    return !result.error;
  }
  const target = path.resolve(dirPath);
  // field 5 of each mountinfo line is the mount point, with space/tab/newline/
  // backslash octal-escaped
  const unescapeMount = (s) => s.replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
  return mountinfo.split('\n').some((line) => {
    const fields = line.split(' ');
    return fields.length > 4 && unescapeMount(fields[4]) === target;
  });
}

/**
 * Locates the backing FLUXFSVOL image for an app component deterministically,
 * without consulting the crontab (whose entries can silently vanish - relying
 * on them once orphaned images on removal and left volumes unmounted after
 * reboot). Candidates mirror where createAppVolume places images: the root of
 * each eligible host volume, or the appvolumes directory (proper and legacy
 * glued layout) when the root filesystem hosts them.
 * @param {string} appId Docker app identifier (e.g. fluxcomp_app).
 * @returns {Promise<string|null>} Absolute path of the image, or null.
 */
async function getVolumeFilePath(appId) {
  const volumeFileName = `${appId}FLUXFSVOL`;
  const candidates = [];

  try {
    const mounts = await eligibleHostMounts();
    mounts.forEach((mount) => {
      candidates.push(path.join(mount.target, volumeFileName));
    });
  } catch (error) {
    log.warn(`getVolumeFilePath - findmnt failed (${error.message}), falling back to appvolumes locations only`);
  }

  candidates.push(path.join(appVolumesPath, volumeFileName));
  candidates.push(path.join(legacyAppVolumesPath, volumeFileName));

  // eslint-disable-next-line no-restricted-syntax
  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await fs.access(candidate).then(() => true).catch(() => false);
    if (exists) return candidate;
  }

  return null;
}

/**
 * Derives the docker app identifiers of an app's components from the
 * FLUXFSVOL images present on disk - the image filename embeds the component
 * identifier (flux<component>_<app>FLUXFSVOL; legacy single-component apps
 * flux<app>FLUXFSVOL). Ground truth for apps whose local spec cannot
 * enumerate components: enterprise specs are stored with compose emptied and
 * decryption needs fluxbenchd, while the images need nothing.
 *
 * This one genuinely cannot be derived forward. The row states the app's
 * identity, but the COMPONENT names live in the sealed spec — so for an app
 * whose blob cannot be opened, the images on disk are the only record of which
 * components exist. It stays until the components are recorded locally at
 * install time, which is a separate change.
 * @param {string} appName Application name.
 * @returns {Promise<string[]>} Docker app identifiers whose images exist on disk.
 */
async function getComponentAppIdsFromVolumeFiles(appName) {
  const appIds = new Set();
  const searchDirs = new Set([appVolumesPath, legacyAppVolumesPath]);

  try {
    const mounts = await eligibleHostMounts();
    mounts.forEach((mount) => searchDirs.add(mount.target));
  } catch (error) {
    log.warn(`getComponentAppIdsFromVolumeFiles - findmnt failed (${error.message}), searching appvolumes locations only`);
  }

  const escapedName = appName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `\w` excludes `-` and the trailing anchor excludes a replica segment, so the
  // pattern this replaces was blind to a hyphenated component name and to every
  // named replica — and a component it cannot see is a volume nothing mounts at
  // boot, after which the reconciler defers on it forever.
  const componentImage = new RegExp(`^flux[a-z0-9-]+_${escapedName}(?:_[a-z0-9-]+)?FLUXFSVOL$`, 'i');
  const legacyImage = `flux${appName}FLUXFSVOL`;

  // eslint-disable-next-line no-restricted-syntax
  for (const dir of searchDirs) {
    // eslint-disable-next-line no-await-in-loop
    const entries = await fs.readdir(dir).catch(() => []);
    entries.forEach((entry) => {
      if (componentImage.test(entry) || entry === legacyImage) {
        appIds.add(entry.slice(0, -'FLUXFSVOL'.length));
      }
    });
  }

  return [...appIds];
}

/**
 * Ensures an app component's data volume is loop-mounted at its app dir - the
 * level-based desired state FluxOS itself owns (a rw mount replays a dirty
 * ext4 journal automatically). Idempotent: a mounted volume is a no-op. Never
 * deletes anything: content found on the bare mountpoint is shadowed by the
 * mount, loudly, so it stays recoverable underneath.
 * @param {string} identifier Component identifier (comp_app), app name, or docker app id.
 * @returns {Promise<{mounted: boolean, alreadyMounted?: boolean, reason?: string}>}
 */
async function ensureAppVolumeMounted(identifier) {
  const appId = dockerService.getAppIdentifier(identifier);
  const mountPoint = path.join(appsFolder, appId);

  if (await isPathMounted(mountPoint)) {
    return { mounted: true, alreadyMounted: true };
  }

  const volumeFile = await getVolumeFilePath(appId);
  if (!volumeFile) {
    return { mounted: false, reason: 'volume_file_missing' };
  }

  let mountPointEntries;
  try {
    mountPointEntries = await fs.readdir(mountPoint);
  } catch (error) {
    const mkdir = await serviceHelper.runCommand('mkdir', { runAsRoot: true, params: ['-p', mountPoint] });
    if (mkdir.error) {
      return { mounted: false, reason: `mount_point_unavailable: ${mkdir.error.message}` };
    }
    mountPointEntries = [];
  }

  if (mountPointEntries.length === 0) {
    // An empty bare mountpoint is locked immutable before mounting so writes
    // through it while the volume is unmounted fail with EPERM instead of
    // silently landing on the host filesystem (bypassing the app's quota and
    // getting orphaned under the next mount). The mounted volume shadows the
    // flag. Both fleet filesystems (ext4, XFS) support it, so a failure is an
    // anomaly - but the flag is defense-in-depth on top of the mount itself,
    // so it must never block bringing the app's volume up.
    const chattr = await serviceHelper.runCommand('chattr', { runAsRoot: true, params: ['+i', mountPoint], logError: false });
    if (chattr.error) {
      log.error(`ensureAppVolumeMounted - could not set ${mountPoint} immutable (unexpected on ext4/XFS): ${chattr.error.message}`);
    }
  } else {
    log.warn(`ensureAppVolumeMounted - ${mountPoint} is not mounted but holds ${mountPointEntries.length} entries; they were written while unmounted and will be shadowed by the volume`);
  }

  const mountRes = await serviceHelper.runCommand('mount', {
    runAsRoot: true, params: ['-o', APP_VOLUME_MOUNT_OPTIONS, volumeFile, mountPoint], logError: false,
  });
  if (mountRes.error) {
    // another actor (e.g. a legacy @reboot job on its last boot) may have
    // mounted in between - that is success, not an error
    if (await isPathMounted(mountPoint)) {
      return { mounted: true, alreadyMounted: true };
    }
    log.error(`ensureAppVolumeMounted - failed to mount ${volumeFile} at ${mountPoint}: ${mountRes.error.message}`);
    return { mounted: false, reason: `mount_failed: ${mountRes.error.message}` };
  }

  log.info(`ensureAppVolumeMounted - mounted ${volumeFile} at ${mountPoint}`);
  return { mounted: true, alreadyMounted: false };
}

/**
 * Verify an app's data volume is mounted at the path its identifier resolves to.
 * Takes the DEPLOYED identifier rather than the parts to rebuild one from: a
 * named replica's identifier carries its replica segment, and reassembling
 * `component_app` would check a path that either belongs to nothing or belongs
 * to a co-located sibling.
 * @param {string} identifier deployed component identifier, or a bare app name
 * @returns {Promise<boolean>} true when mounted; throws otherwise
 */
async function verifyAppVolumeMount(identifier) {
  const appId = dockerService.getAppIdentifier(identifier);
  const mountPath = `${appsFolder}${appId}`;

  const result = await serviceHelper.runCommand('findmnt', { params: ['--target', mountPath, '--json'] });
  if (result.error) {
    const errorMessage = `Volume mount verification failed for ${mountPath}. Mount does not exist or is not accessible.`;
    log.error(`${errorMessage} Details: ${result.error.message}`);
    throw new Error(errorMessage);
  }

  try {
    const parsed = JSON.parse(result.stdout);
    const mount = parsed.filesystems?.[0];
    if (mount && mount.target === mountPath) {
      log.info(`Volume mount verified for ${identifier} at ${mountPath}`);
      return true;
    }
  } catch (parseError) {
    log.error(`Volume mount verification: failed to parse findmnt output for ${mountPath}`);
  }

  throw new Error(`Volume mount verification failed for ${mountPath}. Mount does not exist or is not accessible.`);
}



/**
 * Delete everything an app holds in its volume, leaving the volume itself mounted
 * @param {string} identifier - Component identifier
 * @returns {Promise<void>}
 */
async function clearAppVolumeData(identifier) {
  const appId = dockerService.getAppIdentifier(identifier);
  const appDataPath = path.join(appsFolder, appId, 'appdata');

  // Enumerated AND deleted as root, in one command.
  //
  // Listing the directory host-side runs as the FluxOS user while the rm runs
  // under sudo, and that asymmetry is fatal for exactly the apps g: mode exists
  // to serve: a hardening image chmods its data dir (postgres does `chmod 700
  // $PGDATA`, and for a component mounting /var/lib/postgresql/data that dir IS
  // this appdata), so readdir fails EACCES. The caller treats that as a failed
  // wipe - correctly - and holds dataDesired at 'clear' with a paced retry, so
  // the component would never start again. Refusing to wipe is the right answer
  // to a wipe that failed; it is the wrong answer to one that could have
  // succeeded as root.
  //
  // find, not a shell glob: `rm -rf <dir>/*` was the old shape and hits E2BIG on
  // a large directory, misses dotfiles, and needs a shell. -mindepth 1 empties
  // the directory without removing it - the mount structure has to stay - and
  // -exec ... + batches, so this is one process rather than the concurrent,
  // uncapped rm-per-entry it replaces.
  const wipe = await serviceHelper.runCommand('find', {
    runAsRoot: true,
    params: [appDataPath, '-mindepth', '1', '-maxdepth', '1', '-exec', 'rm', '-rf', '{}', '+'],
  });

  if (wipe.error) {
    // Nothing to clear is not a failed clear: an app whose volume was never
    // populated must not hold the reconciler on a retry forever.
    //
    // Classified by exit code, never by find's message: that text is strerror
    // output, rendered in the node's locale (sudo keeps LANG/LC_* through
    // env_keep), so matching the English words works only on English nodes -
    // anywhere else a missing directory reads as a failed wipe and the
    // reconciler retries it every 5s forever. `test -d` answers with its exit
    // status alone. As root, like the wipe: an unprivileged check paired with
    // a root action fails on a data dir the image chmods to 700.
    //
    // And classified AFTER the wipe rather than checked before it: check-first
    // races toward "falsely clean" when the directory appears inside the
    // window, where this order races toward a throw - and the next pass wipes
    // whatever arrived.
    const probe = await serviceHelper.runCommand('test', {
      runAsRoot: true,
      logError: false,
      params: ['-d', appDataPath],
    });
    if (probe.error) {
      log.info(`No data to delete for app ${appId}`);
      return;
    }
    throw new Error(`Failed to delete data for app ${appId}: ${wipe.stderr || wipe.error.message || wipe.error}`);
  }

  log.info(`Deleted data for app ${appId}`);
}


/**
 * Identity of the filesystem currently mounted at a component's volume mountpoint.
 *
 * Creating a volume runs mke2fs, which mints a fresh filesystem UUID, so this value
 * distinguishes one incarnation of a component's storage from the next while surviving
 * ordinary remounts (the loop device number does not, and would read as a new volume
 * after every reboot).
 *
 * Null when this component's own volume is not mounted. That distinction is the whole
 * point: `findmnt --target` resolves the CONTAINING mountpoint, so an unmounted volume
 * reports the apps-folder filesystem, whose UUID is shared by every component on the
 * node. Comparing targets is what separates "this component's storage" from "the disk it
 * would live on".
 * @param {string} appId Docker app identifier (e.g. fluxcomp_app).
 * @returns {Promise<string|null>} Filesystem UUID, or null when it cannot be established.
 */
async function appVolumeFilesystemId(appId) {
  const mountPath = `${appsFolder}${appId}`;
  const mount = await deviceHelper.mountForTarget(mountPath).catch(() => null);
  if (!mount || mount.target !== mountPath) return null;
  return mount.uuid;
}

module.exports = {
  verifyAppVolumeMount,
  appVolumeFilesystemId,
  capacityVolumesInGib,
  isPathMounted,
  getVolumeFilePath,
  getComponentAppIdsFromVolumeFiles,
  ensureAppVolumeMounted,
  clearAppVolumeData,
  listComponentVolumeMounts,
};
