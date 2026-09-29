'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { expect } = require('chai');
const espree = require('espree');

// FluxOS loads code in one of two ways: a module requires what it uses at the top
// of its file, or lib/moduleLoader loads a handler after the API listens. These
// tests read every shipped source file and hold both rules, so a late require or an
// import cycle fails here rather than as a half-initialised module on a node.

const ROOT = path.join(__dirname, '../..');
const SOURCE_DIR = path.join(ROOT, 'ZelBack/src');
const LOADER = path.join(SOURCE_DIR, 'lib/moduleLoader.js');

function sourceFiles() {
  const files = [path.join(ROOT, 'apiServer.js')];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    });
  }(SOURCE_DIR));
  return files;
}

function resolveRelative(from, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), specifier);
  return [base, `${base}.js`, path.join(base, 'index.js')]
    .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

/**
 * Every require() call in a file: its line, its specifier (null when not a string
 * literal), and whether it runs when the file loads rather than inside a function.
 */
function requireCalls(file) {
  const ast = espree.parse(fs.readFileSync(file, 'utf8'), { ecmaVersion: 'latest', loc: true });
  const calls = [];
  (function visit(node, insideFunction) {
    if (!node || typeof node.type !== 'string') return;
    const inFunction = insideFunction || /Function/.test(node.type);
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require') {
      const [argument] = node.arguments;
      calls.push({
        line: node.loc.start.line,
        specifier: argument && argument.type === 'Literal' ? argument.value : null,
        atLoad: !inFunction,
      });
    }
    Object.keys(node).forEach((key) => {
      const value = node[key];
      if (Array.isArray(value)) value.forEach((child) => visit(child, inFunction));
      else if (value && typeof value.type === 'string') visit(value, inFunction);
    });
  }(ast, false));
  return calls;
}

/** Strongly connected components of more than one module, or of one that requires itself. */
function cycles(graph) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indexOf = new Map();
  const lowOf = new Map();
  const found = [];
  function connect(node) {
    indexOf.set(node, index);
    lowOf.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    (graph.get(node) || new Set()).forEach((next) => {
      if (!indexOf.has(next)) {
        connect(next);
        lowOf.set(node, Math.min(lowOf.get(node), lowOf.get(next)));
      } else if (onStack.has(next)) {
        lowOf.set(node, Math.min(lowOf.get(node), indexOf.get(next)));
      }
    });
    if (lowOf.get(node) === indexOf.get(node)) {
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      if (component.length > 1 || (graph.get(node) || new Set()).has(node)) found.push(component);
    }
  }
  [...graph.keys()].forEach((node) => { if (!indexOf.has(node)) connect(node); });
  return found;
}

describe('module graph', () => {
  const files = sourceFiles();
  const callsByFile = new Map(files.map((file) => [file, requireCalls(file)]));
  const relative = (file) => path.relative(ROOT, file);

  it('reads the whole source tree, the loader included', () => {
    expect(files.length).to.be.greaterThan(300);
    const loaderCalls = callsByFile.get(LOADER);
    expect(loaderCalls, 'the loader is read').to.not.equal(undefined);
    expect(loaderCalls.some((call) => !call.atLoad), 'the loader\'s late require is seen as late').to.equal(true);
  });

  it('requires every module when its file loads, apart from the loader', () => {
    const late = [];
    callsByFile.forEach((calls, file) => {
      if (file === LOADER) return;
      calls.filter((call) => !call.atLoad)
        .forEach((call) => late.push(`${relative(file)}:${call.line} require(${JSON.stringify(call.specifier)})`));
    });
    expect(late, 'require it at the top of the file, or load it through lib/moduleLoader').to.deep.equal([]);
  });

  it('forms no import cycle', () => {
    const graph = new Map();
    callsByFile.forEach((calls, file) => {
      graph.set(file, new Set(calls
        .map((call) => (call.specifier ? resolveRelative(file, call.specifier) : null))
        .filter(Boolean)));
    });
    const edges = [...graph.values()].reduce((sum, targets) => sum + targets.size, 0);
    expect(edges, 'the graph has its edges').to.be.greaterThan(1000);
    const found = cycles(graph).map((component) => component.map(relative).sort().join(' <-> '));
    expect(found, 'a module reaching back into one that requires it').to.deep.equal([]);
  });
});
