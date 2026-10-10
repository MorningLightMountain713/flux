// fleet: 3
/*
 * A v9 mesh app whose owner re-rolled its founder role, then sold it.
 *
 * A mesh component founds once per world: its container asks its own node "may
 * I found?" and exactly one is told yes, from a write-once register a quorum
 * arbitrates. The owner re-rolls the founder role, which deals a fresh founding
 * round, then sells the app through the door while one node is off the network,
 * naming the re-rolled record in the spec's `grants` block. Then:
 *   - the founded component stays founded: every node, the returning one
 *     included, answers its container with the founder of the re-rolled world;
 *   - a component the buyer adds is founded once, in the buyer's world, and
 *     the first component's founder does not move;
 *   - the seller's update is refused;
 *   - a resale undone by a rewind leaves every row as it stood.
 *
 * The committee is the whole three-node fleet (quorum 2), the smallest world
 * in which a founding race is a real race. Founder asks run inside the app's
 * containers, so the app runs the harness's busybox image.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { loadSharedConfig } from '../framework/coupled-knobs.js';
import { authenticate } from '../auth.js';
import { appOwnerKey } from '../framework/keys.js';
import { buyerKey, transferApp } from '../framework/transfer-helper.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { confirmOnChain } from '../framework/app-helper.js';
import { registerEncryptedV9App, updateEncryptedV9App } from '../framework/content-helper.js';
import { pushBusybox } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { execInContainer, requireAppContainerName } from '../framework/container.js';
import { postGenerationRecord } from '../framework/generation-record.js';
import { appView } from '../framework/app-view.js';
import {
  advanceBlocks, getState, queueAppTx, reorgChain, startTicker, stopTicker,
} from '../framework/daemon-control.js';
import {
  waitFor, waitForAppInstalled, waitForDaemonReady, waitForReorg,
} from '../framework/wait.js';
import { appIdentityFromUuid, appUuid, generationRecordHash } from '@runonflux/flux-spec';

const NODES = 3;
const CONVERGE_MS = 300000;
const DOOR_REFUSAL = /does not correspond with Flux App owner/;
const OUTAGE_LIMIT_MS = (loadSharedConfig().fluxapps.nodeDownGraceS - 20) * 1000;

describe('a mesh app re-rolled, then sold', function () {
  let env;
  let view;
  let away;
  let registrar;
  let image;
  let registered;
  let sold;
  let founderRecord; // the seller's re-rolled founder record, which the sale names
  let webFounder; // the node told yes for `web` in the re-rolled world
  let buyersUpdate;
  const seller = appOwnerKey();
  const buyer = buyerKey();
  const name = `meshsale${Date.now()}`;
  const url = (i) => env.clients[i].url;
  const all = () => env.clients.map((_, i) => i);

  function component(componentName, hostPort) {
    return {
      name: componentName,
      description: 'mesh app sold',
      image,
      cpu: 0.5,
      memory: 300,
      rootFsGb: 2,
      persistentStorage: { sizeGb: 1, mounts: { '/data': { source: 'data', destination: '/data' } } },
      ports: { http: { containerPort: 80, hostPort } },
    };
  }

  // The submission's shape: every component, the mesh, and the founder record
  // the app stands on once there is one.
  function shape(components) {
    return {
      instances: 3,
      components,
      specOverrides: {
        network: { mesh: true },
        ...(founderRecord ? { grants: { founder: generationRecordHash(founderRecord) } } : {}),
      },
    };
  }

  // One founder ask from inside a component's container on one node.
  async function askFounder(index, componentName) {
    try {
      const containerName = await requireAppContainerName(env.clients[index].container, name, componentName);
      const { stdout } = await execInContainer(
        env.clients[index].container,
        `docker exec ${containerName} /bin/busybox wget -qO- --post-data='' http://fluxnode.service:16101/mesh/founder`,
      );
      return JSON.parse(stdout)?.data?.answer ?? null;
    } catch {
      return null;
    }
  }

  // Every node's settled answer for a component: exactly one yes.
  async function founderOf(componentName) {
    let answers = [];
    await waitFor(async () => {
      answers = await Promise.all(all().map((i) => askFounder(i, componentName)));
      return answers.every((a) => a === 'yes' || a === 'no');
    }, { timeout: CONVERGE_MS, interval: 5000, label: `founder answers settle for ${componentName}` });
    expect(answers.filter((a) => a === 'yes'), `answers for ${componentName}: ${answers}`).to.have.length(1);
    return answers.indexOf('yes');
  }

  async function standingGeneration(index) {
    const res = await fetch(`${url(index)}/apps/grantgeneration/${registered.identity}/founder`);
    return (await res.json()).data;
  }

  before(async function () {
    this.timeout(1200000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      tickerAutostart: false,
      zmqTopics: ALL_ZMQ_TOPICS,
      arcane: true,
      configOverrides: {
        fluxapps: {
          meshReconcileIntervalMs: 15000,
          minOutgoing: 1,
          minIncoming: 1,
          quorumGrantMaxTtlMs: 30000,
          quorumGrantDrainMs: 20000,
          quorumGrantLockDelayMs: 10000,
          quorumGrantRenewIntervalMs: 5000,
          quorumGrantAskTimeoutMs: 3000,
          adoptionStaggerStepMs: 5000,
          adoptionStaggerWindowMs: 10000,
        },
      },
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1, pricing: true });
    view = appView(env, name, { component: 'web', timeout: CONVERGE_MS });
    const ordinary = all().filter((i) => !env.establishedNodes.includes(i));
    [away] = ordinary;
    registrar = all().find((i) => i !== away);
    expect(buyer.zelid, 'the fixture names two owners').to.not.equal(seller.zelid);

    await pushBusybox(name);
    image = `${REGISTRY_REPO_HOST}/${name}:v1`;
    const reg = await registerEncryptedV9App(url(registrar), { name, ...shape({ web: component('web', 31000) }) });
    expect(reg.status, `the registration is accepted: ${JSON.stringify(reg).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(reg.data, env.clients);
    const uuid = appUuid(name, reg.data);
    registered = {
      spec: { name, owner: seller.zelid, hash: reg.data }, hash: reg.data, uuid, identity: appIdentityFromUuid(uuid),
    };
    await Promise.all(env.clients.map((c) => waitForAppInstalled(c, name, CONVERGE_MS)));
    await founderOf('web');

    // The seller re-rolls the founder role: a fresh founding round in a new world.
    const { zelidauth } = await authenticate(url(registrar), seller);
    const posted = await postGenerationRecord(url(registrar), {
      name, identity: registered.identity, role: 'founder', generation: 1, ownerKey: seller, auth: zelidauth,
    });
    expect(posted.status, posted.body).to.equal(200);
    founderRecord = posted.record;
    await waitFor(async () => (await Promise.all(all().map(standingGeneration))).every((d) => d?.generation === 1), {
      timeout: CONVERGE_MS, interval: 5000, label: 'generation 1 standing on every node',
    });
    webFounder = await founderOf('web');
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('keeps the founded component founded through a sale naming the re-rolled record, on every node', async function () {
    this.timeout(1200000);
    await env.disconnectNode(away);
    const wentAway = Date.now();
    const stayers = all().filter((i) => i !== away);
    const { specOverrides, ...rest } = shape({ web: component('web', 31000) });
    const result = await transferApp(url(registrar), seller, registered, stayers.map((i) => env.clients[i]), {
      v9: { ...rest, specOverrides: { network: specOverrides.network } },
      standsOn: { grants: specOverrides.grants },
    });
    await env.reconnectNode(away);
    expect(Date.now() - wentAway, 'the node was away for less than the node-down grace').to.be.below(OUTAGE_LIMIT_MS);
    expect(result.status, `the sale is accepted: ${JSON.stringify(result).slice(0, 300)}`).to.equal('success');
    sold = result.app;

    await waitForDaemonReady(env.clients[away]);
    await view.installedEverywhere(sold.spec.hash, all(), 'every node adopts the sale');
    expect(await founderOf('web'), 'the founder of the re-rolled world').to.equal(webFounder);
  });

  it('founds a component the buyer adds once, in the buyer\'s world, and the first founder does not move', async function () {
    this.timeout(1200000);
    const res = await updateEncryptedV9App(url(registrar), {
      name,
      ...shape({ web: component('web', 31000), db: component('db', 31001) }),
      owner: buyer.zelid,
      ownerKey: buyer,
    });
    expect(res.status, `the buyer's update is accepted: ${JSON.stringify(res).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(res.data, env.clients);
    buyersUpdate = res.data;
    await view.installedEverywhere(buyersUpdate, all(), 'every node runs the buyer\'s update');
    await founderOf('db');
    expect(await founderOf('web'), 'the first component\'s founder').to.equal(webFounder);
  });

  it('refuses the seller\'s update', async function () {
    this.timeout(120000);
    const refused = await updateEncryptedV9App(url(registrar), {
      name,
      ...shape({ web: component('web', 31000), db: component('db', 31001) }),
      owner: buyer.zelid,
      ownerKey: seller,
    });
    expect(refused.status, 'the seller\'s update at the door').to.equal('error');
    expect(refused.data?.message ?? refused.data, 'the door names the owner check').to.match(DOOR_REFUSAL);
  });

  it('leaves every row as it stood before a resale that a rewind undoes', async function () {
    this.timeout(1200000);
    await stopTicker();
    const forkHeight = (await getState()).currentHeight;
    const resale = await updateEncryptedV9App(url(registrar), {
      name,
      ...shape({ web: component('web', 31000), db: component('db', 31001) }),
      owner: seller.zelid,
      ownerKey: buyer,
    });
    expect(resale.status, `the resale is accepted: ${JSON.stringify(resale).slice(0, 300)}`).to.equal('success');
    await waitFor(async () => {
      const held = await Promise.all(all().map(async (i) => (await env.clients[i].getTempMessages(resale.data)).data?.length > 0));
      return held.every(Boolean);
    }, { timeout: 60000, interval: 2000, label: 'every node holds the resale' });
    await queueAppTx(resale.data);
    await advanceBlocks(2);
    await view.listedEverywhere(resale.data, all(), 'every node lists the resale');

    const mark = env.clients[registrar].getLastEventId();
    await reorgChain({ forkHeight });
    await waitForReorg(env.clients[registrar], (d) => d.forkHeight === forkHeight, 60000, { afterId: mark });
    await advanceBlocks(1);
    await view.listedEverywhere(buyersUpdate, all(), 'every node lists the buyer\'s update again');
    for (const i of all()) {
      // eslint-disable-next-line no-await-in-loop
      expect((await view.listedOn(i)).owner, `node ${i}'s row names the buyer`).to.equal(buyer.zelid);
    }
    await startTicker();
  });
});
