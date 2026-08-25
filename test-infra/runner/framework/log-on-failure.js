import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { activeTestEnvs } from './test-env.js';

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

// Dump each node's logs and SSE events to its OWN file under test-logs/<label>/.
// A merged stdout dump interleaves all nodes, which makes "which node did what"
// impossible to read (every node logs the same identifiers every cycle). Per-node
// files keep each node's timeline clean; stdout only gets a pointer to them.
function dump(label, envs) {
  if (!envs.length) return;
  const dir = join(LOG_ROOT, sanitize(label));
  try {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.log(`log-on-failure: could not create ${dir}: ${err.message}`);
    return;
  }

  const written = [];
  envs.forEach((env, e) => {
    const prefix = envs.length > 1 ? `env${e + 1}-` : '';
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
    console.log(`\n--- per-node logs written to ${dir} ---`);
    written.forEach((w) => console.log(`  ${w}`));
  } else {
    console.log(`\n--- no node logs captured for ${label} ---`);
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
    dump(this.currentTest.fullTitle(), envs);
  },

  // afterEach never fires for a before/after-all HOOK failure, which is exactly
  // when setup blew up and the node logs matter most. Backstop: walk the suite
  // tree for describes where runnable tests exist but none passed — the
  // signature of a setup-hook failure (an all-pending describe is excluded: its
  // tests never intended to run). Dump at the highest such suite; its subtree
  // shares the one evidence set.
  afterAll() {
    const root = this.test?.parent;
    if (!root) return;
    const allTests = (s) => [...s.tests, ...s.suites.flatMap(allTests)];
    const visit = (suite) => {
      const tests = allTests(suite);
      const runnable = tests.filter((t) => !t.pending);
      const anyPassed = tests.some((t) => t.state === 'passed');
      if (runnable.length && !anyPassed && !dumpedSuites.has(suite)) {
        dump(suite.fullTitle() || suite.title || 'setup-hook', envsFor(suite));
        return;
      }
      suite.suites.forEach(visit);
    };
    root.suites.forEach(visit);
  },
};
