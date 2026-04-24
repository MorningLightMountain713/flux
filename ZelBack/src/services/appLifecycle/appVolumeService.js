const config = require('config');
const fs = require('node:fs/promises');
const util = require('util');
const path = require('node:path');
const df = require('node-df');
const nodecmd = require('node-cmd');
const systemcrontab = require('crontab');
const serviceHelper = require('../serviceHelper');
const dockerService = require('../dockerService');
const log = require('../../lib/log');

const fluxDirPath = process.env.FLUXOS_PATH || path.join(process.env.HOME, 'zelflux');
const appsFolderPath = process.env.FLUX_APPS_FOLDER || path.join(fluxDirPath, 'ZelApps');
const appsFolder = `${appsFolderPath}/`;
const cmdAsync = util.promisify(nodecmd.run);
const crontabLoad = util.promisify(systemcrontab.load);

async function createAppVolume(deployComp, res, test = false) {
  const dfAsync = util.promisify(df);
  const identifier = deployComp.identifier;
  const appId = dockerService.getAppIdentifier(identifier);

  const effectiveHdd = test ? 2 : deployComp.storage;

  const searchSpace = {
    status: 'Searching available space...',
  };
  log.info(searchSpace);
  if (res) {
    res.write(serviceHelper.ensureString(searchSpace));
    if (res.flush) res.flush();
  }

  const dfOptions = {
    prefixMultiplier: 'GB',
    isDisplayPrefixMultiplier: false,
    precision: 0,
  };

  const dfres = await dfAsync(dfOptions);
  const okVolumes = [];
  dfres.forEach((volume) => {
    if (volume.filesystem.includes('/dev/') && !volume.filesystem.includes('loop') && !volume.mount.includes('boot')) {
      okVolumes.push(volume);
    } else if (volume.filesystem.includes('loop') && volume.mount === '/') {
      okVolumes.push(volume);
    }
  });

  const hwRequirements = require('../appRequirements/hwRequirements');
  const resourceQueryService = require('../appQuery/resourceQueryService');
  const nodeSpecs = await hwRequirements.getNodeSpecs();
  const totalSpaceOnNode = nodeSpecs.ssdStorage;
  const useableSpaceOnNode = totalSpaceOnNode * 0.95 - config.lockedSystemResources.hdd - config.lockedSystemResources.extrahdd;
  const resourcesLocked = await resourceQueryService.appsResources();
  if (resourcesLocked.status !== 'success') {
    throw new Error('Unable to obtain locked system resources by Flux App. Aborting.');
  }
  const hddLockedByApps = resourcesLocked.data.appsHddLocked;
  const availableSpaceForApps = useableSpaceOnNode - hddLockedByApps + effectiveHdd + config.fluxapps.hddFileSystemMinimum + config.fluxapps.defaultSwap;
  if (effectiveHdd >= availableSpaceForApps) {
    throw new Error('Insufficient space on Flux Node to spawn an application');
  }
  let usedSpace = 0;
  let availableSpace = 0;
  okVolumes.forEach((volume) => {
    usedSpace += serviceHelper.ensureNumber(volume.used);
    availableSpace += serviceHelper.ensureNumber(volume.available);
  });
  const fluxSystemReserve = config.lockedSystemResources.hdd + config.lockedSystemResources.extrahdd - usedSpace > 0 ? config.lockedSystemResources.hdd + config.lockedSystemResources.extrahdd - usedSpace : 0;
  const minSystemReserve = Math.max(config.lockedSystemResources.extrahdd, fluxSystemReserve);
  const totalAvailableSpaceLeft = availableSpace - minSystemReserve;
  if (effectiveHdd >= totalAvailableSpaceLeft) {
    throw new Error('Insufficient space on Flux Node. Space is already assigned to system files');
  }

  let useThisVolume = null;
  const totalVolumes = okVolumes.length;
  for (let i = 0; i < totalVolumes; i += 1) {
    if (okVolumes[i].available > effectiveHdd + minSystemReserve) {
      useThisVolume = okVolumes[i];
      break;
    }
  }
  if (!useThisVolume) {
    throw new Error('Insufficient space on Flux Node. No useable volume found.');
  }

  const searchSpace2 = { status: 'Space found' };
  log.info(searchSpace2);
  if (res) {
    res.write(serviceHelper.ensureString(searchSpace2));
    if (res.flush) res.flush();
  }

  try {
    const allocateSpace = { status: 'Allocating space...' };
    log.info(allocateSpace);
    if (res) {
      res.write(serviceHelper.ensureString(allocateSpace));
      if (res.flush) res.flush();
    }

    let execDD = `sudo fallocate -l ${effectiveHdd}G ${useThisVolume.mount}/${appId}FLUXFSVOL`;
    if (useThisVolume.mount === '/') {
      const execMkdir = `sudo mkdir -p ${fluxDirPath}appvolumes`;
      await cmdAsync(execMkdir);
      execDD = `sudo fallocate -l ${effectiveHdd}G ${fluxDirPath}appvolumes/${appId}FLUXFSVOL`;
    }

    await cmdAsync(execDD);
    const allocateSpace2 = { status: 'Space allocated' };
    log.info(allocateSpace2);
    if (res) {
      res.write(serviceHelper.ensureString(allocateSpace2));
      if (res.flush) res.flush();
    }

    const makeFilesystem = { status: 'Creating filesystem...' };
    log.info(makeFilesystem);
    if (res) {
      res.write(serviceHelper.ensureString(makeFilesystem));
      if (res.flush) res.flush();
    }
    let execFS = `sudo mke2fs -t ext4 ${useThisVolume.mount}/${appId}FLUXFSVOL`;
    if (useThisVolume.mount === '/') {
      execFS = `sudo mke2fs -t ext4 ${fluxDirPath}appvolumes/${appId}FLUXFSVOL`;
    }
    await cmdAsync(execFS);
    const makeFilesystem2 = { status: 'Filesystem created' };
    log.info(makeFilesystem2);
    if (res) {
      res.write(serviceHelper.ensureString(makeFilesystem2));
      if (res.flush) res.flush();
    }

    const makeDirectory = { status: 'Making directory...' };
    log.info(makeDirectory);
    if (res) {
      res.write(serviceHelper.ensureString(makeDirectory));
      if (res.flush) res.flush();
    }
    const execDIR = `sudo mkdir -p ${appsFolder + appId}`;
    await cmdAsync(execDIR);
    const makeDirectory2 = { status: 'Directory made' };
    log.info(makeDirectory2);
    if (res) {
      res.write(serviceHelper.ensureString(makeDirectory2));
      if (res.flush) res.flush();
    }

    const mountingStatus = { status: 'Mounting volume...' };
    log.info(mountingStatus);
    if (res) {
      res.write(serviceHelper.ensureString(mountingStatus));
      if (res.flush) res.flush();
    }
    let volumeFile = `${useThisVolume.mount}/${appId}FLUXFSVOL`;
    if (useThisVolume.mount === '/') {
      volumeFile = `${fluxDirPath}appvolumes/${appId}FLUXFSVOL`;
    }
    const execMount = `while [ ! -f ${volumeFile} ]; do sleep 5; done && sudo mount -o loop ${volumeFile} ${appsFolder + appId}`;
    await cmdAsync(`sudo mount -o loop ${volumeFile} ${appsFolder + appId}`);
    const mountingStatus2 = { status: 'Volume mounted' };
    log.info(mountingStatus2);
    if (res) {
      res.write(serviceHelper.ensureString(mountingStatus2));
      if (res.flush) res.flush();
    }

    const makeAppDataDir = { status: 'Creating appdata directory...' };
    log.info(makeAppDataDir);
    if (res) {
      res.write(serviceHelper.ensureString(makeAppDataDir));
      if (res.flush) res.flush();
    }
    const execAppdataDir = `sudo mkdir -p ${appsFolder + appId}/appdata`;
    await cmdAsync(execAppdataDir);
    const makeAppDataDir2 = { status: 'Appdata directory created' };
    log.info(makeAppDataDir2);
    if (res) {
      res.write(serviceHelper.ensureString(makeAppDataDir2));
      if (res.flush) res.flush();
    }

    const makeDirectoryB = { status: 'Making application data directories and files...' };
    log.info(makeDirectoryB);
    if (res) {
      res.write(serviceHelper.ensureString(makeDirectoryB));
      if (res.flush) res.flush();
    }

    const compDir = `${appsFolder}${appId}`;
    log.info(`Creating ${deployComp.mounts.length} mount source(s) for ${appId}`);

    for (const mount of deployComp.mounts) {
      if (mount.Source === `${compDir}/appdata`) {
        continue; // eslint-disable-line no-continue
      }
      const sourceName = mount.Source.replace(`${compDir}/`, '');
      if (mount.sourceType === 'file') {
        const status = { status: `Creating file mount: ${sourceName}...` };
        log.info(status);
        if (res) { res.write(serviceHelper.ensureString(status)); if (res.flush) res.flush(); }

        // eslint-disable-next-line no-await-in-loop
        await serviceHelper.runCommand('touch', { params: [mount.Source], runAsRoot: true });
        // eslint-disable-next-line no-await-in-loop
        await serviceHelper.runCommand('chmod', { params: ['777', mount.Source], runAsRoot: true });

        const done = { status: `File mount created: ${sourceName}` };
        log.info(done);
        if (res) { res.write(serviceHelper.ensureString(done)); if (res.flush) res.flush(); }
      } else {
        const status = { status: `Creating directory: ${sourceName}...` };
        log.info(status);
        if (res) { res.write(serviceHelper.ensureString(status)); if (res.flush) res.flush(); }

        // eslint-disable-next-line no-await-in-loop
        await serviceHelper.runCommand('mkdir', { params: ['-p', mount.Source], runAsRoot: true });

        const done = { status: `Directory created: ${sourceName}` };
        log.info(done);
        if (res) { res.write(serviceHelper.ensureString(done)); if (res.flush) res.flush(); }
      }
    }

    const makeDirectoryB2 = { status: 'Application data directories and files created' };
    log.info(makeDirectoryB2);
    if (res) {
      res.write(serviceHelper.ensureString(makeDirectoryB2));
      if (res.flush) res.flush();
    }

    const permissionsDirectory = { status: 'Adjusting permissions...' };
    log.info(permissionsDirectory);
    if (res) {
      res.write(serviceHelper.ensureString(permissionsDirectory));
      if (res.flush) res.flush();
    }
    await serviceHelper.runCommand('chmod', { params: ['777', compDir], runAsRoot: true });
    await serviceHelper.runCommand('chmod', { params: ['777', `${compDir}/appdata`], runAsRoot: true });

    for (const mount of deployComp.mounts) {
      if (mount.Source === `${compDir}/appdata`) {
        continue; // eslint-disable-line no-continue
      }
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.runCommand('chmod', { params: ['777', mount.Source], runAsRoot: true });
    }
    const permissionsDirectory2 = { status: 'Permissions adjusted' };
    log.info(permissionsDirectory2);
    if (res) {
      res.write(serviceHelper.ensureString(permissionsDirectory2));
      if (res.flush) res.flush();
    }

    if (deployComp.sync) {
      const stFolderCreation = { status: 'Creating .stfolder for syncthing...' };
      log.info(stFolderCreation);
      if (res) {
        res.write(serviceHelper.ensureString(stFolderCreation));
        if (res.flush) res.flush();
      }
      await serviceHelper.runCommand('mkdir', { params: ['-p', `${compDir}/.stfolder`], runAsRoot: true });
      const stFolderCreation2 = { status: '.stfolder created' };
      log.info(stFolderCreation2);
      if (res) {
        res.write(serviceHelper.ensureString(stFolderCreation2));
        if (res.flush) res.flush();
      }

      await fs.writeFile(`${compDir}/.stignore`, '/backup\n');
      const stiFileCreation = { status: '.stignore created' };
      log.info(stiFileCreation);
      if (res) {
        res.write(serviceHelper.ensureString(stiFileCreation));
        if (res.flush) res.flush();
      }
    }

    const cronStatus = { status: 'Creating crontab...' };
    log.info(cronStatus);
    if (res) {
      res.write(serviceHelper.ensureString(cronStatus));
      if (res.flush) res.flush();
    }
    const crontab = await crontabLoad();
    const jobs = crontab.jobs();
    let exists = false;
    jobs.forEach((job) => {
      if (job.comment() === appId) {
        exists = true;
      }
      if (!job || !job.isValid()) {
        crontab.remove(job);
      }
    });
    if (!exists) {
      const job = crontab.create(execMount, '@reboot', appId);
      if (job == null) {
        throw new Error('Failed to create a cron job');
      }
      if (!job.isValid()) {
        throw new Error('Failed to create a valid cron job');
      }
      crontab.save();
    }
    const cronStatusB = { status: 'Crontab adjusted.' };
    log.info(cronStatusB);
    if (res) {
      res.write(serviceHelper.ensureString(cronStatusB));
      if (res.flush) res.flush();
    }
    const messageHelper = require('../messageHelper');
    const message = messageHelper.createSuccessMessage('Flux App volume creation completed.');
    return message;
  } catch (error) {
    clearInterval(global.allocationInterval);
    clearInterval(global.verificationInterval);
    const cleaningRemoval = { status: 'ERROR OCCURED: Pre-removal cleaning...' };
    log.info(cleaningRemoval);
    if (res) {
      res.write(serviceHelper.ensureString(cleaningRemoval));
      if (res.flush) res.flush();
    }
    const execUnmount = `sudo umount ${appsFolder + appId}`;
    // eslint-disable-next-line no-unused-vars
    await cmdAsync(execUnmount).catch((_e) => {
      log.warn('Volume not mounted or already unmounted during cleanup');
    });
    let execRemoveAlloc = `sudo rm -rf ${useThisVolume.mount}/${appId}FLUXFSVOL`;
    if (useThisVolume.mount === '/') {
      execRemoveAlloc = `sudo rm -rf ${fluxDirPath}appvolumes/${appId}FLUXFSVOL`;
    }
    await cmdAsync(execRemoveAlloc).catch((e) => log.error(e));
    const execFinal = `sudo rm -rf ${appsFolder + appId}`;
    await cmdAsync(execFinal).catch((e) => log.error(e));
    const aloocationRemoval2 = { status: 'Pre-removal cleaning completed. Forcing removal.' };
    log.info(aloocationRemoval2);
    if (res) {
      res.write(serviceHelper.ensureString(aloocationRemoval2));
      if (res.flush) res.flush();
    }
    throw error;
  }
}

async function ensureMountSourcesExist(deployComp) {
  for (const mount of deployComp.mounts) {
    try {
      await fs.access(mount.Source); // eslint-disable-line no-await-in-loop
    } catch {
      log.warn(`Mount source missing, creating: ${mount.Source}`);
      if (mount.sourceType === 'file') {
        // eslint-disable-next-line no-await-in-loop
        await serviceHelper.runCommand('touch', { params: [mount.Source], runAsRoot: true });
        // eslint-disable-next-line no-await-in-loop
        await serviceHelper.runCommand('chmod', { params: ['777', mount.Source], runAsRoot: true });
      } else {
        // eslint-disable-next-line no-await-in-loop
        await serviceHelper.runCommand('mkdir', { params: ['-p', mount.Source], runAsRoot: true });
      }
    }
  }
}

async function removeSyncthingFolder(appComponentName, res) {
  try {
    const identifier = appComponentName;
    const appId = dockerService.getAppIdentifier(identifier);
    const folder = `${appsFolder + appId}`;
    const syncthingService = require('../syncthingService');
    const allSyncthingFolders = await syncthingService.getConfigFolders();
    if (allSyncthingFolders.status === 'error') {
      return;
    }
    let folderId = null;
    // eslint-disable-next-line no-restricted-syntax
    for (const syncthingFolder of allSyncthingFolders.data) {
      if (syncthingFolder.path === folder || syncthingFolder.path.includes(`${folder}/`)) {
        folderId = syncthingFolder.id;
      }
      if (folderId) {
        const adjustSyncthingA = {
          status: `Stopping syncthing on folder ${syncthingFolder.path}...`,
        };
        // eslint-disable-next-line no-await-in-loop
        await syncthingService.adjustConfigFolders('delete', undefined, folderId);
        // eslint-disable-next-line no-await-in-loop
        const restartRequired = await syncthingService.getConfigRestartRequired();
        if (restartRequired.status === 'success' && restartRequired.data.requiresRestart === true) {
          log.info('Syncthing restart required, restarting...');
          // eslint-disable-next-line no-await-in-loop
          await syncthingService.systemRestart();
        }
        const adjustSyncthingB = {
          status: 'Syncthing adjusted',
        };
        log.info(adjustSyncthingA);
        if (res) {
          res.write(serviceHelper.ensureString(adjustSyncthingA));
          if (res.flush) res.flush();
        }
        if (res) {
          res.write(serviceHelper.ensureString(adjustSyncthingB));
          if (res.flush) res.flush();
        }
      }
      folderId = null;
    }
  } catch (error) {
    log.error(error);
  }
}

module.exports = {
  createAppVolume,
  ensureMountSourcesExist,
  removeSyncthingFolder,
};
