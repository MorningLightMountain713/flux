// The fleet declaration is what run-parallel.sh admits suites by, so a wrong
// reading here admits six 16-node fleets as if they were 10-node ones. These
// pin the parse of the declaration and the derivation that keeps it honest.
// `npm run test:unit`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { declaredFleet, derivedFleet, checkFleetDeclaration } from '../framework/fleet-size.js';

const suite = (lines) => lines.join('\n');

describe('declaredFleet', () => {
  it('reads the one line', () => {
    assert.equal(declaredFleet(suite(['// fleet: 16', 'import x from "y";'])), 16);
  });
  it('is null when the line is absent', () => {
    assert.equal(declaredFleet(suite(['// weight: heavy', 'import x from "y";'])), null);
  });
  it('refuses two lines rather than picking one', () => {
    assert.throws(() => declaredFleet(suite(['// fleet: 3', '// fleet: 10'])), /more than one/);
  });
  it('refuses a value that is not a whole number', () => {
    assert.throws(() => declaredFleet('// fleet: ten'), /not a whole number/);
    assert.throws(() => declaredFleet('// fleet: 1.5'), /not a whole number/);
  });
  it('does not read a fleet word inside prose', () => {
    assert.equal(declaredFleet('// the fleet: 16 nodes the suite boots'), null);
  });
});

describe('derivedFleet', () => {
  it('reads a literal', () => {
    const r = derivedFleet('env = await createTestEnv({ hookCtx: this, nodes: 10, tickerAutostart: false });');
    assert.deepEqual(r, { peak: 10, envs: 1, unresolved: [] });
  });
  it('adds the deferred nodes that join later', () => {
    const r = derivedFleet('createTestEnv({ hookCtx: this, nodes: 12, deferredNodes: 2 })');
    assert.equal(r.peak, 14);
  });
  it('resolves a file constant and a constant plus a literal', () => {
    const r = derivedFleet(suite([
      'const REAL_NODES = 5;',
      'createTestEnv({',
      '  hookCtx: this,',
      '  nodes: REAL_NODES + 1,',
      '})',
    ]));
    assert.equal(r.peak, 6);
  });
  it('reads the length of a one-line literal array as a term', () => {
    const r = derivedFleet(suite([
      'const REAL_NODES = 10;',
      'const STUB_INDICES = [10, 11, 12, 13];',
      'const NONE = [];',
      'createTestEnv({ nodes: REAL_NODES + STUB_INDICES.length + NONE.length })',
    ]));
    assert.equal(r.peak, 14);
  });
  it('is the largest single env, not the sum, across several', () => {
    const r = derivedFleet(suite([
      'createTestEnv({ nodes: 3 })',
      'createTestEnv({ nodes: 10 })',
      'createTestEnv({ nodes: 5, deferredNodes: 1 })',
    ]));
    assert.equal(r.peak, 10);
    assert.equal(r.envs, 3);
  });
  it('defaults nodes to one, as createTestEnv does', () => {
    assert.equal(derivedFleet('createTestEnv({ hookCtx: this })').peak, 1);
  });
  it('reports an expression it cannot read instead of guessing', () => {
    const r = derivedFleet('createTestEnv({ nodes: opts.nodes })');
    assert.equal(r.peak, null);
    assert.deepEqual(r.unresolved, ['opts.nodes']);
  });
  it('derives nothing for a suite that boots through a helper', () => {
    const r = derivedFleet('env = await bootPolicyFleet(this, { seedPolicyGrant: false });');
    assert.deepEqual(r, { peak: null, envs: 0, unresolved: [] });
  });
  it('ignores a nodes field that is not an env argument', () => {
    const r = derivedFleet('const spec = { nodes: [] }; createTestEnv({ nodes: 3 })');
    assert.equal(r.peak, 3);
  });
});

describe('checkFleetDeclaration', () => {
  it('passes a declaration equal to the derived peak', () => {
    const v = checkFleetDeclaration(suite(['// fleet: 10', 'createTestEnv({ nodes: 10 })']));
    assert.equal(v.ok, true);
  });
  it('passes a declaration above the derived peak: a helper may boot more', () => {
    assert.equal(checkFleetDeclaration(suite(['// fleet: 12', 'createTestEnv({ nodes: 10 })'])).ok, true);
  });
  it('fails a declaration below what the suite boots', () => {
    const v = checkFleetDeclaration(suite(['// fleet: 10', 'createTestEnv({ nodes: 16 })']));
    assert.equal(v.ok, false);
    assert.match(v.reasons[0], /declares 10 but .* reach 16/);
  });
  it('fails a missing declaration', () => {
    const v = checkFleetDeclaration('createTestEnv({ nodes: 3 })');
    assert.equal(v.ok, false);
    assert.match(v.reasons[0], /no "\/\/ fleet: N" line/);
  });
  it('fails an expression the derivation cannot read, so it is made readable', () => {
    const v = checkFleetDeclaration(suite(['// fleet: 10', 'createTestEnv({ nodes: computeNodes() })']));
    assert.equal(v.ok, false);
    assert.match(v.reasons[0], /not readable/);
  });
  it('holds a helper-booted suite to its declaration alone', () => {
    assert.equal(checkFleetDeclaration(suite(['// fleet: 3', 'bootPolicyFleet(this)'])).ok, true);
  });
});
