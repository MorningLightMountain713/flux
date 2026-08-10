'use strict';

// Renewal sweep for platform-managed backend-TLS certificates.
//
// The leaf an app serves lives for 30 days, so it has to be replaced on a TIMER
// rather than on redeploy: an app can run for months without one, and an expired
// leaf fails FDM's verify:required check, taking the backend down. The sweep
// re-issues any cert inside its renewal window (and any that is missing entirely,
// which is what heals a node whose install-time provisioning failed), writes it
// atomically over the old one, and fires the owner's reload reaction.
//
// Zero downtime comes from the two-cert model: both the old and the new leaf
// chain to the same permanent per-app CA, so FDM keeps accepting the backend
// throughout, and replicas - each with its own keypair and its own staggered
// clock - renew independently of one another.
const config = require('config');
const log = require('../../lib/log');
const dockerService = require('../dockerService');
const appQueryService = require('../appQuery/appQueryService');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const operationRegistry = require('../utils/operationRegistry');
const backendTlsService = require('./backendTlsService');

/**
 * Run the owner's reload reaction for a component whose cert was just replaced.
 * `{action:'restart'}` recreates the process, `{action:'signal'}` sends the
 * chosen signal (SIGHUP by default) to PID 1, and `null` means the app watches
 * the files itself and wants no interference.
 *
 * Best-effort by design: the cert is already on disk and is read on the next
 * start regardless, so a failed reaction (most commonly a container that is not
 * running) must never turn into a failed renewal.
 *
 * @param {Object} deployComp a resolved DeploymentComponent
 * @param {Object} deps - { signal, restart }
 * @returns {Promise<string>} the reaction taken
 */
async function fireReload(deployComp, deps = {}) {
  const {
    signal = dockerService.appDockerSignal,
    restart = dockerService.appDockerRestart,
  } = deps;

  const reaction = backendTlsService.reloadReaction(deployComp.loadBalancing);
  if (!reaction) return 'none';

  try {
    if (reaction.action === 'restart') {
      await restart(deployComp.identifier);
      return 'restart';
    }
    if (reaction.action === 'signal') {
      await signal(deployComp.identifier, reaction.signal);
      return 'signal';
    }
  } catch (error) {
    log.warn(`backendTls: reload reaction for ${deployComp.identifier} failed (the new cert is on disk and is read on the next start) - ${error.message ?? error}`);
  }
  return 'none';
}

/**
 * Check every locally installed verify:required component and re-issue the ones
 * whose cert is missing, unreadable, or inside the renewal window.
 *
 * Per-component failure is isolated: one app whose CA is unreachable must not
 * stop the rest of the node's certs from being renewed.
 *
 * @param {Object} deps injection seam for tests
 * @returns {Promise<Object>} sweep summary
 */
async function renewalSweep(deps = {}) {
  const {
    listInstalled = appQueryService.installedApps,
    getDeployments = deploymentProvider.getInstalledDeployments,
    needsRenewal = backendTlsService.needsRenewal,
    provisionCert = backendTlsService.provisionCert,
    ...reactDeps
  } = deps;

  // Never renew across an install/remove/redeploy/reconcile: mid-operation a
  // component's containers and volumes are being rebuilt underneath us, and the
  // provisioner reissues on that path anyway. There are ~10 days of slack before
  // a cert actually expires, so waiting for the next pass costs nothing.
  if (operationRegistry.anyHeld()) {
    return { skipped: 'operation in flight' };
  }

  const installedRes = await listInstalled();
  if (installedRes.status !== 'success') {
    log.warn('backendTls: renewal sweep skipped - unable to list installed apps');
    return { skipped: 'installed list failed' };
  }

  let checked = 0;
  let renewed = 0;
  for (const app of installedRes.data) {
    // One deployment per identity installed here: co-located replicas each run
    // their own container with their own cert, so each needs its own check.
    // eslint-disable-next-line no-await-in-loop
    const deployments = await getDeployments(app.name);
    for (const deployment of deployments) {
      for (const [, deployComp] of deployment.componentEntries()) {
        if (!deployComp.requiresBackendTls()) continue;
        const tlsPaths = deployComp.backendTlsPaths();
        if (!tlsPaths) continue;
        checked += 1;
        // eslint-disable-next-line no-await-in-loop
        if (!await needsRenewal(tlsPaths)) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          await provisionCert(deployComp.appName, tlsPaths);
        } catch (error) {
          log.error(`backendTls: could not renew the certificate for ${deployComp.identifier} - ${error.message ?? error}`);
          continue;
        }
        renewed += 1;
        // eslint-disable-next-line no-await-in-loop
        const reaction = await fireReload(deployComp, reactDeps);
        log.info(`backendTls: renewed the certificate for ${deployComp.identifier} (reload: ${reaction})`);
      }
    }
  }

  return { checked, renewed };
}

let sweepRunning = false;

/**
 * Run the sweep single-flight and never throw: a renewal failure is logged and
 * picked up again on the next cadence.
 * @returns {Promise<Object|null>} sweep summary, or null (in flight / failed)
 */
async function runSweep() {
  if (sweepRunning) return null;
  sweepRunning = true;
  try {
    const result = await renewalSweep();
    return result;
  } catch (error) {
    log.error(`backendTls: renewal sweep failed - ${error.message ?? error}`);
    return null;
  } finally {
    sweepRunning = false;
  }
}

let started = false;

/**
 * Register the periodic renewal sweep. Dormant on a node with no verify:required
 * app: the pass is a database read plus a file read per managed cert, and most
 * nodes have none.
 */
function start() {
  if (started) return;
  started = true;

  const bootDelay = (ms) => Math.round(ms * config.fluxapps.bootDelayMultiplier);
  setTimeout(() => {
    runSweep();
    setInterval(runSweep, config.fluxapps.backendTlsRenewalIntervalMs);
  }, bootDelay(20 * 60 * 1000));
}

module.exports = {
  start,
  runSweep,
  renewalSweep,
  fireReload,
};
