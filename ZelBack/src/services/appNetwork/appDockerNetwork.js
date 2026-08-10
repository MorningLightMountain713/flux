'use strict';

const dockerService = require('../dockerService');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const serviceHelper = require('../serviceHelper');
const log = require('../../lib/log');
const { getSpecBackend } = require('../utils/specLibs');

// Ownership of the per-app docker network (fluxDockerNetwork_<app>) and the
// 172.23.x.0/24 subnet it sits on. Every caller that creates, repairs or reaps
// one comes through here — dockerService performs the docker calls, this decides
// which network an app gets, when it appears and when it may be removed.
//
// The invariant: an app network exists if and only if the app is installed on
// this node. Creation repairs a violation (install, or a reconciler pass about
// to run a container); removal enforces the other direction (uninstall, and the
// janitor sweep as its backstop). Because the janitor only removes networks
// whose owner is NOT installed and the reconciler only creates them for apps
// that ARE, the two can never fight over the same network.

// The per-app network name prefix. The ownership label stamped at creation is
// read from the shared schema at call time (flux-spec loads asynchronously, so
// there is nothing to bind to at require time).
const APP_NETWORK_PREFIX = 'fluxDockerNetwork_';

// The node-wide flux network (no app suffix) — not an app network, never reaped.
const NODE_NETWORK_NAME = 'fluxDockerNetwork';

// Legacy apps that pinned their gateway octet by name before allocation existed.
const appsThatMightBeUsingOldGatewayIpAssignment = ['HNSDoH', 'dane', 'fdm', 'Jetpack2', 'fdmdedicated', 'isokosse', 'ChainBraryDApp', 'health', 'ethercalc'];

// The octets those legacy apps pin by name (charCodeAt of the last character).
// Reserved in the free-octet scan so a non-legacy app cannot take one before the
// legacy app heals onto its fixed octet.
const legacyPinnedOctets = appsThatMightBeUsingOldGatewayIpAssignment.map((name) => name.charCodeAt(name.length - 1));

/**
 * Ensures the per-app docker network exists, creating it with a free /24 if
 * absent. Safe to call on every install and from the reconciler's heal path,
 * where a pruned network (docker prune, daemon restart) must be re-created
 * before any container can be re-created onto it.
 *
 * When the network already exists this returns EARLY - no allocation and,
 * crucially, no firewall work: its interface is already in the node-wide
 * DOCKER-USER rules, so re-running removeDockerContainerAccessToNonRoutable
 * here would flush and rebuild the whole chain on every heal recreate for no
 * gain (briefly dropping RFC1918 protection for every flux container on the
 * node).
 *
 * Allocation is deterministic (lowest free octet) but collision-safe: many heals
 * can run concurrently after a mass prune, so a create that loses its octet to
 * another app - or to a non-flux network whose subnet docker rejects - is
 * retried against the NEXT free octet, giving up only on true exhaustion. A
 * premature give-up would throw, and on the vanished-container path that throw
 * escalates to an app uninstall, so the loop must never fail while octets are
 * free. The subnet is not persisted; nothing outside the container depends on it
 * (ports are host-mapped, gelf targets resolve from the collector's live
 * container IP at create time).
 *
 * @param {string} appName bare app name (the network is per-app, not per-component)
 * @param {{onStatus?: function}} [options] install-status sink; the heal path passes none
 * @returns {Promise<object|string>} the created-or-existing network response
 */
async function ensureAppDockerNetwork(appName, { onStatus = null } = {}) {
  const checkingStatus = { status: `Checking Flux App network of ${appName}...` };
  log.info(checkingStatus.status);
  if (onStatus) onStatus(checkingStatus);

  if (await dockerService.dockerNetworkState(`fluxDockerNetwork_${appName}`) === 'exists') {
    const existsStatus = { status: `Flux App network of ${appName} already exists.` };
    log.info(existsStatus.status);
    if (onStatus) onStatus(existsStatus);
    return `Flux App Network of ${appName} already exists.`;
  }

  let fluxNet = null;
  if (appsThatMightBeUsingOldGatewayIpAssignment.includes(appName)) {
    // legacy apps pinned their gateway octet by name (it was baked into their
    // config); they must keep it rather than take the next free one.
    fluxNet = await dockerService.createFluxAppDockerNetwork(appName, appName.charCodeAt(appName.length - 1)).catch((error) => log.error(error));
  } else {
    const tried = new Set(legacyPinnedOctets);
    while (!fluxNet) {
      // eslint-disable-next-line no-await-in-loop
      const octet = await dockerService.getFreeFluxAppNetworkOctet(tried);
      if (octet === null) {
        throw new Error(`Flux App network of ${appName} failed to initiate. No free 172.23.x.0/24 subnet available on this node.`);
      }
      // eslint-disable-next-line no-await-in-loop
      fluxNet = await dockerService.createFluxAppDockerNetwork(appName, octet).catch((error) => log.error(error));
      if (!fluxNet) tried.add(octet);
    }
  }
  if (!fluxNet) {
    throw new Error(`Flux App network of ${appName} failed to initiate. Not possible to create docker application network.`);
  }
  log.info(serviceHelper.ensureString(fluxNet));

  const fluxNetworkInterfaces = await dockerService.getFluxDockerNetworkPhysicalInterfaceNames();
  const accessRemoved = await fluxNetworkHelper.removeDockerContainerAccessToNonRoutable(fluxNetworkInterfaces);
  if (onStatus) {
    onStatus({
      status: accessRemoved ? `Private network access removed for ${appName}` : `Error removing private network access for ${appName}`,
    });
    onStatus({ status: `Docker network of ${appName} initiated.` });
  }
  return fluxNet;
}

// One in-flight ensure per app. An app's components reconcile independently, so
// a node that lost a network hands every one of them the same repair at once;
// without this they race for the same octet, and all but one lose the create,
// log the failure and walk to a higher octet before the name check rescues them.
const ensuresInFlight = new Map();

/**
 * Ensures the app's network exists, collapsing concurrent callers for the same
 * app onto one create. Cheap when the network is already there (one state read,
 * no allocation, no firewall work), so callers may treat it as a precondition
 * rather than something to guard with their own check.
 *
 * @param {string} appName bare app name
 * @returns {Promise<object|string>} the created-or-existing network response
 */
async function ensureAppNetworkPresent(appName) {
  const inFlight = ensuresInFlight.get(appName);
  if (inFlight) return inFlight;

  // Settle clears the entry on BOTH outcomes: a retained rejected promise would
  // hand every later caller the same stale failure and wedge the app's repair.
  const pending = ensureAppDockerNetwork(appName)
    .finally(() => ensuresInFlight.delete(appName));
  ensuresInFlight.set(appName, pending);
  return pending;
}

/**
 * Resolve which app a docker network belongs to.
 *
 * Labels are the ownership authority, but they only exist on networks created
 * since the label shipped: an estate upgraded onto this code carries none until
 * each network is recreated. The name convention identifies those. A network we
 * can identify by NEITHER is not ours to reason about, so this returns null and
 * the caller leaves it alone — absence of a label is not evidence of absence of
 * an owner, and on a removal path that distinction is the whole safety story.
 *
 * @param {object} network - docker network list entry (Name, Labels)
 * @param {object} labelKeys - the label schema, resolved by the caller
 * @returns {string|null} owning app name, or null when unidentifiable
 */
function appNetworkOwner(network, labelKeys) {
  const labelled = network.Labels && network.Labels[labelKeys.APP_NETWORK];
  if (labelled) return labelled;
  const name = network.Name || '';
  if (name.startsWith(APP_NETWORK_PREFIX)) {
    return name.slice(APP_NETWORK_PREFIX.length) || null;
  }
  return null;
}

/**
 * Remove the app networks on this node that no installed app owns: what an
 * interrupted uninstall left behind, or what a restored node came back with.
 *
 * Scoped by ownership rather than by docker's idea of "unused" — docker calls a
 * network unused the instant nothing is attached to it, which is true of every
 * healthy app whose container is momentarily down (crash loop, restart,
 * standby), so a prune keyed on that reaps live apps' networks.
 *
 * @param {Set<string>} installedAppNames - apps with an installed row on this node
 * @returns {Promise<{removed: string[], unidentified: number}>} what went and what was left
 */
async function removeUnownedAppNetworks(installedAppNames) {
  const networks = await dockerService.getFluxDockerNetworks();
  const { LABEL_KEYS } = await getSpecBackend();
  const removed = [];
  let unidentified = 0;

  // eslint-disable-next-line no-restricted-syntax
  for (const network of networks) {
    // eslint-disable-next-line no-continue
    if (network.Name === NODE_NETWORK_NAME) continue;
    const owner = appNetworkOwner(network, LABEL_KEYS);
    if (!owner) {
      unidentified += 1;
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-continue
    if (installedAppNames.has(owner)) continue;
    log.info(`appDockerNetwork - removing the network of ${owner}: no installed app owns it`);
    // eslint-disable-next-line no-await-in-loop
    await dockerService.forceRemoveFluxAppDockerNetwork(owner)
      .catch((error) => log.error(`appDockerNetwork - failed to remove the network of ${owner}: ${error.message}`));
    removed.push(owner);
  }

  return { removed, unidentified };
}

module.exports = {
  ensureAppDockerNetwork,
  ensureAppNetworkPresent,
  appNetworkOwner,
  removeUnownedAppNetworks,
  appsThatMightBeUsingOldGatewayIpAssignment,
  legacyPinnedOctets,
};
