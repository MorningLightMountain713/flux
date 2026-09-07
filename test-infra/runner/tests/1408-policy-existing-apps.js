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

describe('Policy: an existing app when the grant changes — as the gate stands today', function () {
  let env;
  let name;

  // The spec is sealed (registerEncryptedV9App), so nothing a node serves at
  // /apps/appspecifications says what an update changed; the node's own store
  // event names the hash it wrote, and that is the update landing on it.
  async function confirmed(hash, label) {
    const markers = env.clients.map((c) => c.getLastEventId());
    await queueAppTx(hash);
    await advanceBlocks(3);
    await Promise.all(env.clients.map((c, i) => c.waitForEvent(
      'app:specStored', (d) => d.name === name && d.hash === hash, 120000, { afterId: markers[i] },
    ).catch((err) => { throw new Error(`${label}: ${err.message}`); })));
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
    await confirmed(upd.data, `the mesh update stored on every node`);
  });

  it('the group closed: an update of the app is refused, a renewal that only extends the ttl included', async function () {
    this.timeout(300000);
    const { height } = await mintDefinition({ features: [] });
    await policyProcessed(env.clients, height);
    const before = (await env.clients[0].getAppSpecs(name)).data;
    expectRefused(await update(env.clients[0], { name, mesh: true, ttl: (before.ttl ?? 0) + 1000 }), 'mesh', 'renewal after the close');
    // and the refusal left the registered spec exactly as it was — this
    // test's own claim, not a restatement of the previous test's (which
    // put mesh on the spec; if that failed, this line must not fail for it)
    const after = (await env.clients[0].getAppSpecs(name)).data;
    expect(after, 'the refused renewal changed the registered spec').to.deep.equal(before);
  });
});
