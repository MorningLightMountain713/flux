// Root hook plugin: report async resources still alive after every suite's
// teardown has run. The runner passes --exit so a leaked handle can never hang
// mocha and swallow the run's aggregate again (the suite-21 incident); this
// report keeps those leaks visible instead of letting --exit hide them.
// Non-gating: the driver surfaces it as a warning, not a failure.

import { createHook } from 'node:async_hooks';

// PipeWrap covers stdio when mocha's output is piped (always, under the
// runner's tee), so it cannot distinguish a leak; sockets, timers and child
// processes are the signal.
const EXPECTED_RESOURCES = new Set([
  'TTYWrap', 'Pipe', 'PipeWrap', 'SignalWrap', 'FSReqCallback', 'CloseReq',
]);

// Timer attribution (E2E_TIMER_STACKS=1): record every live Timeout's creation
// stack so a leak report can name its owner instead of a bare count. Capture
// costs a stack per timer creation, so it stays out of normal gate runs. This
// module is --require'd before any suite or framework code loads, so the hook
// sees every timer the process ever creates.
const liveTimers = new Map();
if (process.env.E2E_TIMER_STACKS) {
  // named so captureStackTrace can exclude the hook's own frame - otherwise
  // every stack carries this module's name and the owner filter below eats it
  const onTimerInit = (asyncId, type, triggerAsyncId, resource) => {
    if (type !== 'Timeout') return;
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 30;
    const holder = {};
    Error.captureStackTrace(holder, onTimerInit);
    Error.stackTraceLimit = limit;
    // read the delay now - holding the resource itself would pin it in memory
    liveTimers.set(asyncId, { stack: holder.stack, delay: resource?._idleTimeout, createdAt: Date.now() });
  };
  createHook({
    init: onTimerInit,
    destroy(asyncId) {
      liveTimers.delete(asyncId);
    },
  }).enable();
}

function reportTimerStacks() {
  // group identical creation sites; drop this module's own frames (the drain
  // timer in afterAll may not have hit its destroy hook yet)
  const groups = new Map();
  for (const { stack, delay } of liveTimers.values()) {
    if (stack.includes('open-handle-report.js')) continue;
    const key = `delay=${delay}ms\n${stack}`;
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  if (groups.size === 0) return;
  console.error(`###TIMER-STACKS ${[...groups.values()].reduce((a, b) => a + b, 0)} live timers at ${groups.size} sites`);
  for (const [key, count] of groups) {
    console.error(`--- x${count} ${key}\n`);
  }
}

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
      if (process.env.E2E_TIMER_STACKS) reportTimerStacks();
    }
  },
};
