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
const daemonServiceFluxnodeRpcs = require('./daemonService/daemonServiceFluxnodeRpcs');
const daemonServiceWalletRpcs = require('./daemonService/daemonServiceWalletRpcs');
const daemonServiceUtils = require('./daemonService/daemonServiceUtils');
const cacheManager = require('./utils/cacheManager').default;
const {
  normalizeSocketAddress, extractIp, extractPort, socketAddressesMatch, ipsMatch,
} = require('./utils/socketAddressUtils');
// App-lifecycle dependencies. This service sits above both the network
// primitives (fluxNetworkHelper) and app-lifecycle, so it requires the
// orchestrators directly at the top level.
const appQueryService = require('./appQuery/appQueryService');
const appUninstaller = require('./appLifecycle/appUninstaller');
const registryManager = require('./appDatabase/registryManager');
const { resolveSpec } = require('./utils/specCutover');

const myCache = cacheManager.ipCache;

// IP-change monitoring state.
let ipChangeData = null;
let dosTooManyIpChanges = false;
let maxNumberOfIpChanges = 0;

// Fired once, with the apps that survived an address change, after the node's
// public IP has moved. serviceManager wires it to appReconciler.requestRestartOf.
let onAddressChanged = null;

function setOnAddressChanged(callback) {
  onAddressChanged = callback;
}

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
    // Everything below needs to know which node this is: whose registration among
    // the ones found at the new address is our own, which apps are ours to hand
    // over, and what address the fluxipchanged broadcast is moving FROM.
    // localSocketAddress is cleared whenever benchmark hiccups, and a comparison
    // against nothing matches nothing - so acting here would read our own rows as
    // strangers' and uninstall the apps they belong to.
    //
    // Return BEFORE the last-known-IP write (the operator's config file until this
    // commit, the local database now), which is what makes this a deferral rather
    // than a silent drop: the write is what marks the change handled, so leaving it
    // unwritten leaves the change pending. checkMyFluxAvailability
    // already refuses to run while the address is unknown, so nothing reaches here
    // again until benchmark answers - and then this runs with the node knowing
    // itself, exactly once, as designed.
    if (!fluxNetworkHelper.getCachedLocalSocketAddress()) {
      log.warn(`adjustExternalIP - own address unknown, deferring the change to ${ip} until benchmark answers`);
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
        // The apps still installed once the loop has removed the ones that cannot
        // stay. Handed to whoever registered for an address change; nothing here
        // knows what bringing them back involves.
        const staying = [];
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
          // An instance at this address means the ports are taken and this node
          // cannot run the app: one instance per IP is enforced by the host port
          // mapping, so a UPnP sibling on another port holds them just as surely
          // as a node that owns the address alone. That is why the address is
          // compared at IP granularity.
          //
          // The node's OWN registration is not that. It stores its own running-app
          // row locally, at the address benchmark reports, so the row sitting at
          // this address is most often itself - and removing on that is a node
          // deleting an app that is exactly where it belongs, then telling the
          // network it is gone. Own-ness is the full socket address, which is what
          // separates it from the sibling that shares only the IP.
          const duplicateInstance = runningAppList.find(
            (instance) => ipsMatch(instance.ip, ip) && !socketAddressesMatch(instance.ip, fluxNetworkHelper.getCachedLocalSocketAddress()),
          );
          if (duplicateInstance) {
            log.info(`Aplication: ${app.name}, was found on the network already running under the same ip, uninstalling app`);
            log.warn(`REMOVAL REASON: Duplicate IP detected - ${app.name} already running on network with IP ${ip} (after IP change)`);
            // eslint-disable-next-line no-await-in-loop
            await appUninstaller.uninstallApplication(app.name, { forceKill: true, skipGuard: true, broadcastRemoval: true }).catch((error) => log.error(error));
            appsRemoved += 1;
          } else {
            staying.push(app);
          }
        }
        // One handover for the whole set, not a call per app: what an app is made
        // of - a composed one's containers are `<component>_<app>`, and an
        // enterprise one's names are inside a blob this layer cannot read - is
        // knowledge the reconciler already holds. Failures stay inside it too, so
        // one app that cannot be asked costs the others nothing and leaves the
        // broadcast, the confirmation transaction and the geolocation update below
        // reachable.
        if (staying.length && onAddressChanged) {
          await onAddressChanged(staying, `node ip changed to ${ip}`)
            .catch((error) => log.error(`adjustExternalIP - restart request failed: ${error.message}`));
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

  // An external observer. This asks a peer whether it can reach US, and a Flux
  // node sharing our public address cannot answer: reaching us means leaving the
  // router and being sent straight back in, which most consumer routers do not
  // do. Asking one produced a false "unreachable" and two points of dosState,
  // on exactly the shared-address topology this release is about.
  const randomSocketAddress = await networkStateService.getRandomExternalObserver(
    fluxNetworkHelper.getCachedLocalSocketAddress(),
  );

  // Nobody outside this address to ask, so nothing is learned and nothing is
  // concluded - dosState is deliberately untouched here, unlike every failure
  // path below it. The next cycle asks again.
  if (!randomSocketAddress) {
    log.warn('checkMyFluxAvailability - no Flux node outside this address could be asked; skipping this pass');
    return false;
  }

  const remoteIp = extractIp(randomSocketAddress);
  const remotePort = extractPort(randomSocketAddress);

  const axiosConfig = {
    timeout: 7000,
  };

  const localIp = extractIp(fluxNetworkHelper.getCachedLocalSocketAddress());
  const localApiPort = extractPort(fluxNetworkHelper.getCachedLocalSocketAddress());

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
    const found = await fluxCommunicationUtils.getFluxnodeFromFluxList(fluxNetworkHelper.getCachedLocalSocketAddress());
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
      // Same shape as the daemon check above, for the same reason. The list
      // accessors wait for the list to arrive, and this loop only re-arms once
      // it has finished - so awaiting in here would retire it for the life of
      // the process rather than delay it, and this is the only thing that ever
      // clears this node's DOS state. Reading an unknown list instead is no
      // better: it makes every branch below conclude this node is not in the
      // confirmed list, log that as the reason, and skip the availability check
      // that would have cleared the DOS.
      if (!networkStateService.isReady()) {
        setTimeout(() => {
          checkDeterministicNodesCollisions();
        }, 120 * 1000);
        return;
      }
      const nodeList = await fluxCommunicationUtils.deterministicFluxList();
      const result = nodeList.filter((node) => socketAddressesMatch(node.ip, localSocketAddr));
      const nodeStatus = await daemonServiceFluxnodeRpcs.getFluxNodeStatus();
      if (nodeStatus.status === 'success') { // different scenario is caught elsewhere
        const myCollateral = nodeStatus.data.collateral;
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
        if (nodeStatus.data.status === 'CONFIRMED' && nodeCollateralDifferentIp) {
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
      const isConfirmed = nodeStatus.data?.status === 'CONFIRMED';
      const inConfirmedList = await fluxCommunicationUtils.socketAddressInFluxList(localSocketAddr);
      if (!isConfirmed || !inConfirmedList) {
        const reason = !isConfirmed
          ? `Node status is ${nodeStatus.data?.status}`
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
  setOnAddressChanged,
  ipChangesOverLimit,
  getMaxNumberOfIpChanges,
  adjustExternalIP,
  checkMyFluxAvailability,
  checkDeterministicNodesCollisions,
};
