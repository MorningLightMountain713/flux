const serviceHelper = require('./serviceHelper');

/**
 * The single mounted filesystem that HOSTS `target` (its containing mountpoint), with
 * byte-level free space — `findmnt --target`. Replaces the old node-df "scan every disk
 * and pick one" probe: an app's FLUXFSVOL must live on the filesystem that holds the
 * apps folder (on Arcane that is /dat, NEVER the root/overlay disk), so we resolve that
 * one filesystem directly instead of guessing. `target` must be an existing path (a
 * non-existent leaf resolves to no mount on modern findmnt). Throws on findmnt failure
 * or an unresolvable path so a caller never silently places a volume on the wrong disk.
 * @param {string} target an existing path
 * @returns {Promise<{source: string, target: string, fstype: string, availableBytes: number}>}
 */
async function mountForTarget(target) {
  const res = await serviceHelper.runCommand('findmnt', {
    logError: false,
    params: ['--target', target, '--bytes', '--json', '--output', 'SOURCE,TARGET,FSTYPE,AVAIL'],
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
    availableBytes: Number(mount.avail),
  };
}

/**
 * Every mounted real (block-backed) filesystem with its byte-level usage — the
 * `df`-equivalent view, sourced from `findmnt --real --list` (one flat row per
 * mount, no mount-tree nesting). Replaces the old `node-df` probe wherever a full
 * mount list is needed (total node capacity, locating an app's FLUXFSVOL by its
 * mount path). `--real` drops pseudo filesystems (proc/sysfs/cgroup/tmpfs); loop
 * devices ARE real, so an app's loop-mounted FLUXFSVOL appears here. Returns []
 * if findmnt fails or finds nothing (the callers treat "no disks" as no space).
 * @returns {Promise<Array<{source: string, target: string, fstype: string, sizeBytes: number, usedBytes: number, availableBytes: number, usePercent: number}>>}
 */
async function listMountedFilesystems() {
  const res = await serviceHelper.runCommand('findmnt', {
    logError: false,
    params: ['--real', '--list', '--bytes', '--json', '--output', 'SOURCE,TARGET,FSTYPE,SIZE,USED,AVAIL,USE%'],
  });
  if (res.error) {
    throw new Error(`findmnt --real --list failed: ${res.error.message || res.error}`);
  }
  const filesystems = JSON.parse(res.stdout || '{}').filesystems || [];
  return filesystems.map((fs) => ({
    source: fs.source,
    target: fs.target,
    fstype: fs.fstype,
    sizeBytes: Number(fs.size),
    usedBytes: Number(fs.used),
    availableBytes: Number(fs.avail),
    usePercent: Number(String(fs['use%'] || '').replace('%', '')),
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

// For testing. Run: node <this file> /var/lib/docker (or another xfs target wth pquota)
if (require.main === module) {
  hasQuotaOptionForMountTarget(process.argv[2]).then((res) => console.log('Has quota:', res));
}

module.exports = {
  hasQuotaOptionForMountTarget,
  mountForTarget,
  listMountedFilesystems,
};
