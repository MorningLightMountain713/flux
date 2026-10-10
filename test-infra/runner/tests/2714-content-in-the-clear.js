// fleet: 3
/*
 * Content in the clear is refused by every node.
 *
 * A v9 spec carrying a content slot travels sealed; the submission door seals
 * it. A node that skipped the door's rules could still gossip the spec in the
 * clear, so the rule is held where every node judges a message: a paid v9
 * registration carrying content in the clear, handed to every node, is
 * refused by each, naming the content in the clear, and no node lists the app.
 * The same app sealed is accepted through the door, so the refusal is about
 * the clear content and nothing else.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { appOwnerKey } from '../framework/keys.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { confirmOnChain } from '../framework/app-helper.js';
import { deliverAppMessage } from '../framework/app-delivery.js';
import { deployContentApp } from '../framework/content-helper.js';
import { buildCleartextV9Message, buildV9ContentSpec } from '../framework/content-crypto-v9.js';
import { pushImage } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { appView } from '../framework/app-view.js';

const NODES = 3;
const CONVERGE_MS = 240000;
const SLOT = 'cfg';
const SLOT_PATH = '/etc/app.conf';
const IN_THE_CLEAR = /clear|content.*sealed|contentSlot/i;

describe('content in the clear is refused by every node', function () {
  let env;
  const owner = appOwnerKey();
  const clear = `clear${Date.now()}`;
  const sealed = `sealed${Date.now()}`;

  const slotSpec = (name) => ({
    name,
    image: `${REGISTRY_REPO_HOST}/${name}:v1`,
    instances: 1,
    contentSlots: [{
      name: SLOT, destination: SLOT_PATH, onUpdate: null, atomic: true,
    }],
  });

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this, nodes: NODES, tickerAutostart: false, arcane: true,
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1, pricing: true });
    await pushImage(clear, 'v1');
    await pushImage(sealed, 'v1');
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('refuses on every node a paid registration carrying a content slot in the clear', async function () {
    this.timeout(600000);
    const message = await buildCleartextV9Message({
      submissionSpec: buildV9ContentSpec({ ...slotSpec(clear), owner: owner.zelid }),
      ownerKey: owner,
    });
    const refusals = [];
    for (const i of [0, 1, 2]) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await deliverAppMessage(env, message, [i], { timeout: 120000 });
        refusals.push(null);
      } catch (error) {
        refusals.push(error.message);
      }
    }
    refusals.forEach((reason, i) => {
      expect(reason, `node ${i} refuses the message`).to.be.a('string');
      expect(reason, `node ${i} names the content in the clear`).to.match(IN_THE_CLEAR);
    });
    const view = appView(env, clear);
    for (const i of [0, 1, 2]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await view.listedOn(i), `node ${i} lists no such app`).to.equal(null);
    }
  });

  it('accepts the same app sealed through the door', async function () {
    this.timeout(600000);
    const res = await deployContentApp(env.clients[0].url, {
      ...slotSpec(sealed),
      contentSlots: [{
        name: SLOT, destination: SLOT_PATH, bytes: Buffer.from('sealed\n'), onUpdate: null, atomic: true,
      }],
    });
    expect(res.status, `the sealed registration: ${JSON.stringify(res).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(res.data, env.clients);
    await appView(env, sealed, { timeout: CONVERGE_MS }).listedEverywhere(res.data, [0, 1, 2], 'every node lists the sealed app');
  });
});
