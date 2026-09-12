// Who may hand syncthingService an express object, read from the sources.
//
// syncthingService serves two callers: routes, which carry a request and a
// response, and the reconciler, the monitor and the events consumer, which
// carry neither. When one function served both, it decided what to do by
// whether a `res` was passed - and removing that switch turned every internal
// call into `res.json` on null. The suite could not see it: each of those
// callers wraps the call in a try/catch and logs, so the node stayed up and
// the behaviour simply stopped happening. It took a fleet to notice.
//
// So the separation is asserted statically, over the real source. The Api half
// owns req and res; the internal half takes plain arguments and knows nothing
// about express. Anything this cannot classify is a failure, not a skip.
//
// The second separation is the RETURN contract. Functions built on `request`
// answer rows and throw; functions built on `performRequest` answer an envelope
// and never reject. Nothing at a call site distinguishes them, so a caller that
// reads the wrong one compiles and passes its suite while treating every
// failure as a success: a `.catch()` on an envelope function is dead code, and
// a bare `await` on one discards the answer. Both are static properties of the
// source, so both are asserted here.

const fs = require('node:fs');
const nodePath = require('node:path');
const { execFileSync } = require('node:child_process');

const { expect } = require('chai');
const espree = require('espree');

const ROOT = nodePath.join(__dirname, '../..');
const SERVICE = 'ZelBack/src/services/syncthingService.js';
const ROUTES = 'ZelBack/src/routes.js';

const parse = (src) => espree.parse(src, {
  ecmaVersion: 2022, sourceType: 'script', loc: true, range: true,
});

function walk(node, visit, enclosing = null, parents = []) {
  if (!node || typeof node.type !== 'string') return;
  const next = node.type === 'FunctionDeclaration' && node.id ? node.id.name : enclosing;
  visit(node, enclosing, parents);
  const chain = [node, ...parents];
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range') continue;
    const value = node[key];
    if (Array.isArray(value)) value.forEach((c) => walk(c, visit, next, chain));
    else if (value && typeof value.type === 'string') walk(value, visit, next, chain);
  }
}

const sourceFiles = () => execFileSync('git', ['-C', ROOT, 'ls-files', 'ZelBack/src'], { encoding: 'utf8' })
  .split('\n').filter((f) => f.endsWith('.js'));

// name -> declared parameter names, for every top-level function in the service
function serviceFunctions() {
  const src = fs.readFileSync(nodePath.join(ROOT, SERVICE), 'utf8');
  const params = new Map();
  for (const node of parse(src).body) {
    if (node.type === 'FunctionDeclaration' && node.id) {
      params.set(node.id.name, node.params.map((p) => (p.type === 'Identifier' ? p.name : `<${p.type}>`)));
    }
  }
  return params;
}

// every syncthingService.<name>( call outside the service itself, with its file
function externalCalls() {
  const calls = [];
  for (const rel of sourceFiles()) {
    if (rel === SERVICE) continue;
    const src = fs.readFileSync(nodePath.join(ROOT, rel), 'utf8');
    if (!src.includes('syncthingService')) continue;
    // the local identifier(s) the module was required under - it is reached
    // through a dynamic require in several files, to break a cycle
    const aliases = new Set([...src.matchAll(/(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=\s*require\([^)]*syncthingService[^)]*\)/g)]
      .map((m) => m[1]));
    if (!aliases.size) continue;
    walk(parse(src), (node, _enclosing, parents) => {
      if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return;
      const { object, property } = node.callee;
      if (object.type !== 'Identifier' || !aliases.has(object.name)) return;
      // the nearest enclosing function, which is as far as a binding can be read
      const fnBody = parents.find((p) => /Function(Declaration|Expression)|ArrowFunctionExpression/.test(p.type));
      calls.push({
        name: property.name,
        where: `${rel}:${node.loc.start.line}`,
        rel,
        how: consumption(node, parents, src),
        reads: propertiesRead(node, parents, fnBody),
      });
    });
  }
  return calls;
}

// The contract a service function answers on, from what it RETURNS - not from
// what it calls. A function that consumes performRequest internally and answers
// its own object (getPeerSyncDiagnostics) throws like any other function, and
// classifying it by the call would make a live catch on it read as dead.
//
// ENVELOPE: a {status, data} value, from performRequest or a messageHelper
// constructor. THROWS: the rows, from `request`. VALUE: anything else - such a
// function has neither contract to get wrong.
function serviceContracts() {
  const src = fs.readFileSync(nodePath.join(ROOT, SERVICE), 'utf8');
  const fns = new Map();
  for (const node of parse(src).body) {
    if (node.type === 'FunctionDeclaration' && node.id) fns.set(node.id.name, node);
  }

  // the returned expressions of one function, skipping any nested function
  const returnsOf = (fn) => {
    const found = [];
    const descend = (node) => {
      if (!node || typeof node.type !== 'string') return;
      if (node !== fn && /Function(Declaration|Expression)|ArrowFunctionExpression/.test(node.type)) return;
      if (node.type === 'ReturnStatement' && node.argument) found.push(node.argument);
      for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'range') continue;
        const value = node[key];
        if (Array.isArray(value)) value.forEach(descend);
        else if (value && typeof value.type === 'string') descend(value);
      }
    };
    descend(fn);
    return found;
  };

  // what an expression evaluates to, following `const x = <expr>` one step and
  // delegation to a sibling any number of steps
  const kindOf = (expr, fn, seen) => {
    if (!expr) return null;
    if (expr.type === 'AwaitExpression') return kindOf(expr.argument, fn, seen);
    if (expr.type === 'CallExpression') {
      const { callee } = expr;
      if (callee.type === 'Identifier') {
        if (callee.name === 'performRequest') return 'ENVELOPE';
        if (callee.name === 'request') return 'THROWS';
        if (fns.has(callee.name)) return resolve(callee.name, seen); // eslint-disable-line no-use-before-define
      }
      if (callee.type === 'MemberExpression' && /^create(Data|Error|Success|Warning)Message$/.test(callee.property.name)) return 'ENVELOPE';
      if (callee.type === 'MemberExpression' && callee.property.name === 'errUnauthorizedMessage') return 'ENVELOPE';
      return null;
    }
    if (expr.type === 'Identifier') {
      // the binding it was last assigned from, within this function
      let assigned = null;
      const descend = (node) => {
        if (!node || typeof node.type !== 'string') return;
        if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === expr.name) assigned = node.init;
        if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier' && node.left.name === expr.name) assigned = node.right;
        for (const key of Object.keys(node)) {
          if (key === 'loc' || key === 'range') continue;
          const value = node[key];
          if (Array.isArray(value)) value.forEach(descend);
          else if (value && typeof value.type === 'string') descend(value);
        }
      };
      descend(fn);
      return assigned ? kindOf(assigned, fn, seen) : null;
    }
    return null;
  };

  function resolve(name, seen = new Set()) {
    if (!fns.has(name) || seen.has(name)) return null;
    seen.add(name);
    const fn = fns.get(name);
    const kinds = new Set(returnsOf(fn).map((expr) => kindOf(expr, fn, seen)).filter(Boolean));
    // a function with even one envelope return can hand a caller one
    if (kinds.has('ENVELOPE')) return 'ENVELOPE';
    if (kinds.has('THROWS')) return 'THROWS';
    return null;
  }

  const contracts = new Map();
  for (const name of fns.keys()) contracts.set(name, resolve(name) || 'VALUE');
  return contracts;
}

// How a call site consumes what it gets back. A `.catch()` and a discarded
// `await` are the two readings that treat an envelope as a throw.
// The properties a call's answer is read through, when it is bound to a name.
// Null when it is not bound - an adapter argument, or a value passed straight on.
function propertiesRead(node, parents, fnBody) {
  const [p1, p2] = parents;
  const binding = p1 && p1.type === 'AwaitExpression' && p2 && p2.type === 'VariableDeclarator'
    && p2.id.type === 'Identifier' ? p2.id.name : null;
  if (!binding || !fnBody) return null;
  const props = new Set();
  const descend = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'MemberExpression' && n.object.type === 'Identifier' && n.object.name === binding) {
      props.add(n.property.name || '<computed>');
    }
    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'range') continue;
      const value = n[key];
      if (Array.isArray(value)) value.forEach(descend);
      else if (value && typeof value.type === 'string') descend(value);
    }
  };
  descend(fnBody);
  return [...props];
}

function consumption(node, parents, src) {
  const [p1, p2, p3] = parents;
  const isDataOrThrow = (call) => call && call.type === 'CallExpression'
    && /dataOrThrow/.test(src.slice(call.callee.range[0], call.callee.range[1]));
  const settles = (m, call) => m && m.type === 'MemberExpression'
    && ['catch', 'then'].includes(m.property.name) && call && call.type === 'CallExpression';
  if (settles(p1, p2) && p1.object === node) return `.${p1.property.name}()`;
  if (isDataOrThrow(p1)) return 'dataOrThrow';
  if (p1 && p1.type === 'AwaitExpression') {
    if (p2 && p2.type === 'ExpressionStatement') return 'discarded';
    if (isDataOrThrow(p2)) return 'dataOrThrow';
    if (settles(p2, p3)) return `.${p2.property.name}()`;
  }
  return 'read';
}

// calls made inside the service to one of its own functions, with the function
// that makes them - this is where the last one hid
function internalCalls(params) {
  const src = fs.readFileSync(nodePath.join(ROOT, SERVICE), 'utf8');
  const calls = [];
  walk(parse(src), (node, enclosing) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') return;
    if (!params.has(node.callee.name)) return;
    calls.push({ name: node.callee.name, from: enclosing, line: node.loc.start.line });
  });
  return calls;
}

describe('syncthing call shape', () => {
  const params = serviceFunctions();
  const external = externalCalls();
  const internal = internalCalls(params);
  const contracts = serviceContracts();
  // routes.js speaks the wire: an envelope is exactly what it forwards.
  const internalSites = external.filter((c) => c.rel !== ROUTES);

  // a sweep that resolves nothing passes every assertion below it, so name the
  // callers this exists to police and fail if any of them went unseen
  it('reaches the router and every internal caller', () => {
    expect(params.size, 'functions in syncthingService').to.be.greaterThan(50);
    const files = [...new Set(external.map((c) => c.rel))];
    for (const caller of [
      ROUTES,
      'ZelBack/src/services/appMonitoring/syncthingFolderStateMachine.js',
      'ZelBack/src/services/appMonitoring/syncthingEventsConsumer.js',
      'ZelBack/src/services/appMonitoring/syncthingMonitor.js',
      'ZelBack/src/services/appMonitoring/peerFolderLiveness.js',
      'ZelBack/src/services/appLifecycle/appOperations.js',
      'ZelBack/src/services/systemService.js',
      'ZelBack/src/services/fluxService.js',
    ]) {
      expect(files, `the sweep never reached ${caller}`).to.include(caller);
    }
  });

  it('every call site names a function that exists', () => {
    const unknown = external.filter((c) => !params.has(c.name)).map((c) => `${c.where} -> ${c.name}`);
    expect(unknown, 'call sites this sweep could not resolve').to.deep.equal([]);
  });

  it('only routes.js calls an Api handler', () => {
    const stray = external
      .filter((c) => c.name.endsWith('Api') && c.rel !== ROUTES)
      .map((c) => `${c.where} -> ${c.name}`);
    expect(stray, 'an Api handler is the wire, and only the router speaks it').to.deep.equal([]);
  });

  it('nothing but routes.js hands syncthingService an express object', () => {
    const offenders = external
      .filter((c) => c.rel !== ROUTES)
      .filter((c) => (params.get(c.name) || []).some((p) => p === 'req' || p === 'res'))
      .map((c) => `${c.where} -> ${c.name}(${params.get(c.name).join(', ')})`);
    expect(offenders, 'an internal caller has no request and no response to give').to.deep.equal([]);
  });

  it('classifies every function by what it returns', () => {
    const unresolved = [...contracts.entries()].filter(([, c]) => !c).map(([name]) => name);
    expect(unresolved, 'a function this sweep cannot classify is a failure, not a skip').to.deep.equal([]);
    // a classifier that answered one thing for everything would pass the
    // assertions below by default, so pin one of each - including the function
    // that CALLS performRequest and returns its own object, which throws
    expect(contracts.get('adjustConfigFolders'), 'through its collection helper').to.equal('ENVELOPE');
    expect(contracts.get('getConfigRestartRequired')).to.equal('ENVELOPE');
    expect(contracts.get('getConfigFolders')).to.equal('THROWS');
    expect(contracts.get('getPeerSyncDiagnostics'), 'consumes performRequest, answers its own object').to.equal('VALUE');
    expect(contracts.get('getDeviceId'), 'answers a device id or null').to.equal('VALUE');
  });

  // A `.catch()` on a function that never rejects never runs. The failure it
  // was written to report is discarded and the caller continues as though the
  // call had succeeded.
  it('nothing catches a function that cannot reject', () => {
    const dead = internalSites
      .filter((c) => contracts.get(c.name) === 'ENVELOPE' && c.how.startsWith('.catch'))
      .map((c) => `${c.where} -> ${c.name}().catch() is dead code; read response.status or messageHelper.dataOrThrow`);
    expect(dead, 'an envelope-returning call answers in-band').to.deep.equal([]);
  });

  // A bare `await` on one throws the answer away, so a refused write is
  // indistinguishable from an applied one.
  it('nothing discards the answer of a function that reports in-band', () => {
    const discarded = internalSites
      .filter((c) => contracts.get(c.name) === 'ENVELOPE' && c.how === 'discarded')
      .map((c) => `${c.where} -> ${c.name}() answers {status, data} and the answer is discarded`);
    expect(discarded, 'the only report of a failure is the value').to.deep.equal([]);
  });

  // The third reading, and the one that survives both rules above: the value is
  // taken and its SHAPE is tested. An error envelope has no rows on it, so
  // `!answer.data` or a missing field reads as "empty" rather than "failed", and
  // the caller acts on an absence that is really a failure.
  it('nothing tests the shape of an answer without testing its status', () => {
    const shapeOnly = internalSites
      .filter((c) => contracts.get(c.name) === 'ENVELOPE' && c.how === 'read' && c.reads && !c.reads.includes('status'))
      .map((c) => `${c.where} -> ${c.name}() is read as ${c.reads.map((r) => `.${r}`).join(', ')} and never .status`);
    expect(shapeOnly, 'an error envelope carries no rows, so shape cannot tell failure from empty').to.deep.equal([]);
  });

  // The sweep resolves nothing if `how` never populates, which would pass both
  // assertions above silently.
  it('reads how each internal call site consumes its answer', () => {
    const envelopeSites = internalSites.filter((c) => contracts.get(c.name) === 'ENVELOPE');
    expect(envelopeSites.length, 'envelope-returning calls outside the router').to.be.greaterThan(10);
    expect(envelopeSites.every((c) => ['read', 'dataOrThrow'].includes(c.how)), 'every one is read').to.be.true;
    const viaDataOrThrow = envelopeSites.filter((c) => c.how === 'dataOrThrow');
    expect(viaDataOrThrow.length, 'and the adapter is in use, so that branch is reached').to.be.greaterThan(0);
  });

  it('inside the service, only an Api handler calls a function that takes req or res', () => {
    const offenders = internal
      .filter((c) => !(c.from || '').endsWith('Api'))
      .filter((c) => (params.get(c.name) || []).some((p) => p === 'req' || p === 'res'))
      .map((c) => `${SERVICE}:${c.line} ${c.from} -> ${c.name}(${params.get(c.name).join(', ')})`);
    expect(offenders, 'a non-Api caller has no express objects to pass on').to.deep.equal([]);
  });
});
