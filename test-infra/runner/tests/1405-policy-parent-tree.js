// Policy, suite 5: the feature parent tree.
//
// networkSharing (bit 17) is a strict child of appRelationships (bit 24): the
// encoder refuses a grant of the child alone, and the gate refuses a spec
// using the child until the parent is granted too. The spec that uses both is
// a dependency edge with network:true, the shareWith fold.
import {
  describe, it, before, after,
} from 'mocha';
import { expect } from 'chai';
import {
  bootPolicyFleet, register, expectAccepted, expectRefused,
} from '../framework/policy-suite.js';
import { mintDefinition, definitionBytes, policyProcessed } from '../framework/policy-chain.js';

describe('Policy: a child feature needs its parent granted', function () {
  let env;
  let target;

  before(async function () {
    this.timeout(600000);
    env = await bootPolicyFleet(this, { seedPolicyGrant: false });
    // the edge needs something to point at: a plain app, no gate applies
    const reg = await register(env.clients[0]);
    expectAccepted(reg, 'the dependency target');
    target = reg.name;
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  const edge = () => ({ [target]: { strength: 'requires', network: true } });

  it('the encoder refuses a definition granting the child without its parent', function () {
    expect(() => definitionBytes({ features: ['networkSharing'] })).to.throw();
    expect(() => definitionBytes({ features: ['appRelationships', 'networkSharing'] })).to.not.throw();
  });

  it('with nothing granted, an edge with network:true is refused naming the parent', async function () {
    this.timeout(120000);
    expectRefused(await register(env.clients[0], { dependencies: edge() }), 'appRelationships', 'nothing granted');
  });

  it('with the parent alone granted, the edge is refused naming the child', async function () {
    this.timeout(300000);
    const { height } = await mintDefinition({ features: ['appRelationships'] });
    await policyProcessed(env.clients, height);
    expectRefused(await register(env.clients[1], { dependencies: edge() }), 'networkSharing', 'parent alone');
  });

  it('with parent and child granted, the edge is accepted', async function () {
    this.timeout(300000);
    const { height } = await mintDefinition({ features: ['appRelationships', 'networkSharing'] });
    await policyProcessed(env.clients, height);
    expectAccepted(await register(env.clients[2], { dependencies: edge() }), 'parent and child');
  });
});
