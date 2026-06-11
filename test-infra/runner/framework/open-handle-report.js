// Root hook plugin: report async resources still alive after every suite's
// teardown has run. The runner passes --exit so a leaked handle can never hang
// mocha and swallow the run's aggregate again (the suite-21 incident); this
// report keeps those leaks visible instead of letting --exit hide them.
// Non-gating: the driver surfaces it as a warning, not a failure.

// PipeWrap covers stdio when mocha's output is piped (always, under the
// runner's tee), so it cannot distinguish a leak; sockets, timers and child
// processes are the signal.
const EXPECTED_RESOURCES = new Set([
  'TTYWrap', 'Pipe', 'PipeWrap', 'SignalWrap', 'FSReqCallback', 'CloseReq',
]);

export const mochaHooks = {
  async afterAll() {
    // let teardown-scheduled cleanup (socket closes, immediates) drain first
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    const counts = {};
    for (const resource of process.getActiveResourcesInfo()) {
      if (EXPECTED_RESOURCES.has(resource)) continue;
      counts[resource] = (counts[resource] || 0) + 1;
    }
    // our own drain timer may still be winding down; one Timeout is ours
    if (counts.Timeout) {
      counts.Timeout -= 1;
      if (counts.Timeout === 0) delete counts.Timeout;
    }
    if (Object.keys(counts).length > 0) {
      console.error(`###OPEN-HANDLES ${JSON.stringify(counts)}`);
    }
  },
};
