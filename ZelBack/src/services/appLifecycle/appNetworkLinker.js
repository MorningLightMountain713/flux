/**
 * App Network Linker
 *
 * Implements opt-in app-to-app network linking. An app owner links the app to
 * other apps via the typed `network.shareWith` spec field (a list of app
 * names). When set, before the app is installed or redeployed the node verifies
 * every named app is installed locally and owned by the same owner; otherwise
 * the install fails. Each of the app's component containers is then attached to
 * the private docker network of every linked app (`fluxDockerNetwork_<linked>`),
 * so it can reach that app's components by their docker DNS name
 * `flux<component>_<linkedApp>` — exactly as if both apps were a single app.
 *
 * Declaration is one-directional (B lists A in shareWith; A declares nothing)
 * but reachability is mutual. This is node-local behaviour; cross-node linking
 * is `network.mesh`, a separate field.
 */

const appsRepository = require('../appDatabase/appsRepository');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const dockerService = require('../dockerService');
const log = require('../../lib/log');

/**
 * Returns the linked app names declared by an app via `network.shareWith`,
 * excluding any self reference and duplicates. Empty for legacy (v1-v8) and
 * encrypted specs (no readable shareWith on this node).
 *
 * @param {object} instantiated - InstantiatedSpec instance
 * @returns {string[]} linked app names
 */
function getLinkedApps(instantiated) {
  if (!instantiated || instantiated.isEncrypted) {
    return [];
  }
  const { spec } = instantiated;
  const shareWith = spec && spec.network && Array.isArray(spec.network.shareWith)
    ? spec.network.shareWith
    : [];
  if (!shareWith.length) {
    return [];
  }
  const selfName = String(instantiated.name || '').toLowerCase();
  const names = [];
  const seen = new Set();
  for (const raw of shareWith) {
    if (typeof raw !== 'string') {
      // eslint-disable-next-line no-continue
      continue;
    }
    const key = raw.toLowerCase();
    if (key && key !== selfName && !seen.has(key)) {
      seen.add(key);
      names.push(raw);
    }
  }
  return names;
}

/**
 * Verifies every app this app is linked to is installed locally and owned by
 * the same owner. Throws otherwise, aborting the install/redeploy.
 *
 * @param {object} instantiated - InstantiatedSpec instance of the parent app
 * @returns {Promise<boolean>} true when all network links are satisfied
 */
async function checkAppNetworkRequirements(instantiated) {
  const linkedApps = getLinkedApps(instantiated);
  if (!linkedApps.length) {
    return true;
  }

  // eslint-disable-next-line no-restricted-syntax
  for (const linkedApp of linkedApps) {
    // eslint-disable-next-line no-await-in-loop
    const installed = await appsRepository.getInstalledApp(linkedApp);
    if (!installed) {
      // Transient ordering condition, not a misconfiguration: the dependency may
      // simply not be installed yet. Tagged so callers can defer and retry
      // instead of treating it as a hard install failure.
      const error = new Error(`App '${linkedApp}' that '${instantiated.name}' must be networked with is not installed on this node. Installation aborted.`);
      error.code = 'NETWORK_DEPENDENCY_NOT_READY';
      throw error;
    }
    if (installed.owner !== instantiated.owner) {
      throw new Error(`App '${linkedApp}' that '${instantiated.name}' must be networked with is owned by a different owner. Installation aborted.`);
    }
  }
  log.info(`App network links satisfied for ${instantiated.name}: ${linkedApps.join(', ')}`);
  return true;
}

/**
 * Attaches a freshly created component container to the private docker network
 * of every app the parent app is linked to, so it can reach the linked apps'
 * components. Throws on a real connection failure so the install is rolled back.
 *
 * @param {string} componentContainerName - docker container name (flux<component>_<app>)
 * @param {object} instantiated - InstantiatedSpec instance of the parent app
 * @returns {Promise<void>}
 */
async function connectComponentToLinkedApps(componentContainerName, instantiated) {
  const linkedApps = getLinkedApps(instantiated);
  if (!linkedApps.length) {
    return;
  }

  // eslint-disable-next-line no-restricted-syntax
  for (const linkedApp of linkedApps) {
    const networkName = `fluxDockerNetwork_${linkedApp}`;
    // eslint-disable-next-line no-await-in-loop
    await dockerService.appDockerNetworkConnect(componentContainerName, networkName);
    log.info(`Connected ${componentContainerName} to linked app network ${networkName}`);
  }
}

/**
 * After an app's private network is (re)created, reconnects every locally
 * installed app that is networked with it back onto that network. Best-effort —
 * never throws, so a redeploy is not aborted by a reconnect hiccup.
 *
 * @param {string} appName - the app whose network was (re)created
 * @returns {Promise<void>}
 */
async function reconnectLinkedApps(appName) {
  let installedApps;
  try {
    installedApps = await appsRepository.listInstalledApps();
  } catch (error) {
    log.error(`reconnectLinkedApps: failed to read installed apps for ${appName}: ${error.message}`);
    return;
  }

  const networkName = `fluxDockerNetwork_${appName}`;
  const lowerAppName = appName.toLowerCase();

  // eslint-disable-next-line no-restricted-syntax
  for (const app of installedApps || []) {
    if (!app || app.name === appName) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const linkedApps = getLinkedApps(app);
    if (!linkedApps.some((linked) => linked.toLowerCase() === lowerAppName)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const containerNames = await dockerService.getAppContainerNames(app.name);
      // eslint-disable-next-line no-restricted-syntax
      for (const containerName of containerNames) {
        // eslint-disable-next-line no-await-in-loop
        await dockerService.appDockerNetworkConnect(containerName, networkName);
        log.info(`Reconnected linked app ${containerName} to ${networkName}`);
      }
    } catch (error) {
      log.error(`reconnectLinkedApps: failed to reconnect ${app.name} to ${networkName}: ${error.message}`);
    }
  }
}

/**
 * Boot-time sweep: ensures every installed app that declares network links is
 * attached to each linked app's network. Idempotent and best-effort.
 *
 * @returns {Promise<void>}
 */
async function reconcileAllAppNetworkLinks() {
  let installedApps;
  try {
    installedApps = await appsRepository.listInstalledApps();
  } catch (error) {
    log.error(`reconcileAllAppNetworkLinks: failed to read installed apps: ${error.message}`);
    return;
  }

  // eslint-disable-next-line no-restricted-syntax
  for (const app of installedApps || []) {
    const linkedApps = getLinkedApps(app);
    if (!linkedApps.length) {
      // eslint-disable-next-line no-continue
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const containerNames = await dockerService.getAppContainerNames(app.name);
      // eslint-disable-next-line no-restricted-syntax
      for (const linkedApp of linkedApps) {
        const networkName = `fluxDockerNetwork_${linkedApp}`;
        // eslint-disable-next-line no-restricted-syntax
        for (const containerName of containerNames) {
          // eslint-disable-next-line no-await-in-loop
          await dockerService.appDockerNetworkConnect(containerName, networkName).catch((error) => {
            log.error(`reconcileAllAppNetworkLinks: failed to connect ${containerName} to ${networkName}: ${error.message}`);
          });
        }
      }
    } catch (error) {
      log.error(`reconcileAllAppNetworkLinks: failed for ${app.name}: ${error.message}`);
    }
  }
}

/**
 * For a SEND component being installed in an app whose own components do NOT
 * contain a LOG=COLLECT component, looks at every app this app is linked to and
 * returns the first linked app that owns a COLLECT component. The actual
 * container name resolution happens in the caller.
 *
 * Encrypted linked apps whose deployment cannot be built on this node are
 * skipped — the SEND container falls back to json-file logging.
 *
 * @param {object} instantiated - InstantiatedSpec instance of the app being installed
 * @returns {Promise<{linkedAppName: string, collectorComponentName: string}|null>}
 */
async function findLinkedAppLogCollector(instantiated) {
  const linkedApps = getLinkedApps(instantiated);
  if (!linkedApps.length) {
    return null;
  }

  // eslint-disable-next-line no-restricted-syntax
  for (const linkedAppName of linkedApps) {
    let deployment;
    try {
      // eslint-disable-next-line no-await-in-loop
      deployment = await deploymentProvider.getInstalledDeployment(linkedAppName);
    } catch (error) {
      log.warn(`findLinkedAppLogCollector: failed to build deployment for ${linkedAppName}: ${error.message}`);
      // eslint-disable-next-line no-continue
      continue;
    }
    if (!deployment) {
      // No deployment to scan — typical for encrypted apps on non-Arcane nodes.
      // eslint-disable-next-line no-continue
      continue;
    }
    const collector = deployment.componentEntries().find(([, component]) => component
      .toDockerEnv().some((env) => typeof env === 'string' && env.startsWith('LOG=COLLECT')));
    if (collector) {
      return { linkedAppName, collectorComponentName: collector[0] };
    }
  }
  return null;
}

module.exports = {
  getLinkedApps,
  checkAppNetworkRequirements,
  connectComponentToLinkedApps,
  reconnectLinkedApps,
  reconcileAllAppNetworkLinks,
  findLinkedAppLogCollector,
};
