const os = require('os');
// path is used for dynamic requires in the file
// eslint-disable-next-line no-unused-vars
const path = require('path');
const serviceHelper = require('../serviceHelper');
const verificationHelper = require('../verificationHelper');
const dockerService = require('../dockerService');
const dbHelper = require('../dbHelper');
const messageHelper = require('../messageHelper');
const benchmarkService = require('../benchmarkService');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const geolocationService = require('../geolocationService');
const appUninstaller = require('./appUninstaller');
// const advancedWorkflows = require('./advancedWorkflows'); // Moved to dynamic require to avoid circular dependency
const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');
const { storeAppRunningMessage, storeAppInstallingErrorMessage } = require('../appMessaging/messageStore');
const { systemArchitecture } = require('../appSystem/systemIntegration');
const { checkApplicationImagesCompliance, verifyRepository } = require('../appSecurity/imageManager');
const { startAppMonitoring } = require('../appManagement/appInspector');
const imageVerifier = require('../utils/imageVerifier');
// pgpService is used in commented out code
// eslint-disable-next-line no-unused-vars
const pgpService = require('../pgpService');
const registryCredentialHelper = require('../utils/registryCredentialHelper');
const upnpService = require('../upnpService');
const globalState = require('../utils/globalState');
const cpuBurstHelper = require('../utils/cpuBurstHelper');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const appVolumeService = require('./appVolumeService');
const { resolveSpec, deserializeSpec } = require('../utils/specCutover');
const { getSpecBackend } = require('../utils/specLibs');
const { findCommonArchitectures } = require('../utils/appUtilities');
const log = require('../../lib/log');
const appsRepository = require('../appDatabase/appsRepository');
const { appsFolder, localAppsInformation, scannedHeightCollection } = require('../utils/appConstants');
const { checkAppTemporaryMessageExistence, checkAppMessageExistence } = require('../appMessaging/messageVerifier');
const { availableApps, getApplicationGlobalSpecifications } = require('../appDatabase/registryManager');
const hwRequirements = require('../appRequirements/hwRequirements');
const config = require('config');

// Legacy apps that use old gateway IP assignment method
const appsThatMightBeUsingOldGatewayIpAssignment = ['HNSDoH', 'dane', 'fdm', 'Jetpack2', 'fdmdedicated', 'isokosse', 'ChainBraryDApp', 'health', 'ethercalc'];

// Helper functions and constants for installComponent
const util = require('util');
const { exec } = require('child_process');

const cmdAsync = util.promisify(exec);
const dockerPullStreamPromise = util.promisify(dockerService.dockerPullStream);

const supportedArchitectures = ['amd64', 'arm64'];

/**
 * Verify that the app volume is mounted
 * @param {string} appName - Application name
 * @param {boolean} isComponent - Whether this is a component
 * @param {string} componentName - Component name (if isComponent is true)
 * @returns {Promise<boolean>} True if mount exists, throws error otherwise
 */
async function verifyAppVolumeMount(appName, isComponent, componentName) {
  const identifier = isComponent ? `${componentName}_${appName}` : appName;
  const appId = dockerService.getAppIdentifier(identifier);
  const mountPath = `${appsFolder}${appId}`;

  try {
    // Check if mount exists using mount command
    // grep will throw if no match is found
    const { stdout } = await cmdAsync(`mount | grep "${mountPath}"`);
    if (stdout && stdout.includes(mountPath)) {
      log.info(`Volume mount verified for ${identifier} at ${mountPath}`);
      return true;
    }
  } catch (error) {
    // grep returns non-zero exit code when no matches found, or other command errors
    const errorMessage = `Volume mount verification failed for ${mountPath}. Mount does not exist or is not accessible.`;
    log.error(`${errorMessage} Details: ${error.message}`);
    throw new Error(errorMessage);
  }

  // This shouldn't be reached, but just in case
  throw new Error(`Volume mount verification failed for ${mountPath}. Mount does not exist or is not accessible.`);
}

/**
 * Perform Docker cleanup (prune containers, networks, volumes, images)
 * @param {object} res - Response object for streaming
 * @returns {Promise<void>}
 */
async function performDockerCleanup(res) {
  const dockerContainers = {
    status: 'Clearing up unused docker containers...',
  };
  log.info(dockerContainers);
  if (res) {
    res.write(serviceHelper.ensureString(dockerContainers));
    if (res.flush) res.flush();
  }
  await dockerService.pruneContainers();
  const dockerContainers2 = {
    status: 'Docker containers cleaned.',
  };
  if (res) {
    res.write(serviceHelper.ensureString(dockerContainers2));
    if (res.flush) res.flush();
  }

  const dockerNetworks = {
    status: 'Clearing up unused docker networks...',
  };
  log.info(dockerNetworks);
  if (res) {
    res.write(serviceHelper.ensureString(dockerNetworks));
    if (res.flush) res.flush();
  }
  await dockerService.pruneNetworks();
  const dockerNetworks2 = {
    status: 'Docker networks cleaned.',
  };
  if (res) {
    res.write(serviceHelper.ensureString(dockerNetworks2));
    if (res.flush) res.flush();
  }

  const dockerVolumes = {
    status: 'Clearing up unused docker volumes...',
  };
  log.info(dockerVolumes);
  if (res) {
    res.write(serviceHelper.ensureString(dockerVolumes));
    if (res.flush) res.flush();
  }
  await dockerService.pruneVolumes();
  const dockerVolumes2 = {
    status: 'Docker volumes cleaned.',
  };
  if (res) {
    res.write(serviceHelper.ensureString(dockerVolumes2));
    if (res.flush) res.flush();
  }

  const dockerImages = {
    status: 'Clearing up unused docker images...',
  };
  log.info(dockerImages);
  if (res) {
    res.write(serviceHelper.ensureString(dockerImages));
    if (res.flush) res.flush();
  }
  await dockerService.pruneImages();
  const dockerImages2 = {
    status: 'Docker images cleaned.',
  };
  if (res) {
    res.write(serviceHelper.ensureString(dockerImages2));
    if (res.flush) res.flush();
  }
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
async function setupApplicationPorts(comp, appName, isComponent, res, test = false) {
  const portStatusInitial = {
    status: isComponent ? `Allowing component ${comp.name} of Flux App ${appName} ports...` : `Allowing Flux App ${appName} ports...`,
  };
  log.info(portStatusInitial);
  if (res) {
    res.write(serviceHelper.ensureString(portStatusInitial));
    if (res.flush) res.flush();
  }

  const ports = test ? [] : comp.hostPorts();
  if (ports.length === 0) return;

  const firewallActive = await fluxNetworkHelper.isFirewallActive();
  if (firewallActive) {
    // eslint-disable-next-line no-restricted-syntax
    for (const port of ports) {
      // eslint-disable-next-line no-await-in-loop
      const portResponse = await fluxNetworkHelper.allowPort(port);
      if (portResponse.status === true) {
        const portStatus = { status: `Port ${port} OK` };
        log.info(portStatus);
        if (res) {
          res.write(serviceHelper.ensureString(portStatus));
          if (res.flush) res.flush();
        }
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
    // eslint-disable-next-line no-restricted-syntax
    for (const port of ports) {
      // eslint-disable-next-line no-await-in-loop
      const portResponse = await upnpService.mapUpnpPort(port, `Flux_App_${appName}`);
      if (portResponse === true) {
        const portStatus = { status: `Port ${port} mapped OK` };
        log.info(portStatus);
        if (res) {
          res.write(serviceHelper.ensureString(portStatus));
          if (res.flush) res.flush();
        }
      } else {
        throw new Error(`Error: Port ${port} FAILed to map.`);
      }
    }
  }
}

/**
 * Verify and pull Docker image for application/component
 * @param {object} appSpec - App or component specifications
 * @param {string} appName - Application name
 * @param {boolean} isComponent - Whether this is a component
 * @param {object} res - Response object for streaming
 * @param {object} fullAppSpecs - Full app specifications
 * @returns {Promise<void>}
 */
async function verifyAndPullImage(comp, appName, isComponent, res, spec, fullAppSpecs) {
  const architecture = await systemArchitecture();
  if (!supportedArchitectures.includes(architecture)) {
    throw new Error(`Invalid architecture ${architecture} detected.`);
  }

  await checkApplicationImagesCompliance(fullAppSpecs);

  const imgVerifier = new imageVerifier.ImageVerifier(
    comp.image,
    { maxImageSize: config.fluxapps.maxImageSize, architecture, architectureSet: supportedArchitectures },
  );

  const pullConfig = { repoTag: comp.image };

  let authToken = null;

  if (comp.imageAuth) {
    const credentials = await registryCredentialHelper.getCredentials(
      comp.image,
      comp.imageAuth,
      spec.version,
      appName,
    );

    if (!credentials) {
      throw new Error('Unable to get credentials');
    }

    imgVerifier.addCredentials(credentials);

    authToken = `${credentials.username}:${credentials.password}`;
    pullConfig.authToken = authToken;
  }

  await imgVerifier.verifyImage();
  imgVerifier.throwIfError();

  if (!imgVerifier.supported) {
    throw new Error(`Architecture ${architecture} not supported by ${comp.image}`);
  }

  pullConfig.provider = imgVerifier.provider;

  // eslint-disable-next-line no-unused-vars
  await dockerPullStreamPromise(pullConfig, res);

  const pullStatus = {
    status: isComponent ? `Pulling component ${comp.name} of Flux App ${appName}` : `Pulling global Flux App ${appName} was successful`,
  };

  if (res) {
    res.write(serviceHelper.ensureString(pullStatus));
    if (res.flush) res.flush();
  }
}

/**
 * To register an app locally. Performs pre-installation checks - database in place, Flux Docker network in place and if app already installed. Then registers app in database and performs hard install. If registration fails, the app is removed locally.
 * @param {object} appSpecs App specifications.
 * @param {object} componentSpecs Component specifications.
 * @param {object} res Response.
 * @param {boolean} test indicates if it is just to test the app install.
 * @param {boolean} sendRemovalMessage whether to broadcast removal message to network if installation fails.
 * @returns {Promise<boolean>} Returns true if installation was successful, false otherwise.
 */
async function installApplication(appSpec, options = {}) {
  const res = options.res || null;
  const test = options.test || false;
  const createVolumes = options.createVolumes !== false;
  const sendRemovalMessage = options.sendRemovalMessage || false;
  try {
    if (globalState.removalInProgress) {
      const rStatus = messageHelper.createWarningMessage('Another application is undergoing removal. Installation not possible.');
      log.error(rStatus);
      if (res) {
        res.write(serviceHelper.ensureString(rStatus));
        res.end();
      }
      return false;
    }
    if (globalState.installationInProgress) {
      const rStatus = messageHelper.createWarningMessage('Another application is undergoing installation. Installation not possible');
      log.error(rStatus);
      if (res) {
        res.write(serviceHelper.ensureString(rStatus));
        res.end();
      }
      return false;
    }
    globalState.installationInProgress = true;

    const benchmarkResponse = await benchmarkService.getBenchmarks();
    if (benchmarkResponse.status === 'error') {
      throw new Error('FluxBench status Error. Application cannot be installed at the moment');
    }
    // get my external IP and check that it is longer than 5 in length.
    let myIP = null;
    if (benchmarkResponse.data.ipaddress) {
      log.info(`Gathered IP ${benchmarkResponse.data.ipaddress}`);
      myIP = benchmarkResponse.data.ipaddress.length > 5 ? benchmarkResponse.data.ipaddress : null;
    }
    if (myIP === null) {
      throw new Error('Unable to detect Flux IP address');
    }

    const appName = appSpec.name;
    const precheckForInstallation = {
      status: 'Running initial checks for Flux App...',
    };
    log.info(precheckForInstallation);
    if (res) {
      res.write(serviceHelper.ensureString(precheckForInstallation));
      if (res.flush) res.flush();
    }
    // connect to mongodb
    const dbOpenTest = {
      status: 'Connecting to database...',
    };
    log.info(dbOpenTest);
    if (res) {
      res.write(serviceHelper.ensureString(dbOpenTest));
      if (res.flush) res.flush();
    }
    const dbopen = dbHelper.databaseConnection();

    const appsDatabase = dbopen.db(config.database.appslocal.database);
    const appsQuery = { name: appName };
    const appsProjection = {
      projection: {
        _id: 0,
        name: 1,
      },
    };

    // check if app is already installed
    const checkDb = {
      status: 'Checking database...',
    };
    log.info(checkDb);
    if (res) {
      res.write(serviceHelper.ensureString(checkDb));
      if (res.flush) res.flush();
    }
    const appResult = await appsRepository.getInstalledAppRaw(appName, { name: 1 });
    if (appResult) {
      globalState.installationInProgress = false;
      const rStatus = messageHelper.createErrorMessage(`Flux App ${appName} already installed`);
      log.error(rStatus);
      if (res) {
        res.write(rStatus);
        res.end();
      }
      return false;
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
    // kadena and folding is old naming scheme having /zel.  all global application start with /flux
    const runningAppsNames = runningApps.map((app) => {
      if (app.Names[0].startsWith('/zel')) {
        return app.Names[0].slice(4);
      }
      return app.Names[0].slice(5);
    });
    // installed always is bigger array than running
    const runningSet = new Set(runningAppsNames);
    const stoppedApps = installedAppComponentNames.filter((installedApp) => !runningSet.has(installedApp));
    if (stoppedApps.length === 0 && !globalState.activeStandbyCoordinationRunning) {
      await performDockerCleanup(res);
    }

    {
      let dockerNetworkAddrValue = Math.floor(Math.random() * 256);
      if (appsThatMightBeUsingOldGatewayIpAssignment.includes(appName)) {
        dockerNetworkAddrValue = appName.charCodeAt(appName.length - 1);
      }
      const fluxNetworkStatus = {
        status: `Checking Flux App network of ${appName}...`,
      };
      log.info(fluxNetworkStatus);
      if (res) {
        res.write(serviceHelper.ensureString(fluxNetworkStatus));
        if (res.flush) res.flush();
      }
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
      const accessRemovedRes = {
        status: accessRemoved ? `Private network access removed for ${appName}` : `Error removing private network access for ${appName}`,
      };
      if (res) {
        res.write(serviceHelper.ensureString(accessRemovedRes));
        if (res.flush) res.flush();
      }
      const fluxNetResponse = {
        status: `Docker network of ${appName} initiated.`,
      };
      if (res) {
        res.write(serviceHelper.ensureString(fluxNetResponse));
        if (res.flush) res.flush();
      }
    }

    const appInstallation = {
      status: `Initiating Flux App ${appName} installation...`,
    };
    log.info(appInstallation);
    if (res) {
      res.write(serviceHelper.ensureString(appInstallation));
      if (res.flush) res.flush();
    }

    const isEnterprise = Boolean(
        appSpec.version >= 8 && appSpec.enterprise,
      );

      const dbSpecs = JSON.parse(JSON.stringify(appSpec));

      if (isEnterprise) {
        dbSpecs.compose = [];
        dbSpecs.contacts = [];
      }

      const existingEntry = await appsRepository.getInstalledAppRaw(appSpec.name);
      if (existingEntry) {
        log.warn(`Found existing database entry for ${appSpec.name} during registration. Cleaning up stale entry.`);
        await appsRepository.removeInstalledApp(appSpec.name);
        log.info(`Stale database entry for ${appSpec.name} removed. Proceeding with fresh insert.`);
      }

      const insertResult = await appsRepository.insertInstalledApp(dbSpecs);
      if (!insertResult) {
        throw new Error(`CRITICAL: Failed to create database entry for ${appSpec.name}. Database insert returned undefined - likely duplicate key error or database failure. Aborting installation to prevent orphaned Docker containers.`);
      }
      log.info(`Database entry created for ${appSpec.name} BEFORE Docker container creation`);

    try {
      const dbEntryExists = await appsRepository.getInstalledAppRaw(appSpec.name, { name: 1 });
        if (!dbEntryExists) {
          throw new Error(`Database entry validation failed for ${appSpec.name}. Entry was inserted but disappeared before Docker container creation. Possible race condition or database corruption detected.`);
        }
        log.info(`Database entry validated for ${appSpec.name} before Docker container creation`);

      const deployment = await deploymentProvider.getInstalledDeployment(appName);
      if (!deployment) throw new Error(`Failed to build deployment for ${appName}`);

      await checkApplicationImagesCompliance(appSpec);

      const owner = appSpec.owner || null;
      const burstEligible = owner
        && cpuBurstHelper.isEnterpriseOwner(owner)
        && await cpuBurstHelper.isCpuBurstSupported();
      const specVersion = appSpec.version || null;
      const onStatus = res ? (msg) => {
        const payload = typeof msg === 'string' ? { status: msg } : msg;
        res.write(serviceHelper.ensureString(payload));
        if (res.flush) res.flush();
      } : null;

      const syslogCollector = deployment.componentEntries()
        .find(([, c]) => c.toDockerEnv().some((e) => e.startsWith('LOG=COLLECT')));
      const syslogTarget = syslogCollector ? syslogCollector[0] : null;

      // eslint-disable-next-line no-restricted-syntax
      for (const [, component] of deployment.componentEntries()) {
        // eslint-disable-next-line no-await-in-loop, no-use-before-define
        await installComponent(component, {
          onStatus,
          test,
          createVolumes,
          burstEligible,
          syslogTarget,
          specVersion,
        });
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
          name: appSpec.name,
          hash: appSpec.hash, // hash of application specifics that are running
          error: serviceHelper.ensureString(errorResponse),
          ip: myIP,
          broadcastedAt,
        };
        // store it in local database first
        // eslint-disable-next-line no-await-in-loop, no-use-before-define
        await storeAppInstallingErrorMessage(newAppRunningMessage);
        // broadcast messages about running apps to all peers
        await fluxCommunicationMessagesSender.broadcastMessageToAll(newAppRunningMessage);
        // broadcast messages about running apps to all peers
      }
      throw error;
    }

    log.info(`Flux App: ${appName} is test install: ${test}`);

    if (!test) {
      const broadcastedAt = Date.now();
      const newAppRunningMessage = {
        type: 'fluxapprunning',
        version: 1,
        name: appSpec.name,
        hash: appSpec.hash, // hash of application specifics that are running
        ip: myIP,
        broadcastedAt,
        runningSince: new Date(broadcastedAt).toISOString(),
        osUptime: os.uptime(),
        staticIp: geolocationService.isStaticIP(),
      };

      // store it in local database first
      // eslint-disable-next-line no-await-in-loop, no-use-before-define
      await storeAppRunningMessage(newAppRunningMessage);
      // broadcast messages about running apps to all peers
      await fluxCommunicationMessagesSender.broadcastMessageToAll(newAppRunningMessage);
      // broadcast messages about running apps to all peers
    }

    // all done message
    const successStatus = messageHelper.createSuccessMessage(`Flux App ${appName} successfully installed and launched`);
    log.info(successStatus);
    if (res) {
      res.write(serviceHelper.ensureString(successStatus));
      res.end();
    }
    globalState.installationInProgress = false;
  } catch (error) {
    globalState.installationInProgress = false;
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    log.error(errorResponse);
    if (res) {
      res.write(serviceHelper.ensureString(errorResponse));
      if (res.flush) res.flush();
    }

    if (!test) {
      const removeStatus = messageHelper.createErrorMessage(`Error occured. Initiating Flux App ${appSpec.name} removal`);
      log.info(removeStatus);
      if (res) {
        res.write(serviceHelper.ensureString(removeStatus));
        if (res.flush) res.flush();
      }
      const onStatus = res ? (msg) => { res.write(serviceHelper.ensureString(msg)); if (res.flush) res.flush(); } : undefined;
      await appUninstaller.uninstallApplication(appSpec.name, { forceKill: true, skipGuard: true, broadcastRemoval: sendRemovalMessage, onStatus });
      log.info(`Cleanup completed for ${appSpec.name} after installation failure`);
    }

    return false;
  } finally {
    if (test) {
      try {
        await appUninstaller.uninstallApplication(appSpec.name, { forceKill: true, skipGuard: true });
        log.info(`Test cleanup completed for ${appSpec.name}`);
      } catch (cleanupError) {
        log.error(`Error during test cleanup for ${appSpec.name}: ${cleanupError.message}`);
      }
    }
  }
  return true;
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
 * Install application (hard installation with Docker)
 * @param {object} appSpec - App specifications or component specifications
 * @param {string} appName - Application name
 * @param {boolean} isComponent - Whether this is a component
 * @param {object} res - Response object
 * @param {object} fullAppSpecs - Full app specifications
 * @param {boolean} test - Whether this is a test installation
 * @returns {Promise<void>} Installation result
 */
async function installComponent(component, options = {}) {
  const onStatus = options.onStatus || null;
  const test = options.test || false;
  const createVolumes = options.createVolumes || false;
  const burstEligible = options.burstEligible || false;
  const extraEnv = options.extraEnv || [];
  const syslogTarget = options.syslogTarget || null;
  const specVersion = options.specVersion || null;

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

  if (component.imageAuth && specVersion) {
    const credentials = await registryCredentialHelper.getCredentials(
      component.image,
      component.imageAuth,
      specVersion,
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
    await verifyAppVolumeMount(appName, id !== appName, component.name);
    status(`Volume mount verified for ${id}`);
  }

  status(`Creating ${id}...`);
  await dockerService.appDockerCreate(component, {
    test,
    burstEligible,
    extraEnv,
    syslogTarget,
  });

  if (test || !component.hasActiveStandbySyncthing()) {
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
async function installAppLocally(req, res) {
  try {
    // appname can be app name or app hash of specific app version
    let { appname } = req.params;
    appname = appname || req.query.appname;

    if (!appname) {
      throw new Error('No Flux App specified');
    }
    let blockAllowance = config.fluxapps.ownerAppAllowance;
    // needs to be logged in
    const authorized = await verificationHelper.verifyPrivilege('user', req);
    if (authorized) {
      let appSpec;
      // anyone can deploy temporary app
      // favor temporary to launch test temporary apps
      const tempMessage = await checkAppTemporaryMessageExistence(appname);
      if (tempMessage) {
        // eslint-disable-next-line prefer-destructuring
        appSpec = tempMessage.appSpec;
        // blockAllowance is used for future validation
        // eslint-disable-next-line no-unused-vars
        blockAllowance = config.fluxapps.temporaryAppAllowance;
      }
      if (!appSpec) {
        // only owner can deploy permanent message or existing app
        const ownerAuthorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);
        if (!ownerAuthorized) {
          const errMessage = messageHelper.errUnauthorizedMessage();
          res.json(errMessage);
          return;
        }
      }
      if (!appSpec) {
        const allApps = await availableApps();
        appSpec = allApps.find((app) => app.name === appname);
      }
      if (!appSpec) {
        // eslint-disable-next-line no-use-before-define
        appSpec = await getApplicationGlobalSpecifications(appname);
      }
      // search in permanent messages for the specific apphash to launch
      if (!appSpec) {
        const permMessage = await checkAppMessageExistence(appname);
        if (permMessage) {
          // eslint-disable-next-line prefer-destructuring
          appSpec = permMessage.appSpec;
        }
      }
      if (!appSpec) {
        throw new Error(`Application Specifications of ${appname} not found`);
      }

      const installSpec = await resolveSpec(appSpec);
      if (!installSpec) throw new Error('Could not deserialize app specifications');

      const dbopen = dbHelper.databaseConnection();
      if (!appSpec.height && appSpec.height !== 0) {
        // precaution for old temporary apps. Set up for custom test specifications.
        const database = dbopen.db(config.database.daemon.database);
        const query = { generalScannedHeight: { $gte: 0 } };
        const projection = {
          projection: {
            _id: 0,
            generalScannedHeight: 1,
          },
        };
        const result = await dbHelper.findOneInDatabase(database, scannedHeightCollection, query, projection);
        if (!result) {
          throw new Error('Scanning not initiated');
        }
        const explorerHeight = serviceHelper.ensureNumber(result.generalScannedHeight);
        appSpec.height = explorerHeight - config.fluxapps.blocksLasting + blockAllowance; // allow running for this amount of blocks
      }

      const appExists = await appsRepository.getInstalledAppRaw(appSpec.name, { name: 1 });
      if (appExists) { // double checked in installation process.
        throw new Error(`Application ${appname} is already installed`);
      }

      // eslint-disable-next-line no-use-before-define
      await checkAppRequirements(installSpec);

      res.setHeader('Content-Type', 'application/json');
      await installApplication(appSpec, { res });
    } else {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
    }
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
 * Check application requirements - validates hardware, static IP, nodes, and geolocation requirements
 * @param {object} appSpecs - Application specifications to check
 * @param {boolean} skipGeolocation - Whether to skip geolocation checks (useful for testing)
 * @param {boolean} skipStaticIp - Whether to skip static IP checks (useful for testing)
 * @param {boolean} skipHardware - Whether to skip hardware and nodes checks (useful for testing)
 * @returns {Promise<boolean>} True if requirements are met
 */
async function checkAppRequirements(appSpecs, skipGeolocation = false, skipStaticIp = false, skipHardware = false) {
  // appSpecs has hdd, cpu and ram assigned to correct tier
  if (!skipHardware) {
    await hwRequirements.checkAppHWRequirements(appSpecs);
  }

  if (!skipStaticIp) {
    hwRequirements.checkAppStaticIpRequirements(appSpecs);
  }

  if (!skipHardware) {
    await hwRequirements.checkAppNodesRequirements(appSpecs);
  }

  if (!skipGeolocation) {
    await hwRequirements.checkAppGeolocationRequirements(appSpecs);
  }

  return true;
}

/**
 * Test application installation - Similar to installAppLocally but for testing with reduced resource requirements
 * @param {object} req - Request object containing appname in params or query
 * @param {object} res - Response object
 * @returns {Promise<void>}
 */
async function testAppInstall(req, res) {
  try {
    // appname can be app name or app hash of specific app version
    let { appname } = req.params;
    appname = appname || req.query.appname;

    if (!appname) {
      throw new Error('No Flux App specified');
    }

    log.info(`testAppInstall: ${appname}`);
    let blockAllowance = config.fluxapps.ownerAppAllowance;

    // needs to be logged in
    const authorized = await verificationHelper.verifyPrivilege('user', req);
    if (authorized) {
      let appSpec;

      // anyone can deploy temporary app
      // favor temporary to launch test temporary apps
      const tempMessage = await checkAppTemporaryMessageExistence(appname);
      if (tempMessage) {
        // eslint-disable-next-line prefer-destructuring
        appSpec = tempMessage.appSpec;
        // blockAllowance is used for future validation
        // eslint-disable-next-line no-unused-vars
        blockAllowance = config.fluxapps.temporaryAppAllowance;
      }

      if (!appSpec) {
        // only owner can deploy permanent message or existing app
        const ownerAuthorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);
        if (!ownerAuthorized) {
          const errMessage = messageHelper.errUnauthorizedMessage();
          res.json(errMessage);
          return;
        }
      }

      if (!appSpec) {
        const allApps = await availableApps();
        appSpec = allApps.find((app) => app.name === appname);
      }

      if (!appSpec) {
        appSpec = await getApplicationGlobalSpecifications(appname);
      }

      // search in permanent messages for the specific apphash to launch
      if (!appSpec) {
        const permMessage = await checkAppMessageExistence(appname);
        if (permMessage) {
          // eslint-disable-next-line prefer-destructuring
          appSpec = permMessage.appSpec;
        }
      }

      if (!appSpec) {
        throw new Error(`Application Specifications of ${appname} not found`);
      }

      const testSpec = await resolveSpec(appSpec);
      if (!testSpec) throw new Error('Could not deserialize app specifications');
      appSpec = testSpec.serialize();

      await checkAppRequirements(testSpec, true, true, true);

      res.setHeader('Content-Type', 'application/json');

      const localArch = await systemArchitecture();

      const componentArchitectures = [];
      for (const [name, comp] of testSpec.componentEntries()) {
        // eslint-disable-next-line no-await-in-loop
        const repoVerification = await verifyRepository(comp.image, {
          repoauth: comp.imageAuth || null,
          specVersion: testSpec.version,
          appName: testSpec.name,
          architecture: localArch,
        });
        componentArchitectures.push({
          name,
          architectures: repoVerification.supportedArchitectures,
        });
      }

      // Calculate common architectures across all components
      const commonArchitectures = findCommonArchitectures(componentArchitectures);

      // If local architecture is not in common architectures, skip Docker operations
      if (!commonArchitectures.includes(localArch)) {
        // Write an initial status message
        const initMessage = {
          status: 'Checking architecture compatibility...',
        };
        res.write(serviceHelper.ensureString(initMessage));
        if (res.flush) res.flush();

        // Write the skip message
        const successMessage = {
          status: `Test installation validation passed. Installation skipped due to architecture incompatibility: this node is ${localArch} but app requires [${commonArchitectures.join(', ')}]`,
        };
        res.write(serviceHelper.ensureString(successMessage));
        res.end();
        return;
      }

      await installApplication(appSpec, { res, test: true });
    } else {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
    }
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
  installApplication,
  installComponent,
  installAppLocally,
  checkAppRequirements,
  testAppInstall,
};
