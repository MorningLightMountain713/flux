'use strict';

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
// proxyquire is called bare, through .load(), and through any number of chained
// modifiers — proxyquire.noCallThru()(...) and .noCallThru().load(...) both run.
// Every proxyquire call, whatever its arguments look like. Deliberately not
// anchored on a quoted first argument: a call this does not match is a call
// nobody counts, and an uncounted call is the blind spot this tool exists to
// not have. Matching them all lets each be either checked or reported skipped.
const PROXYQUIRE_RE = /\bproxyquire(?![\w$])(?:\s*\.\s*\w+\s*(?:\(\s*\))?)*\s*\(/g;

const WHITESPACE = ' \t\r\n';

/** Every module string a file requires, top-level or inline. */
function requiresOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const found = new Set();
  for (const m of src.matchAll(REQUIRE_RE)) found.add(m[1]);
  return found;
}

/**
 * Index of the next character that is neither whitespace nor a comment.
 *
 * Comments have to go before anything else looks at the text: an apostrophe in
 * `// don't` would otherwise open a string that runs to the end of the map.
 */
function skipTrivia(src, from) {
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (WHITESPACE.includes(c)) {
      i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      if (nl === -1) return src.length;
      i = nl + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) return src.length;
      i = end + 2;
      continue;
    }
    return i;
  }
  return src.length;
}

/** Index just past the string literal opening at src[start]. */
function skipString(src, start) {
  const quote = src[start];
  for (let i = start + 1; i < src.length; i += 1) {
    if (src[i] === '\\') i += 1;
    else if (src[i] === quote) return i + 1;
  }
  return src.length;
}

function isIdentifierStart(c) {
  return c !== undefined && /[A-Za-z_$]/.test(c);
}

/**
 * The stub keys and the closing brace of the object literal opening at src[open].
 *
 * Only key position is read. A bare identifier names a module to proxyquire just
 * as much as a quoted one, but identifiers appear all over the values too —
 * `key: cond ? a : b` puts one right before a colon — so a key is recognised
 * solely where one can occur: opening the object, or after a top-level comma.
 */
function readStubMap(src, open) {
  const keys = [];
  let depth = 0;
  let expectKey = false;
  let i = open;
  while (i < src.length) {
    i = skipTrivia(src, i);
    if (i >= src.length) break;
    const c = src[i];

    if (depth === 1 && expectKey && (isIdentifierStart(c) || c === "'" || c === '"' || c === '`')) {
      let end;
      let key;
      if (isIdentifierStart(c)) {
        end = i;
        while (end < src.length && /[\w$]/.test(src[end])) end += 1;
        key = src.slice(i, end);
      } else {
        end = skipString(src, i);
        key = src.slice(i + 1, end - 1);
      }
      const next = skipTrivia(src, end);
      // A shorthand property is a key too; `async foo()` and `get x()` are not.
      if (src[next] === ':') {
        keys.push(key);
        i = next + 1;
      } else if (src[next] === ',' || src[next] === '}') {
        keys.push(key);
        i = next;
      } else i = next;
      expectKey = false;
      continue;
    }
    expectKey = false;

    if (c === "'" || c === '"' || c === '`') {
      i = skipString(src, i);
      continue;
    }
    if ('{(['.includes(c)) {
      depth += 1;
      if (depth === 1) expectKey = true;
      i += 1;
      continue;
    }
    if ('})]'.includes(c)) {
      depth -= 1;
      if (depth === 0) return { keys, close: i };
      i += 1;
      continue;
    }
    if (c === ',' && depth === 1) expectKey = true;
    i += 1;
  }
  return { keys, close: -1 };
}

/** The `const P = '...'` in scope at src[before], i.e. the nearest one above it. */
function prefixBefore(src, before) {
  let value = '${P}';
  for (const m of src.matchAll(/const P = '([^']+)'/g)) {
    if (m.index > before) break;
    value = m[1];
  }
  return value;
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
  // What was read and what was not. A checker that reports only findings lets a
  // call it could not parse read as a call with nothing wrong.
  const seen = { checked: 0, variableMap: 0, unreadableTarget: 0, unbalanced: 0 };

  for (const testFile of testFiles(TEST_GLOB_DIR)) {
    const src = fs.readFileSync(testFile, 'utf8');
    for (const m of src.matchAll(PROXYQUIRE_RE)) {
      let i = skipTrivia(src, m.index + m[0].length);

      // The module under test. Anything but a string literal — a constant, an
      // expression — cannot be resolved to a file to compare against.
      if (!'\'"`'.includes(src[i])) { seen.unreadableTarget += 1; continue; }
      const quote = src[i];
      const closeQuote = src.indexOf(quote, i + 1);
      if (closeQuote === -1) { seen.unreadableTarget += 1; continue; }

      // Template-literal targets carry a variable prefix. Read it from the
      // declaration in scope — files disagree on what P points at, and a guess
      // that resolves to no file leaves the whole map unchecked in silence.
      const target = src.slice(i + 1, closeQuote).replace('${P}', prefixBefore(src, m.index));
      if (target.includes('${')) { seen.unreadableTarget += 1; continue; }

      i = skipTrivia(src, closeQuote + 1);
      if (src[i] !== ',') { seen.unreadableTarget += 1; continue; }

      // A map built elsewhere and passed by name has no keys to read here. The
      // brace that follows belongs to some later, unrelated object.
      const open = skipTrivia(src, i + 1);
      if (src[open] !== '{') { seen.variableMap += 1; continue; }
      const { keys, close } = readStubMap(src, open);
      if (close === -1) { seen.unbalanced += 1; continue; }

      let modulePath = path.resolve(path.dirname(testFile), target);
      if (!modulePath.endsWith('.js')) {
        modulePath = fs.existsSync(`${modulePath}.js`) ? `${modulePath}.js` : path.join(modulePath, 'index.js');
      }
      if (!fs.existsSync(modulePath)) { seen.unreadableTarget += 1; continue; }

      seen.checked += 1;
      const reqs = requiresOf(modulePath);
      for (const key of keys) {
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
  return { findings, seen };
}

const { findings, seen } = scan();
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
// Say what was NOT read. Zero findings over a fraction of the tree is not a
// clean tree, and the difference has to be visible or the number gets believed.
const unread = seen.variableMap + seen.unreadableTarget + seen.unbalanced;
console.log(`maps checked: ${seen.checked}   not read: ${unread}`
  + ` (map passed by variable: ${seen.variableMap},`
  + ` target not a readable literal: ${seen.unreadableTarget},`
  + ` map did not close: ${seen.unbalanced})`);

if (process.argv.includes('--strict') && total > 0) process.exit(1);
