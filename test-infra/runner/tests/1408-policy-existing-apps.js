// Policy, suite 8: existing apps when a grant changes.
//
// An app registered plain, confirmed on chain. An update adding mesh is
// refused while ungranted and accepted once granted. Then the group closes:
// as the gate stands today, EVERY update of that app is refused — a renewal
// that only extends the ttl included — because assertSpecEntitled runs on
// every submission against the policy in force now. Whether a running app
// should keep the feature it was granted, be refused only a renewal, or be
// removed, is not decided; this suite pins what the code does until it is.
import {
  describe, it, before, after,
} from 'mocha';
import { expect } from 'chai';
import {
  bootPolicyFleet, register, update, expectAccepted, expectRefused,
} from '../framework/policy-suite.js';
import { mintDefinition, policyProcessed } from '../framework/policy-chain.js';
import { queueAppTx, advanceBlocks } from '../framework/daemon-control.js';
import { waitFor } from '../framework/wait.js';

describe('Policy: an existing app when the grant changes — as the gate stands today', function () {
  let env;
  let name;

  async function confirmed(hash, predicate, label) {
    await queueAppTx(hash);
    await advanceBlocks(3);
    await waitFor(async () => {
      const rows = await Promise.all(env.clients.map((c) => c.getAppSpecs(name).catch(() => null)));
      return rows.every((r) => r && r.status === 'success' && r.data && predicate(r.data));
    }, { timeout: 120000, interval: 3000, label });
  }

  before(async function () {
    this.timeout(600000);
    env = await bootPolicyFleet(this, { seedPolicyGrant: false });
    const reg = await register(env.clients[0]);
    expectAccepted(reg, 'the plain app');
    ({ name } = reg);
    await confirmed(reg.data, (spec) => spec.name === name, `global spec for ${name} on every node`);
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('an update that adds mesh is refused while ungranted', async function () {
    this.timeout(120000);
    expectRefused(await update(env.clients[0], { name, mesh: true }), 'mesh', 'update adding mesh, ungranted');
  });

  it('granted, the same update is accepted and the fleet converges on the new spec', async function () {
    this.timeout(300000);
    const { height } = await mintDefinition({ features: ['mesh'] });
    await policyProcessed(env.clients, height);
    const upd = await update(env.clients[0], { name, mesh: true });
    expectAccepted(upd, 'update adding mesh, granted');
    await confirmed(upd.data, (spec) => spec.network?.mesh === true, `mesh on ${name} on every node`);
  });

  it('the group closed: an update of the app is refused, a renewal that only extends the ttl included', async function () {
    this.timeout(300000);
    const { height } = await mintDefinition({ features: [] });
    await policyProcessed(env.clients, height);
    const before = (await env.clients[0].getAppSpecs(name)).data;
    expectRefused(await update(env.clients[0], { name, mesh: true, ttl: (before.ttl ?? 0) + 1000 }), 'mesh', 'renewal after the close');
    // and the app's registered spec is untouched by the refusal
    const after = (await env.clients[0].getAppSpecs(name)).data;
    expect(after.network?.mesh, 'the app keeps the spec it was granted').to.equal(true);
  });
});
