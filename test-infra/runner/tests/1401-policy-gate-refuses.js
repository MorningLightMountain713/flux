// Policy, suite 1: the entitlement gate on a chain that grants nothing.
//
// A fresh chain carries no policy message, so every gated feature is denied
// and a plain spec is not — the gate behaving as designed, pinned here
// because the content suites only ever meet it satisfied (the seeded grant of
// policy-helper.js) and a drift between the product's reading of the policy
// collection and that seed went unseen for four days (2026-09-03..07).
import {
  describe, it, before, after,
} from 'mocha';
import {
  bootPolicyFleet, register, expectAccepted, expectRefused,
} from '../framework/policy-suite.js';

describe('Policy: the entitlement gate on a chain that grants nothing', function () {
  let env;

  before(async function () {
    this.timeout(600000);
    env = await bootPolicyFleet(this, { seedPolicyGrant: false });
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('a plain encrypted v9 app is accepted on every node: no gated feature, no gate', async function () {
    this.timeout(180000);
    for (const [i, client] of env.clients.entries()) {
      // eslint-disable-next-line no-await-in-loop
      expectAccepted(await register(client), `plain app at node ${i}`);
    }
  });

  it('an app using mesh is refused on every node, and the refusal names the feature', async function () {
    this.timeout(180000);
    for (const [i, client] of env.clients.entries()) {
      // eslint-disable-next-line no-await-in-loop
      expectRefused(await register(client, { mesh: true }), 'mesh', `mesh app at node ${i}`);
    }
  });
});
