// fleet: 6
/*
 * A transfer dated ahead of the network's clocks.
 *
 * One node's clock runs an hour ahead of the others'. The owner of a v9 app
 * with a content slot signs a sale at that node's time and submits it there.
 * The node takes it by its own clock and gossips it, and every node on the
 * network's clock refuses the gossip, an hour ahead of theirs. A peer that
 * took it relays it into the fleet: each node judges the sale against its own
 * clock, finds it dated an hour ahead, and refuses it at intake, so none of
 * them holds a transfer waiting for payment, and the owner's content update
 * through one of them applies on each of them.
 *
 * The relaying peer is a stub (index 5), connected to the node ahead (4) and
 * to node 3. The node ahead also takes, and the stub relays after the sale, a
 * message dated within every node's clock; every node on the network's clock
 * holding it shows the relay reaches them, so the sale's absence is a refusal
 * and not a silence.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { appOwnerKey } from '../framework/keys.js';
import { buyerKey, transferApp } from '../framework/transfer-helper.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { confirmOnChain } from '../framework/app-helper.js';
import {
  deployContentApp, manifestStanding, pushContentUpdate, registerCleartextV9App,
} from '../framework/content-helper.js';
import { pushBusybox } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { harnessNodeNow, harnessNow, setNodeClockSkew } from '../framework/harness-clock.js';
import { waitFor } from '../framework/wait.js';

const NODES = 6;
const STUB = 5;
const AHEAD = 4; // the node whose clock runs an hour ahead
const ON_TIME = [0, 1, 2, 3];
const REAL = [...ON_TIME, AHEAD];
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
  const canaryName = `${name}c`;
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

  // The hash of the app message of `type` for `app` the stub was gossiped.
  async function gossipedToStub(type, app, label) {
    let found = null;
    await waitFor(async () => {
      found = (await stub.appMessagesReceived()).find((m) => m.type === type && m.name === app);
      return Boolean(found);
    }, { timeout: 60000, interval: 1000, label });
    return found;
  }

  before(async function () {
    this.timeout(1200000);
    env = await createTestEnv({
      hookCtx: this, nodes: NODES, stubPeers: [STUB], tickerAutostart: false, arcane: true, harnessClock: true,
    });
    await bootAndPeer(env, { pricing: true });
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

  it('holds a sale signed an hour ahead on no node on the network\'s clock', async function () {
    this.timeout(CONVERGE_MS);
    await setNodeClockSkew(AHEAD, HOUR_S);
    const named = (await manifestStanding(url(AHEAD), name)).standing;
    const signedAt = harnessNodeNow(AHEAD);
    // The node ahead gossips the sale and then waits for a peer to hold it; none
    // on the network's clock takes its gossip, so it answers that it could not.
    await transferApp(url(AHEAD), seller, { spec: { name } }, clients(), {
      sellerKey: seller,
      buyerKey: buyer,
      standsOn: { manifest: named.hash },
      v9: { ...shape(), timestamp: signedAt },
      pay: false,
    });
    const gossiped = await gossipedToStub('fluxappupdate', name, 'the node ahead gossips the sale');
    sale = gossiped.hash;
    expect(gossiped.timestamp, 'the sale is signed at the node ahead\'s time').to.equal(signedAt);

    // dated within every node's clock: inside the node ahead's hour, and within
    // the allowance ahead of every other node's
    await registerCleartextV9App(url(AHEAD), {
      name: canaryName, ownerKey: seller, instances: 1, components: components(false), timestamp: harnessNow() + 3 * 60000,
    });
    const canary = await gossipedToStub('fluxappregister', canaryName, 'the node ahead gossips the message after the sale');

    const relayedSale = await stub.relayAppMessage(sale);
    expect(relayedSale.sent, `the stub relays the sale: ${JSON.stringify(relayedSale)}`).to.be.at.least(1);
    const relayedCanary = await stub.relayAppMessage(canary.hash);
    expect(relayedCanary.sent, `the stub relays the message after it: ${JSON.stringify(relayedCanary)}`).to.be.at.least(1);
    await waitFor(async () => (await Promise.all(ON_TIME.map((i) => holds(i, canary.hash)))).every(Boolean), {
      timeout: 60000, interval: 2000, label: 'every node on the network\'s clock holds the message relayed after the sale',
    });
    for (const i of ON_TIME) {
      // eslint-disable-next-line no-await-in-loop -- one node at a time, named in the failure
      expect(await holds(i, sale), `node ${i} refused the sale dated an hour ahead of its clock`).to.equal(false);
    }
  });

  it('applies the owner\'s content update on every node on the network\'s clock', async function () {
    this.timeout(CONVERGE_MS);
    const update = await pushContentUpdate(url(0), { name, slots: [{ name: SLOT.name, bytes: v2 }], ownerKey: seller });
    expect(update.status, `the owner's content update is taken: ${JSON.stringify(update).slice(0, 300)}`).to.equal('success');
    await waitFor(async () => (await standingVersions(ON_TIME)).every((v) => v === 2), {
      timeout: CONVERGE_MS, interval: 3000, label: 'every node on the network\'s clock stands on the owner\'s update',
    });
  });
});
