import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { activeTestEnvs } from './test-env.js';
import { execInContainer } from './container.js';
import { SYNCTHING_HOME } from './syncthing-real.js';
import { thawEveryNode } from './host-stall.js';
import failedHooksModule from './failed-hooks.cjs';

const { failedHooks } = failedHooksModule;

// Under the run's own log directory when it has one, so two runs in one clone
// never overwrite each other's evidence.
const LOG_ROOT = join(process.env.E2E_LOG_DIR || process.cwd(), 'test-logs');

function sanitize(label) {
  return (label || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
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

// Two writers inside a node log only where the node's own output never reaches:
// its syncthing, to a file (the harness's start script and FluxOS's launch each
// name one, and syncthing keeps two rotated files beside it), and the apps its
// dockerd runs, which only that dockerd can read back. Both leave with the node.
// App output is bounded per container: a chatty app's whole history would be
// held in memory by the exec that reads it.
const APP_LOG_LINES = 20000;

const SYNCTHING_LOGS = `
for f in /dat/var/log/syncthing*.log* "${SYNCTHING_HOME}"/syncthing*.log*; do
  [ -f "$f" ] || continue
  echo "=== $f ==="
  cat "$f"
done
`;

const APP_LOGS = `
for c in $(docker ps -a --format '{{.Names}}'); do
  echo "=== $c ($(docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}}' "$c" 2>&1)), last ${APP_LOG_LINES} lines ==="
  docker logs --timestamps --tail ${APP_LOG_LINES} "$c" 2>&1
done
`;

// A node's network as the kernel holds it: every rule with its packet counters,
// the connections conntrack is tracking, addresses and routes, and the packets a
// suite captured to E2E_CAPTURE (see startCapture). All of it leaves with the node.
export const E2E_CAPTURE = '/tmp/e2e-capture.pcap';
const NETWORK_STATE = `
echo "=== ip addr ==="; ip -br addr 2>&1
echo "=== ip route ==="; ip route 2>&1
echo "=== iptables-save -c ==="; iptables-save -c 2>&1
echo "=== conntrack -L ==="; conntrack -L 2>&1 | head -1000
if [ -f ${E2E_CAPTURE} ]; then
  echo "=== packets captured to ${E2E_CAPTURE} ==="
  tcpdump -nn -tttt -e -r ${E2E_CAPTURE} 2>&1 | tail -5000
fi
`;

// Captures a node's packets on every interface to E2E_CAPTURE until stopCapture,
// so a failure dump shows them. The node's API and database traffic is left out:
// the node's own log holds it.
export async function startCapture(container, filter = 'not port 16127 and not port 27017') {
  await execInContainer(container, `rm -f ${E2E_CAPTURE}; tcpdump -i any -nn -U -s 256 -w ${E2E_CAPTURE} '${filter}' </dev/null >/dev/null 2>&1 & echo $! > /tmp/e2e-capture.pid; sleep 1`);
}

export async function stopCapture(container) {
  await execInContainer(container, 'kill "$(cat /tmp/e2e-capture.pid 2>/dev/null)" 2>/dev/null; rm -f /tmp/e2e-capture.pid');
}

// Best-effort, as cgroupState: a node that cannot answer is reported, and never
// fails the dump it is attached to.
async function readFromNodes(env, script) {
  const clients = env.clients || [];
  return Promise.all(clients.map(async (client, index) => {
    if (!client?.container) return { index, output: '' };
    try {
      const { output } = await execInContainer(client.container, script);
      return { index, output };
    } catch (err) {
      return { index, error: err.message };
    }
  }));
}

// DUMP_LOGS=always dumps per-node logs after every test (pass or fail), not just
// failures — used to measure timing on green runs while investigating flakes.
const ALWAYS = process.env.DUMP_LOGS === 'always';

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
// process booted — noisy evidence beats none. A createTestEnv that threw mid-boot
// still counts: the partially-built env holds the log collectors and SSE buffers
// (activeTestEnvs in test-env.js).
function envsFor(suite) {
  const all = activeTestEnvs();
  const chain = ancestorChain(suite);
  const picked = all.filter((env) => !env.ownerSuite || chain.has(env.ownerSuite));
  return picked.length ? picked : all;
}

// Dump each node's logs and SSE events to its OWN file under test-logs/<label>/,
// plus one file per infra container (mongo, the stubs, the registry). A merged
// stdout dump interleaves all nodes, which makes "which node did what" impossible
// to read (every node logs the same identifiers every cycle). Per-node files keep
// each node's timeline clean; stdout only gets a pointer to them.
//
// The infra files are what explains an INFRA-DEAD run: a mongo that takes SIGSEGV
// writes its own backtrace, which leaves with the container.
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
  // an `error` and is reported, never thrown.
  // Everything below reads the nodes through their docker, which a suite may
  // have left frozen.
  await Promise.all(envs.map((env) => thawEveryNode(env.clients ?? [])));
  const infraByEnv = await Promise.all(envs.map((env) => env.infraDiagnostics()));
  const cgroupsByEnv = await Promise.all(envs.map((env) => cgroupState(env).catch(
    (err) => `cgroup probe failed: ${err.message}\n`,
  )));
  // What a node's units write to the journal rather than to the container stream
  // the log collectors read; see env.nodeJournals.
  const journalsByEnv = await Promise.all(envs.map((env) => env.nodeJournals().catch(
    (err) => [{ index: 0, text: `journal read failed: ${err.message}\n` }],
  )));
  const nodeFilesByEnv = await Promise.all(envs.map(async (env) => ({
    syncthing: await readFromNodes(env, SYNCTHING_LOGS),
    apps: await readFromNodes(env, APP_LOGS),
    network: await readFromNodes(env, NETWORK_STATE),
  })));

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
    for (const { index, ip, lines, events } of env.nodeDiagnostics()) {
      if (!lines.length && !events.length) continue;

      const parts = [`=== Node ${index} (ip ${ip ?? '?'}) — ${lines.length} log lines ===`];
      parts.push(...lines);
      if (events.length) {
        parts.push('', `=== Node ${index} SSE events (${events.length}) ===`);
        events.forEach((ev) => parts.push(`${ev.event}: ${JSON.stringify(ev.data)}`));
      }
      const file = join(dir, `${prefix}node-${String(index).padStart(2, '0')}.log`);
      writeFileSync(file, `${parts.join('\n')}\n`);
      written.push(`${file} (${lines.length} lines, ${events.length} events)`);
    }
    for (const { index, text } of journalsByEnv[e]) {
      if (!text.trim()) continue;
      const file = join(dir, `${prefix}node-${String(index).padStart(2, '0')}-journal.log`);
      writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`);
      written.push(`${file} (${text.trimEnd().split('\n').length} lines)`);
    }
    for (const [kind, results] of Object.entries(nodeFilesByEnv[e])) {
      for (const { index, output, error } of results) {
        if (error) {
          console.log(`log-on-failure: no ${kind} logs for node ${index}: ${error}`);
          continue;
        }
        if (!output.trim()) continue;
        const file = join(dir, `${prefix}node-${String(index).padStart(2, '0')}-${kind}.log`);
        writeFileSync(file, output.endsWith('\n') ? output : `${output}\n`);
        written.push(`${file} (${output.trimEnd().split('\n').length} lines)`);
      }
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
    await dump(this.currentTest.fullTitle(), envsFor(this.currentTest.parent));
  },

  // afterEach never fires for a failed hook, which is when setup blew up and the
  // node logs matter most. A hook that failed anywhere under a suite file is
  // dumped here, under that hook's title, whatever passed before it.
  async afterAll() {
    const root = this.test?.parent;
    if (!root) return;
    await Promise.all(root.suites.map(async (suite) => {
      const [first] = failedHooks(suite);
      if (first) await dump(first.fullTitle(), envsFor(first.parent));
    }));
  },
};

// The root hooks above cover every suite file with no registration, so this does
// nothing; suites that still call it keep loading.
// eslint-disable-next-line no-unused-vars
export function dumpLogsOnFailure(getEnv) {}
