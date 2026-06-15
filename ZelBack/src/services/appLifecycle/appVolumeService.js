const config = require('config');
const fs = require('node:fs/promises');
const util = require('util');
const path = require('node:path');
const df = require('node-df');
const nodecmd = require('node-cmd');
const systemcrontab = require('crontab');
const serviceHelper = require('../serviceHelper');
const dockerService = require('../dockerService');
const messageHelper = require('../messageHelper');
const hwRequirements = require('../appRequirements/hwRequirements');
const resourceQueryService = require('../appQuery/resourceQueryService');
const syncthingService = require('../syncthingService');
const log = require('../../lib/log');

const fluxDirPath = process.env.FLUXOS_PATH || path.join(process.env.HOME, 'zelflux');
const appsFolderPath = process.env.FLUX_APPS_FOLDER || path.join(fluxDirPath, 'ZelApps');
const appsFolder = `${appsFolderPath}/`;
const cmdAsync = util.promisify(nodecmd.run);
const crontabLoad = util.promisify(systemcrontab.load);

function emitStatus(res, status) {
  log.info(status);
  if (res) {
    res.write(serviceHelper.ensureString(status));
    if (res.flush) res.flush();
  }
}

async function createAppVolume(deployComp, res, test = false) {
  const dfAsync = util.promisify(df);
  const identifier = deployComp.identifier;
  const appId = dockerService.getAppIdentifier(identifier);
  const effectiveHdd = test ? 2 : deployComp.storage;

  emitStatus(res, { status: 'Searching available space...' });

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
  const fluxSystemReserve = config.lockedSystemResources.hdd + config.lockedSystemResources.extrahdd - usedSpace > 0
    ? config.lockedSystemResources.hdd + config.lockedSystemResources.extrahdd - usedSpace : 0;
  const minSystemReserve = Math.max(config.lockedSystemResources.extrahdd, fluxSystemReserve);
  const totalAvailableSpaceLeft = availableSpace - minSystemReserve;
  if (effectiveHdd >= totalAvailableSpaceLeft) {
    throw new Error('Insufficient space on Flux Node. Space is already assigned to system files');
  }

  let useThisVolume = null;
  for (let i = 0; i < okVolumes.length; i += 1) {
    if (okVolumes[i].available > effectiveHdd + minSystemReserve) {
      useThisVolume = okVolumes[i];
      break;
    }
  }
  if (!useThisVolume) {
    throw new Error('Insufficient space on Flux Node. No useable volume found.');
  }

  emitStatus(res, { status: 'Space found' });

  try {
    emitStatus(res, { status: 'Allocating space...' });

    let volumeFile;
    if (useThisVolume.mount === '/') {
      await cmdAsync(`sudo mkdir -p ${fluxDirPath}appvolumes`);
      volumeFile = `${fluxDirPath}appvolumes/${appId}FLUXFSVOL`;
    } else {
      volumeFile = `${useThisVolume.mount}/${appId}FLUXFSVOL`;
    }

    await cmdAsync(`sudo fallocate -l ${effectiveHdd}G ${volumeFile}`);
    emitStatus(res, { status: 'Space allocated' });

    emitStatus(res, { status: 'Creating filesystem...' });
    await cmdAsync(`sudo mke2fs -t ext4 ${volumeFile}`);
    emitStatus(res, { status: 'Filesystem created' });

    emitStatus(res, { status: 'Making directory...' });
    await cmdAsync(`sudo mkdir -p ${appsFolder + appId}`);
    emitStatus(res, { status: 'Directory made' });

    emitStatus(res, { status: 'Mounting volume...' });
    const execMount = `while [ ! -f ${volumeFile} ]; do sleep 5; done && sudo mount -o loop ${volumeFile} ${appsFolder + appId}`;
    await cmdAsync(`sudo mount -o loop ${volumeFile} ${appsFolder + appId}`);
    emitStatus(res, { status: 'Volume mounted' });

    emitStatus(res, { status: 'Creating appdata directory...' });
    await cmdAsync(`sudo mkdir -p ${appsFolder + appId}/appdata`);
    emitStatus(res, { status: 'Appdata directory created' });

    emitStatus(res, { status: 'Making application data directories and files...' });
    const compDir = `${appsFolder}${appId}`;
    log.info(`Creating ${deployComp.mounts.length} mount source(s) for ${appId}`);

    for (const mount of deployComp.mounts) {
      if (mount.Source === `${compDir}/appdata`) continue;
      const sourceName = mount.Source.replace(`${compDir}/`, '');
      if (mount.sourceType === 'file') {
        emitStatus(res, { status: `Creating file mount: ${sourceName}...` });
        // eslint-disable-next-line no-await-in-loop
        await serviceHelper.runCommand('touch', { params: [mount.Source], runAsRoot: true });
        // eslint-disable-next-line no-await-in-loop
        await serviceHelper.runCommand('chmod', { params: ['777', mount.Source], runAsRoot: true });
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
    await serviceHelper.runCommand('chmod', { params: ['777', `${compDir}/appdata`], runAsRoot: true });
    for (const mount of deployComp.mounts) {
      if (mount.Source === `${compDir}/appdata`) continue;
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.runCommand('chmod', { params: ['777', mount.Source], runAsRoot: true });
    }
    emitStatus(res, { status: 'Permissions adjusted' });

    if (deployComp.sync) {
      emitStatus(res, { status: 'Creating .stfolder for syncthing...' });
      await serviceHelper.runCommand('mkdir', { params: ['-p', `${compDir}/.stfolder`], runAsRoot: true });
      emitStatus(res, { status: '.stfolder created' });

      await fs.writeFile(`${compDir}/.stignore`, '/backup\n');
      emitStatus(res, { status: '.stignore created' });
    }

    emitStatus(res, { status: 'Creating crontab...' });
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
    emitStatus(res, { status: 'Crontab adjusted.' });

    return messageHelper.createSuccessMessage('Flux App volume creation completed.');
  } catch (error) {
    clearInterval(global.allocationInterval);
    clearInterval(global.verificationInterval);
    emitStatus(res, { status: 'ERROR OCCURED: Pre-removal cleaning...' });
    await cmdAsync(`sudo umount ${appsFolder + appId}`).catch(() => {
      log.warn('Volume not mounted or already unmounted during cleanup');
    });
    let volumeFilePath;
    if (useThisVolume.mount === '/') {
      volumeFilePath = `${fluxDirPath}appvolumes/${appId}FLUXFSVOL`;
    } else {
      volumeFilePath = `${useThisVolume.mount}/${appId}FLUXFSVOL`;
    }
    await cmdAsync(`sudo rm -rf ${volumeFilePath}`).catch((e) => log.error(e));
    await cmdAsync(`sudo rm -rf ${appsFolder + appId}`).catch((e) => log.error(e));
    emitStatus(res, { status: 'Pre-removal cleaning completed. Forcing removal.' });
    throw error;
  }
}

/**
 * Ensure every bind-mount source for a component exists before its container is
 * (re)created on the soft/volume-reuse path. The operations are unconditional and
 * idempotent (`mkdir -p` / `touch`), so there is no check-then-act (TOCTOU) window
 * inside this helper.
 */
async function ensureMountSourcesExist(deployComp) {
  for (const mount of deployComp.mounts) {
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

async function removeSyncthingFolder(appComponentName, res) {
  try {
    const identifier = appComponentName;
    const appId = dockerService.getAppIdentifier(identifier);
    const folder = `${appsFolder + appId}`;
    const allSyncthingFolders = await syncthingService.getConfigFolders();
    if (allSyncthingFolders.status === 'error') {
      return;
    }
    let folderId = null;
    for (const syncthingFolder of allSyncthingFolders.data) {
      if (syncthingFolder.path === folder || syncthingFolder.path.includes(`${folder}/`)) {
        folderId = syncthingFolder.id;
      }
      if (folderId) {
        const adjustSyncthingA = { status: `Stopping syncthing on folder ${syncthingFolder.path}...` };
        // eslint-disable-next-line no-await-in-loop
        await syncthingService.adjustConfigFolders('delete', undefined, folderId);
        // eslint-disable-next-line no-await-in-loop
        const restartRequired = await syncthingService.getConfigRestartRequired();
        if (restartRequired.status === 'success' && restartRequired.data.requiresRestart === true) {
          log.info('Syncthing restart required, restarting...');
          // eslint-disable-next-line no-await-in-loop
          await syncthingService.systemRestart();
        }
        emitStatus(res, adjustSyncthingA);
        emitStatus(res, { status: 'Syncthing adjusted' });
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
