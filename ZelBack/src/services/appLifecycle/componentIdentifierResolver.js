const appsRepository = require('../appDatabase/appsRepository');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const dockerService = require('../dockerService');
const volumeService = require('../utils/volumeService');

// What a row's components are called, for the startup backfill that records them.
//
// This is the ONLY place that reads components off the disk, and it does so once
// per row rather than on every boot. An enterprise app is stored with `compose`
// deliberately emptied — its components exist only inside the sealed blob — and
// opening that needs the benchmark channel. A consumer deriving them at the
// moment it needs them therefore depends on that channel being up right then;
// recording them instead makes every later boot a lookup.

/**
 * The container identifiers one installed row's components are named by.
 *
 * @param {string} name
 * @param {string|null} replica
 * @returns {Promise<string[]|null>} null when nothing can state them, which the
 *   backfill counts as unresolved and leaves for a later pass — never an empty
 *   list, which would read as "this app has no components".
 */
async function resolveComponentIdentifiers(name, replica) {
  const installed = await appsRepository.getInstalledApp(name);
  if (!installed) return null;

  const deployment = await deploymentProvider
    .buildDeployment(installed, { replica })
    .catch(() => null);
  if (deployment) return deployment.componentEntries().map(([, comp]) => comp.identifier);

  // Only a sealed spec is unreadable for a reason disk can answer. A plain spec
  // that failed to build failed for some other reason, and guessing from
  // filenames would paper over it.
  if (!installed.isEncrypted) return null;

  const diskIds = await volumeService.getComponentAppIdsFromVolumeFiles(name);
  if (diskIds.length === 0) return null;
  // Disk ids carry docker's prefix; a row states the bare component identifier
  // and consumers add the prefix back. Storing the docker form would double it.
  return diskIds.map((id) => dockerService.getBaseAppName(id));
}

module.exports = { resolveComponentIdentifiers };
