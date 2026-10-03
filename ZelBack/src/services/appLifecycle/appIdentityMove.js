'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const appsRepository = require('../appDatabase/appsRepository');
const appHistory = require('../appDecisions/appHistory');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const dockerService = require('../dockerService');
const volumeService = require('../utils/volumeService');
const appsRuntimeState = require('../appManagement/appsRuntimeState');
const { stopAppMonitoring } = require('../appManagement/appInspector');
const syncthingService = require('../syncthingService');
const appDockerNetwork = require('../appNetwork/appDockerNetwork');
const componentProvisioner = require('./componentProvisioner');
const appNetworkLinker = require('./appNetworkLinker');
const appOperations = require('./appOperations');
const shutdownPlan = require('./shutdownPlan');
const fluxShutdowndClient = require('../utils/fluxShutdowndClient');
const operationRegistry = require('../utils/operationRegistry');
const serviceHelper = require('../serviceHelper');
const fluxEventBus = require('../utils/fluxEventBus');
const { getSpec } = require('../utils/specLibs');
const { ConfigMethod } = require('../utils/syncthingConstants');
const { appsFolder } = require('../utils/appConstants');
const log = require('../../lib/log');

// Moves an app installed under its name onto the identity its registration
// mints, so that every container, directory, image and network of the app is
// named the way a v9 node names them. The identity is the uuid's, read off the
// row or off the applied decision of the row's message. The syncthing folder id
// is the one thing the name keeps (DeploymentComponent.syncFolderId): the
// folder's path moves and its id does not, so a peer that has not moved goes on
// sharing it.
//
// Runs before the boot reconcile decides, while the reconciler actuates
// nothing. Each app is moved under its own lease, one at a time: the old
// container goes, the runtime state is rekeyed, the volume moves, the folder is
// re-pointed, the network exists under the identity, the row names the identity
// and the containers are recreated on the kept volume for the reconciler to
// start. The row names the identity before the recreate, so a recreate that
// fails leaves a row the reconciler already finishes on its own. Each step asks
// the world whether it is still needed, and the row carries the move while it
// is in progress, so a run interrupted anywhere resumes at the next start and a
// row already on its identity is never touched.
//
// Data is moved with mv, never copied: syncthing compares a file's mtime, and a
// copy would make every file of the folder look changed to every peer.

// The docker names a component carried before the move: the 8.x prefixed forms,
// and the bare identifier of a container created under the name since.
const FORMER_NAME_PREFIXES = ['flux', 'zel', ''];

function formerContainerNames(identifier) {
  return FORMER_NAME_PREFIXES.map((prefix) => `${prefix}${identifier}`);
}

async function exists(filePath) {
  return fs.access(filePath).then(() => true).catch(() => false);
}

async function run(command, params) {
  const result = await serviceHelper.runCommand(command, { runAsRoot: true, params, logError: false });
  if (result.error) throw new Error(`${command} ${params.join(' ')}: ${result.error.message}`);
  return result;
}

/**
 * The uuid an installed app's registration minted and the version it was
 * registered with: off the row, else off the applied decision of the row's
 * message, which carries both for a registration and for every update after
 * it. Null when no applied decision names the row's message: the app is
 * leaving the list, and the boot reconcile removes it.
 *
 * @param {object} installed - InstantiatedSpec of the row
 * @returns {Promise<{uuid: string, registrationVersion: number, fromRow: boolean}|null>}
 */
async function registrationOf(installed) {
  const { uuid, registrationVersion } = installed;
  if (uuid && Number.isInteger(registrationVersion)) return { uuid, registrationVersion, fromRow: true };
  const applied = (await appHistory.appliedMessages(installed.name))
    .find(({ decision }) => decision.hash === installed.hash);
  if (!applied) return null;
  const found = {
    uuid: uuid ?? applied.decision.uuid ?? null,
    registrationVersion: Number.isInteger(registrationVersion) ? registrationVersion : (applied.decision.registrationVersion ?? null),
  };
  if (!found.uuid || !Number.isInteger(found.registrationVersion)) return null;
  return { ...found, fromRow: false };
}

/**
 * Stops and removes the container a component ran in under its former name.
 * The stop goes through the shutdown daemon when the component's shutdown
 * does, as a redeploy's does. A former container that is not there is a step
 * already taken.
 *
 * @param {object} installed - InstantiatedSpec of the row
 * @param {string|null} replica
 * @param {object} formerComp - the component of the deployment built under the name
 */
async function removeFormerContainer(installed, replica, formerComp) {
  // eslint-disable-next-line no-restricted-syntax
  for (const name of formerContainerNames(formerComp.identifier)) {
    // eslint-disable-next-line no-await-in-loop
    if (await dockerService.getDockerContainer(name)) {
      stopAppMonitoring(formerComp.identifier, true);
      // eslint-disable-next-line no-await-in-loop
      const stopHandled = await appOperations.requestComponentDaemonStop(installed.owner, installed.name, replica, formerComp);
      // eslint-disable-next-line no-await-in-loop
      if (!stopHandled) await dockerService.appDockerStop(name);
      // eslint-disable-next-line no-await-in-loop
      await dockerService.appDockerRemove(name);
      // eslint-disable-next-line no-await-in-loop
      if (await dockerService.getDockerContainer(name)) {
        // eslint-disable-next-line no-await-in-loop
        await dockerService.appDockerForceRemove(name);
      }
      // eslint-disable-next-line no-await-in-loop
      if (await dockerService.getDockerContainer(name)) {
        throw new Error(`${name} is still present after its removal`);
      }
      log.info(`appIdentityMove - removed ${name}`);
    }
  }
}

/**
 * The backing image of a component's volume under its former identifier: the
 * file the kernel mounts at the former directory when it is mounted, else the
 * image this node recorded, else the image found by its 8.x name, else by its
 * bare one. Null when none is there.
 *
 * @param {string} formerIdentifier
 * @param {string} formerDir
 * @returns {Promise<{path: string, fsUuid: string|null}|null>}
 */
async function formerImage(formerIdentifier, formerDir) {
  if (await volumeService.isPathMounted(formerDir)) {
    const backing = await volumeService.mountedImagePath(formerDir);
    if (backing) {
      const recorded = await appsRuntimeState.getVolumeImage(formerIdentifier).catch(() => null);
      const fsUuid = recorded && recorded.path === backing ? recorded.fsUuid : await volumeService.imageFsUuid(backing);
      return { path: backing, fsUuid: fsUuid || null };
    }
  }
  const recorded = await appsRuntimeState.getVolumeImage(formerIdentifier);
  if (recorded && await exists(recorded.path)) return recorded;
  // eslint-disable-next-line no-restricted-syntax
  for (const named of [`flux${formerIdentifier}`, formerIdentifier]) {
    // eslint-disable-next-line no-await-in-loop
    const found = await volumeService.getVolumeFilePath(named);
    if (found.path) {
      // eslint-disable-next-line no-await-in-loop
      return { path: found.path, fsUuid: (await volumeService.imageFsUuid(found.path)) || null };
    }
  }
  return null;
}

/**
 * Moves a component's volume onto its identity: the former directory is
 * unmounted, the image is renamed beside itself and recorded under the new
 * identifier with the stamp it carries, the directory is renamed, and the
 * volume is mounted at the new path through the one path every mount takes.
 * An image already in place is recorded and mounted without a rename.
 *
 * @param {object} formerComp
 * @param {object} comp - the same component of the deployment built under the identity
 */
async function moveVolume(formerComp, comp) {
  const formerDir = `${appsFolder}${formerComp.identifier}`;
  const dir = `${appsFolder}${comp.identifier}`;

  let image = await formerImage(formerComp.identifier, formerDir);
  if (await volumeService.isPathMounted(formerDir)) await run('umount', [formerDir]);

  if (!image) {
    const placed = await appsRuntimeState.getVolumeImage(comp.identifier);
    if (placed && await exists(placed.path)) image = placed;
  }
  if (image) {
    const target = path.join(path.dirname(image.path), `${comp.identifier}FLUXFSVOL`);
    if (image.path !== target) await run('mv', [image.path, target]);
    const fsUuid = image.fsUuid || await volumeService.imageFsUuid(target);
    await volumeService.recordNewVolumeImage(comp.identifier, target, fsUuid);
  }

  if (await exists(formerDir) && !await exists(dir)) {
    await serviceHelper.runCommand('chattr', { runAsRoot: true, params: ['-i', formerDir], logError: false });
    await run('mv', [formerDir, dir]);
  }

  if (!image) {
    log.warn(`appIdentityMove - no image found for ${formerComp.identifier}; the reconciler reports the volume`);
    return;
  }
  const mounted = await volumeService.ensureAppVolumeMounted(comp.identifier);
  if (!mounted.mounted) {
    throw new Error(`the volume of ${comp.identifier} could not be mounted at ${dir}: ${mounted.reason}`);
  }
}

/**
 * Points a component's syncthing folder, by its kept id, at the directory the
 * identity names. The monitor writes the same path on its first pass, so a
 * syncthing that cannot answer now costs the move nothing.
 *
 * @param {object} comp - the component of the deployment built under the identity
 */
async function repointFolder(comp) {
  const id = comp.syncFolderId;
  const target = `${appsFolder}${comp.identifier}`;
  try {
    const folder = await syncthingService.getConfigFolders(id);
    if (!folder || !folder.id || folder.path === target) return false;
    await syncthingService.adjustConfigFolders({ method: ConfigMethod.PATCH, id, config: { path: target } });
    return true;
  } catch (error) {
    if (error.httpStatus === 404) return false;
    log.warn(`appIdentityMove - folder ${id} keeps its path for now: ${error.message}`);
    return false;
  }
}

/**
 * Recreates an app's containers under the identity its row now names, on the
 * volumes kept, for the reconciler to start; attaches each to the networks of
 * the apps it links; and hands the shutdown daemon the plan the new names make.
 *
 * @param {string} name
 * @param {string|null} replica
 * @param {string} uuid
 */
async function recreate(name, replica, uuid) {
  const installed = await appsRepository.getInstalledIdentity(name, replica);
  const deployment = await deploymentProvider.buildDeployment(installed, { replica });
  const requiresEncryption = shutdownPlan.appRequiresDaemonShutdown(deployment);
  // eslint-disable-next-line no-restricted-syntax
  for (const [, component] of deployment.componentEntries()) {
    // eslint-disable-next-line no-await-in-loop
    await componentProvisioner.installComponent(component, {
      createVolumes: false,
      skipPorts: true,
      allowLocalImageFallback: true,
      specVersion: installed.version,
      owner: installed.owner,
      uuid,
      requiresEncryption,
    });
    // eslint-disable-next-line no-await-in-loop
    await appNetworkLinker.connectComponentToLinkedApps(component.identifier, deployment, component.qualifiedNetworkAliases);
  }
  if (requiresEncryption) {
    await fluxShutdowndClient.upsertAppPlanBestEffort(shutdownPlan.buildShutdownPlan(installed, deployment))
      .catch((error) => log.warn(`appIdentityMove - shutdown plan for ${name} not delivered: ${error.message}`));
  }
}

/**
 * Moves one identity's row and everything it names onto the identity.
 *
 * @param {{name: string, replica: string|null}} row
 * @param {{appIdentityFromUuid: Function}} spec
 * @returns {Promise<{moved: boolean, reason?: string, from?: string, to?: string}>}
 */
async function moveRow(row, { appIdentityFromUuid }) {
  const { name, replica } = row;
  let installed = await appsRepository.getInstalledIdentity(name, replica);
  if (!installed) return { moved: false, reason: 'the row cannot be read yet' };
  const registration = await registrationOf(installed);
  if (!registration) return { moved: false, reason: 'no applied decision names its uuid' };
  if (!registration.fromRow) {
    await appsRepository.setInstalledRegistration(name, replica, registration);
    installed = await appsRepository.getInstalledIdentity(name, replica);
  }
  const from = installed.identity;
  const to = appIdentityFromUuid(registration.uuid);

  const token = operationRegistry.acquire(name, 'move', 'appIdentityMove', `moving ${name} onto ${to}`);
  if (!token) return { moved: false, reason: 'held by another operation' };
  try {
    const former = await deploymentProvider.buildDeployment(installed, { replica });
    const next = await deploymentProvider.buildDeployment(installed, { replica, identity: to });
    await appsRepository.setInstalledMove(name, replica, { to, since: Date.now() });

    // eslint-disable-next-line no-restricted-syntax
    for (const [componentName, formerComp] of former.componentEntries()) {
      const comp = next.getComponent(componentName);
      // eslint-disable-next-line no-await-in-loop
      await removeFormerContainer(installed, replica, formerComp);
      // Before the image is recorded under the new identifier: the record is
      // one field of this document, and the move's own write outranks a carried one.
      // eslint-disable-next-line no-await-in-loop
      await appsRuntimeState.rekey(formerComp.identifier, comp.identifier);
      // eslint-disable-next-line no-await-in-loop
      if (!formerComp.isStateless) await moveVolume(formerComp, comp);
      // eslint-disable-next-line no-await-in-loop
      if (comp.hasSyncthing()) await repointFolder(comp);
    }

    await appDockerNetwork.ensureAppDockerNetwork(name, { networkName: next.networkName });
    await appsRepository.setInstalledIdentity(name, replica, to, next.componentEntries().map(([, c]) => c.identifier));
    await recreate(name, replica, registration.uuid);
    await dockerService.removeFluxAppDockerNetwork(from)
      .catch((error) => log.warn(`appIdentityMove - ${former.networkName} stays until it is empty: ${error.message}`));
    fluxEventBus.publish('app:movedOntoIdentity', {
      name, replica, from, to,
    });
    return { moved: true, from, to };
  } finally {
    operationRegistry.release(name, token);
  }
}

/**
 * Moves every installed app whose identity is not its registration's onto it.
 * One app at a time; a failure is logged and the next app is moved, and the
 * failed one resumes at the next start from the record on its row.
 *
 * @returns {Promise<{moved: object[], skipped: object[], failed: object[]}>}
 */
async function moveInstalledAppsOntoIdentity() {
  const results = { moved: [], skipped: [], failed: [] };
  const { isAppIdentity, appIdentityFromUuid } = await getSpec();
  const rows = await appsRepository.listInstalledRows();
  const due = rows.filter((row) => !isAppIdentity(row.identity));
  if (due.length === 0) {
    log.info(`appIdentityMove - every installed app (${rows.length}) is on its identity`);
    return results;
  }
  log.info(`appIdentityMove - ${due.length} of ${rows.length} installed row(s) still named by their name`);
  const startedAt = Date.now();
  // eslint-disable-next-line no-restricted-syntax
  for (const row of due) {
    const label = row.replica ? `${row.name} replica ${row.replica}` : row.name;
    try {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await moveRow(row, { appIdentityFromUuid });
      if (outcome.moved) {
        log.info(`appIdentityMove - ${label} moved from ${outcome.from} onto ${outcome.to}`);
        results.moved.push({ name: row.name, replica: row.replica, to: outcome.to });
      } else {
        log.warn(`appIdentityMove - ${label} not moved: ${outcome.reason}`);
        results.skipped.push({ name: row.name, replica: row.replica, reason: outcome.reason });
      }
    } catch (error) {
      log.error(`appIdentityMove - ${label} failed, resuming at the next start: ${error.message}`);
      results.failed.push({ name: row.name, replica: row.replica, error: error.message });
    }
  }
  log.info(`appIdentityMove - moved ${results.moved.length}, skipped ${results.skipped.length}, failed ${results.failed.length} in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  return results;
}

module.exports = {
  moveInstalledAppsOntoIdentity,
  // exposed for tests
  moveRow,
  registrationOf,
  formerContainerNames,
};
