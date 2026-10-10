// fleet: 3
/*
 * The owner-only routes across a sale.
 *
 * Who may read an app's processes, logs, container, usage and file changes is
 * read from the app's row, so from the block a sale applies on a node, that node
 * answers the incoming owner and refuses the outgoing one. Each owner holds a
 * signed session throughout, so a refusal is the owner check's, never the
 * session's. The terminal and the log stream are 2702's.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { authenticate } from '../auth.js';
import { appOwnerKey } from '../framework/keys.js';
import { buyerKey, transferApp } from '../framework/transfer-helper.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { confirmOnChain } from '../framework/app-helper.js';
import { registerEncryptedV9App } from '../framework/content-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';
import { appView } from '../framework/app-view.js';
import { waitForInstallSettled } from '../framework/wait.js';
import { appIdentityFromUuid, appUuid } from '@runonflux/flux-spec';

const NODES = 3;
const HOST = 0;
const CONVERGE_MS = 240000;

describe('the owner-only routes across a sale', function () {
  let env;
  let view;
  let registered;
  let shape;
  let sellerAuth;
  let buyerAuth;
  const seller = appOwnerKey();
  const buyer = buyerKey();
  const name = `ownersale${Date.now()}`;
  const component = `web_${name}`;
  const routes = () => [
    `/apps/apptop/${component}`,
    `/apps/applog/${component}/10`,
    `/apps/appinspect/${component}`,
    `/apps/appstats/${component}`,
    `/apps/appchanges/${component}`,
  ];

  async function ask(path, zelidauth) {
    const res = await fetch(`${env.clients[HOST].url}${path}`, { headers: { zelidauth } });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { status: 'raw', data: text }; }
  }

  // Every route answers this session: a raw answer is a log, which only an
  // authorised caller gets.
  async function answersAll(zelidauth) {
    return Promise.all(routes().map(async (path) => ({ path, answer: await ask(path, zelidauth) })));
  }

  const refused = (answer) => answer.status === 'error' && /Unauthorized/i.test(JSON.stringify(answer.data));

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this, nodes: NODES, tickerAutostart: false, arcane: true,
      configOverrides: { fluxapps: { adoptionStaggerStepMs: 5000, adoptionStaggerWindowMs: 10000 } },
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1, pricing: true });
    view = appView(env, name, { component: 'web', timeout: CONVERGE_MS });
    expect(buyer.zelid, 'the fixture names two owners').to.not.equal(seller.zelid);

    await pushImage(name, 'v1');
    shape = {
      instances: 1,
      placement: { targetIps: [getSubnetConfig().nodeIp(HOST + 1)] },
      components: {
        web: {
          name: 'web',
          description: 'owner-only routes across a sale',
          image: `${REGISTRY_REPO_HOST}/${name}:v1`,
          cpu: 0.5,
          memory: 300,
          rootFsGb: 2,
          persistentStorage: { sizeGb: 1, mounts: { '/data': { source: 'data', destination: '/data' } } },
          ports: { http: { containerPort: 80, hostPort: 31280 } },
        },
      },
    };
    const reg = await registerEncryptedV9App(env.clients[1].url, { name, ...shape });
    expect(reg.status, `the registration is accepted: ${JSON.stringify(reg).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(reg.data, env.clients);
    const uuid = appUuid(name, reg.data);
    registered = {
      spec: { name, owner: seller.zelid, hash: reg.data }, hash: reg.data, uuid, identity: appIdentityFromUuid(uuid),
    };
    await waitForInstallSettled(env.clients[HOST], name, CONVERGE_MS);
    sellerAuth = (await authenticate(env.clients[HOST].url, seller)).zelidauth;
    buyerAuth = (await authenticate(env.clients[HOST].url, buyer)).zelidauth;
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('answers the owner and refuses another signed-in user before the sale', async function () {
    this.timeout(120000);
    for (const { path, answer } of await answersAll(sellerAuth)) {
      expect(refused(answer), `${path} for the owner: ${JSON.stringify(answer).slice(0, 200)}`).to.equal(false);
    }
    for (const { path, answer } of await answersAll(buyerAuth)) {
      expect(refused(answer), `${path} for another user: ${JSON.stringify(answer).slice(0, 200)}`).to.equal(true);
    }
  });

  it('answers the buyer and refuses the seller once the sale applies on the node', async function () {
    this.timeout(600000);
    const sold = await transferApp(env.clients[1].url, seller, registered, env.clients, { v9: shape });
    expect(sold.status, `the sale is accepted: ${JSON.stringify(sold).slice(0, 300)}`).to.equal('success');
    await view.listedEverywhere(sold.app.spec.hash, [HOST], 'the node lists the sale');
    for (const { path, answer } of await answersAll(buyerAuth)) {
      expect(refused(answer), `${path} for the buyer: ${JSON.stringify(answer).slice(0, 200)}`).to.equal(false);
    }
    for (const { path, answer } of await answersAll(sellerAuth)) {
      expect(refused(answer), `${path} for the seller: ${JSON.stringify(answer).slice(0, 200)}`).to.equal(true);
    }
  });
});
