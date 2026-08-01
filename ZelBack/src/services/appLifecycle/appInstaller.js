// path is used for dynamic requires in the file
// eslint-disable-next-line no-unused-vars
const path = require('path');
const fsPromises = require('node:fs/promises');
const serviceHelper = require('../serviceHelper');
const verificationHelper = require('../verificationHelper');
const appNetworkLinker = require('./appNetworkLinker');
const appDockerNetwork = require('../appNetwork/appDockerNetwork');
const messageHelper = require('../messageHelper');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const appUninstaller = require('./appUninstaller');
const componentProvisioner = require('./componentProvisioner');
const contentBlobService = require('./contentBlobService');
const contentSlotService = require('./contentSlotService');
const appReconciler = require('../appMonitoring/appReconciler');
const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');
const { storeAppInstallingErrorMessage } = require('../appMessaging/messageStore');
const { checkPlacement, checkNodeResources } = require('../appRequirements/hwRequirements');
const { isImageBlocked } = require('../appSecurity/imageManager');
// pgpService is used in commented out code
// eslint-disable-next-line no-unused-vars
const pgpService = require('../pgpService');
const operationRegistry = require('../utils/operationRegistry');
const globalState = require('../utils/globalState');
const pendingTeardownStore = require('./pendingTeardownStore');
const admissionControl = require('../utils/admissionControl');
const cpuBurstHelper = require('../utils/cpuBurstHelper');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const telemetrySinkCache = require('../telemetrySinkCache');
const telemetryConfigService = require('../telemetryConfigService');
const shutdownPlan = require('./shutdownPlan');
const fluxShutdowndClient = require('../utils/fluxShutdowndClient');
const log = require('../../lib/log');
const appsRepository = require('../appDatabase/appsRepository');
const fluxEventBus = require('../utils/fluxEventBus');
const config = require('config');

// Write injected content to a mount source as root-owned 0644 — the platform
// default for declared content (mirrors DeploymentSpec resolveMountPerms). Mode
// bits are ownership hygiene, not enforcement: a root container writes through
// any mode, and real read-only intent is the mount's readOnly bind flag.
async function writeInjectedContent(source, bytes) {
  await fsPromises.writeFile(source, bytes);
  await fsPromises.chmod(source, 0o644);
}

/**
 * Outcome of installApplication. Separates a transient deferral (retry later) from a
 * permanent rejection and a real failure, so callers can back off appropriately.
 */
const InstallStatus = Object.freeze({
  INSTALLED: 'installed', // installed and launched
  SKIPPED: 'skipped', // already installed - nothing to do
  DEFERRED: 'deferred', // could not decide / node busy - retry later
  REJECTED: 'rejected', // admission denied for this spec - won't change on retry
  FAILED: 'failed', // install started then errored - local cleanup already done
});

let onInstallComplete = null;
function setOnInstallComplete(callback) {
  onInstallComplete = callback;
}

/**
 * Store + broadcast a fluxappinstallingerror so peers learn this app failed to
 * install here — it feeds their spawn decisions and error counting, and is what
 * makes one node's discovery of a broken app network-wide knowledge. Both the
 * provisioning-failure catch and the converge-trial rollback route through here.
 * Best-effort: a failed store/broadcast must never mask the install failure it
 * reports.
 * @param {string} appName
 * @param {string} hash app hash the error is cached against
 * @param {Error|string} error failure to report
 */
async function storeAndBroadcastInstallError(appName, hash, error) {
  try {
    const ip = await fluxNetworkHelper.getLocalSocketAddress();
    if (!ip) return;
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    const message = {
      type: 'fluxappinstallingerror',
      version: 1,
      name: appName,
      hash,
      error: serviceHelper.ensureString(errorResponse),
      ip,
      broadcastedAt: Date.now(),
    };
    await storeAppInstallingErrorMessage(message);
    await fluxCommunicationMessagesSender.broadcastMessageToAll(message);
  } catch (err) {
    log.error(`storeAndBroadcastInstallError - ${appName}: ${err.message}`);
  }
}

/**
 * To register an app locally. Runs the admission checks (resources, image blocklist)
 * before any state is mutated, then registers the app in the database and performs the
 * install. If the install fails after it has started, the app is removed locally.
 * @param {object} instantiated Instantiated app spec.
 * @param {object} [options] onStatus stream callback, createVolumes, sendRemovalMessage.
 * @returns {Promise<{status: string, reason: string|null}>} status is an InstallStatus
 *   value: INSTALLED (success), SKIPPED (already installed), DEFERRED (transient - blocklist
 *   unreachable or node busy, retry later), REJECTED (blocked image - won't change on retry),
 *   FAILED (install started then errored; local cleanup already done).
 */
async function installApplication(instantiated, options = {}) {
  const onStatus = options.onStatus || null;
  const createVolumes = options.createVolumes !== false;
  const sendRemovalMessage = options.sendRemovalMessage || false;
  // The identity this install provisions: a replica name (named placement) or
  // null (loose). Normalized to a definite value right after the lease, so
  // every downstream build/uninstall passes a uniform { replica }.
  let replica = 'replica' in options ? options.replica : undefined;
  const appName = instantiated.name;
  // Hoisted out of the try so the post-finally converge-wait can read its components.
  let deployment;
  // Hoisted so the finally releases ONLY a lease this call actually acquired — the
  // token stays null on the deferred early-return (an own-checked no-op), so a
  // deferred install can never clobber the holder's lease.
  let installToken = null;
  // Hoisted so the finally drops ONLY a controller this call registered: an early bail
  // (already installed / teardown owed) returns before registration, and an unconditional
  // delete-by-name would evict a different same-name install's controller.
  let controllerRegistered = false;
  try {
    // Per-app: defer only if THIS app is already mid-operation. Installs of
    // different apps now run concurrently - the admission semaphore backstops
    // resource accounting, ports are per-port, swap is serialized.
    if (operationRegistry.isHeld(appName)) {
      log.error(`An operation is already in progress for ${appName}. Installation not possible.`);
      return { status: InstallStatus.DEFERRED, reason: `An operation is already in progress for ${appName}` };
    }
    // Acquire the per-app operation lease — the sole record that this app is
    // mid-install. Released in the finally.
    installToken = operationRegistry.acquire(appName, 'install', 'appInstaller', `install ${appName}`);

    // Register this install's AbortController BEFORE the awaited pre-pull work (own-IP,
    // DB reads, the teardown-owed gate) so a cancel arriving during that I/O finds the
    // controller and can abort the upcoming image pull — closing the abort TOCTOU. A
    // cancel/removal of this app calls globalState.abortInstall(appName); the signal is
    // threaded into each component's pull and the controller is cleared in the finally.
    globalState.installingApps.set(appName, new AbortController());
    controllerRegistered = true;

    const localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();
    if (!localSocketAddr) {
      throw new Error('Unable to detect Flux IP address');
    }

    if (replica === undefined) {
      replica = await deploymentProvider.resolveDeploymentIdentity(instantiated);
    }

    log.info('Running initial checks for Flux App...');
    if (onStatus) onStatus({ status: 'Running initial checks for Flux App...' });

    log.info('Checking database...');
    if (onStatus) onStatus({ status: 'Checking database...' });
    // Installed state is keyed per identity, so this asks about THIS replica and
    // a co-located sibling's row never masks it.
    if (await appsRepository.existsInstalledIdentity(appName, replica ?? null)) {
      const subject = replica == null ? `Flux App ${appName}` : `Flux App ${appName} replica ${replica}`;
      log.error(`${subject} already installed`);
      return { status: InstallStatus.SKIPPED, reason: `${subject} already installed` };
    }

    // Install-side interlock (cancel-vs-install): refuse to adopt a name while a teardown
    // of it is still owed. A forced cancel runs its teardown in the background — its
    // prelude already deleted the local row (so the check above misses it) while the
    // detached umount + rm -rf of the volume keep running. Starting now would create a
    // fresh volume that teardown promptly rm -rf's. Defer; the spawner retries once the
    // teardown clears its doc. teardownOwedFor fails CLOSED, so a read blip defers rather
    // than races a live teardown — the safe direction here.
    if (await pendingTeardownStore.teardownOwedFor(appName)) {
      log.warn(`Flux App ${appName} is still being torn down; deferring installation until teardown completes`);
      return { status: InstallStatus.DEFERRED, reason: `Flux App ${appName} is still being torn down; deferring installation` };
    }

    await checkPlacement(instantiated);

    // Apps whose spec demands Arcane — an encrypted envelope, or any
    // Arcane-requiring feature (telemetry, content delivery, graceful
    // shutdown, preStop) — may only install on an attested ArcaneOS node.
    // The spawner refuses these before selection; this covers direct and
    // targeted installs, and turns the encrypted case's decrypt failure
    // into a clean rejection.
    if (instantiated.requiresArcane() && !globalState.isArcane()) {
      const reason = `Flux App ${appName} requires an attested ArcaneOS node`;
      if (onStatus) onStatus(messageHelper.createErrorMessage(reason));
      return { status: InstallStatus.REJECTED, reason };
    }

    deployment = await deploymentProvider.buildDeployment(instantiated, { replica });
    // Check resources and reserve them atomically: two concurrent installs of
    // different apps must not both pass before either is accounted (the in-flight
    // double-admit race). The reservation is released once the app is durably in
    // the DB (counted by appsResources) or the install fails (the finally).
    await admissionControl.withLock(async () => {
      await checkNodeResources(deployment);
      admissionControl.reserve(appName, deployment);
    });

    // Admission decision, taken before any state is mutated so neither outcome needs
    // cleanup: a blocked image is a rejection (won't change on retry); an unreachable
    // blocklist is a deferral (transient - retry rather than admit something unchecked).
    const blockResult = await isImageBlocked(appName, deployment.allImages(), { owner: instantiated.owner, hash: instantiated.hash });
    if (blockResult.blocked) {
      if (onStatus) onStatus(messageHelper.createErrorMessage(blockResult.reason));
      return { status: InstallStatus.REJECTED, reason: blockResult.reason };
    }
    if (blockResult.undetermined) {
      const reason = `Image blocklist unreachable - cannot verify ${appName} for installation, will retry`;
      if (onStatus) onStatus(messageHelper.createErrorMessage(reason));
      return { status: InstallStatus.DEFERRED, reason };
    }

    // Verify every app this app shares a network with is installed locally and
    // same-owner before any container is created — aborts early otherwise. A
    // dependency that is merely not installed yet is a transient ordering
    // condition (apps register in any order), so it defers rather than fails —
    // a failure would bury this app in the spawner's 7-day error cache and keep
    // it locked out long after the dependency arrives.
    try {
      await appNetworkLinker.checkAppNetworkRequirements(instantiated);
    } catch (error) {
      if (error.code === 'NETWORK_DEPENDENCY_NOT_READY') {
        if (onStatus) onStatus(messageHelper.createErrorMessage(error.message));
        return { status: InstallStatus.DEFERRED, reason: error.message };
      }
      throw error;
    }

    await appDockerNetwork.ensureAppDockerNetwork(appName, { onStatus });

    log.info(`Initiating Flux App ${appName} installation...`);
    if (onStatus) onStatus({ status: `Initiating Flux App ${appName} installation...` });

    const dbSpecs = instantiated.serialize();

    // This identity's row. A stale row for the SAME identity is replaced (the
    // old registration-cleanup case); a co-located sibling's row is a different
    // key entirely and is never touched.
    if (await appsRepository.existsInstalledIdentity(appName, replica ?? null)) {
      log.warn(`Found existing database entry for ${appName} during registration. Cleaning up stale entry.`);
      await appsRepository.removeInstalledIdentity(appName, replica ?? null);
      log.info(`Stale database entry for ${appName} removed. Proceeding with fresh insert.`);
    }

    const insertResult = await appsRepository.insertInstalledApp(dbSpecs, replica ?? null);
    if (!insertResult) {
      throw new Error(`CRITICAL: Failed to create database entry for ${appName}. Database insert returned undefined - likely duplicate key error or database failure. Aborting installation to prevent orphaned Docker containers.`);
    }
    log.info(`Database entry created for ${appName} BEFORE Docker container creation`);
    // Now counted by appsResources (it is in the DB); drop the pending reservation
    // so it is not double-counted. The finally releases it on any earlier failure.
    admissionControl.release(appName);

    try {
      if (!await appsRepository.existsInstalledIdentity(appName, replica ?? null)) {
        throw new Error(`Database entry validation failed for ${appName}. Entry was inserted but disappeared before Docker container creation. Possible race condition or database corruption detected.`);
      }
      log.info(`Database entry validated for ${appName} before Docker container creation`);

      const freshInst = await appsRepository.getInstalledIdentity(appName, replica ?? null);
      if (!freshInst) throw new Error(`Failed to read back installed spec for ${appName}`);
      const deployment = await deploymentProvider.buildDeployment(freshInst, { replica });
      if (!deployment) throw new Error(`Failed to build deployment for ${appName}`);

      // Record this app's telemetry sink (Arcane-only; null/no-op otherwise)
      // so the identity socket can route its containers to its own backend,
      // and make sure the daemon is running before its containers are created.
      const telemetrySink = telemetrySinkCache.extractSink(deployment);
      telemetrySinkCache.setSink(appName, telemetrySink);
      if (telemetrySink) await telemetryConfigService.ensureNode();

      const { owner } = instantiated;
      const burstEligible = owner
        && cpuBurstHelper.isEnterpriseOwner(owner)
        && await cpuBurstHelper.isCpuBurstSupported();
      const restartAlwaysOwners = config.fluxapps.restartAlwaysOwners || [];
      const restartPolicy = (owner && restartAlwaysOwners.includes(owner)) ? 'always' : null;

      // App-wide feature check computed once: gates the per-container budget labels
      // stamped at docker-create, on the same channel as owner.
      const requiresEncryption = shutdownPlan.appRequiresDaemonShutdown(deployment);

      for (const [, component] of deployment.componentEntries()) {
        // eslint-disable-next-line no-await-in-loop
        await componentProvisioner.installComponent(component, {
          onStatus,
          createVolumes,
          burstEligible,
          restartPolicy,
          owner: instantiated.owner,
          requiresEncryption,
          // Abort the in-flight image pull if a concurrent cancel/removal of this app
          // fires (globalState.abortInstall).
          abortSignal: globalState.installingApps.get(appName)?.signal || null,
        });
        // Attach the freshly created container to every linked app's network.
        // eslint-disable-next-line no-await-in-loop
        await appNetworkLinker.connectComponentToLinkedApps(component.identifier, deployment);
      }

      // Provision declared content — blobs and slots — onto the now-created mount
      // sources before the reconciler starts the containers. Each is resolved
      // peers-first by locator (FluxDrive is the backstop) and hash-verified. A
      // content app is not installable without its content, so a failure here aborts
      // the install (the reconciler retries) rather than starting on empty/stale
      // content. Blobs take their hash from the signed spec; slots take theirs from
      // the latest owner-signed manifest (this node's store, else a running peer).
      const hasBlobs = deployment.componentEntries().some(([, c]) => c.hasContentBlobs());
      const hasSlots = deployment.componentEntries().some(([, c]) => c.hasContentSlots());
      if (hasBlobs || hasSlots) {
        if (onStatus) onStatus({ status: 'Provisioning content...' });
        // Locations are normalized ip:port, usable directly as peer URLs; shuffle
        // so installing nodes don't all hit the same peer first (herd-safety).
        const locations = await appsRepository.appLocationFromEvents({ appname: appName });
        const peers = locations.map((loc) => loc.ip).filter(Boolean);
        for (let i = peers.length - 1; i > 0; i -= 1) {
          const j = Math.floor(Math.random() * (i + 1));
          [peers[i], peers[j]] = [peers[j], peers[i]];
        }
        if (hasBlobs) {
          await contentBlobService.provisionContentBlobs(
            deployment,
            { appName, fluxID: instantiated.owner, peers },
            { writeFile: writeInjectedContent, peerFetch: contentBlobService.fetchBlobFromPeer },
          );
        }
        if (hasSlots) {
          await contentSlotService.provisionContentSlots(
            deployment,
            { appName, peers },
            { peerFetch: contentBlobService.fetchBlobFromPeer },
          );
        }
      }

      // Hand the full shutdown plan to flux-shutdownd (best-effort; Arcane-only
      // — the socket is absent elsewhere and the call no-ops). Only graceful apps
      // get a plan: the predicate is feature-driven, mirroring the budget labels.
      // Per-container labels were stamped at docker-create; this carries the
      // richer plan (preStop argv, drain config) the labels can't hold. The whole
      // handoff is guarded — building or pushing the plan must never break an install.
      if (shutdownPlan.appRequiresDaemonShutdown(deployment)) {
        try {
          await fluxShutdowndClient.upsertAppPlanBestEffort(
            shutdownPlan.buildShutdownPlan(instantiated, deployment),
          );
        } catch (error) {
          log.warn(`flux-shutdownd plan handoff skipped: ${error.message}`);
        }
      }
    } catch (error) {
      // A concurrent cancel/expiry of THIS app aborts the in-flight install (its image
      // pull, or a mid-install condemned/teardown-owed backstop) and rethrows here —
      // before the outer catch classifies the unwind as DEFERRED. Do NOT broadcast a
      // network-wide fluxappinstallingerror for an app we are deliberately tearing down:
      // peers count it as a real install failure for that hash. Suppress the store +
      // broadcast on the same cancel signals the outer catch defers on — installAborted
      // latches the instant the cancel fires (so it is observable here), with the
      // owed-teardown doc as a fail-closed fallback. A linked dependency vanishing
      // mid-install (NETWORK_DEPENDENCY_NOT_READY) is likewise transient, not a real
      // failure, so it is suppressed too. A genuine failure (no cancel) still
      // broadcasts. Always rethrow so the outer catch runs its classification.
      const cancelInFlight = globalState.installAborted(appName)
        || await pendingTeardownStore.teardownOwedFor(appName);
      // A transient-class registry failure (unreachable/rate-limited/5xx, tagged at
      // the pull/verify source) is a node condition too: peers must not count it as
      // the app failing - only a permanent verdict on the image is network knowledge.
      // A managed backend-TLS cert this node could not get signed is the same class:
      // nothing is wrong with the app, this node just cannot serve it right now.
      if (!cancelInFlight && error.code !== 'NETWORK_DEPENDENCY_NOT_READY'
        && error.code !== 'BACKEND_TLS_UNAVAILABLE'
        && error.registryErrorClass !== 'transient') {
        await storeAndBroadcastInstallError(appName, instantiated.hash, error);
      }
      throw error;
    }

    // Reconnect any locally installed apps that are networked with this app — its private
    // network was (re)created during this install. installApplication is always app-level
    // (per-component installs go through installComponent).
    await appNetworkLinker.reconnectLinkedApps(appName);

    log.info(`Flux App ${appName} successfully installed and launched`);
    if (onStatus) onStatus({ status: `Flux App ${appName} successfully installed and launched` });

    // Broadcast this node's running apps now that the app is durably in the DB
    // (insertInstalledApp ran above): checkAndNotifyPeersOfRunningApps builds its
    // snapshot from the installed-app records, so the just-installed app is
    // included in its own announcement. It never throws (it catches internally),
    // so running it here is safe.
    if (onInstallComplete) {
      await onInstallComplete();
      fluxEventBus.publish('app:installed', { name: appName, hash: instantiated.hash });
    }
  } catch (error) {
    log.error(error.message || error);
    // Standard error envelope: stream consumers (frontend, harness) detect a
    // failed install by status:"error" chunks, not by parsing prose.
    if (onStatus) onStatus(messageHelper.createErrorMessage(error.message || error, error.name, error.code));

    // Was this throw a concurrent cancel/expiry of THIS app (it aborted the in-flight
    // pull, or a mid-install backstop fired) rather than a genuine install failure?
    // Returning FAILED would make the spawner 7-day-poison the hash (never cleared),
    // stranding a pinned enterprise app. Defer instead — and do NOT run our own
    // teardown: the in-flight cancel already owns it, so a second uninstall would race
    // it. installAborted latches the instant the cancel fires (so a fast detached
    // teardown cannot out-race it clear), with the owed-teardown doc as a fail-closed
    // fallback.
    const cancelInFlight = globalState.installAborted(appName)
      || await pendingTeardownStore.teardownOwedFor(appName);
    if (cancelInFlight) {
      log.warn(`Install of ${appName} deferred: a concurrent cancel/removal owns its teardown`);
      return { status: InstallStatus.DEFERRED, reason: `A concurrent cancel/removal owns ${appName}'s teardown` };
    }
    log.info(`Error occured. Initiating Flux App ${appName} removal`);
    if (onStatus) onStatus(messageHelper.createErrorMessage(`Error occured. Initiating Flux App ${appName} removal`));
    await appUninstaller.uninstallApplication(appName, { forceKill: true, skipGuard: true, broadcastRemoval: sendRemovalMessage, onStatus, replica });
    log.info(`Cleanup completed for ${appName} after installation failure`);

    // A linked dependency's network vanished mid-install (attach-time
    // NETWORK_DEPENDENCY_NOT_READY). The partial install is cleaned up above; this
    // is the same transient class the pre-install readiness check DEFERS on, just
    // detected later - so DEFER, don't FAIL. Returning FAILED would 7-day-poison
    // the hash in the spawner even though the dependency reinstalls minutes later.
    if (error.code === 'NETWORK_DEPENDENCY_NOT_READY') {
      log.warn(`Install of ${appName} deferred: a linked dependency's network vanished mid-install`);
      return { status: InstallStatus.DEFERRED, reason: error.message };
    }

    // Registry unreachable/rate-limited (transient class): the node couldn't ask,
    // which is not a verdict on the app. The partial install is cleaned up above;
    // DEFER so the spawner retries next cycle instead of 7-day-benching the hash.
    if (error.registryErrorClass === 'transient') {
      log.warn(`Install of ${appName} deferred: registry unreachable (${error.message})`);
      return { status: InstallStatus.DEFERRED, reason: error.message };
    }

    // This node could not get a managed backend-TLS cert signed. Starting the app
    // without one would leave a container that is up and serving nothing while
    // peers count it as a live instance, so the install aborts - but the app is
    // blameless, so DEFER and let it place on a node that can provision it.
    if (error.code === 'BACKEND_TLS_UNAVAILABLE') {
      log.warn(`Install of ${appName} deferred: ${error.message}`);
      return { status: InstallStatus.DEFERRED, reason: error.message };
    }

    return { status: InstallStatus.FAILED, reason: error.message || serviceHelper.ensureString(error) };
  } finally {
    operationRegistry.release(appName, installToken);
    // Drop ONLY a controller this call registered: an early bail before registration
    // must not evict a different same-name install's controller, which would leave a
    // concurrent cancel unable to abort that install's pull.
    if (controllerRegistered) globalState.installingApps.delete(appName);
    // Safety net for every pre-insert failure/early-return path: a reserved-but-
    // not-installed app must never leak its pending resources. Idempotent with the
    // explicit release after insertInstalledApp.
    admissionControl.release(appName);
  }
  // Hand off to the reconciler and await convergence: it starts/holds each
  // component and resolves a settled verdict (the install lease released in the
  // finally above, so the reconcile won't defer). Load-bearing — the reconciler is
  // the sole starter, so this is what turns "provisioned" into "running". A
  // component that exhausts the install-window start attempts fails the converge ->
  // roll the whole install back (provisioned-but-not-running) so the fleet
  // re-places it; a node issue ('provisional' backstop) never rolls back.
  const componentIds = deployment.componentEntries().map(([, comp]) => comp.identifier);
  const { converged, failed } = await appReconciler.awaitConvergence(componentIds);
  if (!converged) {
    // A concurrent cancel during convergence condemns the components — the reconciler
    // then refuses to start them, so they never converge — and owns their teardown.
    // Classify that as a deferral, not a 7-day-poisoning rollback (and skip our own
    // teardown, which would race the cancel's). The install's controller is already
    // cleared by the finally above, so the durable owed-teardown doc is the signal.
    if (await pendingTeardownStore.teardownOwedFor(appName)) {
      log.warn(`Convergence of ${appName} aborted by a concurrent cancel/removal; deferring`);
      return { status: InstallStatus.DEFERRED, reason: `A concurrent cancel/removal owns ${appName}'s teardown` };
    }
    log.warn(`REMOVAL REASON: ${appName} provisioned but did not converge (${failed.join(', ')}); rolling back (appInstaller)`);
    if (onStatus) onStatus(messageHelper.createErrorMessage(`App ${appName} failed to start; rolling back`));
    // A failed install trial is an install failure the network must learn about,
    // exactly like a provisioning failure - without this, every node re-discovers
    // the broken app from scratch.
    await storeAndBroadcastInstallError(appName, instantiated.hash,
      new Error(`App ${appName} failed its install trial: ${failed.join(', ')} never completed a successful run`));
    await appUninstaller.uninstallApplication(appName, { forceKill: true, skipGuard: true, broadcastRemoval: sendRemovalMessage, onStatus, replica });
    return { status: InstallStatus.FAILED, reason: `PROVISIONED-BUT-NOT-RUNNING: ${failed.join(', ')}` };
  }
  return { status: InstallStatus.INSTALLED, reason: null };
}

/**
 * Install application locally - Main API entry point
 * @param {import('express').Request} req - Request object containing appname in params or query
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
async function installApplicationAPI(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname;

    if (!appname) {
      throw new Error('No Flux App specified');
    }

    const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);
    if (!authorized) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
      return;
    }

    const instantiated = await appsRepository.getGlobalAppInfo(appname);
    if (!instantiated) {
      throw new Error(`Application Specifications of ${appname} not found`);
    }

    res.setHeader('Content-Type', 'application/json');
    const onStatus = (msg) => {
      const payload = typeof msg === 'string' ? { status: msg } : msg;
      res.write(serviceHelper.ensureString(payload));
      if (res.flush) res.flush();
    };
    await installApplication(instantiated, { onStatus });
    res.end();
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
 * GET /apps/testappinstall — withdrawn.
 *
 * It ran the app at a hardcoded 0.2 CPU and 300 MB regardless of what the spec
 * declared, so it never tested the app: something needing 4 GB was tested at
 * 300 MB and could fail for a reason that would never occur in production,
 * while a pass proved nothing about the real allocation. Only runonflux/orbit
 * images were health-checked; everything else counted as passing the moment a
 * container started.
 *
 * It was answering two questions with one mechanism, and each has its own
 * answer now. Does the image exist, what architectures does it have, how big is
 * it, does it fit the declared rootFsGb — POST /apps/imagepreflight, without
 * installing anything. Does the app actually run — the playground, at the
 * spec's real declared resources.
 *
 * An error, never a success no-op: a caller who thinks they have tested their
 * app and has not is worse off than one who is told the endpoint is gone.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function testInstallApplicationAPI(req, res) {
  const response = messageHelper.createErrorMessage(
    'testappinstall has been withdrawn. It ran apps at 0.2 CPU / 300MB regardless of '
    + 'their spec, so a pass meant nothing. Use POST /apps/imagepreflight for image '
    + 'facts - existence, architectures, sizes and whether rootFsGb fits - or the '
    + 'playground to watch the app run at its declared resources.',
    'WithdrawnError',
    410,
  );
  return res.status(410).json(response);
}

// Worst-first: any failure outranks a rejection outranks a deferral; a fully
// skipped fan-out reports SKIPPED, anything actually installed reports INSTALLED.
const STATUS_SEVERITY = [
  InstallStatus.FAILED, InstallStatus.REJECTED, InstallStatus.DEFERRED,
  InstallStatus.INSTALLED, InstallStatus.SKIPPED,
];

/**
 * Install every identity this node is assigned for a spec, sequentially - the
 * per-app operation lease serializes replica operations by design, and the
 * per-identity skip guard makes an already-present replica a no-op, so this is
 * the one installer entry a driver (spawner, adoption) needs. Loose placement
 * installs the single unqualified identity, exactly today's install.
 *
 * @param {object} instantiated - InstantiatedSpec
 * @param {object} [options] - forwarded to installApplication per identity
 * @returns {Promise<{status: string, reason: string|null, results: object[]}>}
 *   the worst per-identity outcome, with every identity's result attached
 */
async function installAssignedReplicas(instantiated, options = {}) {
  const identities = await deploymentProvider.assignedIdentities(instantiated);
  const results = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const identity of identities) {
    // eslint-disable-next-line no-await-in-loop
    const result = await installApplication(instantiated, { ...options, replica: identity });
    results.push({ replica: identity, ...result });
  }
  if (results.length === 0) {
    return { status: InstallStatus.SKIPPED, reason: `${instantiated.name} names no replicas for this node`, results };
  }
  const worst = results.reduce((acc, r) => (
    STATUS_SEVERITY.indexOf(r.status) < STATUS_SEVERITY.indexOf(acc.status) ? r : acc
  ));
  return { status: worst.status, reason: worst.reason, results };
}

module.exports = {
  InstallStatus,
  installApplication,
  installAssignedReplicas,
  installApplicationAPI,
  testInstallApplicationAPI,
  setOnInstallComplete,
};
