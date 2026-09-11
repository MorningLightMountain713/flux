'use strict';

// EVERY KNOB THIS CODE READS MUST BE ONE CONFIG SHIPS, AND THIS SAYS SO AT BOOT.
//
// The failure this exists for is silent. `config.fluxapps.x ?? 5000` on a key
// config/default.js does not ship is not a fallback protecting against a broken
// install - it is the only definition of that value, so the knob cannot be set
// by an operator, by the harness, or by a fork. Setting it does nothing, and
// nothing says so. This tree has been bitten twice: appSyncFallbackMinutes, set
// to 5 and to 0 by the harness and ignored both times while every node waited
// 250 blocks, and removeFluxAppsPeriod, which had no reader at all. A sweep
// found 38 more.
//
// Without the `??` the same absence reads as undefined, which is worse: a
// duration becomes NaN, a comparison against it is false, and a ceiling turns
// itself off rather than becoming wrong.
//
// So the reconciliation runs BEFORE anything reads config, and a node that
// cannot find one of its own knobs does not start. Exiting is the point: a node
// running on numbers nobody can see is harder to diagnose than one that refused
// to run and said which key was missing.
//
// The list is swept from the source rather than declared, because a declared
// list is a second copy and drifts away from the reads exactly as the literals
// did. It costs well under a second, once, at boot, over a tree FluxOS already
// runs from.
//
// PARSED, NOT MATCHED. A regex over `config.fluxapps.x` reads one of the four
// ways this tree gets at a knob and silently misses the rest: a destructure
// (`const { bootDelayMultiplier } = config.fluxapps`), the multi-line form of
// one, an alias (`const data = config.fluxapps`), and a nested path
// (`config.fluxapps.spawnDeferrals.capacityGap`, where only `spawnDeferrals`
// was ever checked). A sweep that cannot see a third of its subject is not
// cover, it is the appearance of cover - and the thing it misses is exactly
// the thing nothing else reports.

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, 'src');

let reconciled = false;
// Parsing the service layer costs most of a second, and both entry points plus
// the tests ask for the same answer about the same tree. The source does not
// change inside one process.
const sweeps = new Map();

/**
 * Every .js file under a directory.
 * @param {string} dir
 * @returns {string[]}
 */
function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

/**
 * Which fluxapps keys the service layer reads, and where.
 *
 * ONE FORM, and it is a string literal - which is why this function is nine
 * lines and its predecessor was two hundred. Property access has four spellings
 * (direct, destructured, nested-destructured off config itself, and aliased),
 * they are not distinguishable without resolving bindings, and every one of them
 * answers undefined on a key nobody ships. Three of the four were invisible to
 * the sweep that replaced them, twice.
 *
 * @param {string} [dir] source root, for tests
 * @returns {Map<string, string[]>} dotted path -> the files that read it
 */
function keysRead(dir = SRC) {
  const cached = sweeps.get(dir);
  if (cached) return cached;
  const keys = new Map();
  jsFiles(dir).forEach((file) => {
    const where = path.relative(dir, file);
    const text = fs.readFileSync(file, 'utf8');
    const pattern = /config\.get\(\s*'(fluxapps\.[A-Za-z0-9_.]+)'\s*\)/g;
    let match = pattern.exec(text);
    while (match) {
      const key = match[1].slice('fluxapps.'.length);
      if (!keys.has(key)) keys.set(key, []);
      if (!keys.get(key).includes(where)) keys.get(key).push(where);
      match = pattern.exec(text);
    }
  });
  sweeps.set(dir, keys);
  return keys;
}

/**
 * Reads that go round config.get and will therefore answer undefined in silence.
 *
 * `config.fluxapps.x` in any of its spellings. There is no legitimate one left:
 * the four knobs whose absence used to be a setting now ship the value that says
 * so - null, false, [] - so every read has an answer and get() is the way to ask
 * for it.
 *
 * @param {string} [dir] source root, for tests
 * @returns {Array<{file: string, line: number, text: string}>}
 */
function propertyReads(dir = SRC) {
  const found = [];
  jsFiles(dir).forEach((file) => {
    const where = path.relative(dir, file);
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
      if (!/\bconfig\s*\.\s*fluxapps\b/.test(code) && !/\bfluxapps\s*:\s*\{/.test(code)) return;
      found.push({ file: where, line: i + 1, text: line.trim() });
    });
  });
  return found;
}

/**
 * Resolve a dotted path against an object.
 * @param {object} root
 * @param {string} dotted
 * @returns {*}
 */
function resolve(root, dotted) {
  return dotted.split('.').reduce((acc, step) => (acc == null ? undefined : acc[step]), root);
}

/**
 * The keys this code reads that config does not answer for.
 *
 * Every one of them, not the first: an operator fixing a config wants the whole
 * list, and stopping at the first turns one restart into several.
 *
 * @param {object} fluxapps the effective config.fluxapps
 * @param {string} [dir] source root, for tests
 * @returns {Array<{key: string, files: string[]}>}
 */
function missingKeys(fluxapps, dir = SRC) {
  return [...keysRead(dir).entries()]
    .filter(([key]) => resolve(fluxapps, key) === undefined)
    .map(([key, files]) => ({ key, files }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Run the reconciliation and stop the process if it fails.
 *
 * Writes to stderr directly rather than through the logger: this runs before
 * the logger is required, and a reason the node will not start has to reach
 * whoever is watching the console even if nothing else is up yet.
 *
 * @param {object} [io]
 * @param {(code: number) => void} [io.exit]
 * @param {(line: string) => void} [io.write]
 * @param {object} [io.fluxapps] the config to check, for tests
 * @param {string} [io.dir] the source root to sweep, for tests
 * @returns {Array<{key: string, files: string[]}>} the missing keys
 */
function reconcile(io = {}) {
  const injected = io.exit || io.write || io.fluxapps || io.dir;
  // Both entry points settle their own environment and both run this, and
  // `node app.js` requires the other - so the sweep would otherwise run twice
  // for one process. A caller supplying its own io is asking for the check and
  // is never skipped.
  if (reconciled && !injected) return [];
  if (!injected) reconciled = true;
  const exit = io.exit || ((code) => process.exit(code));
  const write = io.write || ((line) => process.stderr.write(`${line}\n`));

  // eslint-disable-next-line global-require
  const fluxapps = io.fluxapps || require('config').fluxapps || {};
  const missing = missingKeys(fluxapps, io.dir);
  if (!missing.length) return missing;

  write('FluxOS will not start: config/default.js does not ship every fluxapps key this code reads.');
  write('A missing key is not a default - it is a value nobody can see and nobody can change.');
  missing.forEach(({ key, files }) => write(`  fluxapps.${key}   read by ${files.join(', ')}`));
  write('Ship each key in ZelBack/config/default.js, or if absence is a real setting,');
  write('add it to OPTIONAL in ZelBack/configReconciliation.js with the reason.');
  exit(1);
  return missing;
}

module.exports = {
  keysRead, propertyReads, missingKeys, reconcile,
};
