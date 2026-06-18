const log = require('../../lib/log');
const dockerService = require('../dockerService');
const globalState = require('../utils/globalState');
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
//   start         -> a container came up: can satisfy a dependsOn 'started' -> wake dependents.
//   health_status -> reconcile the container AND its dependents; the reconciler reads the
//                    authoritative .State.Health.Status from docker inspect and decides
//                    (restart if unhealthy; a dependsOn 'healthy' dependent starts once the
//                    target reads healthy). The event's status is NOT parsed.

let eventStream = null;
let stopped = false;
let subscribing = false; // a subscribe is mid-await (its stream not yet assigned)
let resubscribeTimer = null; // exactly one pending resubscribe, however many signals fired
let lineBuf = '';
let hasConnected = false;

const RESUBSCRIBE_DELAY_MS = 10000;

// Every way a stream can die ('error', 'end', a raw 'close', or a failed
// subscribe) funnels here, and the timer guard collapses them: one outage
// produces exactly one new stream. Unguarded, error+end firing together
// doubled the stream - and every event was then handled twice.
function scheduleResubscribe(reason) {
  if (stopped || resubscribeTimer || eventStream) return;
  log.warn(`containerEventBridge - event stream ${reason}; resubscribing in ${RESUBSCRIBE_DELAY_MS / 1000}s`);
  resubscribeTimer = setTimeout(() => {
    resubscribeTimer = null;
    // eslint-disable-next-line no-use-before-define
    subscribe();
  }, RESUBSCRIBE_DELAY_MS);
}

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

  // A deliberate FluxOS stop (appDockerStop/Kill/Restart) marks the container in
  // stoppingContainers for the duration of the operation; its die needs no
  // reconcile - the operation already recorded the desired state before acting.
  // Skip to avoid churn. Best-effort only: the flag is cleared by the operation
  // itself when it settles (never by this event), so a die that arrives after
  // the operation resolved simply falls through to a desired-state no-op.
  if (globalState.stoppingContainers.has(containerName)) {
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

function handleContainerEvent(event) {
  const action = event.Action || event.status || '';
  if (action === 'die') return handleContainerDie(event);
  if (action === 'start') return handleContainerStart(event);
  if (action.startsWith('health_status')) return handleContainerHealth(event);
  return undefined;
}

async function subscribe() {
  if (eventStream || subscribing) return;
  subscribing = true;
  lineBuf = '';

  try {
    const stream = await dockerService.dockerGetEvents({
      filters: { type: ['container'], event: ['die', 'start', 'health_status'] },
    });
    eventStream = stream;

    // handlers are scoped to THIS stream: a late signal from an already
    // replaced stream must not retire its healthy successor
    const onGone = (reason) => {
      if (eventStream === stream) eventStream = null;
      scheduleResubscribe(reason);
    };

    stream.on('data', (buf) => {
      if (stopped || eventStream !== stream) return;
      lineBuf += buf.toString();
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          Promise.resolve(handleContainerEvent(event)).catch((err) => {
            log.error(`containerEventBridge - event handler error: ${err.message}`);
          });
        } catch (parseErr) {
          log.error(`containerEventBridge - failed to parse docker event: ${parseErr.message}`);
        }
      }
    });

    stream.on('error', (err) => {
      log.error(`containerEventBridge - event stream error: ${err.message}`);
      onGone('errored');
    });
    stream.on('end', () => onGone('ended'));
    // a raw socket teardown can emit 'close' without 'error' or 'end'
    stream.on('close', () => onGone('closed'));

    log.info('containerEventBridge - listening for container lifecycle events');

    // a re-established stream may have missed events while it was down;
    // reconcile every component from actual state to catch orphans
    if (hasConnected && globalState.bootContainerStateSettled) {
      log.info('containerEventBridge - stream reconnected, reconciling all components');
      appReconciler.enqueueAll('reconnect').catch((err) => {
        log.error(`containerEventBridge - reconnect reconcile failed: ${err.message}`);
      });
    }
    hasConnected = true;
  } catch (err) {
    log.error(`containerEventBridge - failed to subscribe to docker events: ${err.message}`);
    scheduleResubscribe('subscribe failed');
  } finally {
    subscribing = false;
  }
}

async function start() {
  stopped = false;
  hasConnected = false;
  await subscribe();
}

function stop() {
  stopped = true;
  if (resubscribeTimer) {
    clearTimeout(resubscribeTimer);
    resubscribeTimer = null;
  }
  if (eventStream) {
    eventStream.destroy();
    eventStream = null;
  }
}

module.exports = {
  start,
  stop,
  // exposed for tests
  handleContainerEvent,
  handleContainerDie,
  handleContainerStart,
  handleContainerHealth,
};
