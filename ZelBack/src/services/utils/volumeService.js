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
 * Filesystems no app volume belongs on, whatever room they report free.
 *
 * tmpfs, ramfs and devtmpfs hold their contents in memory and lose them at a
 * reboot. overlay and squashfs are not that - an overlay's upper layer is on
 * disk and squashfs is a read-only image - but both belong to something else:
 * an overlay is a container's own writable layer, and a squashfs cannot be
 * written to at all.
 */
const UNUSABLE_FSTYPES = new Set(['tmpfs', 'ramfs', 'devtmpfs', 'overlay', 'squashfs']);

/**
 * Filesystems whose bytes are on another machine. `fallocate` is unsupported on
 * CIFS and on NFSv3, so an image cannot be created on one at all, and where it
 * can the app's data is hostage to a share that can go away while the node
 * keeps running.
 *
 * `findmnt --real` excludes libmount's pseudo filesystems and nothing else, so
 * most of these arrive in the mount table looking like any local disk. A few
 * are on that list too and never arrive; they are named here anyway, because
 * which entries libmount carries is its business and not a thing to depend on.
 */
const REMOTE_FSTYPES = new Set(['nfs', 'nfs4', 'cifs', 'smb3', 'smbfs',
  'afs', 'ncpfs', 'ceph', 'glusterfs', 'lustre', 'gpfs', 'beegfs',
  'virtiofs', '9p']);

/**
 * Filesystems an image is not PLACED on, though one already sitting on any of
 * them is still found.
 *
 * A volume is created with `fallocate` and loop-mounted with an ext4 inside
 * it. `vfat` and `msdos` cap a file at 4 GiB, under the size of most volumes;
 * for the rest that sequence is not established on anything the fleet runs,
 * and `fuseblk` does not even name the driver it would go through - ntfs-3g
 * and exfat-fuse both arrive under it. `createAppVolume` takes one candidate
 * and never falls back, so a filesystem that cannot carry the sequence fails
 * the install outright rather than costing the node a disk.
 */
const UNPLACEABLE_FSTYPES = new Set(['vfat', 'msdos', 'exfat', 'ntfs', 'ntfs3', 'fuseblk']);

/**
 * Where a container runtime keeps the filesystems it owns.
 *
 * A runtime mounts each container's root under its own data directory, and on
 * a storage driver that uses real filesystems - ZFS, btrfs - those mounts are
 * indistinguishable from a disk by fstype alone. An image placed in one lands
 * inside somebody else's container, and is destroyed with it; an image LOOKED
 * FOR in one can be answered by a file the container's owner put there.
 *
 * Neither belongs to this node to use, on any filesystem, so the rule is not
 * about ZFS - it is that a runtime's storage is the runtime's.
 *
 * What is UNDER the directory, never the directory itself: an operator giving
 * docker its own disk mounts it at exactly this path, and that disk is an
 * ordinary one to place on. Nothing a container owns reaches the root of the
 * data directory - only the runtime writes there.
 */
const RUNTIME_DATA_DIRS = ['/var/lib/docker', '/var/lib/containerd', '/var/lib/lxd',
  '/var/snap/lxd/common/lxd', '/var/lib/kubelet', '/dat/var/lib/docker'];

/**
 * A mount row in the unit an app's storage is spent in.
 *
 * Whole GiB, because `createAppVolume` allocates with `fallocate -l <hdd>G`
 * and util-linux reads a bare `G` as 1024^3. Room worth exactly twenty of
 * those has to read as 20, and twenty decimal GB has to read as less, or a
 * node admits an app it is 7.4% short for and finds out at ENOSPC.
 *
 * @param {object} volume One mount row from deviceHelper.
 * @returns {{filesystem: string, mount: string, size: number, used: number,
 *   available: number}} The same mount, in whole GiB.
 */
function inGib(volume) {
  return {
    filesystem: volume.source,
    mount: volume.target,
    size: Math.round(volume.sizeBytes / BYTES_PER_GIB),
    used: Math.round(volume.usedBytes / BYTES_PER_GIB),
    available: Math.round(volume.availableBytes / BYTES_PER_GIB),
  };
}

/**
 * One row per device.
 *
 * `findmnt` names a bind mount and a btrfs subvolume `<device>[<subpath>]`, so
 * a single disk is reported once per bind - in a containerised FluxOS that is
 * `/etc/hostname`, `/etc/hosts` and `/etc/resolv.conf` beside the data volume,
 * four views of one disk reporting its free space four times.
 *
 * Which view survives is an arbitrary tie-break on the shortest target. They
 * are views of one disk, so they agree on every number; all it settles is the
 * directory an image is written into, and the mount table says nothing about
 * which of two directories on a disk was meant for one.
 *
 * Device identity is not filesystem identity. ZFS names each dataset in a pool
 * separately while every one of them reports the pool's free space, so a pool
 * arrives here as one row per dataset and leaves that way. What each row has
 * USED is its own and adds up across rows; what it has FREE may belong to
 * another row too, and does not.
 *
 * @param {Array<object>} rows Mount rows from deviceHelper.
 * @returns {Array<object>} One row per distinct device.
 */
function oneRowPerDevice(rows) {
  const byDevice = new Map();
  rows.forEach((row) => {
    const device = String(row.source).split('[')[0];
    const held = byDevice.get(device);
    if (!held || row.target.length < held.target.length) byDevice.set(device, row);
  });
  return Array.from(byDevice.values());
}

/**
 * Whether an image may be FOUND on this filesystem: is it this machine's
 * storage, in a place one may sit.
 *
 * Location and ownership only. The filesystem's TYPE is not asked, because an
 * image already written to a disk is readable whatever the disk is formatted
 * as, and an earlier release placed images by source alone. Narrowing a search
 * by type reports those images missing, which is a tampering event against the
 * operator and an orphan on the disk.
 *
 * `findmnt --real` has already dropped the pseudo filesystems and a container's
 * own overlay, so what is left to exclude is storage on another machine, the
 * boot disk, and the app volumes this node has already placed: an app's image
 * is carved out of one of these filesystems, so counting it counts the same
 * bytes twice. A loop mount IS such an image - except at the root, where a loop
 * is the host disk itself.
 *
 * @param {object} mount One mount row from deviceHelper.
 * @returns {boolean} True when an image may be looked for on the filesystem.
 */
function isSearchableFilesystem(mount) {
  const fstype = String(mount.fstype || '');
  if (UNUSABLE_FSTYPES.has(fstype)) return false;
  // A fuse type names the driver rather than the backing, and the drivers that
  // reach across a network are open-ended: gluster and sshfs arrive as
  // `fuse.glusterfs` and `fuse.sshfs`, the object stores as `fuse.rclone`,
  // `fuse.s3fs`, `fuse.gcsfuse`. A bare `fuse` is on libmount's pseudofs list
  // and never survives `findmnt --real`, so there is nothing here to test it
  // for. A local fuse pool loses nothing by the rule: the disks it pools are
  // mounted in their own right. `fuseblk` is the block-backed form and IS this
  // machine's storage, so it is searched - it is only refused a new image.
  if (REMOTE_FSTYPES.has(fstype) || fstype.startsWith('fuse.')) return false;
  if (mount.target === '/boot' || mount.target.startsWith('/boot/')) return false;
  const device = String(mount.source).split('[')[0];
  if (device.startsWith('/dev/loop') && mount.target !== '/') return false;
  // Strict descendants of each, never the directory itself: a runtime owns
  // what it mounts underneath its data directory, while the directory may be a
  // disk an operator gave it, and an app's volume is mounted at
  // <appsFolder>/<appId> while the folder itself is ordinary. An image sits at
  // <appId>FLUXFSVOL, which collides with no mount point.
  if (RUNTIME_DATA_DIRS.some((dir) => mount.target.startsWith(`${dir}/`))) return false;
  const appsRoot = appsFolder.replace(/\/+$/, '');
  return !mount.target.startsWith(`${appsRoot}/`);
}

/**
 * Whether an image may be PUT on this filesystem.
 *
 * Everywhere one may be found, less the types that cannot carry a new one.
 * The narrower question, and the one that must never be asked of a search:
 * a type refused here still holds every image an earlier release placed on it.
 *
 * @param {object} mount One mount row from deviceHelper.
 * @returns {boolean} True when an image may be created on the filesystem.
 */
function isHostFilesystem(mount) {
  if (!isSearchableFilesystem(mount)) return false;
  return !UNPLACEABLE_FSTYPES.has(String(mount.fstype || ''));
}

/**
 * The mount a path resolves through: the last row listed at that exact target.
 *
 * @param {string} target Absolute path of a mount point.
 * @param {Array<object>} mounts Mount rows, in mount table order.
 * @returns {object|null} The visible row, or null when nothing is mounted there.
 */
function visibleMountAt(target, mounts) {
  const at = String(target).replace(/\/+$/, '');
  const stack = mounts.filter((mount) => String(mount.target).replace(/\/+$/, '') === at);
  return stack.length ? stack[stack.length - 1] : null;
}

/**
 * Whether a FLUXFSVOL image can be created in this mount.
 *
 * The image is a file written into the mount point, so the mount point has to
 * be a directory and has to be writable. A device cannot answer either.
 *
 * A row with another mount stacked over it answers for a filesystem the path
 * no longer reaches - neither its `ro` flag nor its free space describes what
 * a write there would do - so only the mount a path resolves through is a
 * candidate. Asked of every mount the kernel holds and not of the block-backed
 * ones alone, because a tmpfs laid over a disk is the case that turns a
 * multi-gigabyte image into RAM the app loses at the next restart.
 *
 * @param {object} mount One mount row from deviceHelper.
 * @param {Array<object>} allMounts Every mount, in mount table order.
 * @returns {Promise<boolean>} True when an image can be written there.
 */
async function canHoldAppVolume(mount, allMounts) {
  const visible = visibleMountAt(mount.target, allMounts);
  // Only ever used to REFUSE: a candidate reaches here from the block-backed
  // table, so nothing this list contains can promote one. When no row at the
  // target names this mount's source the comparison has nothing to say and
  // the candidate is left to the rules below. Abstaining that way keeps the
  // disk; abstaining the other way would refuse EVERY disk the moment the two
  // readings disagreed about how to spell a source, and a node that can place
  // nothing is a worse answer than one that placed where it always has.
  if (visible && visible.source !== mount.source) return false;
  if (mount.readOnly) return false;
  const stats = await fs.stat(mount.target).catch(() => null);
  return Boolean(stats && stats.isDirectory());
}

/**
 * The filesystems an app's FLUXFSVOL image may be placed on, most free space
 * first, one row per filesystem, sized in whole GiB.
 *
 * Ranked rather than merely listed, because the caller takes the first that
 * fits: ordering by free space makes that the emptiest disk, where mount-table
 * order would make it whichever the kernel happened to report first.
 *
 * Deduplicated after the write check and not before, so a disk is not lost to a
 * bind of it that happens to be a file.
 *
 * @returns {Promise<Array<{filesystem: string, mount: string, size: number,
 *   used: number, available: number}>>}
 */
async function placementVolumesInGib() {
  const mounts = await deviceHelper.listMountedFilesystems();
  // Every mount, for the shadowing question alone: what a write to a candidate
  // actually lands on is whatever the kernel resolves that path through, which
  // need not be block-backed and so need not appear above.
  // Throws with the reading above rather than falling back to it: answering
  // the shadowing question from the block-backed table is answering it from
  // the one table that cannot show a pseudo mount, which is the case the
  // question exists for. A caller must no more read "nothing is stacked here"
  // out of a table it did not get than it may read "no disks" as "no space".
  const allMounts = await deviceHelper.listAllMounts();
  const hosts = mounts.filter(isHostFilesystem);
  const writable = [];
  for (const mount of hosts) {
    // eslint-disable-next-line no-await-in-loop
    if (await canHoldAppVolume(mount, allMounts)) writable.push(mount);
  }
  // A filesystem the node may use and cannot write to is worth a line: the
  // caller's only other output is "No useable volume found", which names
  // nothing, and a disk lost to a traversal denied or a path answering EIO
  // otherwise looks exactly like a disk the node never had.
  if (writable.length !== hosts.length) {
    const refused = hosts.filter((mount) => !writable.includes(mount)).map((mount) => mount.target);
    log.info(`placementVolumesInGib - not a writable directory this node reaches, so not offered: ${refused.join(', ')}`);
  }
  return oneRowPerDevice(writable)
    .sort((a, b) => b.availableBytes - a.availableBytes)
    .map(inGib);
}

/**
 * The mounts an app's FLUXFSVOL image may be found on.
 *
 * Where an image may be FOUND, which is a wider question than where one may be
 * PUT: an image on a filesystem that has since come up read-only is still
 * perfectly readable, and refusing to look there reports it missing. Placement
 * asks the write question; this asks only containment.
 *
 * The root is left out because an image the root hosts is written to the
 * appvolumes directory instead, which callers search separately.
 *
 * Not deduplicated: two directories on one disk are two places an image can
 * sit, and a search that visited only one of them would miss it.
 *
 * @returns {Promise<Array<object>>} mount rows from deviceHelper
 */
async function eligibleHostMounts() {
  const mounts = await deviceHelper.listMountedFilesystems();
  return mounts.filter((mount) => isSearchableFilesystem(mount) && mount.target !== '/');
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

  // 'null' is the v1-3 flat form's address: an app with no compose array is
  // its own single component, and every caller that speaks the v1 API names
  // that component so.
  const component = componentName === 'null' ? appName : componentName;

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
    const candidates = [DeploymentSpec.containerIdentifierFor(component, identity, replica)];
    if (component === appName) {
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
  placementVolumesInGib,
  isPathMounted,
  getVolumeFilePath,
  getComponentAppIdsFromVolumeFiles,
  ensureAppVolumeMounted,
  listComponentVolumeMounts,
};
