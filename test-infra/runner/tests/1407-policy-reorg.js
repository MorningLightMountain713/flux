// Policy, suite 7: the grant lives on the chain, not in the node.
//
// A reorg that replaces the grant's block takes the grant with it on every
// node (chainRollback removes the policy rows above the fork), a fresh
// registration is refused again, and a grant re-minted on the new branch
// opens it once more. What a node believes about policy is what the chain it
// follows says at the height it is at.
import {
  describe, it, before, after,
} from 'mocha';
import {
  bootPolicyFleet, register, expectAccepted, expectRefused,
} from '../framework/policy-suite.js';
import { mintDefinition, policyProcessed } from '../framework/policy-chain.js';
import { reorgChain, getState } from '../framework/daemon-control.js';
import { waitForBlockProcessed } from '../framework/wait.js';

describe('Policy: a grant a reorg removes from the chain is gone from every node', function () {
  let env;
  let grantHeight;

  before(async function () {
    this.timeout(600000);
    env = await bootPolicyFleet(this, { seedPolicyGrant: false });
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('granted on chain, mesh is accepted', async function () {
    this.timeout(300000);
    ({ height: grantHeight } = await mintDefinition({ features: ['mesh'] }));
    await policyProcessed(env.clients, grantHeight);
    expectAccepted(await register(env.clients[0], { mesh: true }), 'after the grant');
  });

  it('a reorg below the grant replaces its block: every node refuses mesh again', async function () {
    this.timeout(300000);
    const before = await getState();
    // the new branch forks under the grant's block and reaches the same tip height
    const reorg = await reorgChain({ forkHeight: grantHeight - 1, newHeight: before.currentHeight });
    // each node processes the new tip; the block at the grant's height on the
    // new branch carries no policy message
    await Promise.all(env.clients.map((c) => waitForBlockProcessed(c, (d) => d.height >= reorg.newTip.height, 120000)));
    for (const [i, client] of env.clients.entries()) {
      // eslint-disable-next-line no-await-in-loop
      expectRefused(await register(client, { mesh: true }), 'mesh', `node ${i} after the reorg`);
    }
  });

  it('re-minted on the new branch, the grant opens mesh again', async function () {
    this.timeout(300000);
    const { height } = await mintDefinition({ features: ['mesh'] });
    await policyProcessed(env.clients, height);
    expectAccepted(await register(env.clients[1], { mesh: true }), 'after the re-mint');
  });
});
