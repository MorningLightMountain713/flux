// fleet: 4
/*
 * A transfer dated ahead of the network's clocks.
 *
 * One node's clock runs an hour ahead of the others'. The owner of a v9 app
 * with a content slot signs a sale at that node's time and submits it there:
 * the node takes it by its own clock. A peer that took it relays it into the
 * fleet. Every other node judges the sale against its own clock, finds it dated
 * an hour ahead, and refuses it at intake, so none of them holds a transfer
 * waiting for payment, and the owner's content update through one of them
 * applies on each of them. The node ahead takes nothing they relay: by its
 * clock every broadcast of theirs is an hour old.
 *
 * The relaying peer is a stub (index 1) whose only connection is node 0, which
 * relays on to node 3; the node ahead is node 2, whose own relays every other
 * node refuses at the envelope, by its clock. After the sale the stub relays a
 * message dated within every node's clock; node 0 and node 3 holding it shows
 * the relay reaches them, so the sale's absence is a refusal and not a silence.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { appOwnerKey } from '../framework/keys.js';
import { buyerKey, transferApp } from '../framework/transfer-helper.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { confirmOnChain } from '../framework/app-helper.js';
import { relayHeldMessage } from '../framework/app-delivery.js';
import {
  deployContentApp, manifestStanding, pushContentUpdate, registerCleartextV9App,
} from '../framework/content-helper.js';
import { pushBusybox } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { harnessNodeNow, harnessNow, setNodeClockSkew } from '../framework/harness-clock.js';
import { waitFor } from '../framework/wait.js';

const NODES = 4;
const STUB = 1;
const AHEAD = 2; // the node whose clock runs an hour ahead
const OTHERS = [0, 3];
const REAL = [0, 2, 3];
const CONVERGE_MS = 300000;
const HOUR_S = 3600;
const SLOT = { name: 'conf', destination: '/etc/app.conf', onUpdate: { action: 'restart' } };

describe('a transfer dated ahead', function () {
  let env;
  let image;
  let stub;
  let sale;
  const seller = appOwnerKey();
  const buyer = buyerKey();
  const name = `datedahead${Date.now()}`;
  const v1 = Buffer.from(`conf ${name} registered with\n`);
  const v2 = Buffer.from(`conf the owner of ${name} pushed while the sale was refused\n`);
  const url = (i) => env.clients[i].url;
  const clients = () => REAL.map((i) => env.clients[i]);

  function components(withSlot) {
    const mounts = { '/data': { source: 'data', destination: '/data' } };
    if (withSlot) {
      mounts[SLOT.destination] = {
        source: SLOT.name, destination: SLOT.destination, type: 'file', contentSlot: SLOT.name, onUpdate: SLOT.onUpdate,
      };
    }
    return {
      web: {
        name: 'web',
        description: 'a transfer dated ahead',
        image,
        cpu: 0.5,
        memory: 300,
        rootFsGb: 2,
        persistentStorage: { sizeGb: 1, mounts },
        ports: { http: { containerPort: 80, hostPort: withSlot ? 31256 : 31257 } },
      },
    };
  }
  const shape = () => ({ instances: 1, components: components(true) });

  const holds = async (index, hash) => (await env.clients[index].getTempMessages(hash)).data?.length > 0;
  const standingVersions = (indices) => Promise.all(indices.map(async (i) => (await manifestStanding(url(i), name)).standing?.version));

  before(async function () {
    this.timeout(1200000);
    env = await createTestEnv({
      hookCtx: this, nodes: NODES, stubPeers: [STUB], tickerAutostart: false, arcane: true, harnessClock: true,
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1, pricing: true });
    stub = env.stubPeerClients.get(STUB);
    expect(buyer.zelid, 'the fixture names two owners').to.not.equal(seller.zelid);
    await pushBusybox(name);
    image = `${REGISTRY_REPO_HOST}/${name}:v1`;

    const registration = await deployContentApp(url(0), {
      name, ...shape(), ownerKey: seller, contentSlots: [{ ...SLOT, bytes: v1 }],
    });
    expect(registration.status, `the registration is accepted: ${JSON.stringify(registration).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(registration.data, clients());
    await waitFor(async () => (await standingVersions(REAL)).every((v) => v === 1), {
      timeout: CONVERGE_MS, interval: 3000, label: 'every node stands on the registration\'s manifest',
    });
  });

  after(async function () {
    this.timeout(120000);
    await env?.teardown();
  });

  it('holds a sale signed an hour ahead only on the node whose clock is an hour ahead', async function () {
    this.timeout(CONVERGE_MS);
    await setNodeClockSkew(AHEAD, HOUR_S);
    const named = (await manifestStanding(url(AHEAD), name)).standing;
    const submitted = await transferApp(url(AHEAD), seller, { spec: { name } }, clients(), {
      sellerKey: seller,
      buyerKey: buyer,
      standsOn: { manifest: named.hash },
      v9: { ...shape(), timestamp: harnessNodeNow(AHEAD) },
      pay: false,
    });
    expect(submitted.status, `the node an hour ahead takes the sale: ${JSON.stringify(submitted).slice(0, 300)}`).to.equal('success');
    sale = submitted.appHash;
    expect(await holds(AHEAD, sale), 'the node an hour ahead holds the sale').to.equal(true);

    // dated within every node's clock: inside the node ahead's hour, and within
    // the allowance ahead of every other node's
    const canary = await registerCleartextV9App(url(AHEAD), {
      name: `${name}c`, ownerKey: seller, instances: 1, components: components(false), timestamp: harnessNow() + 3 * 60000,
    });
    expect(canary.status, `the node an hour ahead takes a message dated within every clock: ${JSON.stringify(canary).slice(0, 300)}`).to.equal('success');

    const relayedSale = await relayHeldMessage(stub, env.clients[AHEAD], sale);
    expect(relayedSale.sent, `the stub relays the sale to its peer: ${JSON.stringify(relayedSale)}`).to.be.at.least(1);
    const relayedCanary = await relayHeldMessage(stub, env.clients[AHEAD], canary.data);
    expect(relayedCanary.sent, `the stub relays the message after it: ${JSON.stringify(relayedCanary)}`).to.be.at.least(1);
    await waitFor(async () => (await Promise.all(OTHERS.map((i) => holds(i, canary.data)))).every(Boolean), {
      timeout: 60000, interval: 2000, label: 'every other node holds the message relayed after the sale',
    });
    for (const i of OTHERS) {
      expect(await holds(i, sale), `node ${i} refused the sale dated an hour ahead of its clock`).to.equal(false);
    }
  });

  it('applies the owner\'s content update on every node on the network\'s clock while that sale is held', async function () {
    this.timeout(CONVERGE_MS);
    const update = await pushContentUpdate(url(OTHERS[0]), { name, slots: [{ name: SLOT.name, bytes: v2 }], ownerKey: seller });
    expect(update.status, `the owner's content update is taken: ${JSON.stringify(update).slice(0, 300)}`).to.equal('success');
    await waitFor(async () => (await standingVersions(OTHERS)).every((v) => v === 2), {
      timeout: CONVERGE_MS, interval: 3000, label: 'every node on the network\'s clock stands on the owner\'s update',
    });
    expect(await holds(AHEAD, sale), 'the node an hour ahead still holds the sale').to.equal(true);
  });
});
