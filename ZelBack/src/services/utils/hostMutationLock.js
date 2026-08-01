const { AsyncLock } = require('./asyncLock');

// Node-wide serial lock guarding the cross-app-unsafe HOST mutations that several FluxOS
// subsystems perform on single physical host resources:
//   - the ufw ruleset (fluxNetworkHelper allowPort / deleteAllowPortRule -> `sudo ufw ...`);
//   - the UPnP IGD client session (upnpService mapUpnpPort / removeMapUpnpPort);
//   - the content-addressed docker image store (appDockerImageRemove / image prune);
//   - a linked app's docker network (appNetworkLinker cross-app attach vs the teardown
//     worker removing that network).
// Each is one physical resource shared by every app on the node, so two concurrent operations
// corrupt it: an install opening a port while a teardown denies one mangles the ufw ruleset;
// a watchtower prune racing a teardown image-remove corrupts the image store; concurrent UPnP
// edits desync the router session. A single lock shared across ALL of these callers (teardown
// port cleanup, install port-open, prelaunch port-probe, port-support restore, image prune) is
// the one serialization point.
//
// Usage rules (load-bearing):
//   - Acquire ONLY via withHostMutationLock, which pairs one acquire with exactly one release
//     in its finally. maxConcurrent = 1 is the point of this lock: these mutations must be
//     serial, so NEVER raise it.
//   - Wrap ONLY the leaf host-mutation call(s). NEVER hold the lock across an UNBOUNDED wait:
//     no test-bind, no peer-reachability probe, no image pull, no container graceful drain, no
//     serviceHelper.delay. In a multi-port loop, acquire/release PER PORT (each UPnP call
//     carries ~1s of internal pacing) so the longest a holder blocks others is a single call.
//   - NEVER acquire while already holding it (no nesting) -- AsyncLock(1) would deadlock. In
//     particular, do not wrap any region that transitively reaches the removal teardown (which
//     itself acquires this lock): a loop whose body calls the teardown must wrap only its own
//     leaf allow/map calls and keep the teardown call (and any retry delay) OUTSIDE the lock.
const hostMutationLock = new AsyncLock(1);

/**
 * Run fn while holding the node-wide host-mutation lock. fn must perform ONLY a leaf host
 * mutation (a single ufw / UPnP / image-store call) and contain no long wait. Returns fn's
 * result; the lock is always released (finally), even if fn throws.
 * @param {() => Promise<any>} fn
 * @returns {Promise<any>}
 */
async function withHostMutationLock(fn) {
  const release = await hostMutationLock.acquire({ label: 'hostMutation' });
  try {
    return await fn();
  } finally {
    release();
  }
}

module.exports = { withHostMutationLock };
