/*
 * appOperations — operations performed on an already-deployed app: redeploy,
 * global update broadcast, start/stop/restart, reconcile, force-removal,
 * active/standby coordination, backup/restore task append, test-app-mount, and
 * the installation/removal/restore in-progress state flags.
 *
 * WARNING: this is a grab-bag. It was inherited as "advancedWorkflows" and is a
 * dumping ground of loosely-related concerns that happen to sit above the
 * installer/uninstaller/docker primitives. It SHOULD be split along its real
 * seams — e.g. lifecycle commands (start/stop/restart/redeploy), the global
 * update intake, reconciliation, and the in-progress state tracker each belong
 * in their own module. Renaming it to appOperations is only a holding action;
 * do not keep adding to it.
 */
const config = require('config');
const fs = require('node:fs/promises');
const path = require('node:path');
const axios = require('axios');
const log = require('../../lib/log');
const serviceHelper = require('../serviceHelper');
const messageHelper = require('../messageHelper');
const deviceHelper = require('../deviceHelper');
const dockerService = require('../dockerService');
const verificationHelper = require('../verificationHelper');
const daemonServiceMiscRpcs = require('../daemonService/daemonServiceMiscRpcs');
const fluxNetworkHelper = require('../fluxNetworkHelper');
// eslint-disable-next-line no-unused-vars
const upnpService = require('../upnpService');
const {
  appsFolder,
  appsFolderPath,
} = require('../utils/appConstants');
const {
  extractIp, extractPort, ipsMatch, DEFAULT_API_PORT,
} = require('../utils/socketAddressUtils');
const appsRepository = require('../appDatabase/appsRepository');
const ingressAttestationService = require('../appMessaging/ingressAttestationService');
const registryManager = require('../appDatabase/registryManager');
const https = require('https');
const { getSpec, getSpecBackend, assertUpdateInvariants } = require('../utils/specLibs');
const appEventVerifier = require('../appMessaging/appEventVerifier');
const messageVerifier = require('../appMessaging/messageVerifier');
const appQueryService = require('../appQuery/appQueryService');
const { listRunningContainers } = appQueryService;
const deploymentProvider = require('../appRuntime/deploymentProvider');
const appReconciler = require('../appMonitoring/appReconciler');
const syncthingMonitorHelpers = require('../appMonitoring/syncthingMonitorHelpers');
const appsRuntimeState = require('../appManagement/appsRuntimeState');
const globalCommand = require('../appManagement/globalCommand');
const appVolumeService = require('./appVolumeService');
const volumeService = require('../utils/volumeService');
const appCaches = require('../utils/appCaches');
const appUninstaller = require('./appUninstaller');
const componentProvisioner = require('./componentProvisioner');
const pendingTeardownStore = require('./pendingTeardownStore');
const shutdownPlan = require('./shutdownPlan');
const fluxShutdowndClient = require('../utils/fluxShutdowndClient');
const appNetworkLinker = require('./appNetworkLinker');
const telemetrySinkCache = require('../telemetrySinkCache');
const telemetryConfigService = require('../telemetryConfigService');
const telemetryIdentityService = require('../telemetryIdentityService');
const hwRequirements = require('../appRequirements/hwRequirements');
const {
  resolveSubmission, assertSecretsNotConflicting, parseMultipartSubmission, uploadSealedContent,
} = require('../appRequirements/appSubmission');
const globalState = require('../utils/globalState');
const contentBlobService = require('./contentBlobService');
const operationRegistry = require('../utils/operationRegistry');

// Active-standby app tracking
const activePrimaryByIdentifier = new Map();
const scheduledPrimaryStart = new Map();

const fluxDirPath = process.env.FLUXOS_PATH || path.join(process.env.HOME, 'zelflux');

// We need to avoid circular dependency, so we'll implement getInstalledAppsForDocker locally
// eslint-disable-next-line no-unused-vars
function getInstalledAppsForDocker() {
  try {
    return dockerService.dockerListContainers({
      all: true,
      filters: { name: [config.fluxapps.appNamePrefix] },
    });
  } catch (error) {
    log.error('Error getting installed apps:', error);
    return [];
  }
}

/**
 * Get the FDM index based on app name first letter (distributes across 4 servers)
 * @param {string} appName - Application name
 * @returns {number} FDM index (1-4)
 */
function getFdmIndex(appName) {
  const firstLetter = appName.substring(0, 1).toLowerCase();
  if (firstLetter.match(/[h-n]/)) {
    return 2;
  }
  if (firstLetter.match(/[o-u]/)) {
    return 3;
  }
  if (firstLetter.match(/[v-z]/)) {
    return 4;
  }
  return 1; // a-g or any other character
}

/**
 * Get master IP for an app from FDM using the /appips endpoint.
 * Tries EU, USA, and ASIA FDM servers in order until one succeeds.
 * @param {string} appName - Application name
 * @param {Object} axiosOptions - Axios request options
 * @returns {Promise<{ip: string|null, fdmOk: boolean}>} The master IP (FDM returns a bare IP;
 *   compare it with ipsMatch, which ignores the port) and success status
 */
async function getMasterIpFromFdm(appName, axiosOptions) {
  const fdmIndex = getFdmIndex(appName);
  const fdmRegions = config.fdm.regions.map((region) => ({
    name: region.name,
    baseUrl: region.baseUrlTemplate.replace('%i', fdmIndex),
  }));

  for (const region of fdmRegions) {
    try {
      const url = `${region.baseUrl}/appips/${appName}`;
      // eslint-disable-next-line no-await-in-loop
      const response = await serviceHelper.axiosGet(url, axiosOptions);

      if (response.data && response.data.status === 'success' && response.data.data) {
        const { ips } = response.data.data;
        if (ips && ips.length > 0) {
          // Return the first IP, stripping the port if present
          const ip = extractIp(ips[0]);
          log.debug(`getMasterIpFromFdm: Got IP ${ip} for app ${appName} from ${region.name} FDM`);
          return { ip, fdmOk: true };
        }
      }
      // No IPs returned from this region, try next
      log.debug(`getMasterIpFromFdm: No IPs returned from ${region.name} FDM for app ${appName}`);
    } catch (error) {
      if (error.response && error.response.status === 404) {
        log.debug(`getMasterIpFromFdm: App ${appName} not found in ${region.name} FDM`);
      } else if (error.response && error.response.status === 503) {
        log.debug(`getMasterIpFromFdm: ${region.name} FDM service starting up for app ${appName}`);
      } else {
        log.error(`getMasterIpFromFdm: Failed to reach ${region.name} FDM for app ${appName}: ${error.message}`);
      }
      // Continue to next region
    }
  }

  // All regions failed or returned no IPs
  return { ip: null, fdmOk: true };
}

/**
 * Find and restore non-enterprise app specifications for proper removal.
 * When local DB has encrypted enterprise specs (compose: []), we need the last non-enterprise
 * version from permanent messages to get port/container info for proper cleanup.
 * @param {Object} installedApp - The installed app object from local database
 * @returns {Promise<Object|null>} App specifications to use for removal, or null if local specs are usable or no non-enterprise version found
 */

// Global state management - using globalState module instead of local variables
// These are now managed through the globalState module
// eslint-disable-next-line no-unused-vars
let dosMountMessage = '';


/**
 * Redeploy a single component of an application.
 *
 * @param {string} appName
 * @param {string} componentName
 * @param {object} [options]
 * @param {boolean} [options.createVolumes=false] - true = recreate volumes, false = keep
 * @param {Function|null} [options.onStatus] - progress callback
 */
async function redeployComponent(appName, componentName, options = {}) {
  const createVolumes = options.createVolumes || false;
  const onStatus = options.onStatus || null;

  const leaseType = createVolumes ? 'hardRedeploy' : 'softRedeploy';
  const label = createVolumes ? 'rebuild' : 'redeploy';

  const status = (msg) => {
    log.info(msg);
    if (onStatus) onStatus(msg);
  };

  if (operationRegistry.isHeld(appName)) {
    status('Another operation is in progress');
    return;
  }

  // A successful whole-app redeploy loops uninstall/installComponent (no
  // app-level install/remove lease), so this app-scoped lease is the only
  // registry record of an in-flight redeploy.
  const redeployToken = operationRegistry.acquire(appName, leaseType, 'appOperations', `${label} ${appName}`);

  try {
    const deployments = await deploymentProvider.getInstalledDeployments(appName);
    if (deployments.length === 0) {
      throw new Error(`Application ${appName} not found`);
    }

    // A bare component name targets the component in EVERY local identity; a
    // co-located pair rolls one identity's copy at a time (sibling keeps serving).
    const targets = deployments
      .map((deployment) => deployment.getComponent(componentName))
      .filter(Boolean);
    if (targets.length === 0) {
      throw new Error(`Component ${componentName} not found in application ${appName}`);
    }

    // Pre-flight: prove the image is pullable BEFORE tearing down the running version,
    // so a broken redeploy (bad ref/tag/arch/size/non-whitelisted) aborts here with the
    // old version still running (the throw lands in the catch, which only releases +
    // hands off — nothing was torn down). Images are identical across replicas.
    // Manifest check only, no pull, no disk cost.
    await componentProvisioner.verifyComponentImage(targets[0]);

    for (const deployComp of targets) {
      if (createVolumes) {
        log.warn(`REMOVAL REASON: ${label} initiated - ${deployComp.identifier} (redeployComponent)`);
      }
      // Same-spec redeploy: the port set is identical, so leave the app's ufw/UPnP rules
      // in place across the teardown+reinstall (no firewall flap, no ~1s/port UPnP re-map).
      // eslint-disable-next-line no-await-in-loop
      await appUninstaller.uninstallComponent(deployComp, {
        removeVolumes: createVolumes,
        skipPorts: true,
        onStatus,
      });

      status(`Component ${deployComp.identifier} removed. Awaiting installation...`);
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.delay(config.fluxapps.redeploy.composedDelay * 1000);

      // eslint-disable-next-line no-await-in-loop
      const instantiated = await appsRepository.getInstalledApp(appName);
      // eslint-disable-next-line no-await-in-loop
      const freshDeployment = await deploymentProvider.buildDeployment(instantiated, { replica: deployComp.replica ?? null });
      // eslint-disable-next-line no-await-in-loop
      await hwRequirements.checkNodeResources(freshDeployment);

      status(`Installing ${deployComp.identifier}...`);
      // eslint-disable-next-line no-await-in-loop
      await componentProvisioner.installComponent(deployComp, {
        createVolumes,
        skipPorts: true,
        specVersion: instantiated.version,
        owner: instantiated.owner,
        requiresEncryption: shutdownPlan.appRequiresDaemonShutdown(freshDeployment),
      });

      status(`Component ${deployComp.identifier} ${label} complete`);
    }
    operationRegistry.release(appName, redeployToken);
    appReconciler.enqueue(appName);
  } catch (error) {
    log.error(error);
    // A redeploy failure must NOT destroy the app: the old version is already torn
    // down (or never existed), so hand recovery to the reconciler. It recreates the
    // missing containers and, if they can't be rebuilt, applies the §14.5 gate — a
    // has-run app degrades to down + retry; only a never-ran one is removed. No
    // direct uninstall, no fleet-wide removal broadcast over a bad update.
    log.warn(`${label} of ${appName} failed (${error.message}); releasing and handing recovery to the reconciler`);
    operationRegistry.release(appName, redeployToken);
    appReconciler.enqueue(appName);
  }
}

/**
 * Redeploy all components of an application.
 *
 * @param {string} appName
 * @param {object} [options]
 * @param {boolean} [options.createVolumes=false] - true = recreate volumes, false = keep
 * @param {Function|null} [options.onStatus] - progress callback
 */
async function redeployApplication(appName, options = {}) {
  const createVolumes = options.createVolumes || false;
  const onStatus = options.onStatus || null;

  const label = createVolumes ? 'rebuild' : 'redeploy';

  const status = (msg) => {
    log.info(msg);
    if (onStatus) onStatus(msg);
  };

  if (operationRegistry.isHeld(appName)) {
    status('Another operation is in progress');
    return;
  }

  const leaseType = createVolumes ? 'hardRedeploy' : 'softRedeploy';
  // See redeployComponent: the success path loops uninstall/installComponent
  // (no app-level install/remove lease), so this is the sole registry record.
  const redeployToken = operationRegistry.acquire(appName, leaseType, 'appOperations', `${label} ${appName}`);

  try {
    const deployments = await deploymentProvider.getInstalledDeployments(appName);
    if (deployments.length === 0) {
      throw new Error(`Application ${appName} not found`);
    }

    status(`Beginning ${label} of ${appName}...`);

    // Pre-flight: prove every component's image is pullable BEFORE tearing anything
    // down, so a broken redeploy aborts with the old version still running (see
    // redeployComponent). Images are spec-level and identical across replicas, so
    // one identity's view covers them all. Manifest check only — no pull, no
    // transient disk cost.
    for (const [, deployComp] of deployments[0].componentEntries()) {
      // eslint-disable-next-line no-await-in-loop
      await componentProvisioner.verifyComponentImage(deployComp);
    }

    // Pre-flight: verify every shareWith dependency is still installed BEFORE tearing
    // anything down. The post-teardown re-verify below can only fail after the running
    // containers are already destroyed; failing here keeps the old version running
    // untouched (degraded at worst — reconnectLinkedApps re-attaches it when the
    // dependency returns).
    const preTeardownSpec = await appsRepository.getInstalledApp(appName);
    if (!preTeardownSpec) {
      throw new Error(`Application ${appName} not found in database`);
    }
    await appNetworkLinker.checkAppNetworkRequirements(preTeardownSpec);

    // Roll ONE identity at a time: tear down and rebuild its components while a
    // co-located sibling keeps serving — the whole-app redeploy is a rolling
    // rebuild, never a simultaneous outage of every replica.
    for (const deployment of deployments) {
      const unitLabel = deployment.replica != null ? `Replica ${deployment.replica} of ${appName}` : `Application ${appName}`;
      // Same-spec redeploy: every component's port set is unchanged, so leave the app's
      // ufw/UPnP rules in place across the teardown+reinstall (no firewall flap, no UPnP
      // re-map churn). skipPorts on both the teardown and the reinstall below.
      for (const [, deployComp] of deployment.componentEntries({ reverse: true })) {
        if (createVolumes) {
          log.warn(`REMOVAL REASON: ${label} initiated - ${deployComp.identifier} (redeployApplication)`);
        }
        // eslint-disable-next-line no-await-in-loop
        await appUninstaller.uninstallComponent(deployComp, {
          removeVolumes: createVolumes,
          skipPorts: true,
          onStatus,
        });
        // eslint-disable-next-line no-await-in-loop
        await serviceHelper.delay(config.fluxapps.redeploy.composedDelay * 1000);
      }

      status(`${unitLabel} removed. Awaiting installation...`);
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.delay(config.fluxapps.redeploy.delay * 1000);

      // eslint-disable-next-line no-await-in-loop
      const instantiated = await appsRepository.getInstalledApp(appName);
      if (!instantiated) {
        throw new Error(`Application ${appName} not found in database after removal`);
      }
      // eslint-disable-next-line no-await-in-loop
      const freshDeployment = await deploymentProvider.buildDeployment(instantiated, { replica: deployment.replica ?? null });
      if (!freshDeployment) {
        throw new Error(`Application ${appName} deployment not found after requirement check`);
      }
      // eslint-disable-next-line no-await-in-loop
      await hwRequirements.checkNodeResources(freshDeployment);

      // Re-seed telemetry routing before recreating containers, in case the
      // redeploy carries a rotated sink (or dropped telemetry entirely).
      telemetrySinkCache.setSink(appName, telemetrySinkCache.extractSink(freshDeployment));

      // Re-verify shared-network links before recreating containers.
      // eslint-disable-next-line no-await-in-loop
      await appNetworkLinker.checkAppNetworkRequirements(instantiated);

      const requiresEncryption = shutdownPlan.appRequiresDaemonShutdown(freshDeployment);
      for (const [, deployComp] of freshDeployment.componentEntries()) {
        status(`Installing ${deployComp.identifier}...`);
        // eslint-disable-next-line no-await-in-loop
        await componentProvisioner.installComponent(deployComp, {
          createVolumes,
          skipPorts: true,
          specVersion: instantiated.version,
          owner: instantiated.owner,
          requiresEncryption,
        });
        // Re-attach the recreated container to every linked app's network.
        // eslint-disable-next-line no-await-in-loop
        await appNetworkLinker.connectComponentToLinkedApps(deployComp.identifier, instantiated);
        // eslint-disable-next-line no-await-in-loop
        await serviceHelper.delay(config.fluxapps.redeploy.composedDelay * 1000);
      }

      // Refresh this identity's shutdown plan for graceful apps only (a redeploy
      // re-derives the same spec, so the predicate is stable across it). Guarded —
      // the handoff must never break a redeploy. Per-container labels were already
      // restamped at docker-create.
      if (shutdownPlan.appRequiresDaemonShutdown(freshDeployment)) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await fluxShutdowndClient.upsertAppPlanBestEffort(
            shutdownPlan.buildShutdownPlan(instantiated, freshDeployment),
          );
        } catch (error) {
          log.warn(`flux-shutdownd plan handoff skipped: ${error.message}`);
        }
      }
    }

    status(`Application ${appName} ${label} complete`);
    operationRegistry.release(appName, redeployToken);
    appReconciler.enqueue(appName);
  } catch (error) {
    log.error(error);
    // See redeployComponent: never destroy on a redeploy failure — hand recovery to
    // the reconciler (the §14.5 gate decides down-vs-remove on the rebuild attempt).
    log.warn(`${label} of ${appName} failed (${error.message}); releasing and handing recovery to the reconciler`);
    operationRegistry.release(appName, redeployToken);
    appReconciler.enqueue(appName);
  }
}

/**
 * Redeploy component via API
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
async function redeployComponentAPI(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname;
    let { component } = req.params;
    component = component || req.query.component;

    if (!appname) {
      throw new Error('No Flux App specified');
    }

    if (!component) {
      throw new Error('No component specified');
    }

    // Validate that appname does not contain underscore (it should be the app name, not component_app format)
    if (appname.includes('_')) {
      throw new Error('Invalid app name format. Please provide the app name and component name separately');
    }

    if (operationRegistry.isHeld(appname)) {
      log.info(`Operation in progress for ${appname}, component redeploy skipped...`);
      const skipResponse = messageHelper.createWarningMessage(`Operation in progress for ${appname}, component redeploy skipped...`);
      res.json(skipResponse);
      return;
    }

    let { force } = req.params;
    force = force || req.query.force || false;
    force = serviceHelper.ensureBoolean(force);

    // Authorization check - must be app owner or above
    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, appname);
    if (!authorized) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
      return;
    }

    res.setHeader('Content-Type', 'application/json');

    await redeployComponent(appname, component, {
      createVolumes: force,
      onStatus: (msg) => {
        res.write(serviceHelper.ensureString(msg));
        if (res.flush) res.flush();
      },
    });

    const successMessage = messageHelper.createSuccessMessage(`Component ${component} of ${appname} redeployed successfully`);
    res.json(successMessage);
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

/**
 * Redeploy application via API
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
async function redeployApplicationAPI(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname;

    if (!appname) {
      throw new Error('No Flux App specified');
    }

    if (appname.includes('_')) {
      throw new Error('Component cannot be redeployed manually');
    }

    if (operationRegistry.isHeld(appname)) {
      log.info(`Operation in progress for ${appname}, redeploy skipped...`);
      return;
    }

    let { force } = req.params;
    force = force || req.query.force || false;
    force = serviceHelper.ensureBoolean(force);

    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, appname);
    if (!authorized) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
      return;
    }

    let isGlobal = req.params.global || req.query.global || false;
    isGlobal = serviceHelper.ensureBoolean(isGlobal);

    if (isGlobal) {
      globalCommand.executeAppGlobalCommand(appname, 'redeploy', req.headers.zelidauth, force);
      const label = force ? 'hard' : 'soft';
      res.json(messageHelper.createSuccessMessage(`${appname} queried for global ${label} redeploy`));
      return;
    }

    res.setHeader('Content-Type', 'application/json');

    await redeployApplication(appname, {
      createVolumes: force,
      onStatus: (msg) => {
        res.write(serviceHelper.ensureString(msg));
        if (res.flush) res.flush();
      },
    });
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

/**
 * Helper function to send chunk of data to response stream
 * @param {object} res - Response object
 * @param {string} chunk - Data chunk to send
 * @returns {Promise<void>}
 */
async function sendChunk(res, chunk) {
  res.write(`${chunk}\n`);
  if (res.flush) res.flush();
}

/**
 * Helper function to change syncthing folder type
 * @param {string} folderId - Syncthing folder ID (e.g., appId)
 * @param {string} folderType - 'receiveonly' or 'sendreceive'
 * @returns {Promise<boolean>} - true if successful, false otherwise
 */
async function changeSyncthingFolderType(folderId, folderType) {
  try {
    // eslint-disable-next-line global-require
    const syncthingService = require('../syncthingService');

    log.info(`Changing syncthing folder ${folderId} to ${folderType} mode`);

    // Get current folder configuration
    const foldersResponse = await syncthingService.getConfigFolders();
    if (foldersResponse.status !== 'success') {
      log.error(`Failed to get syncthing folders: ${JSON.stringify(foldersResponse)}`);
      return false;
    }

    // Find the folder by path
    // Syncthing syncs the entire appId folder (includes all subdirectories)
    const folderPath = `${appsFolder}${folderId}`;
    const folder = foldersResponse.data.find((f) => f.path === folderPath);

    if (!folder) {
      log.error(`Syncthing folder not found for path: ${folderPath}`);
      return false;
    }

    // Check if already in desired mode
    if (folder.type === folderType) {
      log.info(`Syncthing folder ${folderId} is already in ${folderType} mode`);
      return true;
    }

    // Update folder type using PATCH
    const patchData = { type: folderType };
    const updateResponse = await syncthingService.adjustConfigFolders('patch', patchData, folder.id);

    if (updateResponse.status === 'success') {
      log.info(`Successfully changed syncthing folder ${folderId} to ${folderType} mode`);
      return true;
    }
    log.error(`Failed to change syncthing folder type: ${JSON.stringify(updateResponse)}`);
    return false;
  } catch (error) {
    log.error(`Error changing syncthing folder type for ${folderId}: ${error.message}`);
    return false;
  }
}

/**
 * Helper function to apply permissions fix on persistent container data
 * Fixes permissions on appdata and all additional mount points
 * @param {string} appId - Application ID
 * @returns {Promise<boolean>} - true if successful, false otherwise
 */
async function applyPermissionsFix(appname, appId) {
  try {
    const appPath = `${appsFolder}${appId}`;
    log.info(`Applying permissions fix for app: ${appname}`);

    const deployment = await deploymentProvider.getInstalledDeployment(appname);
    const mounts = deployment
      ? deployment.componentEntries().flatMap(([, comp]) => comp.mounts)
      : [];
    const hasContent = mounts.some((mount) => mount.perms);

    if (!hasContent) {
      // No injected content to protect: the blanket recursive fix, unchanged. The
      // root-owned synced data tree (syncthing runs as root) must be accessible to a
      // container that may run as a non-root uid.
      await serviceHelper.runCommand('chmod', { params: ['-R', '777', appPath], runAsRoot: true });
    } else {
      // The container only sees its bind-mounted sources, so fix each in ONE pass —
      // never recursively 777 the whole tree and walk content back. A data/synced
      // tree gets the recursive 777; injected content gets its own root-owned 0644
      // default (world-readable so the container reads it, never world-writable).
      // No path twice.
      await serviceHelper.runCommand('chmod', { params: ['777', appPath], runAsRoot: true });
      for (const mount of mounts) {
        if (mount.perms) {
          // eslint-disable-next-line no-await-in-loop
          await appVolumeService.applyMountPerms(mount);
        } else {
          // eslint-disable-next-line no-await-in-loop
          await serviceHelper.runCommand('chmod', { params: ['-R', '777', mount.Source], runAsRoot: true });
        }
      }
    }

    log.info(`Successfully applied permissions fix for app: ${appname}`);
    return true;
  } catch (error) {
    log.error(`Error applying permissions fix for ${appname}: ${error.message}`);
    return false;
  }
}

/**
 * Resolve an app or component name to the component identifiers the reconciler keys
 * on: a component name (contains '_') resolves to itself with no spec lookup; a
 * whole-app name expands to every component via its deployment.
 * @param {string} appname - App or component name
 * @returns {Promise<string[]>}
 */
async function componentIdentifiersFor(appname) {
  if (appname.includes('_')) return [appname];
  const instantiated = await appsRepository.getGlobalAppInfo(appname);
  if (!instantiated) {
    throw new Error('Application not found');
  }
  // Every local identity's components: an app-wide stop/start (backup, restore)
  // must cover a co-located pair's containers, not one arbitrary replica's.
  const deployments = await deploymentProvider.buildDeployments(instantiated);
  return deployments.flatMap((deployment) => deployment.componentEntries().map(([, deployComp]) => deployComp.identifier));
}

/**
 * Bring an app's (or single component's) containers up — used by the restore flow
 * after it has swapped in the data. Drives run-state THROUGH the reconciler (the
 * sole actuator) and blocks until converged; never touches Docker. An operator-
 * stopped component correctly settles stopped rather than being force-started.
 * @param {string} appname - App or component name
 * @returns {Promise<void>}
 */
async function startApplication(appname) {
  try {
    const ids = await componentIdentifiersFor(appname);
    await appReconciler.drive(ids, 'running');
  } catch (error) {
    log.error(error);
  }
}

/**
 * Take an app's (or single component's) containers down and BLOCK until they are
 * actually stopped — used by backup/restore before they read or replace the volume.
 * Drives run-state through the reconciler (the sole actuator) via a transient hold;
 * never touches Docker. The hold is transient, so a crash mid-operation lets the app
 * recover rather than stay wrongly stopped.
 * @param {string} appname - App or component name
 * @returns {Promise<void>}
 */
async function stopApplication(appname) {
  try {
    const ids = await componentIdentifiersFor(appname);
    await appReconciler.drive(ids, 'stopped');
  } catch (error) {
    log.error(error);
  }
}

/**
 * Helper function to restart app with permissions fix workflow for new primary
 * This is specifically for g: mode apps becoming primary
 * @param {string} appname - App name
 * @param {string} appId - Application ID for syncthing folder
 * @returns {Promise<void>}
 */
async function promoteApplicationToPrimary(appname, appId) {
  try {
    log.info(`Starting app ${appname} with permissions fix workflow (new primary)`);

    // Quiesce inbound replication while the fix runs: receiveonly stops syncthing
    // overwriting the data we are about to re-own.
    log.info(`Moving syncthing folder to receiveonly for ${appname}`);
    const toReceiveOnly = await changeSyncthingFolderType(appId, 'receiveonly');
    if (!toReceiveOnly) {
      log.warn(`Failed to change syncthing folder to receiveonly for ${appname}, continuing anyway...`);
    }

    // Re-own the persistent container data before the app starts writing to it.
    log.info(`Applying permissions fix for ${appname}`);
    const permissionsApplied = await applyPermissionsFix(appname, appId);
    if (!permissionsApplied) {
      log.error(`Failed to apply permissions fix for ${appname}, aborting container start`);
      return;
    }

    // Restore two-way sync now the data is fixed; a primary must be sendreceive.
    log.info(`Moving syncthing folder to sendreceive for ${appname}`);
    const toSendReceive = await changeSyncthingFolderType(appId, 'sendreceive');
    if (!toSendReceive) {
      log.error(`Failed to change syncthing folder to sendreceive for ${appname}, aborting container start - cannot become primary without sendreceive mode`);
      return;
    }

    // Hand the run-state decision to the reconciler (the single container actuator);
    // permissions are already fixed at this point.
    appReconciler.setControllerDesired(appname, 'running', 'masterSlave primary (synced)');

    log.info(`Successfully completed permissions fix workflow for ${appname}`);
  } catch (error) {
    log.error(`Error in promoteApplicationToPrimary for ${appname}: ${error.message}`);
    // Do not start the app if there was an error in the workflow
  }
}

/**
 * Append backup task to queue
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
/**
 * The volumes one backup/restore task item addresses.
 *
 * A co-located node holds one volume per replica, so a task naming only a
 * component no longer names one thing. The task may carry `replica` to mean
 * exactly that identity; omitting it means every identity of the component on
 * this node, which is the same fan-out uninstall and redeploy already do — and
 * for a loose app, or a replica alone on its node, that set is one, so nothing
 * changes for them.
 *
 * Previously each of these sites took [0] of the matching mounts: a backup
 * archived an arbitrary sibling, and a restore deleted and overwrote one.
 *
 * @param {string} appname
 * @param {string} componentName
 * @param {string|null|undefined} replica - a replica name, or null/undefined
 *   for every identity
 * @returns {Promise<object[]>} volume rows, each tagged with its replica
 */
async function taskVolumes(appname, componentName, replica) {
  const mounts = await volumeService.listComponentVolumeMounts(appname, componentName);
  if (!mounts.length) {
    throw new Error(`Application volume not found for ${componentName} of ${appname}`);
  }
  if (replica === undefined || replica === null) return mounts;
  const match = mounts.find((mount) => mount.replica === replica);
  if (!match) {
    const present = mounts.map((mount) => mount.replica ?? 'unnamed').join(', ');
    throw new Error(`Application volume not found for replica ${replica} of ${componentName} (present: ${present})`);
  }
  return [match];
}

async function appendBackupTask(req, res) {
  let appname;
  let backup;
  // Hoisted so the catch releases ONLY a lease this call acquired (null = no-op).
  let taskToken = null;
  try {
    const processedBody = serviceHelper.ensureObject(req.body);
    log.info(processedBody);
    // eslint-disable-next-line prefer-destructuring
    appname = processedBody.appname;
    // eslint-disable-next-line prefer-destructuring
    backup = processedBody.backup;
    if (!appname || !backup) {
      throw new Error('appname and backup parameters are mandatory');
    }
    if (operationRegistry.isHeld(appname)) {
      throw new Error('An operation is already in progress for this app...');
    }
    const hasTrueBackup = backup.some((backupitem) => backupitem.backup);
    if (hasTrueBackup === false) {
      throw new Error('No backup jobs...');
    }
  } catch (error) {
    log.error(error);
    await sendChunk(res, `${error?.message}\n`);
    res.end();
    return false;
  }
  try {
    const authorized = res ? await verificationHelper.verifyPrivilege('appownerabove', req, appname) : true;
    if (authorized === true) {
      // backup is an app-scoped lease on the same key as install/remove/
      // reconcile, so it's mutually exclusive with them (no feature carve-out).
      taskToken = operationRegistry.acquire(appname, 'backup', 'appOperations', `backup ${appname}`);
      const backupDeployment = await deploymentProvider.getInstalledDeployment(appname);
      // Syncthing folders are registered per component as flux<identifier> —
      // the bare app name matches nothing for a composed app, so the folder
      // must be removed component by component (same as the uninstaller).
      const backupSynced = backupDeployment
        ? backupDeployment.componentEntries().filter(([, comp]) => comp.hasSyncthing()).map(([, comp]) => comp)
        : [];
      if (backupSynced.length) {
        await sendChunk(res, `Stopping syncthing for ${appname}\n`);
        for (const comp of backupSynced) {
          // eslint-disable-next-line no-await-in-loop
          await syncthingMonitorHelpers.removeSyncthingFolder(comp.identifier, res);
        }
      }

      await sendChunk(res, 'Stopping application...\n');
      await stopApplication(appname);
      await serviceHelper.delay(5 * 1000);
      // eslint-disable-next-line global-require
      const IOUtils = require('../IOUtils');
      // eslint-disable-next-line no-restricted-syntax
      for (const component of backup) {
        if (component.backup) {
          const label = component.component.toLowerCase();
          // eslint-disable-next-line no-await-in-loop
          const volumes = await taskVolumes(appname, component.component, component.replica);
          // eslint-disable-next-line no-restricted-syntax
          for (const volume of volumes) {
            // The archive keeps its component name: the directory it lives in
            // is already this identity's volume, so siblings cannot collide.
            const targetPath = `${volume.mount}/appdata`;
            const tarGzPath = `${volume.mount}/backup/local/backup_${label}.tar.gz`;
            const forWhich = volume.replica ? `${label} (replica ${volume.replica})` : label;
            // eslint-disable-next-line no-await-in-loop
            const existStatus = await IOUtils.checkFileExists(tarGzPath);
            if (existStatus === true) {
              // eslint-disable-next-line no-await-in-loop
              await sendChunk(res, `Removing exists backup archive for ${forWhich}...\n`);
              // eslint-disable-next-line no-await-in-loop
              await IOUtils.removeFile(tarGzPath);
            }
            // eslint-disable-next-line no-await-in-loop
            await sendChunk(res, `Creating backup archive for ${forWhich}...\n`);
            // eslint-disable-next-line no-await-in-loop
            const tarStatus = await IOUtils.createTarGz(targetPath, tarGzPath);
            if (tarStatus.status === false) {
              // eslint-disable-next-line no-await-in-loop
              await IOUtils.removeFile(tarGzPath);
              throw new Error(`Error: Failed to create backup archive for ${forWhich}, ${tarStatus.error}`);
            }
          }
        }
      }
      await serviceHelper.delay(5 * 1000);
      await sendChunk(res, 'Starting application...\n');
      if (!backupSynced.length) {
        await startApplication(appname);
      } else {
        for (const [compName, comp] of backupDeployment.componentEntries()) {
          if (comp.persistentStorage?.sync?.mode !== 'activeStandby') {
            // eslint-disable-next-line no-await-in-loop
            await startApplication(`${compName}_${appname}`);
          }
        }
      }
      await sendChunk(res, 'Finalizing...\n');
      await serviceHelper.delay(5 * 1000);
      operationRegistry.release(appname, taskToken);
      res.end();
      return true;
      // eslint-disable-next-line no-else-return
    } else {
      const errMessage = messageHelper.errUnauthorizedMessage();
      return res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    // The stop hold is run-state this operation owes back: a failed backup (ENOSPC
    // on the archive is the classic) must never strand the app stopped — the
    // in-memory hold outlives the error for the life of the process. Only when
    // this call owned the operation — an error path must never clear a foreign
    // operation's hold. startApplication settles on legitimate holds (operator
    // lock, controller), so this never force-starts.
    if (taskToken) await startApplication(appname);
    operationRegistry.release(appname, taskToken);
    await sendChunk(res, `${error?.message}\n`);
    res.end();
    return false;
  }
}

/**
 * Append a restore task based on the provided parameters.
 * @async
 * @param {object} req - Request object.
 * @param {object} res - Response object.
 * @returns {boolean} - True if the restore task is successfully appended, otherwise false.
 * @throws {object} - JSON error response if an error occurs.
 */
async function appendRestoreTask(req, res) {
  let appname;
  let restore;
  let type;
  // Hoisted so the catch releases ONLY a lease this call acquired (null = no-op).
  let taskToken = null;
  try {
    const processedBody = serviceHelper.ensureObject(req.body);
    log.info(processedBody);
    // eslint-disable-next-line prefer-destructuring
    appname = processedBody.appname;
    // eslint-disable-next-line prefer-destructuring
    restore = processedBody.restore;
    // eslint-disable-next-line prefer-destructuring
    type = processedBody.type;
    if (!appname || !restore || !type) {
      throw new Error('appname, restore and type parameters are mandatory');
    }
    if (operationRegistry.isHeld(appname)) {
      throw new Error(`An operation is already in progress for app ${appname}...`);
    }
    const hasTrueRestore = restore.some((restoreitem) => restoreitem.restore);
    if (hasTrueRestore === false) {
      throw new Error('No restore jobs...');
    }
  } catch (error) {
    log.error(error);
    await sendChunk(res, `${error?.message}\n`);
    res.end();
    return false;
  }
  try {
    const authorized = res ? await verificationHelper.verifyPrivilege('appownerabove', req, appname) : true;
    if (authorized === true) {
      const componentItem = restore.map((restoreItem) => restoreItem);
      // restore is an app-scoped lease on the same key as backup/install/
      // remove/reconcile.
      taskToken = operationRegistry.acquire(appname, 'restore', 'appOperations', `restore ${appname}`);
      const restoreDeployment = await deploymentProvider.getInstalledDeployment(appname);
      // Per-component removal for the same reason as backup: composed apps'
      // folders are flux<identifier>, never flux<appname>.
      const restoreSynced = restoreDeployment
        ? restoreDeployment.componentEntries().filter(([, comp]) => comp.hasSyncthing()).map(([, comp]) => comp)
        : [];
      if (restoreSynced.length) {
        await sendChunk(res, `Stopping syncthing for ${appname}\n`);
        for (const comp of restoreSynced) {
          // eslint-disable-next-line no-await-in-loop
          await syncthingMonitorHelpers.removeSyncthingFolder(comp.identifier, res);
        }
      }
      await sendChunk(res, 'Stopping application...\n');
      await stopApplication(appname);
      await serviceHelper.delay(5 * 1000);
      // eslint-disable-next-line global-require
      const IOUtils = require('../IOUtils');
      // eslint-disable-next-line no-restricted-syntax
      for (const component of restore) {
        if (component.restore) {
          // eslint-disable-next-line no-await-in-loop
          const volumes = await taskVolumes(appname, component.component, component.replica);
          // eslint-disable-next-line no-restricted-syntax
          for (const volume of volumes) {
            const forWhich = volume.replica ? `${component.component} (replica ${volume.replica})` : component.component;
            // eslint-disable-next-line no-await-in-loop
            await sendChunk(res, `Removing ${forWhich} component data...\n`);
            // eslint-disable-next-line no-await-in-loop
            await serviceHelper.delay(2 * 1000);
            // eslint-disable-next-line no-await-in-loop
            await IOUtils.removeDirectory(`${volume.mount}/appdata`, true);
          }
        }
      }

      if (type === 'remote') {
        // eslint-disable-next-line no-restricted-syntax
        for (const restoreItem of componentItem) {
          if (restoreItem?.url !== '') {
            // eslint-disable-next-line no-await-in-loop
            const volumes = await taskVolumes(appname, restoreItem.component, restoreItem.replica);
            // eslint-disable-next-line no-restricted-syntax
            for (const volume of volumes) {
              const remotePath = `${volume.mount}/backup/remote`;
              // eslint-disable-next-line no-await-in-loop
              await IOUtils.removeDirectory(remotePath, true);
              // eslint-disable-next-line no-await-in-loop
              await sendChunk(res, `Downloading ${restoreItem.url}...\n`);
              // eslint-disable-next-line no-await-in-loop
              const downloadStatus = await IOUtils.downloadFileFromUrl(restoreItem.url, remotePath, restoreItem.component, true);
              if (downloadStatus !== true) {
                throw new Error(`Error: Failed to download ${restoreItem.url}...`);
              }
            }
          }
        }
      }

      // eslint-disable-next-line no-restricted-syntax
      for (const component of restore) {
        if (component.restore) {
          const label = component.component.toLowerCase();
          // eslint-disable-next-line no-await-in-loop
          const volumes = await taskVolumes(appname, component.component, component.replica);
          // eslint-disable-next-line no-restricted-syntax
          for (const volume of volumes) {
            const targetPath = `${volume.mount}/appdata`;
            const tarGzPath = `${volume.mount}/backup/${type}/backup_${label}.tar.gz`;
            const forWhich = volume.replica ? `${label} (replica ${volume.replica})` : label;
            // eslint-disable-next-line no-await-in-loop
            await sendChunk(res, `Unpacking backup archive for ${forWhich}...\n`);
            // eslint-disable-next-line no-await-in-loop
            const tarStatus = await IOUtils.untarFile(targetPath, tarGzPath);
            if (tarStatus.status === false) {
              throw new Error(`Error: Failed to unpack archive file for ${forWhich}, ${tarStatus.error}`);
            } else {
              // eslint-disable-next-line no-await-in-loop
              await sendChunk(res, `Removing backup file for ${forWhich}...\n`);
              // eslint-disable-next-line no-await-in-loop
              await IOUtils.removeFile(tarGzPath);
            }
            const restoreComp = restoreDeployment?.componentEntries().find(([name]) => name === component.component)?.[1];
            const syncthingAux = restoreComp?.hasSyncthing();
            if (syncthingAux) {
              // Minted by the encoder with this identity's replica, never
              // assembled by hand — that is what drops the replica segment and
              // addresses a sibling. (Co-located replicas cannot use sync, so
              // the replica is null here today; the encoder keeps it right if
              // that ever changes.)
              // eslint-disable-next-line no-await-in-loop
              const { DeploymentSpec } = await getSpecBackend();
              const identifier = DeploymentSpec.containerIdentifierFor(
                component.component,
                appname,
                volume.replica,
              );
              const appId = dockerService.getAppIdentifier(identifier);
              // eslint-disable-next-line no-await-in-loop
              await appCaches.setSyncedMark(appCaches.receiveOnlySyncthingAppsCache, appId, {
                restarted: true,
                numberOfExecutionsRequired: 4,
                numberOfExecutions: 10,
              });
            }
          }
        }
      }
      await serviceHelper.delay(1 * 5 * 1000);
      await sendChunk(res, 'Starting application...\n');
      await startApplication(appname);
      if (restoreSynced.length) {
        await sendChunk(res, 'Redeploying other instances...\n');
        globalCommand.executeAppGlobalCommand(appname, 'redeploy', req.headers.zelidauth, true);
        await serviceHelper.delay(1 * 60 * 1000);
      }
      await sendChunk(res, 'Finalizing...\n');
      await serviceHelper.delay(5 * 1000);
      operationRegistry.release(appname, taskToken);
      res.end();
      return true;
      // eslint-disable-next-line no-else-return
    } else {
      const errMessage = messageHelper.errUnauthorizedMessage();
      return res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    // The stop hold is run-state this operation owes back: a failed restore must
    // never strand the app stopped (the in-memory hold outlives the error for the
    // life of the process). Only when this call owned the operation — an error
    // path must never clear a foreign operation's hold. startApplication settles
    // on legitimate holds (operator lock, controller), so this never force-starts.
    if (taskToken) await startApplication(appname);
    operationRegistry.release(appname, taskToken);
    await sendChunk(res, `${error?.message}\n`);
    res.end();
    return false;
  }
}

/**
 * Remove test app mount
 * @param {string} specifiedVolume - Volume to remove
 * @returns {Promise<void>}
 */
async function removeTestAppMount(specifiedVolume) {
  try {
    const appId = 'flux_fluxTestVol';
    log.info('Mount Test: Unmounting volume');
    const umountResult = await serviceHelper.runCommand('umount', { params: [appsFolder + appId], runAsRoot: true, logError: false });
    if (umountResult.error) {
      log.error(umountResult.error);
      log.error('Mount Test: An error occured while unmounting volume. Continuing. Most likely false positive.');
    } else {
      log.info('Mount Test: Volume unmounted');
    }

    log.info('Mount Test: Cleaning up data');
    const removeDataResult = await serviceHelper.runCommand('rm', { params: ['-rf', appsFolder + appId], runAsRoot: true, logError: false });
    if (removeDataResult.error) {
      log.error(removeDataResult.error);
      log.error('Mount Test: An error occured while cleaning up data. Continuing. Most likely false positive.');
    }
    log.info('Mount Test: Data cleaned');
    log.info('Mount Test: Cleaning up data volume');
    const volumeToRemove = specifiedVolume || `${fluxDirPath}appvolumes/${appId}FLUXFSVOL`;
    const removeVolumeResult = await serviceHelper.runCommand('rm', { params: ['-rf', volumeToRemove], runAsRoot: true, logError: false });
    if (removeVolumeResult.error) {
      log.error(removeVolumeResult.error);
      log.error('Mount Test: An error occured while cleaning up volume. Continuing. Most likely false positive.');
    }
    log.info('Mount Test: Volume cleaned');
  } catch (error) {
    log.error('Mount Test Removal: Error');
    log.error(error);
  }
}

/**
 * Test application mounting capability
 * @returns {Promise<void>}
 */
async function testAppMount() {
  try {
    // before running, try to remove first
    await removeTestAppMount();
    const appSize = 1; // GB
    const overHeadRequired = 2; // GB
    const appId = 'flux_fluxTestVol';

    log.info('Mount Test: started');
    log.info('Mount Test: Searching available space...');

    // The mount test must exercise the same filesystem real app volumes land on (the
    // apps folder's own disk — /dat on Arcane, never the root/overlay disk), so resolve
    // that one filesystem directly instead of scanning every mount and taking the first
    // with room (which could allocate the test volume on /mnt/root). mkdir the apps base
    // first so findmnt can resolve its mountpoint on a fresh node.
    await serviceHelper.runCommand('mkdir', { params: ['-p', appsFolderPath], runAsRoot: true });
    const useThisVolume = await deviceHelper.mountForTarget(appsFolderPath);
    const bytesPerGb = 1024 ** 3;
    if (useThisVolume.availableBytes < (appSize + overHeadRequired) * bytesPerGb) {
      // no useable volume has such a big space for the app
      log.warn('Mount Test: Insufficient space on Flux Node. No useable volume found.');
      // node marked OK
      dosMountMessage = ''; // No Space Found actually
      return;
    }

    // now we know there is a space and we have a volume we can operate with. Let's do volume magic
    log.info('Mount Test: Space found');
    log.info('Mount Test: Allocating space...');

    let volumePath = `${useThisVolume.target}/${appId}FLUXFSVOL`;
    if (useThisVolume.target === '/') {
      await serviceHelper.runCommand('mkdir', { params: ['-p', `${fluxDirPath}appvolumes`], runAsRoot: true });
      volumePath = `${fluxDirPath}appvolumes/${appId}FLUXFSVOL`; // if root mount then temp file is in flux folder/appvolumes
    }

    await serviceHelper.runCommand('fallocate', { params: ['-l', `${appSize}G`, volumePath], runAsRoot: true });

    log.info('Mount Test: Space allocated');
    log.info('Mount Test: Creating filesystem...');

    await serviceHelper.runCommand('mke2fs', { params: ['-t', 'ext4', volumePath], runAsRoot: true });
    log.info('Mount Test: Filesystem created');
    log.info('Mount Test: Making directory...');

    await serviceHelper.runCommand('mkdir', { params: ['-p', appsFolder + appId], runAsRoot: true });
    log.info('Mount Test: Directory made');
    log.info('Mount Test: Mounting volume...');

    await serviceHelper.runCommand('mount', { params: ['-o', 'loop', volumePath, appsFolder + appId], runAsRoot: true });
    log.info('Mount Test: Volume mounted. Test completed.');
    dosMountMessage = '';
    // run removal
    removeTestAppMount(volumePath);
  } catch (error) {
    log.error('Mount Test: Error...');
    log.error(error);
    // node marked OK
    dosMountMessage = 'Unavailability to mount applications volumes. Impossible to run applications.';
    // run removal
    removeTestAppMount();
  }
}

/**
 * Validates that an application update is compatible with the previous version.
 * Enforces structural consistency rules based on app specification version:
 * - v1-3: Repository tags (repotag) cannot be changed
 * - v4+: Component names and count must remain constant (repotag changes allowed)
 * - Version downgrades from v4+ to v1-3 are forbidden
 * Note: Version upgrade policy (e.g. "must upgrade to v8") is enforced in
 * storeAppTemporaryMessage, not here. This function only validates structural
 * compatibility so it can be safely used during hash sync replay of historical messages.
 *
 * @param {object} specifications - The new/updated application specifications to validate
 * @param {string} specifications.name - Application name
 * @param {number} specifications.version - Specification version (1-4+)
 * @param {string} [specifications.repotag] - Docker image repository:tag (v1-3)
 * @param {Array} [specifications.compose] - Component definitions (v4+)
 * @param {object} previousAppSpecs - Previous app specifications (from appSpecHistory.getPreviousSpec)
 * @returns {Promise<boolean>} Returns true if update is compatible
 * @throws {Error} When update violates version-specific compatibility rules:
 *   - Component count mismatch (v4+)
 *   - Component name changes (v4+)
 *   - Repository tag changes (v1-3)
 *   - Version downgrade from v4+ to v1-3
 */

/**
 * Validate and broadcast an app update to the network.
 * Business logic only — no HTTP concerns.
 * @param {object} params - Update parameters
 * @param {object} params.appSpecification - The app specification
 * @param {number} params.timestamp - Message timestamp
 * @param {string} params.signature - Message signature
 * @param {string} params.type - Message type (fluxappupdate/zelappupdate)
 * @param {number} params.version - Message version
 * @returns {Promise<string>} The message hash
 */
async function updateAppGlobaly(params) {
  const {
    appSpecification, timestamp, signature, type: messageType, version: typeVersion, contentCtx,
  } = params;

  if (!appSpecification || !timestamp || !signature || !messageType || !typeVersion) {
    throw new Error('Incomplete message received. Check if appSpecification, timestamp, type, version and signature are provided.');
  }
  if (messageType !== 'zelappupdate' && messageType !== 'fluxappupdate') {
    throw new Error('Invalid type of message');
  }
  // envelope version 1 = legacy v1-v8, 2 = v9 (AppEventV2 / contentHash signing)
  if (typeVersion !== 1 && typeVersion !== 2) {
    throw new Error('Invalid version of message');
  }

  const cleanTimestamp = serviceHelper.ensureNumber(timestamp);
  const cleanSignature = serviceHelper.ensureString(signature);
  const cleanMessageType = serviceHelper.ensureString(messageType);
  const cleanTypeVersion = serviceHelper.ensureNumber(typeVersion);

  const timestampNow = Date.now();
  if (cleanTimestamp < timestampNow - 1000 * 3600) {
    throw new Error('Message timestamp is over 1 hour old, not valid. Check if your computer clock is synced and restart the registration process.');
  } else if (cleanTimestamp > timestampNow + 1000 * 60 * 5) {
    throw new Error('Message timestamp from future, not valid. Check if your computer clock is synced and restart the registration process.');
  }

  const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
  if (!syncStatus.data.synced) {
    throw new Error('Daemon not yet synced.');
  }
  const daemonHeight = syncStatus.data.height;

  const appSpecObj = serviceHelper.ensureObject(appSpecification);
  const cleanContentHash = params.contentHash;
  const cleanExtend = params.extend;

  const { spec, broadcastBlob } = await resolveSubmission(appSpecObj, {
    contentHash: cleanContentHash, timestamp: cleanTimestamp, type: cleanMessageType, daemonHeight,
  });

  for (const { componentName, secrets } of spec.getComponentSecrets()) {
    // eslint-disable-next-line no-await-in-loop
    await assertSecretsNotConflicting(spec.name, componentName, secrets, spec.owner);
  }

  const appInfo = await appsRepository.getGlobalAppInfo(spec.name);
  if (!appInfo) {
    throw new Error('Flux App update received but application to update does not exist!');
  }
  const previousSpec = appInfo.spec;

  // Registration-locked invariants (e.g. referral). Both specs must be
  // cleartext; the stored prior spec may be encrypted, so decrypt it first.
  const priorCleartext = previousSpec.isEncrypted
    ? await previousSpec.decrypt(await previousSpec.createProvider())
    : previousSpec;
  await assertUpdateInvariants(priorCleartext, spec);

  const appEvent = await appEventVerifier.deserializeTempMessage({
    type: cleanMessageType,
    version: cleanTypeVersion,
    appSpecifications: broadcastBlob,
    contentHash: cleanContentHash,
    timestamp: cleanTimestamp,
    extend: cleanExtend,
    signature: cleanSignature,
  });
  await appEventVerifier.authorize({
    appEvent, previousState: appInfo, daemonHeight, verifyHash: false,
  });

  const { latestSupportedSpecVersion } = config.fluxapps;
  const { UpdatePolicy } = await getSpec();
  UpdatePolicy.assertVersionTransition(previousSpec, spec, latestSupportedSpecVersion);
  UpdatePolicy.assertCompatible(previousSpec, spec);

  // Content rides as ONE HPKE-sealed envelope — never plaintext in transit. Open it
  // toward this node's per-app transport key and upload synchronously so it is
  // durably stored before the spec is gossiped. The superseded spec's contentRef
  // hashes are carried over (already stored under identical locators), so the
  // envelope attaches only new or changed files.
  if (contentCtx) {
    await uploadSealedContent(spec, contentCtx.content, contentCtx.ownerSigs, {
      ref: cleanContentHash, timestamp: cleanTimestamp, priorSpec: priorCleartext,
    });
  }

  const messageHASH = await appEventVerifier.computeOutboundHash({
    type: cleanMessageType,
    envelopeVersion: cleanTypeVersion,
    specBlob: broadcastBlob,
    contentHash: cleanContentHash,
    timestamp: cleanTimestamp,
    extend: cleanExtend,
    signature: cleanSignature,
  });

  // v9 only (envelope version 2). v8 enterprise messages are envelope version 1,
  // which old nodes still parse — they must not carry an unknown arcaneAttestation
  // key. v9 messages are rejected by old nodes before parsing.
  let arcaneAttestation;
  if (appEvent.requiresArcaneAttestation()) {
    arcaneAttestation = await appEventVerifier.requestAttestation(cleanContentHash);
  }

  const temporaryAppMessage = {
    type: cleanMessageType,
    version: cleanTypeVersion,
    appSpecifications: broadcastBlob,
    hash: messageHASH,
    contentHash: cleanContentHash,
    timestamp: cleanTimestamp,
    extend: cleanExtend,
    signature: cleanSignature,
    arcaneAttestation,
  };

  // fluxCommunicationMessagesSender stays a lazy require: it forms a load-time
  // cycle back to this module (via dockerService -> ... -> appInspector).
  // eslint-disable-next-line global-require
  const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');
  await fluxCommunicationMessagesSender.broadcastTemporaryAppMessage(temporaryAppMessage);
  await serviceHelper.delay(1200);
  await messageVerifier.requestAppMessage(messageHASH);
  await serviceHelper.delay(1200);

  let tempMessage = await appsRepository.getTempMessage(messageHASH);
  for (let i = 0; i < 20; i += 1) {
    if (!tempMessage) {
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.delay(500);
      // eslint-disable-next-line no-await-in-loop
      tempMessage = await appsRepository.getTempMessage(messageHASH);
    }
  }
  if (tempMessage && typeof tempMessage === 'object' && !Array.isArray(tempMessage)) {
    return tempMessage.hash;
  }
  throw new Error('Unable to update application on the network. Try again later.');
}

/**
 * API endpoint to update application globally
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @returns {Promise<void>} Update result
 */
/**
 * Authorize and run an app update from a parsed submission. Shared by the JSON
 * and multipart paths; the multipart path passes contentCtx (the HPKE-sealed
 * content envelope) so its content uploads synchronously once the spec validates.
 * res.json is sent here on
 * success/unauthorized; validation failures throw to the caller's handler.
 */
async function submitAppUpdate(req, res, processedBody, contentCtx) {
  const authorized = await verificationHelper.verifyPrivilege('user', req);
  if (!authorized) {
    res.json(messageHelper.errUnauthorizedMessage());
    return;
  }
  // eslint-disable-next-line global-require
  const { peerManager } = require('../utils/peerState');
  if (peerManager.outboundCount < config.fluxapps.minOutgoing) {
    throw new Error('Sorry, This Flux does not have enough outgoing peers for safe application update');
  }
  if (peerManager.inboundCount < config.fluxapps.minIncoming) {
    throw new Error('Sorry, This Flux does not have enough incoming peers for safe application update');
  }

  const hash = await updateAppGlobaly({
    appSpecification: processedBody.appSpecification,
    timestamp: processedBody.timestamp,
    signature: processedBody.signature,
    type: processedBody.type,
    version: processedBody.version,
    // v9 (envelope version 2) signs over contentHash and carries the extend
    // flag; both are required to reconstruct the signed message and verify it.
    contentHash: processedBody.contentHash,
    extend: processedBody.extend,
    contentCtx,
  });

  // Record and gossip where this update entered the network (best-effort).
  await ingressAttestationService.emit(hash, req);

  res.json(messageHelper.createDataMessage(hash));
}

/**
 * Multipart update: parse the spec + sealed content envelope, gate content uploads
 * to arcane nodes, then run the shared update flow with the content.
 */
async function handleMultipartAppUpdate(req, res) {
  try {
    const { spec, content, ownerSigs } = await parseMultipartSubmission(req);
    if (content && !globalState.isArcane()) {
      throw new Error('Content uploads require an arcane node');
    }
    const processedBody = serviceHelper.ensureObject(spec);
    const contentCtx = content ? { content, ownerSigs } : null;
    await submitAppUpdate(req, res, processedBody, contentCtx);
  } catch (error) {
    log.warn(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

async function updateAppGlobalyApi(req, res) {
  const contentType = req.headers['content-type'] || '';
  if (contentType.startsWith('multipart/form-data')) {
    return handleMultipartAppUpdate(req, res);
  }
  try {
    const processedBody = serviceHelper.ensureObject(req.body);
    await submitAppUpdate(req, res, processedBody, null);
  } catch (error) {
    log.warn(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
  return undefined;
}

const MAX_CONTENT_SERVES = 4;
let activeContentServes = 0;

/**
 * Serve a content blob to a peer by locator — the peers-first source for other
 * nodes installing this app. Anti-abuse only: the content is opaque ciphertext
 * and integrity is the requester's own hash-check, so this gates on a
 * concurrency cap (429 over the limit), not auth. The bytes come verbatim from
 * this node's artifact store (what it fetched and verified) — never the app's
 * live mount, which the app may legitimately have mutated. fluxID is the
 * installed app's owner — the same identity the locator was derived from at
 * upload/provision time, so the served artifact matches the requested locator.
 * @param {object} req - Request object (params: appName, locator)
 * @param {object} res - Response object
 */
async function contentBlobServeApi(req, res) {
  try {
    if (!globalState.isArcane()) {
      res.status(503).end();
      return;
    }
    if (activeContentServes >= MAX_CONTENT_SERVES) {
      res.status(429).end();
      return;
    }
    activeContentServes += 1;
    try {
      const { appName, locator } = req.params;
      const installed = await appsRepository.getInstalledApp(appName);
      if (!installed) {
        res.status(404).end();
        return;
      }
      const framed = await contentBlobService.serveBlob(
        { appName, fluxID: installed.owner, locator },
      );
      if (!framed) {
        res.status(404).end();
        return;
      }
      res.set('Content-Type', 'application/octet-stream');
      res.send(framed);
    } finally {
      activeContentServes -= 1;
    }
  } catch (error) {
    log.error(error);
    res.status(500).end();
  }
}

async function reconcileComponents(appName, oldDeployment, newDeployment, registrySpec) {
  const oldNames = new Set(Object.keys(oldDeployment.components));
  const newNames = new Set(Object.keys(newDeployment.components));

  const removed = [...oldNames].filter((n) => !newNames.has(n));
  const added = [...newNames].filter((n) => !oldNames.has(n));
  const kept = [...oldNames].filter((n) => newNames.has(n));

  // A changed kept component keeps its volume when only non-storage fields differ;
  // a storage change forces a volume recreate (the loop volume is resized).
  const keepVolume = [];
  const recreateVolume = [];
  for (const name of kept) {
    const oldComp = oldDeployment.getComponent(name);
    const newComp = newDeployment.getComponent(name);
    if (oldComp.equals(newComp)) {
      log.info(`Component ${name} of ${appName} unchanged, skipping`);
    } else if (oldComp.storage === newComp.storage) {
      keepVolume.push(name);
    } else {
      recreateVolume.push(name);
    }
  }

  // Pre-flight: prove every NEW component image is pullable BEFORE tearing the old
  // versions down, so a broken update aborts (caught by reconcileApp, which releases
  // + hands off — no destroy) with the old versions still running. Manifest check
  // only — no pull, no transient disk cost.
  for (const name of [...keepVolume, ...recreateVolume, ...added]) {
    const newComp = newDeployment.getComponent(name);
    // eslint-disable-next-line no-await-in-loop
    if (newComp) await componentProvisioner.verifyComponentImage(newComp);
  }

  // Port delta over the whole app: move only the ufw/UPnP rules that actually change.
  // Close ports the new spec dropped (old−new), open ports it added (new−old), and leave
  // every unchanged port's mapping in place — no firewall flap, no ~1s/port UPnP re-map.
  // The per-component teardown/reinstall below skip ports (skipPorts), so this is the
  // single place ports move for an update.
  const collectHostPorts = (deployment) => {
    const ports = new Set();
    for (const [, comp] of deployment.componentEntries()) {
      for (const port of (comp.hostPorts || [])) ports.add(port);
    }
    return ports;
  };
  const oldPorts = collectHostPorts(oldDeployment);
  const newPorts = collectHostPorts(newDeployment);
  const portsToClose = [...oldPorts].filter((port) => !newPorts.has(port));
  const portsToOpen = [...newPorts].filter((port) => !oldPorts.has(port));

  const toUninstall = [...removed, ...recreateVolume, ...keepVolume];
  if (toUninstall.length > 0) {
    for (const name of toUninstall.reverse()) {
      const deployComp = oldDeployment.getComponent(name);
      if (!deployComp) continue;
      const removeVolumes = removed.includes(name) || recreateVolume.includes(name);
      if (removeVolumes) {
        log.warn(`REMOVAL REASON: Reconciliation - ${deployComp.identifier} ${removed.includes(name) ? 'removed from spec' : 'storage changed'}`);
      }
      // eslint-disable-next-line no-await-in-loop
      await appUninstaller.uninstallComponent(deployComp, { removeVolumes, skipPorts: true });
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.delay(config.fluxapps.redeploy.composedDelay * 1000);
    }
  }

  // Close the dropped ports now (before the reinstall): no surviving component uses them,
  // so closing is always safe, and doing it here means a failed reinstall can't leak them
  // (the reconciler reopens survivors' ports on recovery but never sweeps a stale deny).
  if (portsToClose.length) {
    await appUninstaller.denyPorts(portsToClose, appName);
  }

  // A kept-volume component keeps its old mount sources, so injected content the
  // new spec dropped (a removed contentRef/contentSlot, or a slot left inside a
  // still-mounted shared atomic dir) survives and would keep being served. Remove
  // the orphaned injected files — only what was injected and no longer is, never
  // owner data — before the containers come back up. recreateVolume wipes the
  // whole volume already; removed components were fully uninstalled above.
  for (const name of keepVolume) {
    const oldComp = oldDeployment.getComponent(name);
    const newComp = newDeployment.getComponent(name);
    if (!oldComp || !newComp) continue;
    // eslint-disable-next-line no-await-in-loop
    await appVolumeService.removeOrphanedInjectedContent(oldComp, newComp);
  }

  const wireSpec = registrySpec.serialize();
  await appsRepository.upsertInstalledApp(appName, wireSpec);
  log.info(`Database updated for ${appName}`);

  // Rebuild THIS identity's fresh view - handing a co-located sibling's view to
  // the reinstalls below would apply its ports/env to the wrong containers.
  const freshDeployment = await deploymentProvider.buildDeployment(registrySpec, { replica: newDeployment.replica ?? null });
  await hwRequirements.checkNodeResources(freshDeployment);

  // Re-seed telemetry routing from the updated spec. A sink change (key
  // rotation, added/dropped telemetry) can arrive with no component diff,
  // so this cannot ride on component reinstalls — re-announce the running
  // containers so connected daemons rebuild their exporters.
  if (freshDeployment) {
    const telemetrySink = telemetrySinkCache.extractSink(freshDeployment);
    telemetrySinkCache.setSink(appName, telemetrySink);
    if (telemetrySink) await telemetryConfigService.ensureNode();
    telemetryIdentityService.resyncAll();
  }

  const toInstall = [...keepVolume, ...recreateVolume, ...added];
  if (freshDeployment && toInstall.length > 0) {
    const requiresEncryption = shutdownPlan.appRequiresDaemonShutdown(freshDeployment);
    for (const name of toInstall) {
      const deployComp = freshDeployment.getComponent(name);
      if (!deployComp) continue;
      const createVolumes = recreateVolume.includes(name) || added.includes(name);
      log.info(`Installing ${deployComp.identifier} (${createVolumes ? 'with' : 'without'} volumes)...`);
      // eslint-disable-next-line no-await-in-loop
      await componentProvisioner.installComponent(deployComp, {
        createVolumes,
        skipPorts: true,
        specVersion: registrySpec.version,
        owner: registrySpec.owner,
        requiresEncryption,
      });
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.delay(config.fluxapps.redeploy.composedDelay * 1000);
    }
  }

  // Open the added ports now that the new containers are up. Gate the open on the same
  // teardown-owed signal the install interlock uses: a forced same-name cancel can race
  // this reinstall (force bypasses the per-app gate) — it writes a teardown doc, deletes
  // the row, and tears its ports down; opening here would orphan ufw/UPnP rules for an
  // app that is gone (there is no periodic deny-sweep). The close above always ran
  // (closing is safe); only the open is gated.
  if (portsToOpen.length) {
    if (await pendingTeardownStore.teardownOwedFor(appName)) {
      log.info(`reconcileComponents: teardown owed for ${appName}; skipping redeploy port-open (${portsToOpen.join(',')})`);
    } else {
      await componentProvisioner.openHostPorts(portsToOpen, appName);
    }
  }

  // A reconcile that dropped a component leaves its image behind. Now that the
  // new component set is in place, reclaim the removed components' images,
  // reference-gated — an image still shared with a surviving component (or
  // another app) is left alone, and there is no churn because the new set is up.
  // This is the set-diff layer that knows what was dropped; the per-component
  // uninstall primitive does not.
  const removedImages = removed.map((name) => oldDeployment.getComponent(name)?.image);
  await appUninstaller.reclaimUnusedImages(removedImages, (msg) => log.info(msg));

  // The applied spec changed, so the app-wide shutdown plan (hash, components,
  // timeouts) may differ. Push the refreshed plan for graceful apps; if the update
  // DROPPED all graceful-shutdown features, delete any plan a prior version left so
  // the daemon's store matches. Guarded — must never break the update.
  if (freshDeployment) {
    if (shutdownPlan.appRequiresDaemonShutdown(freshDeployment)) {
      try {
        await fluxShutdowndClient.upsertAppPlanBestEffort(
          shutdownPlan.buildShutdownPlan(registrySpec, freshDeployment),
        );
      } catch (error) {
        log.warn(`flux-shutdownd plan handoff skipped: ${error.message}`);
      }
    } else {
      await fluxShutdowndClient.deleteAppPlanBestEffort(freshDeployment.appName, registrySpec.owner, freshDeployment.replica ?? null);
    }
  }
}

async function reconcileApp(installed, registrySpec) {
  const oldDeployments = await deploymentProvider.getInstalledDeployments(installed.name);
  const newDeployments = await deploymentProvider.buildDeployments(registrySpec);
  if (oldDeployments.length === 0 || newDeployments.length === 0) return;

  if (operationRegistry.isHeld(installed.name)) {
    log.warn(`Skipping ${installed.name} — an operation is in progress for it`);
    return;
  }

  // reconcile is an app-scoped lease on the same key as install/remove/backup/
  // restore — mutually exclusive with them.
  const reconcileToken = operationRegistry.acquire(installed.name, 'reconcile', 'appOperations', `reconcile ${installed.name}`);
  try {
    log.info(`Application ${installed.name} version is obsolete, reconciling...`);
    // One identity at a time under the one app lease, each diffed against its
    // OWN old and new views (a co-located sibling's ports/env never leak in;
    // an identity the update leaves untouched diffs as unchanged and no-ops).
    // Only identities present in BOTH views reconcile here: a de-targeted
    // replica's removal belongs to the spec reconciler's named rung, and a
    // newly assigned one's install to the spawner.
    const newByReplica = new Map(newDeployments.map((deployment) => [deployment.replica ?? null, deployment]));
    for (const oldDeployment of oldDeployments) {
      const newDeployment = newByReplica.get(oldDeployment.replica ?? null);
      if (!newDeployment) continue;
      // eslint-disable-next-line no-await-in-loop
      await reconcileComponents(installed.name, oldDeployment, newDeployment, registrySpec);
    }
    log.info(`Application ${installed.name} reconciliation complete`);
  } catch (error) {
    log.error(error);
    // A reconcile (spec-update) failure must NOT destroy the app: the finally hands
    // recovery to the reconciler, which applies the §14.5 gate on the rebuild — a
    // has-run app degrades to down + retry; only a never-ran one is removed.
    log.warn(`Reconcile of ${installed.name} failed (${error.message}); handing recovery to the reconciler`);
  } finally {
    operationRegistry.release(installed.name, reconcileToken);
    appReconciler.enqueue(installed.name);
  }
}

/**
 * Reconcile flux-shutdownd's plan store against the installed apps on boot.
 * The self-healing backstop for any plan upsert/delete missed while fluxos was
 * down: re-push plans whose spec_hash drifted (or are absent) and delete
 * orphans for apps no longer installed. Best-effort and Arcane-only — the
 * daemon socket is absent elsewhere, so a list failure just ends the resync.
 */
async function shutdownPlanResync() {
  // Gate on the flux-shutdownd socket presence, not node identity: the daemon and its
  // socket only exist where the shutdown pipeline is installed. Absent => nothing to do.
  try {
    await fs.access(fluxShutdowndClient.SOCKET_PATH);
  } catch {
    return;
  }

  let summaries;
  try {
    summaries = await fluxShutdowndClient.listAppPlans();
  } catch (error) {
    log.warn(`shutdown plan resync skipped: ${error.message}`);
    return;
  }

  try {
    const installedApps = await appsRepository.listInstalledApps();
    // One plan per deployed identity: loose keeps the legacy owner:name key,
    // a named replica appends its segment (replica names cannot contain ':').
    const planKey = (owner, name, replica) => (replica != null ? `${owner}:${name}:${replica}` : `${owner}:${name}`);
    const stored = new Map(summaries.map((s) => [planKey(s.owner_flux_id, s.app_name, s.replica ?? null), s]));
    const live = new Set();
    let pushed = 0;
    let deleted = 0;

    for (const installed of installedApps) {
      // Couldn't evaluate the app: keep every plan it holds rather than orphan them.
      const keepAllStored = () => {
        for (const [key, s] of stored) {
          if (s.app_name === installed.name && s.owner_flux_id === installed.owner) live.add(key);
        }
      };
      let deployments;
      try {
        // eslint-disable-next-line no-await-in-loop
        deployments = await deploymentProvider.buildDeployments(installed);
      } catch (error) {
        log.warn(`shutdown plan resync build failed for ${installed.name}: ${error.message}`);
        keepAllStored();
        continue;
      }
      for (const deployment of deployments) {
        const key = planKey(installed.owner, installed.name, deployment.replica ?? null);
        const summary = stored.get(key);
        // A stored plan whose hash still matches: the identity is graceful (it has
        // a plan) and its spec is unchanged — keep it live, nothing to push.
        if (summary && summary.spec_hash === installed.hash) {
          live.add(key);
          continue;
        }
        if (!shutdownPlan.appRequiresDaemonShutdown(deployment)) {
          // Not (or no longer) graceful: leave OUT of `live` so the orphan pass
          // deletes any stale plan a prior graceful version left behind.
          continue;
        }
        live.add(key);
        try {
          // eslint-disable-next-line no-await-in-loop
          await fluxShutdowndClient.upsertAppPlanBestEffort(
            shutdownPlan.buildShutdownPlan(installed, deployment),
          );
          pushed += 1;
        } catch (error) {
          log.warn(`shutdown plan resync upsert failed for ${installed.name}: ${error.message}`);
        }
      }
    }

    for (const [key, summary] of stored) {
      if (live.has(key)) continue;
      // eslint-disable-next-line no-await-in-loop
      await fluxShutdowndClient.deleteAppPlanBestEffort(summary.app_name, summary.owner_flux_id, summary.replica ?? null);
      deleted += 1;
    }

    if (pushed || deleted) log.info(`shutdown plan resync: ${pushed} re-pushed, ${deleted} orphans removed`);
  } catch (error) {
    log.error(`shutdown plan resync failed: ${error.message}`);
  }
}

async function coordinateActiveStandbyApps() {
  // Hoisted so the finally releases ONLY a lease this cycle acquired.
  let coordinateToken = null;
  try {
    // Mark the election cycle in flight (node-global coordinator lease). The
    // node-wide destructive sweeps (daemon-health wipe, orphan removal) stand
    // down while we may be starting/stopping standby containers, and the
    // installer's docker-prune gate checks isHeld(...) for the same reason.
    coordinateToken = operationRegistry.acquire(operationRegistry.ACTIVE_STANDBY_COORDINATOR_KEY, 'coordinate', 'appOperations', 'activeStandby election cycle');
    // The election cycle iterates every activeStandby app; pause it while any
    // folder-set-changing operation is in flight (install/remove/redeploy/reconcile),
    // node-wide. NOT backup/restore - those are skipped per-app in the loop below,
    // so one app's backup never freezes the whole election.
    if (operationRegistry.anyHeldOfType('install', 'remove', 'softRedeploy', 'hardRedeploy', 'reconcile')) {
      return;
    }

    // Wait for the syncthing monitor's first run before electing any primary:
    // that run performs the startup mount-safety check (switching unsafe
    // sendreceive folders to receiveonly). Electing earlier could start a
    // master on a sendreceive-but-unmounted folder and lose data. The monitor
    // clears the flag only after a fully successful cycle.
    if (globalState.syncthingAppsFirstRun) {
      log.info('activeStandby: syncthing first-run mount-safety not complete yet, skipping this cycle');
      return;
    }

    try {
      // eslint-disable-next-line global-require
      const syncthingService = require('../syncthingService');
      const syncthingHealth = await syncthingService.getHealth();
      if (syncthingHealth.status !== 'success' || !syncthingHealth.data || syncthingHealth.data.status !== 'OK') {
        log.warn('activeStandby: Syncthing is not available or not healthy, skipping this cycle');
        return;
      }
    } catch (syncthingError) {
      log.warn(`activeStandby: Failed to check syncthing health: ${syncthingError.message}, skipping this cycle`);
      return;
    }

    const deployments = await deploymentProvider.listInstalledDeployments();
    const runningContainers = await listRunningContainers();

    const runningAppsNames = runningContainers.map((app) => app.Names[0].slice(5));
    const agent = new https.Agent({ rejectUnauthorized: false });
    const axiosOptions = { timeout: 10000, httpsAgent: agent };

    const validIdentifiers = new Set();
    for (const deployment of deployments) {
      for (const [, deployComp] of deployment.componentEntries()) {
        if (deployComp.hasActiveStandbySyncthing()) {
          validIdentifiers.add(deployComp.identifier);
        }
      }
    }

    for (const identifier of activePrimaryByIdentifier.keys()) {
      if (!validIdentifiers.has(identifier)) {
        activePrimaryByIdentifier.delete(identifier);
        log.info(`activeStandby: Cleaned up stale entry from activePrimaryByIdentifier: ${identifier}`);
      }
    }

    for (const identifier of scheduledPrimaryStart.keys()) {
      if (!validIdentifiers.has(identifier)) {
        scheduledPrimaryStart.delete(identifier);
        log.info(`activeStandby: Cleaned up stale entry from scheduledPrimaryStart: ${identifier}`);
      }
    }

    const { receiveOnlySyncthingAppsCache } = globalState;

    for (const deployment of deployments) {
      const { appName } = deployment;
      let fdmOk = true;
      let identifier;
      let needsToBeChecked = false;
      let appId;
      if (operationRegistry.isHeld(appName)) {
        log.info(`activeStandby: operation in progress for ${appName}, skipping`);
        // eslint-disable-next-line no-continue
        continue;
      }
      for (const [, deployComp] of deployment.componentEntries()) {
        if (deployComp.hasActiveStandbySyncthing()) {
          ({ identifier } = deployComp);
          appId = dockerService.getAppIdentifier(identifier);
          needsToBeChecked = true;
          break;
        }
      }
      if (needsToBeChecked) {
        // operator explicitly stopped this g: component; don't elect or act on it
        // eslint-disable-next-line no-await-in-loop
        if (await appsRuntimeState.isOperatorStopped(identifier)) {
          // eslint-disable-next-line no-continue
          continue;
        }
        // Get master IP from FDM using the new /appips endpoint
        // eslint-disable-next-line no-await-in-loop
        const fdmResult = await getMasterIpFromFdm(appName, axiosOptions);
        const { ip } = fdmResult;
        ({ fdmOk } = fdmResult);

        if (!fdmOk) {
          log.warn(`activeStandby: All FDM services failed for app:${appName}, skipping primary selection for this cycle`);
          // eslint-disable-next-line no-continue
          continue;
        }
        if (fdmOk) {
          // no ip means there was no row with ip on fdm
          // down means there was a row ip with status down
          // eslint-disable-next-line no-await-in-loop
          let localSocketAddr;
          try {
            // eslint-disable-next-line no-await-in-loop
            localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();
          } catch (error) {
            log.error(`activeStandby: Failed to get my IP for app:${appName}, error: ${error.message}`);
            // eslint-disable-next-line no-continue
            continue;
          }
          if (localSocketAddr) {
            // Validate ip is a string if it exists
            if (ip && typeof ip !== 'string') {
              log.error(`activeStandby: Invalid IP type from FDM for app:${appName}, got: ${typeof ip}`);
              // eslint-disable-next-line no-continue
              continue;
            }
            if ((!ip)) {
              log.info(`activeStandby: app:${appName} has currently no primary set`);
              if (!runningAppsNames.includes(identifier)) {
                // Check if app is ready (syncthing data is synced) before allowing it to become primary.
                // syncedMark rejects a mark left behind by a previous incarnation of this
                // component's volume - promoting on one would serve an empty disk as primary.
                // eslint-disable-next-line no-await-in-loop
                let isReady = (await appCaches.syncedMark(receiveOnlySyncthingAppsCache, appId))?.restarted === true;

                // Fallback: If not in cache or not ready, check if syncthing folder is already in sendreceive mode
                // This handles the case where folder is synced but cache was cleared/lost
                if (!isReady) {
                  try {
                    // eslint-disable-next-line global-require
                    const syncthingService = require('../syncthingService');
                    // eslint-disable-next-line no-await-in-loop
                    const allSyncthingFolders = await syncthingService.getConfigFolders();
                    if (allSyncthingFolders.status === 'success') {
                      // Syncthing syncs the entire appId folder (includes all subdirectories)
                      const folder = `${appsFolder}${appId}`;
                      // eslint-disable-next-line no-restricted-syntax
                      for (const syncthingFolder of allSyncthingFolders.data) {
                        if (syncthingFolder.path === folder && syncthingFolder.type === 'sendreceive') {
                          log.info(`activeStandby: app:${appName} folder is already in sendreceive mode, treating as ready`);
                          isReady = true;
                          break;
                        }
                      }
                    }
                  } catch (error) {
                    log.error(`activeStandby: Failed to check syncthing folder status for ${appName}: ${error.message}`);
                  }
                }

                if (!isReady) {
                  log.info(`activeStandby: app:${appName} is not ready yet (syncthing not synced), skipping primary selection for this cycle`);
                  // eslint-disable-next-line global-require
                  // eslint-disable-next-line no-continue
                  continue;
                }
                // eslint-disable-next-line no-await-in-loop
                const runningAppList = await registryManager.appLocation(appName);
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
                  if (a.ip < b.ip) {
                    return -1;
                  }
                  if (a.ip > b.ip) {
                    return 1;
                  }
                  return 0;
                });
                const index = runningAppList.findIndex((x) => ipsMatch(x.ip, localSocketAddr));

                // Helper function to check if any lower-index nodes are running the app
                const checkLowerIndexNodesRunning = async () => {
                  if (index <= 0) return false; // Index 0 or not found, no lower nodes to check

                  const { CancelToken } = axios;
                  const timeout = 10 * 1000;

                  // Check all nodes with lower index
                  for (let i = 0; i < index; i += 1) {
                    const nodeToCheck = runningAppList[i];
                    if (!nodeToCheck) continue;

                    const ipToCheck = extractIp(nodeToCheck.ip);
                    const portToCheck = extractPort(nodeToCheck.ip);
                    const source = CancelToken.source();
                    let isResolved = false;

                    setTimeout(() => {
                      if (!isResolved) {
                        source.cancel('Operation canceled by timeout.');
                      }
                    }, timeout);

                    try {
                      // eslint-disable-next-line no-await-in-loop
                      const response = await axios.get(`http://${ipToCheck}:${portToCheck}/apps/listrunningapps`, { timeout, cancelToken: source.token });
                      isResolved = true;
                      const appsRunning = response.data.data;
                      // Match on the active-standby component identifier, not the app name: sibling
                      // components (e.g. a DB cluster component) run on every node and must not be
                      // mistaken for the active-standby component being active there.
                      if (appsRunning.find((app) => app.Names[0].includes(identifier))) {
                        log.info(`activeStandby: component:${identifier} is running on lower-index node (index ${i}) at ${ipToCheck}, will not start`);
                        return true;
                      }
                    } catch (error) {
                      isResolved = true;
                      log.info(`activeStandby: Failed to check lower-index node ${i} at ${ipToCheck} for app:${appName}, error: ${error.message}`);
                      // Continue checking other nodes
                    }
                  }
                  return false;
                };

                if (index === 0 && !activePrimaryByIdentifier.has(identifier)) {
                  // Index 0: Start immediately if no history
                  promoteApplicationToPrimary(identifier, appId);
                  log.info(`activeStandby: starting docker component:${identifier} index: ${index}`);
                } else if (!scheduledPrimaryStart.has(identifier) && activePrimaryByIdentifier.has(identifier) && !ipsMatch(activePrimaryByIdentifier.get(identifier), localSocketAddr)) {
                  // There was a previous master (not me), and it's no longer on FDM
                  const { CancelToken } = axios;
                  const source = CancelToken.source();
                  let isResolved = false;
                  const timeout = 10 * 1000; // 10 seconds
                  setTimeout(() => {
                    if (!isResolved) {
                      source.cancel('Operation canceled by the user.');
                    }
                  }, timeout * 2);
                  const previousMasterIp = activePrimaryByIdentifier.get(identifier);
                  // Look up the correct port from runningAppList since FDM API returns IP without port
                  const previousMasterNode = runningAppList.find((x) => ipsMatch(x.ip, previousMasterIp));
                  const ipToCheckAppRunning = extractIp(previousMasterIp);
                  const portToCheckAppRunning = previousMasterNode ? extractPort(previousMasterNode.ip) : DEFAULT_API_PORT;
                  let previousMasterStillRunning = false;
                  try {
                    // eslint-disable-next-line no-await-in-loop
                    const response = await axios.get(`http://${ipToCheckAppRunning}:${portToCheckAppRunning}/apps/listrunningapps`, { timeout, cancelToken: source.token });
                    isResolved = true;
                    const appsRunning = response.data.data;
                    // Match on the active-standby component identifier, not the app name: sibling
                    // components running on the previous primary must not be mistaken for the
                    // active-standby component still being active there.
                    if (appsRunning.find((app) => app.Names[0].includes(identifier))) {
                      log.info(`activeStandby: component:${identifier} is not on fdm but previous master is running it at: ${ipToCheckAppRunning}:${portToCheckAppRunning}`);
                      previousMasterStillRunning = true;
                    }
                  } catch (error) {
                    log.info(`activeStandby: Failed to reach previous master at ${ipToCheckAppRunning}:${portToCheckAppRunning} for app:${appName}, will proceed with primary selection. Error: ${error.message}`);
                    isResolved = true;
                  }
                  if (previousMasterStillRunning) {
                    return;
                  }
                  // Previous master is not running, determine next primary
                  if (index === 0) {
                    promoteApplicationToPrimary(identifier, appId);
                    log.info(`activeStandby: starting docker component:${identifier} index: ${index}`);
                  } else {
                    const previousMasterIndex = runningAppList.findIndex((x) => ipsMatch(x.ip, activePrimaryByIdentifier.get(identifier)));
                    let timetoStartApp = Date.now();
                    if (previousMasterIndex >= 0) {
                      log.info(`activeStandby: app:${appName} had primary running at index: ${previousMasterIndex}`);
                      if (index > previousMasterIndex) {
                        timetoStartApp += (index - 1) * 3 * 60 * 1000;
                      } else {
                        timetoStartApp += index * 3 * 60 * 1000;
                      }
                    } else {
                      timetoStartApp += index * 3 * 60 * 1000;
                    }
                    if (timetoStartApp <= Date.now()) {
                      // Time to start, but check if lower-index nodes are running
                      // eslint-disable-next-line no-await-in-loop
                      const lowerNodeRunning = await checkLowerIndexNodesRunning();
                      if (!lowerNodeRunning) {
                        promoteApplicationToPrimary(identifier, appId);
                        log.info(`activeStandby: starting docker component:${identifier} index: ${index}`);
                      }
                    } else {
                      log.info(`activeStandby: will start docker app:${appName} at ${timetoStartApp.toString()}`);
                      scheduledPrimaryStart.set(identifier, timetoStartApp);
                    }
                  }
                } else if (scheduledPrimaryStart.has(identifier) && scheduledPrimaryStart.get(identifier) <= Date.now()) {
                  // Scheduled start time has arrived, check if lower-index nodes are running
                  // eslint-disable-next-line no-await-in-loop
                  const lowerNodeRunning = await checkLowerIndexNodesRunning();
                  if (!lowerNodeRunning) {
                    promoteApplicationToPrimary(identifier, appId);
                    log.info(`activeStandby: starting docker component:${identifier} index: ${index} that was scheduled to start at ${scheduledPrimaryStart.get(identifier).toString()}`);
                    scheduledPrimaryStart.delete(identifier);
                  } else {
                    log.info(`activeStandby: not starting app:${appName} index: ${index} - lower-index node is already running`);
                    scheduledPrimaryStart.delete(identifier);
                  }
                } else if (index > 0 && !activePrimaryByIdentifier.has(identifier) && !scheduledPrimaryStart.has(identifier)) {
                  // Non-primary node with no history - schedule start based on index
                  const timetoStartApp = Date.now() + (index * 3 * 60 * 1000);
                  log.info(`activeStandby: scheduling app:${appName} index: ${index} to start at ${timetoStartApp.toString()}`);
                  scheduledPrimaryStart.set(identifier, timetoStartApp);
                } else {
                  // All other cases: don't start
                  log.info(`activeStandby: not starting app:${appName} index: ${index} - conditions not met for primary selection`);
                }
              }
            } else {
              activePrimaryByIdentifier.set(identifier, ip);
              if (scheduledPrimaryStart.has(identifier)) {
                log.info(`activeStandby: app:${appName} removed from scheduledPrimaryStart cache, already started on another standby node`);
                scheduledPrimaryStart.delete(identifier);
              }
              if (!ipsMatch(localSocketAddr, ip) && runningAppsNames.includes(identifier)) {
                // Stop only the active-standby component on this standby node. Sibling components
                // (e.g. a DB cluster component that needs all instances running) must keep running.
                appReconciler.setControllerDesired(identifier, 'stopped', 'masterSlave standby');
                log.info(`activeStandby: stopping docker component:${identifier} it's running on ip:${ip} and localSocketAddr is: ${localSocketAddr}`);
              } else if (ipsMatch(localSocketAddr, ip) && !runningAppsNames.includes(identifier)) {
                // Check if app is ready (syncthing data is synced) before starting. As above,
                // a mark describing a replaced volume must not certify this disk as synced.
                // eslint-disable-next-line no-await-in-loop
                let isReady = (await appCaches.syncedMark(receiveOnlySyncthingAppsCache, appId))?.restarted === true;

                // Fallback: If not in cache or not ready, check if syncthing folder is already in sendreceive mode
                if (!isReady) {
                  try {
                    // eslint-disable-next-line global-require
                    const syncthingService = require('../syncthingService');
                    // eslint-disable-next-line no-await-in-loop
                    const allSyncthingFolders = await syncthingService.getConfigFolders();
                    if (allSyncthingFolders.status === 'success') {
                      // Syncthing syncs the entire appId folder (includes all subdirectories)
                      const folder = `${appsFolder}${appId}`;
                      // eslint-disable-next-line no-restricted-syntax
                      for (const syncthingFolder of allSyncthingFolders.data) {
                        if (syncthingFolder.path === folder && syncthingFolder.type === 'sendreceive') {
                          log.info(`activeStandby: app:${appName} folder is already in sendreceive mode, treating as ready`);
                          isReady = true;
                          break;
                        }
                      }
                    }
                  } catch (error) {
                    log.error(`activeStandby: Failed to check syncthing folder status for ${appName}: ${error.message}`);
                  }
                }

                if (isReady) {
                  promoteApplicationToPrimary(identifier, appId);
                  log.info(`activeStandby: starting docker component:${identifier}`);
                } else {
                  log.info(`activeStandby: app:${appName} is registered as primary on FDM but not ready yet (syncthing not synced), skipping start for this cycle`);
                }
              }
            }
          }
        }
      }
    }
  } catch (error) {
    log.error(`activeStandby: ${error}`);
  } finally {
    operationRegistry.release(operationRegistry.ACTIVE_STANDBY_COORDINATOR_KEY, coordinateToken);
    await serviceHelper.delay(config.fluxapps.masterSlaveIntervalMs ?? 30 * 1000);
    coordinateActiveStandbyApps();
  }
}

/**
 * Get from another peer the list of apps installing errors or just for a specific application name
 // eslint-disable-next-line global-require
 * @returns {Promise<void>}
 */
async function getPeerAppsInstallingErrorMessages() {
  try {
    // Import peerManager dynamically to avoid circular dependency
    // eslint-disable-next-line global-require
    const { peerManager } = require('../utils/peerState');

    if (peerManager.outboundCount === 0) {
      log.info('getPeerAppsInstallingErrorMessages - No outgoing peers available');
      return;
    }

    let finished = false;
    let i = 0;
    while (!finished && i <= 10) {
      i += 1;
      const peer = peerManager.getRandomPeer('outbound');
      if (!peer) break;
      const client = peer.toPeerInfo();
      let axiosConfig = {
        timeout: 5000,
      };
      log.info(`getPeerAppsInstallingErrorMessages - Getting fluxos uptime from ${client.ip}:${client.port}`);
      // eslint-disable-next-line no-await-in-loop
      const response = await serviceHelper.axiosGet(`http://${client.ip}:${client.port}/flux/uptime`, axiosConfig).catch((error) => log.error(error));
      if (!response || !response.data || response.data.status !== 'success' || !response.data.data) {
        log.info(`getPeerAppsInstallingErrorMessages - Failed to get fluxos uptime from ${client.ip}:${client.port}`);
        // eslint-disable-next-line no-continue
        continue;
      }
      const ut = process.uptime();
      const measureUptime = Math.floor(ut);
      // let's get information from a node that have higher fluxos uptime than me for at least one hour.
      if (response.data.data < measureUptime + 3600) {
        log.info(`getPeerAppsInstallingErrorMessages - Connected peer ${client.ip}:${client.port} doesn't have FluxOS uptime to be used`);
        // eslint-disable-next-line no-continue
        continue;
      }
      log.info(`getPeerAppsInstallingErrorMessages - FluxOS uptime is ok on ${client.ip}:${client.port}`);
      axiosConfig = {
        timeout: 30000,
      };
      log.info(`getPeerAppsInstallingErrorMessages - Getting app installing errors from ${client.ip}:${client.port}`);
      const url = `http://${client.ip}:${client.port}/apps/installingerrorslocations`;
      // eslint-disable-next-line no-await-in-loop
      const appsResponse = await serviceHelper.axiosGet(url, axiosConfig).catch((error) => log.error(error));
      if (!appsResponse || !appsResponse.data || appsResponse.data.status !== 'success' || !appsResponse.data.data) {
        log.info(`getPeerAppsInstallingErrorMessages - Failed to get app installing error locations from ${client.ip}:${client.port}`);
        // eslint-disable-next-line no-continue
        continue;
      }
      const apps = appsResponse.data.data;
      log.info(`getPeerAppsInstallingErrorMessages - Will process ${apps.length} apps installing errors locations messages`);
      // eslint-disable-next-line no-await-in-loop
      await appsRepository.upsertAppInstallingErrorLocations(apps);
      finished = true;
    }
  } catch (error) {
    log.error(error);
  }
}

module.exports = {
  redeployComponent,
  redeployApplication,
  reconcileComponents,
  redeployApplicationAPI,
  redeployComponentAPI,
  updateAppGlobaly,
  updateAppGlobalyApi,
  contentBlobServeApi,
  appendBackupTask,
  appendRestoreTask,
  removeTestAppMount,
  testAppMount,
  reconcileApp,
  shutdownPlanResync,
  coordinateActiveStandbyApps,
  getPeerAppsInstallingErrorMessages,
  startApplication,
  stopApplication,
};
