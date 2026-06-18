// path is used for dynamic requires in the file
// eslint-disable-next-line no-unused-vars
const path = require('path');
const serviceHelper = require('../serviceHelper');
const verificationHelper = require('../verificationHelper');
const dockerService = require('../dockerService');
const appNetworkLinker = require('./appNetworkLinker');
const dbHelper = require('../dbHelper');
const messageHelper = require('../messageHelper');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const appUninstaller = require('./appUninstaller');
const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');
const { storeAppInstallingErrorMessage } = require('../appMessaging/messageStore');
const { systemArchitecture, checkPlacement, checkNodeResources } = require('../appRequirements/hwRequirements');
const { isImageBlocked, verifyRepository } = require('../appSecurity/imageManager');
const { startAppMonitoring } = require('../appManagement/appInspector');
const imageVerifier = require('../utils/imageVerifier');
// pgpService is used in commented out code
// eslint-disable-next-line no-unused-vars
const pgpService = require('../pgpService');
const registryCredentialHelper = require('../utils/registryCredentialHelper');
const upnpService = require('../upnpService');
const globalState = require('../utils/globalState');
const operationRegistry = require('../utils/operationRegistry');
const cpuBurstHelper = require('../utils/cpuBurstHelper');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const telemetrySinkCache = require('../telemetrySinkCache');
const telemetryIdentityService = require('../telemetryIdentityService');
const telemetryConfigService = require('../telemetryConfigService');
const appVolumeService = require('./appVolumeService');
const appSwapPoolService = require('./appSwapPoolService');
const shutdownPlan = require('./shutdownPlan');
const fluxShutdowndClient = require('../utils/fluxShutdowndClient');
const { getSpecBackend } = require('../utils/specLibs');
const { findCommonArchitectures } = require('../utils/appUtilities');
const log = require('../../lib/log');
const appsRepository = require('../appDatabase/appsRepository');
const { localAppsInformation } = require('../utils/appConstants');
const fluxEventBus = require('../utils/fluxEventBus');
const volumeService = require('../utils/volumeService');
const config = require('config');

/**
 * Outcome of installApplication. Separates a transient deferral (retry later) from a
 * permanent rejection and a real failure, so callers can back off appropriately.
 */
const InstallStatus = Object.freeze({
  INSTALLED: 'installed', // installed and launched
  SKIPPED: 'skipped', // already installed - nothing to do
  DEFERRED: 'deferred', // could not decide / node busy - retry later
  REJECTED: 'rejected', // admission denied for this spec - won't change on retry
  FAILED: 'failed', // install started then errored - local cleanup already done
});

let onInstallComplete = null;
function setOnInstallComplete(callback) {
  onInstallComplete = callback;
}

// Legacy apps that use old gateway IP assignment method
const appsThatMightBeUsingOldGatewayIpAssignment = ['HNSDoH', 'dane', 'fdm', 'Jetpack2', 'fdmdedicated', 'isokosse', 'ChainBraryDApp', 'health', 'ethercalc'];

// Helper functions and constants for installComponent
const util = require('util');

const dockerPullStreamPromise = util.promisify(dockerService.dockerPullStream);

const supportedArchitectures = ['amd64', 'arm64'];

/**
 * Perform Docker cleanup (prune containers, networks, volumes, images)
 * @param {object} res - Response object for streaming
 * @returns {Promise<void>}
 */
async function performDockerCleanup(onStatus) {
  log.info('Clearing up unused docker containers...');
  if (onStatus) onStatus({ status: 'Clearing up unused docker containers...' });
  await dockerService.pruneContainers();
  if (onStatus) onStatus({ status: 'Docker containers cleaned.' });

  log.info('Clearing up unused docker networks...');
  if (onStatus) onStatus({ status: 'Clearing up unused docker networks...' });
  await dockerService.pruneNetworks();
  if (onStatus) onStatus({ status: 'Docker networks cleaned.' });

  log.info('Clearing up unused docker volumes...');
  if (onStatus) onStatus({ status: 'Clearing up unused docker volumes...' });
  await dockerService.pruneVolumes();
  if (onStatus) onStatus({ status: 'Docker volumes cleaned.' });

  log.info('Clearing up unused docker images...');
  if (onStatus) onStatus({ status: 'Clearing up unused docker images...' });
  await dockerService.pruneImages();
  if (onStatus) onStatus({ status: 'Docker images cleaned.' });
}

/**
 * Setup firewall and UPnP ports for application/component
 * @param {object} appSpec - App or component specifications
 * @param {string} appName - Application name
 * @param {boolean} isComponent - Whether this is a component
 * @param {object} res - Response object for streaming
 * @param {boolean} test - Whether this is a test installation (skips port setup if true)
 * @returns {Promise<void>}
 */
async function setupApplicationPorts(comp, appName, isComponent, onStatus, test = false) {
  const label = isComponent ? `Allowing component ${comp.name} of Flux App ${appName} ports...` : `Allowing Flux App ${appName} ports...`;
  log.info(label);
  if (onStatus) onStatus({ status: label });

  const ports = test ? [] : comp.hostPorts();
  if (ports.length === 0) return;

  const firewallActive = await fluxNetworkHelper.isFirewallActive();
  if (firewallActive) {
    for (const port of ports) {
      // eslint-disable-next-line no-await-in-loop
      const portResponse = await fluxNetworkHelper.allowPort(port);
      if (portResponse.status === true) {
        log.info(`Port ${port} OK`);
        if (onStatus) onStatus({ status: `Port ${port} OK` });
      } else {
        throw new Error(`Error: Port ${port} FAILed to open.`);
      }
    }
  } else {
    log.info('Firewall not active, application ports are open');
  }

  const isUPNP = upnpService.isUPNP();
  if (isUPNP) {
    log.info('Custom port specified, mapping ports');
    for (const port of ports) {
      // eslint-disable-next-line no-await-in-loop
      const portResponse = await upnpService.mapUpnpPort(port, `Flux_App_${appName}`);
      if (portResponse === true) {
        log.info(`Port ${port} mapped OK`);
        if (onStatus) onStatus({ status: `Port ${port} mapped OK` });
      } else {
        throw new Error(`Error: Port ${port} FAILed to map.`);
      }
    }
  }
}

/**
 * To register an app locally. Runs the admission checks (resources, image blocklist)
 * before any state is mutated, then registers the app in the database and performs the
 * install. If the install fails after it has started, the app is removed locally.
 * @param {object} instantiated Instantiated app spec.
 * @param {object} [options] onStatus stream callback, test, createVolumes, sendRemovalMessage.
 * @returns {Promise<{status: string, reason: string|null}>} status is an InstallStatus
 *   value: INSTALLED (success), SKIPPED (already installed), DEFERRED (transient - blocklist
 *   unreachable or node busy, retry later), REJECTED (blocked image - won't change on retry),
 *   FAILED (install started then errored; local cleanup already done).
 */
async function installApplication(instantiated, options = {}) {
  const onStatus = options.onStatus || null;
  const test = options.test || false;
  const createVolumes = options.createVolumes !== false;
  const sendRemovalMessage = options.sendRemovalMessage || false;
  const appName = instantiated.name;
  try {
    if (globalState.removalInProgress) {
      log.error('Another application is undergoing removal. Installation not possible.');
      return { status: InstallStatus.DEFERRED, reason: 'Another application is undergoing removal' };
    }
    if (globalState.installationInProgress) {
      log.error('Another application is undergoing installation. Installation not possible');
      return { status: InstallStatus.DEFERRED, reason: 'Another application is undergoing installation' };
    }
    globalState.installationInProgress = true;
    // Dual-write the operation registry alongside the global flag (Stage 1: the
    // flag is still authoritative; nothing reads the registry yet). Released in
    // the finally, mirroring the flag's lifetime.
    operationRegistry.acquire(appName, 'install', 'appInstaller', `install ${appName}`);

    const localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();
    if (!localSocketAddr) {
      throw new Error('Unable to detect Flux IP address');
    }

    log.info('Running initial checks for Flux App...');
    if (onStatus) onStatus({ status: 'Running initial checks for Flux App...' });

    log.info('Connecting to database...');
    if (onStatus) onStatus({ status: 'Connecting to database...' });
    dbHelper.databaseConnection();

    log.info('Checking database...');
    if (onStatus) onStatus({ status: 'Checking database...' });
    if (await appsRepository.existsInstalledApp(appName)) {
      globalState.installationInProgress = false;
      log.error(`Flux App ${appName} already installed`);
      return { status: InstallStatus.SKIPPED, reason: `Flux App ${appName} already installed` };
    }

    await checkPlacement(instantiated);

    const deployment = await deploymentProvider.buildDeployment(instantiated);
    await checkNodeResources(deployment);

    // Admission decision, taken before any state is mutated so neither outcome needs
    // cleanup: a blocked image is a rejection (won't change on retry); an unreachable
    // blocklist is a deferral (transient - retry rather than admit something unchecked).
    const blockResult = await isImageBlocked(appName, deployment.allImages(), { owner: instantiated.owner, hash: instantiated.hash });
    if (blockResult.blocked) {
      globalState.installationInProgress = false;
      if (onStatus) onStatus(messageHelper.createErrorMessage(blockResult.reason));
      return { status: InstallStatus.REJECTED, reason: blockResult.reason };
    }
    if (blockResult.undetermined) {
      globalState.installationInProgress = false;
      const reason = `Image blocklist unreachable - cannot verify ${appName} for installation, will retry`;
      if (onStatus) onStatus(messageHelper.createErrorMessage(reason));
      return { status: InstallStatus.DEFERRED, reason };
    }

    // eslint-disable-next-line global-require
    const appQueryService = require('../appQuery/appQueryService');
    const deployments = await deploymentProvider.listInstalledDeployments();
    const runningAppsRes = await appQueryService.listRunningApps();
    if (runningAppsRes.status !== 'success') {
      throw new Error('Unable to check running Apps');
    }
    const runningApps = runningAppsRes.data;
    const installedAppComponentNames = [];
    deployments.forEach((deployment) => {
      deployment.componentEntries().forEach(([, comp]) => {
        installedAppComponentNames.push(comp.identifier);
      });
    });
    const runningAppsNames = runningApps.map((app) => app.Names[0].slice(5));
    const runningSet = new Set(runningAppsNames);
    const stoppedApps = installedAppComponentNames.filter((installedApp) => !runningSet.has(installedApp));
    if (stoppedApps.length === 0 && !globalState.activeStandbyCoordinationRunning) {
      await performDockerCleanup(onStatus);
    }

    // Verify every app this app shares a network with is installed locally and
    // same-owner before any container is created — aborts early otherwise.
    await appNetworkLinker.checkAppNetworkRequirements(instantiated);

    {
      let dockerNetworkAddrValue = Math.floor(Math.random() * 256);
      if (appsThatMightBeUsingOldGatewayIpAssignment.includes(appName)) {
        dockerNetworkAddrValue = appName.charCodeAt(appName.length - 1);
      }
      log.info(`Checking Flux App network of ${appName}...`);
      if (onStatus) onStatus({ status: `Checking Flux App network of ${appName}...` });
      let fluxNet = null;
      for (let i = 0; i <= 20; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        fluxNet = await dockerService.createFluxAppDockerNetwork(appName, dockerNetworkAddrValue).catch((error) => log.error(error));
        if (fluxNet || appsThatMightBeUsingOldGatewayIpAssignment.includes(appName)) {
          break;
        }
        dockerNetworkAddrValue = Math.floor(Math.random() * 256);
      }
      if (!fluxNet) {
        throw new Error(`Flux App network of ${appName} failed to initiate. Not possible to create docker application network.`);
      }
      log.info(serviceHelper.ensureString(fluxNet));
      const fluxNetworkInterfaces = await dockerService.getFluxDockerNetworkPhysicalInterfaceNames();
      const accessRemoved = await fluxNetworkHelper.removeDockerContainerAccessToNonRoutable(fluxNetworkInterfaces);
      if (onStatus) onStatus({ status: accessRemoved ? `Private network access removed for ${appName}` : `Error removing private network access for ${appName}` });
      if (onStatus) onStatus({ status: `Docker network of ${appName} initiated.` });
    }

    log.info(`Initiating Flux App ${appName} installation...`);
    if (onStatus) onStatus({ status: `Initiating Flux App ${appName} installation...` });

    const dbSpecs = instantiated.serialize();

    if (await appsRepository.existsInstalledApp(appName)) {
      log.warn(`Found existing database entry for ${appName} during registration. Cleaning up stale entry.`);
      await appsRepository.removeInstalledApp(appName);
      log.info(`Stale database entry for ${appName} removed. Proceeding with fresh insert.`);
    }

    const insertResult = await appsRepository.insertInstalledApp(dbSpecs);
    if (!insertResult) {
      throw new Error(`CRITICAL: Failed to create database entry for ${appName}. Database insert returned undefined - likely duplicate key error or database failure. Aborting installation to prevent orphaned Docker containers.`);
    }
    log.info(`Database entry created for ${appName} BEFORE Docker container creation`);

    try {
      if (!await appsRepository.existsInstalledApp(appName)) {
        throw new Error(`Database entry validation failed for ${appName}. Entry was inserted but disappeared before Docker container creation. Possible race condition or database corruption detected.`);
      }
      log.info(`Database entry validated for ${appName} before Docker container creation`);

      const deployment = await deploymentProvider.getInstalledDeployment(appName);
      if (!deployment) throw new Error(`Failed to build deployment for ${appName}`);

      // Record this app's telemetry sink (Arcane-only; null/no-op otherwise)
      // so the identity socket can route its containers to its own backend,
      // and make sure the daemon is running before its containers are created.
      if (!test) {
        const telemetrySink = telemetrySinkCache.extractSink(deployment);
        telemetrySinkCache.setSink(appName, telemetrySink);
        if (telemetrySink) await telemetryConfigService.ensureNode();
      }

      const owner = instantiated.owner;
      const burstEligible = owner
        && cpuBurstHelper.isEnterpriseOwner(owner)
        && await cpuBurstHelper.isCpuBurstSupported();
      const restartAlwaysOwners = config.fluxapps.restartAlwaysOwners || [];
      const restartPolicy = (owner && restartAlwaysOwners.includes(owner)) ? 'always' : null;

      const syslogCollector = deployment.componentEntries()
        .find(([, c]) => c.toDockerEnv().some((e) => e.startsWith('LOG=COLLECT')));
      const syslogTarget = syslogCollector ? syslogCollector[0] : null;

      // No in-app collector: discover one in a linked (shareWith) app so a
      // SEND component can ship cross-app. Resolved here (orchestrator) and
      // passed down, so the docker primitive never depends on the linker.
      const crossAppLogCollector = syslogTarget
        ? null
        : await appNetworkLinker.findLinkedAppLogCollector(instantiated);

      for (const [, component] of deployment.componentEntries()) {
        // eslint-disable-next-line no-await-in-loop
        await installComponent(component, {
          onStatus,
          test,
          createVolumes,
          burstEligible,
          restartPolicy,
          syslogTarget,
          crossAppLogCollector,
          owner: instantiated.owner,
        });
        // Attach the freshly created container to every linked app's network.
        if (!test) {
          // eslint-disable-next-line no-await-in-loop
          await appNetworkLinker.connectComponentToLinkedApps(component.identifier, instantiated);
        }
      }

      // Hand the full shutdown plan to flux-shutdownd (best-effort; Arcane-only
      // — the socket is absent elsewhere and the call no-ops). Per-container
      // labels were stamped at docker-create; this carries the richer plan
      // (preStop argv, drain config) the labels can't hold. The whole handoff is
      // guarded — building or pushing the plan must never break an install.
      if (!test) {
        try {
          await fluxShutdowndClient.upsertAppPlanBestEffort(
            shutdownPlan.buildShutdownPlan(instantiated, deployment),
          );
        } catch (error) {
          log.warn(`flux-shutdownd plan handoff skipped: ${error.message}`);
        }
      }
    } catch (error) {
      if (!test) {
        const errorResponse = messageHelper.createErrorMessage(
          error.message || error,
          error.name,
          error.code,
        );
        const broadcastedAt = Date.now();
        const newAppRunningMessage = {
          type: 'fluxappinstallingerror',
          version: 1,
          name: appName,
          hash: instantiated.hash,
          error: serviceHelper.ensureString(errorResponse),
          ip: localSocketAddr,
          broadcastedAt,
        };
        await storeAppInstallingErrorMessage(newAppRunningMessage);
        await fluxCommunicationMessagesSender.broadcastMessageToAll(newAppRunningMessage);
      }
      throw error;
    }

    log.info(`Flux App: ${appName} is test install: ${test}`);

    // Reconnect any locally installed apps that are networked with this app — its private
    // network was (re)created during this install. installApplication is always app-level
    // (per-component installs go through installComponent), so run it on any non-test install.
    if (!test) {
      await appNetworkLinker.reconnectLinkedApps(appName);
    }

    log.info(`Flux App ${appName} successfully installed and launched`);
    if (onStatus) onStatus({ status: `Flux App ${appName} successfully installed and launched` });
    globalState.installationInProgress = false;

    // Broadcast this node's running apps AFTER releasing the install lock.
    // onInstallComplete() -> checkAndNotifyPeersOfRunningApps() relies on
    // containerHealthMonitor.monitorAndRecoverApps() to force-include syncthing
    // apps whose components are not all simultaneously "running" at this instant
    // (e.g. a component mid receive-only resync). That recovery path bails out
    // while globalState.isOperationInProgress() is true, so broadcasting before
    // installationInProgress is cleared would exclude the just-installed app from
    // its own announcement. checkAndNotifyPeersOfRunningApps never throws (it
    // catches internally), so running it after the lock release is safe.
    if (!test && onInstallComplete) {
      await onInstallComplete();
      fluxEventBus.publish('app:installed', { name: appName, hash: instantiated.hash });
    }
  } catch (error) {
    globalState.installationInProgress = false;
    log.error(error.message || error);
    // Standard error envelope: stream consumers (frontend, harness) detect a
    // failed install by status:"error" chunks, not by parsing prose.
    if (onStatus) onStatus(messageHelper.createErrorMessage(error.message || error, error.name, error.code));

    if (!test) {
      log.info(`Error occured. Initiating Flux App ${appName} removal`);
      if (onStatus) onStatus(messageHelper.createErrorMessage(`Error occured. Initiating Flux App ${appName} removal`));
      await appUninstaller.uninstallApplication(appName, { forceKill: true, skipGuard: true, broadcastRemoval: sendRemovalMessage, onStatus });
      log.info(`Cleanup completed for ${appName} after installation failure`);
    }

    return { status: InstallStatus.FAILED, reason: error.message || serviceHelper.ensureString(error) };
  } finally {
    operationRegistry.release(appName);
    if (test) {
      try {
        await appUninstaller.uninstallApplication(appName, { forceKill: true, skipGuard: true });
        log.info(`Test cleanup completed for ${appName}`);
      } catch (cleanupError) {
        log.error(`Error during test cleanup for ${appName}: ${cleanupError.message}`);
      }
    }
  }
  return { status: InstallStatus.INSTALLED, reason: null };
}

/**
 * Checks Orbit (Deploy with Git) app health by polling its /api/status endpoint.
 * Waits for initialTestStatus to become true, then checks if the deployment failed.
 * @param {object} appSpec - Component specifications containing repotag and ports
 * @param {string} appName - Application name
 * @param {boolean} isComponent - Whether this is a component
 * @param {object} res - Response object for streaming status updates
 * @returns {Promise<{passed: boolean, reason: string|null}>} Result with passed status and failure reason
 */
async function checkOrbitAppHealth(component, onStatus) {
  if (!component.hostPorts || !component.hostPorts.length) {
    return { passed: false, reason: 'No ports configured for Orbit component' };
  }
  const hostPort = component.hostPorts[0];
  const statusUrl = `http://127.0.0.1:${hostPort}/api/status`;
  const pollInterval = 5000;
  const maxAttempts = 24;
  const initialWait = 5000;

  const id = component.identifier;

  const msg = `Checking Orbit deployment status for ${id} on port ${hostPort}...`;
  log.info(msg);
  if (onStatus) onStatus(msg);

  // Wait for Orbit to initialize before first poll
  await serviceHelper.delay(initialWait);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let pollStatus = '';
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await serviceHelper.axiosGet(statusUrl, { timeout: 5000 });

      if (response.data && response.data.initialTestStatus === true) {
        if (response.data.failed === true) {
          const reason = response.data.failure_reason || 'Unknown failure';
          return { passed: false, reason };
        }
        // initialTestStatus is true and failed is false - test passed
        const successStatus = {
          status: `Orbit initial test passed for ${identifier}`,
        };
        log.info(successStatus);
        log.info(successStatus);
        if (onStatus) onStatus(successStatus);
        return { passed: true, reason: null };
      }

      pollStatus = ` | response: ${JSON.stringify(response.data)}`;
    } catch (error) {
      pollStatus = ` | error: ${error.message}`;
      log.info(`Orbit status poll attempt ${attempt}/${maxAttempts} for ${id}: ${error.message}`);
    }

    const elapsed = attempt * 5;
    const waitMsg = `Waiting for Orbit initial test... (${elapsed}s/${maxAttempts * 5}s)${pollStatus}`;
    if (onStatus) onStatus(waitMsg);

    // eslint-disable-next-line no-await-in-loop
    await serviceHelper.delay(pollInterval);
  }

  return { passed: false, reason: 'Orbit health check timed out: initial test did not complete within 2 minutes' };
}

/**
 * Install a single app component (pull image, create volume, create + start container).
 * @param {object} component - DeploymentComponent to install
 * @param {object} options - { owner, onStatus, test, createVolumes, burstEligible, restartPolicy, extraEnv, syslogTarget, crossAppLogCollector }
 * @returns {Promise<void>}
 */
async function installComponent(component, options = {}) {
  const onStatus = options.onStatus || null;
  const test = options.test || false;
  const createVolumes = options.createVolumes || false;
  const burstEligible = options.burstEligible || false;
  const restartPolicy = options.restartPolicy || null;
  const extraEnv = options.extraEnv || [];
  const syslogTarget = options.syslogTarget || null;
  const crossAppLogCollector = options.crossAppLogCollector || null;
  const { owner } = options;

  // owner is load-bearing: flux-shutdownd keys each app's shutdown plan on it,
  // so a blank runonflux.owner label silently breaks drain/preStop at node
  // shutdown. Refuse rather than stamp an empty owner. Test installs are
  // ephemeral and carry no plan, so they are exempt.
  if (!test && !owner) {
    throw new Error(`installComponent: owner required for ${component.identifier}`);
  }

  const id = component.identifier;
  const appName = component.appName;

  const status = (msg) => {
    log.info(msg);
    if (onStatus) onStatus(msg);
  };

  status(`Allowing ${id} ports...`);
  if (!test) {
    const firewallActive = await fluxNetworkHelper.isFirewallActive();
    const isUPNP = upnpService.isUPNP();
    // eslint-disable-next-line no-restricted-syntax
    for (const port of component.hostPorts) {
      if (firewallActive) {
        // eslint-disable-next-line no-await-in-loop
        const portResponse = await fluxNetworkHelper.allowPort(port);
        if (portResponse.status !== true) {
          throw new Error(`Error: Port ${port} FAILed to open.`);
        }
      }
      if (isUPNP) {
        // eslint-disable-next-line no-await-in-loop
        const mapped = await upnpService.mapUpnpPort(port, `Flux_App_${appName}`);
        if (mapped !== true) {
          throw new Error(`Error: Port ${port} FAILed to map.`);
        }
      }
      status(`Port ${port} OK`);
    }
  }

  const architecture = await systemArchitecture();
  if (!supportedArchitectures.includes(architecture)) {
    throw new Error(`Invalid architecture ${architecture} detected.`);
  }

  const imgVerifier = new imageVerifier.ImageVerifier(
    component.image,
    { maxImageSize: config.fluxapps.maxImageSize, architecture, architectureSet: supportedArchitectures },
  );

  const pullConfig = { repoTag: component.image };

  if (component.imageAuth) {
    const credentials = await registryCredentialHelper.getCredentials(
      component.image,
      component.imageAuth,
      appName,
    );
    if (!credentials) {
      throw new Error('Unable to get credentials');
    }
    imgVerifier.addCredentials(credentials);
    pullConfig.authToken = `${credentials.username}:${credentials.password}`;
  }

  await imgVerifier.verifyImage();
  imgVerifier.throwIfError();

  if (!imgVerifier.supported) {
    throw new Error(`Architecture ${architecture} not supported by ${component.image}`);
  }

  pullConfig.provider = imgVerifier.provider;
  await dockerPullStreamPromise(pullConfig, onStatus ? { write: (data) => onStatus(data), flush: () => {} } : null);
  status(`Pulling ${id} was successful`);

  if (createVolumes) {
    await appVolumeService.createAppVolume(component, onStatus ? { write: (data) => onStatus(data), flush: () => {} } : null, test);

    status(`Verifying volume mount for ${id}...`);
    await volumeService.verifyAppVolumeMount(appName, id !== appName, component.name);
    status(`Volume mount verified for ${id}`);
  }

  // Ensure the dedicated app-swap pool covers all installed apps' swap before the
  // container is created, so its memory.swap.max has live backing. Idempotent; a
  // no-op on nodes without the new-mechanism host config.
  await appSwapPoolService.reconcile();
  // Measure the pulled image's on-disk size so the writable-layer (StorageOpt) cap
  // can be rootFsGb - imageSize for v9. 0 (inspect failed) falls back to full rootFsGb.
  const measuredImageSizeBytes = await dockerService.appDockerImageSize(component.image);
  // Authoritative rootFs-fit reject: the decompressed image must leave room within
  // the component's rootFs budget, else its writable layer has none. Version-blind
  // (legacy is never charged); 0 (inspect failed) skips so create still proceeds.
  if (measuredImageSizeBytes && !component.imageFitsRootFs(measuredImageSizeBytes)) {
    throw new Error(
      `Component '${component.name}' image (${component.image}) is ${(measuredImageSizeBytes / 1e9).toFixed(2)}GB on disk, `
      + `which exceeds its rootFsGb budget of ${component.rootFsGb}GB. `
      + 'rootFsGb must budget the image plus writable-layer headroom.',
    );
  }
  status(`Creating ${id}...`);
  await dockerService.appDockerCreate(component, {
    test,
    burstEligible,
    restartPolicy,
    extraEnv,
    syslogTarget,
    crossAppLogCollector,
    owner,
    measuredImageSizeBytes,
  });

  // Set the log ACL and announce identity to flux-telemetryd before the
  // container starts (Arcane-only; no-op for non-telemetry apps).
  if (!test) {
    await telemetryIdentityService.onComponentCreated(component);
  }

  // A hard install (createVolumes) creates fresh empty volumes, so a
  // component whose data must sync before first start is held for the sync
  // decider to start once seeded; a component where only one elected
  // instance may run is held on every install. Soft installs reuse existing
  // volumes, so sync-before-start components start immediately.
  const holdStart = component.hasActiveStandbySyncthing()
    || (createVolumes && component.requiresSyncBeforeStart());
  if (test || !holdStart) {
    status(`Starting ${id}...`);
    const app = await dockerService.appDockerStart(id);
    if (!app) {
      throw new Error(`Failed to start ${id} container`);
    }
    if (!test) {
      startAppMonitoring(id);
    }
    status(`${id} started`);

    if (test && component.image?.startsWith('runonflux/orbit')) {
      const orbitHealth = await checkOrbitAppHealth(component, onStatus);
      if (!orbitHealth.passed) {
        throw new Error(`Orbit deployment failed: ${orbitHealth.reason}`);
      }
    }
  }
}


/**
 * Install application locally - Main API entry point
 * @param {object} req - Request object containing appname in params or query
 * @param {object} res - Response object
 * @returns {Promise<void>}
 */
async function installApplicationAPI(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname;

    if (!appname) {
      throw new Error('No Flux App specified');
    }

    const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);
    if (!authorized) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
      return;
    }

    const instantiated = await appsRepository.getGlobalAppInfo(appname);
    if (!instantiated) {
      throw new Error(`Application Specifications of ${appname} not found`);
    }

    res.setHeader('Content-Type', 'application/json');
    const onStatus = (msg) => {
      const payload = typeof msg === 'string' ? { status: msg } : msg;
      res.write(serviceHelper.ensureString(payload));
      if (res.flush) res.flush();
    };
    await installApplication(instantiated, { onStatus });
    res.end();
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}


async function testInstallApplication(appname) {
  const tempMessage = await appsRepository.getTempMessageByName(appname);
  if (!tempMessage) {
    throw new Error(`No pending spec found for ${appname}`);
  }

  const { PendingSpec } = await getSpecBackend();
  const pending = PendingSpec.fromTempMessage(tempMessage);

  let spec = pending.spec;
  if (pending.isEncrypted) {
    const provider = await spec.createProvider();
    spec = (await spec.decrypt(provider)).spec;
  }

  const localArch = await systemArchitecture();

  const componentArchitectures = [];
  for (const [name, comp] of spec.componentEntries()) {
    // eslint-disable-next-line no-await-in-loop
    const repoVerification = await verifyRepository(comp.image, {
      repoauth: comp.imageAuth || null,
      appName: spec.name,
      architecture: localArch,
    });
    componentArchitectures.push({
      name,
      architectures: repoVerification.supportedArchitectures,
    });
  }

  const commonArchitectures = findCommonArchitectures(componentArchitectures);

  if (!commonArchitectures.includes(localArch)) {
    return {
      compatible: false,
      localArch,
      requiredArchitectures: commonArchitectures,
    };
  }

  const instantiated = pending.promote(0);
  await installApplication(instantiated, { test: true });
  return { compatible: true };
}

async function testInstallApplicationAPI(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname;

    if (!appname) {
      throw new Error('No Flux App specified');
    }

    const authorized = await verificationHelper.verifyPrivilege('user', req);
    if (!authorized) {
      res.json(messageHelper.errUnauthorizedMessage());
      return;
    }

    const result = await testInstallApplication(appname);

    if (!result.compatible) {
      res.setHeader('Content-Type', 'application/json');
      res.write(serviceHelper.ensureString({ status: 'Checking architecture compatibility...' }));
      if (res.flush) res.flush();
      res.write(serviceHelper.ensureString({
        status: `Test installation validation passed. Installation skipped due to architecture incompatibility: this node is ${result.localArch} but app requires [${result.requiredArchitectures.join(', ')}]`,
      }));
      res.end();
      return;
    }

    const successResponse = messageHelper.createSuccessMessage('Test installation successful');
    res.json(successResponse);
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

module.exports = {
  InstallStatus,
  installApplication,
  installComponent,
  installApplicationAPI,
  testInstallApplicationAPI,
  setOnInstallComplete,
};
