'use strict';

const fs = require('fs').promises;
const path = require('node:path');
const deviceHelper = require('../deviceHelper');
const dockerService = require('../dockerService');
const serviceHelper = require('../serviceHelper');
const log = require('../../lib/log');
const { getSpecBackend } = require('./specLibs');
const appsRepository = require('../appDatabase/appsRepository');
const { appsFolder, appVolumesPath, legacyAppVolumesPath } = require('./appConstants');

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
  // node does not), and a volume is this component's because of what it is
  // called, not because of where the layout happens to put it.
  const byName = new Map(filesystems.map((entry) => [path.basename(entry.target), entry]));

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
  isPathMounted,
  getVolumeFilePath,
  getComponentAppIdsFromVolumeFiles,
  ensureAppVolumeMounted,
  listComponentVolumeMounts,
  volumeMountForIdentity,
};
