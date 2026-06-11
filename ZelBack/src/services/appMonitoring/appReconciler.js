const log = require('../../lib/log');
const fluxEventBus = require('../utils/fluxEventBus');
const dockerService = require('../dockerService');
const globalState = require('../utils/globalState');
const appInspector = require('../appManagement/appInspector');
const appsRuntimeState = require('../appManagement/appsRuntimeState');
const appQueryService = require('../appQuery/appQueryService');
const appsRepository = require('../appDatabase/appsRepository');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const appVolumeService = require('../appLifecycle/appVolumeService');
const containerHealthMonitor = require('./containerHealthMonitor');
const appUninstaller = require('../appLifecycle/appUninstaller');
const appTamperingDetectionService = require('../appTamperingDetectionService');
const telemetrySinkCache = require('../telemetrySinkCache');

// The single, level-based actuator for app containers. Every trigger (docker
// die event, stream reconnect, hourly tick, boot, post-install, and the
// masterSlave/syncthing deciders) just enqueues a component identifier; one
// reconcile per identifier drives the actual Docker state toward the desired
// state. This is the ONLY place that calls appDockerStart/appDockerStop.
//
// Desired state inputs:
//   operatorStopped (durable, appsRuntimeState) - user lock, wins over all.
//   controllerDesired (in-memory, below)        - election/sync output for replicated components.
//   restart policy + actual exit code           - Docker-like restart policy.

// id -> 'running' | 'stopped'. In-memory: re-derived from live truth (FDM
// election + real syncthing sync state) by the deciders each cycle, so it is
// intentionally NOT persisted (a stale election after a reboot must not act).
const controllerDesired = new Map();

const inFlight = new Set(); // ids currently reconciling (per-key single-flight)
const dirty = new Set(); // ids re-requested while in flight -> reconcile again
const bootPending = new Set(); // ids enqueued before the boot gate opened
const backoffTimers = new Map(); // id -> scheduled retry timeout

// while an install/remove/redeploy/backup/restore or a deliberate stop owns a
// container, defer and re-check shortly (the operation also re-enqueues on
// completion, so this is just a backstop)
const MANAGED_RETRY_MS = 5000;

// Replicated components hold silently at awaitingController (correct for a FluxOS
// restart with containers still running), but a hold that outlives many sweep
// cycles means no decider is speaking - e.g. the syncthing first-run gate is
// wedged - and that silence has hidden whole-node outages. Surface it by age.
const AWAITING_CONTROLLER_WARN_MS = 10 * 60 * 1000;
const silentHoldSince = new Map(); // id -> { since, warned }

function trackSilentHold(identifier) {
  const entry = silentHoldSince.get(identifier);
  if (!entry) {
    silentHoldSince.set(identifier, { since: Date.now(), warned: false });
    return;
  }
  const heldMs = Date.now() - entry.since;
  if (!entry.warned && heldMs > AWAITING_CONTROLLER_WARN_MS) {
    entry.warned = true;
    log.warn(`appReconciler - ${identifier} held at awaitingController for ${Math.round(heldMs / 60000)}m - no masterSlave/syncthing decider has declared a desired state for it`);
    fluxEventBus.publish('reconciler:actuated', { identifier, action: 'awaitingControllerHeld', heldMs });
  }
}

// The reconciler's canonical id is the bare component identifier
// (`{component}_{app}`). Deciders disagree on the form they pass — masterSlave
// uses the bare identifier, the syncthing flow passes the flux-prefixed docker
// name — so we normalise every inbound id here, at the boundary, the same way
// dockerService normalises to the prefixed form for docker calls. This keeps the
// spec lookup and all in-memory state (controllerDesired/backoff/runtime) keyed
// consistently no matter which decider triggered the reconcile.
const canonical = (id) => dockerService.getBaseAppName(id);

// --- restart policy ------------------------------------------------------
// getRestartPolicy is the ONLY place the policy source lives: the v9
// per-component spec field. Legacy versions (v1-v8) pin it to 'always' in
// their component classes and the deployment layer bridges absent values, so
// every component answers without a fallback here.
function getRestartPolicy(spec) {
  return spec.comp.restartPolicy;
}

/**
 * Whether a stopped container should be (re)started under the given policy and
 * its actual last exit code. exitCode === null means the container has never
 * run (Docker state 'created'), i.e. an initial start. Values are the v9 spec
 * vocabulary: always | onFailure | never. A clean exit (0) under onFailure
 * means the component completed its work - the run-once init/migration shape.
 */
function policyAllowsRun(policy, exitCode) {
  switch (policy) {
    case 'onFailure': return exitCode === null || exitCode !== 0;
    case 'never': return exitCode === null;
    default: return true; // always
  }
}

// --- desired/actual state ------------------------------------------------

/**
 * Resolves a component identifier to its DeploymentComponent view, or null if
 * the app (or component) is not installed on this node. The deployment layer
 * owns version dispatch, enterprise decryption, and containerData parsing —
 * the reconciler never reads raw spec documents.
 */
async function getLocalComponentSpec(identifier) {
  const mainAppName = identifier.split('_')[1] || identifier;
  let inst;
  try {
    inst = await appsRepository.getInstalledApp(mainAppName);
  } catch (err) {
    // A DB read failure is transient, not "not installed". Throw a tagged error so
    // reconcile defers + retries rather than silently dropping the recovery.
    const error = new Error(`failed to read local spec for ${identifier}: ${err.message}`);
    error.transient = true;
    throw error;
  }
  if (!inst) return null;

  let deployment;
  try {
    deployment = await deploymentProvider.buildDeployment(inst);
  } catch (err) {
    if (inst.isEncrypted) {
      // Decryption failed (e.g. the enterprise key isn't loaded yet at boot).
      // Never act on ciphertext - defer and retry once the key is available.
      const error = new Error(`failed to decrypt enterprise spec for ${identifier}: ${err.message}`);
      error.transient = true;
      throw error;
    }
    // Structural failure (e.g. invalid containerData): the spec can never be
    // actuated - volume construction would throw on the same input - so fail
    // loud instead of looping. Retrying cannot fix an invalid spec.
    return { invalidSpec: true, invalidReason: err.message };
  }

  // A successful build is also the convergence point for telemetry routing:
  // the sink lives behind the same decryption this build just proved
  // available. The boot-time cache rebuild races fluxbenchd's unseal and
  // orphans the cache when it loses (observed live on cabbage); this seam
  // already defer-retries on exactly that dependency, so re-seed here.
  telemetrySinkCache.setSink(mainAppName, telemetrySinkCache.extractSink(deployment));

  // Resolve by matching each component's own identifier - never by parsing
  // the string. A bare app name resolves directly only for v1-v3 flat
  // deployments (whose single component IS the app); for v4+ it matches
  // nothing, including a component named like the app, whose identifier is
  // the name_name stutter.
  const entries = deployment.componentEntries();
  const match = entries.find(([, c]) => c.identifier === identifier);
  if (!match) {
    // An app-level identifier: callers that hold only an app name (boot
    // recovery, the hourly sweep) cannot derive component identifiers - the
    // deployment owns them, sometimes behind encryption - so the reconciler
    // expands the identifier itself. Replicated components are safe to
    // include: they hold at awaitingController until a decider speaks.
    if (!identifier.includes('_')) {
      const expandTo = entries.map(([, c]) => c.identifier);
      if (expandTo.length > 0) return { expandTo };
    }
    // A component-style identifier that resolves to nothing is a real
    // mismatch (renamed component, stale enqueue) - surface it instead of
    // dropping the recovery as if the app were uninstalled.
    return { missingComponent: true };
  }
  const comp = match[1];

  return {
    deployment, comp, invalidSpec: false, invalidReason: null,
  };
}

/**
 * Whether the Docker daemon is reachable at all. A cheap list call: if it
 * answers, docker is up; if it throws (socket down, e.g. dockerd restarting),
 * it is not. Used to disambiguate an inspect failure — see dockerActual.
 */
async function dockerReachable() {
  try {
    await dockerService.dockerListContainers(true);
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Reads the container's actual state from Docker. exitCode is null when the
 * container has never run (state 'created') so restart policies treat it as an
 * initial start.
 *
 * An inspect failure is ambiguous: the container may be genuinely gone, OR
 * docker may be unreachable (mid dockerd-restart). These surface as different,
 * version-dependent errors (a lookup TypeError vs a socket error), so rather
 * than pattern-match the error we probe the daemon directly: if docker is
 * reachable the container really is missing (recreate); if not, `reachable` is
 * false and the caller must defer rather than mistake a down daemon for a
 * vanished container (which would wrongly recreate then uninstall the app).
 */
async function dockerActual(identifier) {
  try {
    const info = await dockerService.dockerContainerInspect(identifier);
    const everRan = info.State && info.State.Status !== 'created';
    return {
      reachable: true,
      exists: true,
      running: !!(info.State && info.State.Running),
      exitCode: everRan ? (info.State.ExitCode ?? null) : null,
    };
  } catch (err) {
    const reachable = await dockerReachable();
    return { reachable, exists: false, running: false, exitCode: null };
  }
}

/**
 * Whether another subsystem currently owns this container — a global
 * install/remove/redeploy, a per-component backup/restore, or the transient
 * window of a deliberate stop/restart/kill (tracked in stoppingContainers).
 * The reconciler must not actuate while one of these is in flight.
 */
function isManagedElsewhere(identifier) {
  if (globalState.isOperationInProgress && globalState.isOperationInProgress()) return true;
  const backup = globalState.backupInProgress || [];
  const restore = globalState.restoreInProgress || [];
  if (backup.includes(identifier) || restore.includes(identifier)) return true;
  if (globalState.stoppingContainers.has(dockerService.getAppIdentifier(identifier))) return true;
  return false;
}

async function effectiveDesiredRunning(identifier, spec, exitCode) {
  if (await appsRuntimeState.isOperatorStopped(identifier)) return { desired: false, reason: 'operatorStopped' };
  // The shutdown pipeline owns a draining/stopping app's containers: draining
  // ones must keep serving (no stop here) and stopped ones must stay down (no
  // restart that races the daemon's signal stage). Take no action while the LB
  // state holds — it self-expires at deadline+slack, and clear/expiry enqueue a
  // reconcile, so recovery resumes the moment the pipeline ends.
  const appName = identifier.split('_')[1] || identifier;
  if (globalState.getAppLbState(appName)) return { desired: null, reason: 'shutdownPipeline' };
  // Only decider-owned components hold for a controller opinion: activeStandby
  // (the election decides which instance runs) and sync-before-start (the sync
  // readiness decider starts it once its data is complete). Plain-sync
  // components replicate data but their run-state is nobody's decision - they
  // run like any other component; holding them would leave a crashed one down
  // forever.
  if (spec.comp.hasActiveStandbySyncthing() || spec.comp.requiresSyncBeforeStart()) {
    const cd = controllerDesired.get(identifier) ?? null;
    // No controller opinion yet. controllerDesired is in-memory, so a FluxOS
    // restart wipes it while the container keeps running (Docker is independent of
    // the FluxOS process). Take no action - leave the container as-is until the
    // masterSlave/syncthing decider re-derives intent. Treating "unset" as "stop"
    // here would bounce every running syncthing app on every FluxOS restart.
    if (cd === null) return { desired: null, reason: 'awaitingController' };
    if (cd !== 'running') return { desired: false, reason: 'controllerDesired' };
  }
  const desired = policyAllowsRun(getRestartPolicy(spec), exitCode);
  return { desired, reason: desired ? 'running' : 'policy' };
}

/**
 * Recreates a vanished container (no Docker event fires for absence), recording
 * the tampering signals and falling back to local removal on failure — the
 * behavior previously in containerHealthMonitor.monitorAndRecoverApps.
 */
async function recreateMissing(identifier) {
  const mainAppName = identifier.split('_')[1] || identifier;

  await appTamperingDetectionService.recordEvent(mainAppName, 'container_vanished', `Container ${identifier} missing, not found in Docker`);
  try {
    await containerHealthMonitor.recreateMissingContainers(identifier);
    appInspector.startAppMonitoring(identifier, globalState.appsMonitored);
    log.info(`appReconciler - recreated missing container ${identifier}`);
    fluxEventBus.publish('reconciler:actuated', { identifier, action: 'recreated' });
  } catch (err) {
    log.error(`appReconciler - failed to recreate ${identifier}: ${err.message}`);
    fluxEventBus.publish('reconciler:actuated', { identifier, action: 'recreateFailed', reason: err.message });
    await appTamperingDetectionService.recordEvent(mainAppName, 'recreation_failed', `Container recreation failure: ${err.message}`);
    if (appTamperingDetectionService.isNetworkMissingError(err.message)) {
      await appTamperingDetectionService.recordEvent(mainAppName, 'network_pruned', `Docker network missing during recreation: ${err.message}`);
    }
    log.warn(`REMOVAL REASON: Container recreation failure - ${mainAppName} (appReconciler)`);
    await appUninstaller.uninstallApplication(mainAppName, { broadcastRemoval: true });
  }
}

// --- the reconcile -------------------------------------------------------

async function reconcile(rawIdentifier) {
  const identifier = canonical(rawIdentifier);
  if (isManagedElsewhere(identifier)) {
    scheduleRetry(identifier, MANAGED_RETRY_MS);
    return;
  }

  let spec;
  try {
    spec = await getLocalComponentSpec(identifier);
  } catch (err) {
    // transient failure reading the local spec (e.g. a momentary DB blip): defer and
    // retry rather than dropping the component's recovery as if it were uninstalled.
    log.warn(`appReconciler - ${identifier} spec read failed, deferring: ${err.message}`);
    scheduleRetry(identifier, MANAGED_RETRY_MS);
    return;
  }
  if (!spec) {
    silentHoldSince.delete(identifier);
    log.info(`appReconciler - ${identifier} not installed here, nothing to enforce`);
    return;
  }

  // App-level identifier expanded by the spec layer (component identifiers
  // live inside the deployment, sometimes behind encryption): reconcile each
  // component individually.
  if (spec.expandTo) {
    log.info(`appReconciler - ${identifier} expanded to components: ${spec.expandTo.join(', ')}`);
    spec.expandTo.forEach((id) => enqueue(id));
    return;
  }

  if (spec.missingComponent) {
    log.error(`appReconciler - ${identifier} does not match any component of its installed deployment, not reconciling`);
    fluxEventBus.publish('reconciler:actuated', { identifier, action: 'missingComponent' });
    return;
  }

  // Invalid containerData (e.g. a sync flag on a non-primary mount, or an index-ref
  // primary): the spec can never be actuated — volume construction would throw — so
  // fail loud and stop. Do NOT scheduleRetry (retrying cannot fix an invalid spec)
  // and do NOT attempt a start. The hourly sweep re-surfaces it, so it stays visible
  // rather than silently looping "not ready".
  if (spec.invalidSpec) {
    log.error(`appReconciler - ${identifier} has invalid containerData, not reconciling: ${spec.invalidReason}`);
    fluxEventBus.publish('reconciler:actuated', { identifier, action: 'invalidSpec', reason: spec.invalidReason });
    return;
  }

  const actual = await dockerActual(identifier);

  // docker unreachable (e.g. dockerd restarting): defer rather than misread the
  // container as vanished and recreate/uninstall it. A reconnect sweep and this
  // retry both re-reconcile once docker is back.
  if (!actual.reachable) {
    log.warn(`appReconciler - docker unreachable for ${identifier}, deferring reconcile`);
    scheduleRetry(identifier, MANAGED_RETRY_MS);
    return;
  }

  const { desired, reason } = await effectiveDesiredRunning(identifier, spec, actual.exitCode);

  // null = no controller opinion yet for a replicated component: neither start nor stop,
  // leave the container in its current state until the decider speaks - but
  // surface the hold once it has outlived any plausible decider cycle.
  if (desired === null) {
    if (reason === 'awaitingController') trackSilentHold(identifier);
    return;
  }
  silentHoldSince.delete(identifier);

  if (!desired) {
    if (actual.running) {
      log.info(`appReconciler - ${identifier} desired stopped, stopping`);
      await dockerService.appDockerStop(identifier);
      fluxEventBus.publish('reconciler:actuated', { identifier, action: 'stopped', reason });
    }
    return;
  }

  if (actual.running) return; // already where we want it

  if (!actual.exists) {
    await recreateMissing(identifier);
    return;
  }

  // exists but stopped, should run -> backoff-paced restart (no sleeping; the
  // worker re-enqueues when the backoff window elapses)
  const wait = await appsRuntimeState.restartWaitMs(identifier);
  if (wait > 0) {
    log.warn(`appReconciler - ${identifier} stopped, backing off ${Math.round(wait / 1000)}s before restart`);
    fluxEventBus.publish('reconciler:actuated', { identifier, action: 'backoff', waitMs: wait });
    scheduleRetry(identifier, wait);
    return;
  }

  // Recreate any bind-mount paths removed while the container was stopped (e.g.
  // Syncthing cleanup of a replicated data folder) before starting — otherwise the
  // start fails on a missing mount source and the app backoff-loops forever.
  await appVolumeService.ensureMountSourcesExist(spec.comp);

  await appsRuntimeState.recordRestart(identifier);
  await dockerService.appDockerStart(identifier);
  appInspector.startAppMonitoring(identifier, globalState.appsMonitored);
  log.info(`appReconciler - ${identifier} restarted`);
  fluxEventBus.publish('reconciler:actuated', { identifier, action: 'started', exitCode: actual.exitCode });
}

// --- workqueue (per-key single-flight, boot-gated) -----------------------

function scheduleRetry(identifier, delayMs) {
  if (backoffTimers.has(identifier)) clearTimeout(backoffTimers.get(identifier));
  const timer = setTimeout(() => {
    backoffTimers.delete(identifier);
    enqueue(identifier);
  }, delayMs);
  if (timer.unref) timer.unref();
  backoffTimers.set(identifier, timer);
}

function runReconcile(identifier) {
  reconcile(identifier)
    .catch((err) => log.error(`appReconciler - reconcile ${identifier} failed: ${err.message}`))
    .finally(() => {
      inFlight.delete(identifier);
      if (dirty.has(identifier)) {
        dirty.delete(identifier);
        setImmediate(() => enqueue(identifier));
      }
    });
}

/**
 * Schedule a reconcile of one component. Coalesces: if a reconcile for the
 * same identifier is in flight, it re-runs once when that finishes. Held until
 * the boot gate opens so nothing actuates before daemon/DB are ready.
 */
function enqueue(rawIdentifier) {
  const identifier = canonical(rawIdentifier);
  if (!globalState.bootContainerStateSettled) {
    bootPending.add(identifier);
    return;
  }
  if (inFlight.has(identifier)) {
    dirty.add(identifier);
    return;
  }
  inFlight.add(identifier);
  runReconcile(identifier);
}

/**
 * Enqueue every installed app (hourly tick / reconnect / boot drift). Apps are
 * enqueued by name; reconcile expands each to its component identifiers
 * through the deployment layer, which owns version dispatch and decryption.
 */
async function enqueueAll(reason = 'resync') {
  const res = await appQueryService.installedApps();
  if (!res || res.status !== 'success') return;
  let count = 0;
  for (const app of res.data) {
    enqueue(app.name);
    count += 1;
  }
  fluxEventBus.publish('reconciler:swept', { reason, count });
}

// --- controllerDesired seam (written by masterSlave/syncthing deciders) ---

/**
 * A decider (masterSlave election / syncthing readiness) declares the desired
 * run-state of a replicated component and triggers enforcement. The decider does its
 * own synchronous data-safety steps (stop+wipe, permission-fix) first; this
 * only records intent and enqueues.
 */
function setControllerDesired(rawIdentifier, state, reason) {
  const identifier = canonical(rawIdentifier);
  controllerDesired.set(identifier, state);
  log.info(`appReconciler - controllerDesired[${identifier}] = ${state} (${reason})`);
  fluxEventBus.publish('reconciler:desiredChanged', { identifier, state, reason });
  enqueue(identifier);
}

function clearControllerDesired(rawIdentifier) {
  controllerDesired.delete(canonical(rawIdentifier));
}

// --- lifecycle -----------------------------------------------------------

let started = false;

async function start() {
  if (started) return;
  started = true;
  await globalState.waitForBootContainerStateSettled();
  // drain everything enqueued during boot now that daemon/DB are ready
  const pending = [...bootPending];
  bootPending.clear();
  pending.forEach((id) => enqueue(id));
}

function stop() {
  started = false;
  backoffTimers.forEach((t) => clearTimeout(t));
  backoffTimers.clear();
  inFlight.clear();
  dirty.clear();
  bootPending.clear();
}

module.exports = {
  enqueue,
  enqueueAll,
  setControllerDesired,
  clearControllerDesired,
  start,
  stop,
  // exposed for tests
  reconcile,
  policyAllowsRun,
  getRestartPolicy,
};
