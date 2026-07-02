const config = require('config');
const log = require('../../lib/log');
const fluxEventBus = require('../utils/fluxEventBus');
const serviceHelper = require('../serviceHelper');
const dockerService = require('../dockerService');
const dockerOperations = require('../appManagement/dockerOperations');
const globalState = require('../utils/globalState');
const { appNameFromIdentifier } = require('../utils/componentIdentifier');
const operationRegistry = require('../utils/operationRegistry');
const specLibs = require('../utils/specLibs');
const appInspector = require('../appManagement/appInspector');
const appsRuntimeState = require('../appManagement/appsRuntimeState');
const appQueryService = require('../appQuery/appQueryService');
const appsRepository = require('../appDatabase/appsRepository');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const appNetworkLinker = require('../appLifecycle/appNetworkLinker');
const appVolumeService = require('../appLifecycle/appVolumeService');
const appSwapPoolService = require('../appLifecycle/appSwapPoolService');
const containerHealthMonitor = require('./containerHealthMonitor');
const appUninstaller = require('../appLifecycle/appUninstaller');
const appTamperingDetectionService = require('../appTamperingDetectionService');
const telemetrySinkCache = require('../telemetrySinkCache');
const reconcilerQueue = require('./reconcilerQueue');

// The lightweight scheduling seam this engine drives: enqueue/scheduleRetry/canonical
// live there, and the engine registers its reconcile + onSettled below. A producer
// that only needs to enqueue depends on reconcilerQueue directly and never pulls this
// engine's heavy dependency tree (the import-hub that made every producer a cycle risk).
const { enqueue, scheduleRetry, canonical } = reconcilerQueue;

// The single, level-based actuator for app containers. Every trigger (docker
// container events via containerEventBridge, stream reconnect, hourly tick, boot,
// post-install, and the masterSlave/syncthing deciders) just enqueues a component
// identifier; one reconcile per identifier drives the actual Docker state toward the
// desired state. This is the sole authority for MANAGED-APP run-state — the only
// other Docker run-state mutations are named exceptions: the uninstaller's terminal
// teardown (destruction), the test-install inline start (componentProvisioner), the
// non-Flux janitor (appController.stopAllNonFluxRunningApps), and the watchtower
// cleanup (imageUpdateService). The set is grep-enforced by
// reconcilerRunAuthority.guard.test.js.
//
// Desired state inputs:
//   operatorStopped (durable, appsRuntimeState) - user lock, wins over all.
//   controllerDesired (in-memory, below)        - election/sync output for replicated components.
//   dataDesired       (in-memory, below)        - sync layer's local-appdata reset.
//   restart policy + actual exit code           - Docker-like restart policy.
//
// Durability rule for these inputs: anything a human ASKED for is durable — it must
// survive a crash until it is carried out (operatorStopped, and the forced-kill mode
// that rides with it: an operator's force-kill lost in a crash would silently downgrade
// to the app's graceful-shutdown window, which can be hours). State the reconciler
// RE-DERIVES from live truth each cycle is in-memory ONLY (controllerDesired from the
// FDM election, dataDesired from sync state): persisting a stale snapshot would act on a
// lie — start a deposed master, or wipe the only good copy. So: durable for human intent,
// transient only for what we can recompute from the live world.

// id -> 'running' | 'stopped'. In-memory: re-derived from live truth (FDM
// election + real syncthing sync state) by the deciders each cycle, so it is
// intentionally NOT persisted (a stale election after a reboot must not act).
const controllerDesired = new Map();

// id -> 'clear'. In-memory peer of controllerDesired: a pending request from the
// sync layer to wipe the component's local appdata before it next runs (the
// first-run / new-app reset). Also NOT persisted - a stale wipe intent surviving
// a restart could delete the only good copy (the same data-loss direction B1
// guards). The reconciler actuates the wipe inside its per-key single-flight, so
// a start can never race it.
const dataDesired = new Map();

// id -> 'stopped'. In-memory peer of controllerDesired: a TRANSIENT run-state hold
// owned by an in-flight operation (backup/restore) that needs the container
// actually stopped while it works on the volume, then running again afterwards. The
// operation drives this THROUGH the reconciler (drive() below) instead of touching
// Docker, so the reconciler stays the sole actuator. NOT persisted: a crash drops
// it, and the aborted operation's app must recover rather than stay wrongly held
// down (the lease that set it is also in-memory and gone after a crash).
const operationDesired = new Map();

// brief settle between the stop and the rm -rf so the container has fully released
// its appdata mount before the wipe (mirrors the sync layer's prior 500ms delay).
const DATA_CLEAR_SETTLE_MS = 500;

// Install converge-wait (Stage 5b): installApplication registers a per-component
// waiter via awaitConvergence and blocks on it. runReconcile resolves 'settled'
// once the reconciler stops trying to change a component (running | legitimately
// held | stopped-by-policy); a converging component that exhausts the install-window
// start attempts resolves 'failed' (-> install rollback); a generous backstop
// resolves 'provisional' (a NODE issue, e.g. docker down: never rolls back). This
// is a DIRECT in-process observer, never FluxEventBus (a prod no-op).
const convergeWaiters = new Map(); // id -> (verdict) => void
const convergeBackstops = new Map(); // id -> backstop timer
// rollback after this many failed start attempts within the window (default 2 =
// initial + one retry); a COUNT not a wall clock, so a node issue never rolls back.
const CONVERGE_FAIL_ATTEMPTS = config.fluxapps.convergeFailAttempts ?? 2;
const CONVERGE_BACKSTOP_MS = config.fluxapps.convergeBackstopMs ?? 5 * 60 * 1000;

// A container start is information the network wants immediately: a backoff
// straggler that starts minutes after boot must refresh its appsLocations row
// inside the sigterm TTL window, not at the next hourly broadcast.
// serviceManager wires this to the peer broadcast (which coalesces bursts),
// mirroring appInstaller.setOnInstallComplete.
let onContainerStarted = null;

function setOnContainerStarted(callback) {
  onContainerStarted = callback;
}

// serviceManager wires this to appShutdownCoordinator.requestGracefulStop. When set and
// it returns true, the daemon owns a graceful stop-but-keep of the app and this
// reconciler takes no docker action (the 'stopping' LB gate holds subsequent passes).
let requestGracefulStop = null;

function setRequestGracefulStop(callback) {
  requestGracefulStop = callback;
}

function notifyContainerStarted(identifier) {
  if (!onContainerStarted) return;
  try {
    onContainerStarted(identifier);
  } catch (err) {
    log.error(`appReconciler - onContainerStarted callback failed for ${identifier}: ${err.message}`);
  }
}

// while an install/remove/redeploy/backup/restore or a deliberate stop owns a
// container, defer and re-check shortly (the operation also re-enqueues on
// completion, so this is just a backstop)
const MANAGED_RETRY_MS = 5000;

// an unmountable volume usually means its host filesystem is still coming up
// (e.g. the encrypted data partition after a reboot) - retry on a pace that
// won't spam, and keep deferring until it mounts
const VOLUME_MOUNT_RETRY_MS = 30 * 1000;

// identifiers whose missing backing image was already recorded as a tampering
// event, so the paced retries don't re-record it every cycle
const volumeMissingNoted = new Set();

// A component can hold silently with no action: awaitingController (no decider has
// spoken) or awaitingDependency (a dependsOn target hasn't reached its condition). Both
// are correct in the moment, but a hold that outlives many sweep cycles means something
// is wedged - a stuck syncthing first-run gate, a dependency that never comes up - and
// that silence has hidden whole-node outages. Surface it by age.
const SILENT_HOLD_WARN_MS = 10 * 60 * 1000;
const silentHoldSince = new Map(); // id -> { since, warned }

function trackSilentHold(identifier, reason) {
  const entry = silentHoldSince.get(identifier);
  if (!entry) {
    silentHoldSince.set(identifier, { since: Date.now(), warned: false });
    return;
  }
  const heldMs = Date.now() - entry.since;
  if (!entry.warned && heldMs > SILENT_HOLD_WARN_MS) {
    entry.warned = true;
    const detail = reason === 'awaitingDependency'
      ? 'a dependsOn target has not reached its condition'
      : 'no masterSlave/syncthing decider has declared a desired state for it';
    log.warn(`appReconciler - ${identifier} held at ${reason} for ${Math.round(heldMs / 60000)}m - ${detail}`);
    fluxEventBus.publish('reconciler:actuated', { identifier, action: 'silentHoldWarned', reason, heldMs });
  }
}

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
  const mainAppName = appNameFromIdentifier(identifier);
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
  const comp = deployment.componentForIdentifier(identifier);
  if (!comp) {
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
  return {
    deployment, comp, invalidSpec: false, invalidReason: null,
  };
}

/**
 * Reads the container's actual state from Docker. exitCode is null when the
 * container has never run (state 'created') so restart policies treat it as an
 * initial start.
 *
 * An inspect failure is ambiguous: the container may be genuinely gone, docker
 * may be unreachable (mid dockerd-restart), or the single inspect call failed
 * transiently while docker is fine. These surface as different,
 * version-dependent errors, so rather than pattern-match the error we probe
 * the daemon with a list call and use its ANSWER, not just its success:
 *   - list throws            -> docker is down: defer (reachable false)
 *   - container IS listed    -> the inspect failure was transient; the
 *                               container exists (indeterminate run-state):
 *                               defer, the next inspect succeeds. Treating it
 *                               as vanished here would falsely record
 *                               tampering, then recreate -> 409 -> uninstall a
 *                               healthy app.
 *   - container NOT listed   -> docker itself confirms absence: vanished.
 */
async function dockerActual(identifier) {
  try {
    const info = await dockerService.dockerContainerInspect(identifier);
    const everRan = info.State && info.State.Status !== 'created';
    // docker's record of the last death - the truth even when the die event was
    // missed (reboot, FluxOS restart, stream gap). Zero value (0001-01-01) means
    // the container never finished.
    const finishedParsed = Date.parse(info.State?.FinishedAt ?? '');
    const finishedAt = Number.isFinite(finishedParsed) && finishedParsed > 0 ? finishedParsed : null;
    return {
      reachable: true,
      exists: true,
      running: !!(info.State && info.State.Running),
      exitCode: everRan ? (info.State.ExitCode ?? null) : null,
      finishedAt,
      // docker HEALTHCHECK status from a v9 livenessProbe: healthy | unhealthy |
      // starting, or null when the component declares no probe.
      health: info.State?.Health?.Status ?? null,
      // docker-network memberships, for the network-membership convergence.
      // null (the error paths below) means unknown - never converge on it.
      networks: Object.keys(info.NetworkSettings?.Networks ?? {}),
    };
  } catch (err) {
    let containers;
    try {
      containers = await dockerService.dockerListContainers(true);
    } catch (probeErr) {
      return {
        reachable: false, exists: false, running: false, exitCode: null, health: null, networks: null,
      };
    }
    const dockerName = dockerService.getAppDockerNameIdentifier(identifier);
    const listed = containers.some((c) => Array.isArray(c.Names) && c.Names.includes(dockerName));
    if (listed) {
      return {
        reachable: true, exists: true, running: false, exitCode: null, health: null, indeterminate: true, networks: null,
      };
    }
    return {
      reachable: true, exists: false, running: false, exitCode: null, health: null, networks: null,
    };
  }
}

/**
 * Converges the container's docker-network memberships on the deployment's
 * declared links: its own app network plus one per network.shareWith target.
 * Runs wherever the reconcile holds a live container - before a start, so a
 * recreated container is wired before it first runs, and on the steady-state
 * pass, so drift (a missed attach, an update that dropped a link, an external
 * disconnect) heals within one reconcile. Best-effort: a failure never blocks
 * the run decision - an app is not held down over a degraded link - it paces
 * a retry instead. No-op when the memberships are unknown (inspect failed).
 */
async function reconcileNetworkMembership(identifier, spec, actual) {
  if (!Array.isArray(actual.networks)) return;
  const { appName } = spec.deployment;
  const desired = [
    `fluxDockerNetwork_${appName}`,
    ...spec.deployment.linkedApps.map((name) => `fluxDockerNetwork_${name}`),
  ];
  const result = await appNetworkLinker.ensureContainerNetworkMembership(identifier, desired, actual.networks);
  if (result.connected.length || result.disconnected.length || result.failed.length) {
    fluxEventBus.publish('reconciler:actuated', {
      identifier, action: 'networkMembership', connected: result.connected, disconnected: result.disconnected, failed: result.failed,
    });
  }
  if (result.failed.length) {
    scheduleRetry(identifier, MANAGED_RETRY_MS);
  }
}

// Operation leases that BUILD or DESTROY containers: while one runs the reconciler
// stands down so it never races container construction/teardown. backup/restore are
// deliberately NOT here — they hold run-state through the transient operationDesired
// (driven via drive()) and the reconciler keeps actuating; freezing it would force
// them to reach around it, the very thing the single-actuator invariant forbids.
const CONSTRUCTION_LEASE_TYPES = new Set(['install', 'remove', 'softRedeploy', 'hardRedeploy', 'reconcile']);

/**
 * Whether a lease blocks the reconciler from actuating this container: a
 * container-construction operation on its parent app (install/remove/redeploy/
 * reconcile) or the component's own transient stop/restart/kill window. The
 * reconciler stands down for these so it never races construction. A backup/restore
 * lease is NOT blocking — those drive run-state through operationDesired and the
 * reconciler keeps actuating. Per-app, NOT a node-wide freeze.
 */
function hasBlockingLease(identifier) {
  // the component's own stop/restart/kill window, keyed on the prefixed docker
  // name exactly as dockerService acquires the 'stopping' lease
  if (operationRegistry.isHeld(dockerService.getAppIdentifier(identifier))) return true;
  // a container-construction operation on the parent app, keyed on the bare app name
  const appLease = operationRegistry.get(appNameFromIdentifier(identifier));
  return !!appLease && CONSTRUCTION_LEASE_TYPES.has(appLease.type);
}

/**
 * The last exit code that the run decision should key on. docker inspect gives it
 * while the container exists; once it has vanished (pruned / removed) the live code is
 * null, so fall back to the durable record (appsRuntimeState.lastExitCode, written on
 * every genuine die and surviving a FluxOS restart). This makes `never` / `onFailure`
 * a real "exactly once / until success" guarantee and a `completed` dependency
 * satisfiable even after its container is gone — instead of re-running on amnesia.
 */
async function effectiveExitCode(identifier, actual) {
  if (actual.exists) return actual.exitCode;
  const rs = await appsRuntimeState.getState(identifier);
  return (rs && rs.lastExitCode !== undefined) ? rs.lastExitCode : actual.exitCode;
}

/**
 * Whether a dependsOn target has reached the required condition, read from its live
 * container state. `started` = running; `healthy` = livenessProbe healthy; `completed` =
 * ran to a clean exit (effective exit code 0, surviving a vanished container).
 */
async function dependencyConditionMet(condition, identifier, actual) {
  if (condition === 'healthy') return actual.health === 'healthy';
  if (condition === 'completed') {
    const exitCode = await effectiveExitCode(identifier, actual);
    return !actual.running && exitCode === 0;
  }
  return actual.running; // 'started'
}

async function effectiveDesiredRunning(identifier, spec, exitCode) {
  // condemned wins over everything: a being-torn-down component must stay stopped
  // (the deferred teardown worker removes it once the reconciler has stopped it) and
  // must never be started, even where the operator lock or a controller would run it.
  if (await appsRuntimeState.isCondemned(identifier)) return { desired: false, reason: 'condemned' };
  if (await appsRuntimeState.isOperatorStopped(identifier)) return { desired: false, reason: 'operatorStopped' };
  // A transient operation hold (backup/restore driving run-state through drive())
  // owns the container for the operation's duration: above policy/controller/
  // dependency, below only the operator's durable lock. Graceful stop — a force-kill
  // rides solely with operatorStopped, never an operation hold.
  if (operationDesired.get(identifier) === 'stopped') return { desired: false, reason: 'operationHold' };
  // The shutdown pipeline owns a draining/stopping app's containers: draining
  // ones must keep serving (no stop here) and stopped ones must stay down (no
  // restart that races the daemon's signal stage). Take no action while the LB
  // state holds — it self-expires at deadline+slack, and clear/expiry enqueue a
  // reconcile, so recovery resumes the moment the pipeline ends.
  const { appName } = spec.comp;
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
  // Hold a dependent until each dependsOn target reaches its condition. dependsOn is a
  // same-node, same-app relationship, so the target's container state is read directly.
  // desired:null (not false) means "leave as-is" — a dependent already running is not
  // stopped if a dependency later flaps; dependsOn is a startup gate, not a runtime
  // kill-switch. The dependency's own start / health_status / clean-exit docker event
  // re-enqueues this dependent (the event bridge calls enqueueDependents), so the hold
  // lifts event-driven, never polled.
  if (spec.comp.hasDependencies()) {
    for (const [depName, condition] of spec.comp.dependencyEntries()) {
      const depComp = spec.deployment.getComponent(depName);
      // validateSemantics guarantees the target exists; skip defensively if not.
      // eslint-disable-next-line no-continue
      if (!depComp) continue;
      // eslint-disable-next-line no-await-in-loop
      const depActual = await dockerActual(depComp.identifier);
      // eslint-disable-next-line no-await-in-loop
      const met = await dependencyConditionMet(condition, depComp.identifier, depActual);
      if (!met) return { desired: null, reason: 'awaitingDependency' };
    }
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
  const mainAppName = appNameFromIdentifier(identifier);

  await appTamperingDetectionService.recordEvent(mainAppName, 'container_vanished', `Container ${identifier} missing, not found in Docker`);
  try {
    await containerHealthMonitor.recreateMissingContainers(identifier);
    log.info(`appReconciler - recreated missing container ${identifier} (created); enqueuing to start`);
    fluxEventBus.publish('reconciler:actuated', { identifier, action: 'recreated' });
    // The container is provisioned in Docker 'created' state (installComponent no
    // longer starts) — enqueue so the reconciler's start branch starts it,
    // registers monitoring, and emits firstStart. Coalesces into this in-flight
    // reconcile via dirty, so the start runs on the immediate follow-up pass.
    enqueue(identifier);
  } catch (err) {
    // Removal must be justified by the state of the world NOW, not at
    // classification time: a whole recreate attempt (image pull - up to
    // minutes) sits between them, during which a redeploy can legitimately
    // create the container (hasOperationLease is only sampled at reconcile
    // entry), or our own recreate can fail AFTER creating it (start/network
    // step). If the container exists, the failure is moot: no tamper events,
    // no removal - retry shortly and converge on the actual state.
    const containerExistsNow = await dockerService.getDockerContainerOnly(identifier).catch(() => undefined);
    if (containerExistsNow) {
      log.info(`appReconciler - recreate of ${identifier} failed (${err.message}) but the container now exists; skipping removal`);
      scheduleRetry(identifier, MANAGED_RETRY_MS);
      return;
    }
    log.error(`appReconciler - failed to recreate ${identifier}: ${err.message}`);
    fluxEventBus.publish('reconciler:actuated', { identifier, action: 'recreateFailed', reason: err.message });
    await appTamperingDetectionService.recordEvent(mainAppName, 'recreation_failed', `Container recreation failure: ${err.message}`);
    if (appTamperingDetectionService.isNetworkMissingError(err.message)) {
      await appTamperingDetectionService.recordEvent(mainAppName, 'network_pruned', `Docker network missing during recreation: ${err.message}`);
    }
    // §14.5 principle: a component that has run here before is NOT destroyed on a
    // failed rebuild (its image is now unpullable, a bad update, a registry blip) —
    // it degrades to DOWN and backs off, so a broken update can never delete an
    // established app + its data, fleet-wide. Only a never-ran component (a fresh
    // install that vanished before it ever started) is removed, mirroring the
    // install converge-wait's count-based rollback.
    const rs = await appsRuntimeState.getState(identifier);
    if (rs && rs.hasSuccessfullyStarted) {
      await appsRuntimeState.recordRestart(identifier);
      const wait = Math.max(await appsRuntimeState.restartWaitMs(identifier), MANAGED_RETRY_MS);
      log.warn(`appReconciler - ${identifier} could not be recreated but has run here before; keeping it (down) and retrying in ${Math.round(wait / 1000)}s`);
      scheduleRetry(identifier, wait);
      return;
    }
    log.warn(`REMOVAL REASON: Container recreation failure (never ran here) - ${mainAppName} (appReconciler)`);
    const removal = await appUninstaller.uninstallApplication(mainAppName, { broadcastRemoval: true });
    if (removal.status === appUninstaller.UninstallStatus.DEFERRED
      || removal.status === appUninstaller.UninstallStatus.FAILED) {
      // Removal didn't land (busy or errored); the app is still in a bad state, so retry
      // the reconcile rather than assume it's gone.
      log.warn(`appReconciler - removal of ${mainAppName} ${removal.status} (${removal.reason}); scheduling retry`);
      scheduleRetry(identifier, MANAGED_RETRY_MS);
    }
  }
}

// --- the reconcile -------------------------------------------------------

async function reconcile(rawIdentifier) {
  const identifier = canonical(rawIdentifier);
  if (hasBlockingLease(identifier)) {
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

  const mainAppName = identifier.split('_')[1] || identifier;

  // The component's data volume is level-based desired state owned HERE, not by
  // a @reboot crontab (unreconciled - its silent loss left volumes unmounted
  // after reboot). It must be mounted before ANY actuation touches the app dir:
  // a data wipe, mount-path creation or container start against the bare
  // mountpoint writes to the host filesystem instead of the volume. It matters
  // even while the container stays stopped - a g:/r: component's syncthing
  // folder lives on it. An app whose volume cannot be mounted stays inert.
  const volumeMount = await volumeService.ensureAppVolumeMounted(identifier);
  if (!volumeMount.mounted) {
    // A stop takes nothing from the app dir, and deferring it would leave the
    // container running over a missing volume with the mount-safety hold
    // unenforceable - the incident's app kept running through the gutted
    // window exactly this way. Honor a pending stop; defer everything else.
    if (controllerDesired.get(identifier) === 'stopped') {
      try {
        const actualNow = await dockerActual(identifier);
        if (actualNow.reachable && !actualNow.indeterminate && actualNow.running) {
          log.info(`appReconciler - ${identifier} data volume unavailable but a stop is desired; stopping the container`);
          await dockerService.appDockerStop(identifier);
          fluxEventBus.publish('reconciler:actuated', { identifier, action: 'stopped', reason: 'controllerDesired' });
        }
      } catch (err) {
        log.error(`appReconciler - ${identifier} stop under unavailable volume failed: ${err.message}`);
      }
    }
    log.error(`appReconciler - ${identifier} data volume not mounted (${volumeMount.reason}); deferring all actuation`);
    fluxEventBus.publish('reconciler:actuated', { identifier, action: 'volumeUnavailable', reason: volumeMount.reason });
    if (volumeMount.reason === 'volume_file_missing' && !volumeMissingNoted.has(identifier)) {
      volumeMissingNoted.add(identifier);
      await appTamperingDetectionService.recordEvent(mainAppName, 'volume_missing', `Backing volume image for ${identifier} not found on disk`);
    }
    scheduleRetry(identifier, VOLUME_MOUNT_RETRY_MS);
    return;
  }
  volumeMissingNoted.delete(identifier);
  if (!volumeMount.alreadyMounted) {
    log.info(`appReconciler - mounted data volume for ${identifier}`);
    fluxEventBus.publish('reconciler:actuated', { identifier, action: 'volumeMounted' });
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

  // inspect failed but docker's own list shows the container exists: transient
  // inspect failure - defer, the next inspect succeeds (its run-state is
  // unknown right now, so neither start nor stop can be justified)
  if (actual.indeterminate) {
    log.warn(`appReconciler - ${identifier} inspect failed but the container exists, deferring reconcile`);
    scheduleRetry(identifier, MANAGED_RETRY_MS);
    return;
  }

  // Pending data wipe: the sync layer flagged this component's local appdata as
  // stale/to-be-reset and to be cleared before it runs again. This is the highest-
  // priority data action and is resolved here, inside the per-key single-flight and
  // BEFORE the run decision below, so a start can never race the wipe (the S1 data-
  // loss window). Stop first - an rm -rf under a live container corrupts it - then
  // wipe, then drop the flag. The wipe path is keyed by the on-disk (flux-prefixed)
  // folder name, while the stop takes the bare id (dockerService re-prefixes).
  // Skipped for a condemned component: the teardown is about to rm -rf its whole
  // volume, so wiping the appdata first is pointless AND races the teardown's
  // unmount (byte-level corruption). The condemned gate below stops it; the worker
  // removes it and its volume.
  if (dataDesired.get(identifier) === 'clear' && !(await appsRuntimeState.isCondemned(identifier))) {
    try {
      if (actual.running) {
        log.info(`appReconciler - ${identifier} stopping before local appdata clear`);
        await dockerService.appDockerStop(identifier);
        appInspector.stopAppMonitoring(identifier, false, globalState.appsMonitored);
        fluxEventBus.publish('reconciler:actuated', { identifier, action: 'stopped', reason: 'dataClear' });
      }
      await serviceHelper.delay(DATA_CLEAR_SETTLE_MS);
      await dockerOperations.appDeleteDataInMountPoint(dockerService.getAppIdentifier(identifier));
    } catch (err) {
      // A failed stop/wipe is the only actuation path here that would otherwise drop
      // to the hourly sweep (~1h down). Leave dataDesired 'clear' - so the retried
      // reconcile re-runs the idempotent wipe AND a start can never proceed onto
      // un-wiped data (this block still wins the next pass) - and arm our own paced
      // retry, mirroring the failed-start path below.
      log.error(`appReconciler - failed to clear local appdata for ${identifier}: ${err.message}; retrying`);
      fluxEventBus.publish('reconciler:actuated', { identifier, action: 'dataClearFailed', reason: err.message });
      scheduleRetry(identifier, MANAGED_RETRY_MS);
      return;
    }
    dataDesired.delete(identifier);
    log.info(`appReconciler - ${identifier} local appdata cleared`);
    fluxEventBus.publish('reconciler:actuated', { identifier, action: 'dataCleared' });
    // the sync layer flips controllerDesired to 'running' once a synced source is
    // confirmed; re-enqueue so we converge promptly if it already has.
    scheduleRetry(identifier, MANAGED_RETRY_MS);
    return;
  }

  const selfExitCode = await effectiveExitCode(identifier, actual);
  const { desired, reason } = await effectiveDesiredRunning(identifier, spec, selfExitCode);

  // null = a hold: no controller opinion yet for a replicated component, or a dependsOn
  // target that hasn't reached its condition. Neither start nor stop - leave the
  // container as-is until the decider speaks / the dependency comes up (event-driven),
  // but surface the hold once it has outlived any plausible cycle.
  if (desired === null) {
    if (reason === 'awaitingController' || reason === 'awaitingDependency') trackSilentHold(identifier, reason);
    return;
  }
  silentHoldSince.delete(identifier);

  if (!desired) {
    if (actual.running) {
      // A hard-kill skips the graceful shutdown window: an operator stop carrying the
      // durable operatorStopForce, or a condemned-with-force (operator hard-cancel,
      // durable condemnedForce). Every other stop (controllerDesired, policy, a
      // graceful condemn) is a graceful appDockerStop.
      const rs = (reason === 'operatorStopped' || reason === 'condemned') ? await appsRuntimeState.getState(identifier) : null;
      const forceKill = !!(rs && (reason === 'condemned' ? rs.condemnedForce : rs.operatorStopForce));
      log.info(`appReconciler - ${identifier} desired stopped, ${forceKill ? 'killing' : 'stopping'}`);
      if (forceKill) {
        await dockerService.appDockerKill(identifier);
      } else if (requestGracefulStop && await requestGracefulStop(identifier, reason)) {
        // flux-shutdownd owns a graceful drain of this app (Arcane). No docker action
        // here — the 'stopping' LB gate holds subsequent passes until the drain ends.
      } else {
        await dockerService.appDockerStop(identifier);
      }
      // monitoring follows run-state — the reconciler owns both ends (it starts
      // monitoring on the start branch), so a stopped container is never left with
      // a polling interval erroring against it.
      appInspector.stopAppMonitoring(identifier, false, globalState.appsMonitored);
      fluxEventBus.publish('reconciler:actuated', { identifier, action: 'stopped', reason, forced: forceKill });
    }
    return;
  }

  if (actual.running) {
    // Steady state is where membership drift surfaces (a recreated linked app,
    // an update that dropped a link, an external disconnect) - converge before
    // the run-state decisions below.
    await reconcileNetworkMembership(identifier, spec, actual);
    // A durable restart request (operator restart / mount or network repair) bounces
    // a running container when the desired generation exceeds the one we last
    // actuated, then records it. Level-based + idempotent (re-running won't re-bounce);
    // durable, so an operator's restart survives a crash. Not backoff-paced — a
    // deliberate bounce, not crash recovery.
    const restartReq = await appsRuntimeState.getState(identifier);
    const desiredGen = (restartReq && restartReq.restartGeneration) || 0;
    const actuatedGen = (restartReq && restartReq.actuatedRestartGeneration) || 0;
    if (desiredGen > actuatedGen) {
      log.info(`appReconciler - ${identifier} restart requested (gen ${desiredGen}); restarting`);
      try {
        await dockerService.appDockerRestart(identifier);
      } catch (err) {
        log.error(`appReconciler - failed to restart ${identifier} (requested): ${err.message}; retrying`);
        fluxEventBus.publish('reconciler:actuated', { identifier, action: 'restartRequestedFailed', reason: err.message });
        scheduleRetry(identifier, MANAGED_RETRY_MS);
        return;
      }
      await appsRuntimeState.recordRestartGeneration(identifier, desiredGen);
      fluxEventBus.publish('reconciler:actuated', { identifier, action: 'restartRequested', generation: desiredGen });
      notifyContainerStarted(identifier);
      return;
    }
    // A running container whose v9 livenessProbe HEALTHCHECK has failed its retries
    // (docker reports unhealthy) is restarted, paced by the SAME backoff ladder as crash
    // restarts so a permanently-unhealthy container is not restart-looped. The ladder
    // resets on a sustained healthy run (restartWaitMs runningNow). health is null when the
    // component declares no probe, so probe-less apps never enter here.
    if (actual.health === 'unhealthy') {
      const wait = await appsRuntimeState.restartWaitMs(identifier, { runningNow: true });
      if (wait > 0) {
        log.warn(`appReconciler - ${identifier} running but unhealthy, backing off ${Math.round(wait / 1000)}s before restart`);
        fluxEventBus.publish('reconciler:actuated', { identifier, action: 'unhealthyBackoff', waitMs: wait });
        scheduleRetry(identifier, wait);
        return;
      }
      await appsRuntimeState.recordRestart(identifier);
      try {
        await dockerService.appDockerRestart(identifier);
      } catch (err) {
        // appDockerRestart owns the stop+start; a thrown restart leaves the container in
        // whatever state docker left it. Pace the retry off the ladder (attempt recorded
        // above) rather than hammering, mirroring the failed-start path below.
        log.error(`appReconciler - failed to restart unhealthy ${identifier}: ${err.message}; retrying`);
        fluxEventBus.publish('reconciler:actuated', { identifier, action: 'restartUnhealthyFailed', reason: err.message });
        scheduleRetry(identifier, MANAGED_RETRY_MS);
        return;
      }
      log.warn(`appReconciler - ${identifier} restarted (was unhealthy)`);
      fluxEventBus.publish('reconciler:actuated', { identifier, action: 'restartUnhealthy' });
      return;
    }
    return; // healthy / starting / probe-less — already where we want it
  }

  if (!actual.exists) {
    await recreateMissing(identifier);
    return;
  }

  // exists but stopped, should run -> backoff-paced restart (no sleeping; the
  // worker re-enqueues when the backoff window elapses)
  const wait = await appsRuntimeState.restartWaitMs(identifier, { lastFinishedAtMs: actual.finishedAt });
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

  // Wire the container's network memberships before it runs: every creation
  // path hands the container to this start in docker 'created' state, so this
  // is the attach-before-first-start guarantee for shareWith links (and heals
  // a stopped container's drift before a restart).
  await reconcileNetworkMembership(identifier, spec, actual);

  // The controller verdict was sampled at reconcile entry, but the syncthing
  // decider's stop wrapper runs OUTSIDE this single-flight and may have flipped
  // it (stop + data wipe) during the awaits above. Re-read at actuation time:
  // starting onto a folder mid-wipe corrupts the fresh sync. The decider's own
  // enqueue drives the follow-up reconcile, so aborting here needs no retry.
  if ((spec.comp.hasActiveStandbySyncthing() || spec.comp.requiresSyncBeforeStart()) && controllerDesired.get(identifier) !== 'running') {
    log.info(`appReconciler - ${identifier} controller verdict changed during reconcile, aborting start`);
    return;
  }

  // condemned can also land during the awaits above (a cancel/expiry between this
  // reconcile's entry-time condemned read and now). Re-read at actuation so a start never
  // races a teardown's condemn — a container started here that the teardown then can't
  // gracefully remove. The teardown drives its own removal, so aborting needs no retry.
  if (await appsRuntimeState.isCondemned(identifier)) {
    log.info(`appReconciler - ${identifier} condemned during reconcile, aborting start`);
    return;
  }

  // firstStart vs restart keys on the durable hasSuccessfullyStarted marker (read
  // before recordRestart bumps the history): a container that has run here before
  // is a restart even after a crash; one that never has is a first start.
  const priorRuntimeState = await appsRuntimeState.getState(identifier);
  const firstStart = !(priorRuntimeState && priorRuntimeState.hasSuccessfullyStarted);
  await appsRuntimeState.recordRestart(identifier);
  try {
    await dockerService.appDockerStart(identifier);
  } catch (err) {
    // No die event fires for a failed start (the container never ran), so a
    // dropped throw here leaves the component down until the hourly sweep.
    // Schedule our own retry; pacing is free - the attempt was recorded above,
    // so a persistent failure walks the backoff ladder instead of hammering.
    log.error(`appReconciler - failed to start ${identifier}: ${err.message}; retrying`);
    fluxEventBus.publish('reconciler:actuated', { identifier, action: 'startFailed', reason: err.message });
    await failConvergeIfExhausted(identifier);
    scheduleRetry(identifier, MANAGED_RETRY_MS);
    return;
  }
  appInspector.startAppMonitoring(identifier, globalState.appsMonitored);
  if (firstStart) await appsRuntimeState.setSuccessfullyStarted(identifier);
  // A start satisfies any pending restart request (a "restart" of a stopped
  // container IS a start), so the running reconcile that follows won't re-bounce it.
  const pendingGen = (priorRuntimeState && priorRuntimeState.restartGeneration) || 0;
  const actuatedGen = (priorRuntimeState && priorRuntimeState.actuatedRestartGeneration) || 0;
  if (pendingGen > actuatedGen) await appsRuntimeState.recordRestartGeneration(identifier, pendingGen);
  log.info(`appReconciler - ${identifier} ${firstStart ? 'started (first start)' : 'restarted'}`);
  fluxEventBus.publish('reconciler:actuated', { identifier, action: firstStart ? 'firstStart' : 'restart', exitCode: actual.exitCode });
  notifyContainerStarted(identifier);
}

// --- install converge-wait (direct observer; resolved by the reconcile loop) ---

// Registered with reconcilerQueue: called after each reconcile pass that armed no
// retry and is not re-running (the final pass for that id). A converging component
// that reached a settled verdict (running | legitimately held | stopped-by-policy)
// resolves here. The queue owns the pass loop; the verdict reads engine state.
function onSettled(identifier, { retryArmed }) {
  if (convergeWaiters.has(identifier) && !retryArmed) {
    resolveConverge(identifier, 'settled');
  }
}

function resolveConverge(identifier, verdict) {
  const resolve = convergeWaiters.get(identifier);
  if (!resolve) return;
  convergeWaiters.delete(identifier);
  const timer = convergeBackstops.get(identifier);
  if (timer) {
    clearTimeout(timer);
    convergeBackstops.delete(identifier);
  }
  resolve(verdict);
}

// A converging component that has exhausted the install-window start attempts and
// never started successfully is a failed install — resolve its waiter 'failed' so
// installApplication rolls it back. A genuine node issue makes no start attempt, so
// restartHistory never grows and this never fires (the backstop handles that).
async function failConvergeIfExhausted(identifier) {
  if (!convergeWaiters.has(identifier)) return;
  const rs = await appsRuntimeState.getState(identifier);
  const attempts = rs && rs.restartHistory ? rs.restartHistory.length : 0;
  if (attempts >= CONVERGE_FAIL_ATTEMPTS && !(rs && rs.hasSuccessfullyStarted)) {
    resolveConverge(identifier, 'failed');
  }
}

/**
 * Await each just-installed component reaching a settled verdict. Registers a
 * per-component waiter, enqueues a reconcile, and blocks until each resolves:
 * 'settled' (running | legitimately held | stopped-by-policy), 'failed' (it
 * exhausted the install-window start attempts → caller rolls back), or
 * 'provisional' (the anti-hang backstop — a node issue, never rolls back).
 *
 * @param {string[]} rawIdentifiers component identifiers of the installed app
 * @param {object} [opts]
 * @param {number} [opts.backstopMs]
 * @returns {Promise<{converged: boolean, failed: string[]}>}
 */
async function awaitConvergence(rawIdentifiers, opts = {}) {
  const backstopMs = opts.backstopMs ?? CONVERGE_BACKSTOP_MS;
  const ids = rawIdentifiers.map(canonical);
  const verdicts = await Promise.all(ids.map((id) => new Promise((resolve) => {
    convergeWaiters.set(id, resolve);
    const timer = setTimeout(() => {
      convergeWaiters.delete(id);
      convergeBackstops.delete(id);
      resolve('provisional');
    }, backstopMs);
    if (timer.unref) timer.unref();
    convergeBackstops.set(id, timer);
    enqueue(id);
  })));
  const failed = ids.filter((id, i) => verdicts[i] === 'failed');
  return { converged: failed.length === 0, failed };
}

/**
 * Drive a set of components to a desired run-state THROUGH the reconciler and block
 * until they settle there — how an operation (backup/restore) that needs a container
 * actually stopped before its next step (then running again after) acts WITHOUT
 * touching Docker, so the reconciler stays the sole actuator. Sets the transient
 * operation hold, then reuses awaitConvergence (enqueue + await the settled verdict):
 * 'stopped' settles once the container is down, 'running' clears the hold and settles
 * once it is up — or legitimately held by a higher gate (e.g. the operator lock),
 * which is the correct end-state, so a backup never churns a start onto a deliberately
 * stopped app. The hold is transient: a crash drops it so an aborted operation's app
 * recovers rather than staying wrongly held down.
 *
 * @param {string[]} rawIds component identifiers
 * @param {'stopped'|'running'} state
 * @returns {Promise<{converged:boolean, failed:string[]}>}
 */
async function drive(rawIds, state) {
  const ids = rawIds.map(canonical);
  ids.forEach((id) => {
    if (state === 'stopped') operationDesired.set(id, 'stopped');
    else operationDesired.delete(id);
  });
  return awaitConvergence(ids);
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

/**
 * Re-evaluate the dependents of a component whose state just changed — called by the
 * event bridge when a container reaches a dependsOn milestone (start, health_status
 * healthy, or a clean exit). Each dependent re-checks its own condition in
 * effectiveDesiredRunning, so this only enqueues them; it never decides. dependsOn is a
 * same-app relationship, so the dependents live in the same deployment.
 */
async function enqueueDependents(rawIdentifier) {
  const identifier = canonical(rawIdentifier);
  let spec;
  try {
    spec = await getLocalComponentSpec(identifier);
  } catch (err) {
    // transient (DB / decryption): the dependency's next event, the reconnect sweep, or
    // the hourly tick re-evaluates dependents. Nothing to actuate here.
    log.warn(`appReconciler - enqueueDependents ${identifier} spec read failed: ${err.message}`);
    return;
  }
  if (!spec || !spec.deployment || !spec.comp) return;
  for (const depName of spec.deployment.dependentsOf(spec.comp.name)) {
    const dependent = spec.deployment.getComponent(depName);
    if (dependent) enqueue(dependent.identifier);
  }
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

/**
 * Declare that a g:/r: component must be stopped and its local appdata cleared
 * before it next runs - the sync layer's first-run / new-app reset. Sets both
 * desired inputs and enqueues ONE reconcile: the reconciler (the sole container
 * and data actuator) performs the stop-then-wipe inside its per-key single-flight,
 * so a start can never race the wipe. Replaces the sync layer's prior imperative
 * stop+rm-rf, which ran outside the single-flight (the S1 data-loss window).
 */
function requestStopAndClearData(rawIdentifier, reason) {
  const identifier = canonical(rawIdentifier);
  controllerDesired.set(identifier, 'stopped');
  dataDesired.set(identifier, 'clear');
  log.info(`appReconciler - requesting stop + local appdata clear for ${identifier} (${reason})`);
  fluxEventBus.publish('reconciler:desiredChanged', { identifier, state: 'stopped', reason });
  fluxEventBus.publish('reconciler:dataClearRequested', { identifier, reason });
  enqueue(identifier);
}

function clearControllerDesired(rawIdentifier) {
  const identifier = canonical(rawIdentifier);
  controllerDesired.delete(identifier);
  dataDesired.delete(identifier);
}

// --- lifecycle -----------------------------------------------------------

let started = false;

async function start() {
  if (started) return;
  started = true;
  await globalState.waitForBootContainerStateSettled();
  // Warm the flux-spec-backend cache so the sync identifier->name helpers
  // (componentIdentifier -> specLibs.getSpecBackendSync) resolve before any
  // reconcile runs — hasOperationLease cannot await an ESM import.
  await specLibs.getSpecBackend();
  // Provision + swapon the per-app swap pool before any app starts (no-op without
  // the new-mechanism host config). Best-effort: a failure must not wedge the boot
  // drain — per-container memory.swap.max still bounds usage and install/uninstall
  // reconciles retry.
  await appSwapPoolService.reconcile().catch((error) => {
    log.warn(`appReconciler - boot swap-pool reconcile failed: ${error.message}`);
  });
  // hand the boot-held queue to the scheduling seam to drain, now that daemon/DB are ready
  reconcilerQueue.beginBootDrain();
}

function stop() {
  started = false;
  reconcilerQueue.stopQueue();
  // resolve any in-flight install waiters so a stopped reconciler never hangs an
  // install; 'provisional' never rolls back (the app is provisioned, just unstarted).
  convergeBackstops.forEach((timer) => clearTimeout(timer));
  convergeWaiters.forEach((resolve) => resolve('provisional'));
  convergeWaiters.clear();
  convergeBackstops.clear();
}

// Wire the engine into the scheduling seam: the queue drives reconcile() and hands
// each final pass to onSettled() for converge resolution. One-way (queue never
// imports the engine), so producers can depend on the queue without this heavy tree.
reconcilerQueue.setReconcile(reconcile);
reconcilerQueue.setOnSettled(onSettled);

module.exports = {
  enqueue,
  enqueueAll,
  enqueueDependents,
  awaitConvergence,
  drive,
  setControllerDesired,
  clearControllerDesired,
  requestStopAndClearData,
  setOnContainerStarted,
  setRequestGracefulStop,
  waitForBootDrainSettled: reconcilerQueue.waitForBootDrainSettled,
  start,
  stop,
  // exposed for tests
  reconcile,
  policyAllowsRun,
  getRestartPolicy,
};
