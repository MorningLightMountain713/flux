// Per-component provisioner: builds one component's container substrate — ports,
// image verify/pull, volumes, swap pool, image-size measurement, appDockerCreate,
// telemetry identity — and leaves it in Docker `created` for the reconciler to
// start (a `test` install is the one exception: it starts inline + health-checks).
// Extracted from appInstaller so the reconciler's recreate path
// (containerHealthMonitor) depends on this provisioner primitive rather than on the
// install orchestrator (installApplication). That breaks the appReconciler ->
// containerHealthMonitor -> appInstaller import cycle, letting appInstaller hand off
// to the reconciler directly. installComponent is a pure provisioner: it knows
// nothing of the reconciler or the operation registry.
const util = require('util');
const config = require('config');
const log = require('../../lib/log');
const serviceHelper = require('../serviceHelper');
const dockerService = require('../dockerService');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const upnpService = require('../upnpService');
const { systemArchitecture } = require('../appRequirements/hwRequirements');
const imageVerifier = require('../utils/imageVerifier');
const registryCredentialHelper = require('../utils/registryCredentialHelper');
const appVolumeService = require('./appVolumeService');
const appSwapPoolService = require('./appSwapPoolService');
const volumeService = require('../utils/volumeService');
const telemetryIdentityService = require('../telemetryIdentityService');
const appsRuntimeState = require('../appManagement/appsRuntimeState');
const pendingTeardownStore = require('./pendingTeardownStore');

const dockerPullStreamPromise = util.promisify(dockerService.dockerPullStream);

const supportedArchitectures = ['amd64', 'arm64'];

/**
 * Cancel-during-install backstop. The abortable image pull closes the in-pull window;
 * this closes the gaps AFTER it — before the volume is created and again before the
 * container is created — so an install can never build a volume/container that a
 * concurrent cancel's teardown is about to rm -rf. A cancel/removal of this app condemns
 * its components and writes a durable owed-teardown doc the moment its prelude runs.
 * teardownOwedFor is the robust signal (the install cannot erase it) and fails CLOSED
 * (a read blip aborts rather than races a live rm -rf); isCondemned is a fail-OPEN
 * secondary (a blip returns false, never a spurious abort). Read-only and idempotent: a
 * no-op on every normal install (this app's own teardown cleared its doc at finish, and
 * the install passed the teardown-owed interlock at entry).
 * @param {object} component deployment component being provisioned
 */
async function throwIfCancelledMidInstall(component) {
  const owed = await pendingTeardownStore.teardownOwedFor(component.appName);
  if (owed || await appsRuntimeState.isCondemned(component.identifier)) {
    throw new Error(`Install of ${component.identifier} aborted: a removal/cancel of ${component.appName} arrived mid-install`);
  }
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
          status: `Orbit initial test passed for ${id}`,
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
 * Verify a component's image is usable on this node WITHOUT pulling it: checks the
 * node architecture, then the registry manifest for whitelist/arch/max-size/pullability
 * (credentials applied for private registries). Throws on a deterministic "this image
 * is broken/unusable" failure (bad ref, deleted tag, non-whitelisted, unsupported arch,
 * oversize). Returns the prepared pullConfig so installComponent can do the actual pull.
 *
 * Used as a redeploy/reconcile PRE-FLIGHT (before tearing the old version down) so a
 * broken update aborts with the old version still running. Cheap: a manifest check, no
 * layer download — so it adds no transient disk pressure.
 *
 * @param {object} component - DeploymentComponent
 * @returns {Promise<object>} pullConfig for dockerPullStreamPromise
 */
async function verifyComponentImage(component) {
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
      component.appName,
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
  return pullConfig;
}

/**
 * Open an app's host ports on the firewall (ufw) and the router (UPnP). The same leaf
 * the install path uses, also called by a redeploy's port-delta reconcile to open only
 * the added ports. Host/router state outlives a container, so it is independent of the
 * container lifecycle. Throws on the first port that fails to open or map.
 * @param {number[]} ports - host ports to open
 * @param {string} appName - app name (the UPnP mapping description key)
 * @param {Function|null} [status] - optional per-port progress callback
 */
async function openHostPorts(ports, appName, status = null) {
  const firewallActive = await fluxNetworkHelper.isFirewallActive();
  const isUPNP = upnpService.isUPNP();
  // eslint-disable-next-line no-restricted-syntax
  for (const port of (ports || [])) {
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
    if (status) status(`Port ${port} OK`);
  }
}

/**
 * Install a single app component (pull image, create volume, create + start container).
 * @param {object} component - DeploymentComponent to install
 * @param {object} options - { owner, onStatus, test, createVolumes, skipPorts, burstEligible, restartPolicy, extraEnv, syslogTarget, crossAppLogCollector }
 * @returns {Promise<void>}
 */
async function installComponent(component, options = {}) {
  const onStatus = options.onStatus || null;
  const test = options.test || false;
  const createVolumes = options.createVolumes || false;
  // skipPorts: a redeploy keeps the running app's ufw/UPnP rules in place and reconciles
  // only the port delta itself, so the reinstall must NOT open this component's ports
  // (an unchanged port set would otherwise flap every rule). A fresh install leaves it
  // false and opens all ports. Only the ufw/UPnP open is skipped — the container still
  // gets its docker port bindings.
  const skipPorts = options.skipPorts || false;
  const burstEligible = options.burstEligible || false;
  const restartPolicy = options.restartPolicy || null;
  const extraEnv = options.extraEnv || [];
  const syslogTarget = options.syslogTarget || null;
  const crossAppLogCollector = options.crossAppLogCollector || null;
  const abortSignal = options.abortSignal || null;
  const { owner } = options;
  // App-wide: does any component use a graceful-shutdown feature? Gates the
  // per-container budget labels (identity labels are always stamped). Travels on
  // the same channel as owner — computed once per app by the orchestrator.
  const requiresEncryption = options.requiresEncryption || false;

  // owner is load-bearing: flux-shutdownd keys each app's shutdown plan on it,
  // so a blank runonflux.owner label silently breaks drain/preStop at node
  // shutdown. Refuse rather than stamp an empty owner. Test installs are
  // ephemeral and carry no plan, so they are exempt.
  if (!test && !owner) {
    throw new Error(`installComponent: owner required for ${component.identifier}`);
  }

  const id = component.identifier;
  const { appName } = component;

  const status = (msg) => {
    log.info(msg);
    if (onStatus) onStatus(msg);
  };

  if (!test && !skipPorts) {
    status(`Allowing ${id} ports...`);
    await openHostPorts(component.hostPorts, appName, status);
  }

  const pullConfig = await verifyComponentImage(component);
  // Thread the install's abort signal so a concurrent cancel/removal of this app ends the
  // in-flight download (docker-modem >=5 makes the pull abortable). null on a test install.
  if (abortSignal) pullConfig.abortSignal = abortSignal;
  await dockerPullStreamPromise(pullConfig, onStatus ? { write: (data) => onStatus(data), flush: () => {} } : null);
  status(`Pulling ${id} was successful`);

  // Post-pull backstop: a cancel that landed while/after the pull ran (the abort is then a
  // no-op) must not let us build a volume the cancel's teardown is about to rm -rf.
  if (!test) await throwIfCancelledMidInstall(component);

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
  // Pre-create backstop: re-check immediately before the container is created. A data
  // (r:/g:) app skips the test-only start block below, so for a real install this is the
  // last guard between volume-create and appDockerCreate against a racing cancel.
  if (!test) await throwIfCancelledMidInstall(component);
  status(`Creating ${id}...`);
  await dockerService.appDockerCreate(component, {
    test,
    burstEligible,
    restartPolicy,
    extraEnv,
    syslogTarget,
    crossAppLogCollector,
    owner,
    requiresEncryption,
    measuredImageSizeBytes,
  });

  // Set the log ACL and announce identity to flux-telemetryd before the
  // container starts (Arcane-only; no-op for non-telemetry apps).
  if (!test) {
    await telemetryIdentityService.onComponentCreated(component);
  }

  // A real install only PROVISIONS: the container is left in Docker 'created' and
  // the reconciler is the sole starter (installApplication enqueues + awaits its
  // convergence). holdStart is gone — the activeStandby/sync-before-start hold is
  // already the reconciler's controllerDesired -> awaitingController gate. Test
  // installs are synchronous and fail-fast: they start inline + run the orbit
  // health check and never hand off (a test that "passes" without ever starting a
  // container would be a false positive).
  if (test) {
    status(`Starting ${id}...`);
    const app = await dockerService.appDockerStart(id);
    if (!app) {
      throw new Error(`Failed to start ${id} container`);
    }
    status(`${id} started`);

    if (component.image?.startsWith('runonflux/orbit')) {
      const orbitHealth = await checkOrbitAppHealth(component, onStatus);
      if (!orbitHealth.passed) {
        throw new Error(`Orbit deployment failed: ${orbitHealth.reason}`);
      }
    }
  }
}

module.exports = {
  installComponent,
  openHostPorts,
  verifyComponentImage,
};
