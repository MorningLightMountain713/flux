'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const appRecords = require('../appDatabase/appRecords');
const appIdentityMoveStore = require('./appIdentityMoveStore');
const installedLedger = require('./installedLedger');
const specLibrary = require('../utils/specLibrary');
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
const { nodeChain } = require('../utils/nodeChain');

// Moves an app installed under its name onto the identity its registration
// mints, so that every container, directory, image and network of the app is
// named the way a v9 node names them. The identity is the uuid's, read off the
// row or off the applied decision of the row's message. The syncthing folder id
// is the one thing the name keeps (DeploymentComponent.syncFolderId): the
// folder's path moves and its id does not, so a peer that has not moved goes on
// sharing it.
//
// Runs before the boot reconcile decides, while the reconciler actuates
// nothing, and inside the window the fleet gives a node to announce itself
// again after a stop. Every former container on the node is stopped at once,
// so the node pays docker's grace once; then each app is moved in turn: the
// old container goes, the runtime state is rekeyed, the volume moves, the
// folder is re-pointed, the network exists under the identity, the row names
// the identity, and the containers are recreated on the kept volume, from the
// image already on this daemon, for the reconciler to start.
//
// The row names the identity before the recreate, so a recreate that fails
// leaves a row the reconciler already finishes on its own, and a volume that
// will not mount leaves the mount and the create to the reconciler as well.
// Each step asks the world whether it is still needed, and a step that fails is
// tried again on the spot. An app that still cannot be finished keeps its
// lease, which holds the reconciler and the syncthing monitor off it, and is
// tried again on a timer until it completes; a start runs the boot move again,
// which continues from wherever the world is. A row already on its identity is
// never touched.
//
// Data is renamed, never copied: syncthing compares a file's mtime, and a copy
// would make every file of the folder look changed to every peer.

// The docker names a component carried before the move: the 8.x prefixed forms,
// and the bare identifier of a container created under the name since.
const FORMER_NAME_PREFIXES = ['flux', 'zel', ''];
const ATTEMPTS = 3;
const ATTEMPT_DELAY_MS = 2000;
const RETRY_MS = 60 * 1000;

// The apps whose move did not complete, by row, each holding its lease until it does.
const held = new Map();
let retryTimer = null;

function rowKey(name, replica) {
  return `${name}|${replica ?? ''}`;
}

function formerContainerNames(identifier) {
  return FORMER_NAME_PREFIXES.map((prefix) => `${prefix}${identifier}`);
}

async function exists(filePath) {
  return fs.access(filePath).then(() => true).catch(() => false);
}

/**
 * The directory a component's volume had before the move, under the same names
 * its container carried: the 8.x prefixed forms, then the bare identifier. The
 * first that exists, else the 8.x form.
 * @param {string} identifier
 * @returns {Promise<string>}
 */
async function formerDirectory(identifier) {
  const candidates = formerContainerNames(identifier).map((name) => `${appsFolder}${name}`);
  // eslint-disable-next-line no-restricted-syntax
  for (const dir of candidates) {
    // eslint-disable-next-line no-await-in-loop
    if (await exists(dir)) return dir;
  }
  return candidates[0];
}

async function run(command, params) {
  const result = await serviceHelper.runCommand(command, { runAsRoot: true, params, logError: false });
  if (result.error) throw new Error(`${command} ${params.join(' ')}: ${result.error.message}`);
  return result;
}

/**
 * Runs a step up to ATTEMPTS times, a pause between tries. The last error is
 * the one thrown.
 *
 * @param {string} label
 * @param {() => Promise<*>} step
 */
async function attempt(label, step) {
  let lastError;
  for (let i = 1; i <= ATTEMPTS; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await step();
    } catch (error) {
      lastError = error;
      if (i < ATTEMPTS) {
        log.warn(`appIdentityMove - ${label} failed (${error.message}); attempt ${i + 1} of ${ATTEMPTS}`);
        // eslint-disable-next-line no-await-in-loop
        await serviceHelper.delay(ATTEMPT_DELAY_MS);
      }
    }
  }
  throw lastError;
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
/**
 * Writes an instance's record with the registered fields changed, keeping its
 * replica, its removal owed and its component keys.
 * @param {object} installed - the InstalledSpec
 * @param {object} fields - the registered fields to change
 */
async function putRecord(installed, fields) {
  const { InstalledSpec, InstantiatedSpec } = specLibrary.loaded();
  const registered = InstantiatedSpec.deserialize({ ...installed.record.serialize(), ...fields }, { chain: nodeChain() });
  await appRecords.installed().put(new InstalledSpec({
    record: registered, replica: installed.replica, owed: installed.owed, componentKeys: installed.componentKeys,
  }));
}

async function registrationOf(installed) {
  let { uuid } = installed;
  const fromRow = Boolean(uuid);
  if (!uuid) {
    const applied = (await appHistory.appliedMessages(installed.name))
      .find(({ decision }) => decision.hash === installed.hash);
    uuid = applied?.decision.uuid ?? null;
    if (!uuid) return null;
  }
  const registrationVersion = await appHistory.registrationVersionOf(installed.name, uuid);
  if (!Number.isInteger(registrationVersion)) return null;
  return { uuid, registrationVersion, fromRow };
}

/**
 * Everything one row's move needs, read before anything is touched, with the
 * app's lease taken: the deployment under the name and the deployment under
 * the identity. A row already on its identity is done; one that cannot be
 * read, whose uuid nothing names, whose app another operation holds or whose
 * deployment cannot be built is not planned, and says why.
 *
 * @param {{name: string, replica: string|null}} row
 * @param {{isAppIdentity: Function, appIdentityFromUuid: Function}} spec
 * @returns {Promise<object>}
 */
async function planRow(row, { isAppIdentity, appIdentityFromUuid }) {
  const { name, replica } = row;
  let installed = await appRecords.installed().byReplica(name, replica);
  if (!installed) return { name, replica, skipped: 'the row cannot be read yet' };
  if (isAppIdentity(installed.identity)) return { name, replica, done: true };
  const registration = await registrationOf(installed);
  if (!registration) return { name, replica, skipped: 'no applied registration names its uuid and version' };
  if (!registration.fromRow) {
    await putRecord(installed, { uuid: registration.uuid });
    installed = await appRecords.installed().byReplica(name, replica);
  }
  const to = appIdentityFromUuid(registration.uuid);
  const token = operationRegistry.acquire(name, 'move', 'appIdentityMove', `moving ${name} onto ${to}`);
  if (!token) return { name, replica, skipped: 'held by another operation' };
  try {
    const former = await deploymentProvider.buildDeployment(installed, { replica });
    const next = await deploymentProvider.planDeployment(installed.record, {
      replica, identity: to, registrationVersion: registration.registrationVersion, componentKeys: installed.componentKeys,
    });
    return {
      name, replica, installed, registration, from: installed.identity, to, former, next, token,
    };
  } catch (error) {
    operationRegistry.release(name, token);
    return { name, replica, skipped: `its deployment cannot be built: ${error.message}` };
  }
}

/**
 * Stops the container a component runs in under its former name, through the
 * shutdown daemon when the component's shutdown does, as a redeploy's does. A
 * former container that is not there, or not running, costs nothing.
 *
 * @param {object} plan
 * @param {object} formerComp - the component of the deployment built under the name
 */
async function stopFormerContainer(plan, formerComp) {
  // eslint-disable-next-line no-restricted-syntax
  for (const name of formerContainerNames(formerComp.identifier)) {
    // eslint-disable-next-line no-await-in-loop
    if (await dockerService.getDockerContainer(name)) {
      stopAppMonitoring(formerComp.identifier, true);
      // eslint-disable-next-line no-await-in-loop
      const handled = await appOperations.requestComponentDaemonStop(shutdownPlan.daemonIdentity(plan.installed), plan.name, plan.replica, formerComp);
      // eslint-disable-next-line no-await-in-loop
      if (!handled) await dockerService.appDockerStop(name);
    }
  }
}

/**
 * Removes the container a component ran in under its former name, forcing it
 * when a plain remove leaves it. One that is not there is a step already taken.
 *
 * @param {object} formerComp
 */
async function removeFormerContainer(formerComp) {
  // eslint-disable-next-line no-restricted-syntax
  for (const name of formerContainerNames(formerComp.identifier)) {
    // eslint-disable-next-line no-await-in-loop
    if (await dockerService.getDockerContainer(name)) {
      // eslint-disable-next-line no-await-in-loop
      await dockerService.appDockerRemove(name).catch((error) => log.warn(`appIdentityMove - remove ${name}: ${error.message}`));
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
 * image the ledger names, else the image found by its 8.x name, else by its
 * bare one. Null when none is there.
 *
 * @param {string} formerIdentifier
 * @param {string} formerDir
 * @returns {Promise<{path: string, fsUuid: string|null}|null>}
 */
async function formerImage(formerIdentifier, formerDir) {
  const recorded = await volumeService.recordedVolumeImage(formerIdentifier);
  return installedLedger.discoverVolumeImage(formerIdentifier, recorded, [formerDir]);
}

/**
 * Moves a component's volume onto its identity: the former directory is
 * unmounted, the image is renamed beside itself, and the directory is
 * renamed. An image already in place is left where it is. The volume is
 * mounted once the ledger names it, after the record flips.
 *
 * @param {object} formerComp
 * @param {object} comp - the same component of the deployment built under the identity
 * @returns {Promise<{path: string, fsUuid: string|null}|null>} the image under the
 *   identity, with the stamp it carries, or null when none is there
 */
async function moveVolume(formerComp, comp) {
  const formerDir = await formerDirectory(formerComp.identifier);
  const dir = `${appsFolder}${comp.identifier}`;

  let image = await formerImage(formerComp.identifier, formerDir);
  if (await volumeService.isPathMounted(formerDir)) await run('umount', [formerDir]);

  if (!image) {
    const placed = await volumeService.getVolumeFilePath(comp.identifier);
    if (placed.path) image = { path: placed.path, fsUuid: (await volumeService.imageFsUuid(placed.path)) || null };
  }
  if (image) {
    const target = path.join(path.dirname(image.path), `${comp.identifier}FLUXFSVOL`);
    if (image.path !== target) await run('mv', [image.path, target]);
    image = { path: target, fsUuid: image.fsUuid || (await volumeService.imageFsUuid(target)) || null };
  }

  if (await exists(formerDir) && !await exists(dir)) {
    await serviceHelper.runCommand('chattr', { runAsRoot: true, params: ['-i', formerDir], logError: false });
    await run('mv', [formerDir, dir]);
  }

  return image;
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
 * volumes kept and from the images on this daemon, for the reconciler to
 * start; attaches each to the networks of the apps it links; and hands the
 * shutdown daemon the plan the new names make. A container already there is
 * left as it is.
 *
 * @param {string} name
 * @param {string|null} replica
 * @param {string} uuid
 */
async function recreate(name, replica, uuid) {
  const installed = await appRecords.installed().byReplica(name, replica);
  const deployment = await deploymentProvider.buildDeployment(installed, { replica });
  const requiresEncryption = shutdownPlan.appRequiresDaemonShutdown(deployment);
  // eslint-disable-next-line no-restricted-syntax
  for (const [, component] of deployment.componentEntries()) {
    // eslint-disable-next-line no-await-in-loop
    if (await dockerService.getDockerContainer(component.identifier)) continue;
    // eslint-disable-next-line no-await-in-loop
    await componentProvisioner.installComponent(component, {
      createVolumes: false,
      skipPorts: true,
      localImageFirst: true,
      allowLocalImageFallback: true,
      specVersion: installed.version,
      uuid,
      requiresEncryption,
    });
    // eslint-disable-next-line no-await-in-loop
    await appNetworkLinker.connectComponentToLinkedApps(component.identifier, deployment, component.qualifiedNetworkAliases);
  }
  if (requiresEncryption) {
    await fluxShutdowndClient.upsertAppPlanBestEffort(shutdownPlan.buildShutdownPlan(installed.record, deployment))
      .catch((error) => log.warn(`appIdentityMove - shutdown plan for ${name} not delivered: ${error.message}`));
  }
}

/**
 * Moves one planned row and everything it names onto the identity. Throws on
 * a step that still fails after its attempts; the row then keeps its move
 * record and its lease for the retry.
 *
 * @param {object} plan - from planRow
 * @returns {Promise<{deferred: string|null}>} what was left to the reconciler
 */
async function executePlan(plan) {
  const {
    name, replica, registration, from, to, former, next,
  } = plan;
  await appIdentityMoveStore.begin(name, replica, to);
  // The image of each volume under the identity, as the move left it.
  const volumes = new Map();

  // eslint-disable-next-line no-restricted-syntax
  for (const [componentName, formerComp] of former.componentEntries()) {
    const comp = next.getComponent(componentName);
    // eslint-disable-next-line no-await-in-loop
    await attempt(`stop ${formerComp.identifier}`, () => stopFormerContainer(plan, formerComp));
    // eslint-disable-next-line no-await-in-loop
    await attempt(`remove ${formerComp.identifier}`, () => removeFormerContainer(formerComp));
    // eslint-disable-next-line no-await-in-loop
    await appsRuntimeState.rekey(formerComp.identifier, comp.identifier);
    if (!formerComp.isStateless) {
      // eslint-disable-next-line no-await-in-loop
      volumes.set(comp.identifier, await attempt(`move the volume of ${formerComp.identifier}`, () => moveVolume(formerComp, comp)));
    }
    // eslint-disable-next-line no-await-in-loop
    if (comp.hasSyncthing()) await repointFolder(comp);
  }

  await attempt(`network of ${name}`, () => appDockerNetwork.ensureAppDockerNetwork(name, { networkName: next.networkName }));
  // The record names the identity, the ledger holds what the move left on the
  // host under it, and the move's own record ends with them.
  const { InstalledLedger } = specLibrary.loaded();
  await putRecord(plan.installed, { identity: to });
  await appRecords.ledgers().put(new InstalledLedger({
    name, replica, ...(await installedLedger.observeLedger(next, async (identifier) => volumes.get(identifier) ?? null)),
  }));
  await appIdentityMoveStore.end(name, replica);

  // Mounted now that the ledger names each image, through the one path every
  // mount takes. A volume that will not mount is left for the reconciler,
  // which mounts every volume before it starts an app and reports one that
  // will not.
  let deferred = null;
  // eslint-disable-next-line no-restricted-syntax
  for (const [identifier, image] of volumes) {
    if (!image) {
      deferred = `${identifier}: no image found under the former names`;
      break;
    }
    // eslint-disable-next-line no-await-in-loop
    const mounted = await volumeService.ensureAppVolumeMounted(identifier);
    if (!mounted.mounted) {
      deferred = `${identifier}: ${mounted.reason}`;
      break;
    }
  }
  if (deferred) {
    log.warn(`appIdentityMove - ${name} is on its identity; the reconciler mounts and creates its containers (${deferred})`);
  } else {
    await attempt(`recreate ${name}`, () => recreate(name, replica, registration.uuid));
  }
  await dockerService.removeFluxAppDockerNetwork(from)
    .catch((error) => log.warn(`appIdentityMove - ${former.networkName} stays until it is empty: ${error.message}`));
  fluxEventBus.publish('app:movedOntoIdentity', {
    name, replica, from, to, deferred: Boolean(deferred),
  });
  return { deferred };
}

function resetForTests() {
  held.clear();
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

function scheduleRetry() {
  if (retryTimer || held.size === 0) return;
  retryTimer = setTimeout(() => {
    retryHeldApps().catch((error) => log.error(`appIdentityMove - retry failed: ${error.message}`));
  }, RETRY_MS);
  if (retryTimer.unref) retryTimer.unref();
}

/**
 * Records a finished plan's outcome, releases its lease and drops it from the
 * held set.
 */
function settle(plan, results, outcome) {
  const entry = { name: plan.name, replica: plan.replica, to: plan.to };
  if (outcome.deferred) {
    log.warn(`appIdentityMove - ${plan.name} moved onto ${plan.to}, containers left to the reconciler`);
    results.deferred.push({ ...entry, reason: outcome.deferred });
  } else {
    log.info(`appIdentityMove - ${plan.name} moved from ${plan.from} onto ${plan.to}`);
    results.moved.push(entry);
  }
  operationRegistry.release(plan.name, plan.token);
  held.delete(rowKey(plan.name, plan.replica));
}

function hold(plan, results, error) {
  log.error(`appIdentityMove - ${plan.name} could not be finished, held for retry: ${error.message}`);
  held.set(rowKey(plan.name, plan.replica), plan);
  results.held.push({ name: plan.name, replica: plan.replica, error: error.message });
}

/**
 * Tries again every app the last run left held, each planned afresh from its
 * row. Arms the next retry while any remains.
 *
 * @returns {Promise<{moved: object[], deferred: object[], held: object[]}>}
 */
async function retryHeldApps() {
  retryTimer = null;
  const results = { moved: [], deferred: [], held: [] };
  if (held.size === 0) return results;
  const spec = await getSpec();
  // eslint-disable-next-line no-restricted-syntax
  for (const [key, stale] of [...held]) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const plan = await planRow({ name: stale.name, replica: stale.replica }, spec);
      if (plan.done) {
        operationRegistry.release(stale.name, stale.token);
        held.delete(key);
        results.moved.push({ name: stale.name, replica: stale.replica, to: stale.to });
      } else if (plan.skipped) {
        throw new Error(plan.skipped);
      } else {
        // eslint-disable-next-line no-await-in-loop
        settle(plan, results, await executePlan(plan));
      }
    } catch (error) {
      hold(stale, results, error);
    }
  }
  scheduleRetry();
  return results;
}

/**
 * Moves every installed app whose identity is not its registration's onto it:
 * every former container stopped at once, then one app at a time. An app that
 * cannot be finished is held, lease kept, and tried again on a timer.
 *
 * @returns {Promise<{moved: object[], deferred: object[], skipped: object[], held: object[]}>}
 */
async function moveInstalledAppsOntoIdentity() {
  const results = {
    moved: [], deferred: [], skipped: [], held: [],
  };
  held.clear();
  const spec = await getSpec();
  const rows = await appRecords.installed().all();
  const due = rows.filter((row) => !spec.isAppIdentity(row.identity));
  if (due.length === 0) {
    log.info(`appIdentityMove - every installed app (${rows.length}) is on its identity`);
    return results;
  }
  log.info(`appIdentityMove - ${due.length} of ${rows.length} installed row(s) still named by their name`);
  const startedAt = Date.now();

  const plans = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const row of due) {
    // eslint-disable-next-line no-await-in-loop
    const plan = await planRow(row, spec);
    if (plan.skipped) {
      log.warn(`appIdentityMove - ${row.name} not moved: ${plan.skipped}`);
      results.skipped.push({ name: row.name, replica: row.replica, reason: plan.skipped });
    } else if (!plan.done) {
      plans.push(plan);
    }
  }

  // Every former container at once: the node pays docker's grace once.
  await Promise.all(plans.flatMap((plan) => plan.former.componentEntries().map(([, formerComp]) => (
    stopFormerContainer(plan, formerComp)
      .catch((error) => log.warn(`appIdentityMove - stop ${formerComp.identifier}: ${error.message}; tried again with its move`))
  ))));

  // eslint-disable-next-line no-restricted-syntax
  for (const plan of plans) {
    try {
      // eslint-disable-next-line no-await-in-loop
      settle(plan, results, await executePlan(plan));
    } catch (error) {
      hold(plan, results, error);
    }
  }
  scheduleRetry();
  log.info(`appIdentityMove - moved ${results.moved.length}, deferred ${results.deferred.length}, skipped ${results.skipped.length}, held ${results.held.length} in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  return results;
}

module.exports = {
  moveInstalledAppsOntoIdentity,
  retryHeldApps,
  // exposed for tests
  registrationOf,
  formerContainerNames,
  heldRows: () => [...held.keys()],
  resetForTests,
};
