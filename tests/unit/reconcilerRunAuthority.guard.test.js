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

  it('only the allowlisted owners call appDockerStart/Stop/Restart/Kill', () => {
    // file (relative to services) -> exact number of appDocker* run-state calls allowed.
    // A count mismatch (new call in an owner) fails just like a brand-new offender file.
    const owners = {
      'appMonitoring/appReconciler.js': 7, // the sole authority: volume-unavailable pending stop, data-clear stop, force kill, graceful stop, restart-gen bounce, unhealthy restart, start
      'appLifecycle/appUninstaller.js': 4, // terminal teardown: uninstallComponent (redeploy) kill+stop, runTeardown worker kill+stop
      'appLifecycle/componentProvisioner.js': 1, // test-install inline start (synchronous fail-fast)
      'appManagement/appController.js': 1, // stopAllNonFluxRunningApps janitor (foreign, non-Flux containers)
    };
    const call = /\.appDocker(Start|Stop|Restart|Kill)\(/;
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
