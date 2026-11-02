'use strict';

/*
 * appOperations — operations performed on an already-deployed app: redeploy,
 * global update broadcast, start/stop/restart, reconcile, force-removal,
 * active/standby coordination, backup/restore task append, test-app-mount, and
 * the installation/removal/restore in-progress state flags.
 *
 * WARNING: this is a grab-bag — loosely-related concerns that happen to sit above
 * the installer/uninstaller/docker primitives. It SHOULD be split along its real
 * seams: lifecycle commands (start/stop/restart/redeploy), the global update
 * intake, reconciliation, and the in-progress state tracker each belong in their
 * own module. Do not keep adding to it.
 */
const config = require('config');
const fs = require('node:fs/promises');
const log = require('../../lib/log');
const serviceHelper = require('../serviceHelper');
const messageHelper = require('../messageHelper');
const verificationHelper = require('../verificationHelper');
const daemonStatus = require('../daemonService/daemonStatus');
const fluxNetworkHelper = require('../fluxNetworkHelper');
// eslint-disable-next-line no-unused-vars
const upnpService = require('../upnpService');
const { assertSubmittableTimestamp } = require('../appMessaging/submittableTimestamp');
const { ipsMatch } = require('../utils/socketAddressUtils');
const appsRepository = require('../appDatabase/appsRepository');
const appRecords = require('../appDatabase/appRecords');
const appSpecHistory = require('../appDatabase/appSpecHistory');
const appDataEntries = require('../utils/appDataEntries');
const ingressAttestationService = require('../appMessaging/ingressAttestationService');
const ingressCapture = require('../utils/ingressCapture');
const { getSpec, assertUpdateInvariants } = require('../utils/specLibs');
const appEventVerifier = require('../appMessaging/appEventVerifier');
const placementFeasibility = require('../appPlacement/placementFeasibility');
const messageVerifier = require('../appMessaging/messageVerifier');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const appReconciler = require('../appMonitoring/appReconciler');
const syncthingMonitorHelpers = require('../appMonitoring/syncthingMonitorHelpers');
const syncthingFolderStateMachine = require('../appMonitoring/syncthingFolderStateMachine');
// Accessed through the module object, not destructured: a destructured binding
// is fixed at load and cannot be substituted, so the two-writer rule could not be
// exercised against a stated silence verdict.
const globalCommand = require('../appManagement/globalCommand');
const appVolumeService = require('./appVolumeService');
const volumeService = require('../utils/volumeService');
const appCaches = require('../utils/appCaches');
const fluxEventBus = require('../utils/fluxEventBus');
const appUninstaller = require('./appUninstaller');
const componentProvisioner = require('./componentProvisioner');
const owedRemovals = require('./owedRemovals');
const appHistory = require('../appDecisions/appHistory');
const componentKeyMap = require('./componentKeyMap');
const shutdownPlan = require('./shutdownPlan');
const fluxShutdowndClient = require('../utils/fluxShutdowndClient');
const appNetworkLinker = require('./appNetworkLinker');
const relationshipResolver = require('./relationshipResolver');
const telemetrySinkCache = require('../telemetrySinkCache');
const telemetryIdentityService = require('../telemetryIdentityService');
const hwRequirements = require('../appRequirements/hwRequirements');
const {
  resolveSubmission, assertSecretsNotConflicting, parseMultipartSubmission, uploadSealedContent, assertNamesWhatStands,
  holdsEnoughPeersToSubmit,
} = require('../appRequirements/appSubmission');
const globalState = require('../utils/globalState');
const contentBlobService = require('./contentBlobService');
const contentSlotService = require('./contentSlotService');
const operationRegistry = require('../utils/operationRegistry');
const { Privilege, authOf } = require('../utils/privileges');
const IOUtils = require('../IOUtils');
const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');
const { peerManager } = require('../utils/peerState');
const activeStandbyElection = require('./activeStandbyElection');
const primaryRole = require('./primaryRole');

/**
 * Redeploy a single component of an application.
 *
 * @param {string} appName
 * @param {string} componentName
 * @param {object} [options]
 * @param {boolean} [options.createVolumes=false] - true = recreate volumes, false = keep
 * @param {Function|null} [options.onStatus] - progress callback
 */
// component_busy retry pacing: an uncovered stop of the same identity is in
// flight (bounded — the flows here are sequential, so this is a guard rail,
// not a hot path).
const COMPONENT_STOP_BUSY_RETRIES = 3;
const COMPONENT_STOP_BUSY_DELAY_MS = 5000;

/**
 * Route one component's teardown stop through flux-shutdownd when the
 * component declares a graceful contract (drain, preStop, shutdown) — the
 * daemon is the contract's sole executor, whatever flow tears the component
 * down. Returns true when the daemon's drain is over (the teardown must not
 * stop again); false leaves the stop to the teardown's local fallback, which
 * IS the contract for a component declaring nothing — and the only executor
 * on legacy nodes, where declared-contract components cannot be placed.
 *
 * @param {string} identity - the identity the daemon knows the app by
 * @param {string} appName
 * @param {string|null} replica
 * @param {object} deployComp - a DeploymentComponent
 * @returns {Promise<boolean>} the stop already landed
 */
async function requestComponentDaemonStop(identity, appName, replica, deployComp) {
  if (!deployComp.requiresDaemonShutdown()) return false;
  for (let attempt = 0; attempt < COMPONENT_STOP_BUSY_RETRIES; attempt += 1) {
    const deadline = Math.floor(Date.now() / 1000) + deployComp.shutdownBudgetSeconds();
    // eslint-disable-next-line no-await-in-loop
    const stop = await fluxShutdowndClient.beginAppStop(
      identity,
      appName,
      fluxShutdowndClient.SHUTDOWN_REASON.REDEPLOY,
      {
        force: false, deadline, replica, component: deployComp.name,
      },
    );
    if (stop.outcome !== 'component_busy') {
      return stop.outcome === 'complete' || stop.outcome === 'deadline'
        || stop.outcome === 'superseded' || stop.outcome === 'forced';
    }
    // eslint-disable-next-line no-await-in-loop
    await serviceHelper.delay(COMPONENT_STOP_BUSY_DELAY_MS);
  }
  log.warn(`component stop for ${deployComp.identifier} stayed busy; falling back to a local stop`);
  return false;
}

async function redeployComponent(appName, componentName, options = {}) {
  const createVolumes = options.createVolumes || false;
  const onStatus = options.onStatus || null;

  // One word per operation: the registry lease type, and the word every message
  // uses. They were two vocabularies for one thing.
  const operation = createVolumes ? 'rebuild' : 'redeploy';

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
  const redeployToken = operationRegistry.acquire(appName, operation, 'appOperations', `${operation} ${appName}`);

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

    // And every file its container reads at its first start is in this node's
    // store, so a file that cannot be had refuses the operation here with the
    // old version running: the create step writes it onto the sources the
    // teardown leaves or the rebuild makes.
    for (const deployComp of targets) {
      // eslint-disable-next-line no-await-in-loop
      await contentSlotService.stageComponentContent(deployComp, { appName });
    }

    for (const deployComp of targets) {
      if (createVolumes) {
        log.warn(`REMOVAL REASON: ${operation} initiated - ${deployComp.identifier} (redeployComponent)`);
      }
      // A declared graceful contract routes the stop through flux-shutdownd,
      // component-scoped; everything else takes the teardown's local stop.
      // eslint-disable-next-line no-await-in-loop
      const stopHandled = await requestComponentDaemonStop(
        shutdownPlan.daemonIdentity({ identity: deployComp.identity, name: appName }), appName, deployComp.replica ?? null, deployComp,
      );
      // Same-spec redeploy: the port set is identical, so leave the app's ufw/UPnP rules
      // in place across the teardown+reinstall (no firewall flap, no ~1s/port UPnP re-map).
      // eslint-disable-next-line no-await-in-loop
      await appUninstaller.uninstallComponent(deployComp, {
        removeVolumes: createVolumes,
        skipPorts: true,
        stopHandled,
        onStatus,
      });

      status(`Component ${deployComp.identifier} removed. Awaiting installation...`);
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.delay(config.get('fluxapps.redeploy.composedDelay') * 1000);

      // eslint-disable-next-line no-await-in-loop
      const install = await appRecords.hostedInstances().byName(appName);
      // eslint-disable-next-line no-await-in-loop
      const freshDeployment = await deploymentProvider.buildDeployment(install, { replica: deployComp.replica ?? null });
      // eslint-disable-next-line no-await-in-loop
      await hwRequirements.checkNodeResourcesReclaiming(freshDeployment);

      status(`Installing ${deployComp.identifier}...`);
      // eslint-disable-next-line no-await-in-loop
      await componentProvisioner.installComponent(deployComp, {
        createVolumes,
        skipPorts: true,
        specVersion: install.record.version,
        uuid: install.record.uuid,
        requiresEncryption: shutdownPlan.appRequiresDaemonShutdown(freshDeployment),
      });

      status(`Component ${deployComp.identifier} ${operation} complete`);
      // One component replaced in place, the app left installed. Nothing
      // observing the node could previously tell a component redeploy from its
      // never having been asked for - the app's own state is the same either
      // way - which is how this endpoint failing on every call went unnoticed.
      //
      // `hard` is the consequence that differs between the two operations: a
      // rebuild recreated the component's volume, so its data on this node is
      // gone. Published per COMPONENT rather than per app, because a co-located
      // pair rolls one identity's copy at a time and an observer waiting on the
      // app would not know which.
      fluxEventBus.publish('app:componentRedeployed', {
        name: appName,
        component: componentName,
        identifier: deployComp.identifier,
        hard: createVolumes,
      });
    }
    operationRegistry.release(appName, redeployToken);
    appReconciler.enqueueApp(appName);
  } catch (error) {
    log.error(error);
    // A redeploy failure must NOT destroy the app: the old version is already torn
    // down (or never existed), so hand recovery to the reconciler. It recreates the
    // missing containers and, if they can't be rebuilt, applies the §14.5 gate — a
    // has-run app degrades to down + retry; only a never-ran one is removed. No
    // direct uninstall, no fleet-wide removal broadcast over a bad update.
    // Told to the caller, not only to the log. Returning quietly closes the
    // stream on whatever the teardown last wrote - a progress line - so a
    // redeploy that did not happen answers 200 and reads as one that did.
    status(messageHelper.createErrorMessage(
      `${operation} of ${appName} failed: ${error.message}. `
      + 'No forced uninstall - convergence is left to the reconciler.',
    ));
    operationRegistry.release(appName, redeployToken);
    appReconciler.enqueueApp(appName);
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

  // One word per operation: the registry lease type, and the word every message
  // uses. They were two vocabularies for one thing.
  const operation = createVolumes ? 'rebuild' : 'redeploy';

  const status = (msg) => {
    log.info(msg);
    if (onStatus) onStatus(msg);
  };

  if (operationRegistry.isHeld(appName)) {
    status('Another operation is in progress');
    return;
  }

  // See redeployComponent: the success path loops uninstall/installComponent
  // (no app-level install/remove lease), so this is the sole registry record.
  const redeployToken = operationRegistry.acquire(appName, operation, 'appOperations', `${operation} ${appName}`);

  try {
    const deployments = await deploymentProvider.getInstalledDeployments(appName);
    if (deployments.length === 0) {
      throw new Error(`Application ${appName} not found`);
    }

    status(`Beginning ${operation} of ${appName}...`);

    // Pre-flight: prove every component's image is pullable BEFORE tearing anything
    // down, so a broken redeploy aborts with the old version still running (see
    // redeployComponent). Images are spec-level and identical across replicas, so
    // one identity's view covers them all. Manifest check only — no pull, no
    // transient disk cost.
    for (const [, deployComp] of deployments[0].componentEntries()) {
      // eslint-disable-next-line no-await-in-loop
      await componentProvisioner.verifyComponentImage(deployComp);
    }

    // And every content file the app declares is in this node's store, so a
    // file that cannot be had refuses the operation here with the old version
    // running: each create step writes its component's files onto the sources
    // the teardown leaves or the rebuild makes.
    for (const deployment of deployments) {
      // eslint-disable-next-line no-await-in-loop
      await contentSlotService.stageContent(deployment, { appName });
    }

    // Pre-flight: verify every shareWith dependency is still installed BEFORE tearing
    // anything down. The post-teardown re-verify below can only fail after the running
    // containers are already destroyed; failing here keeps the old version running
    // untouched (degraded at worst — reconnectLinkedApps re-attaches it when the
    // dependency returns).
    const preTeardownSpec = (await appRecords.hostedInstances().byName(appName))?.record;
    if (!preTeardownSpec) {
      throw new Error(`Application ${appName} not found in database`);
    }
    // The spec decides whether this node keeps the app at all, asked before anything
    // comes down: a node its targets no longer name hands the app back and tells its
    // peers, rather than tearing down a copy the rebuild would then refuse to install.
    const targeted = await hwRequirements.targetsNameThisNode(preTeardownSpec);
    if (targeted === null) {
      status(`Cannot establish whether ${appName} names this node, ${operation} deferred`);
      operationRegistry.release(appName, redeployToken);
      return;
    }
    if (!targeted) {
      log.warn(`REMOVAL REASON: Candidate set does not name this node - ${appName} (${operation})`);
      status(`${appName} is not allowed on this node by its specification, handing it back`);
      operationRegistry.release(appName, redeployToken);
      await appUninstaller.uninstallApplication(appName, { broadcastRemoval: true, onStatus });
      return;
    }
    await relationshipResolver.checkAppDependencyRequirements(preTeardownSpec);

    // Roll ONE identity at a time: tear down and rebuild its components while a
    // co-located sibling keeps serving — the whole-app redeploy is a rolling
    // rebuild, never a simultaneous outage of every replica.
    for (const deployment of deployments) {
      const unitLabel = deployment.replica != null ? `Replica ${deployment.replica} of ${appName}` : `Application ${appName}`;
      // Route the identity's stop through flux-shutdownd first: the daemon is the
      // sole executor of declared graceful contracts (drain → preStop → window),
      // and a redeploy's teardown must honor them like any other stop. Terminal
      // outcomes mean the containers are already down; a daemon that cannot take
      // the stop (legacy, unreachable) leaves it to the component teardown's
      // local fallback.
      const budgetSeconds = shutdownPlan.appShutdownBudgetSeconds(deployment);
      // eslint-disable-next-line no-await-in-loop
      const stop = await fluxShutdowndClient.beginAppStop(
        deployment.identity,
        appName,
        fluxShutdowndClient.SHUTDOWN_REASON.REDEPLOY,
        { force: false, deadline: Math.floor(Date.now() / 1000) + budgetSeconds, replica: deployment.replica ?? null },
      );
      if (stop.outcome === 'rejected_pipeline_active') {
        status(`${unitLabel} ${operation} deferred: a node-wide shutdown owns the stop`);
        operationRegistry.release(appName, redeployToken);
        appReconciler.enqueueApp(appName);
        return;
      }
      const stopHandled = stop.outcome === 'complete' || stop.outcome === 'deadline'
        || stop.outcome === 'superseded' || stop.outcome === 'forced';
      // Same-spec redeploy: every component's port set is unchanged, so leave the app's
      // ufw/UPnP rules in place across the teardown+reinstall (no firewall flap, no UPnP
      // re-map churn). skipPorts on both the teardown and the reinstall below.
      for (const [, deployComp] of deployment.componentEntries({ reverse: true })) {
        if (createVolumes) {
          log.warn(`REMOVAL REASON: ${operation} initiated - ${deployComp.identifier} (redeployApplication)`);
        }
        // eslint-disable-next-line no-await-in-loop
        await appUninstaller.uninstallComponent(deployComp, {
          removeVolumes: createVolumes,
          skipPorts: true,
          stopHandled,
          onStatus,
        });
        // eslint-disable-next-line no-await-in-loop
        await serviceHelper.delay(config.get('fluxapps.redeploy.composedDelay') * 1000);
      }
      status(`${unitLabel} removed. Awaiting installation...`);

      // eslint-disable-next-line no-await-in-loop
      const install = await appRecords.hostedInstances().byName(appName);
      if (!install) {
        throw new Error(`Application ${appName} not found in database after removal`);
      }
      // eslint-disable-next-line no-await-in-loop
      const freshDeployment = await deploymentProvider.buildDeployment(install, { replica: deployment.replica ?? null });
      if (!freshDeployment) {
        throw new Error(`Application ${appName} deployment not found after requirement check`);
      }
      // eslint-disable-next-line no-await-in-loop
      await hwRequirements.checkNodeResourcesReclaiming(freshDeployment);

      // Re-seed telemetry routing before recreating containers, in case the
      // redeploy carries a rotated sink (or dropped telemetry entirely).
      telemetrySinkCache.setSink(appName, telemetrySinkCache.extractSink(freshDeployment));

      // Re-verify the dependency edges before recreating containers.
      // eslint-disable-next-line no-await-in-loop
      await relationshipResolver.checkAppDependencyRequirements(install.record);

      const requiresEncryption = shutdownPlan.appRequiresDaemonShutdown(freshDeployment);
      for (const [, deployComp] of freshDeployment.componentEntries()) {
        status(`Installing ${deployComp.identifier}...`);
        // eslint-disable-next-line no-await-in-loop
        await componentProvisioner.installComponent(deployComp, {
          createVolumes,
          skipPorts: true,
          specVersion: install.record.version,
          uuid: install.record.uuid,
          requiresEncryption,
        });
        // Re-attach the recreated container to every linked app's network.
        // eslint-disable-next-line no-await-in-loop
        await appNetworkLinker.connectComponentToLinkedApps(
          deployComp.identifier, freshDeployment, deployComp.qualifiedNetworkAliases,
        );
        // eslint-disable-next-line no-await-in-loop
        await serviceHelper.delay(config.get('fluxapps.redeploy.composedDelay') * 1000);
      }

      // Refresh this identity's shutdown plan for graceful apps only (a redeploy
      // re-derives the same spec, so the predicate is stable across it). Guarded —
      // the handoff must never break a redeploy. Per-container labels were already
      // restamped at docker-create.
      if (shutdownPlan.appRequiresDaemonShutdown(freshDeployment)) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await fluxShutdowndClient.upsertAppPlanBestEffort(
            shutdownPlan.buildShutdownPlan(install.record, freshDeployment),
          );
        } catch (error) {
          log.warn(`flux-shutdownd plan handoff skipped: ${error.message}`);
        }
      }
    }

    status(`Application ${appName} ${operation} complete`);
    operationRegistry.release(appName, redeployToken);
    appReconciler.enqueueApp(appName);
  } catch (error) {
    log.error(error);
    // See redeployComponent: never destroy on a redeploy failure — hand recovery to
    // the reconciler (the §14.5 gate decides down-vs-remove on the rebuild attempt),
    // and say so to the caller rather than closing the stream on a progress line.
    status(messageHelper.createErrorMessage(
      `${operation} of ${appName} failed: ${error.message}. `
      + 'No forced uninstall - convergence is left to the reconciler.',
    ));
    operationRegistry.release(appName, redeployToken);
    appReconciler.enqueueApp(appName);
  }
}

/**
 * Redeploy component via API
 * @param {import('express').Request} req
 * @param {import('express').Response} res
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
    const authorized = await verificationHelper.verifyPrivilege(Privilege.APP_OWNER_OR_FLUX_TEAM, authOf(req), { appName: appname });
    if (!authorized) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
      return;
    }

    // The connection stays open for the rebuild and carries its progress. The
    // stream is message objects with no separator between them, so the type is
    // what it holds rather than what frames it.
    res.setHeader('Content-Type', 'application/json');

    return await redeployComponent(appname, component, {
      createVolumes: force,
      onStatus: messageReporter(res),
    });
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    // Once the stream has started the status line is already spent, so the
    // error goes into it as one more message rather than as a fresh body.
    if (res.headersSent) {
      res.write(serviceHelper.ensureString(errorResponse));
    } else {
      res.json(errorResponse);
    }
  } finally {
    // The redeploy writes progress, this closes. Its internal guards return
    // without closing, and a failure after the stream has started leaves
    // nothing else that can.
    if (!res.writableEnded) res.end();
  }
}

/**
 * Redeploy application via API
 * @param {import('express').Request} req
 * @param {import('express').Response} res
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
      // A refusal is an answer. Returning without writing leaves the caller on
      // an open connection until server.requestTimeout.
      log.info(`Operation in progress for ${appname}, redeploy skipped...`);
      res.json(messageHelper.createWarningMessage(`Operation in progress for ${appname}, redeploy skipped...`));
      return;
    }

    let { force } = req.params;
    force = force || req.query.force || false;
    force = serviceHelper.ensureBoolean(force);

    const authorized = await verificationHelper.verifyPrivilege(Privilege.APP_OWNER_OR_FLUX_TEAM, authOf(req), { appName: appname });
    if (!authorized) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
      return;
    }

    let isGlobal = req.params.global || req.query.global || false;
    isGlobal = serviceHelper.ensureBoolean(isGlobal);

    if (isGlobal) {
      globalCommand.executeAppGlobalCommand(appname, 'redeploy', req.headers.zelidauth, force);
      const operation = force ? 'rebuild' : 'redeploy';
      res.json(messageHelper.createSuccessMessage(`${appname} queried for global ${operation}`));
      return;
    }

    res.setHeader('Content-Type', 'application/json');

    return await redeployApplication(appname, {
      createVolumes: force,
      onStatus: messageReporter(res),
    });
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    if (res.headersSent) {
      res.write(serviceHelper.ensureString(errorResponse));
    } else {
      res.json(errorResponse);
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
}

/**
 * Says what an operation is doing, to a caller holding the connection open.
 *
 * The flush is what makes a line arrive: the compression middleware buffers
 * small writes to build compressible chunks, so a progress stream without it
 * sits in that buffer instead of reaching the caller.
 *
 * @param {import('express').Response} res
 * @returns {function(string): void}
 */
function lineReporter(res) {
  return (message) => {
    if (res.writableEnded) return;
    res.write(`${serviceHelper.ensureString(message)}\n`);
    if (res.flush) res.flush();
  };
}

/**
 * The same, for the redeploy routes, whose stream carries message OBJECTS with
 * no separator between them - a reader splits it on `}{`. A progress line
 * arrives as a success envelope and a failure as the error envelope the
 * redeploy built, so the last object's status says how it ended. A newline
 * here would land inside the value a caller parses.
 *
 * @param {import('express').Response} res
 * @returns {function(string|object): void}
 */
function messageReporter(res) {
  return (message) => {
    if (res.writableEnded) return;
    const chunk = typeof message === 'string' ? messageHelper.createSuccessMessage(message) : message;
    res.write(serviceHelper.ensureString(chunk));
    if (res.flush) res.flush();
  };
}

/**
 * The syncthing folder a component's data is shared under, as the installed
 * resources record it: the folder's id and its directory. Null for a component
 * that shares none, and for one this node holds no resources of.
 * @param {string} identifier - the component's container identifier
 * @returns {Promise<{id: string, path: string}|null>}
 */
async function recordedSyncFolder(identifier) {
  const resources = await appRecords.instanceResources().byIdentifier(identifier);
  return resources?.blockOf(identifier)?.syncFolder ?? null;
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
  // The containers are this node's, named by its hosted instance.
  const install = await appRecords.hostedInstances().byName(appname);
  if (!install) {
    throw new Error('Application not found');
  }
  // Every local identity's components: an app-wide stop/start (backup, restore)
  // must cover a co-located pair's containers, not one arbitrary replica's.
  const deployments = await deploymentProvider.buildDeployments(install);
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
// How long the DAEMON gets to become able to answer - not how long a container
// gets to stop. A stop legitimately takes hours under a graceful drain; a
// dockerd restart clears in seconds.
const DOCKER_SETTLE_POLL_MS = 5000;
const DOCKER_SETTLE_ATTEMPTS = 12;
// How often the stopping gate is re-read while flux-shutdownd drains an app.
const DRAIN_POLL_MS = 1000;
// The directories a restore may read an archive from, and so the only values its
// type may take: the type names a directory inside the app's volume and reaches a
// shell through tar.
const RESTORE_TYPES = ['local', 'remote', 'upload'];

/**
 * What docker says this container is actually doing, waiting out a daemon that
 * cannot answer yet.
 *
 * "I asked, and the container is up" and "docker did not answer" are different
 * facts and only one of them is about the container. observedContainerState separates
 * them by probing the daemon with a list call and using its ANSWER rather than
 * pattern-matching a version-dependent inspect error. The wait is not standing
 * in for the fact; it is how the fact becomes obtainable.
 *
 * @param {string} identifier - bare component identifier
 * @param {function(string): Promise<void>} [onWait] - told what is being waited for
 * @returns {Promise<object|null>} the state, or null if the daemon never answered
 */
async function settledDockerState(identifier, onWait) {
  for (let attempt = 1; attempt <= DOCKER_SETTLE_ATTEMPTS; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const actual = await appReconciler.observedContainerState(identifier);
    if (actual.reachable && !actual.indeterminate) return actual;
    if (attempt === DOCKER_SETTLE_ATTEMPTS) break;
    const waiting = `Docker is not answering for ${identifier} yet, waiting (${attempt}/${DOCKER_SETTLE_ATTEMPTS - 1})...`;
    log.warn(`stopApplication - ${waiting}`);
    // The response is a stream that has already returned 200, so a minute of
    // silence is a minute in which anything between here and the browser may
    // decide the connection is idle.
    // eslint-disable-next-line no-await-in-loop
    if (onWait) await onWait(waiting);
    // eslint-disable-next-line no-await-in-loop
    await serviceHelper.delay(DOCKER_SETTLE_POLL_MS);
  }
  return null;
}

/**
 * Stop an app's containers and PROVE they are down, for a caller that is about
 * to read or replace the volume underneath them.
 *
 * @param {string} appname - App or component name
 * @param {function(string): Promise<void>} [onWait] - progress, while waiting on the daemon
 * @returns {Promise<void>}
 */
async function stopApplication(appname, onWait) {
  const ids = await componentIdentifiersFor(appname);
  const { converged, failed } = await appReconciler.drive(ids, 'stopped');
  if (!converged) {
    throw new Error(`Refusing to touch ${appname}'s data: ${failed.join(', ')} did not stop`);
  }

  // On Arcane the reconciler hands a stop to flux-shutdownd and returns while the
  // daemon drains the app; the app-wide stopping gate stands until the daemon
  // reports the stop done or the gate's own deadline passes. The containers are
  // read only once that gate has lifted, so a drain in progress is waited out
  // rather than read as a container that refused to stop.
  const appName = deploymentProvider.appNameFromRequest(appname);
  let told = false;
  while (globalState.getAppShutdownPipelineState(appName)) {
    if (!told && onWait) {
      told = true;
      // eslint-disable-next-line no-await-in-loop
      await onWait(`flux-shutdownd is stopping ${appName}, waiting for it to finish...`);
    }
    // eslint-disable-next-line no-await-in-loop
    await serviceHelper.delay(DRAIN_POLL_MS);
  }

  // CONVERGENCE IS NOT THE FACT THIS CALLER NEEDS. awaitConvergence counts only
  // the 'failed' verdict, and the anti-hang backstop answers 'provisional' after
  // convergeBackstopMs - five minutes - which is NOT counted, so `converged` is
  // true. Five minutes is nothing against a stop: the stopping lease is held for
  // its duration, legitimately hours under a graceful drain, so 'provisional'
  // here ordinarily means STILL STOPPING rather than anything being wrong.
  //
  // Both callers replace or archive the volume next, so the question has to be
  // the container's actual state, asked of docker. It is authoritative whoever
  // did the stopping - the reconciler, or flux-shutdownd's drain - and a
  // container still draining reads as running, which is the correct refusal.
  const stillRunning = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const identifier of ids) {
    // eslint-disable-next-line no-await-in-loop
    const actual = await settledDockerState(identifier, onWait);
    if (!actual) {
      // The daemon is a property of the node, not of this component: having
      // waited it out once, waiting again per component only multiplies the
      // refusal's latency by the compose count. Said as what it is - the daemon
      // never answered - rather than as a container that refused to stop, which
      // was never established.
      throw new Error(`Refusing to touch ${appname}'s data: docker never became able to answer about ${identifier}`);
    }
    // reachable and not running covers stopped AND gone; neither can write.
    if (actual.running) stillRunning.push(identifier);
  }
  if (stillRunning.length) {
    throw new Error(`Refusing to touch ${appname}'s data: ${stillRunning.join(', ')} is still running`);
  }
}

/**
 * Append backup task to queue
 * @param {import('express').Request} req
 * @param {import('express').Response} res
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
  let force = false;
  try {
    const processedBody = serviceHelper.ensureObject(req.body);
    // eslint-disable-next-line prefer-destructuring
    appname = processedBody.appname;
    // eslint-disable-next-line prefer-destructuring
    backup = processedBody.backup;
    // Archive an incomplete copy anyway. Deliberately explicit rather than a
    // default: the refusal below exists because the archive it prevents looks
    // fine now and loses data when it is restored months later.
    force = processedBody.force === true || processedBody.force === 'true';
    log.info(`Backup task requested for app ${appname}`);
    if (!appname || !backup) {
      throw new Error('appname and backup parameters are mandatory');
    }
    if (!Array.isArray(backup)) {
      throw new Error('backup must be a list of components');
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
    res.json(messageHelper.createErrorMessage(error.message || error, error.name, error.code));
    return false;
  }

  try {
    // Unconditional. It read `res ? await verifyPrivilege(...) : true`, which
    // authorises whoever arrives without a response object.
    const authorized = await verificationHelper.verifyPrivilege(Privilege.APP_OWNER_OR_FLUX_TEAM, authOf(req), { appName: appname });
    if (authorized !== true) {
      res.json(messageHelper.errUnauthorizedMessage());
      return false;
    }
  } catch (error) {
    log.error(error);
    res.json(messageHelper.createErrorMessage(error.message || error, error.name, error.code));
    return false;
  }

  // An archive stops the app, reads its volumes and starts it again, and the
  // caller reads how far it has got off this connection. The work throws rather
  // than writing into the response, so a failure arrives as one chunk from here.
  const report = lineReporter(res);
  try {
    return await runBackupTask(appname, backup, force, report);
  } catch (error) {
    log.error(error);
    report(`${error?.message}\n`);
    return false;
  } finally {
    // The archive writes progress; this closes. A failure after the stream has
    // started leaves nothing else that can.
    if (!res.writableEnded) res.end();
  }
}

/**
 * Give back the syncthing folders an operation paused.
 *
 * Owed on every exit, success or failure, for the reason the pause exists: a
 * folder left paused replicates nothing and says nothing, and only the monitor's
 * per-app pass would ever notice - the same pass whose absence makes removing
 * the folder unsafe in the first place.
 *
 * Never throws. It is called from a catch, where a throw would replace the error
 * that brought the caller there.
 *
 * @param {Array<object>} syncedComponents - the components whose folders were paused
 * @param {function(string): void} [report]
 */
async function resumeBackupSync(syncedComponents, report) {
  if (!syncedComponents || !syncedComponents.length) return;
  // eslint-disable-next-line no-restricted-syntax
  for (const comp of syncedComponents) {
    // eslint-disable-next-line no-await-in-loop
    await syncthingMonitorHelpers.setSyncthingFolderPaused(comp.syncFolderId, false, report);
  }
}
/**
 * Archive an app's volumes: stop it, read them, start it again.
 *
 * @param {string} appname
 * @param {Array<object>} backup - the components to archive
 * @param {boolean} force - archive an incomplete copy anyway
 * @param {function(string): void} report - progress, written to the caller's stream
 * @returns {Promise<boolean>}
 */
async function runBackupTask(appname, backup, force, report) {
  // Hoisted so the catch releases ONLY a lease this call acquired (null = no-op),
  // and beside it the folders this call paused, for the same reason: the catch
  // owes back what the try took.
  let taskToken = null;
  let pausedSynced = [];
  try {
    // backup is an app-scoped lease on the same key as install/remove/
    // reconcile, so it's mutually exclusive with them (no feature carve-out).
    taskToken = operationRegistry.acquire(appname, 'backup', 'appOperations', `backup ${appname}`);
    // The claim is the isHeld check above made atomic. That check runs BEFORE
    // the awaited privilege call, so two requests for one app both passed it
    // and archived the same volume at once; acquire is a synchronous
    // test-and-set that only one of them can win, and its answer was being
    // dropped. Refusing here also keeps the catch honest: with a null token
    // the loser would neither hold the lease nor restart the app it stopped.
    if (!taskToken) {
      throw new Error('An operation is already in progress for this app...');
    }
    const backupDeployment = await deploymentProvider.getInstalledDeployment(appname);
    // Refused here, before anything is stopped or paused, so a refusal never
    // costs a healthy app an outage.
    //
    // The provider answers null for two different facts - the app is not
    // installed here, and its deployment could not be BUILT (it logs the build
    // error and returns null either way). Treating that as "no synced
    // components" is what switched the completeness gate off silently: the one
    // case where least is known about the app is the case the safety check
    // skipped. Neither fact permits a backup, so both refuse.
    if (!backupDeployment) {
      throw new Error(`Refused: no deployment could be resolved for ${appname}`);
    }
    // Syncthing folders are registered per component as flux<identifier> —
    // the bare app name matches nothing for a composed app, so the folder
    // must be removed component by component (same as the uninstaller).
    const backupSynced = backupDeployment.componentEntries()
      .filter(([, comp]) => comp.hasSyncthing()).map(([, comp]) => comp);

    // An archive is only worth keeping if this instance holds a COMPLETE copy.
    // A synced app's data lives on every instance, and a backup is deliberately
    // taken from a standby - the quiescent one - so the question is never "is
    // this the primary" but "is this copy whole". An index that is behind, or
    // absent entirely (a folder syncthing was never configured with), yields an
    // archive of whatever happens to be on disk, which can be nothing at all.
    //
    // Checked BEFORE anything is stopped: a refusal must not cost a healthy app
    // an outage. Only the components actually being archived are checked - a
    // partial copy of a component nobody asked for is not this request's
    // problem.
    const requested = new Set(backup.filter((item) => item.backup).map((item) => item.component));
    const incomplete = [];
    for (const comp of backupSynced.filter((c) => requested.has(c.name))) {
      const folderId = comp.syncFolderId;
      // eslint-disable-next-line no-await-in-loop
      const { status: syncStatus, reason } = await syncthingFolderStateMachine
        .probeFolderSyncCompletion(folderId);
      if (reason === 'absent') {
        incomplete.push(`${comp.name}: no syncthing folder - this instance has never synced`);
      } else if (reason === 'unknown') {
        // Syncthing not answering says nothing about the data. Refusing is still
        // right - an archive of an unverified copy is the thing that looks fine
        // now and loses data when it is restored months later - but the reason
        // given has to be the one that actually happened.
        incomplete.push(`${comp.name}: syncthing did not answer - sync state could not be determined`);
      } else if (syncStatus.globalBytes === 0) {
        // With nothing in the global index there is nothing to be a fraction of,
        // and the percentage defaults to 100 - which would tell an operator the
        // copy is complete in the same breath as refusing it.
        incomplete.push(`${comp.name}: nothing in the sync index yet - cannot confirm this copy holds the data`);
      } else if (!syncStatus.isSynced) {
        incomplete.push(`${comp.name}: ${syncStatus.syncPercentage.toFixed(2)}% synced (${syncStatus.inSyncBytes}/${syncStatus.globalBytes} bytes)`);
      }
    }
    if (incomplete.length > 0) {
      const summary = incomplete.join('; ');
      if (!force) {
        throw new Error(`Refusing to back up an incomplete copy - ${summary}. Back up from a fully synced instance, or repeat with force to archive what is on disk anyway.`);
      }
      log.warn(`appendBackupTask - ${appname} forced over an incomplete copy - ${summary}`);
      report(`WARNING: backing up an incomplete copy - ${summary}\n`);
    }

    if (backupSynced.length) {
      report(`Pausing syncthing for ${appname}\n`);
      for (const comp of backupSynced) {
        // Paused, not removed. Removing discards the folder config, and only the
        // monitor's per-app pass ever rebuilds it - so on a node where that pass
        // cannot complete, the app keeps running and silently stops being
        // replicated. Given back on every exit, including the catch.
        // eslint-disable-next-line no-await-in-loop
        const held = await syncthingMonitorHelpers.setSyncthingFolderPaused(comp.syncFolderId, true, report);
        if (held === 'held') pausedSynced.push(comp);
        // An unheld folder is still pulling, so the archive would be taken over
        // data that moves underneath it.
        if (held === 'failed') {
          throw new Error(`Refused: ${comp.identifier} could not be held still, so an archive taken now could be inconsistent`);
        }
      }
    }

    report('Stopping application...\n');
    await stopApplication(appname, report);
    await serviceHelper.delay(5 * 1000);
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
          const tarGzPath = `${volume.mount}/backup/local/backup_${label}.tar.gz`;
          const forWhich = volume.replica ? `${label} (replica ${volume.replica})` : label;
          // eslint-disable-next-line no-await-in-loop
          const existStatus = await IOUtils.checkFileExists(tarGzPath);
          if (existStatus === true) {
            // eslint-disable-next-line no-await-in-loop
            report(`Removing exists backup archive for ${forWhich}...\n`);
            // eslint-disable-next-line no-await-in-loop
            await IOUtils.removeFile(tarGzPath);
          }
          // eslint-disable-next-line no-await-in-loop
          report(`Creating backup archive for ${forWhich}...\n`);
          // eslint-disable-next-line no-await-in-loop
          const tarStatus = await appDataEntries.archiveAppData(volume.mount, tarGzPath, {
            component: component.component, replica: volume.replica,
          });
          if (tarStatus.status === false) {
            // eslint-disable-next-line no-await-in-loop
            await IOUtils.removeFile(tarGzPath);
            throw new Error(`Error: Failed to create backup archive for ${forWhich}, ${tarStatus.error}`);
          }
        }
      }
    }
    await serviceHelper.delay(5 * 1000);
    report('Starting application...\n');
    // Every component gets the stop hold back, the synced ones included: the
    // reconciler runs a component only where the election made this node the
    // writer, so a standby settles stopped and the elected primary comes back.
    await startApplication(appname);
    report('Finalizing...\n');
    await serviceHelper.delay(5 * 1000);
    await resumeBackupSync(pausedSynced, report);
    operationRegistry.release(appname, taskToken);
    return true;
  } catch (error) {
    log.error(error);
    // The stop hold is run-state this operation owes back: a failed backup (ENOSPC
    // on the archive is the classic) must never strand the app stopped - the
    // in-memory hold outlives the error for the life of the process. Only when
    // this call owned the operation - an error path must never clear a foreign
    // operation's hold. startApplication settles on legitimate holds (operator
    // lock, controller), so this never force-starts.
    if (taskToken) await startApplication(appname);
    // Owed back exactly as the run state above is: a failed operation must not
    // leave an app replicating nothing. Never throws, so it cannot replace the
    // error that brought us here.
    await resumeBackupSync(pausedSynced, report);
    operationRegistry.release(appname, taskToken);
    throw error;
  }
}

/**
 * Append a restore task based on the provided parameters.
 * @async
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {boolean} - True if the restore task is successfully appended, otherwise false.
 * @throws {object} - JSON error response if an error occurs.
 */
async function appendRestoreTask(req, res) {
  let appname;
  let restore;
  let type;
  let force = false;
  try {
    const processedBody = serviceHelper.ensureObject(req.body);
    // eslint-disable-next-line prefer-destructuring
    appname = processedBody.appname;
    // eslint-disable-next-line prefer-destructuring
    restore = processedBody.restore;
    // eslint-disable-next-line prefer-destructuring
    type = processedBody.type;
    // Restore onto a copy the election does not name as the writer anyway.
    force = processedBody.force === true || processedBody.force === 'true';
    log.info(`Restore task requested for app ${appname} (${type})`);
    if (!appname || !restore || !type) {
      throw new Error('appname, restore and type parameters are mandatory');
    }
    if (!Array.isArray(restore)) {
      throw new Error('restore must be a list of components');
    }
    if (!RESTORE_TYPES.includes(type)) {
      throw new Error(`Refused: type must be one of ${RESTORE_TYPES.join(', ')}`);
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
    res.json(messageHelper.createErrorMessage(error.message || error, error.name, error.code));
    return false;
  }

  try {
    const authorized = await verificationHelper.verifyPrivilege(Privilege.APP_OWNER_OR_FLUX_TEAM, authOf(req), { appName: appname });
    if (authorized !== true) {
      res.json(messageHelper.errUnauthorizedMessage());
      return false;
    }
  } catch (error) {
    log.error(error);
    res.json(messageHelper.createErrorMessage(error.message || error, error.name, error.code));
    return false;
  }

  // A restore stops the app, replaces its volumes and starts it again, and the
  // caller reads how far it has got off this connection.
  const report = lineReporter(res);
  try {
    return await runRestoreTask(appname, restore, type, req.headers.zelidauth, report, { force });
  } catch (error) {
    log.error(error);
    report(`${error?.message}\n`);
    return false;
  } finally {
    if (!res.writableEnded) res.end();
  }
}

/**
 * A restore that failed after clearing a component's appdata leaves that
 * directory neither copy. The component is held stopped, its synced folder
 * demoted to receiveonly so the partial copy is never offered to the peers, and
 * the rest of the app restarts on data the restore never touched.
 * @param {string} appname
 * @param {Array<{identifier: string, folderId: ?string, synced: boolean}>} swaps components whose clear
 *   began, each synced one with the id of its syncthing folder as the instance's resources record it
 */
async function holdPartialRestore(appname, swaps) {
  for (const swap of swaps) {
    if (swap.synced) {
      const { folderId } = swap;
      // eslint-disable-next-line no-await-in-loop
      // A folder syncthing does not know answers 404: nothing replicates it.
      const demoted = await primaryRole.demoteForSafety(folderId);
      if (demoted.status !== 'success' && demoted.data?.httpStatus !== 404) {
        log.error(`restore - SAFETY: ${folderId} holds partial data and could not be demoted to receiveonly`);
      }
      // eslint-disable-next-line no-await-in-loop
      await appCaches.setSyncedMark(appCaches.receiveOnlySyncthingAppsCache, folderId, swap.identifier, { restarted: false, numberOfExecutions: 0 });
    }
    appReconciler.setControllerDesired(swap.identifier, 'stopped', 'restore did not complete');
  }
  const held = new Set(swaps.map((swap) => swap.identifier));
  const others = (await componentIdentifiersFor(appname)).filter((identifier) => !held.has(identifier));
  if (others.length) await appReconciler.drive(others, 'running');
}

/**
 * Replace an app's volumes from an archive: stop it, restore them, start it again.
 *
 * Nothing is destroyed until a complete, readable replacement is known to
 * exist: every archive is read end to end first, and only then does appdata
 * make way for it. The other instances are never told to redeploy - they hold
 * the only other copies, and the resumed folders carry the restored data to
 * them; where their containers are running they are restarted, which recreates
 * nothing.
 *
 * @param {string} appname
 * @param {Array<object>} restore - the components to restore
 * @param {string} type - where the archive comes from
 * @param {string} zelidauth - the caller's auth, for the peer restart it triggers
 * @param {function(string): void} report - progress, written to the caller's stream
 * @param {{force?: boolean}} [opts] - force restores onto a copy the election does not name as the writer
 * @returns {Promise<boolean>}
 */
/**
 * The local archive a restore of one component's volume reads. Backup writes
 * it under the component's name in the volume the component's key names, so
 * an archive taken before a rename is under a former name: the current name's
 * is read when present, else the most recent former name's that is.
 *
 * @param {string} appname
 * @param {object} volume - a volume row, tagged with its replica
 * @param {string} label - the archive name the request addresses the component by
 * @param {string} componentName - the component's current name
 * @returns {Promise<string>} the archive path; the current name's when none is present
 */
async function localArchivePath(appname, volume, label, componentName) {
  const pathOf = (name) => `${volume.mount}/backup/local/backup_${name.toLowerCase()}.tar.gz`;
  const install = await appRecords.hostedInstances().byReplica(appname, volume.replica ?? null);
  const formerNames = install ? install.formerNamesOf(componentName) : [];
  // eslint-disable-next-line no-restricted-syntax
  for (const name of [label, ...formerNames.reverse()]) {
    // eslint-disable-next-line no-await-in-loop
    if (await IOUtils.checkFileExists(pathOf(name))) return pathOf(name);
  }
  return pathOf(label);
}

async function runRestoreTask(appname, restore, type, zelidauth, report, { force = false } = {}) {
  // Hoisted so the catch releases ONLY a lease this call acquired (null = no-op),
  // and beside it the folders this call held, for the same reason: the catch
  // owes back what the try took.
  let taskToken = null;
  const pausedSynced = [];
  // Whether this call took the app down: only a stop it took is its to give back.
  let stopped = false;
  // Components whose appdata clear has begun: until every unpack lands, their
  // directories are neither copy, and a failure in between holds them rather
  // than starting them on it.
  const swapsInFlight = [];
  try {
    // restore is an app-scoped lease on the same key as backup/install/
    // remove/reconcile.
    taskToken = operationRegistry.acquire(appname, 'restore', 'appOperations', `restore ${appname}`);
    // See appendBackupTask: the isHeld check above is not the claim, and a
    // restore that loses the race would replace the volume under the winner.
    if (!taskToken) {
      throw new Error('An operation is already in progress for this app...');
    }
    const restoreDeployment = await deploymentProvider.getInstalledDeployment(appname);
    // Refused here, before anything is stopped or paused, so a refusal never
    // costs a healthy app an outage.
    //
    // The provider answers null for two different facts - the app is not
    // installed here, and its deployment could not be BUILT (it logs the build
    // error and returns null either way). Treating that as "no synced
    // components" is what switched the completeness gate off silently: the one
    // case where least is known about the app is the case the safety check
    // skipped. Neither fact permits a restore, so both refuse.
    if (!restoreDeployment) {
      throw new Error(`Refused: no deployment could be resolved for ${appname}`);
    }

    // Only the components the caller asked for, and each one the app has. The
    // UI sends every component on every request, the unselected ones flagged
    // false, so the flags decide; a name the app does not have is refused here,
    // before anything is held or stopped.
    const targets = restore.filter((item) => item.restore).map((item) => {
      const entries = restoreDeployment.componentEntries();
      const wanted = deploymentProvider.componentNameFromRequest(
        appname, item.component, entries.map(([name]) => name),
      );
      const comp = entries.find(([name]) => name === wanted)?.[1];
      if (!comp) {
        throw new Error(`Refused: ${item.component} is not a component of ${appname}`);
      }
      return {
        name: item.component,
        comp,
        synced: comp.hasSyncthing(),
        elected: comp.hasActiveStandbySyncthing(),
        url: item.url,
        replica: item.replica,
      };
    });

    // An active-standby component has exactly one writer, the instance the
    // election points at. Restoring onto any other copy puts the data where the
    // primary is still overwriting it: it reports success and is quietly
    // undone. Only a positive answer disqualifies this node - an FDM that cannot
    // answer does not block a restore, as it does not block an election.
    if (!force && targets.some((target) => target.elected)) {
      const localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();
      const { ip: primaryIp, fdmOk } = await activeStandbyElection.getMasterIpFromFdm(appname, { timeout: 10_000 });
      if (fdmOk && primaryIp && !ipsMatch(primaryIp, localSocketAddr)) {
        throw new Error(`Refused: restore on ${primaryIp}, it holds the live copy`);
      }
    }

    // Hold the data being replaced still, and only that: the named components'
    // folders. Paused, not removed - removing discards the folder config, and
    // only the monitor's per-app pass ever rebuilds it. Clearing appdata happens
    // inside the replicated folder, so an unheld sendreceive folder turns the
    // clear into deletions this node broadcasts to every healthy peer; that is
    // refused while the data is still there.
    const syncedTargets = targets.filter((target) => target.synced);
    if (syncedTargets.length) {
      report(`Pausing syncthing for ${appname}\n`);
      for (const { comp } of syncedTargets) {
        // eslint-disable-next-line no-await-in-loop
        const held = await syncthingMonitorHelpers.setSyncthingFolderPaused(comp.syncFolderId, true, report);
        if (held === 'held') pausedSynced.push(comp);
        if (held === 'failed') {
          throw new Error(`Refused: ${comp.identifier} could not be held still, so clearing its data would propagate the deletions to the other instances`);
        }
      }
    }
    report('Stopping application...\n');
    await stopApplication(appname, report);
    stopped = true;
    await serviceHelper.delay(5 * 1000);

    // The volumes each target replaces, each with the archive it reads.
    // eslint-disable-next-line no-restricted-syntax
    for (const target of targets) {
      const label = target.name.toLowerCase();
      // eslint-disable-next-line no-await-in-loop
      target.volumes = await taskVolumes(appname, target.name, target.replica);
      // eslint-disable-next-line no-restricted-syntax
      for (const volume of target.volumes) {
        volume.archivePath = type === 'local'
          // eslint-disable-next-line no-await-in-loop
          ? await localArchivePath(appname, volume, label, target.comp.name)
          : `${volume.mount}/backup/${type}/backup_${label}.tar.gz`;
        volume.forWhich = volume.replica ? `${label} (replica ${volume.replica})` : label;
      }
    }

    if (type === 'remote') {
      // eslint-disable-next-line no-restricted-syntax
      for (const target of targets) {
        if (!target.url) {
          throw new Error(`Refused: no url given for ${target.name}`);
        }
        // eslint-disable-next-line no-restricted-syntax
        for (const volume of target.volumes) {
          const remotePath = `${volume.mount}/backup/remote`;
          // eslint-disable-next-line no-await-in-loop
          await IOUtils.removeDirectory(remotePath, true);
          report(`Downloading ${target.url}...\n`);
          // eslint-disable-next-line no-await-in-loop
          const downloadStatus = await IOUtils.downloadFileFromUrl(target.url, remotePath, target.name, true);
          if (downloadStatus !== true) {
            throw new Error(`Error: Failed to download ${target.url}...`);
          }
          // this copy is the task's own, so the task is what removes it
          volume.downloaded = true;
          // A connection that dropped, or an error page served as 200, lands here
          // as a short file. The archive read below would catch it too, but only
          // after inflating what did arrive, and it cannot say what was expected.
          // eslint-disable-next-line no-await-in-loop
          const expectedBytes = await IOUtils.getRemoteFileSize(target.url, 'B', 0, true);
          // eslint-disable-next-line no-await-in-loop
          const receivedBytes = await IOUtils.getFileSize(volume.archivePath);
          if (Number.isFinite(expectedBytes) && expectedBytes > 0 && receivedBytes !== expectedBytes) {
            throw new Error(`Error: download incomplete, got ${receivedBytes} of ${expectedBytes} bytes`);
          }
        }
      }
    }

    // Every archive is read end to end before any of them is acted on: one
    // decompression pass that writes nothing, proving the archive is whole and
    // readable while the data it would replace is still there.
    // eslint-disable-next-line no-restricted-syntax
    for (const target of targets) {
      // eslint-disable-next-line no-restricted-syntax
      for (const volume of target.volumes) {
        report(`Checking archive for ${volume.forWhich}...\n`);
        // eslint-disable-next-line no-await-in-loop
        const archive = await IOUtils.inspectTarGz(volume.archivePath);
        if (!archive.status) {
          throw new Error(`Error: archive for ${volume.forWhich} is unreadable, ${archive.error}`);
        }
        if (archive.entries === 0) {
          throw new Error(`Error: archive for ${volume.forWhich} is empty`);
        }
      }
    }

    // eslint-disable-next-line no-restricted-syntax
    for (const target of targets) {
      // eslint-disable-next-line no-restricted-syntax
      for (const volume of target.volumes) {
        // The archive decides what is replaced, so the clear and the unpack
        // are one step: from here until the unpack lands the directory is
        // neither copy.
        report(`Replacing ${volume.forWhich} component data from the backup archive...\n`);
        // eslint-disable-next-line no-await-in-loop
        await serviceHelper.delay(2 * 1000);
        // Read before the clear: a synced volume whose folder cannot be named
        // could not be kept from its peers if the unpack then failed.
        // eslint-disable-next-line no-await-in-loop
        const folder = target.synced ? await recordedSyncFolder(volume.identifier) : null;
        if (target.synced && !folder) {
          throw new Error(`Refused: no syncthing folder is recorded for ${volume.identifier}`);
        }
        swapsInFlight.push({ identifier: volume.identifier, folderId: folder?.id ?? null, synced: target.synced });
        // eslint-disable-next-line no-await-in-loop
        const tarStatus = await appDataEntries.restoreAppData(volume.mount, volume.archivePath, target.comp);
        if (tarStatus.status === false) {
          throw new Error(`Error: Failed to restore ${volume.forWhich} from its archive, ${tarStatus.error}`);
        }
        if (target.synced) {
          // eslint-disable-next-line no-await-in-loop
          await appCaches.setSyncedMark(appCaches.receiveOnlySyncthingAppsCache, folder.id, volume.identifier, {
            restarted: true,
            numberOfExecutionsRequired: 4,
            numberOfExecutions: 10,
          });
        }
      }
    }
    // Every unpack landed: the directories are whole copies again.
    swapsInFlight.length = 0;
    await serviceHelper.delay(1 * 5 * 1000);
    report('Starting application...\n');
    await startApplication(appname);

    // Only a copy this task downloaded is its to remove. An uploaded or local
    // archive is the owner's restore point, and restoring from it must not
    // consume it. Held until here so that a failure above can be retried from
    // the archive rather than re-fetched.
    // eslint-disable-next-line no-restricted-syntax
    for (const target of targets) {
      // eslint-disable-next-line no-restricted-syntax
      for (const volume of target.volumes.filter((v) => v.downloaded)) {
        report(`Removing backup file for ${volume.forWhich}...\n`);
        // eslint-disable-next-line no-await-in-loop
        await IOUtils.removeFile(volume.archivePath);
      }
    }

    // A component every instance runs and writes (r:/s:) has peer containers
    // holding the data this restore has just replaced underneath them; a
    // restart is what makes them read it again, and it recreates no volume. An
    // active-standby component has no peer container to disturb - the other
    // instances are stopped and adopt the restored data when the role next
    // moves - and an unsynced component's data never left this node.
    if (targets.some((target) => target.synced && !target.elected)) {
      report('Restarting other instances...\n');
      globalCommand.executeAppGlobalCommand(appname, 'apprestart', zelidauth, undefined, true); // do not wait
    }
    report('Finalizing...\n');
    await serviceHelper.delay(5 * 1000);
    await resumeBackupSync(pausedSynced, report);
    operationRegistry.release(appname, taskToken);
    return true;
  } catch (error) {
    log.error(error);
    // The stop hold is run-state this operation owes back: a failed restore must
    // never strand the app stopped on data it never touched, and must never
    // start a component whose appdata it had begun to replace. Only a stop this
    // call took is its to give back - a refusal before it leaves the app as it
    // found it.
    if (taskToken && stopped) {
      if (swapsInFlight.length) {
        await holdPartialRestore(appname, swapsInFlight);
      } else {
        await startApplication(appname);
      }
    }
    // Owed back exactly as the run state above is: a failed operation must not
    // leave an app replicating nothing. Never throws, so it cannot replace the
    // error that brought us here.
    await resumeBackupSync(pausedSynced, report);
    operationRegistry.release(appname, taskToken);
    throw error;
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
 * @param {object} previousAppSpecs - The specifications this update replaces
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
 * @param {string} params.type - Message type (fluxappupdate)
 * @param {number} params.version - Message version
 * @returns {Promise<string|null>} The message hash, or null when this node does not
 *   hold the message it broadcast
 */
async function updateAppGlobaly(params) {
  const {
    appSpecification, timestamp, signature, type: messageType, version: typeVersion, contentCtx,
  } = params;

  if (!appSpecification || !timestamp || !signature || !messageType || !typeVersion) {
    throw new Error('Incomplete message received. Check if appSpecification, timestamp, type, version and signature are provided.');
  }
  if (messageType !== 'fluxappupdate') {
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

  assertSubmittableTimestamp(cleanTimestamp);

  const syncStatus = daemonStatus.daemonSyncState();
  if (!syncStatus.synced) {
    throw new Error('Daemon not yet synced.');
  }
  const daemonHeight = syncStatus.height;

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

  // The app the update is judged against: the one the list carries under the
  // name, or the one that last held it, so an expired app is renewed on what it
  // held.
  const appInfo = (await appRecords.registry().byName(spec.name)) ?? (await appSpecHistory.latestAppliedState(spec.name));
  if (!appInfo) {
    throw new Error('Flux App update received but application to update does not exist!');
  }
  const previousSpec = appInfo.spec;

  // Registration-locked invariants (e.g. referral). Both specs must be
  // cleartext; a listed row's spec is sealed, and the state an expired app last
  // held arrives opened, so open only a sealed one.
  const priorCleartext = previousSpec.sealed
    ? await previousSpec.decrypt(await previousSpec.createProvider())
    : previousSpec;
  await assertUpdateInvariants(priorCleartext, spec);

  // Placement feasibility applies to updates too: a narrowed geolocation, a
  // raised instance count or a shrunk pin set must not buy a spec the network
  // provably cannot satisfy. The previous spec is passed so an update that
  // changes nothing placement-relevant - a renewal, a cancellation - is not
  // gated at all, and an unreadable prior counts as unchanged rather than as a
  // change. A failure to COMPUTE never refuses.
  await placementFeasibility.checkPlacementFeasibility(spec, 'updateAppGlobaly', priorCleartext);

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

  const latestSupportedSpecVersion = config.get('fluxapps.latestSupportedSpecVersion');
  const { UpdatePolicy } = await getSpec();
  UpdatePolicy.assertVersionTransition(previousSpec, spec, latestSupportedSpecVersion);
  UpdatePolicy.assertCompatible(previousSpec, spec);

  const messageHASH = await appEventVerifier.computeOutboundHash({
    type: cleanMessageType,
    envelopeVersion: cleanTypeVersion,
    specBlob: broadcastBlob,
    contentHash: cleanContentHash,
    timestamp: cleanTimestamp,
    extend: cleanExtend,
    signature: cleanSignature,
  });

  // A v9 update is priced against the message it replaces and starts its term at
  // its signed time, so one signed at or before that message was mined or signed
  // is refused by consensus, and one sent while another for the app waits for
  // its payment would be priced against a message about to be replaced. Both are
  // refused here, before anyone pays.
  if (spec.version >= 9) {
    const replaced = await appHistory.replacedBy(spec.name);
    if (replaced && cleanTimestamp <= replaced.signAfter) {
      const early = new Error('An update must be signed after the message it replaces was mined and signed.');
      early.name = 'StampedEarly';
      throw early;
    }
    const waiting = await appsRepository.getTempMessageByName(spec.name);
    if (waiting && waiting.hash !== messageHASH) {
      throw new Error('An update for this app is already in progress; wait for it to be applied.');
    }
  }

  // Content rides as ONE HPKE-sealed envelope — never plaintext in transit. Open it
  // toward this node's per-app transport key and upload synchronously so it is
  // durably stored before the spec is gossiped. The superseded spec's contentRef
  // hashes are carried over (already stored under identical locators), so the
  // envelope attaches only new or changed files. A manifest the envelope carries
  // is verified for the listed app and its listed owner, who signed this update,
  // and rides in the update's message; its FluxDrive writes name this message's
  // hash, so FluxDrive holds them until the nodes answer that the update applied.
  let carriedManifest = null;
  // An update that changes the content-ref files with no content envelope carries
  // no keep list.
  if (!contentCtx) contentBlobService.assertKeepListCarried(spec, priorCleartext, null);
  if (contentCtx) {
    ({ carriedManifest } = await uploadSealedContent(spec, contentCtx.content, contentCtx.ownerSigs, {
      ref: cleanContentHash,
      timestamp: cleanTimestamp,
      identity: appInfo.identity,
      owner: appInfo.owner,
      messageHash: messageHASH,
      priorSpec: priorCleartext,
    }));
  }

  // The update names the manifest and the generation records it stands on
  // exactly when the owner it names did not sign them: a sale names them all.
  await assertNamesWhatStands(spec, appInfo, { carriedManifest });

  // v9 only (envelope version 2). v8 enterprise messages are envelope version 1,
  // which old nodes still parse — they must not carry an unknown arcaneAttestation
  // key. v9 messages are rejected by old nodes before parsing.
  let arcaneAttestation;
  if (appEvent.requiresArcaneAttestation()) {
    arcaneAttestation = await appEventVerifier.requestAttestation(
      cleanContentHash,
      broadcastBlob,
    );
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
  if (carriedManifest) temporaryAppMessage.contentManifest = carriedManifest;

  await fluxCommunicationMessagesSender.broadcastTemporaryAppMessage(temporaryAppMessage);
  await serviceHelper.delay(1200);
  await messageVerifier.requestAppMessage(messageHASH);
  await serviceHelper.delay(1200);

  // Held in the pool, or confirmed when the chain recorded the payment first.
  const heldMessage = async () => await appsRepository.getTempMessage(messageHASH)
    || appsRepository.getPermanentMessage(messageHASH);
  let tempMessage = await heldMessage();
  for (let i = 0; i < 20; i += 1) {
    if (!tempMessage) {
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.delay(500);
      // eslint-disable-next-line no-await-in-loop
      tempMessage = await heldMessage();
    }
  }
  if (tempMessage && typeof tempMessage === 'object' && !Array.isArray(tempMessage)) {
    return tempMessage.hash;
  }
  return null;
}

/**
 * API endpoint to update application globally
 * @param {import('express').Request} req
 * @param {import('express').Response} res
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
  const authorized = await verificationHelper.verifyPrivilege(Privilege.USER, authOf(req));
  if (!authorized) {
    res.json(messageHelper.errUnauthorizedMessage());
    return;
  }
  if (!holdsEnoughPeersToSubmit()) {
    throw new Error('Sorry, This Flux does not hold enough peer connections for safe application update');
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
  if (!hash) throw new Error('Unable to update application on the network. Try again later.');

  // Record and gossip where this update entered the network (best-effort).
  await ingressAttestationService.emit(hash, await ingressCapture.captureIngress(req));

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
 * live mount, which the app may legitimately have mutated. The locator is
 * derived for the installed app's identity, the one it was derived for at
 * upload/provision time, so the served artifact matches the requested locator.
 * @param {import('express').Request} req - Request object (params: appName, locator)
 * @param {import('express').Response} res
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
      const installed = await appRecords.hostedInstances().byName(appName);
      if (!installed) {
        res.status(404).end();
        return;
      }
      const framed = await contentBlobService.serveBlob(
        { appName, identity: installed.identity, locator },
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

/**
 * Brings one installed identity of an app from the spec it was installed with
 * to the spec the registry lists: the components the update drops are removed,
 * the ones it adds are installed, and a kept one is recreated when it changed.
 * Components are matched by their keys, so a renamed component is a kept one:
 * its container is recreated under its new name, its volume and folder stay.
 *
 * An update that only names another owner changes no component, so it
 * recreates nothing: a sale restarts nothing. Nothing on a container says who
 * owns its app.
 *
 * @param {string} appName
 * @param {object} oldDeployment - the installed view of this identity
 * @param {object} newDeployment - the listed spec's view of it
 * @param {object} registrySpec - the listed row
 * @param {{componentKeys: Map<string, string>, formerNames: Map<string, string[]>}} naming - the
 *   listed spec's component keys and former names, as this node derived them
 */
async function reconcileComponents(appName, oldDeployment, newDeployment, registrySpec, naming) {
  const byKey = (deployment) => new Map(deployment.componentEntries().map(([, comp]) => [comp.componentKey, comp]));
  const oldByKey = byKey(oldDeployment);
  const newByKey = byKey(newDeployment);

  const removed = [...oldByKey.keys()].filter((key) => !newByKey.has(key));
  const added = [...newByKey.keys()].filter((key) => !oldByKey.has(key));
  const kept = [...oldByKey.keys()].filter((key) => newByKey.has(key));
  const renamed = kept.filter((key) => oldByKey.get(key).name !== newByKey.get(key).name);

  // A changed kept component keeps its volume when only non-storage fields differ;
  // a storage change forces a volume recreate (the loop volume is resized).
  const keepVolume = [];
  const recreateVolume = [];
  for (const key of kept) {
    const oldComp = oldByKey.get(key);
    const newComp = newByKey.get(key);
    if (oldComp.equals(newComp)) {
      log.info(`Component ${newComp.name} of ${appName} unchanged, skipping`);
    } else if (oldComp.storage === newComp.storage) {
      keepVolume.push(key);
    } else {
      recreateVolume.push(key);
    }
  }

  // Pre-flight: prove every NEW component image is pullable BEFORE tearing the old
  // versions down, so a broken update aborts (caught by reconcileApp, which releases
  // + hands off — no destroy) with the old versions still running. Manifest check
  // only — no pull, no transient disk cost.
  for (const key of [...keepVolume, ...recreateVolume, ...added]) {
    // eslint-disable-next-line no-await-in-loop
    await componentProvisioner.verifyComponentImage(newByKey.get(key));
  }

  // And every content file the listed spec declares is in this node's store
  // before anything is torn down: a file that cannot be had yet aborts here with
  // the old version running, and the adoption is tried again while the installed
  // spec is not the listed one. No container is created to start on an empty slot.
  await contentSlotService.stageContent(newDeployment, { appName });

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
  // The resources name each port with the methods it was opened by, which is
  // what closing one and recording a kept one read.
  const replica = newDeployment.replica ?? null;
  const resources = await appRecords.instanceResources().byInstance(appName, replica);
  const recordedPorts = Object.values(resources?.components ?? {}).flatMap((block) => block.hostPorts ?? []);

  const toUninstall = [...removed, ...recreateVolume, ...keepVolume];
  if (toUninstall.length > 0) {
    for (const key of toUninstall.reverse()) {
      const deployComp = oldByKey.get(key);
      const removeVolumes = removed.includes(key) || recreateVolume.includes(key);
      if (removeVolumes) {
        log.warn(`REMOVAL REASON: Reconciliation - ${deployComp.identifier} ${removed.includes(key) ? 'removed from spec' : 'storage changed'}`);
      }
      // A declared graceful contract routes the stop through flux-shutdownd,
      // component-scoped — siblings keep serving; everything else takes the
      // teardown's local stop.
      // eslint-disable-next-line no-await-in-loop
      const stopHandled = await requestComponentDaemonStop(
        oldDeployment.identity, appName, oldDeployment.replica ?? null, deployComp,
      );
      // eslint-disable-next-line no-await-in-loop
      await appUninstaller.uninstallComponent(deployComp, { removeVolumes, skipPorts: true, stopHandled });
      // A component the new spec drops has left the instance; its block goes
      // with it. One rebuilt or reinstalled keeps its block for the ports and
      // the volume the reinstall does not recreate.
      // eslint-disable-next-line no-await-in-loop
      if (removed.includes(key)) await appRecords.instanceResources().removeComponent(appName, oldDeployment.replica ?? null, key);
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.delay(config.get('fluxapps.redeploy.composedDelay') * 1000);
    }
  }

  // Close the dropped ports now (before the reinstall): no surviving component uses them,
  // so closing is always safe, and doing it here means a failed reinstall can't leak them
  // (the reconciler reopens survivors' ports on recovery but never sweeps a stale deny).
  if (portsToClose.length) {
    await appUninstaller.denyPorts(recordedPorts.filter((entry) => portsToClose.includes(entry.port)), appName);
  }

  // A kept-volume component keeps its old mount sources, so injected content the
  // new spec dropped (a removed contentRef/contentSlot, or a slot left inside a
  // still-mounted shared atomic dir) survives and would keep being served. Remove
  // the orphaned injected files — only what was injected and no longer is, never
  // owner data — before the containers come back up. recreateVolume wipes the
  // whole volume already; removed components were fully uninstalled above.
  for (const key of keepVolume) {
    // eslint-disable-next-line no-await-in-loop
    await appVolumeService.removeOrphanedInjectedContent(oldByKey.get(key), newByKey.get(key));
  }

  await appRecords.hostedInstances().updateRecord(registrySpec, naming);
  log.info(`Database updated for ${appName}`);

  // THIS identity's view of the update - handing a co-located sibling's view to
  // the reinstalls below would apply its ports/env to the wrong containers.
  const planned = {
    replica: newDeployment.replica ?? null,
    identity: newDeployment.identity ?? null,
    // A component the update adds is named by the registration.
    registrationVersion: await appHistory.registrationVersionOf(appName, registrySpec.uuid) ?? undefined,
    componentKeys: naming.componentKeys,
  };
  // A renamed component's container is recreated under its new name, so the
  // aliases the resources recorded for it are its new name's, not its old ones.
  if (renamed.length > 0) {
    const derived = byKey(await deploymentProvider.planDeployment(registrySpec, { ...planned, recordedNames: false }));
    for (const key of renamed) {
      // eslint-disable-next-line no-await-in-loop
      await appRecords.instanceResources().setComponent(appName, planned.replica, key, 'aliases', derived.get(key).networkAliases);
    }
  }
  const freshDeployment = await deploymentProvider.planDeployment(registrySpec, planned);
  await hwRequirements.checkNodeResourcesReclaiming(freshDeployment);

  // Re-seed telemetry routing from the updated spec. A sink change (key
  // rotation, added/dropped telemetry) can arrive with no component diff,
  // so this cannot ride on component reinstalls — re-announce the running
  // containers so the daemon rebuilds their exporters.
  if (freshDeployment) {
    const telemetrySink = telemetrySinkCache.extractSink(freshDeployment);
    telemetrySinkCache.setSink(appName, telemetrySink);
    telemetryIdentityService.resyncAll();
  }

  const toInstall = [...keepVolume, ...recreateVolume, ...added];
  const created = [];
  const replaced = [];
  if (freshDeployment && toInstall.length > 0) {
    const freshByKey = byKey(freshDeployment);
    const requiresEncryption = shutdownPlan.appRequiresDaemonShutdown(freshDeployment);
    for (const key of toInstall) {
      const deployComp = freshByKey.get(key);
      const createVolumes = recreateVolume.includes(key) || added.includes(key);
      log.info(`Installing ${deployComp.identifier} (${createVolumes ? 'with' : 'without'} volumes)...`);
      if (!createVolumes && !deployComp.isStateless) {
        // A kept volume holds the sources the old spec's mounts had. A mount the
        // new spec adds has none, and docker refuses a bind whose source is absent.
        // eslint-disable-next-line no-await-in-loop
        const stignoreChanged = await appVolumeService.ensureMountSourcesExist(deployComp);
        // eslint-disable-next-line no-await-in-loop
        if (stignoreChanged) await syncthingMonitorHelpers.requestFolderScan(deployComp.syncFolderId);
      }
      // eslint-disable-next-line no-await-in-loop
      await componentProvisioner.installComponent(deployComp, {
        uuid: registrySpec.uuid,
        createVolumes,
        skipPorts: true,
        specVersion: registrySpec.version,
        requiresEncryption,
      });
      created.push(deployComp.name);
      if (!added.includes(key)) replaced.push({ component: deployComp.name, identifier: deployComp.identifier, hard: createVolumes });
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.delay(config.get('fluxapps.redeploy.composedDelay') * 1000);
    }
  }

  // The manifest the app stands on reaches the components this pass left in
  // place before the reconciler starts anything, and is marked delivered then:
  // a component left running under a manifest the update changed gets the
  // reaction its slots declare. A component this pass created took its content
  // at its create step.
  if (freshDeployment) await contentSlotService.provisionContentSlots(freshDeployment, { appName, created });

  // Each component's ports as the resources name them, before any is opened: a
  // port kept from the old spec keeps the methods it was opened by, an added
  // one takes the methods the node opens ports by now.
  const opened = await componentProvisioner.portOpenMethods();
  // eslint-disable-next-line no-restricted-syntax
  for (const [key, comp] of newByKey) {
    const before = resources?.component(key)?.hostPorts ?? [];
    const hostPorts = (comp.hostPorts ?? []).map((port) => ({ port, opened: before.find((p) => p.port === port)?.opened ?? opened }));
    // eslint-disable-next-line no-await-in-loop
    await appRecords.instanceResources().setComponent(appName, replica, key, 'hostPorts', hostPorts);
  }

  // Open the added ports now that the new containers are up. Gate the open on the same
  // teardown-owed signal the install interlock uses: a forced same-name cancel can race
  // this reinstall (force bypasses the per-app gate) — it writes a teardown doc, deletes
  // the row, and tears its ports down; opening here would orphan ufw/UPnP rules for an
  // app that is gone (there is no periodic deny-sweep). The close above always ran
  // (closing is safe); only the open is gated.
  if (portsToOpen.length) {
    if (await owedRemovals.removalOwedFor(appName)) {
      log.info(`reconcileComponents: teardown owed for ${appName}; skipping redeploy port-open (${portsToOpen.join(',')})`);
    } else {
      await componentProvisioner.openHostPorts(portsToOpen, appName, opened);
    }
  }

  // A reconcile that dropped a component leaves its image behind. Now that the
  // new component set is in place, reclaim the removed components' images,
  // reference-gated — an image still shared with a surviving component (or
  // another app) is left alone, and there is no churn because the new set is up.
  // This is the set-diff layer that knows what was dropped; the per-component
  // uninstall primitive does not.
  const removedImages = removed.map((key) => oldByKey.get(key).image);
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
      await fluxShutdowndClient.deleteAppPlanBestEffort(freshDeployment.identity, freshDeployment.replica ?? null);
    }
  }

  // Each component the update replaced, once the whole update is applied: the
  // row was written before the replacements were built, so it is no sign the
  // update finished. The event a component redeploy publishes; `hard` when the
  // component's volume was rebuilt.
  for (const { component, identifier, hard } of replaced) {
    fluxEventBus.publish('app:componentRedeployed', {
      name: appName, component, identifier, hard,
    });
  }
}

async function reconcileApp(installed, registrySpec) {
  const oldDeployments = await deploymentProvider.getInstalledDeployments(installed.name);
  // The registry spec carries no identity - an update KEEPS the identity the
  // app was installed with, or the diff's new side spells <component>_<appName>
  // and matches nothing (no component ever redeploys, and the row's identifier
  // list is rewritten wrong).
  const naming = await componentKeyMap.namingForUpdate(installed, registrySpec);
  const newDeployments = await deploymentProvider.planDeployments(registrySpec, {
    identity: installed.identity ?? null,
    registrationVersion: await appHistory.registrationVersionOf(installed.name, installed.uuid) ?? undefined,
    componentKeys: naming.componentKeys,
  });
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
      await reconcileComponents(installed.name, oldDeployment, newDeployment, registrySpec, naming);
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
    appReconciler.enqueueApp(installed.name);
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
    const installedApps = await appRecords.hostedInstances().apps();
    // One plan per deployment, as the daemon keys them: the app's identity, and
    // a named replica's segment after it (neither can contain ':').
    const planKey = (identity, replica) => (replica != null ? `${identity}:${replica}` : identity);
    const stored = new Map(summaries.map((s) => [planKey(s.identity, s.replica ?? null), s]));
    const live = new Set();
    let pushed = 0;
    let deleted = 0;

    for (const installed of installedApps) {
      // Couldn't evaluate the app: keep every plan it holds rather than orphan them.
      const keepAllStored = () => {
        for (const [key, s] of stored) {
          if (s.identity === shutdownPlan.daemonIdentity(installed)) live.add(key);
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
        const key = planKey(deployment.identity, deployment.replica ?? null);
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
      await fluxShutdowndClient.deleteAppPlanBestEffort(summary.identity, summary.replica ?? null);
      deleted += 1;
    }

    if (pushed || deleted) log.info(`shutdown plan resync: ${pushed} re-pushed, ${deleted} orphans removed`);
  } catch (error) {
    log.error(`shutdown plan resync failed: ${error.message}`);
  }
}

/**
 * One pass of the activeStandby election - see activeStandbyElection.
 * @returns {Promise<void>}
 */
function coordinateActiveStandbyApps() {
  return activeStandbyElection.electionPass();
}

// A pass must never overlap itself: the cadence is a fixed interval, so a pass that
// outruns it would otherwise have a second one racing its own promotions.
let coordinatorPassInFlight = false;

/**
 * Drives the active-standby election on a fixed interval.
 *
 * The cadence is level-triggered on purpose. The loop used to re-arm itself from its own
 * `finally` - the only reschedule there was - so a pass that never settled stopped
 * election on that node permanently, recoverable only by restarting FluxOS. The operation
 * registry does not cover this: its TTL bounds the coordinator LEASE so other operations
 * proceed, but nothing re-arms the decider. A timer that fires regardless of what the
 * previous pass did removes that whole failure mode.
 *
 * Note this bounds overlap, not pass duration: a pass that hangs still holds the
 * single-flight and no election happens until it settles. Abandoning it would need a
 * supersession guard first, or the abandoned pass keeps running and later flips a live
 * primary's folder to receiveonly or reverses a start its replacement already made.
 * @returns {NodeJS.Timeout} the interval handle
 */
function startActiveStandbyCoordinator() {
  const intervalMs = config.get('fluxapps.masterSlaveIntervalMs');
  return setInterval(async () => {
    if (coordinatorPassInFlight) {
      log.info('activeStandby: previous pass still in flight, skipping this tick');
      return;
    }
    coordinatorPassInFlight = true;
    try {
      await coordinateActiveStandbyApps();
    } finally {
      coordinatorPassInFlight = false;
    }
  }, intervalMs);
}

/**
 * Get from another peer the list of apps installing errors or just for a specific application name
 * @returns {Promise<void>}
 */
async function getPeerAppsInstallingErrorMessages() {
  try {

    if (peerManager.getNumberOfPeers() === 0) {
      log.info('getPeerAppsInstallingErrorMessages - No peers held');
      return;
    }

    let finished = false;
    let i = 0;
    while (!finished && i <= 10) {
      i += 1;
      const peer = peerManager.getRandomPeer();
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
        timeout: 30_000,
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
  requestComponentDaemonStop,
  redeployApplication,
  reconcileComponents,
  redeployApplicationAPI,
  redeployComponentAPI,
  updateAppGlobaly,
  updateAppGlobalyApi,
  contentBlobServeApi,
  appendBackupTask,
  runBackupTask,
  appendRestoreTask,
  runRestoreTask,
  reconcileApp,
  shutdownPlanResync,
  coordinateActiveStandbyApps,
  startActiveStandbyCoordinator,
  getPeerAppsInstallingErrorMessages,
  startApplication,
  stopApplication,
  // The promote workflow, exported so its decision can be asserted directly.
  // Its five call sites are all inside coordinateActiveStandbyApps and all
  // fire-and-forget, so driving it through the election would assert the
  // election rather than the promotion.
  // Exported so the two-writer rule can be exercised without driving the whole
  // election: the loop reaches it only through the grant, FDM and index gates.
  isElectedPrimary: activeStandbyElection.isElectedPrimary,
  isElectedPrimaryHere: activeStandbyElection.isElectedPrimaryHere,
};
