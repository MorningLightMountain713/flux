const log = require('../../lib/log');
const dockerService = require('../dockerService');
const dockerEventStream = require('../utils/dockerEventStream');
const globalState = require('../utils/globalState');
const operationRegistry = require('../utils/operationRegistry');
const appsRuntimeState = require('../appManagement/appsRuntimeState');
const appReconciler = require('./appReconciler');

// Bridges the Docker container event stream into the reconcile workqueue. A thin
// translator only: it turns "container X did Y" into the right reconciler call and
// never decides anything itself (restart policy, backoff, dependsOn conditions all
// live in appReconciler). On stream reconnect it sweeps every component to catch
// containers orphaned while the stream was down (e.g. a dockerd restart underneath a
// running FluxOS). It listens for:
//   die           -> a flux container exited: enqueue it (the reconciler applies the
//                    restart policy + backoff). A clean exit (0) can also satisfy a
//                    dependsOn 'completed', so wake the dependents too.
//   destroy       -> a flux container was REMOVED. A deliberate teardown holds its
//                    stop-aligned lease for the duration (skip, like die); anything
//                    else is an out-of-band removal (a docker rm -f under us) —
//                    enqueue so the reconciler discovers the vanish now. Without
//                    this the die often races the rm window (container still listed,
//                    "exists but stopped") and the vanish is only found by a paced
//                    retry or the hourly sweep.
//   start         -> a container came up: can satisfy a dependsOn 'started' -> wake dependents.
//   health_status -> reconcile the container AND its dependents; the reconciler reads the
//                    authoritative .State.Health.Status from docker inspect and decides
//                    (restart if unhealthy; a dependsOn 'healthy' dependent starts once the
//                    target reads healthy). The event's status is NOT parsed.
//   disconnect    -> (network event) a container lost an endpoint on a fluxDockerNetwork_*
//                    network. A live external disconnect leaves the container running but
//                    unreachable, and no container-type event ever fires for it - without
//                    this the network-detach heal waits for the hourly sweep. Enqueue only;
//                    the reconciler re-reads the attachment and owns every heal decision
//                    (confirm, persistence window, storm guard), so a spurious or already-
//                    stale event is at most one no-op reconcile.

let subscription = null;

function isFluxContainer(name) {
  return name.startsWith('flux') || name.startsWith('zel');
}

// Wake the dependents of a container that just reached a dependsOn milestone.
// Fire-and-forget with a guard: enqueueDependents already logs spec-read failures,
// this only catches anything unexpected so a bad event can never crash the handler.
function wakeDependents(containerName) {
  appReconciler.enqueueDependents(containerName).catch((err) => {
    log.error(`containerEventBridge - enqueueDependents ${containerName} failed: ${err.message}`);
  });
}

async function handleContainerDie(event) {
  const containerName = event.Actor?.Attributes?.name;
  if (!containerName || !isFluxContainer(containerName)) return;

  // A deliberate teardown of the container (a stop/kill/restart, or a teardown's
  // remove) holds a stop-aligned component lease for the duration of the operation;
  // its die needs no reconcile - the operation already recorded the desired state
  // before acting. Skip to avoid churn. A die while an 'actuating' (create/start)
  // lease is held is the opposite: a genuine crash-on-start that MUST be recorded and
  // re-reconciled, so it falls through. Best-effort only: the lease is released by the
  // operation itself when it settles (never by this event), so a die that arrives
  // after the operation resolved simply falls through to a desired-state no-op.
  const lease = operationRegistry.get(containerName);
  if (lease && operationRegistry.isStopAligned(lease.type)) {
    return;
  }

  const parsed = parseInt(event.Actor?.Attributes?.exitCode, 10);
  const exitCode = Number.isNaN(parsed) ? null : parsed;

  // Pass the raw docker name; recordExit and enqueue both canonicalise to the bare
  // component id (single strip, one place), exactly like every other enqueue caller.
  // best-effort diagnostics; the reconciler reads the authoritative exit code
  // from Docker, so a failure here (e.g. DB not ready during boot) is harmless
  await appsRuntimeState.recordExit(containerName, exitCode);
  appReconciler.enqueue(containerName);
  // a clean exit can satisfy a dependsOn 'completed' (run-once init/migration) -
  // wake the dependents so they re-evaluate their gate.
  if (exitCode === 0) wakeDependents(containerName);
}

function handleContainerDestroy(event) {
  const containerName = event.Actor?.Attributes?.name;
  if (!containerName || !isFluxContainer(containerName)) return;
  // same skip as die: a deliberate teardown (uninstall/redeploy remove) holds a
  // stop-aligned lease while it destroys — its removal needs no reconcile.
  const lease = operationRegistry.get(containerName);
  if (lease && operationRegistry.isStopAligned(lease.type)) {
    return;
  }
  appReconciler.enqueue(containerName);
}

function handleContainerStart(event) {
  const containerName = event.Actor?.Attributes?.name;
  if (!containerName || !isFluxContainer(containerName)) return;
  wakeDependents(containerName);
}

function handleContainerHealth(event) {
  const containerName = event.Actor?.Attributes?.name;
  if (!containerName || !isFluxContainer(containerName)) return;
  // Don't parse the status out of the event — docker only carries it as a free-form
  // Action suffix ("health_status: unhealthy"), with no structured field. Re-reconcile
  // the container (the reconciler reads the authoritative .State.Health.Status from
  // inspect and restarts it if unhealthy; a deliberate stop in flight is handled by its
  // hasOperationLease guard) and its dependents (a dependsOn 'healthy' dependent starts
  // once the target reads healthy). Health events are transition-only, so this is at most
  // one no-op reconcile per transition.
  appReconciler.enqueue(containerName);
  wakeDependents(containerName);
}

async function handleNetworkDisconnect(event) {
  const networkName = event.Actor?.Attributes?.name;
  if (!networkName || !networkName.startsWith('fluxDockerNetwork_')) return;
  const containerId = event.Actor?.Attributes?.container;
  if (!containerId) return;
  // The event carries the container ID, not its name - resolve it ourselves (no
  // getDockerContainerOnly: its not-found error log would fire on every legitimate
  // teardown, whose disconnect trails the container's removal).
  const containers = await dockerService.dockerListContainers(true);
  const match = containers.find((c) => c.Id === containerId);
  if (!match) return; // container already gone - absence belongs to the destroy handler
  const containerName = (match.Names?.[0] || '').replace(/^\//, '');
  if (!containerName || !isFluxContainer(containerName)) return;
  // same skip as die/destroy: a deliberate teardown disconnects its own endpoints
  // under a stop-aligned lease - that disconnect needs no reconcile.
  const lease = operationRegistry.get(containerName);
  if (lease && operationRegistry.isStopAligned(lease.type)) {
    return;
  }
  appReconciler.enqueue(containerName);
}

function handleContainerEvent(event) {
  const action = event.Action || event.status || '';
  if (event.Type === 'network') {
    if (action === 'disconnect') return handleNetworkDisconnect(event);
    return undefined;
  }
  if (action === 'die') return handleContainerDie(event);
  if (action === 'destroy') return handleContainerDestroy(event);
  if (action === 'start') return handleContainerStart(event);
  if (action.startsWith('health_status')) return handleContainerHealth(event);
  return undefined;
}

// Events during an outage are gone, so a re-established stream cannot assume it
// saw every death: reconcile every component from actual state to catch the
// containers orphaned while it was down.
function onReconnect() {
  if (!globalState.bootContainerStateSettled) return undefined;
  log.info('containerEventBridge - stream reconnected, reconciling all components');
  return appReconciler.enqueueAll('reconnect');
}

async function start() {
  if (!subscription) {
    subscription = dockerEventStream.createDockerEventStream({
      label: 'containerEventBridge',
      filters: { type: ['container', 'network'], event: ['die', 'destroy', 'start', 'health_status', 'disconnect'] },
      onEvent: handleContainerEvent,
      onReconnect,
    });
  }
  await subscription.start();
}

function stop() {
  if (subscription) subscription.stop();
}

module.exports = {
  start,
  stop,
  // exposed for tests
  handleContainerEvent,
  handleContainerDie,
  handleContainerDestroy,
  handleContainerStart,
  handleContainerHealth,
  handleNetworkDisconnect,
};
