#!/usr/bin/env node
// Proves a suite can fail. Each mutation in mutations/<suite>.json is made in a
// worktree of HEAD, every image is built from that worktree under the
// mutation's own tag, and the suite runs there through run-all.sh. A mutation
// passes only when exactly the tests it declares red fail
// (framework/mutation.js has the file's shape).
//
//   node test-infra/runner/mutate.js <suite> [<mutation>...] [--control]
//
// --control first runs the suite unmutated, from this clone on FLUX_E2E_TAG's
// images, and requires every test green. FLUX_E2E_BASE_TAG passes through to a
// suite that boots a node on a released image.
//
// One mutation at a time, each on one fleet. The clone must be clean: the
// worktree is HEAD, so an uncommitted change would be tested by the control and
// not by the mutations. Output goes to $E2E_LOG_DIR/mutate-<suite>-<utc>/:
// `summary` (one verdict line per run, then the reasons), and per run its
// run-all output (<run>.out), log dir and build log. Exit 0 only when every run
// met its declaration.
import { spawnSync } from 'node:child_process';
import {
  appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyEdit, judgeRun, mutationListProblems, mutationTag, tapResults,
} from './framework/mutation.js';

const RUNNER = dirname(fileURLToPath(import.meta.url));
const CLONE = resolve(RUNNER, '../..');

const args = process.argv.slice(2);
const control = args.includes('--control');
const [suite, ...only] = args.filter((a) => a !== '--control');
if (!/^\d+$/.test(suite ?? '')) fail('usage: mutate.js <suite> [<mutation>...] [--control]');

const suiteFiles = readdirSync(join(RUNNER, 'tests')).filter((f) => f.startsWith(`${suite}-`) && f.endsWith('.js'));
if (suiteFiles.length !== 1) fail(`suite ${suite}: ${suiteFiles.length} files in tests/, not one`);
const suiteFile = suiteFiles[0];

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
writeFileSync(summary, `suite ${suite} at ${git(['rev-parse', '--short=10', 'HEAD']).trim()}\n`);
console.log(out);

let allMet = true;
if (control) allMet = runControl() && allMet;
for (const m of chosen) allMet = runMutation(m) && allMet;
appendFileSync(summary, `${allMet ? 'ALL MET' : 'NOT ALL MET'}\n`);
process.exit(allMet ? 0 : 1);

function fail(message) {
  console.error(`mutate: ${message}`);
  process.exit(2);
}

function git(gitArgs) {
  const r = spawnSync('git', ['-C', CLONE, ...gitArgs], { encoding: 'utf8' });
  if (r.status !== 0) fail(`git ${gitArgs.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout;
}

/** Runs a command with its output appended to `log`; its exit status, 1 on a signal. */
function run(command, commandArgs, { cwd, env = {}, log }) {
  const fd = openSync(log, 'a');
  try {
    const r = spawnSync(command, commandArgs, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', fd, fd] });
    return r.status ?? 1;
  } finally {
    closeSync(fd);
  }
}

function record(label, verdict) {
  const line = `${verdict.ok ? 'MET    ' : 'NOT MET'} ${label}`;
  appendFileSync(summary, `${line}\n${verdict.reasons.map((r) => `        ${r}\n`).join('')}`);
  console.log(line);
}

/** Runs the suite through run-all.sh in `tree` and judges it against `red`. */
function runSuite(label, tree, tag, red) {
  const logDir = join(out, label);
  const status = run('bash', [join(tree, 'test-infra/runner/run-all.sh')], {
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
}

function runControl() {
  const tag = process.env.FLUX_E2E_TAG || 'latest';
  const verdict = runSuite('control', CLONE, tag, []);
  record(`control on ${tag}`, verdict);
  return verdict.ok;
}

function runMutation(m) {
  const tag = mutationTag(suite, m.name);
  const tree = join(out, `${m.name}.tree`);
  const buildLog = join(out, `${m.name}.build.log`);
  try {
    git(['worktree', 'add', '--quiet', '--detach', tree, 'HEAD']);
    if (run('bash', [join(CLONE, 'test-infra/copy-build-products.sh'), CLONE, tree], { log: buildLog }) !== 0) {
      record(m.name, { ok: false, reasons: ['the build products could not be copied'] });
      return false;
    }
    symlinkSync(join(CLONE, 'node_modules'), join(tree, 'node_modules'));
    symlinkSync(join(CLONE, 'test-infra/runner/node_modules'), join(tree, 'test-infra/runner/node_modules'));
    copyFileSync(join(CLONE, 'config/userconfig.js'), join(tree, 'config/userconfig.js'));
    for (const edit of m.edits) {
      const file = join(tree, edit.file);
      writeFileSync(file, applyEdit(readFileSync(file, 'utf8'), edit));
    }
    if (run('bash', [join(tree, 'test-infra/build-images.sh')], { cwd: tree, env: { FLUX_E2E_TAG: tag }, log: buildLog }) !== 0) {
      record(m.name, { ok: false, reasons: [`the images did not build (${buildLog})`] });
      return false;
    }
    const verdict = runSuite(m.name, tree, tag, m.red);
    record(m.name, verdict);
    return verdict.ok;
  } catch (err) {
    record(m.name, { ok: false, reasons: [err.message] });
    return false;
  } finally {
    removeImages(tag, buildLog);
    if (existsSync(tree)) git(['worktree', 'remove', '--force', tree]);
  }
}

function removeImages(tag, log) {
  const listed = spawnSync('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}', '--filter', `reference=flux-e2e-*:${tag}`], { encoding: 'utf8' });
  const images = listed.stdout.split('\n').filter(Boolean);
  if (images.length) run('docker', ['rmi', ...images], { log });
}
