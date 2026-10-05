'use strict';

const path = require('node:path');

const log = require('../../lib/log');
const appRecords = require('../appDatabase/appRecords');
const appIdentityMoveStore = require('./appIdentityMoveStore');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const dockerService = require('../dockerService');
const volumeService = require('../utils/volumeService');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const upnpService = require('../upnpService');
const specLibrary = require('../utils/specLibrary');
const { appsFolder } = require('../utils/appConstants');

/**
 * The ledger of an installed instance as the host holds it now, read for an
 * instance installed before the node kept one. Every entry is what the host
 * can tell: the names the deployment states, the volume image the node
 * recorded, the digest and the mesh name the daemon holds, the folder the
 * deployment names; null where the host holds nothing. Each port is recorded
 * as opened by the node's current firewall and UPnP state.
 */

// The disk a volume image was placed on: the root disk when the image sits in
// the node's own appvolumes directory, otherwise the mount holding it.
function diskOf(file) {
  return path.basename(path.dirname(file)) === 'appvolumes' ? '/' : path.dirname(file);
}

async function meshNameOf(identifier) {
  const inspected = await dockerService.dockerContainerInspect(identifier).catch(() => null);
  const env = inspected?.Config?.Env ?? [];
  const self = env.find((entry) => entry.startsWith('FLUX_MESH_SELF='));
  return self ? { name: self.slice('FLUX_MESH_SELF='.length) } : null;
}

/**
 * @param {object} deployment - the instance's DeploymentSpec
 * @returns {Promise<object>} the ledger
 */
async function observeLedger(deployment) {
  const { hostTlsDir } = specLibrary.loaded();
  const opened = [
    ...(await fluxNetworkHelper.isFirewallActive() ? ['ufw'] : []),
    ...(upnpService.isUPNP() ? ['upnp'] : []),
  ];
  const components = {};
  // eslint-disable-next-line no-restricted-syntax
  for (const [name, component] of deployment.componentEntries()) {
    const compDir = path.join(appsFolder, component.identifier);
    // eslint-disable-next-line no-await-in-loop
    const recorded = component.isStateless ? null : await volumeService.recordedVolumeImage(component.identifier);
    components[name] = {
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
 * Writes the ledger of every instance installed before the node kept one, and
 * moves its move-in-progress record, if it carries one, to the move's own
 * collection. An instance whose record states no identity is named by its
 * name. An instance that cannot be adopted is left as it is and logged.
 * @returns {Promise<{adopted: Array<{name: string, replica: string|null}>, skipped: Array<{name: string, replica: string|null, reason: string}>}>}
 */
async function adoptInstalledLedgers() {
  const { InstalledSpec, InstantiatedSpec } = specLibrary.loaded();
  const pending = await appRecords.installed().unadopted();
  const results = { adopted: [], skipped: [] };
  // eslint-disable-next-line no-restricted-syntax
  for (const { record, move } of pending) {
    const key = { name: record.name, replica: record.replica };
    try {
      let registered = record.record;
      if (registered.identity === null) {
        registered = InstantiatedSpec.deserialize({ ...registered.serialize(), identity: registered.name });
      }
      // eslint-disable-next-line no-await-in-loop
      if (move) await appIdentityMoveStore.begin(record.name, record.replica, move.to, move.since);
      // eslint-disable-next-line no-await-in-loop
      const deployment = await deploymentProvider.buildDeployment(registered, { replica: record.replica });
      // eslint-disable-next-line no-await-in-loop
      const ledger = await observeLedger(deployment);
      // eslint-disable-next-line no-await-in-loop
      await appRecords.installed().put(new InstalledSpec({
        record: registered, replica: record.replica, owed: null, ledger,
      }));
      results.adopted.push(key);
    } catch (error) {
      log.warn(`installedLedger - ${record.name}${record.replica ? ` (${record.replica})` : ''} not adopted: ${error.message}`);
      results.skipped.push({ ...key, reason: error.message });
    }
  }
  if (pending.length) log.info(`installedLedger - ${results.adopted.length} of ${pending.length} installed instance(s) adopted the ledger`);
  return results;
}

module.exports = { observeLedger, adoptInstalledLedgers };
