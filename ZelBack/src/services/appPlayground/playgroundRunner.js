'use strict';

const util = require('util');
const config = require('config');
const log = require('../../lib/log');
const { AsyncLock } = require('../utils/asyncLock');
const dockerService = require('../dockerService');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const playgroundNetwork = require('./playgroundNetwork');
const playgroundWatcher = require('./playgroundWatcher');
const componentProvisioner = require('../appLifecycle/componentProvisioner');
const { verifyRepository } = require('../appSecurity/imageManager');
const { getSpecBackend } = require('../utils/specLibs');

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

// One session pulls at a time, node-wide.
//
// This is what "staggered starts" means, and it is a queue on the contended
// resource rather than a delay before starting: concurrent sessions are the
// point, and only their PULLS actually contend. Bandwidth is what the aggregate
// image budget bounds, and it is shared with the paid apps this node is
// installing - two sessions each pulling their allowance at once doubles the
// peak for work nobody is paying for. A delay would be a number invented to
// stand in for "is anyone else pulling", which is a thing we can simply know.
//
// Held per IMAGE, not per session, so the hold is bounded by the per-image
// ceiling rather than by the whole aggregate, and a second session's first
// image starts as soon as the first session's current one lands.
//
// No hold watchdog: the pull is already bounded by dockerPullStream's own
// stall abort (no progress for 90s), so a limit here would be a second,
// invented deadline for the same thing - and it would fire mid-pull on a slow
// link, handing the slot to a second puller while the first is still going,
// which is the exact situation this exists to prevent. The release is in a
// finally, so the only way to hold it forever is a pull that never settles.
const pullLock = new AsyncLock(1, { maxHoldMs: 0 });

function probeTimeoutMs() {
  return config.fluxapps.playgroundProbeTimeoutMs ?? 180_000;
}

function probeStableMs() {
  return config.fluxapps.playgroundProbeStableMs ?? 30_000;
}

// How often to knock on a declared port while waiting for a component with no
// health check to start serving. Nothing reports "the app has bound its port",
// so this rung has to ask.
function tcpRetryMs() {
  return config.fluxapps.playgroundTcpRetryMs ?? 2_000;
}

// How often to sample CPU. The only genuine timer left in a session: docker
// reports state transitions but nothing reports how busy a container is, and
// mining detection wants an average across the window rather than fine detail.
function cpuSampleMs() {
  return config.fluxapps.playgroundCpuSampleMs ?? 15_000;
}

function logLines() {
  return config.fluxapps.playgroundLogLines ?? 50;
}

function logRetainedLines() {
  return config.fluxapps.playgroundLogRetainedLines ?? 2000;
}

// Bounds the teardown's final log read. Not load-bearing for the case the read
// exists for - a dead container's log endpoint delivers and closes in
// milliseconds - it only closes the tap on a still-running container, whose
// bytes arrive immediately but whose stream would otherwise stay open.
function finalLogReadMs() {
  return config.fluxapps.playgroundFinalLogReadMs ?? 2000;
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
  const { LABEL_KEYS: labelKeys } = await getSpecBackend();

  const pullConfig = await componentProvisioner.verifyComponentImage(component);
  // Says so when it is actually waiting, rather than reporting a pull that has
  // not begun: a session whose progress reads "Pulling..." for two minutes
  // because another session holds the slot looks stuck to its owner.
  if (pullLock.locked) status(`Waiting to pull ${component.name} (another session is pulling)...`);
  const releasePull = await pullLock.acquire({ label: `playground pull ${id}` });
  try {
    status(`Pulling ${component.name}...`);
    await dockerPullStreamPromise(pullConfig, null);
    status(`Pulled ${component.name}`);
  } finally {
    releasePull();
  }

  const measuredImageSizeBytes = await dockerService.appDockerImageSize(component.image);

  status(`Creating ${component.name}...`);
  await dockerService.appDockerCreate(component, {
    measuredImageSizeBytes,
    // The session's own network, stated rather than derived from the spec's
    // app name - which would attach a guest to a same-named paid app's network.
    networkName: session.networkName,
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
    labels: { [labelKeys.PLAYGROUND_SESSION]: session.sessionId },
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
async function probeComponent(component, watcher, deadlineNs, shouldCancel = () => false) {
  const id = component.identifier;
  const started = process.hrtime.bigint();
  const stableNs = BigInt(probeStableMs()) * 1_000_000n;

  for (;;) {
    const state = watcher.state(id);

    if (state.gone) {
      return { passed: false, basis: 'container', detail: 'The container disappeared before it could be probed.' };
    }

    if (state.known && !state.running) {
      const { exitCode } = state;
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

    if (state.health === 'healthy') {
      return { passed: true, basis: 'healthcheck', detail: 'The container reported healthy.' };
    }
    if (state.health === 'unhealthy') {
      return { passed: false, basis: 'healthcheck', detail: 'The container reported unhealthy.' };
    }

    // No health check on this image at all: fall to the weaker rungs. A
    // 'starting' status means there IS one and it has not settled, so keep
    // waiting for it rather than passing the container on weaker evidence.
    if (!state.hasHealthCheck) {
      // eslint-disable-next-line no-await-in-loop
      const reached = await probeTcp(component, state.address);
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
        detail: state.health
          ? `The health check had not passed after ${Math.round(probeTimeoutMs() / 1000)}s (last status: ${state.health}).`
          : `No verdict after ${Math.round(probeTimeoutMs() / 1000)}s.`,
      };
    }

    // Wait for the container to DO something rather than asking whether it has.
    // A health-checked image wakes the instant docker reports a transition; an
    // image without one has nothing to report a bound port, so its TCP knock is
    // retried on a cadence - the one question here no event can answer.
    const remainingNs = deadlineNs - process.hrtime.bigint();
    const remainingMs = Math.max(1, Number(remainingNs / 1_000_000n));
    // eslint-disable-next-line no-await-in-loop
    await watcher.changedOr(Math.min(tcpRetryMs(), remainingMs));
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
async function probeTcp(component, address) {
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
/**
 * One counter for the whole session rather than one per component, so a client
 * tracks a single number: "everything above N" is unambiguous across every
 * component, where per-component counters would make component A's line 40 and
 * component B's line 40 unrelated.
 */
function sessionSequence() {
  let seq = 0;
  return () => {
    seq += 1;
    return seq;
  };
}

function logBuffer(maxLines, nextSeq) {
  const lines = [];
  // What this component has produced, which is NOT the sequence number: the
  // sequence is session-wide, so `total` has to be counted separately or a
  // truncated log's arithmetic stops adding up.
  let produced = 0;
  let dropped = 0;
  // Every line ever OFFERED, blanks included - distinct from `produced`
  // (admitted lines). Zero means the feeding stream never delivered a single
  // byte, which is what the teardown's final read keys on.
  let seen = 0;
  // Whatever arrived after the last newline. A stream is bytes, not lines, so a
  // line straddling two chunks is held here until the rest of it comes.
  let partial = '';

  function admit(line) {
    seen += 1;
    if (!line.trim()) return;
    const match = LOG_LINE.exec(line);
    produced += 1;
    lines.push({ seq: nextSeq(), at: match ? match[1] : null, text: match ? match[2] : line });

    // Bounded, and the client is TOLD how many went. A silently truncated log
    // reads as a complete one.
    while (lines.length > maxLines) {
      lines.shift();
      dropped += 1;
    }
  }

  return {
    /**
     * @param {Buffer|string} chunk a piece of the follow stream, on no
     *   particular boundary
     */
    append(chunk) {
      if (!chunk) return;
      partial += chunk.toString('utf8');
      const parts = partial.split('\n');
      partial = parts.pop();
      for (const line of parts) admit(line);
    },
    /** Whatever the container wrote without a trailing newline before it died. */
    flush() {
      if (!partial) return;
      const last = partial;
      partial = '';
      admit(last);
    },
    /** How many lines the feeding stream has ever offered, blanks included. */
    seenCount() {
      return seen;
    },
    /**
     * @param {number} [sinceSeq] what the caller already has; 0 means everything
     *   still retained. Filtering here rather than discarding on read is what
     *   lets a lost response be re-fetched with the same cursor, and lets two
     *   readers each see the whole log.
     */
    view(sinceSeq = 0) {
      return {
        lines: sinceSeq > 0 ? lines.filter((line) => line.seq > sinceSeq) : [...lines],
        dropped,
        total: produced,
      };
    },
  };
}

/**
 * Follow a component's output into its buffer for the rest of the session.
 *
 * Following rather than re-reading is what makes the log trustworthy: docker's
 * `since` filter is inclusive and only accurate to the second, so polled reads
 * always overlap and anything faster than the page size is lost between them. A
 * stream has neither problem, and the buffer needs no de-duplication at all.
 *
 * Best effort: logs are the most useful part of a failed session, so a
 * container that has already gone must not turn a reportable failure into an
 * unreportable one. The stream ending is the normal end of a short-lived
 * container's output, not an error.
 *
 * @returns {Promise<function|null>} stop handle, or null if it could not follow
 */
async function followLogsInto(component, buffer) {
  try {
    const { stream, stop } = await dockerService.dockerContainerLogsStream(component.identifier, {
      timestamps: true,
      tail: logLines(),
    });
    stream.on('data', (chunk) => buffer.append(chunk));
    stream.on('end', () => buffer.flush());
    stream.on('error', (error) => {
      buffer.flush();
      log.warn(`playground: log stream for ${component.identifier} ended: ${error.message}`);
    });
    return stop;
  } catch (error) {
    log.warn(`playground: could not follow logs for ${component.identifier}: ${error.message}`);
    return null;
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
  // One stop handle per component's follow, closed by the teardown. A follow
  // outliving its session would hold a docker connection open for nothing.
  session.logFollows = [];
  const nextSeq = sessionSequence();

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
  const network = await playgroundNetwork.createSessionNetwork(session.sessionId);
  session.bridge = network.bridge;
  session.subnet = network.subnet;
  session.networkName = network.networkName;
  status(`Session network ready on ${network.subnet}, capped and default-deny outbound`);

  // Subscribed BEFORE anything starts, so no transition can happen unobserved.
  // Inspecting first and subscribing after would leave a window in which a
  // container that died immediately fires its event into nothing, and the
  // session would then wait out its whole deadline for a verdict that had
  // already happened.
  session.watcher = playgroundWatcher.createSessionWatcher(session.sessionId);
  await session.watcher.start(components.map((component) => component.identifier));

  // eslint-disable-next-line no-restricted-syntax
  for (const component of components) {
    throwIfCancelled(session, hooks);
    // Claimed BEFORE the attempt, not after it succeeds. Teardown works from
    // this map, so a component that fails half way through its own start - image
    // pulled, container created, start refused - has to already be in it or its
    // container survives the session that created it.
    session.results[component.name] = { started: false, probe: null };
    session.logBuffers[component.name] = logBuffer(logRetainedLines(), nextSeq);
    // eslint-disable-next-line no-await-in-loop
    await startComponent(component, session, status);
    session.results[component.name].started = true;
    // Follow from the moment it is up: a container that says something and dies
    // in the next second has still said it, and a reader attached later would
    // never see it.
    // eslint-disable-next-line no-await-in-loop
    const stopLogs = await followLogsInto(component, session.logBuffers[component.name]);
    if (stopLogs) session.logFollows.push(stopLogs);
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
  // Runs for the probe AND the window that follows: the question is what this
  // session did overall, so the sampling must not stop when the verdict lands.
  const stopCpuSampler = startCpuSampler(components, session.watcher, cpu);

  try {
    // eslint-disable-next-line no-restricted-syntax
    for (const component of components) {
      throwIfCancelled(session, hooks);
      status(`Probing ${component.name}...`);
      // eslint-disable-next-line no-await-in-loop
      const probe = await probeComponent(component, session.watcher, deadlineNs, () => Boolean(hooks.isCancelled && hooks.isCancelled()));
      // No log snapshot here: the follow keeps writing after this line, so
      // anything captured now would be stale by the time it was read. The poll
      // builds the view from the buffer, at the cursor the caller asked for.
      session.results[component.name] = { started: true, probe };
      status(`${component.name}: ${probe.passed ? 'passed' : 'failed'} (${probe.basis})`);
    }

    // The probe has a verdict; the SESSION has not ended. This is the window the
    // owner actually watches in - logs accumulating, the app staying up or
    // falling over - and it is what the design's duty cycle is costed against:
    // two sessions of fifteen running minutes is the "~30 minutes and ~1
    // core-hour per hour" a node donates.
    //
    // Timed from when the containers actually started, not from when the request
    // was accepted, so a slow registry eats into the pulls rather than into this.
    await observeSession(session, components, session.watcher, hooks, status);
  } finally {
    stopCpuSampler();
  }

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
async function observeSession(session, components, watcher, hooks, status) {
  const deadlineNs = process.hrtime.bigint() + BigInt(sessionTtlMs()) * 1_000_000n;
  const identifiers = components.map((component) => component.identifier);
  session.runningSince = Date.now();
  status(`Running. Watching for up to ${Math.round(sessionTtlMs() / 60000)} minutes.`);

  while (process.hrtime.bigint() < deadlineNs) {
    throwIfCancelled(session, hooks);

    if (!watcher.anyRunning(identifiers)) {
      status('Every component has stopped; ending the session.');
      return;
    }

    // The last container stopping wakes this immediately; otherwise it sleeps
    // until the deadline. Nothing is asked of docker in between.
    const remainingNs = deadlineNs - process.hrtime.bigint();
    // eslint-disable-next-line no-await-in-loop
    await watcher.changedOr(Math.max(1, Number(remainingNs / 1_000_000n)));
  }

  session.reachedDeadline = true;
  status('Reached the session time limit.');
}

/**
 * Sample every running container's CPU on a cadence for as long as the session
 * lasts, into the session's one accumulator.
 *
 * @returns {function} stop handle
 */
function startCpuSampler(components, watcher, cpu) {
  let stopped = false;
  let timer = null;

  const tick = async () => {
    // eslint-disable-next-line no-restricted-syntax
    for (const component of components) {
      if (stopped) return;
      if (!watcher.state(component.identifier).running) continue;
      // eslint-disable-next-line no-await-in-loop
      const fraction = await sampleCpuFraction(component);
      if (fraction !== null) cpu.record(fraction);
    }
    if (!stopped) timer = setTimeout(tick, cpuSampleMs());
  };

  timer = setTimeout(tick, cpuSampleMs());

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * The terminal read of one component's log, straight from the record.
 *
 * The follow serves the live session; docker's log FILE is the source of truth
 * and outlives the container. A component whose follow never delivered a
 * single line - a container that died milliseconds after starting, its bytes
 * still in flight when the session ended - gets its words from here, read
 * BEFORE the removal destroys the record. A buffer the follow ever fed is
 * left alone: two writers into one cursor space cannot be reconciled under a
 * tail cap, and the observed failure class is all-or-nothing.
 */
async function readFinalLogs(component, buffer) {
  if (!buffer || buffer.seenCount() > 0) return;
  let follow = null;
  try {
    follow = await dockerService.dockerContainerLogsStream(component.identifier, {
      timestamps: true,
      tail: logRetainedLines(),
    });
    await new Promise((resolve) => {
      const tap = setTimeout(resolve, finalLogReadMs());
      follow.stream.on('data', (chunk) => buffer.append(chunk));
      follow.stream.on('end', () => { clearTimeout(tap); resolve(); });
      follow.stream.on('error', () => { clearTimeout(tap); resolve(); });
    });
    buffer.flush();
  } catch (error) {
    log.warn(`playground: could not take the final log read for ${component.identifier}: ${error.message}`);
  } finally {
    try { if (follow) follow.stop(); } catch (error) { /* the stream is already closed */ }
  }
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

  // The event subscription goes first: the removals below are this session's
  // own doing, so there is nothing left to learn from watching them.
  if (session.watcher) session.watcher.stop();

  // Before the containers go: each follow ends when its container does, but a
  // session cancelled while everything is still up would otherwise leave them
  // open. Stopping is what flushes a trailing unterminated line into the buffer.
  for (const stopLogs of session.logFollows || []) {
    try {
      stopLogs();
    } catch (error) {
      log.warn(`playground: could not stop a log follow for ${session.appName}: ${error.message}`);
    }
  }

  const names = Object.keys(session.results || {});
  const components = session.deployment
    ? names.map((name) => session.deployment.getComponent(name)).filter(Boolean)
    : [];

  // The follow served the live session; the terminal state comes from the
  // record, which outlives the container - read before the removal destroys it.
  // eslint-disable-next-line no-restricted-syntax
  for (const component of components) {
    // eslint-disable-next-line no-await-in-loop
    await readFinalLogs(component, session.logBuffers && session.logBuffers[component.name]);
  }

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

  // By session, never by app name: removing an app-named network here would
  // force-disconnect every container on it, a same-named paid app's included.
  const networkName = session.networkName ?? playgroundNetwork.networkNameFor(session.sessionId);
  try {
    await dockerService.forceRemoveFluxAppDockerNetwork(null, { networkName });
  } catch (error) {
    log.warn(`playground: could not remove ${networkName}: ${error.message}`);
  }

  // Check rather than assume. Every removal above swallows its own failure so a
  // session still gets marked finished, which means without this a partial
  // teardown is indistinguishable in the log from a clean one. Asking docker
  // what is actually still labelled turns that into a stated fact - and names
  // the containers, so whoever reads it knows what the sweep will be collecting.
  try {
    const survivors = await labelledContainers(session.sessionId);
    if (survivors.length) {
      log.error(
        `playground: teardown of ${session.appName} left ${survivors.length} container(s) behind `
        + `(${survivors.join(', ')}); the orphan sweep will collect them`,
      );
    }
  } catch (error) {
    log.warn(`playground: could not confirm teardown of ${session.appName}: ${error.message}`);
  }

  return removed;
}

/** Which session a container belongs to, or null if it is not a session's. */
function sessionIdOf(container, labelKeys) {
  return (container.Labels && container.Labels[labelKeys.PLAYGROUND_SESSION]) || null;
}

/** The container names docker still holds for one session. */
async function labelledContainers(sessionId) {
  const containers = await dockerService.dockerListContainers(true);
  const { LABEL_KEYS } = await getSpecBackend();
  return containers
    .filter((container) => sessionIdOf(container, LABEL_KEYS) === sessionId)
    .map((container) => ((container.Names && container.Names[0]) ? container.Names[0].slice(1) : container.Id));
}

/**
 * Remove the playground containers and networks no live session claims.
 *
 * This is what makes a restart safe. Sessions live only in memory, so after a
 * restart there are no live ids and everything labelled is by definition
 * abandoned - the sweep collects the lot. During normal running it collects
 * whatever a failed teardown left behind.
 *
 * Networks are swept here rather than by the app debris sweep, which used to
 * collect them incidentally while they were named like an app's. They are not,
 * any more, so it cannot see them - and an abandoned network holds its bridge
 * slot for the life of the node.
 *
 * @param {Set<string>} liveSessionIds ids the service still owns
 */
async function reapOrphans(liveSessionIds) {
  const networks = await playgroundNetwork.reapOrphanNetworks(liveSessionIds);

  let containers;
  try {
    containers = await dockerService.dockerListContainers(true);
  } catch (error) {
    log.warn(`playground: orphan sweep could not list containers: ${error.message}`);
    return { skipped: 'docker list failed', networksRemoved: networks.removed };
  }

  const { LABEL_KEYS } = await getSpecBackend();
  const orphans = containers.filter((container) => {
    const sessionId = sessionIdOf(container, LABEL_KEYS);
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

  return { removed: removed.length, containers: removed, networksRemoved: networks.removed };
}

module.exports = {
  checkImageSize,
  probeComponent,
  runSession,
  teardownSession,
  reapOrphans,
};
