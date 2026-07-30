/*
 * Find proxyquire stub keys naming a module the target never requires.
 *
 * proxyquire silently ignores a key that matches no require in the module under
 * test. The stub then reads as coverage and does nothing — and when a refactor
 * moves code between modules, every key pointing at the old location goes quiet
 * without a single test turning red. This finds them.
 *
 *   node tests/tools/stale-proxyquire-stubs.js            # report
 *   node tests/tools/stale-proxyquire-stubs.js --strict    # exit 1 if any found
 *
 * A hit is not automatically a bug: it means the stub is inert. Either the
 * module genuinely stopped using that dependency (delete the key) or the test
 * meant to stub something it is now missing (fix the key).
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const TEST_GLOB_DIR = path.join(REPO, 'tests', 'unit');

const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
const PROXYQUIRE_RE = /proxyquire\(\s*[`'"]([^`'"]+)[`'"]\s*,/g;

/** Every module string a file requires, top-level or inline. */
function requiresOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const found = new Set();
  for (const m of src.matchAll(REQUIRE_RE)) found.add(m[1]);
  return found;
}

/** Index of the '}' closing the object literal that opens at src[start]. */
function matchBrace(src, start) {
  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = start; i < src.length; i += 1) {
    const c = src[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) inString = false;
    } else if (c === "'" || c === '"' || c === '`') {
      inString = true;
      quote = c;
    } else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Keys at depth 1 of an object literal — nested objects are not stub keys. */
function topLevelKeys(block) {
  const keys = [];
  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  let start = -1;
  for (let i = 0; i < block.length; i += 1) {
    const c = block[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c !== quote) continue;
      inString = false;
      if (depth === 1) {
        let j = i + 1;
        while (j < block.length && ' \t\n'.includes(block[j])) j += 1;
        if (block[j] === ':') keys.push(block.slice(start + 1, i));
      }
    } else if (c === "'" || c === '"' || c === '`') {
      inString = true;
      quote = c;
      start = i;
    } else if ('{(['.includes(c)) depth += 1;
    else if ('})]'.includes(c)) depth -= 1;
  }
  return keys;
}

function testFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(full));
    else if (entry.name.endsWith('.test.js')) out.push(full);
  }
  return out.sort();
}

function scan() {
  const findings = new Map();
  for (const testFile of testFiles(TEST_GLOB_DIR)) {
    const src = fs.readFileSync(testFile, 'utf8');
    for (const m of src.matchAll(PROXYQUIRE_RE)) {
      // Template-literal targets carry a variable prefix; resolve the common one.
      const target = m[1].replace('${P}', '../../ZelBack/src/services');
      if (target.includes('${')) continue;

      const brace = src.indexOf('{', m.index + m[0].length);
      if (brace === -1) continue;
      const close = matchBrace(src, brace);
      if (close === -1) continue;

      let modulePath = path.resolve(path.dirname(testFile), target);
      if (!modulePath.endsWith('.js')) modulePath += '.js';
      if (!fs.existsSync(modulePath)) continue;

      const reqs = requiresOf(modulePath);
      for (const key of topLevelKeys(src.slice(brace, close + 1))) {
        if (key.startsWith('@')) continue; // proxyquire directive, not a module
        if (reqs.has(key)) continue;
        const rel = path.relative(REPO, testFile);
        if (!findings.has(rel)) findings.set(rel, new Map());
        const byTarget = findings.get(rel);
        if (!byTarget.has(target)) byTarget.set(target, new Set());
        byTarget.get(target).add(key);
      }
    }
  }
  return findings;
}

const findings = scan();
let total = 0;
for (const [testFile, byTarget] of findings) {
  console.log(testFile);
  for (const [target, keys] of byTarget) {
    console.log(`  -> ${target}`);
    for (const key of [...keys].sort()) {
      console.log(`     STALE  ${key}`);
      total += 1;
    }
  }
}
console.log(`\nfiles: ${findings.size}   stale keys: ${total}`);

if (process.argv.includes('--strict') && total > 0) process.exit(1);
