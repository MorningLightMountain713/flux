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
const espree = require('espree');

const SRC = path.join(__dirname, 'src');

let reconciled = false;
// Parsing the service layer costs most of a second, and both entry points plus
// the tests ask for the same answer about the same tree. The source does not
// change inside one process.
const sweeps = new Map();

/**
 * Keys whose ABSENCE is a meaningful setting, with the reason each is allowed
 * to be missing. Every one of these reads the value through a guard that gives
 * absence a defined meaning - it is never used raw.
 *
 * Anything not listed here is required, so adding a knob to the code and
 * forgetting to ship it fails at the next boot rather than at the next
 * incident.
 */
const OPTIONAL = new Map([
  ['quorumGrantActivationHeight', 'absent = the grant plane has not been scheduled yet and stays inert'],
  ['quorumGrantMastership', 'absent = the mastership gate is off; read as `!== true`'],
  ['restartAlwaysOwners', 'absent = nobody is on the list; read as `|| []`'],
  ['verifyPoolSize', 'absent = cpus-1, which is what production runs; read through Number.isInteger'],
]);

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
 * Every node of an AST, depth first.
 * @param {object} node
 * @param {(node: object) => void} visit
 */
function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  Object.keys(node).forEach((field) => {
    if (field === 'parent') return;
    const child = node[field];
    if (Array.isArray(child)) child.forEach((c) => walk(c, visit));
    else if (child && typeof child.type === 'string') walk(child, visit);
  });
}

/**
 * The dotted path a member expression reads, when every step of it is static.
 *
 * `config.fluxapps.spawnDeferrals.capacityGap` answers
 * ['config', 'fluxapps', 'spawnDeferrals', 'capacityGap']. A computed step that
 * is not a string literal answers null: the path is not knowable from the
 * source, and guessing at one is how a sweep reports a key nobody reads.
 *
 * @param {object} node
 * @returns {string[]|null}
 */
function staticPath(node) {
  if (node.type === 'Identifier') return [node.name];
  if (node.type !== 'MemberExpression') return null;
  const base = staticPath(node.object);
  if (!base) return null;
  if (node.computed) {
    if (node.property.type === 'Literal' && typeof node.property.value === 'string') {
      return [...base, node.property.value];
    }
    return null;
  }
  if (node.property.type !== 'Identifier') return null;
  return [...base, node.property.name];
}

/**
 * The path under fluxapps, or null if this expression is not one.
 * @param {object} node
 * @param {Set<string>} aliases names bound to config.fluxapps in this file
 * @returns {string[]|null}
 */
function fluxappsPath(node, aliases) {
  const full = staticPath(node);
  if (!full) return null;
  if (full[0] === 'config' && full[1] === 'fluxapps') return full.slice(2);
  if (aliases.has(full[0])) return full.slice(1);
  return null;
}

/**
 * The keys an object pattern takes, by the name it reads them under - which is
 * the key, not the local name a rename gives it.
 *
 * A property with a default (`{ x = 5 }`) is a read whose absence has a
 * meaning, so it is reported separately rather than required: the same
 * judgement OPTIONAL makes, made by the code itself.
 *
 * @param {object} pattern ObjectPattern
 * @returns {{required: string[], defaulted: string[]}}
 */
function patternKeys(pattern) {
  const required = [];
  const defaulted = [];
  pattern.properties.forEach((prop) => {
    if (prop.type !== 'Property' || prop.computed) return;
    const key = prop.key.type === 'Identifier' ? prop.key.name
      : (prop.key.type === 'Literal' ? String(prop.key.value) : null);
    if (!key) return;
    if (prop.value.type === 'AssignmentPattern') defaulted.push(key);
    else required.push(key);
  });
  return { required, defaulted };
}

/**
 * Which fluxapps paths the service layer reads, and where.
 *
 * Paths, not top-level keys: `spawnDeferrals.capacityGap` is as absent as
 * `spawnDeferrals` would be, and reads as undefined the same way.
 *
 * @param {string} [dir] source root, for tests
 * @returns {Map<string, string[]>} dotted path -> the files that read it
 */
function keysRead(dir = SRC) {
  const cached = sweeps.get(dir);
  if (cached) return cached;
  const keys = new Map();
  const record = (segments, where) => {
    if (!segments.length) return;
    const key = segments.join('.');
    if (!keys.has(key)) keys.set(key, []);
    if (!keys.get(key).includes(where)) keys.get(key).push(where);
  };

  jsFiles(dir).forEach((file) => {
    const where = path.relative(dir, file);
    const text = fs.readFileSync(file, 'utf8');
    const ast = espree.parse(text, { ecmaVersion: 'latest', sourceType: 'script', loc: false });

    // A name bound to config.fluxapps stands in for it, so `data.x` is a read
    // of fluxapps.x. Collected first, because the binding may be written below
    // the use in source order inside a function.
    const aliases = new Set();
    walk(ast, (node) => {
      if (node.type !== 'VariableDeclarator' || !node.init) return;
      if (node.id.type !== 'Identifier') return;
      const p = staticPath(node.init);
      if (p && p[0] === 'config' && p[1] === 'fluxapps' && p.length === 2) aliases.add(node.id.name);
    });

    walk(ast, (node) => {
      // const { a, b } = config.fluxapps.something
      if (node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern' && node.init) {
        const base = fluxappsPath(node.init, aliases);
        if (base) {
          const { required } = patternKeys(node.id);
          required.forEach((key) => record([...base, key], where));
          return;
        }
      }
      // ({ a } = config.fluxapps) - assignment rather than declaration
      if (node.type === 'AssignmentExpression' && node.left.type === 'ObjectPattern') {
        const base = fluxappsPath(node.right, aliases);
        if (base) {
          const { required } = patternKeys(node.left);
          required.forEach((key) => record([...base, key], where));
          return;
        }
      }
      // config.fluxapps.a.b - recorded whole, and only at the outermost member
      // expression, so the inner config.fluxapps.a is not reported separately
      // when nothing reads it on its own.
      if (node.type === 'MemberExpression') {
        const p = fluxappsPath(node, aliases);
        if (p) record(p, where);
      }
    });
  });

  // An outer path implies its prefixes exist, and recording both would report
  // the same absence twice. Only the longest is kept where one is a prefix of
  // another read in the same tree.
  const all = [...keys.keys()];
  all.forEach((key) => {
    const prefixed = all.some((other) => other !== key && other.startsWith(`${key}.`));
    if (prefixed && keys.get(key).every((f) => all.some((other) => other.startsWith(`${key}.`) && keys.get(other).includes(f)))) {
      keys.delete(key);
    }
  });
  sweeps.set(dir, keys);
  return keys;
}

/**
 * Files that bind config.fluxapps itself to a name.
 *
 * ONE KNOB, TWO SPELLINGS, AND BOTH READABLE: `config.fluxapps.someKey` where
 * it is used, or `const { someKey } = config.fluxapps` at the top of a module.
 * Either says which key it wants, in the source, where this sweep can see it.
 *
 * Binding the object to a name says nothing. From `const data = config.fluxapps`
 * onward the reads are `data.x`, and whether `data` is fluxapps or anything else
 * is a question about the whole file rather than about that line - so a knob read
 * that way is a knob nothing checks, and it goes missing in silence. There is no
 * third thing it buys.
 *
 * @param {string} [dir] source root, for tests
 * @returns {Map<string, string[]>} file -> the names it bound
 */
function aliasesOfFluxapps(dir = SRC) {
  const found = new Map();
  jsFiles(dir).forEach((file) => {
    const where = path.relative(dir, file);
    const ast = espree.parse(fs.readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'script' });
    walk(ast, (node) => {
      if (node.type !== 'VariableDeclarator' || !node.init || node.id.type !== 'Identifier') return;
      const p = staticPath(node.init);
      if (!p || p.length !== 2 || p[0] !== 'config' || p[1] !== 'fluxapps') return;
      if (!found.has(where)) found.set(where, []);
      found.get(where).push(node.id.name);
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
    .filter(([key]) => !OPTIONAL.has(key))
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
  OPTIONAL, aliasesOfFluxapps, keysRead, missingKeys, reconcile,
};
