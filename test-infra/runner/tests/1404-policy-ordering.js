// Policy, suite 4: two definitions for one group in one block.
//
// The later position in the block wins on every node — the rule of
// 9b0498338 (2026-09-03), proved from the chain side — and a node restarted
// afterwards rebuilds the same answer from its stored rows, in chain order.
import {
  describe, it, before, after,
} from 'mocha';
import {
  bootPolicyFleet, register, expectAccepted, expectRefused,
} from '../framework/policy-suite.js';
import { mintPolicyBlock, definitionBytes, policyProcessed } from '../framework/policy-chain.js';
import { restartFluxos } from '../framework/container.js';
import { waitForNodeStatus } from '../framework/wait.js';

describe('Policy: two definitions in one block — the later position wins, live and after a restart', function () {
  let env;

  before(async function () {
    this.timeout(600000);
    env = await bootPolicyFleet(this, { seedPolicyGrant: false });
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('open then close in one block: closed on every node', async function () {
    this.timeout(300000);
    const { height } = await mintPolicyBlock([
      { bytes: definitionBytes({ features: ['mesh'] }) },
      { bytes: definitionBytes({ features: [] }) },
    ]);
    await policyProcessed(env.clients, height);
    for (const [i, client] of env.clients.entries()) {
      // eslint-disable-next-line no-await-in-loop
      expectRefused(await register(client, { mesh: true }), 'mesh', `node ${i} after open-then-close`);
    }
  });

  it('close then open in one block: open on every node', async function () {
    this.timeout(300000);
    const { height } = await mintPolicyBlock([
      { bytes: definitionBytes({ features: [] }) },
      { bytes: definitionBytes({ features: ['mesh'] }) },
    ]);
    await policyProcessed(env.clients, height);
    for (const [i, client] of env.clients.entries()) {
      // eslint-disable-next-line no-await-in-loop
      expectAccepted(await register(client, { mesh: true }), `node ${i} after close-then-open`);
    }
  });

  it('a node restarted afterwards rebuilds the same answer from its rows', async function () {
    this.timeout(400000);
    const client = env.clients[0];
    await restartFluxos(client.container);
    await waitForNodeStatus(client, (d) => d.confirmed === true, 120000);
    expectAccepted(await register(client, { mesh: true }), 'node 0 after its restart');
  });
});
