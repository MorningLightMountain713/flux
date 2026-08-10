'use strict';

// Per-component provisioner: builds one component's container substrate — ports,
// image verify/pull, volumes, swap pool, image-size measurement, appDockerCreate,
// telemetry identity — and leaves it in Docker `created` for the reconciler to
// start.
// Extracted from appInstaller so the reconciler's recreate path
// (containerHealthMonitor) depends on this provisioner primitive rather than on the
// install orchestrator (installApplication). That breaks the appReconciler ->
// containerHealthMonitor -> appInstaller import cycle, letting appInstaller hand off
// to the reconciler directly. installComponent is a pure provisioner: it knows
// nothing of the reconciler or the operation registry.
const util = require('util');
const log = require('../../lib/log');
const dockerService = require('../dockerService');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const upnpService = require('../upnpService');
const { systemArchitecture } = require('../appRequirements/hwRequirements');
const { verifyRepository } = require('../appSecurity/imageManager');
const registryCredentialHelper = require('../utils/registryCredentialHelper');
const appVolumeService = require('./appVolumeService');
const appSwapPoolService = require('./appSwapPoolService');
const backendTlsService = require('./backendTlsService');
const volumeService = require('../utils/volumeService');
const telemetryIdentityService = require('../telemetryIdentityService');
const appsRuntimeState = require('../appManagement/appsRuntimeState');
const pendingTeardownStore = require('./pendingTeardownStore');
const meshReconciler = require('../appMesh/meshReconciler');
const { NodeCondition } = require('./nodeConditions');

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
    // The daemon does its own pull, so it needs the credentials regardless of
    // what the verification below does with them.
    pullConfig.authToken = `${credentials.username}:${credentials.password}`;
  }

  // Through verifyRepository rather than a verifier of our own: this used to
  // stand up a second ImageVerifier and repeat every registry round-trip the
  // submission gate had already made, cache and all. On a multi-component app
  // that was the whole verification pass a second time, for an answer already
  // held. The architecture argument keeps the "runs on THIS node" check.
  const result = await verifyRepository(component.image, {
    repoauth: component.imageAuth || null,
    appName: component.appName,
    architecture,
  });

  pullConfig.provider = result.provider;
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
 * @param {object} options - { owner, uuid, onStatus, createVolumes, skipPorts, burstEligible, restartPolicy, extraEnv }
 * @returns {Promise<void>}
 */
async function installComponent(component, options = {}) {
  const onStatus = options.onStatus || null;
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
  const abortSignal = options.abortSignal || null;
  // Recreate-only: when the registry cannot be REACHED (transient-class failure)
  // and the image is already on disk, create from the local copy instead of
  // failing - the container ran these exact bits minutes ago, and running them
  // through an outage beats sitting down until the registry heals. Fresh installs
  // never set this: they have no local copy to trust and defer instead.
  const allowLocalImageFallback = options.allowLocalImageFallback || false;
  const { owner } = options;
  // Which app INSTANCE this container belongs to. Unlike owner this is NOT
  // load-bearing yet and is absent for every app registered before identities
  // were minted, so it is stamped empty rather than refused.
  const { uuid } = options;
  // App-wide: does any component use a graceful-shutdown feature? Gates the
  // per-container budget labels (identity labels are always stamped). Travels on
  // the same channel as owner — computed once per app by the orchestrator.
  const requiresEncryption = options.requiresEncryption || false;

  // owner is load-bearing: flux-shutdownd keys each app's shutdown plan on it,
  // so a blank runonflux.owner label silently breaks drain/preStop at node
  // shutdown. Refuse rather than stamp an empty owner. Test installs are
  // ephemeral and carry no plan, so they are exempt.
  if (!owner) {
    throw new Error(`installComponent: owner required for ${component.identifier}`);
  }

  const id = component.identifier;
  const { appName } = component;

  const status = (msg) => {
    log.info(msg);
    if (onStatus) onStatus(msg);
  };

  if (!skipPorts) {
    status(`Allowing ${id} ports...`);
    await openHostPorts(component.hostPorts, appName, status);
  }

  try {
    const pullConfig = await verifyComponentImage(component);
    // Thread the install's abort signal so a concurrent cancel/removal of this app ends the
    // in-flight download (docker-modem >=5 makes the pull abortable).
    if (abortSignal) pullConfig.abortSignal = abortSignal;
    await dockerPullStreamPromise(pullConfig, onStatus ? { write: (data) => onStatus(data), flush: () => {} } : null);
    status(`Pulling ${id} was successful`);
  } catch (error) {
    // Pull-first keeps recreates fresh (a same-tag pull is a cheap manifest
    // check); the local image only substitutes when the registry is unreachable
    // AND the bits are already here - the stale-run window is exactly the
    // outage's duration, never a policy. Image-bad (permanent) failures rethrow.
    const localImagePresent = allowLocalImageFallback
      && error.registryErrorClass === 'transient'
      && await dockerService.appDockerImageSize(component.image) > 0;
    if (!localImagePresent) throw error;
    status(`Registry unreachable; recreating ${id} from the local image`);
  }

  // Post-pull backstop: a cancel that landed while/after the pull ran (the abort is then a
  // no-op) must not let us build a volume the cancel's teardown is about to rm -rf.
  await throwIfCancelledMidInstall(component);

  // A stateless component (persistentStorage.sizeGb 0) has no volume to build,
  // so there is also nothing to verify a mount for — verifyAppVolumeMount would
  // fail on the mountpoint that was deliberately never created.
  if (createVolumes && !component.isStateless) {
    await appVolumeService.createAppVolume(component, onStatus ? { write: (data) => onStatus(data), flush: () => {} } : null);

    status(`Verifying volume mount for ${id}...`);
    await volumeService.verifyAppVolumeMount(id);
    status(`Volume mount verified for ${id}`);
  }

  // Ensure the dedicated app-swap pool covers all installed apps' swap before the
  // container is created, so its memory.swap.max has live backing. Idempotent; a
  // no-op on nodes without the new-mechanism host config.
  await appSwapPoolService.reconcile();
  // Measure the pulled image's on-disk size so the writable-layer (StorageOpt) cap
  // can be rootFsGb - imageSize for v9. 0 (inspect failed) falls back to full rootFsGb.
  const measuredImageSizeBytes = await dockerService.appDockerImageSize(component.image);
  // Invariant backstop, not the gate: registration measures the decompressed size
  // from the registry and refuses a spec that cannot fit, so reaching this means
  // the two disagree. Version-blind (legacy is never charged); 0 (inspect failed)
  // skips so create still proceeds.
  if (measuredImageSizeBytes && !component.imageFitsRootFs(measuredImageSizeBytes)) {
    throw new Error(
      `Component '${component.name}' image (${component.image}) is ${(measuredImageSizeBytes / 1e9).toFixed(2)}GB on disk, `
      + `which exceeds its rootFsGb budget of ${component.rootFsGb}GB. `
      + 'A spec this image cannot fit should not have passed registration.',
    );
  }
  // Platform-managed backend TLS: a verify:required component serves HTTPS from a
  // cert this node issues, delivered as files in the reserved /io.runonflux/tls/
  // mount (materialized by flux-spec, created by the volume pass above). Write it
  // before the container is created so the app finds it at its very first start.
  // This is the single container-creation funnel, so every path that can recreate
  // a container - fresh install, redeploy, spec update, health recreate - reissues
  // here; a rebuild wipes the volume, and this is what puts the cert back.
  //
  // A failure here ABORTS the install. Without the cert the app cannot serve the
  // HTTPS its spec promises, and FDM's verify:required fails closed - so starting
  // anyway produces a container that is up, counted by peers as a live instance,
  // and serving nothing, which nothing will ever re-place. Failing instead lets
  // the app land on a node that can provision it. The BACKEND_TLS_UNAVAILABLE code
  // tags this as a NODE condition, so appInstaller defers (retry next cycle)
  // rather than broadcasting it to the network as a verdict on the app itself.
  if (component.requiresBackendTls()) {
    const tlsPaths = component.backendTlsPaths();
    if (!tlsPaths) {
      // Both answers come from the same resolved component, so disagreement is a
      // plumbing defect, not a node condition: fail outright rather than retry.
      throw new Error(`${id} requires a managed backend-TLS cert but has no platform TLS mount`);
    }
    status(`Provisioning backend TLS certificate for ${id}...`);
    try {
      await backendTlsService.provisionCert(appName, tlsPaths);
    } catch (error) {
      throw Object.assign(
        new Error(`Could not provision the backend-TLS certificate for ${id}: ${error.message}`),
        { code: NodeCondition.BACKEND_TLS_UNAVAILABLE },
      );
    }
  }

  // Mesh components are created with their presented address in the
  // environment and the mesh resolver chain, both fixed for the container's
  // lifetime — so the address must be assigned and the app's mesh runtime
  // ready before the container exists. The veth attach itself happens after
  // start (a created container has no network namespace yet); the reconciler's
  // converge pass plumbs it. A node that cannot ready the mesh runtime right
  // now (port pool contended, daemon catching up) is a NODE condition like
  // BACKEND_TLS_UNAVAILABLE: defer, never blame the app.
  let mesh = null;
  try {
    mesh = await meshReconciler.prepareComponentMesh(appName, component.name);
  } catch (error) {
    throw Object.assign(
      new Error(`Could not ready the mesh runtime for ${id}: ${error.message}`),
      { code: NodeCondition.MESH_UNAVAILABLE },
    );
  }
  if (mesh) status(`Mesh runtime ready for ${id} at ${mesh.presentedIp}`);

  // Pre-create backstop: re-check immediately before the container is created. A data
  // (r:/g:) app is provisioned only, so for an install this is the
  // last guard between volume-create and appDockerCreate against a racing cancel.
  await throwIfCancelledMidInstall(component);
  status(`Creating ${id}...`);
  await dockerService.appDockerCreate(component, {
    burstEligible,
    restartPolicy,
    extraEnv: mesh ? [...extraEnv, ...mesh.env] : extraEnv,
    ...(mesh && { dns: mesh.dns }),
    // Mesh identity: the docker Hostname is the member name (what the app
    // reads to learn who it is), and the component name rides as a network
    // alias so sibling components keep resolving plain `<component>`.
    ...(mesh?.hostname && { hostname: mesh.hostname }),
    ...(mesh?.aliases && { networkAliases: mesh.aliases }),
    owner,
    uuid,
    requiresEncryption,
    measuredImageSizeBytes,
  });

  // Set the log ACL and announce identity to flux-telemetryd before the
  // container starts (Arcane-only; no-op for non-telemetry apps).
  await telemetryIdentityService.onComponentCreated(component);

  // The container is left in Docker 'created' and the reconciler is the sole
  // starter (installApplication enqueues + awaits its convergence). holdStart is
  // gone — the activeStandby/sync-before-start hold is already the reconciler's
  // controllerDesired -> awaitingController gate.
}

module.exports = {
  installComponent,
  openHostPorts,
  verifyComponentImage,
};
