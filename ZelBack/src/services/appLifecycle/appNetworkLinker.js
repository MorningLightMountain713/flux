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

const config = require('config');
const appsRepository = require('../appDatabase/appsRepository');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const dockerService = require('../dockerService');
const { withHostMutationLock } = require('../utils/hostMutationLock');
const { socketAddressesMatch } = require('../utils/socketAddressUtils');
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
 * Whether every container belonging to an installed app is currently running.
 * Docker-listing based (the local DB blanks enterprise compose, so iterating the
 * spec would miss components), so it works for enterprise apps too. False when
 * the app has no containers.
 *
 * @param {string} appName
 * @returns {Promise<boolean>}
 */
async function isAppRunning(appName) {
  const containers = await dockerService.getAppContainerObjects(appName);
  if (!containers || !containers.length) {
    return false;
  }
  return containers.every((container) => container && container.State === 'running');
}

/**
 * Verifies every app this app is linked to is installed locally and owned by
 * the same owner; when the node-managed collector lifecycle is enabled, also
 * that each linked app is actually running. Throws otherwise, aborting or
 * deferring the install/redeploy.
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
    // When the node-managed collector lifecycle is on, require the dependency to
    // be actually running - not merely installed - so this app's docker-network
    // attach and log routing land on a live container. Tagged transient so
    // callers defer and retry rather than hard-failing.
    if (config.fluxapps.manageCollectorLifecycle) {
      // eslint-disable-next-line no-await-in-loop
      const running = await isAppRunning(linkedApp);
      if (!running) {
        const error = new Error(`App '${linkedApp}' that '${instantiated.name}' must be networked with is installed but not running yet. Installation deferred.`);
        error.code = 'NETWORK_DEPENDENCY_NOT_READY';
        throw error;
      }
    }
  }
  log.info(`App network links satisfied for ${instantiated.name}: ${linkedApps.join(', ')}`);
  return true;
}

/**
 * Whether an app is a pure follower — `activation.standalone === false`: it has
 * no independent run decision and exists on a node only while a same-owner app
 * there `shareWith`-links to it (the v9 successor to the v8 dependencyOnly
 * marker, e.g. a shared stats collector). Absent/null activation (v1-v8 specs,
 * the v9 default) and encrypted specs (activation unreadable on this node) are
 * standalone.
 *
 * @param {object} instantiated - InstantiatedSpec instance
 * @returns {boolean}
 */
function isPureFollower(instantiated) {
  if (!instantiated || instantiated.isEncrypted) {
    return false;
  }
  const activation = instantiated.spec && instantiated.spec.activation;
  return !!activation && activation.standalone === false;
}

/**
 * Whether an orphaned follower should be reaped: a pure follower that also
 * declares `activation.stopWhenUnneeded`. A follower with stopWhenUnneeded
 * false persists even when orphaned (an explicit spec opt-in); a standalone
 * app is never reaped — it justifies its own presence.
 *
 * @param {object} instantiated - InstantiatedSpec instance
 * @returns {boolean}
 */
function isReapableFollower(instantiated) {
  return isPureFollower(instantiated) && instantiated.spec.activation.stopWhenUnneeded === true;
}

/**
 * Given a set of apps, returns the set of follower-app names that are
 * *required*: the transitive `shareWith` closure starting from the apps that
 * can stand alone (activation.standalone !== false). Links are only followed
 * between apps of the same owner. Original-cased names are returned; matching
 * is case-insensitive.
 *
 * Starting the closure from standalone apps only (not every app in the set) is
 * what lets a pure follower fall out of the required set once nothing links to
 * it — otherwise a collector, being present itself, would keep itself alive.
 *
 * @param {Array<object>} apps - InstantiatedSpec instances to reason over
 * @returns {Set<string>} required follower app names
 */
function computeRequiredDependencyNames(apps) {
  const required = new Set();
  if (!Array.isArray(apps) || !apps.length) {
    return required;
  }
  const byName = new Map();
  apps.forEach((app) => {
    if (app && app.name) byName.set(app.name.toLowerCase(), app);
  });

  const roots = apps.filter((app) => app && app.name && !isPureFollower(app));
  const queue = [...roots];
  const visited = new Set(roots.map((app) => app.name.toLowerCase()));

  while (queue.length) {
    const current = queue.shift();
    // eslint-disable-next-line no-restricted-syntax
    for (const linkedName of getLinkedApps(current)) {
      const dep = byName.get(linkedName.toLowerCase());
      if (dep && dep.owner === current.owner) {
        required.add(dep.name);
        const key = dep.name.toLowerCase();
        if (!visited.has(key)) {
          visited.add(key);
          queue.push(dep);
        }
      }
    }
  }
  return required;
}

/**
 * Whether a workload transitively `shareWith`-depends on `depNameLower`,
 * following same-owner links only. Breadth-first over the link graph.
 *
 * @param {object} workload - root InstantiatedSpec
 * @param {string} depNameLower - lowercased follower name to look for
 * @param {Map<string, object>} byName - lowercased-name -> InstantiatedSpec
 * @returns {boolean}
 */
function appTransitivelyRequires(workload, depNameLower, byName) {
  const visited = new Set([workload.name.toLowerCase()]);
  const queue = [workload];
  while (queue.length) {
    const current = queue.shift();
    // eslint-disable-next-line no-restricted-syntax
    for (const linkedName of getLinkedApps(current)) {
      const key = linkedName.toLowerCase();
      const dep = byName.get(key);
      // Only same-owner links to present apps are real dependencies (mirrors
      // computeRequiredDependencyNames); a cross-owner/dangling link is ignored.
      if (!dep || dep.owner !== workload.owner) {
        // eslint-disable-next-line no-continue
        continue;
      }
      if (key === depNameLower) {
        return true;
      }
      if (!visited.has(key)) {
        visited.add(key);
        queue.push(dep);
      }
    }
  }
  return false;
}

/**
 * Locally-installed workloads (apps that are NOT pure followers) that
 * transitively `shareWith`-require the given follower, same-owner only. The
 * inverse of `computeRequiredDependencyNames`: used to uninstall the consumers
 * before the dependency they rely on is torn down.
 *
 * @param {string} depName - follower app name
 * @returns {Promise<Array<object>>} requiring workload InstantiatedSpecs
 */
async function findInstalledWorkloadsRequiring(depName) {
  const installed = await appsRepository.listInstalledApps();
  if (!installed || !installed.length) {
    return [];
  }
  const byName = new Map();
  installed.forEach((app) => {
    if (app && app.name) byName.set(app.name.toLowerCase(), app);
  });
  const target = depName.toLowerCase();
  return installed.filter((app) => app && app.name && !isPureFollower(app)
    && appTransitivelyRequires(app, target, byName));
}

/**
 * The follower-app names that should be present on this node, computed from
 * every global app whose placement targets this node. Used by the spawner to
 * suppress a pure follower that nothing here requires.
 *
 * @param {object} nodeIdentity - { ip, outpoint, operator } of this node
 * @returns {Promise<Set<string>>}
 */
async function getRequiredDependencyNamesForNode(nodeIdentity) {
  const { ip, outpoint, operator } = nodeIdentity || {};
  if (!ip && !outpoint && !operator) {
    return new Set();
  }
  const globalApps = await appsRepository.listGlobalAppInfo();
  const assigned = (globalApps || []).filter((app) => app && app.placement
    && app.placement.hasTargets()
    && app.placement.matchesTarget({
      ip, outpoint, operator, ipMatcher: socketAddressesMatch,
    }));
  return computeRequiredDependencyNames(assigned);
}

/**
 * Locally-installed reapable followers (activation stopWhenUnneeded) that no
 * installed workload requires any more (transitive `shareWith`). These should
 * be removed. Based on what is actually installed here now, so removing the
 * last workload orphans the collectors it linked to.
 *
 * @returns {Promise<Array<object>>} orphaned follower InstantiatedSpecs
 */
async function findUnrequiredInstalledDependencies() {
  const installed = await appsRepository.listInstalledApps();
  if (!installed || !installed.length) {
    return [];
  }
  const required = computeRequiredDependencyNames(installed);
  return installed.filter((app) => isReapableFollower(app) && !required.has(app.name));
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
    // The linked app's network is a CROSS-APP host resource: its removal runs in
    // the linked app's teardown worker under the node-wide hostMutationLock. Take
    // the same lock per attach so this connect either lands before that network is
    // torn down or fails cleanly (rolling back this install) - never racing a
    // half-removed network. Per-call (leaf) granularity, matching the install
    // port-open loop; the connect is a single bounded docker call.
    // eslint-disable-next-line no-await-in-loop
    await withHostMutationLock(() => dockerService.appDockerNetworkConnect(componentContainerName, networkName));
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
        // Same-lock attach as connectComponentToLinkedApps: never race a
        // concurrent teardown removing this network.
        // eslint-disable-next-line no-await-in-loop
        await withHostMutationLock(() => dockerService.appDockerNetworkConnect(containerName, networkName));
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
          // Same-lock attach as connectComponentToLinkedApps: never race a
          // concurrent teardown removing this network.
          // eslint-disable-next-line no-await-in-loop
          await withHostMutationLock(() => dockerService.appDockerNetworkConnect(containerName, networkName)).catch((error) => {
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
  isAppRunning,
  isPureFollower,
  isReapableFollower,
  checkAppNetworkRequirements,
  computeRequiredDependencyNames,
  findInstalledWorkloadsRequiring,
  getRequiredDependencyNamesForNode,
  findUnrequiredInstalledDependencies,
  connectComponentToLinkedApps,
  reconnectLinkedApps,
  reconcileAllAppNetworkLinks,
  findLinkedAppLogCollector,
};
