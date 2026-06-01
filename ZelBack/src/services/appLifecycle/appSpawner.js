// App Spawner - Handles automatic spawning of global applications
const config = require('config');
const serviceHelper = require('../serviceHelper');
const generalService = require('../generalService');
const benchmarkService = require('../benchmarkService');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const nodeDosState = require('../nodeDosState');
const geolocationService = require('../geolocationService');
const daemonServiceMiscRpcs = require('../daemonService/daemonServiceMiscRpcs');
const log = require('../../lib/log');
const { normalizeSocketAddress, extractIp, extractPort, socketAddressesMatch } = require('../utils/socketAddressUtils');

// Import modular services
const appQueryService = require('../appQuery/appQueryService');
const registryManager = require('../appDatabase/registryManager');
const appsRepository = require('../appDatabase/appsRepository');
const imageManager = require('../appSecurity/imageManager');
const hwRequirements = require('../appRequirements/hwRequirements');
const portManager = require('../appNetwork/portManager');
const { getSpecBackend } = require('../utils/specLibs');
const { appsFolder } = require('../utils/appConstants');
const globalState = require('../utils/globalState');
const enterpriseNetwork = require('../utils/enterpriseNetwork');
const { FluxCacheManager } = require('../utils/cacheManager');
const appInstaller = require('./appInstaller');
const appUninstaller = require('./appUninstaller');
const { appSyncEvents, EVENTS: SYNC_EVENTS } = require('../utils/appSyncEvents');
const fluxEventBus = require('../utils/fluxEventBus');

let appsCountAvailableToInstallOnMyNode = 0;

const collisionWaitMs = config.fluxapps.installCollisionWaitMs;
const spawnReconfirmDelayMs = config.fluxapps.spawnReconfirmDelayMs;
const unencryptedSpawnDelayMs = config.fluxapps.unencryptedSpawnDelayMs ?? 2 * 60 * 1000;

let spawnLoopRunning = false;

function initialize() {
  appSyncEvents.on(SYNC_EVENTS.SPAWNER_READY, () => {
    log.info('AppSyncOrchestrator signals ready, starting spawn loop');
    globalState.spawnerPaused = false;
    fluxEventBus.publish('spawner:resumed', {});
    if (!spawnLoopRunning) {
      spawnLoop();
    }
  });
  appSyncEvents.on(SYNC_EVENTS.READINESS_LOST, () => {
    log.warn('AppSyncOrchestrator signals readiness lost, spawner will pause on next iteration');
    globalState.spawnerPaused = true;
    fluxEventBus.publish('spawner:paused', {});
  });
}

async function spawnLoop() {
  spawnLoopRunning = true;
  try {
    while (!globalState.spawnerPaused) {
      const delayMs = await trySpawningGlobalApplication();
      if (delayMs > 0) await serviceHelper.delay(delayMs);
    }
  } finally {
    spawnLoopRunning = false;
    log.info('Spawn loop exited (paused)');
  }
}

// Note: Docker Hub error classification and caching is now handled by imageManager.js
// which uses structured error metadata from imageVerifier.js for accurate classification
// This spawner cache serves as an additional layer to prevent repeated spawn attempts

/**
 * Try spawning a global application that needs more instances
 * This is the main function that continuously checks for applications that need more instances
 * and attempts to spawn them on this node if it meets the requirements
 * @returns {Promise<void>}
 */
async function trySpawningGlobalApplication() {
  const installDelay = config.fluxapps.installation.delay * 1000;
  const isEnterpriseNode = enterpriseNetwork.getCachedEnterpriseIdentity();
  if (isEnterpriseNode === null) {
    log.info('Flux enterprise identity not yet resolved');
    fluxEventBus.publish('spawner:blocked', { reason: 'enterprise_unresolved' });
    return installDelay;
  }
  let { shortDelayTime, delayTime } = enterpriseNetwork.getSpawnDelays(isEnterpriseNode, 0);
  let appHash = null;
  try {
    const synced = await generalService.checkSynced();
    if (synced !== true) {
      log.info('Flux not yet synced');
      fluxEventBus.publish('spawner:blocked', { reason: 'not_synced' });
      return installDelay;
    }

    if (!globalState.dbReady) {
      log.info('DB not yet ready, waiting for orchestrator');
      fluxEventBus.publish('spawner:blocked', { reason: 'db_not_ready' });
      return installDelay;
    }

    if (nodeDosState.isNodeDos()) {
      log.info('Node is in DOS state. Global applications will not be installed');
      fluxEventBus.publish('spawner:blocked', { reason: 'dos' });
      return installDelay;
    }

    let isNodeConfirmed = false;
    isNodeConfirmed = await generalService.isNodeStatusConfirmed().catch(() => null);
    if (!isNodeConfirmed) {
      log.info('Flux Node not Confirmed. Global applications will not be installed');
      fluxEventBus.publish('spawner:blocked', { reason: 'not_confirmed' });
      globalState.fluxNodeWasNotConfirmedOnLastCheck = true;
      return installDelay;
    }

    if (globalState.firstExecutionAfterItsSynced === true) {
      log.info('Explorer Synced, checking for expired apps');
      await registryManager.expireGlobalApplications();
      globalState.firstExecutionAfterItsSynced = false;
    }

    if (globalState.fluxNodeWasAlreadyConfirmed && globalState.fluxNodeWasNotConfirmedOnLastCheck) {
      globalState.fluxNodeWasNotConfirmedOnLastCheck = false;
      return spawnReconfirmDelayMs;
    }
    globalState.fluxNodeWasAlreadyConfirmed = true;

    const benchmarkResponse = await benchmarkService.getBenchmarks();
    if (benchmarkResponse.status === 'error') {
      log.info('FluxBench status Error. Global applications will not be installed');
      return installDelay;
    }
    // get my external IP and check that it is longer than 5 in length.
    let localSocketAddr = null;
    if (benchmarkResponse.data.ipaddress) {
      log.info(`Gathered IP ${benchmarkResponse.data.ipaddress}`);
      localSocketAddr = benchmarkResponse.data.ipaddress.length > 5 ? normalizeSocketAddress(benchmarkResponse.data.ipaddress) : null;
    }
    if (localSocketAddr === null) {
      throw new Error('Unable to detect Flux IP address');
    }

    const runningApps = await appQueryService.listRunningApps();
    if (runningApps.status !== 'success') {
      throw new Error('trySpawningGlobalApplication - Unable to check running apps on this Flux');
    }
    if (runningApps.data.length >= config.fluxapps.maxAppsPerNode) {
      log.info(`trySpawningGlobalApplication - Node at max apps capacity (${runningApps.data.length}/${config.fluxapps.maxAppsPerNode})`);
      return delayTime;
    }

    const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
    const currentHeight = syncStatus.data.height;
    const nowSeconds = Math.floor(Date.now() / 1000);

    log.info('trySpawningGlobalApplication - Checking for apps that are missing instances on the network.');
    let globalAppNamesLocation = await appsRepository.findUnderProvisionedApps(currentHeight, nowSeconds);
    const numberOfGlobalApps = globalAppNamesLocation.length;
    if (!numberOfGlobalApps) {
      log.info('trySpawningGlobalApplication - No installable application found');
      return delayTime;
    }
    log.info(`trySpawningGlobalApplication - Found ${numberOfGlobalApps} apps that are missing instances on the network.`);

    let appToRun = null;
    let selectedCandidate = null;
    let minInstances = null;
    let appFromAppsToBeCheckedLater = false;
    let appFromAppsSyncthingToBeCheckedLater = false;
    const { appsToBeCheckedLater, appsSyncthingToBeCheckedLater } = globalState;

    const collateral = await generalService.obtainNodeCollateralInformation();
    const nodeOutpoint = `${collateral.txhash}:${collateral.txindex}`;
    const nodeOperator = fluxNetworkHelper.getFluxNodePublicKey();
    const targetInfo = {
      ip: localSocketAddr,
      outpoint: nodeOutpoint,
      operator: typeof nodeOperator === 'string' ? nodeOperator : undefined,
      ipMatcher: socketAddressesMatch,
    };
    const appIndex = appsToBeCheckedLater.findIndex((app) => app.timeToCheck <= Date.now());
    const appSyncthingIndex = appsSyncthingToBeCheckedLater.findIndex((app) => app.timeToCheck <= Date.now());
    let runningAppList = [];
    let installingAppList = [];

    if (appIndex >= 0) {
      appToRun = appsToBeCheckedLater[appIndex].appName;
      appHash = appsToBeCheckedLater[appIndex].hash;
      minInstances = appsToBeCheckedLater[appIndex].required;
      appsToBeCheckedLater.splice(appIndex, 1);
      appFromAppsToBeCheckedLater = true;
      appsCountAvailableToInstallOnMyNode = Math.max(0, appsCountAvailableToInstallOnMyNode - 1);
    } else if (appSyncthingIndex >= 0) {
      appToRun = appsSyncthingToBeCheckedLater[appSyncthingIndex].appName;
      appHash = appsSyncthingToBeCheckedLater[appSyncthingIndex].hash;
      minInstances = appsSyncthingToBeCheckedLater[appSyncthingIndex].required;
      appsSyncthingToBeCheckedLater.splice(appSyncthingIndex, 1);
      appFromAppsSyncthingToBeCheckedLater = true;
      appsCountAvailableToInstallOnMyNode = Math.max(0, appsCountAvailableToInstallOnMyNode - 1);
    } else {
      const nodeGeo = await geolocationService.getNodeGeolocation();
      const nodeInfo = {
        hasStaticIp: geolocationService.isStaticIP(),
        isDataCenter: geolocationService.isDataCenter(),
        location: nodeGeo ? {
          continent: nodeGeo.continentCode,
          country: nodeGeo.countryCode,
          region: nodeGeo.regionName,
        } : undefined,
      };
      globalAppNamesLocation = globalAppNamesLocation.filter((c) => !runningApps.data.find((appsRunning) => appsRunning.Names[0].slice(5) === c.instantiated.name)
        && !globalState.spawnErrorsLongerAppCache.has(c.instantiated.hash)
        && !globalState.trySpawningGlobalAppCache.has(c.instantiated.hash)
        && !appsToBeCheckedLater.some((appAux) => appAux.appName === c.instantiated.name));
      globalAppNamesLocation = globalAppNamesLocation.filter((c) => c.instantiated.spec.placement.matches(nodeInfo));
      globalAppNamesLocation = globalAppNamesLocation.filter((c) => {
        const owner = c.instantiated.owner;
        const isEnterpriseOwner = enterpriseNetwork.isEnterpriseAppOwner(owner);
        const eligible = isEnterpriseNode ? isEnterpriseOwner : !isEnterpriseOwner;
        return eligible;
      });
      // Enterprise-owned apps that pin nodes (IP / outpoint / operator targets) are strict:
      // only a matching node may install them, regardless of version. Carries the legacy
      // app.nodes enforcement forward into the v9 placement model.
      globalAppNamesLocation = globalAppNamesLocation.filter((c) => {
        const { placement } = c.instantiated.spec;
        if (placement.hasTargets() && enterpriseNetwork.isEnterpriseAppOwner(c.instantiated.owner)) {
          return placement.matchesTarget({
            ip: localSocketAddr,
            ipMatcher: socketAddressesMatch,
            outpoint: nodeOutpoint,
            operator: nodeOperator,
          });
        }
        return true;
      });

      appsCountAvailableToInstallOnMyNode = globalAppNamesLocation.length + appsSyncthingToBeCheckedLater.length + appsToBeCheckedLater.length;
      ({ shortDelayTime, delayTime } = enterpriseNetwork.getSpawnDelays(isEnterpriseNode, appsCountAvailableToInstallOnMyNode));

      if (globalAppNamesLocation.length === 0) {
        log.info('trySpawningGlobalApplication - No app currently to be processed');
        return delayTime;
      }
      log.info(`trySpawningGlobalApplication - Found ${globalAppNamesLocation.length} apps that are missing instances on the network and can be selected to try to spawn on my node.`);

      const ipTargeted = globalAppNamesLocation.filter((c) => c.instantiated.spec.placement.targetIps.length > 0
        && c.instantiated.spec.placement.matchesTarget({ ip: localSocketAddr, ipMatcher: socketAddressesMatch }));
      const outpointTargeted = globalAppNamesLocation.filter((c) => c.instantiated.spec.placement.targetOutpoints.length > 0
        && c.instantiated.spec.placement.matchesTarget({ outpoint: nodeOutpoint }));
      const operatorTargeted = globalAppNamesLocation.filter((c) => c.instantiated.spec.placement.targetOperators.length > 0
        && c.instantiated.spec.placement.matchesTarget({ operator: nodeOperator }));

      const pool = ipTargeted.length > 0 ? ipTargeted
        : outpointTargeted.length > 0 ? outpointTargeted
        : operatorTargeted.length > 0 ? operatorTargeted
        : globalAppNamesLocation;

      selectedCandidate = pool[Math.floor(Math.random() * pool.length)];

      appToRun = selectedCandidate.instantiated.name;
      appHash = selectedCandidate.instantiated.hash;
      minInstances = selectedCandidate.required;

      log.info(`trySpawningGlobalApplication - Application ${appToRun} selected to try to spawn. Reported as been running in ${selectedCandidate.actual} instances and ${selectedCandidate.required} are required.`);
      runningAppList = await registryManager.appLocation(appToRun);
      installingAppList = await registryManager.appInstallingLocation(appToRun);
      if (runningAppList.length + installingAppList.length > minInstances) {
        log.info(`trySpawningGlobalApplication - Application ${appToRun} is already spawned or being installed on ${runningAppList.length + installingAppList.length} instances.`);
        return shortDelayTime;
      }
      const isArcane = Boolean(process.env.FLUXOS_PATH);
      if (selectedCandidate.instantiated.isEncrypted && !isArcane) {
        log.info(`trySpawningGlobalApplication - Application ${appToRun} is encrypted, can only install on ArcaneOS`);
        globalState.spawnErrorsLongerAppCache.set(appHash, '');
        return shortDelayTime;
      }
    }

    globalState.trySpawningGlobalAppCache.set(appHash, '');
    log.info(`trySpawningGlobalApplication - App ${appToRun} hash: ${appHash}`);

    // TODO: re-enable once error classification (transient vs permanent) is implemented.
    // Without classification, transient infra errors suppress healthy apps network-wide.
    const errorCount = await registryManager.countAppInstallingErrors(appHash);
    if (errorCount >= 5) {
      log.warn(`trySpawningGlobalApplication - App ${appToRun} hash ${appHash} has ${errorCount} network-wide install failures (not blocking)`);
      fluxEventBus.publish('spawner:networkErrorSkip', { appName: appToRun, hash: appHash, errorCount });
    }

    runningAppList = await registryManager.appLocation(appToRun);

    const adjustedIP = extractIp(localSocketAddr); // just IP address
    // check if app not running on this device
    if (runningAppList.find((document) => document.ip.includes(adjustedIP))) {
      log.info(`trySpawningGlobalApplication - Application ${appToRun} is reported as already running on this Flux IP`);
      return delayTime;
    }
    if (installingAppList.find((document) => document.ip.includes(adjustedIP))) {
      log.info(`trySpawningGlobalApplication - Application ${appToRun} is reported as already being installed on this Flux IP`);
      return delayTime;
    }

    const instantiated = selectedCandidate
      ? selectedCandidate.instantiated
      : await appsRepository.getGlobalAppInfo(appToRun);
    if (!instantiated) {
      throw new Error(`trySpawningGlobalApplication - Specifications for application ${appToRun} were not found!`);
    }

    if (await appsRepository.existsInstalledApp(instantiated.name)) {
      log.info(`trySpawningGlobalApplication - Application ${instantiated.name} is already installed`);
      return shortDelayTime;
    }

    let spec = instantiated.spec;
    if (instantiated.isEncrypted) {
      const provider = await spec.createProvider();
      spec = (await spec.decrypt(provider)).spec;
    }
    const { DeploymentSpec } = await getSpecBackend();
    const deployment = DeploymentSpec.fromSpec(spec, appsFolder);
    const appPorts = deployment.allHostPorts();

    const appIsVetted = await imageManager.isAppVetted({ owner: instantiated.owner, hash: instantiated.hash, images: deployment.allImages() });
    if (!appIsVetted) {
      // eslint-disable-next-line no-restricted-syntax
      for (let i = 0; i < appPorts.length; i += 1) {
        const port = appPorts[i];
        const isUserBlocked = fluxNetworkHelper.isPortUserBlocked(port);
        if (isUserBlocked) {
          log.info(`trySpawningGlobalApplication - App ${instantiated.name} uses user-blocked port ${port}. Adding to error cache.`);
          globalState.spawnErrorsLongerAppCache.set(appHash, '');
          // eslint-disable-next-line no-await-in-loop
          return shortDelayTime;
        }
      }
    } else {
      log.info(`trySpawningGlobalApplication - App ${instantiated.name} is vetted. Bypassing user-blocked ports check.`);
    }

    // verify app compliance
    const blockResult = await imageManager.isImageBlocked(instantiated.name, deployment.allImages(), { owner: instantiated.owner, hash: instantiated.hash });
    if (blockResult.blocked) {
      globalState.spawnErrorsLongerAppCache.set(appHash, '');
      throw new Error(blockResult.reason);
    }

    await hwRequirements.checkNodeResources(deployment);
    if (isEnterpriseNode) {
      await hwRequirements.checkCpuBurstHeadroom(deployment);
    }

    // ensure ports unused
    // Get apps running specifically on this IP
    const localSocketAddrAddress = extractIp(localSocketAddr); // just IP address without port
    const runningAppsOnThisIP = await registryManager.getRunningAppIpList(localSocketAddrAddress);
    const runningAppsNames = runningAppsOnThisIP.map((app) => app.name);

    await portManager.ensureApplicationPortsNotUsed(deployment, runningAppsNames);

    // Note: User-blocked port check happens earlier (line ~353) before Docker Hub calls
    // Check if ports are publicly available - critical for proper Flux network operation
    const portsPubliclyAvailable = await portManager.checkInstallingAppPortAvailable(appPorts);
    if (portsPubliclyAvailable === false) {
      log.error(`trySpawningGlobalApplication - Some of application ports of ${instantiated.name} are not available publicly. Installation aborted.`);
      return shortDelayTime;
    }

    // double check if app is installed on the number of instances requested
    runningAppList = await registryManager.appLocation(appToRun);
    installingAppList = await registryManager.appInstallingLocation(appToRun);
    if (runningAppList.length + installingAppList.length > minInstances) {
      log.info(`trySpawningGlobalApplication - Application ${appToRun} is already spawned or being installed on ${runningAppList.length + installingAppList.length} instances.`);
      return shortDelayTime;
    }

    const syncthingApp = spec.hasSyncthing();

    const localIp = extractIp(localSocketAddr);
    const lastIndex = localIp.lastIndexOf('.');
    const secondLastIndex = localIp.substring(0, lastIndex).lastIndexOf('.');
    const ipPrefix = localIp.substring(0, secondLastIndex + 1); // includes the '.' e.g. "192.168."

    if (syncthingApp) {
      let sameIpRangeNode = runningAppList.find((location) => location.ip.startsWith(ipPrefix));
      if (sameIpRangeNode) {
        log.info(`trySpawningGlobalApplication - Application ${appToRun} uses syncthing and it is already spawned on Fluxnode with same ip range`);
        return shortDelayTime;
      }
      sameIpRangeNode = installingAppList.find((location) => location.ip.startsWith(ipPrefix));
      if (sameIpRangeNode) {
        log.info(`trySpawningGlobalApplication - Application ${appToRun} uses syncthing and it is already being installed on Fluxnode with same ip range`);
        return shortDelayTime;
      }
      if (!appFromAppsToBeCheckedLater && !appFromAppsSyncthingToBeCheckedLater && runningAppList.length < 6) {
        // check if there are connectivity to all nodes
        // eslint-disable-next-line no-restricted-syntax
        for (const node of runningAppList) {
          const ip = extractIp(node.ip);
          const port = extractPort(node.ip);
          // eslint-disable-next-line no-await-in-loop
          const isOpen = await fluxNetworkHelper.isPortOpen(ip, port);
          if (!isOpen) {
            log.info(`trySpawningGlobalApplication - Application ${appToRun} uses syncthing and instance running on ${ip}:${port} is not reachable, possible conenctivity issue, will be installed in 27m if remaining missing instances`);
            const appToCheck = {
              timeToCheck: Date.now() + 0.45 * 60 * 60 * 1000,
              appName: appToRun,
              hash: appHash,
              required: minInstances,
            };
            globalState.appsSyncthingToBeCheckedLater.push(appToCheck);
            globalState.trySpawningGlobalAppCache.delete(appHash);
            return shortDelayTime;
          }
        }
        // eslint-disable-next-line no-restricted-syntax
        for (const node of installingAppList) {
          const ip = extractIp(node.ip);
          const port = extractPort(node.ip);
          // eslint-disable-next-line no-await-in-loop
          const isOpen = await fluxNetworkHelper.isPortOpen(ip, port);
          if (!isOpen) {
            log.info(`trySpawningGlobalApplication - Application ${appToRun} uses syncthing and instance being installed on ${ip}:${port} is not reachable, possible conenctivity issue, will be installed in 27m if remaining missing instances`);
            const appToCheck = {
              timeToCheck: Date.now() + 0.45 * 60 * 60 * 1000,
              appName: appToRun,
              hash: appHash,
              required: minInstances,
            };
            globalState.appsSyncthingToBeCheckedLater.push(appToCheck);
            globalState.trySpawningGlobalAppCache.delete(appHash);
            return shortDelayTime;
          }
        }
      }
    }

    const specPlacement = spec.placement;
    const isEncryptedApp = instantiated.isEncrypted;

    if (!appFromAppsToBeCheckedLater && !appFromAppsSyncthingToBeCheckedLater
      && specPlacement.hasTargets() && !specPlacement.matchesTarget(targetInfo)) {
      const deferral = config.fluxapps.spawnDeferrals.targetedNodesMs;
      const delayMs = isEncryptedApp ? deferral.encrypted : deferral.standard;
      const appToCheck = {
        timeToCheck: Date.now() + delayMs,
        appName: appToRun,
        hash: appHash,
        required: minInstances,
      };
      log.info(`trySpawningGlobalApplication - App ${appToRun} has targets that don't match this node, will check in around ${Math.round(delayMs / 60000)}m if instances are still missing`);
      globalState.appsToBeCheckedLater.push(appToCheck);
      globalState.trySpawningGlobalAppCache.delete(appHash);
      fluxEventBus.publish('spawner:deferred', { appName: appToRun, reason: 'targeted_nodes', delayMs });
      return shortDelayTime;
    }

    if (!isEnterpriseNode && !appFromAppsToBeCheckedLater && !appFromAppsSyncthingToBeCheckedLater) {
      const tier = await generalService.nodeTier();
      const appHWrequirements = deployment.totalResources();
      let delay = false;
      const isArcane = Boolean(process.env.FLUXOS_PATH);
      if (!isEncryptedApp && isArcane) {
        const appToCheck = {
          timeToCheck: Date.now() + unencryptedSpawnDelayMs,
          appName: appToRun,
          hash: appHash,
          required: minInstances,
        };
        log.info(`trySpawningGlobalApplication - App ${appToRun} not encrypted, will check in around ${Math.round(unencryptedSpawnDelayMs / 1000)}s if instances are still missing`);
        globalState.appsToBeCheckedLater.push(appToCheck);
        globalState.trySpawningGlobalAppCache.delete(appHash);
        fluxEventBus.publish('spawner:deferred', { appName: appToRun, reason: 'unencrypted_on_arcane', delayMs: unencryptedSpawnDelayMs });
        delay = true;
      } else if (!specPlacement.staticIp && geolocationService.isStaticIP()) {
        const deferral = config.fluxapps.spawnDeferrals.staticIpMs;
        const delayMs = isEncryptedApp ? deferral.encrypted : deferral.standard;
        const appToCheck = {
          timeToCheck: Date.now() + delayMs,
          appName: appToRun,
          hash: appHash,
          required: minInstances,
        };
        log.info(`trySpawningGlobalApplication - App ${appToRun} does not require static IP but node has static IP, will check in around ${Math.round(delayMs / 60000)}m if instances are still missing`);
        globalState.appsToBeCheckedLater.push(appToCheck);
        globalState.trySpawningGlobalAppCache.delete(appHash);
        fluxEventBus.publish('spawner:deferred', { appName: appToRun, reason: 'static_ip', delayMs });
        delay = true;
      } else if (!specPlacement.dataCenter && geolocationService.isDataCenter()) {
        const deferral = config.fluxapps.spawnDeferrals.datacenterMs;
        const delayMs = isEncryptedApp ? deferral.encrypted : deferral.standard;
        const appToCheck = {
          timeToCheck: Date.now() + delayMs,
          appName: appToRun,
          hash: appHash,
          required: minInstances,
        };
        log.info(`trySpawningGlobalApplication - App ${appToRun} does not require datacenter but node is datacenter, will check in around ${Math.round(delayMs / 60000)}m if instances are still missing`);
        globalState.appsToBeCheckedLater.push(appToCheck);
        globalState.trySpawningGlobalAppCache.delete(appHash);
        fluxEventBus.publish('spawner:deferred', { appName: appToRun, reason: 'datacenter', delayMs });
        delay = true;
      } else if (specPlacement.matchesTarget(targetInfo)) {
        log.info(`trySpawningGlobalApplication - App ${appToRun} targets this node`);
      } else if (!specPlacement.hasTargets() && tier === 'bamf' && appHWrequirements.cpu < 3 && appHWrequirements.memory < 6000 && appHWrequirements.storage < 150) {
        const deferral = config.fluxapps.spawnDeferrals.capacityGap.largeMs;
        const delayMs = isEncryptedApp ? deferral.encrypted : deferral.standard;
        const appToCheck = {
          timeToCheck: Date.now() + delayMs,
          appName: appToRun,
          hash: appHash,
          required: minInstances,
        };
        log.info(`trySpawningGlobalApplication - App ${appToRun} specs are from cumulus, will check in around ${Math.round(delayMs / 60000)}m if instances are still missing`);
        globalState.appsToBeCheckedLater.push(appToCheck);
        globalState.trySpawningGlobalAppCache.delete(appHash);
        fluxEventBus.publish('spawner:deferred', { appName: appToRun, reason: 'capacity_gap_large', delayMs });
        delay = true;
      } else if (!specPlacement.hasTargets() && tier === 'bamf' && appHWrequirements.cpu < 7 && appHWrequirements.memory < 29000 && appHWrequirements.storage < 370) {
        const deferral = config.fluxapps.spawnDeferrals.capacityGap.mediumMs;
        const delayMs = isEncryptedApp ? deferral.encrypted : deferral.standard;
        const appToCheck = {
          timeToCheck: Date.now() + delayMs,
          appName: appToRun,
          hash: appHash,
          required: minInstances,
        };
        log.info(`trySpawningGlobalApplication - App ${appToRun} specs are from nimbus, will check in around ${Math.round(delayMs / 60000)}m if instances are still missing`);
        globalState.appsToBeCheckedLater.push(appToCheck);
        globalState.trySpawningGlobalAppCache.delete(appHash);
        fluxEventBus.publish('spawner:deferred', { appName: appToRun, reason: 'capacity_gap_medium', delayMs });
        delay = true;
      } else if (!specPlacement.hasTargets() && tier === 'super' && appHWrequirements.cpu < 3 && appHWrequirements.memory < 6000 && appHWrequirements.storage < 150) {
        const deferral = config.fluxapps.spawnDeferrals.capacityGap.smallMs;
        const delayMs = isEncryptedApp ? deferral.encrypted : deferral.standard;
        const appToCheck = {
          timeToCheck: Date.now() + delayMs,
          appName: appToRun,
          hash: appHash,
          required: minInstances,
        };
        log.info(`trySpawningGlobalApplication - App ${appToRun} specs are from cumulus, will check in around ${Math.round(delayMs / 60000)}m if instances are still missing`);
        globalState.appsToBeCheckedLater.push(appToCheck);
        globalState.trySpawningGlobalAppCache.delete(appHash);
        fluxEventBus.publish('spawner:deferred', { appName: appToRun, reason: 'capacity_gap_small', delayMs });
        delay = true;
      }
      if (delay) {
        return shortDelayTime;
      }
    }

    // ToDo: Move this to global
    const architecture = await hwRequirements.systemArchitecture();

    for (const [, component] of spec.componentEntries()) {
      // eslint-disable-next-line no-await-in-loop
      await imageManager.verifyRepository(component.image, {
        repoauth: component.imageAuth,
        specVersion: instantiated.version,
        architecture,
        appName: instantiated.name,
      }).catch((error) => {
        // imageManager already handles error classification and caching with intelligent TTLs (1h-7d)
        // Add to spawn cache with 1-hour TTL to allow retry sooner than default 12h
        // This lets temporary Docker Hub issues (network, rate limit) be retried faster
        log.warn(`trySpawningGlobalApplication - Docker Hub verification failed for ${appToRun}: ${error.message}`);
        globalState.trySpawningGlobalAppCache.set(appHash, '', { ttl: FluxCacheManager.oneHour });
        throw error;
      });
    }

    // triple check if app is installed on the number of instances requested
    runningAppList = await registryManager.appLocation(appToRun);
    installingAppList = await registryManager.appInstallingLocation(appToRun);
    if (runningAppList.length + installingAppList.length > minInstances) {
      log.info(`trySpawningGlobalApplication - Application ${appToRun} is already spawned or being installed on ${runningAppList.length + installingAppList.length} instances.`);
      return shortDelayTime;
    }

    // an application was selected and checked that it can run on this node. try to install and run it locally
    // lets broadcast to the network the app is going to be installed on this node, so we don't get lot's of intances installed when it's not needed
    let broadcastedAt = Date.now();
    const newAppInstallingMessage = {
      type: 'fluxappinstalling',
      version: 1,
      name: instantiated.name,
      ip: localSocketAddr,
      broadcastedAt,
    };

    // store it in local database first
    await registryManager.storeAppInstallingMessage(newAppInstallingMessage);
    // broadcast messages about running apps to all peers
    // eslint-disable-next-line global-require
    const fluxCommMessagesSender = require('../fluxCommunicationMessagesSender');
    await fluxCommMessagesSender.broadcastMessageToAll(newAppInstallingMessage);

    await serviceHelper.delay(collisionWaitMs); // give it 1.5m so messages are propagated on the network

    // double check if app is installed in more of the instances requested
    runningAppList = await registryManager.appLocation(appToRun);
    installingAppList = await registryManager.appInstallingLocation(appToRun);
    if (runningAppList.length + installingAppList.length > minInstances) {
      installingAppList.sort((a, b) => {
        if (a.broadcastedAt < b.broadcastedAt) {
          return -1;
        }
        if (a.broadcastedAt > b.broadcastedAt) {
          return 1;
        }
        return 0;
      });
      broadcastedAt = Date.now();
      const index = installingAppList.findIndex((x) => socketAddressesMatch(x.ip, localSocketAddr));
      if (runningAppList.length + index + 1 > minInstances) {
        log.info(`trySpawningGlobalApplication - Application ${appToRun} is already spawned or being installed on ${runningAppList.length + installingAppList.length} instances, my instance is number ${runningAppList.length + index + 1}`);
        return shortDelayTime;
      }
    }

    if (syncthingApp) {
      const sameIpRangeNode = runningAppList.find((location) => location.ip.startsWith(ipPrefix));
      if (sameIpRangeNode) {
        log.info(`trySpawningGlobalApplication - Application ${appToRun} uses syncthing and it is already spawned on Fluxnode with same ip range`);
        return shortDelayTime;
      }
      const sameIpRangeInstallingNodes = installingAppList.filter((location) => location.ip.startsWith(ipPrefix));
      if (sameIpRangeInstallingNodes.length > 0) {
        // Find the node with the oldest broadcastedAt (first to start installing)
        const oldestNode = sameIpRangeInstallingNodes.reduce((oldest, current) => {
          if (!oldest.broadcastedAt) return current;
          if (!current.broadcastedAt) return oldest;
          return current.broadcastedAt < oldest.broadcastedAt ? current : oldest;
        });
        // If our node is not the oldest one, skip - let the first node continue
        if (!socketAddressesMatch(oldestNode.ip, localSocketAddr)) {
          log.info(`trySpawningGlobalApplication - Application ${appToRun} uses syncthing and it is already being installed on Fluxnode with same ip range`);
          return shortDelayTime;
        }
        // Our node is the oldest - we were first, continue with installation
        log.info(`trySpawningGlobalApplication - Application ${appToRun} uses syncthing, we are the first node in ip range to start installing, continuing`);
      }
    }

    // install the app
    let registerOk = false;
    try {
      registerOk = await appInstaller.installApplication(instantiated);
    } catch (error) {
      log.error(error);
      registerOk = false;
    }
    if (!registerOk) {
      log.info(`trySpawningGlobalApplication - Install failed for ${appToRun}, adding to local error cache`);
      globalState.spawnErrorsLongerAppCache.set(appHash, '');
      fluxEventBus.publish('spawner:installFailed', { appName: appToRun, hash: appHash });
      return shortDelayTime;
    }

    await serviceHelper.delay(1 * 60 * 1000); // await 1 minute to give time for messages to be propagated on the network
    // double check if app is installed in more of the instances requested
    runningAppList = await registryManager.appLocation(appToRun);
    if (runningAppList.length > minInstances) {
      runningAppList.sort((a, b) => {
        if (!a.runningSince && b.runningSince) {
          return -1;
        }
        if (a.runningSince && !b.runningSince) {
          return 1;
        }
        if (a.runningSince < b.runningSince) {
          return -1;
        }
        if (a.runningSince > b.runningSince) {
          return 1;
        }
        return 0;
      });
      const index = runningAppList.findIndex((x) => socketAddressesMatch(x.ip, localSocketAddr));
      log.info(`trySpawningGlobalApplication - Application ${appToRun} is already spawned on ${runningAppList.length} instances, my instance is number ${index + 1}`);
      if (index + 1 > minInstances) {
        log.info(`trySpawningGlobalApplication - Application ${appToRun} is going to be removed as already passed the instances required.`);
        log.warn(`REMOVAL REASON: Exceeded required instances - ${instantiated.name} already has sufficient instances, removing local installation (appSpawner)`);
        globalState.trySpawningGlobalAppCache.delete(appHash);
        appUninstaller.uninstallApplication(instantiated.name, { forceKill: true, skipGuard: true, broadcastRemoval: true }).catch((error) => log.error(error));
      }
    }

    log.info('trySpawningGlobalApplication - Reinitiating possible app installation');
    const nextDelay = isEnterpriseNode ? 0 : delayTime;
    return nextDelay;
  } catch (error) {
    log.error(error);
    if (appHash && !globalState.spawnErrorsLongerAppCache.has(appHash) && !globalState.trySpawningGlobalAppCache.has(appHash)) {
      log.info(`trySpawningGlobalApplication - Adding app hash ${appHash} to trySpawningGlobalAppCache due to pre-install error`);
      globalState.trySpawningGlobalAppCache.set(appHash, '', { ttl: FluxCacheManager.oneHour * 6 });
    }
    return shortDelayTime || 5 * 60 * 1000;
  }
}

module.exports = {
  initialize,
  trySpawningGlobalApplication,
};
