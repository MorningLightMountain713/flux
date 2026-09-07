// Policy, suite 3: membership.
//
// A group other than the default carries the bit; a membership message puts
// one fluxid in it. That owner registers, another owner is refused; removed
// from the group, the owner is refused again. The customer-facing model.
import {
  describe, it, before, after,
} from 'mocha';
import {
  bootPolicyFleet, register, expectAccepted, expectRefused,
} from '../framework/policy-suite.js';
import { mintDefinition, mintMembership, policyProcessed } from '../framework/policy-chain.js';
import { appOwnerKey, userKey } from '../framework/keys.js';

const GROUP = 5;

describe('Policy: membership of a group that carries the bit', function () {
  let env;

  before(async function () {
    this.timeout(600000);
    env = await bootPolicyFleet(this, { seedPolicyGrant: false });
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('a group with mesh and no members grants nobody', async function () {
    this.timeout(300000);
    const { height } = await mintDefinition({ groupId: GROUP, features: ['mesh'] });
    await policyProcessed(env.clients, height);
    expectRefused(await register(env.clients[0], { mesh: true, ownerKey: appOwnerKey() }), 'mesh', 'owner, not yet a member');
  });

  it('the member registers on every node; another owner is refused', async function () {
    this.timeout(300000);
    const { height } = await mintMembership({ groupId: GROUP, fluxids: [appOwnerKey().zelid] });
    await policyProcessed(env.clients, height);
    for (const [i, client] of env.clients.entries()) {
      // eslint-disable-next-line no-await-in-loop
      expectAccepted(await register(client, { mesh: true, ownerKey: appOwnerKey() }), `member at node ${i}`);
    }
    expectRefused(await register(env.clients[1], { mesh: true, ownerKey: userKey() }), 'mesh', 'another owner');
  });

  it('removed from the group, the owner is refused again', async function () {
    this.timeout(300000);
    const { height } = await mintMembership({ groupId: GROUP, fluxids: [appOwnerKey().zelid], action: 'delete' });
    await policyProcessed(env.clients, height);
    expectRefused(await register(env.clients[2], { mesh: true, ownerKey: appOwnerKey() }), 'mesh', 'owner after removal');
  });
});
