// fleet: 3
/*
 * The locator route across a sale.
 *
 * A blob's locator is derived from the app's identity and the blob's content
 * hash on the benchmark channel, through POST /apps/bloblocator, for the owner
 * the registry lists. Before the sale the owner derives the locator FluxDrive
 * stores the blob under; once the sale applies the outgoing owner is refused,
 * and the incoming owner derives the same locator, since a sale keeps the
 * identity.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { appOwnerKey } from '../framework/keys.js';
import { buyerKey, transferApp } from '../framework/transfer-helper.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { confirmOnChain } from '../framework/app-helper.js';
import { deployContentApp, requestBlobLocator } from '../framework/content-helper.js';
import { blobHash } from '../framework/content-crypto-v9.js';
import { getFluxDriveState } from '../framework/fluxdrive-control.js';
import { pushImage } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { appView } from '../framework/app-view.js';
import { waitFor } from '../framework/wait.js';
import { appIdentityFromUuid, appUuid } from '@runonflux/flux-spec';

const NODES = 3;
const CONVERGE_MS = 240000;
const REF_PATH = '/etc/ref.conf';

describe('the locator route across a sale', function () {
  let env;
  let view;
  let node; // the node every request goes to
  let registered;
  let shape;
  let stored; // the locator FluxDrive holds the blob under
  const seller = appOwnerKey();
  const buyer = buyerKey();
  const name = `locsale${Date.now()}`;
  const blob = Buffer.from(`the blob of ${name}\n`);
  const contentHash = blobHash(blob);

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this, nodes: NODES, tickerAutostart: false, arcane: true,
      configOverrides: { fluxapps: { adoptionStaggerStepMs: 5000, adoptionStaggerWindowMs: 10000 } },
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1, pricing: true });
    node = env.clients[0];
    view = appView(env, name, { component: 'web', timeout: CONVERGE_MS });
    expect(buyer.zelid, 'the fixture names two owners').to.not.equal(seller.zelid);

    await pushImage(name, 'v1');
    shape = {
      instances: 1,
      components: {
        web: {
          name: 'web',
          description: 'the locator route across a sale',
          image: `${REGISTRY_REPO_HOST}/${name}:v1`,
          cpu: 0.5,
          memory: 300,
          rootFsGb: 2,
          persistentStorage: {
            sizeGb: 1,
            mounts: {
              '/data': { source: 'data', destination: '/data' },
              [REF_PATH]: {
                source: 'ref.conf', destination: REF_PATH, type: 'file', contentRef: { hash: contentHash },
              },
            },
          },
          ports: { http: { containerPort: 80, hostPort: 31260 } },
        },
      },
    };
    const reg = await deployContentApp(node.url, { name, contentRef: blob, ...shape });
    expect(reg.status, `the registration is accepted: ${JSON.stringify(reg).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(reg.data, env.clients);
    const uuid = appUuid(name, reg.data);
    registered = {
      spec: { name, owner: seller.zelid, hash: reg.data }, hash: reg.data, uuid, identity: appIdentityFromUuid(uuid),
    };
    await view.listedEverywhere(reg.data, [0, 1, 2], 'every node lists the app');
    await waitFor(async () => {
      const state = await getFluxDriveState();
      stored = state.blobs.find((b) => b.identity === registered.identity && !b.tombstoned)?.locator ?? null;
      return stored !== null;
    }, { timeout: 60000, interval: 2000, label: 'FluxDrive holds the blob' });
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('derives for the owner the locator FluxDrive stores the blob under', async function () {
    this.timeout(60000);
    const res = await requestBlobLocator(node.url, { name, contentHash, ownerKey: seller });
    expect(res.status, `the owner's request: ${JSON.stringify(res).slice(0, 300)}`).to.equal('success');
    expect(res.data.locator, 'the derived locator is the stored one').to.equal(stored);
  });

  it('refuses the outgoing owner once the sale applies, and derives the same locator for the incoming one', async function () {
    this.timeout(600000);
    const sold = await transferApp(node.url, seller, registered, env.clients, { v9: shape });
    expect(sold.status, `the sale is accepted: ${JSON.stringify(sold).slice(0, 300)}`).to.equal('success');
    await view.listedEverywhere(sold.app.spec.hash, [0], 'the node lists the sale');

    const fromSeller = await requestBlobLocator(node.url, { name, contentHash, ownerKey: seller });
    expect(fromSeller.status, 'the outgoing owner is refused').to.equal('error');
    expect(fromSeller.data?.message ?? fromSeller.data).to.match(/listed under another owner/);

    const fromBuyer = await requestBlobLocator(node.url, { name, contentHash, ownerKey: buyer });
    expect(fromBuyer.status, `the incoming owner's request: ${JSON.stringify(fromBuyer).slice(0, 300)}`).to.equal('success');
    expect(fromBuyer.data.locator, 'the same locator: a sale keeps the identity').to.equal(stored);
  });
});
