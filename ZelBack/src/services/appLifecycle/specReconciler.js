'use strict';

const crypto = require('node:crypto');
const config = require('config');
const serviceHelper = require('../serviceHelper');
const log = require('../../lib/log');
const appsRepository = require('../appDatabase/appsRepository');
const registryManager = require('../appDatabase/registryManager');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const dockerService = require('../dockerService');
const generalService = require('../generalService');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const globalState = require('../utils/globalState');
const { socketAddressesMatch } = require('../utils/socketAddressUtils');
const { getSpecBackend } = require('../utils/specLibs');
const imageManager = require('../appSecurity/imageManager');
const shutdownPlan = require('./shutdownPlan');
const appUninstaller = require('./appUninstaller');
const appOperations = require('./appOperations');

// The single owner of one question: does what this node RUNS match what the
// chain says it should run? Every trigger — a block processed at the tip, a
// spec landing in the registry, a post-install propagation wait, a blocklist
// refresh, boot — is only a REQUEST for convergence; the decision ladder below
// is the one body that decides, ordered by severity:
//
//   1. blocklisted image        -> removal            (compliance passes only)
//   2. expired                  -> removal (graceful, backgrounded)
//   3. named, not targeted      -> removal (the declarative diff)
//   4. loose, surplus instance  -> removal (rank by runningSince)
//   5. spec hash differs        -> ADOPTION, scheduled with a stagger
//   6. nothing                  -> converged
//
// Removals act immediately: they restart nobody else, and expiry/de-target are
// exactly what the owner asked for. Adoption never acts inline — a redeploy
// that changes this replica's own view restarts its container, and when an
// update confirms, every node holding the app learns in the same block. The
// stagger turns that into a rolling update instead of a fleet-wide restart:
//
//   named replica  ->  ordinal(my replica, sorted names) x step, where the
//                      step floors at the app's graceful-shutdown budget so
//                      replica N+1 never starts recreating while N drains
//   loose instance ->  hash(local address | app name) % window — the same
//                      fleet-spreading the old randomized sweep bought, but
//                      bounded and stable per (node, app)
//
// The image-compliance step needs full deployment views (a decrypt per app),
// so the cheap per-block pass skips it; blocklist-refresh, boot and backstop
// passes run the whole ladder. The docker-orphan janitor and the global
// registry cleanup stay periodic elsewhere: a crash fires no hooks and
// registry hygiene is not this node's desired state.

const pendingAdoptions = new Map(); // appName -> { timer, hash }

function staggerConfig() {
  return {
    stepMs: config.fluxapps.adoptionStaggerStepMs,
    windowMs: config.fluxapps.adoptionStaggerWindowMs,
  };
}

/**
 * The adoption delay for this node's copy of an app. Named placement rolls the
 * replicas in spec order; loose instances spread over a bounded window.
 * @param {object} registrySpec - hydrated desired spec (placement readable)
 * @param {string} localSocketAddr
 * @returns {Promise<number>} milliseconds
 */
async function adoptionDelayMs(registrySpec, localSocketAddr) {
  const { stepMs, windowMs } = staggerConfig();
  if (registrySpec.placement.mode() === 'pinned') {
    // Replica names live in the sealed assignment - decrypt to read them.
    const runtimeSpec = await deploymentProvider.resolveRuntimeSpec(registrySpec);
    const assigned = await deploymentProvider.resolveLocalReplicas(runtimeSpec);
    if (assigned.length === 0) return 0;
    const names = [...runtimeSpec.assignment.replicaNames()].sort();
    // A co-located node rolls once, at its earliest replica's slot: the local
    // adoption redeploys all its identities together, and the earliest ordinal
    // keeps the fleet-wide roll order intact.
    const ordinal = Math.max(0, Math.min(...assigned.map((replica) => names.indexOf(replica))));
    // Floor the step at the app's graceful-shutdown budget (+15s start margin)
    // so the rolling window never overlaps two replicas down at once. The
    // deployment build is acceptable here: an adoption is about to rebuild it
    // anyway.
    let step = stepMs;
    const deployment = await deploymentProvider.getInstalledDeployment(registrySpec.name);
    if (deployment && shutdownPlan.appRequiresDaemonShutdown(deployment)) {
      const budgetMs = shutdownPlan.appShutdownBudgetSeconds(deployment) * 1000;
      step = Math.max(step, budgetMs + 15000);
    }
    return ordinal * step;
  }
  const digest = crypto.createHash('sha256').update(`${localSocketAddr}|${registrySpec.name}`).digest();
  return digest.readUInt32BE(0) % windowMs;
}

/**
 * Schedule the staggered adoption of a newer spec, coalescing per app: a newer
 * store supersedes a pending one. At fire time the hashes are re-read — the
 * update may have been superseded again, or another path may already have
 * adopted it.
 */
function scheduleAdoption(appName, registryHash, delayMs) {
  const pending = pendingAdoptions.get(appName);
  if (pending) {
    if (pending.hash === registryHash) return; // already scheduled for this exact spec
    clearTimeout(pending.timer);
  }
  log.info(`specReconciler: adoption of ${appName} (${registryHash}) scheduled in ${Math.round(delayMs / 1000)}s`);
  const timer = setTimeout(() => {
    pendingAdoptions.delete(appName);
    fireAdoption(appName).catch((error) => log.error(`specReconciler: adoption of ${appName} failed: ${error.message}`));
  }, delayMs);
  if (timer.unref) timer.unref();
  pendingAdoptions.set(appName, { timer, hash: registryHash });
}

async function fireAdoption(appName) {
  const installed = await appsRepository.getInstalledApp(appName);
  if (!installed) return;
  const registrySpec = await appsRepository.getGlobalAppInfo(appName);
  if (!registrySpec || registrySpec.hash === installed.hash) return;
  await appOperations.reconcileApp(installed, registrySpec);
}

/**
 * The per-app decision ladder. Returns the action taken ('removed' |
 * 'adoption-scheduled' | 'converged' | 'skipped').
 * @param {object} installed - hydrated installed spec
 * @param {object} registrySpec - hydrated desired spec, or null
 * @param {object} ctx - { localSocketAddr, nowSeconds, explorerHeight, includeCompliance }
 */
async function convergeApp(installed, registrySpec, ctx) {
  // Blocklisted image (compliance passes only: needs the deployment view). A
  // blocked app is removed regardless of any other state.
  if (ctx.includeCompliance) {
    const deployment = await deploymentProvider.getInstalledDeployment(installed.name);
    const images = deployment ? deployment.allImages() : [];
    const blockResult = await imageManager.isImageBlocked(installed.name, images, { owner: installed.owner, hash: installed.hash });
    if (blockResult.blocked) {
      log.warn(`REMOVAL REASON: Blacklisted image - ${installed.name} uses a blacklisted Docker image`);
      await appUninstaller.uninstallApplication(installed.name, { broadcastRemoval: true });
      return 'removed';
    }
  }

  // Expiry is a property of the network-confirmed spec, so the authoritative
  // global row decides (a stale local row must neither remove a renewed app
  // nor keep a cancelled one); an app with no global registration falls back
  // to its local row. Height 0 never expires.
  const authoritative = registrySpec || installed;
  if (authoritative.height !== 0
    && (!authoritative.height || authoritative.isExpired(ctx.nowSeconds, ctx.explorerHeight))) {
    log.warn(`REMOVAL REASON: App expired - ${installed.name} reached expiration date (specReconciler)`);
    await appUninstaller.uninstallApplication(installed.name, {
      forceKill: false, skipGuard: true, broadcastRemoval: true, background: true,
    });
    return 'removed';
  }
  if (!registrySpec) return 'skipped';

  // The identities the spec assigns this node: the named replicas targeting it,
  // or the single unqualified identity that loose placement always has.
  // mode() is cleartext, so candidate/none apps are decided without a decrypt.
  // Only a pinned app decrypts (assignedIdentities) to read its sealed names.
  const named = registrySpec.placement.mode() === 'pinned';
  const assigned = named ? await deploymentProvider.assignedIdentities(registrySpec) : [null];
  if (named && assigned.length === 0) {
    // Named placement is declarative: the targeting maps name exactly which
    // nodes run a replica, so an installed copy on a node the current spec
    // does not name is removed — precisely the replica the owner deleted.
    // Checked regardless of hash equality, so it also heals a node whose
    // identity drifted out of the maps.
    log.warn(`REMOVAL REASON: Named placement does not target this node - ${installed.name}`);
    await appUninstaller.uninstallApplication(installed.name, { broadcastRemoval: true });
    return 'removed';
  }

  // Per-identity diff: shed exactly the identities this node holds but the spec
  // no longer assigns it - a de-targeted replica, a pre-qualification
  // (unlabeled) install that must requalify, or a qualified replica left behind
  // when the owner switched the app back to loose - while its siblings run on
  // untouched. Both modes are diffed: loose placement assigns the unqualified
  // identity and only that, so every qualified container it still holds is
  // stale by the same rule. Missing assigned identities install via the
  // spawner, not here.
  const present = await dockerService.getAppContainerObjects(installed.name).catch(() => []);
  const { LABEL_KEYS } = await getSpecBackend();
  const presentIdentities = [...new Set(present.map((c) => (c.Labels && c.Labels[LABEL_KEYS.REPLICA]) || null))];
  const stale = presentIdentities.filter((identity) => !assigned.includes(identity));
  if (present.length > 0 && stale.length > 0) {
    let removedOne = false;
    // eslint-disable-next-line no-restricted-syntax
    for (const identity of stale) {
      let reason;
      if (identity === null) reason = 'Pre-qualification install requalifying';
      else if (named) reason = `Named placement no longer assigns replica ${identity} to this node`;
      else reason = `Placement is loose - replica ${identity} must de-qualify`;
      log.warn(`REMOVAL REASON: ${reason} - ${installed.name}`);
      // eslint-disable-next-line no-await-in-loop
      const result = await appUninstaller.uninstallApplication(installed.name, { broadcastRemoval: true, replica: identity });
      removedOne = removedOne || result.status === appUninstaller.UninstallStatus.REMOVED;
    }
    if (removedOne) return 'removed';
  }

  // The count-based eviction is loose-only: it sheds by instance rank, which
  // during a named scale-down or mode switch can be a still-targeted replica.
  if (!named && ctx.localSocketAddr) {
    // Loose placement sheds surplus by instance rank (oldest instances keep
    // their seats). Every surplus node self-identifies in one pass, so an
    // election overshoot trims in a single cycle. Graceful: trimming surplus
    // is never an emergency, so it defers on any in-flight operation and
    // drains rather than force-kills.
    const required = installed.spec.instances || config.fluxapps.minimumInstances;
    const runningAppList = await registryManager.appLocation(installed.name);
    if (runningAppList.length > required) {
      runningAppList.sort((a, b) => {
        if (!a.runningSince && b.runningSince) return -1;
        if (a.runningSince && !b.runningSince) return 1;
        if (a.runningSince < b.runningSince) return -1;
        if (a.runningSince > b.runningSince) return 1;
        return 0;
      });
      const rank = runningAppList.findIndex((x) => socketAddressesMatch(x.ip, ctx.localSocketAddr));
      if (rank + 1 > required) {
        log.warn(`REMOVAL REASON: Exceeded required instances - ${installed.name} runs ${runningAppList.length} of ${required}; this instance ranks ${rank + 1}`);
        if (installed.hash && globalState.trySpawningGlobalAppCache) globalState.trySpawningGlobalAppCache.delete(installed.hash);
        await appUninstaller.uninstallApplication(installed.name, { broadcastRemoval: true });
        return 'removed';
      }
    }
  }

  // Apps whose spec demands Arcane — an encrypted envelope, or any
  // Arcane-requiring feature (telemetry, content delivery, graceful
  // shutdown, preStop) — may only run on an attested ArcaneOS node. The
  // verdict is resolved before convergence runs, so a non-arcane verdict
  // is definitive.
  if (registrySpec.requiresArcane() && !globalState.isArcane()) {
    log.warn(`REMOVAL REASON: App requires arcaneOS - ${installed.name}`);
    await appUninstaller.uninstallApplication(installed.name, { forceKill: true, skipGuard: true, broadcastRemoval: true });
    return 'removed';
  }

  if (registrySpec.hash !== installed.hash) {
    const delayMs = await adoptionDelayMs(registrySpec, ctx.localSocketAddr);
    scheduleAdoption(installed.name, registrySpec.hash, delayMs);
    return 'adoption-scheduled';
  }
  return 'converged';
}

/** Gates shared by every convergence request: never act while syncing. */
async function convergenceAllowed() {
  if (!globalState.dbReady) return false;
  const synced = await generalService.checkSynced();
  return synced === true;
}

/**
 * Converge every installed app. `includeCompliance` runs the image-compliance step (needs full deployment views, so the per-block pass skips it).
 * @param {{ reason: string, includeCompliance?: boolean }} opts
 */
async function requestFullConvergence({ reason, includeCompliance = false } = {}) {
  try {
    if (!await convergenceAllowed()) return;
    const installedApps = await appsRepository.listInstalledApps();
    if (!installedApps.length) return;
    const localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();
    const installedNames = installedApps.map((app) => app.name);
    const globalRows = await appsRepository.listGlobalAppInfo({ filter: { name: { $in: installedNames } } });
    const globalByName = new Map(globalRows.map((spec) => [spec.name, spec]));
    const ctx = {
      localSocketAddr,
      nowSeconds: Math.floor(Date.now() / 1000),
      explorerHeight: await registryManager.getScannedHeight(),
      includeCompliance,
    };
    const outcomes = { removed: 0, 'adoption-scheduled': 0, converged: 0, skipped: 0 };
    for (const installed of installedApps) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const outcome = await convergeApp(installed, globalByName.get(installed.name) || null, ctx);
        outcomes[outcome] += 1;
        if (outcome === 'removed') {
          // eslint-disable-next-line no-await-in-loop
          await serviceHelper.delay(config.fluxapps.removal.delay * 1000);
        }
      } catch (error) {
        log.error(`specReconciler: convergence failed for ${installed.name}: ${error.message}`);
      }
    }
    if (outcomes.removed || outcomes['adoption-scheduled']) {
      log.info(`specReconciler(${reason}): ${installedApps.length} apps — ${outcomes.removed} removed, ${outcomes['adoption-scheduled']} adoptions scheduled`);
    }
  } catch (error) {
    log.error(`specReconciler(${reason}): ${error.message}`);
  }
}

/**
 * Converge one app, optionally after a delay (e.g. the post-install
 * propagation wait). Fire-and-forget safe.
 */
async function requestAppConvergence(appName, { reason, delayMs = 0 } = {}) {
  try {
    if (delayMs) await serviceHelper.delay(delayMs);
    if (!await convergenceAllowed()) return;
    const installed = await appsRepository.getInstalledApp(appName);
    if (!installed) return;
    const registrySpec = await appsRepository.getGlobalAppInfo(appName);
    const ctx = {
      localSocketAddr: await fluxNetworkHelper.getLocalSocketAddress(),
      nowSeconds: Math.floor(Date.now() / 1000),
      explorerHeight: await registryManager.getScannedHeight(),
      includeCompliance: false,
    };
    const outcome = await convergeApp(installed, registrySpec, ctx);
    if (outcome !== 'converged') log.info(`specReconciler(${reason}): ${appName} -> ${outcome}`);
  } catch (error) {
    log.error(`specReconciler(${reason}): ${appName}: ${error.message}`);
  }
}

/**
 * Spec-stored control hook (production, composed in serviceManager): a spec
 * landing in the registry for an app installed here converges that app now —
 * responsiveness between blocks; the per-block pass is the level-triggered
 * backstop.
 */
async function notifySpecStored(specDoc) {
  try {
    if (!specDoc || !specDoc.name) return;
    const installedHere = await appsRepository.existsInstalledApp(specDoc.name);
    if (!installedHere) return;
    await requestAppConvergence(specDoc.name, { reason: 'specStored' });
  } catch (error) {
    log.error(`specReconciler.notifySpecStored: ${error.message}`);
  }
}

module.exports = {
  requestFullConvergence,
  requestAppConvergence,
  notifySpecStored,
  // exposed for tests
  convergeApp,
  adoptionDelayMs,
};
