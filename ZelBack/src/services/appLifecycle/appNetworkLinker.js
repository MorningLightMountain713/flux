'use strict';

/**
 * App Network Linker — the docker-network attach plumbing for app-to-app
 * linking. An app declares a network-bearing dependency edge
 * (`dependencies.<target>.network: true`; v8 apps carry the legacy
 * description DSL, normalized by the spec classes); each of its component
 * containers is then attached to the private docker network of every linked
 * app (`fluxDockerNetwork_<linked>`), so it can reach that app's components
 * by their docker DNS name `flux<component>_<linkedApp>` — exactly as if
 * both apps were a single app.
 *
 * Declaration is one-directional (B declares an edge to A; A declares
 * nothing) but reachability is mutual. This is node-local behaviour;
 * cross-node connectivity is `network.mesh`, a separate field.
 *
 * Only the attach/detach/convergence mechanics live here. The relationship
 * graph itself — install gates, follower pull-in, ref-count reap, onRemove
 * cascade — is relationshipResolver.js, which this module never imports
 * from a graph decision: it consumes the `linkedAppNames()` projection the
 * spec classes derive from the same edges.
 */

const appsRepository = require('../appDatabase/appsRepository');
const dockerService = require('../dockerService');
const { withHostMutationLock } = require('../utils/hostMutationLock');
const { buildViewsByName } = require('./relationshipResolver');
const { NodeCondition } = require('./nodeConditions');
const log = require('../../lib/log');

/**
 * The network-bearing link names an app declares, read off its resolved
 * view. An unreadable view contributes none.
 *
 * @param {Map<string, object|null>} viewsByName
 * @param {string} nameLower
 * @returns {string[]}
 */
function linkedNamesOf(viewsByName, nameLower) {
  const view = viewsByName.get(nameLower);
  return view ? view.linkedAppNames() : [];
}

/**
 * Attaches a freshly created component container to the private docker network
 * of every app the parent app is linked to, so it can reach the linked apps'
 * components. Throws on a real connection failure so the install is rolled back.
 *
 * Takes the DeploymentSpec rather than the InstantiatedSpec: `linkedApps` rides
 * the resolved view precisely so this attach works for an encrypted app, whose
 * sealed accessor reports no links at all. Both call sites already hold one.
 *
 * @param {string} componentContainerName - docker container name (flux<component>_<app>)
 * @param {object} deployment - DeploymentSpec of the parent app
 * @returns {Promise<void>}
 */
async function connectComponentToLinkedApps(componentContainerName, deployment, aliases = []) {
  const linkedApps = deployment ? deployment.linkedApps : [];
  if (!linkedApps || !linkedApps.length) {
    return;
  }

  // eslint-disable-next-line no-restricted-syntax
  for (const linkedApp of linkedApps) {
    // The target's network is named from ITS identity: read it off the target's row
    // rather than spelling it from the name this consumer happens to hold.
    // eslint-disable-next-line no-await-in-loop
    const target = await appsRepository.getInstalledApp(linkedApp);
    const networkName = `fluxDockerNetwork_${target?.identity ?? linkedApp}`;
    try {
      // The linked app's network is a CROSS-APP host resource: its removal runs in
      // the linked app's teardown worker under the node-wide hostMutationLock. Take
      // the same lock per attach so this connect either lands before that network is
      // torn down or fails cleanly (rolling back this install) - never racing a
      // half-removed network. Per-call (leaf) granularity, matching the install
      // port-open loop; the connect is a single bounded docker call.
      // eslint-disable-next-line no-await-in-loop
      await withHostMutationLock(
        () => dockerService.appDockerNetworkConnect(componentContainerName, networkName, aliases),
      );
      log.info(`Connected ${componentContainerName} to linked app network ${networkName}`);
    } catch (error) {
      // A dependency can vanish between the pre-install readiness check and this
      // attach (reaped, or its own expiry/cancel completed mid-install). If the
      // network is simply gone, that is a transient ordering condition - tag it so
      // the installer DEFERS and retries rather than hard-failing the consumer into
      // the 7-day error cache. A connect that failed for any other reason (the
      // network is present) is a real failure and propagates unchanged.
      // eslint-disable-next-line no-await-in-loop
      if (!(await dockerService.fluxDockerNetworkExists(networkName))) {
        const notReady = new Error(`Linked app network ${networkName} for '${deployment.appName}' disappeared during install; deferring`);
        notReady.code = NodeCondition.NETWORK_DEPENDENCY_NOT_READY;
        throw notReady;
      }
      throw error;
    }
  }
}

/**
 * The docker networks a consumer should currently be attached to for its declared
 * links: each linked name resolved to a currently-installed app owned by the SAME
 * owner. A link whose target is gone (expired, never installed) or has changed
 * hands (the name re-registered by a different owner after the original expired)
 * is dropped — convergence then treats its network as stale and disconnects,
 * rather than maintaining a dangling or cross-tenant bridge. This carries the
 * same-owner invariant that install enforces once (checkAppDependencyRequirements)
 * onto the post-install attach surfaces, where the trust decision is acted on
 * every pass. Uses the installed app's REGISTERED casing for the network name —
 * the name docker actually created — not the declared casing.
 *
 * @param {string} ownerId - the linking (consumer) app's owner
 * @param {string[]} linkedNames - declared linked app names
 * @returns {Promise<string[]>} fluxDockerNetwork_<name> for each valid link
 */
async function resolveActiveLinkedNetworks(ownerId, linkedNames) {
  if (!Array.isArray(linkedNames) || !linkedNames.length) {
    return [];
  }
  const networks = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const name of linkedNames) {
    // eslint-disable-next-line no-await-in-loop
    const installed = await appsRepository.getInstalledApp(name);
    if (installed && installed.owner === ownerId) {
      // The target's network is named from ITS identity, read off its own row - the
      // consumer cannot derive it, and must not assume the name spelling.
      networks.push(`fluxDockerNetwork_${installed.identity ?? installed.name}`);
    }
  }
  return networks;
}

/**
 * TRANSITIONAL — remove once no pre-label fluxDockerNetwork_* networks remain in
 * the fleet. Whether a network is eligible for the reconciler to DISCONNECT a
 * container from. The forward-looking signal is the runonflux.app-network
 * ownership label; but docker cannot retro-stamp that label onto networks an
 * older FluxOS created, and only FluxOS ever creates the fluxDockerNetwork_
 * prefix, so we also accept that prefix for the reversible disconnect decision
 * (the connect/ownership decision is owner-validated upstream, never by name). To
 * retire: delete the prefix branch and revert callers to isFluxAppNetwork.
 *
 * @param {string} networkName
 * @returns {Promise<boolean>}
 */
async function isDisconnectEligibleFluxNetwork(networkName) {
  if (await dockerService.isFluxAppNetwork(networkName)) return true; // permanent signal
  return networkName.startsWith('fluxDockerNetwork_'); // transitional fallback
}

/**
 * Converges a container's docker-network memberships on the given desired set:
 * connects missing networks and disconnects stale flux app networks (a
 * membership no longer desired, e.g. an update dropped a network-bearing edge,
 * or a link resolved as gone/changed-hands). Networks docker or a user created
 * are never touched, and nothing outside the desired/actual diff is. Best-effort
 * per network: each change is a leaf docker call under the node-wide host
 * mutation lock (a linked network's removal runs in its app's teardown under the
 * same lock), failures are collected for the caller to pace a retry.
 *
 * @param {string} componentIdentifier - bare component identifier
 * @param {string[]} desiredNetworks - full desired membership (own + linked)
 * @param {string[]} actualNetworks - current memberships from docker inspect
 * @returns {Promise<{connected: string[], disconnected: string[], failed: string[]}>}
 */
async function ensureContainerNetworkMembership(componentIdentifier, desiredNetworks, actualNetworks) {
  const desired = new Set(desiredNetworks);
  const actual = new Set(actualNetworks);
  const connected = [];
  const disconnected = [];
  const failed = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const networkName of desired) {
    if (actual.has(networkName)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      await withHostMutationLock(() => dockerService.appDockerNetworkConnect(componentIdentifier, networkName));
      connected.push(networkName);
      log.info(`Connected ${componentIdentifier} to ${networkName}`);
    } catch (error) {
      failed.push(networkName);
      log.error(`ensureContainerNetworkMembership: failed to connect ${componentIdentifier} to ${networkName}: ${error.message}`);
    }
  }
  // eslint-disable-next-line no-restricted-syntax
  for (const networkName of actual) {
    if (desired.has(networkName)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      if (!(await isDisconnectEligibleFluxNetwork(networkName))) {
        // eslint-disable-next-line no-continue
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await withHostMutationLock(() => dockerService.appDockerNetworkDisconnect(componentIdentifier, networkName));
      disconnected.push(networkName);
      log.info(`Disconnected ${componentIdentifier} from stale ${networkName}`);
    } catch (error) {
      failed.push(networkName);
      log.error(`ensureContainerNetworkMembership: failed to disconnect ${componentIdentifier} from ${networkName}: ${error.message}`);
    }
  }
  return { connected, disconnected, failed };
}

/**
 * After an app's private network is (re)created, reconnects every locally
 * installed SAME-OWNER app that is networked with it back onto that network.
 * Best-effort — never throws, so a redeploy is not aborted by a reconnect
 * failure.
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
  // The owner of the just-(re)created app. Only same-owner consumers may attach:
  // if this name changed hands (re-registered by a different owner after the
  // original expired), a foreign consumer's declared link must NOT bridge it in.
  const depApp = (installedApps || []).find((a) => a && a.name === appName);
  const depOwner = depApp ? depApp.owner : null;

  // Resolved views, not the sealed accessor: an encrypted consumer declares its
  // edges inside the ciphertext and would otherwise never be reattached.
  const { viewsByName } = await buildViewsByName(installedApps || []);

  // eslint-disable-next-line no-restricted-syntax
  for (const app of installedApps || []) {
    if (!app || app.name === appName) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const linkedApps = linkedNamesOf(viewsByName, app.name.toLowerCase());
    if (!linkedApps.some((linked) => linked.toLowerCase() === lowerAppName)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    if (!depOwner || app.owner !== depOwner) {
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

  // Resolved views, not the sealed accessor: an encrypted app declares its edges
  // inside the ciphertext, so the boot sweep would otherwise never bridge it.
  const { viewsByName } = await buildViewsByName(installedApps || []);

  // eslint-disable-next-line no-restricted-syntax
  for (const app of installedApps || []) {
    // Only attach to links that resolve to a currently-installed same-owner app —
    // a departed or changed-hands link is not (re)bridged at boot.
    // eslint-disable-next-line no-await-in-loop
    const desiredNetworks = await resolveActiveLinkedNetworks(
      app.owner, linkedNamesOf(viewsByName, app.name.toLowerCase()),
    );
    if (!desiredNetworks.length) {
      // eslint-disable-next-line no-continue
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const containerNames = await dockerService.getAppContainerNames(app.name);
      // eslint-disable-next-line no-restricted-syntax
      for (const networkName of desiredNetworks) {
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

module.exports = {
  connectComponentToLinkedApps,
  resolveActiveLinkedNetworks,
  isDisconnectEligibleFluxNetwork,
  ensureContainerNetworkMembership,
  reconnectLinkedApps,
  reconcileAllAppNetworkLinks,
};
