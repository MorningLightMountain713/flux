'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

const log = require('../../lib/log');
const appRecords = require('../appDatabase/appRecords');
const appIdentityMoveStore = require('./appIdentityMoveStore');
const appHistory = require('../appDecisions/appHistory');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const dockerService = require('../dockerService');
const appsRuntimeState = require('../appManagement/appsRuntimeState');
const volumeService = require('../utils/volumeService');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const upnpService = require('../upnpService');
const specLibrary = require('../utils/specLibrary');
const { appsFolder } = require('../utils/appConstants');
const { nodeChain } = require('../utils/nodeChain');

/**
 * The resources of an installed instance as the host holds it now, read for an
 * instance whose resources the node did not write as it provisioned. Every entry
 * is what the host can tell: the names the deployment states, the volume image
 * the caller's reader answers, the digest and the mesh name the daemon holds,
 * the folder the deployment names; null where the host holds nothing. Each
 * port is recorded as opened by the node's current firewall and UPnP state.
 */

// The disk a volume image was placed on: the root disk when the image sits in
// the node's own appvolumes directory, otherwise the mount holding it.
function diskOf(file) {
  return path.basename(path.dirname(file)) === 'appvolumes' ? '/' : path.dirname(file);
}

async function exists(file) {
  return fs.access(file).then(() => true, () => false);
}

/**
 * The image of a component's volume that the resources do not yet name, found
 * as a release before instance resources found it: the file the kernel mounts at one
 * of the component's directories, else the record given with the stamp it
 * holds, else the file found by the component's identifier on the disks, then
 * by its 8.x name. The stamp is the record's when it names the file found,
 * else read from the image. Null when none is there.
 *
 * @param {string} identifier
 * @param {{path: string, fsUuid: string|null}|null} recorded - the record a
 *   release before the resources kept for the component, or the resources' own
 * @param {string[]} [dirs] - the directories the volume may be mounted at
 * @returns {Promise<{path: string, fsUuid: string|null}|null>}
 */
async function discoverVolumeImage(identifier, recorded, dirs = [path.join(appsFolder, identifier), path.join(appsFolder, `flux${identifier}`)]) {
  const stampOf = async (file) => (recorded?.path === file && recorded.fsUuid) || (await volumeService.imageFsUuid(file)) || null;
  // eslint-disable-next-line no-restricted-syntax
  for (const dir of dirs) {
    // eslint-disable-next-line no-await-in-loop
    if (await volumeService.isPathMounted(dir)) {
      // eslint-disable-next-line no-await-in-loop
      const backing = await volumeService.mountedImagePath(dir);
      // eslint-disable-next-line no-await-in-loop
      if (backing) return { path: backing, fsUuid: await stampOf(backing) };
    }
  }
  if (recorded && await exists(recorded.path)) return { path: recorded.path, fsUuid: await stampOf(recorded.path) };
  // eslint-disable-next-line no-restricted-syntax
  for (const named of [identifier, `flux${identifier}`]) {
    // eslint-disable-next-line no-await-in-loop
    const found = await volumeService.getVolumeFilePath(named);
    // eslint-disable-next-line no-await-in-loop
    if (found.path) return { path: found.path, fsUuid: await stampOf(found.path) };
  }
  return null;
}

async function meshNameOf(identifier) {
  const inspected = await dockerService.dockerContainerInspect(identifier).catch(() => null);
  const env = inspected?.Config?.Env ?? [];
  const self = env.find((entry) => entry.startsWith('FLUX_MESH_SELF='));
  return self ? { name: self.slice('FLUX_MESH_SELF='.length) } : null;
}

/**
 * @param {object} deployment - the instance's DeploymentSpec
 * @param {(identifier: string) => Promise<{path: string, fsUuid: string|null}|null>} volumeOf
 *   the volume image recorded for a component's identifier, or null
 * @returns {Promise<{network: {name: string}, components: object}>} the resources' body
 */
async function observeResources(deployment, volumeOf) {
  const { hostTlsDir } = specLibrary.loaded();
  const opened = [
    ...(await fluxNetworkHelper.isFirewallActive() ? ['ufw'] : []),
    ...(upnpService.isUPNP() ? ['upnp'] : []),
  ];
  const components = {};
  // eslint-disable-next-line no-restricted-syntax
  for (const [, component] of deployment.componentEntries()) {
    const compDir = path.join(appsFolder, component.identifier);
    // eslint-disable-next-line no-await-in-loop
    const recorded = component.isStateless ? null : await volumeOf(component.identifier);
    components[component.componentKey] = {
      identifier: component.identifier,
      // eslint-disable-next-line no-await-in-loop
      image: { reference: component.image, digest: await dockerService.appDockerImageDigest(component.image) },
      hostPorts: (component.hostPorts ?? []).map((port) => ({ port, opened: [...opened] })),
      volume: component.isStateless ? null : {
        file: recorded?.path ?? null,
        disk: recorded?.path ? diskOf(recorded.path) : null,
        fsUuid: recorded?.fsUuid ?? null,
        mountDir: compDir,
      },
      mountSources: (component.mounts ?? []).map((mount) => ({ path: mount.Source, kind: mount.sourceType === 'file' ? 'file' : 'dir' })),
      syncFolder: component.hasSyncthing() ? { id: component.syncFolderId, path: compDir } : null,
      aliases: [...(component.networkAliases ?? [])],
      // eslint-disable-next-line no-await-in-loop
      mesh: await meshNameOf(component.identifier),
      tls: component.requiresBackendTls() ? { dir: hostTlsDir(compDir) } : null,
    };
  }
  return { network: { name: deployment.networkName }, components };
}

/**
 * Writes the resources of every installed instance that has none, from what the
 * host holds for it: the volume image found once, from the record the
 * component's runtime-state document kept, the kernel, or the disks. The move
 * onto the identity an instance's record carries goes to the move's own
 * collection, and an instance whose record states no identity is named by its
 * name. An instance that cannot be adopted is left as it is and logged.
 * @returns {Promise<{adopted: Array<{name: string, replica: string|null}>, skipped: Array<{name: string, replica: string|null, reason: string}>}>}
 */
async function adoptInstanceResources() {
  const { HostedInstance, InstanceResources, RegisteredSpec } = specLibrary.loaded();
  const installed = appRecords.hostedInstances();
  const instanceResources = appRecords.instanceResources();
  const moves = new Map((await installed.legacyMoves()).map(({ record, move }) => [appRecords.instanceKey(record), move]));
  const withResources = new Set((await instanceResources.keys()).map(appRecords.instanceKey));
  const pending = (await installed.all()).filter((record) => !withResources.has(appRecords.instanceKey(record)));
  const results = { adopted: [], skipped: [] };
  // eslint-disable-next-line no-restricted-syntax
  for (const record of pending) {
    const key = { name: record.name, replica: record.replica };
    try {
      const move = moves.get(appRecords.instanceKey(record)) ?? null;
      let registered = record.record;
      if (registered.identity === null) {
        registered = RegisteredSpec.deserialize({ ...registered.serialize(), identity: registered.name }, { chain: nodeChain() });
      }
      // eslint-disable-next-line no-await-in-loop
      if (move) await appIdentityMoveStore.begin(record.name, record.replica, move.to, move.since);
      let install = record;
      if (move || registered !== record.record) {
        install = new HostedInstance({
          record: registered, replica: record.replica, owed: record.owed, componentKeys: record.componentKeys, formerNames: record.formerNames,
        });
        // eslint-disable-next-line no-await-in-loop
        await installed.put(install);
      }
      // eslint-disable-next-line no-await-in-loop
      const registrationVersion = await appHistory.registrationVersionOf(record.name, registered.uuid) ?? undefined;
      // eslint-disable-next-line no-await-in-loop
      const deployment = await deploymentProvider.buildDeployment(install, { replica: record.replica, registrationVersion });
      // eslint-disable-next-line no-await-in-loop
      const body = await observeResources(deployment, async (identifier) => discoverVolumeImage(identifier, await appsRuntimeState.getVolumeImage(identifier)));
      // eslint-disable-next-line no-await-in-loop
      await instanceResources.put(new InstanceResources({ name: record.name, replica: record.replica, ...body }));
      results.adopted.push(key);
    } catch (error) {
      log.warn(`instanceResourceObserver - ${record.name}${record.replica ? ` (${record.replica})` : ''} not adopted: ${error.message}`);
      results.skipped.push({ ...key, reason: error.message });
    }
  }
  if (pending.length) log.info(`instanceResourceObserver - ${results.adopted.length} of ${pending.length} installed instance(s) adopted resources`);
  return results;
}

module.exports = { observeResources, discoverVolumeImage, adoptInstanceResources };
