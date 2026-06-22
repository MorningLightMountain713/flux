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
const componentProvisioner = require('./componentProvisioner');
const appReconciler = require('../appMonitoring/appReconciler');
const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');
const { storeAppInstallingErrorMessage } = require('../appMessaging/messageStore');
const { systemArchitecture, checkPlacement, checkNodeResources } = require('../appRequirements/hwRequirements');
const { isImageBlocked, verifyRepository } = require('../appSecurity/imageManager');
// pgpService is used in commented out code
// eslint-disable-next-line no-unused-vars
const pgpService = require('../pgpService');
const operationRegistry = require('../utils/operationRegistry');
const admissionControl = require('../utils/admissionControl');
const cpuBurstHelper = require('../utils/cpuBurstHelper');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const telemetrySinkCache = require('../telemetrySinkCache');
const telemetryConfigService = require('../telemetryConfigService');
const shutdownPlan = require('./shutdownPlan');
const fluxShutdowndClient = require('../utils/fluxShutdowndClient');
const { getSpecBackend } = require('../utils/specLibs');
const { findCommonArchitectures } = require('../utils/appUtilities');
const log = require('../../lib/log');
const appsRepository = require('../appDatabase/appsRepository');
const { localAppsInformation } = require('../utils/appConstants');
const fluxEventBus = require('../utils/fluxEventBus');
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
  // Hoisted out of the try so the post-finally converge-wait can read its components.
  let deployment;
  try {
    // Per-app: defer only if THIS app is already mid-operation. Installs of
    // different apps now run concurrently - the admission semaphore backstops
    // resource accounting, ports are per-port, swap is serialized.
    if (operationRegistry.isHeld(appName)) {
      log.error(`An operation is already in progress for ${appName}. Installation not possible.`);
      return { status: InstallStatus.DEFERRED, reason: `An operation is already in progress for ${appName}` };
    }
    // Acquire the per-app operation lease — the sole record that this app is
    // mid-install. Released in the finally.
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
      log.error(`Flux App ${appName} already installed`);
      return { status: InstallStatus.SKIPPED, reason: `Flux App ${appName} already installed` };
    }

    await checkPlacement(instantiated);

    deployment = await deploymentProvider.buildDeployment(instantiated);
    // Check resources and reserve them atomically: two concurrent installs of
    // different apps must not both pass before either is accounted (the in-flight
    // double-admit race). The reservation is released once the app is durably in
    // the DB (counted by appsResources) or the install fails (the finally).
    await admissionControl.withLock(async () => {
      await checkNodeResources(deployment);
      admissionControl.reserve(appName, deployment);
    });

    // Admission decision, taken before any state is mutated so neither outcome needs
    // cleanup: a blocked image is a rejection (won't change on retry); an unreachable
    // blocklist is a deferral (transient - retry rather than admit something unchecked).
    const blockResult = await isImageBlocked(appName, deployment.allImages(), { owner: instantiated.owner, hash: instantiated.hash });
    if (blockResult.blocked) {
      if (onStatus) onStatus(messageHelper.createErrorMessage(blockResult.reason));
      return { status: InstallStatus.REJECTED, reason: blockResult.reason };
    }
    if (blockResult.undetermined) {
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
    if (stoppedApps.length === 0 && !operationRegistry.isHeld(operationRegistry.ACTIVE_STANDBY_COORDINATOR_KEY)) {
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
    // Now counted by appsResources (it is in the DB); drop the pending reservation
    // so it is not double-counted. The finally releases it on any earlier failure.
    admissionControl.release(appName);

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
        await componentProvisioner.installComponent(component, {
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

    // Broadcast this node's running apps now that the app is durably in the DB
    // (insertInstalledApp ran above): checkAndNotifyPeersOfRunningApps builds its
    // snapshot from the installed-app records, so the just-installed app is
    // included in its own announcement. It never throws (it catches internally),
    // so running it here is safe.
    if (!test && onInstallComplete) {
      await onInstallComplete();
      fluxEventBus.publish('app:installed', { name: appName, hash: instantiated.hash });
    }
  } catch (error) {
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
    // Safety net for every pre-insert failure/early-return path: a reserved-but-
    // not-installed app must never leak its pending resources. Idempotent with the
    // explicit release after insertInstalledApp.
    admissionControl.release(appName);
    if (test) {
      try {
        await appUninstaller.uninstallApplication(appName, { forceKill: true, skipGuard: true });
        log.info(`Test cleanup completed for ${appName}`);
      } catch (cleanupError) {
        log.error(`Error during test cleanup for ${appName}: ${cleanupError.message}`);
      }
    }
  }
  // Hand off to the reconciler and await convergence: it starts/holds each
  // component and resolves a settled verdict (the install lease released in the
  // finally above, so the reconcile won't defer). Load-bearing — the reconciler is
  // the sole starter, so this is what turns "provisioned" into "running". A
  // component that exhausts the install-window start attempts fails the converge ->
  // roll the whole install back (provisioned-but-not-running) so the fleet
  // re-places it; a node issue ('provisional' backstop) never rolls back.
  if (!test) {
    const componentIds = deployment.componentEntries().map(([, comp]) => comp.identifier);
    const { converged, failed } = await appReconciler.awaitConvergence(componentIds);
    if (!converged) {
      log.warn(`REMOVAL REASON: ${appName} provisioned but did not converge (${failed.join(', ')}); rolling back (appInstaller)`);
      if (onStatus) onStatus(messageHelper.createErrorMessage(`App ${appName} failed to start; rolling back`));
      await appUninstaller.uninstallApplication(appName, { forceKill: true, skipGuard: true, broadcastRemoval: sendRemovalMessage, onStatus });
      return { status: InstallStatus.FAILED, reason: `PROVISIONED-BUT-NOT-RUNNING: ${failed.join(', ')}` };
    }
  }
  return { status: InstallStatus.INSTALLED, reason: null };
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
  installApplicationAPI,
  testInstallApplicationAPI,
  setOnInstallComplete,
};
