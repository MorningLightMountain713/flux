const log = require('../../lib/log');
const componentProvisioner = require('../appLifecycle/componentProvisioner');
const appVolumeService = require('../appLifecycle/appVolumeService');
const syncthingMonitorHelpers = require('./syncthingMonitorHelpers');
const appsRepository = require('../appDatabase/appsRepository');
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
 * @param {{abortSignal?: AbortSignal, allowVolumeCreation?: boolean}} [options]
 */
async function recreateMissingContainers(componentIdentifier, { abortSignal = null, allowVolumeCreation = true } = {}) {
  const mainAppName = componentIdentifier.split('_')[1] || componentIdentifier;
  const instantiated = await appsRepository.getInstalledApp(mainAppName);
  if (!instantiated) {
    throw new Error(`App ${mainAppName} not found in local database`);
  }

  const deployment = await deploymentProvider.buildDeployment(instantiated);

  // A container can only be (re)created onto an existing docker network, but the
  // per-app network (fluxDockerNetwork_<app>) is otherwise created only at install
  // time (registerAppLocally). If it was pruned - docker prune, daemon restart -
  // every recreate below would loop forever on "network not found". Recreate it
  // first; ensureAppDockerNetwork returns early (no create, no firewall work) when
  // the network already exists, so the common intact-network recreate stays cheap.
  await appInstaller.ensureAppDockerNetwork(mainAppName);

  // Recompute the app-wide feature gate so a recreated container keeps its budget
  // labels (identity labels are always stamped) — never silently downgraded.
  const requiresEncryption = shutdownPlan.appRequiresDaemonShutdown(deployment);
  const isComponent = componentIdentifier.includes('_');
  const componentName = isComponent ? componentIdentifier.split('_')[0] : null;
  const components = componentName
    ? [[componentName, deployment.getComponent(componentName)]]
    : deployment.componentEntries();

  for (const [, deployComp] of components) {
    if (!deployComp) {
      throw new Error(`Component ${componentName} not found in app ${mainAppName}`);
    }
    let volumeMounted = false;
    try {
      volumeMounted = await verifyAppVolumeMount(mainAppName, true, deployComp.name);
    } catch {
      // volume not mounted
    }
    if (volumeMounted) {
      // Soft recreate reuses the mounted volume; a bind-mount source can have
      // vanished while the container was down (e.g. Syncthing pruning a replicated
      // subdir), and Docker's Mounts API errors on a missing source rather than
      // creating it, so remake them first. (Hard recreate skips this: createAppVolume
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
    if (!volumeMounted && !allowVolumeCreation) {
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
