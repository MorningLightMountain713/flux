// Policy, suite 2: a grant arrives on chain and takes effect.
//
// A group-0 definition in an OP_RETURN from the message authority, in a block
// the daemon stub serves, ingested by each node's own explorer: the refused
// registration succeeds on every node without a restart. A second definition
// that closes the group refuses again — the latest message wins. The path
// mainnet takes, not the DB inject the content suites use as a precondition.
import {
  describe, it, before, after,
} from 'mocha';
import {
  bootPolicyFleet, register, expectAccepted, expectRefused,
} from '../framework/policy-suite.js';
import { mintDefinition, policyProcessed } from '../framework/policy-chain.js';

describe('Policy: a grant on chain opens a feature on every node, and the latest message wins', function () {
  let env;

  before(async function () {
    this.timeout(600000);
    env = await bootPolicyFleet(this, { seedPolicyGrant: false });
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('before any grant, mesh is refused', async function () {
    this.timeout(120000);
    expectRefused(await register(env.clients[0], { mesh: true }), 'mesh', 'before the grant');
  });

  it('a group-0 definition opening mesh is ingested by every node, and mesh is accepted everywhere without a restart', async function () {
    this.timeout(300000);
    const { height } = await mintDefinition({ features: ['mesh'] });
    await policyProcessed(env.clients, height);
    for (const [i, client] of env.clients.entries()) {
      // eslint-disable-next-line no-await-in-loop
      expectAccepted(await register(client, { mesh: true }), `mesh app at node ${i} after the grant`);
    }
  });

  it('a later definition that closes the group refuses mesh again on every node', async function () {
    this.timeout(300000);
    const { height } = await mintDefinition({ features: [] });
    await policyProcessed(env.clients, height);
    for (const [i, client] of env.clients.entries()) {
      // eslint-disable-next-line no-await-in-loop
      expectRefused(await register(client, { mesh: true }), 'mesh', `mesh app at node ${i} after the close`);
    }
  });
});
