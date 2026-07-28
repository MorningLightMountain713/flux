const serviceHelper = require('./serviceHelper');

/**
 * The single mounted filesystem that HOSTS `target` (its containing mountpoint), with
 * byte-level free space — `findmnt --target`. Replaces the old node-df "scan every disk
 * and pick one" probe: an app's FLUXFSVOL must live on the filesystem that holds the
 * apps folder (on Arcane that is /dat, NEVER the root/overlay disk), so we resolve that
 * one filesystem directly instead of guessing. `target` must be an existing path (a
 * non-existent leaf resolves to no mount on modern findmnt). Throws on findmnt failure
 * or an unresolvable path so a caller never silently places a volume on the wrong disk.
 *
 * `uuid` identifies the filesystem itself and survives remounts, so it distinguishes one
 * incarnation of a volume from the next: rebuilding one runs mke2fs, which mints a fresh
 * UUID. Null on filesystems that carry none (tmpfs, overlay).
 * @param {string} target an existing path
 * @returns {Promise<{source: string, target: string, fstype: string, uuid: string|null, availableBytes: number}>}
 */
async function mountForTarget(target) {
  const res = await serviceHelper.runCommand('findmnt', {
    logError: false,
    params: ['--target', target, '--bytes', '--json', '--output', 'SOURCE,TARGET,FSTYPE,UUID,AVAIL'],
  });
  if (res.error) {
    throw new Error(`findmnt --target ${target} failed: ${res.error.message || res.error}`);
  }
  const [mount] = JSON.parse(res.stdout || '{}').filesystems || [];
  if (!mount) {
    throw new Error(`findmnt --target ${target} resolved no mounted filesystem`);
  }
  return {
    source: mount.source,
    target: mount.target,
    fstype: mount.fstype,
    uuid: mount.uuid ?? null,
    availableBytes: Number(mount.avail),
  };
}

/**
 * Every mounted real (block-backed) filesystem with its byte-level usage.
 *
 * This is the `df` view, sourced from `findmnt --real --list`: one flat row per
 * mount, no mount-tree nesting. `--real` drops the pseudo filesystems
 * (proc/sysfs/cgroup/tmpfs); loop devices ARE real, so an app's loop-mounted
 * FLUXFSVOL appears here.
 *
 * Byte counts come from `--bytes`, so they need no unit conversion.
 *
 * Throws on findmnt failure rather than returning [], so a caller cannot read
 * "no disks" as "no space" and act on it.
 *
 * @returns {Promise<Array<{source: string, target: string, fstype: string,
 *   options: string, readOnly: boolean, sizeBytes: number, usedBytes: number,
 *   availableBytes: number, usePercent: number}>>}
 */
async function listMountedFilesystems() {
  const res = await serviceHelper.runCommand('findmnt', {
    logError: false,
    params: ['--real', '--list', '--bytes', '--json', '--output', 'SOURCE,TARGET,FSTYPE,OPTIONS,SIZE,USED,AVAIL,USE%'],
  });
  if (res.error) {
    throw new Error(`findmnt --real --list failed: ${res.error.message || res.error}`);
  }
  const filesystems = JSON.parse(res.stdout || '{}').filesystems || [];
  return filesystems.map((entry) => ({
    source: entry.source,
    target: entry.target,
    fstype: entry.fstype,
    options: String(entry.options || ''),
    readOnly: String(entry.options || '').split(',').includes('ro'),
    sizeBytes: Number(entry.size),
    usedBytes: Number(entry.used),
    availableBytes: Number(entry.avail),
    usePercent: Number(String(entry['use%'] || '').replace('%', '')),
  }));
}

/**
 * Determines if mount target has a filesystem quota
 * @param {string} target The mount target
 * @returns {Promise<Boolean>} If the device has a quota
 */
async function hasQuotaOptionForMountTarget(target) {
  // this could just be reading and parsing /proc/self/mountinfo
  // then we don't need to use child process

  // As per `man mount`... use findmnt instead of mount:
  //   Listing the mounts
  //   The listing mode is maintained for backward compatibility only.

  //   For more robust and customizable output use findmnt(8), especially in your scripts. Note that control characters in the
  //   mountpoint name are replaced with '?'.

  //   here is a sample of what the output looks like: (I don't have xfs backed fs)

  // this was tested using:
  //   fallocate -l 100m pquotaFS
  //   mkfs.xfs pquotaFS
  //   mkdir pquotaFSMOUNT
  //   sudo mount -o pquota pquotaFS pquotaFSMOUNT

  //   davew@charlie:~$ findmnt --target /home/davew/pquotaFSMOUNT --options prjquota
  // TARGET                    SOURCE     FSTYPE OPTIONS
  // /home/davew/pquotaFSMOUNT /dev/loop7 xfs    rw,relatime,attr2,inode64,logbufs=8,logbsize=32k,prjquota

  // if there is no pquota, the above will return empty

  // output is parseable with --json option, but we don't need it here
  const { stdout } = await serviceHelper.runCommand('findmnt', { logError: false, params: ['--target', target, '--options', 'prjquota'] });

  return Boolean(stdout);
}

/**
 * Every mount the kernel holds, pseudo filesystems included.
 *
 * `listMountedFilesystems` answers the df question, and `--real` drops
 * libmount's pseudo filesystems - tmpfs, overlay, proc and their kind. It
 * keeps everything else including the network ones, so it is not a
 * block-backed filter. This answers a different question - what a path
 * resolves through - and a tmpfs or an overlay laid over a disk is exactly
 * what decides that, which is precisely what `--real` removes. No byte
 * counts: a caller asking this is asking about visibility, not about room.
 *
 * Throws on findmnt failure, so a caller cannot read "nothing is mounted
 * there" out of a table it never got.
 *
 * @returns {Promise<Array<{source: string, target: string, fstype: string,
 *   options: string, readOnly: boolean}>>}
 */
async function listAllMounts() {
  const res = await serviceHelper.runCommand('findmnt', {
    logError: false,
    params: ['--list', '--json', '--output', 'SOURCE,TARGET,FSTYPE,OPTIONS'],
  });
  if (res.error) {
    throw new Error(`findmnt --list failed: ${res.error.message || res.error}`);
  }
  const filesystems = JSON.parse(res.stdout || '{}').filesystems || [];
  return filesystems.map((entry) => ({
    source: entry.source,
    target: entry.target,
    fstype: entry.fstype,
    options: String(entry.options || ''),
    readOnly: String(entry.options || '').split(',').includes('ro'),
  }));
}

// For testing. Run: node <this file> /var/lib/docker (or another xfs target wth pquota)
if (require.main === module) {
  hasQuotaOptionForMountTarget(process.argv[2]).then((res) => console.log('Has quota:', res));
}

module.exports = {
  hasQuotaOptionForMountTarget,
  listAllMounts,
  listMountedFilesystems,
  mountForTarget,
};
