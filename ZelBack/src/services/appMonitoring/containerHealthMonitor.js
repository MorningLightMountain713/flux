const log = require('../../lib/log');
const componentProvisioner = require('../appLifecycle/componentProvisioner');
const appVolumeService = require('../appLifecycle/appVolumeService');
const syncthingMonitorHelpers = require('./syncthingMonitorHelpers');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const shutdownPlan = require('../appLifecycle/shutdownPlan');
const { verifyAppVolumeMount } = require('../utils/volumeService');


/**
 * Recreates the container(s) for an app/component from its installed spec.
 *
 * allowVolumeCreation: whether a component whose data volume cannot be verified
 * as mounted may have its volume (re)created (installComponent createVolumes,
 * which fallocates + mke2fs's the volume file — i.e. REFORMATS the app's data).
 * That is acceptable when recreating a container that is gone and whose volume
 * is genuinely unverifiable, but it is catastrophic for a caller that
 * deliberately removed a live container whose data was intact (the
 * network-detach heal): a transient verifyAppVolumeMount failure would wipe the
 * user's data. Such callers pass false and get a throw instead, so they can
 * retry rather than reformat.
 *
 * @param {string} componentIdentifier
 * @param {object|null} instantiated - InstantiatedSpec of the app that owns this
 *   component, resolved by the caller. Taken rather than looked up: this used to
 *   recover the app by splitting the identifier, which yields the APP-IDENTITY
 *   SEGMENT and not a name — the two coincide only for an app whose identity was
 *   borrowed from its name. The reconciler has already resolved the app for the
 *   pass that got here, so asking again could also answer differently.
 * @param {{abortSignal?: AbortSignal, allowVolumeCreation?: boolean}} [options]
 */
async function recreateMissingContainers(componentIdentifier, instantiated, { abortSignal = null, allowVolumeCreation = true } = {}) {
  if (!instantiated) {
    throw new Error(`App for ${componentIdentifier} not found in local database`);
  }
  const mainAppName = instantiated.name;
  const identity = instantiated.identity ?? mainAppName;

  // The app's docker network is a precondition of the recreate below, and the
  // reconciler guarantees it before reaching any path that runs a container -
  // this one included. Deliberately not re-ensured here: two owners of the same
  // guarantee is how they drift apart.

  // Every identity installed here. The deployment layer minted these
  // identifiers, so it is also the authority on which one an identifier names:
  // an exact match, never a string parse. That keeps this module off the sync
  // spec-backend bridge, which only resolves once something else has warmed it
  // — a dependency this entry point (health monitor, network heal) has no way
  // to guarantee, since it is not on the reconciler's boot path.
  const deployments = await deploymentProvider.installedDeployments(instantiated);
  let matched = null;
  for (const deployment of deployments) {
    const component = deployment.componentForIdentifier(componentIdentifier);
    if (component) {
      matched = { deployment, component };
      break;
    }
  }


  let components;
  let requiresEncryption;
  if (matched) {
    // A qualified identifier recreates exactly that replica's container, with
    // its own ports and env. Recompute the app-wide feature gate so a recreated
    // container keeps its budget labels — never silently downgraded.
    requiresEncryption = shutdownPlan.appRequiresDaemonShutdown(matched.deployment);
    components = [[matched.component.name, matched.component]];
  } else if (componentIdentifier === identity) {
    // An APP-level identifier (the bare identity, no component segment)
    // recreates every installed identity's containers.
    requiresEncryption = deployments.length > 0 && shutdownPlan.appRequiresDaemonShutdown(deployments[0]);
    components = deployments.flatMap((deployment) => deployment.componentEntries());
  } else {
    throw new Error(`Component ${componentIdentifier} not found in app ${mainAppName}`);
  }

  for (const [, deployComp] of components) {
    let volumeMounted = false;
    try {
      volumeMounted = await verifyAppVolumeMount(deployComp.identifier);
    } catch {
      // volume not mounted
    }
    if (volumeMounted) {
      // A recreate that keeps the volume remounts it; a bind-mount source can have
      // vanished while the container was down (e.g. Syncthing pruning a replicated
      // subdir), and Docker's Mounts API errors on a missing source rather than
      // creating it, so remake them first. (A rebuild skips this: createAppVolume
      // makes the sources after it mounts the fresh volume.) ensureMountSourcesExist
      // is race-free internally, but a residual TOCTOU remains — installComponent
      // pulls the image before appDockerCreate binds, so a re-prune in that window
      // still fails the create and can escalate to removal. Fully closing it needs a
      // rearchitect (pruner coordination / sources outside the synced tree).
      const stignoreChanged = await appVolumeService.ensureMountSourcesExist(deployComp);
      if (stignoreChanged) {
        await syncthingMonitorHelpers.requestFolderScan(deployComp.identifier);
      }
    }
    // A stateless component has no volume by design, so "not mounted" is its
    // correct steady state rather than a reason to refuse the recreate — the
    // guard exists to avoid silently reformatting data, and there is none.
    if (!volumeMounted && !deployComp.isStateless && !allowVolumeCreation) {
      throw new Error(`Cannot recreate ${componentIdentifier} without creating (reformatting) its data volume: the volume for ${mainAppName} could not be verified as mounted`);
    }
    await componentProvisioner.installComponent(deployComp, {
      createVolumes: !volumeMounted, owner: instantiated.owner, requiresEncryption, abortSignal, allowLocalImageFallback: true,
    });
  }

  log.info(`Successfully recreated missing containers for ${componentIdentifier}`);
}

module.exports = {
  recreateMissingContainers,
};
