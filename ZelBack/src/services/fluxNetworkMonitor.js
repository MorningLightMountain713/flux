const config = require('config');
const log = require('../lib/log');
const serviceHelper = require('./serviceHelper');
const fluxNetworkHelper = require('./fluxNetworkHelper');
const nodeIdentityRepository = require('./appDatabase/nodeIdentityRepository');
const nodeDosState = require('./nodeDosState');
const benchmarkService = require('./benchmarkService');
const networkStateService = require('./networkStateService');
const fluxCommunicationUtils = require('./fluxCommunicationUtils');
const fluxCommunicationMessagesSender = require('./fluxCommunicationMessagesSender');
const geolocationService = require('./geolocationService');
const daemonServiceMiscRpcs = require('./daemonService/daemonServiceMiscRpcs');
const nodeConfirmationService = require('./nodeConfirmationService');
const daemonServiceWalletRpcs = require('./daemonService/daemonServiceWalletRpcs');
const daemonServiceUtils = require('./daemonService/daemonServiceUtils');
const cacheManager = require('./utils/cacheManager').default;
const {
  normalizeSocketAddress, extractIp, extractPort, socketAddressesMatch,
} = require('./utils/socketAddressUtils');
// App-lifecycle dependencies. This service sits above both the network
// primitives (fluxNetworkHelper) and app-lifecycle, so it requires the
// orchestrators directly at the top level.
const appQueryService = require('./appQuery/appQueryService');
const appUninstaller = require('./appLifecycle/appUninstaller');
const registryManager = require('./appDatabase/registryManager');
const appController = require('./appManagement/appController');
const { resolveSpec } = require('./utils/specCutover');

const myCache = cacheManager.ipCache;

// IP-change monitoring state.
let ipChangeData = null;
let dosTooManyIpChanges = false;
let maxNumberOfIpChanges = 0;

/**
 * To check ip changes limit. If over limit all apps are uninstalled from the node and it get dos state
 * @returns {boolean} True if a ip as changes more than one time in the last 20h
 */
async function ipChangesOverLimit() {
  const currentTime = Date.now();
  if (ipChangeData) {
    const oldTime = ipChangeData.time;
    const timeDifference = currentTime - oldTime;
    if (timeDifference <= 20 * 60 * 60 * 1000) {
      ipChangeData.count += 1;
      if (ipChangeData.count > maxNumberOfIpChanges) {
        maxNumberOfIpChanges = ipChangeData.count;
      }
      if (ipChangeData.count >= 2) {
        let apps = await appQueryService.installedApps();
        if (apps.status === 'success' && apps.data.length > 0) {
          apps = apps.data;
          // eslint-disable-next-line no-restricted-syntax
          for (const app of apps) {
            log.warn(`REMOVAL REASON: Too many IP changes - ${app.name} being removed due to ${ipChangeData.count} IP changes in ${timeDifference}ms (DoS protection)`);
            // eslint-disable-next-line no-await-in-loop
            await appUninstaller.uninstallApplication(app.name, { forceKill: true }).catch((error) => log.error(error)); // we will not send appremove messages because they will not be accepted by the other nodes
            // eslint-disable-next-line no-await-in-loop
            await serviceHelper.delay(500);
          }
        }
        dosTooManyIpChanges = true;
        return true;
      }
    } else {
      ipChangeData.time = currentTime;
      ipChangeData.count = 1;
      maxNumberOfIpChanges = 1;
    }
    return false;
  }
  ipChangeData = {
    time: currentTime,
    count: 1,
  };
  return false;
}

function getMaxNumberOfIpChanges() {
  return maxNumberOfIpChanges;
}

/**
 * To adjust an external IP.
 * @param {string} ip IP address.
 * @returns {Promise<void>} Return statement is only used here to interrupt the function and nothing is returned.
 */
async function adjustExternalIP(ip) {
  try {
    const { userconfig } = globalThis;
    // https://github.com/sindresorhus/ip-regex/blob/master/index.js#L8
    const v4 = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)){3}';
    const v4exact = new RegExp(`^${v4}$`);
    if (!v4exact.test(ip)) {
      log.warn(`Gathered IP ${ip} is not a valid format`);
      return;
    }
    // The address this node last observed about itself: node runtime state, so it
    // is remembered in the local database rather than written back into the
    // operator's config file.
    const oldUserConfigIp = await nodeIdentityRepository.getLastKnownIp();
    if (ip === oldUserConfigIp) {
      return;
    }
    log.info(`Adjusting External IP from ${oldUserConfigIp} to ${ip}`);
    await nodeIdentityRepository.setLastKnownIp(ip);

    if (oldUserConfigIp && v4exact.test(oldUserConfigIp) && !myCache.has(ip)) {
      myCache.set(ip, '');
      const newIP = normalizeSocketAddress(`${ip}:${userconfig.initial.apiport}`);
      const oldIP = normalizeSocketAddress(`${oldUserConfigIp}:${userconfig.initial.apiport}`);
      log.info(`New public Ip detected: ${newIP}, old Ip: ${oldIP} , updating the FluxNode info on the network`);
      const measuredUptime = fluxNetworkHelper.fluxUptime();
      if (await ipChangesOverLimit() && measuredUptime.status === 'success' && measuredUptime.data > config.fluxapps.minUpTime) {
        log.info('IP changes over the limit allowed, one in 20 hours');
        nodeDosState.addDosState(11);
        nodeDosState.setDosMessage('IP changes over the limit allowed, one in 20 hours');
        log.error(nodeDosState.getRawDosMessage());
      }
      let apps = await appQueryService.installedApps();
      if (apps.status === 'success' && apps.data.length > 0) {
        apps = apps.data;
        let appsRemoved = 0;
        // eslint-disable-next-line no-restricted-syntax
        for (const app of apps) {
          // Check if app requires static IP - if so, uninstall it since IP changed
          // Only decrypt enterprise app specs if the app has enterprise field (v8+)
          if (app.version >= 7 && (app.staticip === true || app.enterprise)) {
            let appSpecs = app;
            // Decrypt enterprise app specs if needed (v8+ with enterprise field)
            if (app.enterprise) {
              try {
                // eslint-disable-next-line no-await-in-loop
                appSpecs = await resolveSpec(app);
              } catch (decryptError) {
                log.error(`Failed to decrypt enterprise specs for ${app.name}: ${decryptError.message}`);
                // eslint-disable-next-line no-continue
                continue;
              }
            }
            if (appSpecs.staticip === true) {
              log.info(`Application ${app.name} requires static IP but node IP has changed, uninstalling app`);
              log.warn(`REMOVAL REASON: Static IP required - ${app.name} requires static IP but node IP changed from ${oldIP} to ${newIP}`);
              // eslint-disable-next-line no-await-in-loop
              await appUninstaller.uninstallApplication(app.name, { forceKill: true, skipGuard: true, broadcastRemoval: true }).catch((error) => log.error(error));
              appsRemoved += 1;
              // eslint-disable-next-line no-continue
              continue;
            }
          }

          // eslint-disable-next-line no-await-in-loop
          const runningAppList = await registryManager.appLocation(app.name);
          const duplicateInstance = runningAppList.find((instance) => extractIp(instance.ip) === ip);
          if (duplicateInstance) {
            log.info(`Aplication: ${app.name}, was found on the network already running under the same ip, uninstalling app`);
            log.warn(`REMOVAL REASON: Duplicate IP detected - ${app.name} already running on network with IP ${ip} (after IP change)`);
            // eslint-disable-next-line no-await-in-loop
            await appUninstaller.uninstallApplication(app.name, { forceKill: true, skipGuard: true, broadcastRemoval: true }).catch((error) => log.error(error));
            appsRemoved += 1;
          } else {
            // once app specs v8 is done we check if app have specs that is using fluxnode service.
            // bounce the app through the reconciler to pick up the new node IP
            // eslint-disable-next-line no-await-in-loop
            await appController.requestAppRestart(app.name);
          }
        }
        if (apps.length > appsRemoved) {
          const broadcastedAt = Date.now();
          const newIpChangedMessage = {
            type: 'fluxipchanged',
            version: 1,
            oldIP,
            newIP,
            broadcastedAt,
          };
          // broadcast messages about ip changed to all peers
          await fluxCommunicationMessagesSender.broadcastMessageToAll(newIpChangedMessage);
        }
      }
      const result = await daemonServiceWalletRpcs.createConfirmationTransaction();
      log.info(`createConfirmationTransaction: ${JSON.stringify(result)}`);
      // Update geolocation service to track IP change and update static IP status
      geolocationService.setNodeGeolocation();
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * To check user's FluxNode availability.
 * @param {number} retryNumber Number of retries.
 * @returns {Promise<boolean>} Return value is only for testing
 */
async function checkMyFluxAvailability(retryNumber = 0) {
  if (dosTooManyIpChanges) {
    nodeDosState.addDosState(11);
    nodeDosState.setDosMessage('IP changes over the limit allowed, one in 20 hours');
    return false;
  }

  const localSocketAddress = fluxNetworkHelper.getCachedLocalSocketAddress();
  if (localSocketAddress === null) return false;

  const fluxBenchVersionAllowed = await fluxNetworkHelper.checkFluxbenchVersionAllowed();
  if (!fluxBenchVersionAllowed) {
    return false;
  }

  const randomSocketAddress = await networkStateService.getRandomSocketAddress(
    localSocketAddress,
  );

  if (!randomSocketAddress) return false;

  const remoteIp = extractIp(randomSocketAddress);
  const remotePort = extractPort(randomSocketAddress);

  const axiosConfig = {
    timeout: 7000,
  };

  const localIp = extractIp(localSocketAddress);
  const localApiPort = extractPort(localSocketAddress);

  const url = `http://${remoteIp}:${remotePort}/flux/`
    + `checkfluxavailability?ip=${localIp}&port=${localApiPort}`;

  const resMyAvailability = await serviceHelper.axiosGet(url, axiosConfig).catch(
    (error) => {
      log.error(`checkMyFluxAvailability - ${remoteIp}:${remotePort}`
        + ` is not reachable. ${error.message}`);

      return null;
    },
  );

  if (!resMyAvailability) {
    nodeDosState.addDosState(2);
    if (nodeDosState.getDosStateValue() > 10) {
      nodeDosState.setDosMessage(nodeDosState.getRawDosMessage() || 'Flux communication is limited, other nodes on the network cannot reach yours through API calls');
      log.error(nodeDosState.getRawDosMessage());
      return false;
    }
    if (retryNumber <= 6) {
      const newRetryIndex = retryNumber + 1;
      return checkMyFluxAvailability(newRetryIndex);
    }
    return false;
  }
  if (resMyAvailability.data.status === 'error' || resMyAvailability.data.data.message.includes('not')) {
    log.error(`My Flux unavailability detected from: ${remoteIp}:${remotePort}`);
    // Asked Flux cannot reach me lets check if ip changed
    if (retryNumber === 4 || nodeDosState.getDosStateValue() > 10) {
      log.info('Getting publicIp from FluxBench');
      const benchIpResponse = await benchmarkService.getPublicIp();
      if (benchIpResponse.status === 'success') {
        log.info(`FluxBench reported public IP: ${benchIpResponse.data}`);
        const benchMyIP = benchIpResponse.data.length > 5 ? benchIpResponse.data : null;
        if (benchMyIP && extractIp(benchMyIP) !== localIp) {
          daemonServiceUtils.setStandardCache('getbenchmarks[]', null);
          log.info('New IP found... updating network');
          nodeDosState.setDosStateValue(0);
          nodeDosState.setDosMessage(null);
          await adjustExternalIP(extractIp(benchMyIP));
          return true;
        } if (benchMyIP && extractIp(benchMyIP) === localIp) {
          log.info('FluxBench reported the same Ip that was already in use');
        } else {
          log.info('FluxBench reported a invalid IP');
          nodeDosState.setDosMessage('Error getting publicIp from FluxBench');
          nodeDosState.addDosState(15);
          log.error('FluxBench wasnt able to detect flux node public ip');
        }
      } else {
        log.info('FluxBench reported returned error on getpublicipcall');
        nodeDosState.setDosMessage('Error getting publicIp from FluxBench');
        nodeDosState.addDosState(15);
        log.error(nodeDosState.getRawDosMessage());
        return false;
      }
    }
    nodeDosState.addDosState(2);
    if (nodeDosState.getDosStateValue() > 10) {
      nodeDosState.setDosMessage(nodeDosState.getRawDosMessage() || 'Flux is not available for outside communication');
      log.error(nodeDosState.getRawDosMessage());
      return false;
    }
    if (retryNumber <= 6) {
      const newRetryIndex = retryNumber + 1;
      return checkMyFluxAvailability(newRetryIndex);
    }
    return false;
  }
  const measuredUptime = fluxNetworkHelper.fluxUptime();
  if (measuredUptime.status === 'success' && measuredUptime.data > config.fluxapps.minUpTime) { // node has been running for 30 minutes. Upon starting a node, there can be dos that needs resetting
    const found = await fluxCommunicationUtils.getFluxnodeFromFluxList(localSocketAddress);
    const nodeCount = await fluxCommunicationUtils.getNodeCount();

    if (nodeCount > config.fluxapps.minIncoming + config.fluxapps.minOutgoing && found) { // our node MUST be in confirmed list in order to have some peers
      // check sufficient connections
      const connectionInfo = fluxNetworkHelper.isCommunicationEstablished();
      if (connectionInfo.status === 'error') {
        nodeDosState.addDosState(0.13); // slow increment, DOS after ~75 minutes. 0.13 per minute. This check depends on other nodes being able to connect to my node
        if (nodeDosState.getDosStateValue() > 10) {
          nodeDosState.setDosMessage(connectionInfo.data.message || 'Flux does not have sufficient peers');
          log.error(nodeDosState.getRawDosMessage());
          return false;
        }
        await adjustExternalIP(localIp);
        return true; // availability ok
      }
    }
  } else if (measuredUptime.status === 'error') {
    log.error('Flux uptime is not available'); // introduce dos increment
  }
  nodeDosState.setDosStateValue(0);
  nodeDosState.setDosMessage(null);
  await adjustExternalIP(localIp);
  return true;
}

/**
 * To check deterministic node collisions (i.e. if multiple FluxNode instances detected).
 * @returns {void} Return statement is only used here to interrupt the function and nothing is returned.
 */
async function checkDeterministicNodesCollisions() {
  const axiosConfig = {
    timeout: 5000,
  };

  try {
    // get my external ip address
    // get node list with filter on this ip address
    // if it returns more than 1 object, shut down.
    // another precatuion might be comparing node list on multiple nodes. evaulate in the future
    const localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();
    if (localSocketAddr) {
      const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
      if (!syncStatus.data.synced) {
        setTimeout(() => {
          checkDeterministicNodesCollisions();
        }, 120 * 1000);
        return;
      }
      // Both halves of this check — the node list and our own status — come from the
      // daemon. Without a current answer it would only re-derive the conclusion it
      // reached last time, so there is nothing to gain by running it.
      if (!nodeConfirmationService.isDaemonReachable()) {
        setTimeout(() => {
          checkDeterministicNodesCollisions();
        }, 60 * 1000);
        return;
      }
      const nodeList = await fluxCommunicationUtils.deterministicFluxList();
      const result = nodeList.filter((node) => socketAddressesMatch(node.ip, localSocketAddr));
      const nodeStatus = nodeConfirmationService.getNodeStatus();
      if (nodeStatus) { // different scenario is caught elsewhere
        const myCollateral = nodeStatus.collateral;
        const myNode = result.find((node) => node.collateral === myCollateral);
        const nodeCollateralDifferentIp = nodeList.find((node) => node.collateral === myCollateral && !socketAddressesMatch(node.ip, localSocketAddr));
        if (result.length > 1) {
          log.warn('Multiple Flux Node instances detected');
          if (myNode) {
            const myBlockHeight = myNode.readded_confirmed_height || myNode.confirmed_height; // todo we may want to introduce new readded heights and readded confirmations
            const filterEarlierSame = result.filter((node) => (node.readded_confirmed_height || node.confirmed_height) <= myBlockHeight);
            // keep running only older collaterals
            if (filterEarlierSame.length >= 1) {
              log.error(`Flux earlier collision detection on ip:${localSocketAddr}`);
              nodeDosState.setDosStateValue(100);
              nodeDosState.setDosMessage(`Flux earlier collision detection on ip:${localSocketAddr}`);
              setTimeout(() => {
                checkDeterministicNodesCollisions();
              }, 60 * 1000);
              return;
            }
          }
          // prevent new activation
        } else if (result.length === 1) {
          if (!myNode) {
            log.error('Flux collision detection. Another ip:port is confirmed on flux network with the same collateral transaction information.');
            nodeDosState.setDosStateValue(100);
            nodeDosState.setDosMessage('Flux collision detection. Another ip:port is confirmed on flux network with the same collateral transaction information.');
            setTimeout(() => {
              checkDeterministicNodesCollisions();
            }, 60 * 1000);
            return;
          }
        }
        if (nodeStatus.status === 'CONFIRMED' && nodeCollateralDifferentIp) {
          let errorCall = false;
          const askingIP = extractIp(nodeCollateralDifferentIp.ip);
          const askingIpPort = extractPort(nodeCollateralDifferentIp.ip);
          log.info(`Detected same collateral on different IP: ${askingIP}:${askingIpPort}. Checking if other node is reachable...`);

          // First reachability check
          await serviceHelper.axiosGet(`http://${askingIP}:${askingIpPort}/flux/version`, axiosConfig).catch(() => { errorCall = true; });
          if (!errorCall) {
            // Other node is reachable and confirmed - this is a collision
            log.error(`Flux collision detection. Node at ${askingIP}:${askingIpPort} is confirmed and reachable on flux network with the same collateral transaction information.`);
            nodeDosState.setDosStateValue(100);
            nodeDosState.setDosMessage(`Flux collision detection. Node at ${askingIP}:${askingIpPort} is confirmed and reachable on flux network with the same collateral transaction information.`);
            setTimeout(() => {
              checkDeterministicNodesCollisions();
            }, 60 * 1000);
            return;
          }

          // First check failed - wait 60 seconds before confirming the other node is truly offline
          // This grace period prevents false positives from temporary network issues or node restarts
          log.info(`Other node at ${askingIP}:${askingIpPort} appears unreachable. Waiting 60 seconds to verify before taking over...`);
          errorCall = false;
          await serviceHelper.delay(60 * 1000);

          // Second reachability check after grace period
          await serviceHelper.axiosGet(`http://${askingIP}:${askingIpPort}/flux/version`, axiosConfig).catch(() => { errorCall = true; });
          if (errorCall) {
            // Other node is confirmed offline after grace period - take over the collateral
            log.info(`Other node at ${askingIP}:${askingIpPort} confirmed offline. Creating confirmation transaction to take over collateral...`);
            const daemonResult = await daemonServiceWalletRpcs.createConfirmationTransaction();
            log.info(`node was confirmed on a different machine ip - createConfirmationTransaction: ${JSON.stringify(daemonResult)}`);
            // Clear any previous DOS state related to this collision
            if (nodeDosState.getDosMessage() && nodeDosState.getDosMessage().includes('is confirmed and reachable on flux network')) {
              log.info('Clearing previous collision DOS state - this node has successfully taken over the collateral');
              nodeDosState.setDosStateValue(0);
              nodeDosState.setDosMessage(null);
            }
          } else {
            // Other node came back online during grace period
            log.warn(`Node at ${askingIP}:${askingIpPort} came back online during grace period. Collision still exists.`);
          }
        }
      }
      // If this node is not CONFIRMED, or our current IP isn't in the confirmed
      // list (e.g. IP recently changed), remote nodes will reject the availability
      // check via the confirmed-list gate in isFluxAvailable. Skip to avoid
      // spamming the network with requests that will always fail.
      const isConfirmed = nodeStatus?.status === 'CONFIRMED';
      const inConfirmedList = await fluxCommunicationUtils.socketAddressInFluxList(localSocketAddr);
      if (!isConfirmed || !inConfirmedList) {
        const reason = !isConfirmed
          ? `Node status is ${nodeStatus?.status}`
          : `Our IP ${localSocketAddr} is not in the confirmed flux list`;
        log.warn(`${reason}. Skipping remote availability check.`);
        setTimeout(() => {
          checkDeterministicNodesCollisions();
        }, 60 * 1000);
        return;
      }
      // early stages of the network or testnet
      if (nodeList.length > config.fluxapps.minIncoming + config.fluxapps.minOutgoing) {
        await checkMyFluxAvailability();
      } else { // sufficient amount of nodes has to appear on the network within 6 hours
        const measuredUptime = fluxNetworkHelper.fluxUptime();
        if (measuredUptime.status === 'success' && measuredUptime.data > (config.fluxapps.minUpTime * 12)) {
          await checkMyFluxAvailability();
        } else if (measuredUptime.status === 'error') {
          log.error('Flux uptime unavailable');
          await checkMyFluxAvailability();
        }
      }
    } else {
      nodeDosState.addDosState(1);
      if (nodeDosState.getDosStateValue() > 10) {
        nodeDosState.setDosMessage(nodeDosState.getRawDosMessage() || 'Flux IP detection failed');
        log.error(nodeDosState.getRawDosMessage());
      } else {
        const measuredUptime = fluxNetworkHelper.fluxUptime();
        if (measuredUptime.status === 'success' && measuredUptime.data > (config.fluxapps.minUpTime)) {
          const benchIpResponse = await benchmarkService.getPublicIp();
          if (benchIpResponse.status === 'success') {
            log.info(`FluxBench was previoulsy without ip and now reported public IP: ${benchIpResponse.data}`);
            const benchMyIP = benchIpResponse.data.length > 5 ? benchIpResponse.data : null;
            if (benchMyIP) {
              daemonServiceUtils.setStandardCache('getbenchmarks[]', null);
            }
          }
        }
      }
    }
    setTimeout(() => {
      checkDeterministicNodesCollisions();
    }, 60 * 1000);
  } catch (error) {
    log.error(error);
    setTimeout(() => {
      checkDeterministicNodesCollisions();
    }, 120 * 1000);
  }
}

module.exports = {
  ipChangesOverLimit,
  getMaxNumberOfIpChanges,
  adjustExternalIP,
  checkMyFluxAvailability,
  checkDeterministicNodesCollisions,
};
