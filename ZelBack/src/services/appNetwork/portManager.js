const config = require('config');
const axios = require('axios');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const networkStateService = require('../networkStateService');
const verificationHelper = require('../verificationHelper');
const log = require('../../lib/log');
const upnpService = require('../upnpService');
const serviceHelper = require('../serviceHelper');
const fluxHttpTestServer = require('../utils/fluxHttpTestServer');
const appsRepository = require('../appDatabase/appsRepository');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const { extractIp, extractPort } = require('../utils/socketAddressUtils');
const { withHostMutationLock } = require('../utils/hostMutationLock');

// Global cache for failed nodes
const failedNodesTestPortsCache = new Map();

/**
 * Get ports assigned by currently installed applications
 * @returns {Promise<Array>} Array of objects with app names and their assigned ports
 */
async function assignedPortsInstalledApps() {
  const deployments = await deploymentProvider.listInstalledDeployments();
  return deployments.map((deployment) => ({ name: deployment.appName, ports: deployment.allHostPorts() }));
}

/**
 * Get ports assigned by global applications
 * @param {string[]} appNames - Array of app names to check
 * @returns {Promise<Array>} Array of objects with app names and their assigned ports
 */
async function assignedPortsGlobalApps(appNames) {
  if (!appNames || appNames.length === 0) return [];

  const appsQuery = appNames.map((app) => ({ name: app }));
  const globalApps = await appsRepository.listGlobalAppInfo({ filter: { $or: appsQuery } });
  const apps = [];
  for (const inst of globalApps) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const deployment = await deploymentProvider.buildDeployment(inst);
      const ports = deployment.allHostPorts();
      if (ports.length > 0) {
        apps.push({ name: deployment.appName, ports });
      }
    } catch (err) {
      log.warn(`assignedPortsGlobalApps: skipping ${inst.name}: ${err.message}`);
    }
  }
  return apps;
}

/**
 * Ensure application ports are not already in use
 * @param {object} appSpecFormatted - Plain wire-form app spec
 * @param {string[]} globalCheckedApps - Global apps to check against
 * @returns {Promise<boolean>} True if ports are available
 * @throws {Error} If ports are already in use
 */
async function ensureApplicationPortsNotUsed(deployment, globalCheckedApps) {
  let currentAppsPorts = await assignedPortsInstalledApps();

  if (globalCheckedApps && globalCheckedApps.length) {
    const globalAppsPorts = await assignedPortsGlobalApps(globalCheckedApps);
    currentAppsPorts = currentAppsPorts.concat(globalAppsPorts);
  }

  for (const port of deployment.allHostPorts()) {
    const portAssigned = currentAppsPorts.find((app) => app.ports.includes(port));
    if (portAssigned && portAssigned.name !== deployment.appName) {
      throw new Error(`Flux App ${deployment.appName} port ${port} already used with different application. Installation aborted.`);
    }
  }
  return true;
}

/**
 * Restores FluxOS firewall, UPNP rules
 * @returns {Promise<void>}
 */
async function restoreFluxPortsSupport() {
  try {
    const isUPNP = upnpService.isUPNP();

    const { userconfig } = globalThis;
    const apiPort = userconfig.initial.apiport || config.server.apiport;
    const homePort = +apiPort - 1;
    const apiPortSSL = +apiPort + 1;
    const syncthingPort = +apiPort + 2;

    const firewallActive = await fluxNetworkHelper.isFirewallActive();
    if (firewallActive) {
      // setup UFW if active
      await fluxNetworkHelper.allowPort(serviceHelper.ensureNumber(apiPort));
      await fluxNetworkHelper.allowPort(serviceHelper.ensureNumber(homePort));
      await fluxNetworkHelper.allowPort(serviceHelper.ensureNumber(apiPortSSL));
      await fluxNetworkHelper.allowPort(serviceHelper.ensureNumber(syncthingPort));
    }

    // UPNP
    if (isUPNP) {
      // map our Flux API, UI and SYNCTHING port
      await upnpService.setupUPNP(apiPort);
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * Restores applications firewall, UPNP rules
 * @returns {Promise<void>}
 */
async function restoreAppsPortsSupport() {
  try {
    const currentAppsPorts = await assignedPortsInstalledApps();
    const isUPNP = upnpService.isUPNP();

    const firewallActive = await fluxNetworkHelper.isFirewallActive();
    // setup UFW for apps
    if (firewallActive) {
      // eslint-disable-next-line no-restricted-syntax
      for (const application of currentAppsPorts) {
        // eslint-disable-next-line no-restricted-syntax
        for (const port of application.ports) {
          // eslint-disable-next-line no-await-in-loop
          await fluxNetworkHelper.allowPort(serviceHelper.ensureNumber(port));
        }
      }
    }

    // UPNP
    if (isUPNP) {
      // map application ports
      // eslint-disable-next-line no-restricted-syntax
      for (const application of currentAppsPorts) {
        // eslint-disable-next-line no-restricted-syntax
        for (const port of application.ports) {
          // eslint-disable-next-line no-await-in-loop
          const upnpOk = await upnpService.mapUpnpPort(serviceHelper.ensureNumber(port), `Flux_App_${application.name}`);
          if (!upnpOk) {
            log.warn(`REMOVAL REASON: UPNP port mapping failure - ${application.name} failed to map port ${port} via UPNP (portManager)`);
            // Import locally to avoid circular dependency
            // eslint-disable-next-line global-require
            const appUninstaller = require('../appLifecycle/appUninstaller');
            // eslint-disable-next-line no-await-in-loop
            await appUninstaller.uninstallApplication(application.name, { forceKill: true, skipGuard: true, broadcastRemoval: true }).catch((error) => log.error(error)); // remove entire app
            // eslint-disable-next-line no-await-in-loop
            await serviceHelper.delay(3 * 60 * 1000); // 3 mins
            break;
          }
        }
      }
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * Restores FluxOS and applications firewall, UPNP rules
 * @returns {Promise<void>}
 */
async function restorePortsSupport() {
  try {
    await restoreFluxPortsSupport();
    await restoreAppsPortsSupport();
  } catch (error) {
    log.error(error);
  }
}

/**
 * Get all ports currently in use by applications
 * @returns {Promise<number[]>} Array of port numbers in use
 */
async function getAllUsedPorts() {
  const installedAppsPorts = await assignedPortsInstalledApps();
  const allPorts = [];

  installedAppsPorts.forEach((app) => {
    allPorts.push(...app.ports);
  });

  return [...new Set(allPorts)]; // Remove duplicates
}

/**
 * Check if a specific port is available
 * @param {number} port - Port number to check
 * @param {string} excludeApp - App name to exclude from check (for updates)
 * @returns {Promise<boolean>} True if port is available
 */
async function isPortAvailable(port, excludeApp = null) {
  const usedPorts = await assignedPortsInstalledApps();

  // eslint-disable-next-line no-restricted-syntax
  for (const app of usedPorts) {
    if (excludeApp && app.name === excludeApp) {
      continue; // eslint-disable-line no-continue
    }
    if (app.ports.includes(Number(port))) {
      return false;
    }
  }

  return true;
}

/**
 * Find the next available port in a given range
 * @param {number} startPort - Starting port to check
 * @param {number} endPort - Ending port range
 * @param {string} excludeApp - App name to exclude from check
 * @returns {Promise<number|null>} Next available port or null if none found
 */
async function findNextAvailablePort(startPort, endPort, excludeApp = null) {
  for (let port = startPort; port <= endPort; port += 1) {
    // eslint-disable-next-line no-await-in-loop
    const available = await isPortAvailable(port, excludeApp);
    if (available) {
      return port;
    }
  }
  return null;
}

/**
 * Sign application data for verification
 * @param {string} message - Message to sign
 * @returns {Promise<string>} Signature
 */
async function signCheckAppData(message) {
  const privKey = await fluxNetworkHelper.getFluxNodePrivateKey();
  const signature = await verificationHelper.signMessage(message, privKey);
  return signature;
}

/**
 * Bind a throwaway HTTP listener on a port to prove this node can currently hold it
 * (the local half of the port check, before asking peers about public reachability).
 * Resolves once the socket is listening; rejects on a bind error (e.g. EADDRINUSE).
 * The server is pushed onto `trackingServers` SYNCHRONOUSLY - before listen() and
 * before this returns - so the caller's cleanup closes it even when a sibling port's
 * bind rejects first and fail-fasts the concurrent Promise.all.
 * @param {number} portToTest
 * @param {Array} trackingServers - collector the caller closes during cleanup
 * @returns {Promise<null>}
 */
function bindPortTestServer(portToTest, trackingServers) {
  return new Promise((resolve, reject) => {
    const testHttpServer = new fluxHttpTestServer.FluxHttpTestServer();
    trackingServers.push(testHttpServer);
    // Tested: the 'error' handler catches EADDRINUSE. Previously this crashed the app.
    // note - if you kill the port with `ss --kill state listening src :<the port>`
    // nodeJS does not raise an error.
    testHttpServer
      .once('error', (err) => {
        testHttpServer.removeAllListeners('listening');
        reject(err.message);
      })
      .once('listening', () => {
        testHttpServer.removeAllListeners('error');
        resolve(null);
      });
    testHttpServer.listen(portToTest);
  });
}

/**
 * Ask a single remote node to connect back to our IP:port(s) and report whether
 * they are publicly reachable.
 *   answered=false  -> the peer itself did not respond (says nothing about our port)
 *   reachable=true  -> the peer reached our port(s) (proves public reachability)
 *   reachable=false -> the peer answered but could not reach a port (failedPort set)
 * @param {string} peerSocketAddress - 'ip:port' of the node to ask
 * @param {string} payload - signed, JSON-stringified port-test request body
 * @param {object} axiosConfig - axios config (carries the per-peer timeout)
 * @returns {Promise<{answered: boolean, reachable?: boolean, failedPort?: number}>}
 */
async function askPeerPortReachability(peerSocketAddress, payload, axiosConfig) {
  const askingIP = extractIp(peerSocketAddress);
  const askingIpPort = extractPort(peerSocketAddress);
  const res = await axios
    .post(`http://${askingIP}:${askingIpPort}/flux/checkappavailability`, payload, axiosConfig)
    .catch(() => {
      // peer unreachable from us -> says nothing about OUR port; it is just a non-answer
      log.info(`askPeerPortReachability - peer ${askingIP}:${askingIpPort} did not answer port test`);
      return null;
    });
  if (!res || !res.data) return { answered: false };
  if (res.data.status === 'success') return { answered: true, reachable: true };
  if (res.data.status === 'error') {
    let failedPort = null;
    const msg = res.data.data && res.data.data.message;
    if (msg && msg.includes('Failed port: ')) {
      failedPort = serviceHelper.ensureNumber(msg.split('Failed port: ')[1]);
    }
    return { answered: true, reachable: false, failedPort };
  }
  return { answered: false };
}

/**
 * Verify the given ports are publicly reachable by asking remote nodes to connect
 * back. Reachability is external, so the peer round-trip is the only real signal -
 * there is nothing local to wait for (firewall/UPnP are already applied by the
 * caller). Each round queries portTestPeerQueryCount nodes from DISTINCT /16s (and
 * never our own /16) concurrently:
 *   - the first peer that reaches us proves reachability -> true;
 *   - >=2 distinct-subnet peers agreeing it is unreachable -> false;
 *   - an inconclusive round (peers did not answer) retries with fresh diverse peers,
 *     bounded by portTestMaxRounds rounds.
 * Same-network peers are excluded because a local-path connect-back can give a false
 * pass and same-subnet peers share fate (their votes are not independent). Never
 * confirmed reachable -> false (fail-closed: do not install an unverifiable port).
 * @param {object} data - signed port-test request body
 * @param {string} localSocketAddress - our own socket address (excluded from peers)
 * @returns {Promise<boolean>}
 */
async function arePortsReachableViaPeers(data, localSocketAddress) {
  const axiosConfig = { timeout: config.fluxapps.portTestPeerTimeoutMs };
  const peerQueryCount = config.fluxapps.portTestPeerQueryCount;
  const payload = JSON.stringify(data);
  let failVotes = 0;

  for (let round = 0; round < config.fluxapps.portTestMaxRounds; round += 1) {
    // eslint-disable-next-line no-await-in-loop
    const peers = await networkStateService.getRandomSocketAddressSample(peerQueryCount, {
      excludeSocketAddress: localSocketAddress,
      distinctPrefixes: true,
    });
    if (!peers || peers.length === 0) {
      // no eligible peers this round (tiny / just-booted network state) - retry
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const results = await Promise.all(
      peers.map((peer) => askPeerPortReachability(peer, payload, axiosConfig)),
    );
    if (results.some((r) => r.reachable)) return true;
    failVotes += results.filter((r) => r.answered && r.reachable === false).length;
    if (failVotes >= 2) return false;
    // else inconclusive (peers did not answer) -> next round of fresh diverse peers
  }
  return false;
}

/**
 * To check if app ports are available publicly before installation
 * @param {Array} portsToTest Array of ports to test
 * @returns {Promise<boolean>} True if ports are available, false otherwise
 */
async function checkInstallingAppPortAvailable(portsToTest = []) {
  // No ports to verify -> nothing to probe. A portless app's install must not
  // hinge on reaching a random peer (which can time out and falsely fail it).
  if (!Array.isArray(portsToTest) || portsToTest.length === 0) {
    return true;
  }
  const beforeAppInstallTestingServers = [];
  const isUPNP = upnpService.isUPNP();
  let portsStatus = false;

  try {
    const localSocketAddress = await fluxNetworkHelper.getLocalSocketAddress();
    if (!localSocketAddress) {
      throw new Error('Failed to detect Public IP');
    }
    const localIp = extractIp(localSocketAddress);
    const localPort = extractPort(localSocketAddress);

    const pubKey = await fluxNetworkHelper.getFluxNodePublicKey();
    let somePortBanned = false;
    portsToTest.forEach((portToTest) => {
      const iBP = fluxNetworkHelper.isPortBanned(portToTest);
      if (iBP) {
        somePortBanned = true;
      }
    });
    if (somePortBanned) {
      return false;
    }
    if (isUPNP) {
      somePortBanned = false;
      portsToTest.forEach((portToTest) => {
        const iBP = fluxNetworkHelper.isPortUPNPBanned(portToTest);
        if (iBP) {
          somePortBanned = true;
        }
      });
      if (somePortBanned) {
        return false;
      }
    }
    const firewallActive = await fluxNetworkHelper.isFirewallActive();
    // Open the firewall + UPnP mapping for every port (sequentially, each leaf edit
    // under the host-mutation lock so it never races a concurrent teardown's ufw/UPnP
    // cleanup), then bind a test listener on every port concurrently. allowPort /
    // mapUpnpPort are awaited (the rule/mapping is live the moment they resolve) and
    // each bind is confirmed by its 'listening' event, so there is nothing to "settle"
    // - no blind bind delay, and a multi-port app is no longer bound one port at a time.
    // eslint-disable-next-line no-restricted-syntax
    for (const portToTest of portsToTest) {
      if (firewallActive) {
        // eslint-disable-next-line no-await-in-loop
        await withHostMutationLock(() => fluxNetworkHelper.allowPort(portToTest));
      }
      if (isUPNP) {
        // eslint-disable-next-line no-await-in-loop
        const upnpMapResult = await withHostMutationLock(() => upnpService.mapUpnpPort(portToTest, `Flux_Prelaunch_App_${portToTest}`));
        if (!upnpMapResult) {
          throw new Error('Failed to create map UPNP port');
        }
      }
    }
    // Bind a throwaway listener on each port concurrently to prove this node can hold
    // them. Each server is tracked synchronously (see bindPortTestServer) so a sibling
    // bind failure still tears every one of them down via the catch below.
    await Promise.all(
      portsToTest.map((portToTest) => bindPortTestServer(portToTest, beforeAppInstallTestingServers)),
    );

    const data = {
      ip: localIp,
      port: localPort,
      appname: 'appPortsTest',
      ports: portsToTest,
      pubKey,
    };
    const signature = await signCheckAppData(JSON.stringify(data));
    data.signature = signature;
    portsStatus = await arePortsReachableViaPeers(data, localSocketAddress);
    // stop listening on the port, close the port
    // eslint-disable-next-line no-restricted-syntax
    for (const portToTest of portsToTest) {
      if (firewallActive) {
        // eslint-disable-next-line no-await-in-loop
        await withHostMutationLock(() => fluxNetworkHelper.deleteAllowPortRule(portToTest));
      }
      if (isUPNP) {
        // eslint-disable-next-line no-await-in-loop
        await withHostMutationLock(() => upnpService.removeMapUpnpPort(portToTest, `Flux_Prelaunch_App_${portToTest}`));
      }
    }
    // Close all test servers and wait for them to finish
    await Promise.all(
      beforeAppInstallTestingServers.map((server) => new Promise((resolve) => {
        server.close((err) => {
          if (err) {
            log.error(`beforeAppInstallTestingServer Shutdown failed: ${err.message}`);
          }
          resolve();
        });
      })),
    );
    return portsStatus;
  } catch (error) {
    let firewallActive = true;
    firewallActive = await fluxNetworkHelper.isFirewallActive().catch((e) => log.error(e));
    // stop listening on the testing port, close the port
    // eslint-disable-next-line no-restricted-syntax
    for (const portToTest of portsToTest) {
      if (firewallActive) {
        // eslint-disable-next-line no-await-in-loop
        await withHostMutationLock(() => fluxNetworkHelper.deleteAllowPortRule(portToTest).catch((e) => log.error(e)));
      }
      if (isUPNP) {
        // eslint-disable-next-line no-await-in-loop
        await withHostMutationLock(() => upnpService.removeMapUpnpPort(portToTest, `Flux_Prelaunch_App_${portToTest}`).catch((e) => log.error(e)));
      }
    }
    // Close all test servers and wait for them to finish
    await Promise.all(
      beforeAppInstallTestingServers.map((server) => new Promise((resolve) => {
        try {
          server.close((err) => {
            if (err) {
              log.error(`beforeAppInstallTestingServer Shutdown failed: ${err.message}`);
            }
            resolve();
          });
        } catch (e) {
          log.warn(e);
          resolve();
        }
      })),
    );
    log.error(error);
    return false;
  }
}

/**
 * Periodically call other nodes to establish a connection with the ports I have open on UPNP to remain OPEN
 * @returns {Promise<void>}
 */
async function callOtherNodeToKeepUpnpPortsOpen() {
  try {
    const { userconfig } = globalThis;
    const apiPort = userconfig.initial.apiport || config.server.apiport;
    const localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();
    if (!localSocketAddr) {
      return;
    }

    const randomSocketAddress = await networkStateService.getRandomSocketAddress(localSocketAddr);

    if (!randomSocketAddress) return;

    const askingIP = extractIp(randomSocketAddress);
    const askingIpPort = extractPort(randomSocketAddress);
    const localIp = extractIp(localSocketAddr);

    if (localIp === askingIP) {
      callOtherNodeToKeepUpnpPortsOpen();
      return;
    }
    if (failedNodesTestPortsCache.has(askingIP)) {
      callOtherNodeToKeepUpnpPortsOpen();
      return;
    }

    const pubKey = await fluxNetworkHelper.getFluxNodePublicKey();
    const deployments = await deploymentProvider.listInstalledDeployments();
    const ports = [];
    for (const deployment of deployments) {
      ports.push(...deployment.allHostPorts());
    }

    // We don't add the api port, as the remote node will callback to our
    // api port to make sure it can connect before testing any other ports
    // this is so that we know the remote end can reach us. I also removed
    // -2,-3,-4, +3 as they are currently not used.
    ports.push(apiPort - 1);
    // ports.push(apiPort - 2);
    // ports.push(apiPort - 3);
    // ports.push(apiPort - 4);
    ports.push(apiPort - 5);
    ports.push(apiPort + 1);
    ports.push(apiPort + 2);
    // ports.push(apiPort + 3);

    const axiosConfig = {
      timeout: 5_000,
    };

    const dataUPNP = {
      ip: localIp,
      apiPort,
      ports,
      pubKey,
      timestamp: Math.floor(Date.now() / 1000),
    };

    const stringData = JSON.stringify(dataUPNP);
    const signature = await signCheckAppData(stringData);
    dataUPNP.signature = signature;

    const logMsg = `callOtherNodeToKeepUpnpPortsOpen - calling ${askingIP}:${askingIpPort} to test ports: ${ports}`;
    log.info(logMsg);

    const url = `http://${askingIP}:${askingIpPort}/flux/keepupnpportsopen`;
    await axios.post(url, dataUPNP, axiosConfig).catch(() => {
      // callOtherNodeToKeepUpnpPortsOpen();
    });
  } catch (error) {
    log.error(error);
  }
}

module.exports = {
  assignedPortsInstalledApps,
  assignedPortsGlobalApps,
  ensureApplicationPortsNotUsed,
  restoreFluxPortsSupport,
  restoreAppsPortsSupport,
  restorePortsSupport,
  getAllUsedPorts,
  isPortAvailable,
  findNextAvailablePort,
  signCheckAppData,
  askPeerPortReachability,
  arePortsReachableViaPeers,
  checkInstallingAppPortAvailable,
  callOtherNodeToKeepUpnpPortsOpen,
  failedNodesTestPortsCache,
};
