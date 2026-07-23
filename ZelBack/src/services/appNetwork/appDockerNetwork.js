const dockerService = require('../dockerService');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const serviceHelper = require('../serviceHelper');
const log = require('../../lib/log');

// Ownership of the per-app docker network (fluxDockerNetwork_<app>) and the
// 172.23.x.0/24 subnet it sits on. Both the install path and the reconciler's
// heal path need it, and neither owns it — dockerService performs the docker
// calls, this decides which network an app gets and when.

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
  log.info(checkingStatus);
  if (onStatus) onStatus(checkingStatus);

  if (await dockerService.dockerNetworkState(`fluxDockerNetwork_${appName}`) === 'exists') {
    const existsStatus = { status: `Flux App network of ${appName} already exists.` };
    log.info(existsStatus);
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

module.exports = {
  ensureAppDockerNetwork,
  appsThatMightBeUsingOldGatewayIpAssignment,
  legacyPinnedOctets,
};
