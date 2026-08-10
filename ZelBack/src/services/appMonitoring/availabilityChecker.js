'use strict';

// Availability Checker - Checks apps availability by testing ports from external nodes
const axios = require('axios');
const config = require('config');
const serviceHelper = require('../serviceHelper');
const nodeConfirmationService = require('../nodeConfirmationService');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const verificationHelper = require('../verificationHelper');
const daemonServiceMiscRpcs = require('../daemonService/daemonServiceMiscRpcs');
const upnpService = require('../upnpService');
const networkStateService = require('../networkStateService');
const fluxHttpTestServer = require('../utils/fluxHttpTestServer');
const appsRepository = require('../appDatabase/appsRepository');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const log = require('../../lib/log');
const { extractIp, extractPort } = require('../utils/socketAddressUtils');

// Helper function to sign check app data
async function signCheckAppData(message) {
  const privKey = await fluxNetworkHelper.getFluxNodePrivateKey();
  const signature = await verificationHelper.signMessage(message, privKey);
  return signature;
}

// Helper function to handle test shutdown
async function handleTestShutdown(testingPort, testHttpServer, options = {}) {
  const skipFirewall = options.skipFirewall || false;
  const skipUpnp = options.skipUpnp || false;
  const skipHttpServer = options.skipHttpServer || false;

  const updateFirewall = skipFirewall ? false : await fluxNetworkHelper.isFirewallActive();

  if (updateFirewall) {
    await fluxNetworkHelper
      .deleteAllowPortRule(testingPort)
      .catch((e) => log.error(e));
  }

  if (!skipUpnp) {
    await upnpService
      .removeMapUpnpPort(testingPort, 'Flux_Test_App')
      .catch((e) => log.error(e));
  }

  if (!skipHttpServer) {
    testHttpServer.close((err) => {
      if (err) {
        log.error(`testHttpServer shutdown failed: ${err.message}`);
      }
    });
  }
}

/**
 * Run a single app-availability check iteration. The body that used to re-spawn
 * itself via setImmediate now simply returns how long the caller should wait
 * before the next iteration.
 * @param {object} dosState - DOS state object with getters and setters
 * @param {object} portsNotWorking - Set of ports not working
 * @param {object} failedNodesTestPortsCache - Cache of failed nodes
 * @returns {Promise<number>} ms to wait before the next iteration
 */
async function runAvailabilityCheckOnce(dosState, portsNotWorking, failedNodesTestPortsCache) {
  const timeouts = {
    default: 3_600_000,
    error: 60_000,
    failure: 15_000,
    dos: 300_000,
    appError: 240_000,
  };

  const thresholds = {
    dos: 100,
    portsHighEdge: 100,
    portsLowEdge: 80,
  };

  if (dosState.dosMountMessage || dosState.dosDuplicateAppMessage) {
    // eslint-disable-next-line no-param-reassign
    dosState.dosMessage = dosState.dosMountMessage || dosState.dosDuplicateAppMessage;
    // eslint-disable-next-line no-param-reassign
    dosState.dosStateValue = thresholds.dos;
    return timeouts.appError;
  }

  const isUpnp = upnpService.isUPNP();
  const testHttpServer = new fluxHttpTestServer.FluxHttpTestServer();

  const setNextPort = () => {
    if (dosState.originalPortFailed && dosState.testingPort > dosState.originalPortFailed) {
      // eslint-disable-next-line no-param-reassign
      dosState.nextTestingPort = dosState.originalPortFailed - 1;
    } else {
      // eslint-disable-next-line no-param-reassign
      dosState.nextTestingPort = null;
      // eslint-disable-next-line no-param-reassign
      dosState.originalPortFailed = null;
    }
  };

  const setRandomPort = () => {
    const ports = Array.from(portsNotWorking);
    const randomIndex = Math.floor(Math.random() * ports.length);
    // eslint-disable-next-line no-param-reassign
    dosState.nextTestingPort = ports[randomIndex];
    return ports;
  };

  try {
    const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
    if (!syncStatus.data.synced) {
      log.info('Flux Node daemon not synced. Application checks are disabled');
      return timeouts.appError;
    }

    if (!nodeConfirmationService.isConfirmed()) {
      log.info('Flux Node not Confirmed. Application checks are disabled');
      return timeouts.appError;
    }

    const localSocketAddress = await fluxNetworkHelper.getLocalSocketAddress();
    if (!localSocketAddress) {
      log.info('No Public IP found. Application checks are disabled');
      return timeouts.appError;
    }

    const installedApps = await appsRepository.listInstalledApps();
    const appPorts = [];

    for (const instantiated of installedApps) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const deployments = await deploymentProvider.buildDeployments(instantiated);
        for (const deployment of deployments) {
          appPorts.push(...deployment.allHostPorts());
        }
      } catch (err) {
        log.warn(`checkMyAppsAvailability: could not resolve ports for ${instantiated.name}: ${err.message}`);
      }
    }

    if (dosState.nextTestingPort) {
      // eslint-disable-next-line no-param-reassign
      dosState.testingPort = dosState.nextTestingPort;
    } else {
      const { fluxapps: { portMin, portMax } } = config;
      // eslint-disable-next-line no-param-reassign
      dosState.testingPort = Math.floor(Math.random() * (portMax - portMin) + portMin);
    }

    log.info(`checkMyAppsAvailability - Testing port ${dosState.testingPort}`);

    const isPortBanned = fluxNetworkHelper.isPortBanned(dosState.testingPort);
    if (isPortBanned) {
      log.info(`checkMyAppsAvailability - Testing port ${dosState.testingPort} is banned`);
      setNextPort();
      return timeouts.failure;
    }

    if (isUpnp) {
      const isPortUpnpBanned = fluxNetworkHelper.isPortUPNPBanned(dosState.testingPort);
      if (isPortUpnpBanned) {
        log.info(`checkMyAppsAvailability - Testing port ${dosState.testingPort} is UPNP banned`);
        setNextPort();
        return timeouts.failure;
      }
    }

    if (appPorts.includes(dosState.testingPort)) {
      log.info(`checkMyAppsAvailability - Skipped checking ${dosState.testingPort} - in use`);
      setNextPort();
      return timeouts.failure;
    }

    const remoteSocketAddress = await networkStateService.getRandomSocketAddress(localSocketAddress);
    if (!remoteSocketAddress) {
      return timeouts.appError;
    }

    if (failedNodesTestPortsCache.has(remoteSocketAddress)) {
      return timeouts.failure;
    }

    const firewallActive = await fluxNetworkHelper.isFirewallActive();
    if (firewallActive) {
      await fluxNetworkHelper.allowPort(dosState.testingPort);
    }

    if (isUpnp) {
      const upnpMapResult = await upnpService.mapUpnpPort(dosState.testingPort, 'Flux_Test_App');
      if (!upnpMapResult) {
        if (dosState.lastUPNPMapFailed) {
          // eslint-disable-next-line no-param-reassign
          dosState.dosStateValue += 4;
          if (dosState.dosStateValue >= thresholds.dos) {
            // eslint-disable-next-line no-param-reassign
            dosState.dosMessage = 'Not possible to run applications on the node, router returning exceptions when creating UPNP ports mappings';
          }
        }
        // eslint-disable-next-line no-param-reassign
        dosState.lastUPNPMapFailed = true;
        log.info(`checkMyAppsAvailability - Testing port ${dosState.testingPort} failed to create UPnP mapping`);
        setNextPort();
        await handleTestShutdown(dosState.testingPort, testHttpServer, {
          skipFirewall: !firewallActive,
          skipUpnp: true,
          skipHttpServer: true,
        });
        return dosState.dosMessage ? timeouts.dos : timeouts.error;
      }
      // eslint-disable-next-line no-param-reassign
      dosState.lastUPNPMapFailed = false;
    }

    const listening = new Promise((resolve, reject) => {
      testHttpServer
        .once('error', (err) => {
          testHttpServer.removeAllListeners('listening');
          reject(err.message);
        })
        .once('listening', () => {
          testHttpServer.removeAllListeners('error');
          resolve(null);
        });
      testHttpServer.listen(dosState.testingPort);
    });

    const error = await listening.catch((err) => err);
    if (error) {
      log.warn(`Unable to listen on port: ${dosState.testingPort}. Error: ${error}`);
      setNextPort();
      await handleTestShutdown(dosState.testingPort, testHttpServer, {
        skipFirewall: !firewallActive,
        skipUpnp: !isUpnp,
        skipHttpServer: true,
      });
      return timeouts.error;
    }

    const timeout = 10_000;
    const axiosConfig = {
      timeout,
      headers: { 'content-type': '' },
    };

    const pubKey = await fluxNetworkHelper.getFluxNodePublicKey();
    const localIp = extractIp(localSocketAddress);
    const localPort = extractPort(localSocketAddress);
    const remoteIp = extractIp(remoteSocketAddress);
    const remotePort = extractPort(remoteSocketAddress);

    const data = {
      ip: localIp,
      port: String(localPort),
      appname: 'appPortsTest',
      ports: [dosState.testingPort],
      pubKey,
    };

    const signature = await signCheckAppData(JSON.stringify(data));
    data.signature = signature;

    const resMyAppAvailability = await axios
      .post(`http://${remoteIp}:${remotePort}/flux/checkappavailability`, JSON.stringify(data), axiosConfig)
      .catch(() => {
        log.error(`checkMyAppsAvailability - ${remoteSocketAddress} for app availability is not reachable`);
        // eslint-disable-next-line no-param-reassign
        dosState.nextTestingPort = dosState.testingPort;
        failedNodesTestPortsCache.set(remoteSocketAddress, '');
        return null;
      });

    await handleTestShutdown(dosState.testingPort, testHttpServer, {
      skipFirewall: !firewallActive,
      skipUpnp: !isUpnp,
    });

    if (!resMyAppAvailability) {
      return timeouts.failure;
    }

    const {
      data: {
        status: responseStatus = null,
        data: { message: responseMessage = 'No response' } = { message: 'No response' },
      },
    } = resMyAppAvailability;

    if (!['success', 'error'].includes(responseStatus)) {
      log.warn(`checkMyAppsAvailability - Unexpected response status: ${responseStatus}`);
      return timeouts.error;
    }

    const portTestFailed = responseStatus === 'error';
    let waitMs = 0;

    if (portTestFailed && portsNotWorking.size < thresholds.portsHighEdge) {
      portsNotWorking.add(dosState.testingPort);
      if (!dosState.originalPortFailed) {
        // eslint-disable-next-line no-param-reassign
        dosState.originalPortFailed = dosState.testingPort;
        // eslint-disable-next-line no-param-reassign
        dosState.nextTestingPort = dosState.testingPort < 65535 ? dosState.testingPort + 1 : dosState.testingPort - 1;
      } else if (dosState.testingPort >= dosState.originalPortFailed && dosState.testingPort + 1 <= 65535) {
        // eslint-disable-next-line no-param-reassign
        dosState.nextTestingPort = dosState.testingPort + 1;
      } else if (dosState.testingPort - 1 > 0) {
        // eslint-disable-next-line no-param-reassign
        dosState.nextTestingPort = dosState.testingPort - 1;
      } else {
        // eslint-disable-next-line no-param-reassign
        dosState.nextTestingPort = null;
        // eslint-disable-next-line no-param-reassign
        dosState.originalPortFailed = null;
      }
      waitMs = timeouts.failure;
    } else if (portTestFailed && dosState.dosStateValue < thresholds.dos) {
      // eslint-disable-next-line no-param-reassign
      dosState.dosStateValue += 4;
      setRandomPort();
      waitMs = timeouts.failure;
    } else if (portTestFailed && dosState.dosStateValue >= thresholds.dos) {
      const failedPorts = setRandomPort();
      // eslint-disable-next-line no-param-reassign
      dosState.dosMessage = `Ports tested not reachable from outside, DMZ or UPNP required! All ports that have failed: ${JSON.stringify(failedPorts)}`;
      waitMs = timeouts.dos;
    } else if (!portTestFailed && portsNotWorking.size > thresholds.portsLowEdge) {
      portsNotWorking.delete(dosState.testingPort);
      setRandomPort();
      waitMs = timeouts.failure;
    } else {
      portsNotWorking.clear();
      // eslint-disable-next-line no-param-reassign
      dosState.nextTestingPort = null;
      // eslint-disable-next-line no-param-reassign
      dosState.originalPortFailed = null;
      // eslint-disable-next-line no-param-reassign
      dosState.dosMessage = dosState.dosMountMessage || dosState.dosDuplicateAppMessage || null;
      // eslint-disable-next-line no-param-reassign
      dosState.dosStateValue = dosState.dosMessage ? thresholds.dos : 0;
      waitMs = timeouts.default;
    }

    if (portTestFailed) {
      log.error(`checkMyAppsAvailability - Port ${dosState.testingPort} unreachable. Detected from ${remoteIp}:${remotePort}. DosState: ${dosState.dosStateValue}`);
    } else {
      log.info(`${responseMessage} Detected from ${remoteIp}:${remotePort} on port ${dosState.testingPort}. DosState: ${dosState.dosStateValue}`);
    }

    if (portsNotWorking.size) {
      log.error(`checkMyAppsAvailability - Count: ${portsNotWorking.size}. portsNotWorking: ${JSON.stringify(Array.from(portsNotWorking))}`);
    }

    return waitMs;
  } catch (error) {
    if (!dosState.dosMessage && (dosState.dosMountMessage || dosState.dosDuplicateAppMessage)) {
      // eslint-disable-next-line no-param-reassign
      dosState.dosMessage = dosState.dosMountMessage || dosState.dosDuplicateAppMessage;
    }
    await handleTestShutdown(dosState.testingPort, testHttpServer, { skipUpnp: !isUpnp });
    log.error(`checkMyAppsAvailability - Error: ${error}`);
    return timeouts.appError;
  }
}

/**
 * Continuously check my apps availability, pacing each iteration by the delay it
 * returns. Fire-and-forget — runs for the lifetime of the process.
 * @param {object} dosState - DOS state object with getters and setters
 * @param {object} portsNotWorking - Set of ports not working
 * @param {object} failedNodesTestPortsCache - Cache of failed nodes
 * @returns {Promise<void>}
 */
async function checkMyAppsAvailability(dosState, portsNotWorking, failedNodesTestPortsCache) {
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const waitMs = await runAvailabilityCheckOnce(dosState, portsNotWorking, failedNodesTestPortsCache);
    // eslint-disable-next-line no-await-in-loop
    await serviceHelper.delay(waitMs);
  }
}

module.exports = {
  checkMyAppsAvailability,
  runAvailabilityCheckOnce,
};
