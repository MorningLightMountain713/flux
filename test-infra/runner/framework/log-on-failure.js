import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { activeTestEnvs } from './test-env.js';
import { execInContainer } from './container.js';

const LOG_ROOT = join(process.cwd(), 'test-logs');

// DUMP_LOGS=always dumps per-node logs after every test (pass or fail), not just
// failures — used to measure timing on green runs while investigating flakes.
const ALWAYS = process.env.DUMP_LOGS === 'always';

// Suites already evidenced by a failed-test dump; the after-all backstop skips
// them so one failure isn't written twice under two labels.
const dumpedSuites = new Set();

function sanitize(label) {
  return (label || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
}

function ancestorChain(suite) {
  const chain = new Set();
  for (let s = suite; s; s = s.parent) chain.add(s);
  return chain;
}

// The envs whose evidence belongs to a failure in `suite`: every env created by
// a hook of `suite` or one of its ancestors (createTestEnv tags env.ownerSuite
// from the hookCtx it already receives), plus any env that carries no tag (a
// createTestEnv call without hookCtx cannot be attributed, so it is never
// filtered out). If attribution matches nothing, fall back to every env this
// process booted — noisy evidence beats none.
function envsFor(suite) {
  const all = activeTestEnvs();
  const chain = ancestorChain(suite);
  const picked = all.filter((env) => !env.ownerSuite || chain.has(env.ownerSuite));
  return picked.length ? picked : all;
}

// A container start that fails inside the runtime reports the same sentence
// whether the parent cgroup no longer delegates a controller or the container's
// own cgroup is absent: `openat2 .../memory.max: no such file or directory`.
// The three facts that separate those - what the parent delegates, what sits
// directly in the parent, and whether the child cgroup exists - live only in the
// node's cgroup tree, which leaves with the container. A start failure is
// diagnosable from the archive only if they are read while the node is up.
const CGROUP_PROBE = `
d=/sys/fs/cgroup/docker
echo "root subtree_control: [$(cat /sys/fs/cgroup/cgroup.subtree_control 2>&1)]"
echo "root procs: $(wc -l < /sys/fs/cgroup/cgroup.procs 2>&1)"
if [ -d "$d" ]; then
  echo "docker/ subtree_control: [$(cat $d/cgroup.subtree_control 2>&1)]"
  echo "docker/ procs: [$(xargs < $d/cgroup.procs 2>&1)]"
  for c in "$d"/*/; do
    [ -d "$c" ] || continue
    if [ -f "$c/memory.max" ]; then m=$(cat "$c/memory.max" 2>&1); else m=ABSENT; fi
    echo "  child $(basename "$c"): memory.max=$m"
  done
else
  echo "docker/: ABSENT"
fi
echo "containers:"
docker ps -a --format '  {{.Names}} {{.Status}}' 2>&1
`;

// Best-effort, exactly like the infra log fetch: a node that cannot answer
// contributes its error, and never fails the dump it is attached to.
async function cgroupState(env) {
  const clients = env.clients || [];
  const parts = await Promise.all(clients.map(async (client, index) => {
    const head = `=== Node ${index} cgroup state ===`;
    if (!client?.container) return `${head}\n  no container\n`;
    try {
      const { output } = await execInContainer(client.container, CGROUP_PROBE);
      return `${head}\n${output}\n`;
    } catch (err) {
      return `${head}\n  probe failed: ${err.message}\n`;
    }
  }));
  return parts.join('\n');
}

// Dump each node's logs and SSE events to its OWN file under test-logs/<label>/.
// A merged stdout dump interleaves all nodes, which makes "which node did what"
// impossible to read (every node logs the same identifiers every cycle). Per-node
// files keep each node's timeline clean; stdout only gets a pointer to them.
async function dump(label, envs) {
  if (!envs.length) return;
  const dir = join(LOG_ROOT, sanitize(label));
  try {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.log(`log-on-failure: could not create ${dir}: ${err.message}`);
    return;
  }

  // Node diagnostics are already in memory; infra logs come off the docker
  // daemon, so they are fetched up front and written alongside them. Each entry
  // is best-effort (see env.infraDiagnostics) — a log fetch that failed carries
  // an `error` and is reported, never thrown. These are what explain an
  // INFRA-DEAD run: a mongo that takes SIGSEGV writes its own backtrace, and
  // without capturing it here that evidence goes with the container.
  const infraByEnv = await Promise.all(envs.map((env) => env.infraDiagnostics()));
  const cgroupsByEnv = await Promise.all(envs.map((env) => cgroupState(env).catch(
    (err) => `cgroup probe failed: ${err.message}\n`,
  )));

  const written = [];
  envs.forEach((env, e) => {
    const prefix = envs.length > 1 ? `env${e + 1}-` : '';
    const cgroups = cgroupsByEnv[e];
    if (cgroups && cgroups.trim()) {
      const file = join(dir, `${prefix}cgroup-state.log`);
      writeFileSync(file, cgroups.endsWith('\n') ? cgroups : `${cgroups}\n`);
      written.push(file);
    }
    for (const { name, text, error } of infraByEnv[e]) {
      if (error) {
        console.log(`log-on-failure: no logs for infra container ${name}: ${error}`);
        continue;
      }
      if (!text.trim()) continue;
      const file = join(dir, `${prefix}infra-${sanitize(name)}.log`);
      writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`);
      written.push(`${file} (${text.trimEnd().split('\n').length} lines)`);
    }
    for (const { index, ip, lines, events, record } of env.nodeDiagnostics()) {
      if (!lines.length && !events.length && !record) continue;

      const parts = [`=== Node ${index} (ip ${ip ?? '?'}) — ${lines.length} log lines ===`];
      parts.push(...lines);
      if (events.length) {
        parts.push('', `=== Node ${index} SSE events (${events.length}) ===`);
        events.forEach((ev) => parts.push(`${ev.event}: ${JSON.stringify(ev.data)}`));
      }
      if (record) {
        parts.push('', `=== Node ${index} in-container record (journal + file log) ===`);
        parts.push(record);
      }
      const file = join(dir, `${prefix}node-${String(index).padStart(2, '0')}.log`);
      writeFileSync(file, `${parts.join('\n')}\n`);
      written.push(`${file} (${lines.length} lines, ${events.length} events${record ? ', record' : ''})`);
    }
  });

  if (written.length) {
    console.log(`\n--- per-container logs written to ${dir} ---`);
    written.forEach((w) => console.log(`  ${w}`));
  } else {
    console.log(`\n--- no container logs captured for ${label} ---`);
  }
}

// Root hook plugin (.mocharc.json `require`): every suite file gets failure
// dumps automatically — no per-suite registration.
export const mochaHooks = {
  async afterEach() {
    if (!ALWAYS && this.currentTest.state !== 'failed') return;
    const envs = envsFor(this.currentTest.parent);
    // The containers are still alive here - the one moment their journals
    // (systemd nodes log there, never to stdout) can be read. Bounded pulls.
    if (this.currentTest.state === 'failed') {
      await Promise.all(envs.map((env) => env.captureNodeRecords?.().catch(() => {})));
    }
    for (const s of ancestorChain(this.currentTest.parent)) dumpedSuites.add(s);
    await dump(this.currentTest.fullTitle(), envsFor(this.currentTest.parent));
  },

  // afterEach never fires for a before/after-all HOOK failure, which is exactly
  // when setup blew up and the node logs matter most. Backstop: walk the suite
  // tree for describes where runnable tests exist but none passed — the
  // signature of a setup-hook failure (an all-pending describe is excluded: its
  // tests never intended to run). Dump at the highest such suite; its subtree
  // shares the one evidence set.
  async afterAll() {
    const root = this.test?.parent;
    if (!root) return;
    const allTests = (s) => [...s.tests, ...s.suites.flatMap(allTests)];
    const targets = [];
    const visit = (suite) => {
      const tests = allTests(suite);
      const runnable = tests.filter((t) => !t.pending);
      const anyPassed = tests.some((t) => t.state === 'passed');
      if (runnable.length && !anyPassed && !dumpedSuites.has(suite)) {
        targets.push(suite);
        return;
      }
      suite.suites.forEach(visit);
    };
    root.suites.forEach(visit);
    for (const suite of targets) {
      const envs = envsFor(suite);
      // A setup failure means createTestEnv may have THROWN: the suite's own
      // after() never saw an env to tear down, so nothing pulled the
      // in-container records - and the containers are still alive right here
      // (run-all's label sweep collects them only after mocha exits). This is
      // the last reader they will ever have.
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(envs.map((env) => env.captureNodeRecords?.().catch(() => {})));
      // eslint-disable-next-line no-await-in-loop
      await dump(suite.fullTitle() || suite.title || 'setup-hook', envs);
    }
  },
};

// Compat shim. The root hooks above cover every suite file with no registration,
// so this does nothing — but development added 48 suites that call it, and a
// removed export is an import-time crash for every one of them. Their sweep goes
// with F8's renumbering pass, which has to open the same files anyway.
// eslint-disable-next-line no-unused-vars
export function dumpLogsOnFailure(getEnv) {}
