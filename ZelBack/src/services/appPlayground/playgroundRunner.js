const util = require('util');
const config = require('config');
const log = require('../../lib/log');
const dockerService = require('../dockerService');
const serviceHelper = require('../serviceHelper');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const playgroundNetwork = require('./playgroundNetwork');
const componentProvisioner = require('../appLifecycle/componentProvisioner');
const { verifyRepository } = require('../appSecurity/imageManager');

// The container half of a playground session: pull, create, start, probe, tear
// down. Deliberately NOT componentProvisioner - a playground container is not an
// app. It has no volume, no host ports, no owner, no shutdown plan, no telemetry
// identity and no reconciler; routing it through the installer would mean adding
// a flag that makes the install path behave differently for a guest, which is
// the exact shape of the `test` flag that was just removed from it.
//
// This module is one of the named exceptions to the reconciler's run-state
// authority (tests/unit/reconcilerRunAuthority.guard.test.js). The reconciler
// arbitrates MANAGED-APP run state from desired state held in the registry; a
// playground session has no registry row and no desired state to converge on -
// it starts once, is watched, and is destroyed on a timer.

const dockerPullStreamPromise = util.promisify(dockerService.dockerPullStream);

// Marks every container and network a session owns. The reaper keys on it, and
// so does the app janitor's orphan sweep, which must leave these alone: it
// removes containers with no installed-app row, and a playground session is
// exactly that by design.
const PLAYGROUND_LABEL = 'flux.playground';

function probeTimeoutMs() {
  return config.fluxapps.playgroundProbeTimeoutMs ?? 180_000;
}

function probeStableMs() {
  return config.fluxapps.playgroundProbeStableMs ?? 30_000;
}

function logLines() {
  return config.fluxapps.playgroundLogLines ?? 50;
}

function imageMaxBytes() {
  return config.fluxapps.playgroundSessionImageMaxBytes ?? 2e9;
}

function imageTotalMaxBytes() {
  return config.fluxapps.playgroundSessionImageTotalMaxBytes ?? 6e9;
}

/**
 * Measure a component's image and refuse it if it is too big to be worth a
 * node's donated bandwidth. Measured BEFORE any pull: the whole point is not to
 * download two gigabytes to discover it was two gigabytes.
 *
 * Judged on the clearance figure - the upper bound when a gzip size record
 * wrapped ambiguously - because that is the only one it is safe to admit
 * against. An image that cannot be measured is admitted: an unmeasurable layer
 * is the registry's ambiguity, not evidence of size, and the disk budget behind
 * the pull is what actually bounds it.
 *
 * @returns {Promise<{ok: boolean, reason: string|null, bytes: number}>}
 */
async function checkImageSize(component) {
  const result = await verifyRepository(component.image, {
    repoauth: component.imageAuth || null,
    appName: component.appName,
  });

  const bytes = result.decompressedSizeClearanceBytes || 0;
  const max = imageMaxBytes();

  if (bytes && bytes > max) {
    return {
      ok: false,
      bytes,
      reason: `Component '${component.name}' decompresses to about ${(bytes / 1e9).toFixed(2)} GB; `
        + `a playground session runs images up to ${(max / 1e9).toFixed(2)} GB. `
        + 'Install it to run it at full size.',
    };
  }

  return { ok: true, reason: null, bytes };
}

/**
 * Bring one component up: pull, create with no host binding, start.
 *
 * @param {object} component DeploymentComponent
 * @param {object} session the owning session
 * @param {Function} status progress sink
 */
async function startComponent(component, session, status) {
  const id = component.identifier;

  status(`Pulling ${component.name}...`);
  const pullConfig = await componentProvisioner.verifyComponentImage(component);
  await dockerPullStreamPromise(pullConfig, null);
  status(`Pulled ${component.name}`);

  const measuredImageSizeBytes = await dockerService.appDockerImageSize(component.image);

  status(`Creating ${component.name}...`);
  await dockerService.appDockerCreate(component, {
    measuredImageSizeBytes,
    // No host binding, no firewall hole, no UPnP mapping: a session is reachable
    // from nowhere. The ports stay exposed inside the session's own network so
    // components can still talk to each other and the TCP probe can connect.
    publishPorts: false,
    // A guest's aggregate load is capped separately from the apps this node is
    // paid to run, so a playground can never crowd them out.
    cgroupSlice: 'flux-playground.slice',
    // Never restart: a session is a single observation with a deadline. A crash
    // is a RESULT the owner needs to see, not something to paper over.
    restartPolicy: 'no',
    labels: { [PLAYGROUND_LABEL]: session.sessionId },
    owner: session.fluxId,
  });

  status(`Starting ${component.name}...`);
  await dockerService.appDockerStart(id);
  status(`Started ${component.name}`);
}

/**
 * Stop at the next checkpoint if the caller has cancelled.
 *
 * A cancel raises a flag and the worker notices; it does not interrupt a docker
 * call already in flight. The checkpoints are placed where the next step would
 * be expensive - before starting each component, and around the probe waits -
 * so a cancel costs at most the step already running rather than the session.
 */
function throwIfCancelled(session, hooks) {
  if (!hooks.isCancelled || !hooks.isCancelled()) return;
  const cancelled = new Error('The session was cancelled.');
  cancelled.kind = 'cancelled';
  throw cancelled;
}

/**
 * Wait for a container to reach a verdict, and say which rung of the ladder
 * produced it.
 *
 * The ladder exists because "did it run" has no single answer across every image
 * an owner might bring. In order: the spec's own livenessProbe, then the image's
 * HEALTHCHECK (docker fills the same field from either, so both read alike),
 * then a TCP connect to a declared port, and finally just staying up. Each rung
 * is weaker than the one above, so the verdict carries the rung that produced it
 * - a "stayed up" pass is reported as the weak evidence it is rather than
 * dressed up as a health check.
 *
 * @returns {Promise<object>} the component's verdict
 */
async function probeComponent(component, deadlineNs, shouldCancel = () => false) {
  const id = component.identifier;
  const started = process.hrtime.bigint();
  const stableNs = BigInt(probeStableMs()) * 1_000_000n;

  let sawHealthField = false;

  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const info = await dockerService.dockerContainerInspect(id);
    if (!info) {
      return { passed: false, basis: 'container', detail: 'The container disappeared before it could be probed.' };
    }

    const running = Boolean(info.State && info.State.Running);
    const health = info.State?.Health?.Status ?? null;
    if (health) sawHealthField = true;

    if (!running) {
      const exitCode = info.State?.ExitCode ?? null;
      // Exit 0 is ambiguous and is reported as such rather than guessed at: a
      // job container that finished its work and a server that gave up on its
      // configuration both leave 0 behind.
      return {
        passed: false,
        basis: 'exit',
        exitCode,
        detail: exitCode === 0
          ? 'The container exited cleanly (status 0). If it is a long-running service, it stopped instead of serving.'
          : `The container exited with status ${exitCode}.`,
      };
    }

    if (health === 'healthy') {
      return { passed: true, basis: 'healthcheck', detail: 'The container reported healthy.' };
    }
    if (health === 'unhealthy') {
      return { passed: false, basis: 'healthcheck', detail: 'The container reported unhealthy.' };
    }

    // No health check on this image at all: fall to the weaker rungs. A
    // 'starting' status means there IS one and it has not settled, so keep
    // waiting for it rather than passing the container on weaker evidence.
    if (!sawHealthField) {
      // eslint-disable-next-line no-await-in-loop
      const reached = await probeTcp(component, info);
      if (reached) {
        return { passed: true, basis: 'tcp', detail: `Accepted a TCP connection on port ${reached}.` };
      }

      if (process.hrtime.bigint() - started >= stableNs) {
        const declared = probeablePorts(component).length > 0;
        return {
          passed: true,
          basis: 'uptime',
          weak: true,
          detail: declared
            ? `Stayed up for ${Math.round(probeStableMs() / 1000)}s, but never accepted a connection on a declared port. `
              + 'It is running; whether it is serving is unproven.'
            : `Stayed up for ${Math.round(probeStableMs() / 1000)}s. The spec declares no ports and no health check, `
              + 'so staying up is the whole of the evidence.',
        };
      }
    }

    if (shouldCancel()) {
      return { passed: false, basis: 'cancelled', detail: 'The session was cancelled before this component reached a verdict.' };
    }

    if (process.hrtime.bigint() >= deadlineNs) {
      return {
        passed: false,
        basis: 'timeout',
        detail: health
          ? `The health check had not passed after ${Math.round(probeTimeoutMs() / 1000)}s (last status: ${health}).`
          : `No verdict after ${Math.round(probeTimeoutMs() / 1000)}s.`,
      };
    }

    // eslint-disable-next-line no-await-in-loop
    await serviceHelper.delay(2000);
  }
}

/**
 * The container ports a component declares, in the container's own numbering.
 *
 * The CONTAINER port, not the host port: nothing is bound on the host for a
 * session, and the probe dials the container's address on the session network.
 * UDP is skipped rather than guessed at - there is no accept to observe, so a
 * connect proves nothing either way.
 */
function probeablePorts(component) {
  return (component.portBindings || [])
    .filter((pb) => (pb.protocol || 'tcp') === 'tcp')
    .map((pb) => Number(pb.containerPort))
    .filter(Number.isFinite);
}

/**
 * Try each declared container port until one accepts, from the node rather than
 * from inside the container: this is the same direction a real user's traffic
 * would arrive from, so a process bound only to 127.0.0.1 correctly fails here.
 *
 * @returns {Promise<number|null>} the port that accepted, or null
 */
async function probeTcp(component, info) {
  const networks = info.NetworkSettings?.Networks ?? {};
  const address = Object.values(networks).map((n) => n.IPAddress).find(Boolean);
  if (!address) return null;

  // eslint-disable-next-line no-restricted-syntax
  for (const port of probeablePorts(component)) {
    // eslint-disable-next-line no-await-in-loop
    const open = await fluxNetworkHelper.isPortOpen(address, port, { timeout: 2000 });
    if (open) return port;
  }
  return null;
}

/**
 * The last lines a component wrote. Best effort: logs are the most useful part
 * of a failed session, so a container that has already gone must not turn a
 * reportable failure into an unreportable one.
 */
async function tailLogs(component) {
  try {
    const buffer = await dockerService.dockerContainerLogs(component.identifier, logLines());
    if (!buffer) return [];
    return serviceHelper.dockerBufferToString(buffer).split('\n').slice(-logLines());
  } catch (error) {
    log.warn(`playground: could not read logs for ${component.identifier}: ${error.message}`);
    return [];
  }
}

/**
 * Run a whole session: size-gate every image, build the network, bring each
 * component up in the spec's declared startup order, then probe.
 *
 * Sequential on purpose. The components of one app frequently depend on each
 * other, the spec already says in what order, and a session is one app on one
 * node - there is nothing here for concurrency to win that would not be paid for
 * in a database that starts before the thing it needs.
 */
async function runSession(session, hooks = {}) {
  const status = hooks.onStatus || (() => {});
  const { deployment } = session;

  const components = deployment.startupOrder.map((name) => deployment.getComponent(name));

  // Every image is measured before ANY of them is pulled, so a session that is
  // going to be refused for size costs the node no bandwidth at all.
  //
  // Two bounds, and they answer different questions. The per-image one refuses a
  // single image too big to be worth a donated node's bandwidth; the aggregate
  // refuses a spec whose images are individually reasonable but together are
  // not. The aggregate is what replaced the old component-count ceiling - it
  // bounds the thing counting components was really standing in for, without
  // refusing an ordinary four-component app.
  let totalBytes = 0;
  // eslint-disable-next-line no-restricted-syntax
  for (const component of components) {
    // eslint-disable-next-line no-await-in-loop
    const verdict = await checkImageSize(component);
    if (!verdict.ok) {
      const refusal = new Error(verdict.reason);
      refusal.kind = 'rejected';
      throw refusal;
    }
    totalBytes += verdict.bytes;
  }

  if (totalBytes > imageTotalMaxBytes()) {
    const refusal = new Error(
      `The spec's images come to about ${(totalBytes / 1e9).toFixed(2)} GB in total; `
      + `a playground session pulls up to ${(imageTotalMaxBytes() / 1e9).toFixed(2)} GB. `
      + 'Install it to run it at full size.',
    );
    refusal.kind = 'rejected';
    throw refusal;
  }

  // The session's own network, on a reserved slot, with the default-deny egress
  // policy in force before any guest container is attached to it. Not
  // ensureAppDockerNetwork: an app network gets a whole /24 out of a pool of 255
  // that also serves maxAppsPerNode apps, and carries no egress policy.
  status('Creating the session network...');
  const network = await playgroundNetwork.createSessionNetwork(session.appName);
  session.bridge = network.bridge;
  session.subnet = network.subnet;
  status(`Session network ready on ${network.subnet}, capped and default-deny outbound`);

  // eslint-disable-next-line no-restricted-syntax
  for (const component of components) {
    throwIfCancelled(session, hooks);
    // Claimed BEFORE the attempt, not after it succeeds. Teardown works from
    // this map, so a component that fails half way through its own start - image
    // pulled, container created, start refused - has to already be in it or its
    // container survives the session that created it.
    session.results[component.name] = { started: false, probe: null, logs: [] };
    // eslint-disable-next-line no-await-in-loop
    await startComponent(component, session, status);
    session.results[component.name].started = true;
  }

  // The probe budget starts when probing does. Folding the pulls into it would
  // mean a slow registry silently spending the time meant for watching the app,
  // and reporting a timeout that was never about the app at all. The session's
  // own deadline is what bounds the pulls.
  const deadlineNs = process.hrtime.bigint() + BigInt(probeTimeoutMs()) * 1_000_000n;

  // eslint-disable-next-line no-restricted-syntax
  for (const component of components) {
    throwIfCancelled(session, hooks);
    status(`Probing ${component.name}...`);
    // eslint-disable-next-line no-await-in-loop
    const probe = await probeComponent(component, deadlineNs, () => Boolean(hooks.isCancelled && hooks.isCancelled()));
    // eslint-disable-next-line no-await-in-loop
    const logs = await tailLogs(component);
    session.results[component.name] = { started: true, probe, logs };
    status(`${component.name}: ${probe.passed ? 'passed' : 'failed'} (${probe.basis})`);
  }

  return session.results;
}

/**
 * Destroy everything a session owns.
 *
 * Never throws. Teardown runs from the TTL timer, from the cancel path and from
 * the failure path, and a session whose cleanup failed still has to be marked
 * finished - a throw here would leave the node believing a session it can no
 * longer see is still occupying its one slot.
 */
async function teardownSession(session) {
  const removed = [];

  const names = Object.keys(session.results || {});
  const components = session.deployment
    ? names.map((name) => session.deployment.getComponent(name)).filter(Boolean)
    : [];

  // eslint-disable-next-line no-restricted-syntax
  for (const component of components) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await dockerService.appDockerForceRemove(component.identifier);
      removed.push(component.identifier);
    } catch (error) {
      log.warn(`playground: could not remove ${component.identifier}: ${error.message}`);
    }
  }

  try {
    await dockerService.forceRemoveFluxAppDockerNetwork(session.appName);
  } catch (error) {
    log.warn(`playground: could not remove network for ${session.appName}: ${error.message}`);
  }

  return removed;
}

/**
 * Remove playground containers no live session claims.
 *
 * This is what makes a restart safe. Sessions live only in memory, so after a
 * restart there are no live ids and every labelled container is by definition
 * abandoned - the sweep collects the lot. During normal running it collects
 * whatever a failed teardown left behind.
 *
 * @param {Set<string>} liveSessionIds ids the service still owns
 */
async function reapOrphans(liveSessionIds) {
  let containers;
  try {
    containers = await dockerService.dockerListContainers(true);
  } catch (error) {
    log.warn(`playground: orphan sweep could not list containers: ${error.message}`);
    return { skipped: 'docker list failed' };
  }

  const orphans = containers.filter((container) => {
    const sessionId = container.Labels && container.Labels[PLAYGROUND_LABEL];
    return sessionId && !liveSessionIds.has(sessionId);
  });

  const removed = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const container of orphans) {
    const name = (container.Names && container.Names[0]) ? container.Names[0].slice(1) : container.Id;
    try {
      // eslint-disable-next-line no-await-in-loop
      await dockerService.appDockerForceRemove(name);
      removed.push(name);
      log.info(`playground: reaped orphaned session container ${name}`);
    } catch (error) {
      log.warn(`playground: could not reap ${name}: ${error.message}`);
    }
  }

  return { removed: removed.length, containers: removed };
}

module.exports = {
  PLAYGROUND_LABEL,
  checkImageSize,
  probeComponent,
  runSession,
  teardownSession,
  reapOrphans,
};
