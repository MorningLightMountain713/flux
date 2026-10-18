// fleet: 3
/*
 * The submission door refuses an update of a v9 app with a content slot that
 * does not stand on what stands for it, naming its rule:
 *   - a sale naming no manifest, and a sale naming another, are refused with
 *     the manifest the sale must name; the sale naming it is taken;
 *   - an owner's update declaring a slot the standing manifest lacks, carrying
 *     no file list, is refused naming the slot;
 *   - while that sale waits for payment, the owner's content update through the
 *     node holding it is refused.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { appOwnerKey } from '../framework/keys.js';
import { buyerKey, transferApp } from '../framework/transfer-helper.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { confirmOnChain } from '../framework/app-helper.js';
import {
  deployContentApp, manifestStanding, pushContentUpdate, updateEncryptedV9App,
} from '../framework/content-helper.js';
import { pushBusybox } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { waitFor } from '../framework/wait.js';

const NODES = 3;
const CONVERGE_MS = 300000;
const CONF = { name: 'conf', destination: '/etc/app.conf', onUpdate: { action: 'restart' } };
const EXTRA = { name: 'extra', destination: '/etc/extra.conf', onUpdate: { action: 'restart' } };
const ANOTHER_MANIFEST = `sha256:${'ab'.repeat(32)}`;

describe('submissions refused', function () {
  let env;
  let image;
  let standing; // the manifest that stands for the app
  const owner = appOwnerKey();
  const buyer = buyerKey();
  const name = `refused${Date.now()}`;
  const conf = Buffer.from(`conf ${name} registered with\n`);
  const url = (i) => env.clients[i].url;

  function components(slots) {
    const mounts = { '/data': { source: 'data', destination: '/data' } };
    for (const s of slots) {
      mounts[s.destination] = {
        source: s.name, destination: s.destination, type: 'file', contentSlot: s.name, onUpdate: s.onUpdate,
      };
    }
    return {
      web: {
        name: 'web',
        description: 'submissions refused',
        image,
        cpu: 0.5,
        memory: 300,
        rootFsGb: 2,
        persistentStorage: { sizeGb: 1, mounts },
        ports: { http: { containerPort: 80, hostPort: 31262 } },
      },
    };
  }
  const shape = (slots) => ({ instances: 1, components: components(slots) });

  // A sale through node 0, left unpaid, naming `manifest` (none when null).
  const sell = (manifest) => transferApp(url(0), owner, { spec: { name } }, env.clients, {
    sellerKey: owner,
    buyerKey: buyer,
    standsOn: manifest ? { manifest } : {},
    v9: shape([CONF]),
    pay: false,
  });

  function expectRefused(result, rule, label) {
    expect(result.status, `${label}: ${JSON.stringify(result).slice(0, 400)}`).to.equal('error');
    expect(JSON.stringify(result.data), `${label}: the refusal names its rule`).to.match(rule);
  }

  before(async function () {
    this.timeout(1200000);
    env = await createTestEnv({
      hookCtx: this, nodes: NODES, tickerAutostart: false, arcane: true,
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1, pricing: true });
    expect(buyer.zelid, 'the fixture names two owners').to.not.equal(owner.zelid);
    await pushBusybox(name);
    image = `${REGISTRY_REPO_HOST}/${name}:v1`;

    const registration = await deployContentApp(url(0), {
      name, ...shape([CONF]), ownerKey: owner, contentSlots: [{ ...CONF, bytes: conf }],
    });
    expect(registration.status, `the registration is accepted: ${JSON.stringify(registration).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(registration.data, env.clients);
    await waitFor(async () => (await Promise.all(env.clients.map(async (c) => (await manifestStanding(c.url, name)).standing?.version))).every((v) => v === 1), {
      timeout: CONVERGE_MS, interval: 3000, label: 'every node stands on the registration\'s manifest',
    });
    standing = (await manifestStanding(url(0), name)).standing;
  });

  after(async function () {
    this.timeout(120000);
    await env?.teardown();
  });

  it('refuses a sale naming no manifest, naming the one it must', async function () {
    this.timeout(120000);
    const unnamed = await sell(null);
    expectRefused(unnamed, new RegExp(`content must name the manifest the update stands on, ${standing.hash}`), 'a sale naming no manifest');
  });

  it('refuses a sale naming another manifest, naming the one it must', async function () {
    this.timeout(120000);
    const wrong = await sell(ANOTHER_MANIFEST);
    expectRefused(wrong, new RegExp(`content names ${ANOTHER_MANIFEST}, not the manifest the update stands on, ${standing.hash}`), 'a sale naming another manifest');
  });

  it('refuses an update declaring a slot the standing manifest lacks, naming the slot', async function () {
    this.timeout(120000);
    const uncovered = await updateEncryptedV9App(url(0), { name, ownerKey: owner, ...shape([CONF, EXTRA]) });
    expectRefused(uncovered, /the manifest the update stands on does not cover slot extra/, 'an update declaring a slot no manifest covers');
  });

  it('takes the sale naming the standing manifest, and refuses the owner\'s content update while it waits for payment', async function () {
    this.timeout(CONVERGE_MS);
    const sale = await sell(standing.hash);
    expect(sale.status, `the sale naming the standing manifest is taken: ${JSON.stringify(sale).slice(0, 300)}`).to.equal('success');
    await waitFor(async () => (await env.clients[0].getTempMessages(sale.appHash)).data?.length > 0, {
      timeout: 60000, interval: 2000, label: 'the node holds the sale waiting for payment',
    });
    const update = await pushContentUpdate(url(0), { name, slots: [{ name: CONF.name, bytes: Buffer.from('conf pushed while the sale waits\n') }], ownerKey: owner });
    expectRefused(update, /a transfer of the app waits for payment on this node/, 'a content update while a sale waits');
  });
});
