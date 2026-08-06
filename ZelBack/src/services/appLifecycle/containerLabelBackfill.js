const dockerService = require('../dockerService');
const appsRepository = require('../appDatabase/appsRepository');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const appOperations = require('./appOperations');
const { getSpecBackend } = require('../utils/specLibs');
const log = require('../../lib/log');

// Restamp the containers that predate the identity label.
//
// Labels cannot be changed on a live container — Docker has no API for it — so a
// container created before the scheme shipped carries none, and every consumer that
// reads ownership or identity off a label has to keep a string-parsing fallback for
// it. The recreate that adds them moves no data: it re-derives every physical name
// identically, re-mounts the same volume and re-attaches the same syncthing folder
// id. The only difference in the new container is `Config.Labels`.
//
// There is no stored marker and no version. The condition IS the label's absence,
// so the pass is idempotent by construction: an interrupted run resumes, a run on a
// finished node does nothing, and the coverage figure is recomputed from Docker
// rather than remembered. Recording "this node is done" would be a second copy of a
// fact the container list already answers.
//
// It only ever restamps a container that is ALREADY STOPPED, so it never costs an
// app any downtime it was not already taking. That is not a compromise on coverage:
// FluxOS stamps every container it manages with RestartPolicy 'no', so after a host
// reboot nothing is running until the reconciler starts it, and this runs before
// that — one reboot restamps the whole node for free. An Arcane release reboots the
// host, so coverage advances fleet-wide on the release cadence rather than by
// disrupting anyone.

// A node with an unusual number of components must not spend its whole boot here:
// apps start after this returns, and the first apprunning broadcast is racing the
// running-location TTL. Whatever does not fit is still unlabelled next boot, which
// is exactly how the pass finds work anyway.
const BUDGET_NS = 2n * 60n * 1000n * 1000n * 1000n;

/**
 * The containers this node manages, found WITHOUT the identity label.
 *
 * Deliberately not `isManagedContainer`: its authoritative tier is the identity
 * label, which is exactly what this sweep looks for the absence of, so it would
 * exclude every container this exists to find. The name test is the only tier
 * available here, and it must cover `zel` as well as `flux` — the legacy fleet
 * carries that prefix, and counting only `flux` reports full coverage on a node
 * that has none.
 *
 * @param {object} labelKeys the label schema
 * @returns {Promise<{ours: object[], unlabelled: object[]}>}
 */
async function surveyContainers(labelKeys) {
  const containers = await dockerService.dockerListContainers(true);
  const ours = (containers || []).filter((container) => {
    const name = (container.Names?.[0] || '').replace(/^\//, '');
    return name.startsWith('flux') || name.startsWith('zel');
  });
  const unlabelled = ours.filter((container) => !(container.Labels && container.Labels[labelKeys.IDENTIFIER]));
  return { ours, unlabelled };
}

/**
 * How much of this node's container population carries the identity label.
 *
 * Answered from Docker every time rather than latched: coverage can go backwards
 * — a container recovered from another node arrives without labels — so a stored
 * "this node is done" could be wrong minutes after it was written. Surfaced on
 * /flux/info so the fleet can be surveyed: the name-parsing fallbacks every
 * consumer still carries can only be deleted once every node reports full
 * coverage, and without a number that decision has nothing to stand on.
 *
 * @returns {Promise<{labelled: number, total: number, covered: boolean}>}
 */
async function labelCoverage() {
  const { LABEL_KEYS } = await getSpecBackend();
  const { ours, unlabelled } = await surveyContainers(LABEL_KEYS);
  return {
    labelled: ours.length - unlabelled.length,
    total: ours.length,
    // A node with no containers is trivially covered: there is nothing carrying
    // an old name for a consumer to fall back on.
    covered: unlabelled.length === 0,
  };
}

/**
 * The app and component a label-less container belongs to, or null when nothing
 * installed claims it.
 *
 * A container without the label is one created before identities were minted, so
 * its identifier's identity segment IS the app name it was built from — the one
 * case where reading a name out of an identifier is sound, because no identity was
 * ever stated. It is still resolved through the installed row rather than trusted:
 * a name that no longer belongs to an installed app must be left alone, not acted
 * on. The component then states its own name, so nothing is parsed twice.
 *
 * @param {object} container a docker list entry
 * @returns {Promise<{appName: string, componentName: string}|null>}
 */
async function resolveContainer(container) {
  const name = (container.Names?.[0] || '').replace(/^\//, '');
  const identifier = dockerService.getBaseAppName(name);
  const { DeploymentSpec } = await getSpecBackend();
  const identity = DeploymentSpec.appNameFromIdentifier(identifier);

  const installed = await appsRepository.getInstalledAppByIdentity(identity);
  if (!installed) return null;

  const deployments = await deploymentProvider.getInstalledDeployments(installed.name);
  const comp = deployments
    .map((deployment) => deployment.componentForIdentifier(identifier))
    .find(Boolean);
  if (!comp) return null;

  return { appName: installed.name, componentName: comp.name };
}

/**
 * Restamp every label-less container on this node, one component at a time.
 *
 * Each component is redeployed with `createVolumes: false` — `true` reformats the
 * volume, and there is nothing wrong with the data here. The redeploy holds an
 * app-scoped lease for its whole duration, which is what keeps the reconciler from
 * reading the intermediate absence as a vanished container and recording a tamper
 * event: the removal is deliberate and already accounted for. A component whose app
 * is mid-operation is skipped rather than queued — `redeployComponent` declines a
 * held app — and the next boot finds it still unlabelled and tries again.
 *
 * @returns {Promise<{covered: boolean, labelled: number, total: number, restamped: string[], unresolved: string[], deferred: number}>}
 */
async function backfillContainerLabels() {
  const results = {
    covered: false, labelled: 0, total: 0, restamped: [], unresolved: [], deferred: 0,
  };

  try {
    const { LABEL_KEYS } = await getSpecBackend();
    const { ours, unlabelled } = await surveyContainers(LABEL_KEYS);

    results.total = ours.length;
    results.labelled = ours.length - unlabelled.length;

    if (unlabelled.length === 0) {
      results.covered = true;
      log.info(`containerLabelBackfill - ${results.labelled}/${results.total} containers carry the identity label; node is backfilled`);
      return results;
    }

    // Only what is already down. A running container would have to be stopped to be
    // relabelled, and no app should lose a second of uptime for a label — the reboot
    // that ships a release stops everything anyway, and this runs before they start.
    const stopped = unlabelled.filter((container) => container.State !== 'running');
    results.deferred = unlabelled.length - stopped.length;

    log.info(`containerLabelBackfill - ${results.labelled}/${results.total} containers carry the identity label; restamping ${stopped.length} stopped, leaving ${results.deferred} running`);

    if (stopped.length === 0) return results;

    // Resolved up front and de-duplicated: one redeploy covers a component in every
    // local identity, so a co-located pair must not be redeployed once per replica.
    const targets = new Map();
    for (const container of stopped) {
      const name = (container.Names?.[0] || '').replace(/^\//, '');
      // eslint-disable-next-line no-await-in-loop
      const target = await resolveContainer(container).catch((error) => {
        log.warn(`containerLabelBackfill - could not resolve ${name}: ${error.message}`);
        return null;
      });
      if (!target) {
        results.unresolved.push(name);
        continue;
      }
      targets.set(`${target.appName} ${target.componentName}`, target);
    }

    if (results.unresolved.length) {
      log.warn(`containerLabelBackfill - ${results.unresolved.length} container(s) claimed by no installed app, left alone: ${results.unresolved.join(', ')}`);
    }

    const deadlineNs = process.hrtime.bigint() + BUDGET_NS;
    for (const { appName, componentName } of targets.values()) {
      if (process.hrtime.bigint() >= deadlineNs) {
        // Said out loud: a silently truncated pass reads as "this node is done".
        log.warn(`containerLabelBackfill - boot budget spent with ${targets.size - results.restamped.length} component(s) still unlabelled; resuming next boot`);
        break;
      }
      try {
        log.info(`containerLabelBackfill - restamping ${componentName} of ${appName}`);
        // eslint-disable-next-line no-await-in-loop
        await appOperations.redeployComponent(appName, componentName, { createVolumes: false });
        results.restamped.push(`${componentName}_${appName}`);
      } catch (error) {
        log.error(`containerLabelBackfill - restamp of ${componentName} of ${appName} failed: ${error.message}`);
      }
    }

    log.info(`containerLabelBackfill - restamped ${results.restamped.length} component(s)`);
    return results;
  } catch (error) {
    log.error(`containerLabelBackfill - sweep failed: ${error.message}`);
    return results;
  }
}

module.exports = {
  backfillContainerLabels,
  labelCoverage,
  surveyContainers,
  resolveContainer,
};
