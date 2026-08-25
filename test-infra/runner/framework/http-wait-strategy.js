// A testcontainers WaitStrategy that polls an HTTP URL until it responds OK,
// bypassing Docker's health state machine entirely.
//
// Why not the built-in strategies:
//   - Wait.forHealthCheck() couples readiness to Docker's health state machine,
//     which tears the container down the instant Docker reports "unhealthy". Under
//     fleet-boot contention (10 privileged docker-in-docker nodes booting at once)
//     a node can miss the healthcheck startPeriod, or a probe can time out under CPU
//     pressure even though FluxOS is already serving — Docker flips to "unhealthy"
//     and testcontainers destroys the fleet. (It also flips "unhealthy" transiently
//     during monitor teardown on restart — moby health.go CloseMonitorChannel.)
//   - Wait.forHttp() resolves its target as runtimeHost:boundPorts.getBinding(port),
//     i.e. a host-PUBLISHED port. This harness publishes no ports and addresses every
//     node by its static network IP, so there is no bound port for forHttp to target.
//
// This strategy polls the node's own URL — the exact route every test uses to reach
// it — so readiness is validated against the real path, independent of Docker health.
//
// Implements the public testcontainers `WaitStrategy` interface directly (waitUntilReady
// + the startup-timeout accessors), so it needs no internal `testcontainers/build/...`
// import. `.start()` calls withStartupTimeout() when the container has an explicit
// startup timeout, then waitForContainer() calls waitUntilReady(); container.restart()
// calls only waitUntilReady().
export class HttpPollWaitStrategy {
  #url;
  #startupTimeoutMs = 120000;
  #startupTimeoutSet = false;
  #pollIntervalMs;
  #probeTimeoutMs;
  #validate;

  // `validate` inspects the response beyond res.ok — needed when the target
  // returns 200 with an error body while a dependency (e.g. mongo) is still
  // coming up. Defaults to res.ok when omitted.
  constructor(url, { pollIntervalMs = 500, probeTimeoutMs = 2000, validate = null } = {}) {
    this.#url = url;
    this.#pollIntervalMs = pollIntervalMs;
    this.#probeTimeoutMs = probeTimeoutMs;
    this.#validate = validate;
  }

  withStartupTimeout(startupTimeoutMs) {
    this.#startupTimeoutMs = startupTimeoutMs;
    this.#startupTimeoutSet = true;
    return this;
  }

  isStartupTimeoutSet() {
    return this.#startupTimeoutSet;
  }

  getStartupTimeout() {
    return this.#startupTimeoutMs;
  }

  // Only a SETTLED container counts as dead. 'created' is the pre-start moment, and
  // inspect can fail transiently (the container may be mid-removal on another path);
  // neither is evidence, so both keep polling and the deadline stays the backstop.
  async #deathReport(container) {
    if (!container || typeof container.inspect !== 'function') return null;
    let state;
    try {
      ({ State: state } = await container.inspect());
    } catch {
      return null;
    }
    if (!state || state.Running || state.Status === 'created') return null;
    const parts = [`status=${state.Status}`, `exitCode=${state.ExitCode}`];
    if (state.OOMKilled) parts.push('OOMKilled=true');
    if (state.Error) parts.push(`error=${state.Error}`);
    return parts.join(' ');
  }

  // A container that has EXITED never answers, so without a liveness check a dead node
  // is indistinguishable from a slow one: both stay silent for the whole allowance and
  // both report "not ready after Nms". Raising the allowance cannot fix that reading,
  // and a boot-time distribution cannot detect it either — a node that dies contributes
  // no sample, so the distribution reads healthiest when this failure is worst. Fail on
  // the exit instead and report what docker recorded.
  // testcontainers passes the dockerode container as the first argument (see
  // wait-for-container.js); container.restart() calls this the same way.
  async waitUntilReady(container) {
    const deadline = Date.now() + this.#startupTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(this.#url, { signal: AbortSignal.timeout(this.#probeTimeoutMs) });
        if (this.#validate ? await this.#validate(res) : res.ok) return;
      } catch {
        // not serving yet — keep polling until the deadline
      }
      // Checked after the probe so a container that served and then exited on its own
      // teardown is still reported ready, rather than lost to a race with it.
      const death = await this.#deathReport(container);
      if (death) {
        throw new Error(`HttpPollWaitStrategy: ${this.#url} container exited during boot (${death})`);
      }
      await new Promise((r) => setTimeout(r, this.#pollIntervalMs));
    }
    throw new Error(`HttpPollWaitStrategy: ${this.#url} not ready after ${this.#startupTimeoutMs}ms`);
  }
}
