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

function logRetainedLines() {
  return config.fluxapps.playgroundLogRetainedLines ?? 2000;
}

function sessionTtlMs() {
  return config.fluxapps.playgroundSessionTtlMs ?? 900_000;
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
 * Collects CPU samples across a whole session and reduces them to one number:
 * the fraction of samples that were at or above the busy threshold.
 *
 * A fraction of TIME AT FULL TILT, not an average. An average is dragged down by
 * a slow start or a quiet tail and would let something that pegged a core for
 * fourteen of fifteen minutes read as moderate; what the miner profile turns on
 * is precisely that it never stops.
 */
function cpuAccumulator(threshold) {
  let samples = 0;
  let busy = 0;

  return {
    record(fraction) {
      samples += 1;
      if (fraction >= threshold) busy += 1;
    },
    // null, never 0, when nothing was sampled: "could not tell" must not be
    // mistaken for "was idle" by anything downstream.
    result() {
      return samples ? busy / samples : null;
    },
  };
}

/**
 * How hard a container is working, as a fraction of what its spec asked for.
 *
 * Measured against the container's OWN allocation, not the host. Docker reports
 * raw CPU time, so a container allowed two cores and using two cores and one
 * allowed half a core and using half a core both look "busy" in absolute terms
 * while meaning completely different things about whether the owner is using
 * what they paid for.
 *
 * @returns {Promise<number|null>} 0..1, or null when it could not be sampled -
 *   which reads as "cannot tell" and never as "idle"
 */
async function sampleCpuFraction(component) {
  try {
    const stats = await dockerService.dockerContainerStats(component.identifier);
    if (!stats || !stats.cpu_stats || !stats.precpu_stats) return null;

    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage
      - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta = stats.cpu_stats.system_cpu_usage
      - stats.precpu_stats.system_cpu_usage;
    if (!systemDelta || cpuDelta < 0) return null;

    const hostCores = stats.cpu_stats.online_cpus
      || (stats.cpu_stats.cpu_usage.percpu_usage || []).length;
    if (!hostCores) return null;

    // Fraction of the whole host, scaled by the cores this component declared.
    const hostFraction = (cpuDelta / systemDelta) * hostCores;
    const allocated = component.cpu || 0;
    if (!allocated) return null;

    return Math.min(hostFraction / allocated, 1);
  } catch (error) {
    log.warn(`playground: could not sample cpu for ${component.identifier}: ${error.message}`);
    return null;
  }
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
async function probeComponent(component, deadlineNs, shouldCancel = () => false, cpu = null) {
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

    // Sampled on the same tick as the inspect, so watching a container costs one
    // extra call rather than a loop of its own.
    if (cpu) {
      // eslint-disable-next-line no-await-in-loop
      const fraction = await sampleCpuFraction(component);
      if (fraction !== null) cpu.record(fraction);
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

// Docker prefixes each line with an RFC3339Nano timestamp when asked for them.
const LOG_LINE = /^(\S+)\s([\s\S]*)$/;

/**
 * An append-only view of one component's output.
 *
 * A terminal wants a STREAM: give me what I have not seen, in order, once. The
 * obvious implementation - re-read the last N lines every few seconds - is not
 * that. Consecutive reads overlap, so the client has to guess which lines are
 * new, and anything that arrived faster than N lines per interval is lost
 * before anyone sees it. A log you cannot trust to be complete is worse than no
 * log, because the missing lines are invisible.
 *
 * So each line gets a sequence number that only ever increases, and a poll
 * returns lines with their numbers. A client renders everything after the
 * highest it has, and knows immediately if it skipped any. This is the same
 * shape jobRegistry.progress already uses for its steps.
 */
function logBuffer(maxLines) {
  const lines = [];
  let seq = 0;
  let dropped = 0;
  // Docker's `since` is inclusive and second-granular, so consecutive reads
  // always overlap by up to a second. That overlap is the only place duplicates
  // can arrive from, so it is the only place that needs de-duplicating.
  let since = 0;
  // The newest timestamp held, and the lines carrying exactly it. Anything
  // older has certainly been seen; anything at the same instant is checked
  // against this small set; anything newer is new and resets it.
  //
  // Deliberately NOT a set of every line ever seen: that grows without bound,
  // and pruning it alongside the retained lines breaks it - an evicted line
  // would be re-admitted as new by the next overlapping read.
  let newestAt = null;
  let atNewest = new Set();

  return {
    /** @param {Buffer|null} raw docker's timestamped log output */
    append(raw) {
      if (!raw) return;

      const text = serviceHelper.dockerBufferToString(raw);
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;

        const match = LOG_LINE.exec(line);
        const at = match ? match[1] : null;
        const body = match ? match[2] : line;

        if (at && newestAt) {
          if (at < newestAt) continue;
          // Several lines can share one instant, so identity at the boundary is
          // the text, not the timestamp.
          if (at === newestAt && atNewest.has(body)) continue;
        }

        if (at && at !== newestAt) {
          newestAt = at;
          atNewest = new Set();
        }
        if (at) atNewest.add(body);

        seq += 1;
        lines.push({ seq, at, text: body });

        if (at) {
          const epochSeconds = Math.floor(Date.parse(at) / 1000);
          if (Number.isFinite(epochSeconds)) since = epochSeconds;
        }
      }

      // Bounded, and the client is TOLD how many went. A silently truncated log
      // reads as a complete one.
      while (lines.length > maxLines) {
        lines.shift();
        dropped += 1;
      }
    },
    since() { return since; },
    view() { return { lines: [...lines], dropped, total: seq }; },
  };
}

/**
 * Read whatever a component has written since the last read, into its buffer.
 *
 * Best effort: logs are the most useful part of a failed session, so a container
 * that has already gone must not turn a reportable failure into an unreportable
 * one.
 */
async function readLogsInto(component, buffer) {
  try {
    const raw = await dockerService.dockerContainerLogs(component.identifier, logLines(), {
      timestamps: true,
      ...(buffer.since() ? { since: buffer.since() } : {}),
    });
    buffer.append(raw);
  } catch (error) {
    log.warn(`playground: could not read logs for ${component.identifier}: ${error.message}`);
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

  // Held for the whole session, not rebuilt per read: they are what make the
  // log a stream rather than a series of overlapping snapshots.
  session.logBuffers = {};

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
    session.results[component.name] = { started: false, probe: null, logs: { lines: [], dropped: 0, total: 0 } };
    session.logBuffers[component.name] = logBuffer(logRetainedLines());
    // eslint-disable-next-line no-await-in-loop
    await startComponent(component, session, status);
    session.results[component.name].started = true;
  }

  // The probe budget starts when probing does. Folding the pulls into it would
  // mean a slow registry silently spending the time meant for watching the app,
  // and reporting a timeout that was never about the app at all. The session's
  // own deadline is what bounds the pulls.
  const deadlineNs = process.hrtime.bigint() + BigInt(probeTimeoutMs()) * 1_000_000n;

  // One accumulator for the whole session rather than per component: the
  // question is whether this SESSION sat at full tilt, and a miner with a
  // sidecar would otherwise dilute its own reading.
  const cpu = cpuAccumulator(config.fluxapps.playgroundMinerCpuBusyFraction ?? 0.9);

  // eslint-disable-next-line no-restricted-syntax
  for (const component of components) {
    throwIfCancelled(session, hooks);
    status(`Probing ${component.name}...`);
    // eslint-disable-next-line no-await-in-loop
    const probe = await probeComponent(component, deadlineNs, () => Boolean(hooks.isCancelled && hooks.isCancelled()), cpu);
    // eslint-disable-next-line no-await-in-loop
    await readLogsInto(component, session.logBuffers[component.name]);
    session.results[component.name] = {
      started: true, probe, logs: session.logBuffers[component.name].view(),
    };
    status(`${component.name}: ${probe.passed ? 'passed' : 'failed'} (${probe.basis})`);
  }

  // The probe has a verdict; the SESSION has not ended. This is the window the
  // owner actually watches in - logs accumulating, the app staying up or falling
  // over - and it is what the design's duty cycle is costed against: two
  // sessions of fifteen running minutes is the "~30 minutes and ~1 core-hour per
  // hour" a node donates. Returning at the verdict, as this used to, ended a
  // session in well under a minute and gave the owner nothing to watch.
  //
  // Timed from when the containers actually started, not from when the request
  // was accepted, so a slow registry eats into the pulls rather than into this.
  await observeSession(session, components, cpu, hooks, status);

  session.cpuBusyFraction = cpu.result();

  return session.results;
}

/**
 * Hold the session open for its running window, watching it.
 *
 * Ends on whichever comes first: the deadline, a cancel, or every container
 * having stopped on its own - there is nothing left to watch once they are all
 * gone, and holding the slot open would only delay the next caller.
 *
 * Refreshes the logs each tick so a poll returns what the app has said most
 * recently, and keeps sampling CPU, which is what makes the running window
 * measurable at all.
 */
async function observeSession(session, components, cpu, hooks, status) {
  const deadlineNs = process.hrtime.bigint() + BigInt(sessionTtlMs()) * 1_000_000n;
  session.runningSince = Date.now();
  status(`Running. Watching for up to ${Math.round(sessionTtlMs() / 60000)} minutes.`);

  while (process.hrtime.bigint() < deadlineNs) {
    throwIfCancelled(session, hooks);

    let anyRunning = false;
    // eslint-disable-next-line no-restricted-syntax
    for (const component of components) {
      // eslint-disable-next-line no-await-in-loop
      const info = await dockerService.dockerContainerInspect(component.identifier);
      if (info && info.State && info.State.Running) {
        anyRunning = true;
        // eslint-disable-next-line no-await-in-loop
        const fraction = await sampleCpuFraction(component);
        if (fraction !== null) cpu.record(fraction);
      }
      // eslint-disable-next-line no-await-in-loop
      await readLogsInto(component, session.logBuffers[component.name]);
      session.results[component.name].logs = session.logBuffers[component.name].view();
    }

    if (!anyRunning) {
      status('Every component has stopped; ending the session.');
      return;
    }

    // eslint-disable-next-line no-await-in-loop
    await serviceHelper.delay(5000);
  }

  session.reachedDeadline = true;
  status('Reached the session time limit.');
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
