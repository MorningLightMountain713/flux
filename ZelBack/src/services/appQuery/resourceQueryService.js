// Resource Query Service - Query functions for app and node resource usage
const messageHelper = require('../messageHelper');
const appsRepository = require('../appDatabase/appsRepository');
const hwRequirements = require('../appRequirements/hwRequirements');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const admissionControl = require('../utils/admissionControl');
const log = require('../../lib/log');

// Import appQueryService to avoid circular dependency (will be cleaned up later)
const appQueryService = require('./appQueryService');

/**
 * Get application usage statistics
 * @param {object} req Request.
 * @param {object} res Response.
 * @returns {object} Message.
 */
async function fluxUsage(req, res) {
  try {
    const totalApps = await appsRepository.countInstalledApps();
    const runningApps = await appQueryService.listRunningApps();
    const totalRunning = runningApps.data ? runningApps.data.length : 0;

    // Ensure node specs are loaded before accessing them
    const nodeSpecs = await hwRequirements.getNodeSpecs();

    const usage = {
      totalApps,
      runningApps: totalRunning,
      stoppedApps: totalApps - totalRunning,
      nodeSpecs,
    };

    const dataResponse = messageHelper.createDataMessage(usage);
    return res ? res.json(dataResponse) : dataResponse;
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    return res ? res.json(errorResponse) : errorResponse;
  }
}

/**
 * What this node has committed to the applications it holds, and which of them it
 * could not read.
 *
 * An enterprise app is stored locally with its components emptied - they are the
 * customer's decrypted configuration and do not belong in a local database - so
 * counting the stored row directly credits that app with no cpu, no memory and
 * no disk at all, including the fixed overhead every component carries. It is
 * not skipped by a rule: it takes the ordinary path, finds an empty list and
 * adds nothing. That total is what the node subtracts from its own capacity
 * before accepting another app, so a node holding enterprise apps believes it
 * is emptier than it is and keeps taking work it cannot run.
 *
 * So the specifications are decrypted first, through the cached path: it keys on
 * the spec hash, shares one attempt between concurrent callers and remembers a
 * failure briefly, none of which the raw decrypt does - and this is reached from
 * two public endpoints, so a decrypt per caller would be an amplifier into
 * fluxbenchd. Unformatted, because the formatter strips the hash the cache keys
 * on and nothing here reads a formatted field.
 *
 * `unreadable` is the names it could not decrypt, and it is the reason this
 * returns two things rather than three numbers. An app whose components cannot
 * be read contributes nothing, which is indistinguishable from an app that
 * reserves nothing - the caller has to be able to tell those apart, because one
 * of them means this node cannot account for itself. It does not leave the
 * process: the API halves publish the totals alone.
 *
 * @returns {object} Message carrying {appsCpusLocked, appsRamLocked, appsHddLocked, unreadable}
 */
async function appsResources() {
  log.info('Checking appsResources');
  try {
    const installed = await appsRepository.listInstalledApps();
    const deployments = await deploymentProvider.listInstalledDeployments();
    // An app whose deployment could not be built (its components are inside a
    // blob this node cannot read) is absent from `deployments`, not zero-sized:
    // it is named, so the caller can tell unaccountable from unused.
    const built = new Set(deployments.map((deployment) => deployment.appName));
    const unreadable = installed.filter((inst) => !built.has(inst.name));
    let appsCpusLocked = 0;
    let appsRamLocked = 0;
    let appsHddLocked = 0;

    // eslint-disable-next-line no-restricted-syntax
    for (const deployment of deployments) {
      const { cpu, memoryMb: memory } = deployment.resourceTotals();
      appsCpusLocked += cpu;
      appsRamLocked += memory;
      // Full host-disk footprint per app: persistent storage + rootFsGb + swapGb
      // across components. Legacy specs report 10/2 per component, matching the old
      // flat (hddFileSystemMinimum + defaultSwap) * componentCount overhead.
      appsHddLocked += deployment.reservableHostDiskGb();
    }
    // Add in-flight admissions: apps that passed resource admission but have not yet
    // landed in the DB (the check->insertInstalledApp window). Without this a
    // concurrent install of a different app would not see them and could double-admit.
    const inflight = admissionControl.pendingResources();
    appsCpusLocked += inflight.cpu;
    appsRamLocked += inflight.memory;
    appsHddLocked += inflight.hdd;
    const appsUsage = {
      appsCpusLocked,
      appsRamLocked,
      appsHddLocked,
      unreadable: unreadable.map((app) => app.name),
    };
    return messageHelper.createDataMessage(appsUsage);
  } catch (error) {
    log.error(error);
    return messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
  }
}

/**
 * The applications this node holds but cannot size.
 *
 * One whose specification cannot be read contributes nothing to the totals,
 * which is indistinguishable from one that reserves nothing - so a decision that
 * subtracts those totals from the node's capacity believes space is free that is
 * already spoken for.
 *
 * Offered rather than enforced here, because the answer differs by caller.
 * Taking on NEW work while this is non-empty over-commits the node. Maintaining
 * work it already holds does not: a redeploy of an app already counted adds
 * nothing, and refusing there would freeze every other application on the node
 * over one it cannot read.
 *
 * @param {object} response - what appsResources answered with
 * @returns {string[]} the names, empty when the totals account for everything
 */
function unaccountedApps(response) {
  if (response.status !== 'success') return [];

  return response.data.unreadable || [];
}

/**
 * The committed totals, and nothing else.
 *
 * Three numbers, node-wide, exactly as this has always answered. `unreadable`
 * stops here: the names are already public on chain, but "this node is holding an
 * application it cannot read" is a statement about the node's health that nobody
 * outside it needs.
 *
 * @param {object} req Request.
 * @param {object} res Response.
 * @returns {Promise<void>}
 */
async function appsResourcesApi(req, res) {
  const response = await appsResources();

  if (response.status === 'error') {
    res.json(response);
    return;
  }

  const { appsCpusLocked, appsRamLocked, appsHddLocked } = response.data;
  res.json(messageHelper.createDataMessage({ appsCpusLocked, appsRamLocked, appsHddLocked }));
}

/**
 * The same three numbers, for a caller inside this process that publishes them.
 * @param {object} usage - what appsResources answered with
 * @returns {object} {appsCpusLocked, appsRamLocked, appsHddLocked}
 */
function publicResourceView(usage) {
  const { appsCpusLocked, appsRamLocked, appsHddLocked } = usage;

  return { appsCpusLocked, appsRamLocked, appsHddLocked };
}

module.exports = {
  fluxUsage,
  appsResources,
  unaccountedApps,
  appsResourcesApi,
  publicResourceView,
};
