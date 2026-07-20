const fs = require('fs').promises;
const path = require('node:path');
const deviceHelper = require('../deviceHelper');
const dockerService = require('../dockerService');
const serviceHelper = require('../serviceHelper');
const log = require('../../lib/log');
const { getSpecBackend } = require('./specLibs');
const { appsFolder, appVolumesPath, legacyAppVolumesPath } = require('./appConstants');

/**
 * Every mounted app volume on this node belonging to one component, tagged with
 * the identity that owns it.
 *
 * A co-located app mounts one volume per replica, so (app, component) stopped
 * naming a single thing — the replica rides on each row instead of being lost.
 *
 * Each mount is identified by DECODING its identifier through flux-spec's own
 * decoders, never by matching a rebuilt `flux<component>_<app>` pattern:
 * reassembling that rule here is what dropped the replica segment and made a
 * co-located pair look like one volume. The decoders are reached through the
 * async backend, not the sync bridge — this is a request path with no reason to
 * assume someone else has already warmed the loader.
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
  const filesystems = await deviceHelper.listMountedFilesystems();

  return filesystems.flatMap((entry) => {
    const base = path.basename(entry.target);
    if (!base.startsWith('flux')) return [];
    const identifier = base.slice('flux'.length);

    // The mount table carries every filesystem on the box; anything that does
    // not decode as an app identifier simply is not one of ours.
    let decoded;
    try {
      decoded = {
        app: DeploymentSpec.appNameFromIdentifier(identifier),
        component: DeploymentSpec.componentNameFromIdentifier(identifier),
        replica: DeploymentSpec.replicaFromIdentifier(identifier),
      };
    } catch (error) {
      return [];
    }

    if (decoded.app !== appName) return [];
    if (decoded.component !== componentName) return [];

    return [{
      replica: decoded.replica,
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
 * The one mounted volume belonging to a single identity, or null.
 *
 * The replica is required and nullable (null for loose placement) rather than
 * optional: every caller addresses real data, and silently picking a sibling is
 * the failure this exists to prevent — a restore into the wrong replica
 * overwrites live data.
 *
 * @param {string} appName
 * @param {string} componentName
 * @param {string|null} replica
 * @returns {Promise<object|null>}
 */
async function volumeMountForIdentity(appName, componentName, replica) {
  if (replica === undefined) {
    throw new Error(`volumeMountForIdentity for ${componentName} of ${appName} requires an explicit replica (null for loose placement)`);
  }
  const mounts = await listComponentVolumeMounts(appName, componentName);
  return mounts.find((mount) => mount.replica === (replica ?? null)) || null;
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
    const filesystems = await deviceHelper.listMountedFilesystems();
    filesystems.forEach((volume) => {
      const eligible = volume.source.includes('/dev/') && !volume.source.includes('loop')
        && !volume.target.includes('boot') && volume.target !== '/';
      if (eligible) {
        candidates.push(path.join(volume.target, volumeFileName));
      }
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
 * @param {string} appName Application name.
 * @returns {Promise<string[]>} Docker app identifiers whose images exist on disk.
 */
async function getComponentAppIdsFromVolumeFiles(appName) {
  const appIds = new Set();
  const searchDirs = new Set([appVolumesPath, legacyAppVolumesPath]);

  try {
    const filesystems = await deviceHelper.listMountedFilesystems();
    filesystems.forEach((volume) => {
      const eligible = volume.source.includes('/dev/') && !volume.source.includes('loop')
        && !volume.target.includes('boot') && volume.target !== '/';
      if (eligible) {
        searchDirs.add(volume.target);
      }
    });
  } catch (error) {
    log.warn(`getComponentAppIdsFromVolumeFiles - findmnt failed (${error.message}), searching appvolumes locations only`);
  }

  const escapedName = appName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const componentImage = new RegExp(`^flux\\w+_${escapedName}FLUXFSVOL$`);
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
    runAsRoot: true, params: ['-o', 'loop', volumeFile, mountPoint], logError: false,
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
module.exports = {
  verifyAppVolumeMount,
  isPathMounted,
  getVolumeFilePath,
  getComponentAppIdsFromVolumeFiles,
  ensureAppVolumeMounted,
  listComponentVolumeMounts,
  volumeMountForIdentity,
};
