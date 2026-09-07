// Policy, suite 6: who may speak.
//
// A definition is ingested only from the configured message authority, and
// only from an input that signs all outputs. A stranger's definition and an
// authority input whose signature does not cover every output both grant
// nothing; the real thing does.
import {
  describe, it, before, after,
} from 'mocha';
import {
  bootPolicyFleet, register, expectAccepted, expectRefused,
} from '../framework/policy-suite.js';
import { mintDefinition, policyProcessed, STRANGER } from '../framework/policy-chain.js';

describe('Policy: a definition counts only from the authority, signed over every output', function () {
  let env;

  before(async function () {
    this.timeout(600000);
    env = await bootPolicyFleet(this, { seedPolicyGrant: false });
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('a definition from a stranger grants nothing', async function () {
    this.timeout(300000);
    const { height } = await mintDefinition({ features: ['mesh'], sender: STRANGER });
    await policyProcessed(env.clients, height);
    expectRefused(await register(env.clients[0], { mesh: true }), 'mesh', 'after a stranger\'s definition');
  });

  it('a definition from the authority whose input does not sign all outputs grants nothing', async function () {
    this.timeout(300000);
    const { height } = await mintDefinition({ features: ['mesh'], signsAllOutputs: false });
    await policyProcessed(env.clients, height);
    expectRefused(await register(env.clients[1], { mesh: true }), 'mesh', 'after an authority definition not signed over every output');
  });

  it('a definition from the authority, signed over every output, grants', async function () {
    this.timeout(300000);
    const { height } = await mintDefinition({ features: ['mesh'] });
    await policyProcessed(env.clients, height);
    expectAccepted(await register(env.clients[2], { mesh: true }), 'after the real definition');
  });
});
