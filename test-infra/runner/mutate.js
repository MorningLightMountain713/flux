#!/usr/bin/env node
// Proves a suite can fail. Each mutation in mutations/<suite>.json is made in a
// worktree of HEAD, every image is built from that worktree under the
// mutation's own tag, and the suite runs there through run-all.sh. A mutation
// passes only when exactly the tests it declares red fail
// (framework/mutation.js has the file's shape).
//
//   node test-infra/runner/mutate.js <suite> [<mutation>...] [--control]
//
// --control also runs the suite unmutated, from this clone on FLUX_E2E_TAG's
// images, and requires every test green. FLUX_E2E_BASE_TAG passes through to a
// suite that boots a node on a released image.
//
// Builds run one at a time host-wide (BUILD_LOCK, flock); each run starts once
// its images exist and the box admits its fleet, by run-parallel.sh's rules: the suite's `// fleet: N` plus
// the nodes in flight within NODE_BUDGET (60), fewer than MAXN (6) runs in
// flight, MIN_FREE_MB (15000) memory available and 1-minute load under MAX_LOAD
// (3/4 of the cores). The clone must be clean: the worktrees are HEAD, so an
// uncommitted change would be tested by the control and not by the mutations.
// Output goes to $E2E_LOG_DIR/mutate-<suite>-<utc>/: `summary` (one verdict line
// per run as it ends, then its reasons), and per run its run-all output
// (<run>.out), log dir and build log. Exit 0 only when every run met its
// declaration.
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { cpus, freemem, loadavg } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { declaredFleet } from './framework/fleet-size.js';
import {
  applyEdit, judgeRun, mutationListProblems, mutationTag, tapResults,
} from './framework/mutation.js';

const RUNNER = dirname(fileURLToPath(import.meta.url));
const CLONE = resolve(RUNNER, '../..');
const NODE_BUDGET = Number(process.env.NODE_BUDGET || 60);
const MAXN = Number(process.env.MAXN || 6);
const MIN_FREE_MB = Number(process.env.MIN_FREE_MB || 15000);
const MAX_LOAD = Number(process.env.MAX_LOAD || Math.floor((cpus().length * 3) / 4));
const ADMIT_POLL_MS = 10000;
// One image build at a time on the host, across every run of this script: two
// builds at once race in containerd's snapshot store. A base-image build that
// takes the same lock (flock -x) waits its turn too.
const BUILD_LOCK = '/tmp/e2e-image-build.lock';

const args = process.argv.slice(2);
const control = args.includes('--control');
const [suite, ...only] = args.filter((a) => a !== '--control');
if (!/^\d+$/.test(suite ?? '')) fail('usage: mutate.js <suite> [<mutation>...] [--control]');

const suiteFiles = readdirSync(join(RUNNER, 'tests')).filter((f) => f.startsWith(`${suite}-`) && f.endsWith('.js'));
if (suiteFiles.length !== 1) fail(`suite ${suite}: ${suiteFiles.length} files in tests/, not one`);
const suiteFile = suiteFiles[0];
const fleet = declaredFleet(readFileSync(join(RUNNER, 'tests', suiteFile), 'utf8'));
if (fleet === null) fail(`${suiteFile} declares no fleet`);
if (fleet > NODE_BUDGET) fail(`${suiteFile} declares ${fleet} nodes, over NODE_BUDGET ${NODE_BUDGET}`);

const listPath = join(RUNNER, 'mutations', `${suite}.json`);
if (!existsSync(listPath)) fail(`suite ${suite} declares no mutations (${listPath})`);
const list = JSON.parse(readFileSync(listPath, 'utf8'));
const problems = mutationListProblems(list);
if (problems.length) fail(`${listPath}:\n  ${problems.join('\n  ')}`);
const unknown = only.filter((n) => !list.some((m) => m.name === n));
if (unknown.length) fail(`not in ${basename(listPath)}: ${unknown.join(', ')}`);
const chosen = only.length ? list.filter((m) => only.includes(m.name)) : list;

if (git(['status', '--porcelain']).trim()) fail('the clone has uncommitted changes; commit them or run from a clean clone');

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const out = join(process.env.E2E_LOG_DIR || '/tmp/e2e-logs', `mutate-${suite}-${stamp}`);
mkdirSync(out, { recursive: true });
const summary = join(out, 'summary');
writeFileSync(summary, `suite ${suite} at ${git(['rev-parse', '--short=10', 'HEAD']).trim()}, fleet ${fleet}\n`);
console.log(out);

let runsInFlight = 0;
const runs = [];
if (control) runs.push(controlRun());
for (const m of chosen) {
  // one build at a time; the runs it releases overlap the next build
  // eslint-disable-next-line no-await-in-loop
  const tree = await prepare(m);
  if (tree) runs.push(mutationRun(m, tree));
}
const allMet = (await Promise.all(runs)).every(Boolean) && runs.length === chosen.length + (control ? 1 : 0);
appendFileSync(summary, `${allMet ? 'ALL MET' : 'NOT ALL MET'}\n`);
process.exit(allMet ? 0 : 1);

function fail(message) {
  console.error(`mutate: ${message}`);
  process.exit(2);
}

function git(gitArgs) {
  const r = spawnSync('git', ['-C', CLONE, ...gitArgs], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${gitArgs.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout;
}

/** Runs a command with its output appended to `log`; resolves its exit status, 1 on a signal. */
function run(command, commandArgs, { cwd, env = {}, log }) {
  const fd = openSync(log, 'a');
  const child = spawn(command, commandArgs, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', fd, fd] });
  return new Promise((resolveStatus) => {
    child.on('close', (code) => {
      closeSync(fd);
      resolveStatus(code ?? 1);
    });
  });
}

function record(label, verdict) {
  const line = `${verdict.ok ? 'MET    ' : 'NOT MET'} ${label}`;
  appendFileSync(summary, `${line}\n${verdict.reasons.map((r) => `        ${r}\n`).join('')}`);
  console.log(line);
}

/** MemAvailable in MB, or the free memory where /proc is absent. */
function availableMb() {
  try {
    const m = /^MemAvailable:\s+(\d+) kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'));
    if (m) return Math.floor(Number(m[1]) / 1024);
  } catch {
    // not Linux
  }
  return Math.floor(freemem() / 1048576);
}

function admits() {
  if (runsInFlight === 0) return true;
  return runsInFlight < MAXN
    && (runsInFlight + 1) * fleet <= NODE_BUDGET
    && availableMb() >= MIN_FREE_MB
    && loadavg()[0] < MAX_LOAD;
}

/** Waits for the box to admit one more fleet, then holds its place. */
async function admit() {
  while (!admits()) {
    // eslint-disable-next-line no-await-in-loop
    await sleep(ADMIT_POLL_MS);
  }
  runsInFlight += 1;
}

/** Runs the suite through run-all.sh in `tree` once admitted, and judges it against `red`. */
async function runSuite(label, tree, tag, red) {
  await admit();
  try {
    const logDir = join(out, label);
    const status = await run('bash', [join(tree, 'test-infra/runner/run-all.sh')], {
      cwd: join(tree, 'test-infra/runner'),
      env: {
        SUITE_GLOB: `tests/${suiteFile}`,
        FLUX_E2E_TAG: tag,
        E2E_LOG_DIR: logDir,
        E2E_RUN_LABEL: `${label}-${process.pid}`,
        DUMP_LOGS_SUITES: suite,
      },
      log: join(out, `${label}.out`),
    });
    const tapFile = join(logDir, `${basename(suiteFile, '.js')}.tap`);
    const results = existsSync(tapFile) ? tapResults(readFileSync(tapFile, 'utf8')) : [];
    const verdict = judgeRun(results, red);
    if (status > 1) verdict.reasons.unshift(`run-all.sh exited ${status}`);
    return { ...verdict, ok: verdict.ok && status <= 1 };
  } finally {
    runsInFlight -= 1;
  }
}

async function controlRun() {
  const tag = process.env.FLUX_E2E_TAG || 'latest';
  const verdict = await runSuite('control', CLONE, tag, []);
  record(`control on ${tag}`, verdict);
  return verdict.ok;
}

/** The mutation's worktree with its edits made and its images built, or null when it cannot run. */
async function prepare(m) {
  const tag = mutationTag(suite, process.pid, m.name);
  const tree = join(out, `${m.name}.tree`);
  const buildLog = join(out, `${m.name}.build.log`);
  try {
    git(['worktree', 'add', '--quiet', '--detach', tree, 'HEAD']);
    if (await run('bash', [join(CLONE, 'test-infra/copy-build-products.sh'), CLONE, tree], { log: buildLog }) !== 0) {
      throw new Error('the build products could not be copied');
    }
    symlinkSync(join(CLONE, 'node_modules'), join(tree, 'node_modules'));
    symlinkSync(join(CLONE, 'test-infra/runner/node_modules'), join(tree, 'test-infra/runner/node_modules'));
    copyFileSync(join(CLONE, 'config/userconfig.js'), join(tree, 'config/userconfig.js'));
    for (const edit of m.edits) {
      const file = join(tree, edit.file);
      writeFileSync(file, applyEdit(readFileSync(file, 'utf8'), edit));
    }
    const build = ['-x', BUILD_LOCK, 'bash', join(tree, 'test-infra/build-images.sh')];
    if (await run('flock', build, { cwd: tree, env: { FLUX_E2E_TAG: tag }, log: buildLog }) !== 0) {
      throw new Error(`the images did not build (${buildLog})`);
    }
    return tree;
  } catch (err) {
    record(m.name, { ok: false, reasons: [err.message] });
    await cleanUp(m, tree);
    return null;
  }
}

async function mutationRun(m, tree) {
  try {
    const verdict = await runSuite(m.name, tree, mutationTag(suite, process.pid, m.name), m.red);
    record(m.name, verdict);
    return verdict.ok;
  } finally {
    await cleanUp(m, tree);
  }
}

async function cleanUp(m, tree) {
  const tag = mutationTag(suite, process.pid, m.name);
  const listed = spawnSync('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}', '--filter', `reference=flux-e2e-*:${tag}`], { encoding: 'utf8' });
  const images = listed.stdout.split('\n').filter(Boolean);
  if (images.length) await run('docker', ['rmi', ...images], { log: join(out, `${m.name}.build.log`) });
  if (existsSync(tree)) git(['worktree', 'remove', '--force', tree]);
}
