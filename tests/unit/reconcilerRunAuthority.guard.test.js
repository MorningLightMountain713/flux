'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

// The single-authority invariant (Stage 5d.2): the reconciler is the ONLY component
// that mutates MANAGED-APP container run-state. Every other Docker run-state mutation
// is an explicit, named exception. This guard greps the whole services tree and fails
// if any appDockerStart/Stop/Restart/Kill call — or raw dockerode start/stop/restart/
// kill — appears outside the allowlist. A new offender means: route it through the
// reconciler (set durable/operation intent + enqueue, or drive()), don't actuate Docker
// directly. If the authority surface legitimately changes, update the expected counts
// here ON PURPOSE — that conscious edit is the point.
//
// A REFERENCE counts, not just a call. The pattern deliberately does not require the
// opening bracket, because taking the primitive as an injected dependency —
//   const { restart = dockerService.appDockerRestart } = deps;  ...  await restart(id);
// — mutates run state exactly as much as calling it directly, while producing no
// `.appDockerRestart(` anywhere for a call-shaped pattern to find. Two modules already
// do this for their reload reactions, and both were invisible to this guard until the
// pattern was loosened: the invariant read as "only these files mutate run state" while
// anything could step outside it by accepting the function as a parameter.

const SERVICES = path.join(__dirname, '..', '..', 'ZelBack', 'src', 'services');

function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function matchingLines(file, regex) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    if (regex.test(line)) hits.push(`${i + 1}: ${line.trim()}`);
  });
  return hits;
}

describe('reconciler run-authority guard', () => {
  const files = jsFiles(SERVICES);

  it('only the allowlisted owners call appDockerStart/Stop/Restart/Kill/ForceRemove', () => {
    // file (relative to services) -> exact number of appDocker* run-state calls allowed.
    // A count mismatch (new call in an owner) fails just like a brand-new offender file.
    // ForceRemove counts: destroying a (possibly running) container is the strongest
    // run-state mutation there is.
    const owners = {
      'appMonitoring/appReconciler.js': 8, // the sole authority: volume-unavailable pending stop, data-clear stop, force kill, graceful stop, restart-gen bounce, unhealthy restart, start, network-detach heal force-remove
      'appLifecycle/appUninstaller.js': 6, // terminal teardown: the shared core's kill+stop fallback + force-remove + escalated force-remove, runTeardown's pre-lock kill+stop fallback
      'appManagement/appController.js': 1, // stopAllNonFluxRunningApps janitor (foreign, non-Flux containers)
      // The deposition fence: a deposed master must be down within the grant's
      // fencing window (lock-delay), not at reconcile cadence — the gate stops
      // it HARD the moment it learns of a higher accepted term. Routing through
      // the reconciler would add a pass of latency exactly where the plane's
      // exactly-one promise is enforced.
      'appLifecycle/mastershipGrantGate.js': 1,
      // Owner-declared reload reactions. Both take the primitive as an injected
      // dependency rather than calling it inline, so each shows up as one
      // reference, not one call. Restarting is the owner's own choice of reaction
      // to their content or certificate being replaced under a running container —
      // it is not the reconciler arbitrating run state, which is why these are
      // exceptions rather than routes through it.
      'appLifecycle/contentSlotService.js': 1, // onUpdate: { action: 'restart' }
      'appLifecycle/backendTlsRenewal.js': 1, // backendTls.reload: { action: 'restart' }
      // The playground runs a guest's unsigned spec for 15 minutes and destroys
      // it. Its containers are NOT managed apps: they have no registry row, no
      // desired state and no spec the reconciler could converge them towards, so
      // there is nothing for it to arbitrate. Routing them through it would mean
      // teaching the reconciler about containers it must never try to keep alive.
      // start, teardown force-remove, orphan-reaper force-remove.
      'appPlayground/playgroundRunner.js': 3,
    };
    // No `\(` — a bare reference is a mutation too; see the header.
    const call = /\.appDocker(Start|Stop|Restart|Kill|ForceRemove)\b/;
    const offenders = [];
    const counts = {};
    for (const file of files) {
      const rel = path.relative(SERVICES, file).split(path.sep).join('/');
      const hits = matchingLines(file, call);
      if (hits.length === 0) continue;
      if (!(rel in owners)) {
        offenders.push(`${rel} is not a run-state owner:\n  ${hits.join('\n  ')}`);
      } else {
        counts[rel] = hits.length;
      }
    }
    expect(offenders, `unexpected run-state mutation(s) — route through the reconciler:\n${offenders.join('\n')}`).to.deep.equal([]);
    expect(counts).to.deep.equal(owners);
  });

  it('only dockerService and the watchtower cleanup call raw dockerode start/stop/restart/kill', () => {
    // dockerService IS the docker primitive layer (it implements appDocker*); the
    // watchtower cleanup stops a system container, not a managed app. No other module
    // may reach around the appDocker* primitives to raw dockerode.
    const allowed = new Set([
      'dockerService.js',
      'imageUpdateService.js',
    ]);
    const raw = /\b(container|dockerContainer)\.(start|stop|restart|kill)\(/;
    const offenders = [];
    for (const file of files) {
      const rel = path.relative(SERVICES, file).split(path.sep).join('/');
      if (allowed.has(rel)) continue;
      const hits = matchingLines(file, raw);
      if (hits.length > 0) offenders.push(`${rel}:\n  ${hits.join('\n  ')}`);
    }
    expect(offenders, `unexpected raw dockerode run-state call(s) — use the appDocker* primitives:\n${offenders.join('\n')}`).to.deep.equal([]);
  });
});
