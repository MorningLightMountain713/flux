// fleet: 6
/*
 * A sale, for each kind of app that carries no content: a v8 cleartext app, a v8
 * enterprise app, a v9 cleartext app and a v9 encrypted app.
 *
 * Each app runs on two nodes and owes a third instance to a node that has not
 * yet booted. While one of the two is off the network, the owner on record sells all four through the
 * submission door. Then, for every app:
 *   - the node that ran it through the sale restarted nothing;
 *   - the node that was off the network returns and holds the sale;
 *   - the node that boots afterwards installs the app as sold, the encrypted
 *     specifications opening under the buyer;
 *   - the buyer's update applies on all three; the seller's is refused at the
 *     door, and for a v8 app handed to a node as a paid message, by the decider;
 *   - a resale undone by a rewind leaves every node's row as it stood before it.
 *
 * The two v8 apps are unpinned: a cleartext v8 spec cannot name nodes, and a pin
 * is an enterprise owner's grant that a buyer off the enterprise list does not
 * inherit. Each is placed on its two nodes while every other node's spawner is
 * held, and the holds stay until the fresh node, which boots holding none, has
 * placed the third instance. Their registrations reach the fleet as paid messages.
 * The two v9 apps are pinned by their placement and registered through the door.
 * Every app's subjects
 * are chosen outside env.establishedNodes, whose spent fallback budget would
 * have them promote past the joins this suite measures.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { loadSharedConfig } from '../framework/coupled-knobs.js';
import { appOwnerKey } from '../framework/keys.js';
import { buyerKey, transferApp } from '../framework/transfer-helper.js';
import { bootAndPeer, placeOnNodes, releaseSpawnerHolds } from '../framework/reconciler-suite.js';
import {
  buildSeedableApp, buildSeedableEnterpriseApp, buildSeedableUpdate,
} from '../framework/seed-helper.js';
import { registerApp, confirmOnChain } from '../framework/app-helper.js';
import {
  registerCleartextV9App, registerEncryptedV9App, updateCleartextV9App, updateEncryptedV9App,
} from '../framework/content-helper.js';
import { deliverAppMessage } from '../framework/app-delivery.js';
import { pushTestApp } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';
import { execInContainer, getAppContainerId, requireAppContainerName } from '../framework/container.js';
import {
  advanceBlocks, getState, queueAppTx, reorgChain, startTicker, stopTicker,
} from '../framework/daemon-control.js';
import {
  waitFor, waitForChainFollowed, waitForDaemonReady, waitForInstallSettled, waitForReorg,
} from '../framework/wait.js';
import { appIdentityFromUuid, appUuid } from '@runonflux/flux-spec';

const NODES = 5;
const FRESH = 4; // boots after the sale
const CONVERGE_MS = 240000;
const DOOR_REFUSAL = /does not correspond with Flux App owner/;
// A node with no peers for the node-down grace is certified down and removes every
// app, which is another suite's subject: the outage here ends well inside it.
const OUTAGE_LIMIT_MS = (loadSharedConfig().fluxapps.nodeDownGraceS - 20) * 1000;

function v8Component(name) {
  return {
    name,
    description: `sold with every kind. ${name}`,
    repotag: `${REGISTRY_REPO_HOST}/${name}:v1`,
    ports: [],
    domains: [''],
    environmentParameters: ['EXIT_CODE=0'],
    commands: [],
    containerPorts: [80],
    containerData: '/tmp',
    cpu: 0.1,
    ram: 100,
    hdd: 1,
    repoauth: '',
  };
}

function v9Components(name, hostPort) {
  return {
    web: {
      name: 'web',
      description: 'sold with every kind',
      image: `${REGISTRY_REPO_HOST}/${name}:v1`,
      cpu: 0.5,
      memory: 300,
      rootFsGb: 2,
      persistentStorage: { sizeGb: 1, mounts: { '/data': { source: 'data', destination: '/data' } } },
      ports: { http: { containerPort: 80, hostPort } },
    },
  };
}

describe('a sale of every app kind that carries no content', function () {
  let env;
  let host; // runs every app through the sale
  let away; // off the network through the sale
  let registrar; // takes every submission
  const seller = appOwnerKey();
  const buyer = buyerKey();
  const base = `sale${Date.now()}`;
  const kinds = [];

  let offline = null; // the node off the network, while it is
  const online = () => env.clients.filter((client, i) => client && i !== offline);

  async function installedOn(index, name) {
    const res = await env.clients[index].getInstalledApps();
    if (res.status !== 'success') return null;
    return (res.data ?? []).find((a) => a.name === name) ?? null;
  }

  // The node's registry row: the spec with the hash of the message it stands on.
  async function listedOn(index, name) {
    const res = await fetch(`${env.clients[index].url}/apps/globalappsspecifications?appname=${encodeURIComponent(name)}`);
    const body = await res.json();
    return body.status === 'success' && Array.isArray(body.data) ? body.data[0] ?? null : null;
  }

  // The container docker holds for the app on a node: its id, which a recreate
  // changes, and when it last started, which a restart changes.
  async function runningContainer(index, kind) {
    const { container } = env.clients[index];
    const id = await getAppContainerId(container, kind.name, kind.component);
    const name = await requireAppContainerName(container, kind.name, kind.component);
    const { stdout } = await execInContainer(container, `docker inspect --format '{{.State.StartedAt}}' ${name}`);
    return { id, startedAt: stdout.trim() };
  }

  // Resolves once every node named holds the app at this message, installed.
  async function installedEverywhere(kind, hash, indices, label) {
    await waitFor(async () => {
      const held = await Promise.all(indices.map((i) => installedOn(i, kind.name)));
      return held.every((app) => app?.hash === hash);
    }, { timeout: CONVERGE_MS, interval: 3000, label: `${kind.label}: ${label}` });
  }

  // Resolves once every node named lists the app at this message.
  async function listedEverywhere(kind, hash, indices, label) {
    await waitFor(async () => {
      const rows = await Promise.all(indices.map((i) => listedOn(i, kind.name)));
      return rows.every((row) => row?.hash === hash);
    }, { timeout: CONVERGE_MS, interval: 3000, label: `${kind.label}: ${label}` });
  }

  // A v8 app: seeded and placed with the other spawners held, then sold and
  // updated through the door, restating its spec with the owner and description
  // each submission names.
  function v8Kind({ label, name, enterprise }) {
    return {
      label,
      name,
      component: name,
      v8: true,
      held: true,
      async register() {
        const build = enterprise ? buildSeedableEnterpriseApp : buildSeedableApp;
        const app = await build({ name, instances: 3, compose: [v8Component(name)] });
        await placeOnNodes(env, app, [host, away], { release: false });
        return app;
      },
      async submit(app, { signerKey, owner, description }) {
        const spec = { ...app.spec, owner, ...(description ? { description } : {}) };
        delete spec.hash;
        delete spec.uuid;
        delete spec.identity;
        const res = await registerApp(env.clients[registrar].url, seller, spec, 'fluxappupdate', { signerKey });
        return { res, spec };
      },
      async sell(app) {
        const sold = await transferApp(env.clients[registrar].url, seller, app, online());
        expect(sold.status, `${label}: the sale is accepted: ${JSON.stringify(sold)}`).to.equal('success');
        return sold.app;
      },
    };
  }

  // A v9 app: registered, sold and updated through the door; the submission
  // restates its components and placement every time.
  function v9Kind({ label, name, cleartext, hostPort }) {
    const register = cleartext ? registerCleartextV9App : registerEncryptedV9App;
    const update = cleartext ? updateCleartextV9App : updateEncryptedV9App;
    const shape = (pins) => ({
      components: v9Components(name, hostPort),
      placement: { targetIps: pins.map((i) => getSubnetConfig().nodeIp(i + 1)) },
      instances: 3,
    });
    let pinsOf = null;
    return {
      label,
      name,
      component: 'web',
      v8: false,
      async register(pins) {
        pinsOf = pins;
        const res = await register(env.clients[registrar].url, { name, ...shape(pins) });
        expect(res.status, `${label}: the registration is accepted: ${JSON.stringify(res)}`).to.equal('success');
        await confirmOnChain(res.data, online());
        const uuid = appUuid(name, res.data);
        const app = {
          spec: { name, owner: seller.zelid, hash: res.data },
          hash: res.data,
          uuid,
          identity: appIdentityFromUuid(uuid),
        };
        await Promise.all([host, away].map((i) => waitForInstallSettled(env.clients[i], name, CONVERGE_MS)));
        return app;
      },
      async submit(app, { signerKey, owner, description }) {
        const res = await update(env.clients[registrar].url, {
          name,
          ...shape(pinsOf),
          owner,
          ownerKey: signerKey,
          ...(description ? { specOverrides: { description } } : {}),
        });
        return { res };
      },
      async sell(app) {
        const sold = await transferApp(env.clients[registrar].url, seller, app, online(), {
          v9: { cleartext, ...shape(pinsOf) },
        });
        expect(sold.status, `${label}: the sale is accepted: ${JSON.stringify(sold)}`).to.equal('success');
        return sold.app;
      },
    };
  }

  before(async function () {
    this.timeout(1200000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      deferredNodes: 1,
      arcane: true,
      tickerAutostart: false,
      // The chain's push path: a node hears the rewind as it happens.
      zmqTopics: ALL_ZMQ_TOPICS,
      configOverrides: { fluxapps: { adoptionStaggerStepMs: 5000, adoptionStaggerWindowMs: 10000 } },
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1, pricing: true });

    const running = [0, 1, 2, 3];
    const ordinary = running.filter((i) => !env.establishedNodes.includes(i));
    expect(ordinary.length, 'two nodes outside the established set to host the apps').to.be.at.least(2);
    [host, away] = ordinary;
    registrar = running.find((i) => i !== host && i !== away);
    expect(buyer.zelid, 'the fixture names two owners').to.not.equal(seller.zelid);

    kinds.push(
      v8Kind({ label: 'v8 cleartext', name: `${base}a`, enterprise: false }),
      v8Kind({ label: 'v8 enterprise', name: `${base}b`, enterprise: true }),
      v9Kind({ label: 'v9 cleartext', name: `${base}c`, cleartext: true, hostPort: 36011 }),
      v9Kind({ label: 'v9 encrypted', name: `${base}d`, cleartext: false, hostPort: 36012 }),
    );
    const pins = [host, away, FRESH];
    for (const kind of kinds) {
      // eslint-disable-next-line no-await-in-loop
      await pushTestApp(kind.name);
      // eslint-disable-next-line no-await-in-loop
      kind.registered = await kind.register(pins);
    }
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('runs every app on both of its nodes before the sale', async function () {
    this.timeout(CONVERGE_MS);
    for (const kind of kinds) {
      // eslint-disable-next-line no-await-in-loop
      await installedEverywhere(kind, kind.registered.hash, [host, away], 'installed on both nodes before the sale');
      // eslint-disable-next-line no-await-in-loop
      kind.containerBefore = await runningContainer(host, kind);
      // eslint-disable-next-line no-await-in-loop
      kind.awayContainerBefore = await runningContainer(away, kind);
    }
  });

  it('adopts the sale on the node that ran the app through it: every record names the buyer', async function () {
    this.timeout(1200000);
    await env.disconnectNode(away);
    offline = away;
    const wentAway = Date.now();
    const sold = await Promise.all(kinds.map((kind) => kind.sell(kind.registered)));
    const stayers = online().map((c) => env.clients.indexOf(c));
    await env.reconnectNode(away);
    offline = null;
    expect(Date.now() - wentAway, 'the node was away for less than the node-down grace').to.be.below(OUTAGE_LIMIT_MS);
    for (const [i, kind] of kinds.entries()) {
      kind.sold = sold[i];
      expect(kind.sold.identity, `${kind.label}: a sale keeps the identity`).to.equal(kind.registered.identity);
    }
    for (const kind of kinds) {
      // eslint-disable-next-line no-await-in-loop
      await listedEverywhere(kind, kind.sold.spec.hash, stayers, 'every node that stayed lists the sale');
      // eslint-disable-next-line no-await-in-loop
      await installedEverywhere(kind, kind.sold.spec.hash, [host], 'the host adopts the sale');
      // eslint-disable-next-line no-await-in-loop
      expect((await listedOn(host, kind.name)).owner, `${kind.label}: the registry names the buyer`).to.equal(buyer.zelid);
      // eslint-disable-next-line no-await-in-loop
      expect((await installedOn(host, kind.name)).owner, `${kind.label}: the installed record names the buyer`).to.equal(buyer.zelid);
    }
  });

  it('restarts nothing on the node that ran the app through the sale', async function () {
    this.timeout(120000);
    for (const kind of kinds) {
      // eslint-disable-next-line no-await-in-loop
      const after = await runningContainer(host, kind);
      expect(after.id, `${kind.label}: the container was not recreated`).to.equal(kind.containerBefore.id);
      expect(after.startedAt, `${kind.label}: the container was not restarted`).to.equal(kind.containerBefore.startedAt);
    }
  });

  it('brings the node that was off the network through the sale to the buyer once it returns, restarting nothing', async function () {
    this.timeout(CONVERGE_MS * 2);
    await waitForChainFollowed(env.clients[away]);
    for (const kind of kinds) {
      // eslint-disable-next-line no-await-in-loop
      await installedEverywhere(kind, kind.sold.spec.hash, [away], 'the returning node adopts the sale');
      // eslint-disable-next-line no-await-in-loop
      expect((await installedOn(away, kind.name)).owner, `${kind.label}: the returning node's record names the buyer`).to.equal(buyer.zelid);
      // eslint-disable-next-line no-await-in-loop
      const after = await runningContainer(away, kind);
      expect(after.id, `${kind.label}: the returning node's container was not recreated`).to.equal(kind.awayContainerBefore.id);
      expect(after.startedAt, `${kind.label}: the returning node's container was not restarted`).to.equal(kind.awayContainerBefore.startedAt);
    }
  });

  it('installs every app as sold on a node that boots afterwards', async function () {
    this.timeout(CONVERGE_MS * 2);
    const fresh = await env.startNode(FRESH);
    await waitForDaemonReady(fresh);
    await env.startDiscovery([FRESH]);
    for (const kind of kinds) {
      // eslint-disable-next-line no-await-in-loop
      await installedEverywhere(kind, kind.sold.spec.hash, [FRESH], 'the fresh node installs the app as sold');
      // eslint-disable-next-line no-await-in-loop
      expect((await installedOn(FRESH, kind.name)).owner, `${kind.label}: the fresh node's record names the buyer`).to.equal(buyer.zelid);
      // eslint-disable-next-line no-await-in-loop
      if (kind.held) await releaseSpawnerHolds(env, kind.name);
    }
  });

  it('applies the buyer\'s update on every node that runs the app', async function () {
    this.timeout(1200000);
    for (const kind of kinds) {
      // eslint-disable-next-line no-await-in-loop
      const { res, spec } = await kind.submit(kind.sold, {
        signerKey: buyer, owner: buyer.zelid, description: `updated by the buyer ${kind.name}`,
      });
      expect(res.status, `${kind.label}: the buyer's update is accepted: ${JSON.stringify(res)}`).to.equal('success');
      // eslint-disable-next-line no-await-in-loop
      await confirmOnChain(res.data, online());
      kind.updated = {
        ...kind.sold,
        spec: { ...(spec ?? kind.sold.spec), hash: res.data, uuid: kind.sold.uuid, identity: kind.sold.identity },
        hash: res.data,
      };
    }
    for (const kind of kinds) {
      // eslint-disable-next-line no-await-in-loop
      await installedEverywhere(kind, kind.updated.hash, [host, away, FRESH], 'every node runs the buyer\'s update');
    }
  });

  it('refuses the seller\'s update at the door, and for a v8 app handed over as a paid message, in the decider', async function () {
    this.timeout(600000);
    for (const kind of kinds) {
      // eslint-disable-next-line no-await-in-loop
      const { res } = await kind.submit(kind.updated, {
        signerKey: seller, owner: buyer.zelid, description: `updated by the seller ${kind.name}`,
      });
      expect(res.status, `${kind.label}: the seller's update at the door`).to.equal('error');
      expect(res.data?.message ?? res.data, `${kind.label}: the door names the owner check`).to.match(DOOR_REFUSAL);
    }

    // Handed to the registrar as a paid message: the decider judges it against the
    // owner on record.
    for (const kind of kinds.filter((k) => k.v8)) {
      // eslint-disable-next-line no-await-in-loop
      const forged = await buildSeedableUpdate(kind.updated, (spec) => {
        spec.description = `handed over by the seller ${kind.name}`;
      }, { signerKey: seller });
      let refusal = null;
      try {
        // eslint-disable-next-line no-await-in-loop
        await deliverAppMessage(env, forged.message, [registrar]);
      } catch (error) {
        refusal = error.message;
      }
      expect(refusal, `${kind.label}: the seller's paid message`).to.match(/unauthorized/);
      // eslint-disable-next-line no-await-in-loop
      expect((await listedOn(registrar, kind.name)).hash, `${kind.label}: the row is the buyer's`).to.equal(kind.updated.hash);
    }
  });

  it('leaves every row as it stood before a resale that a rewind undoes', async function () {
    this.timeout(1200000);
    const nodes = [0, 1, 2, 3, FRESH];
    // Blocks are mined here and nowhere else, so the rewind reaches back past the
    // resale and no further.
    await stopTicker();
    const forkHeight = (await getState()).currentHeight;
    const resales = [];
    for (const kind of kinds) {
      // eslint-disable-next-line no-await-in-loop
      const { res } = await kind.submit(kind.updated, { signerKey: buyer, owner: seller.zelid });
      expect(res.status, `${kind.label}: the resale is accepted: ${JSON.stringify(res)}`).to.equal('success');
      resales.push(res.data);
    }
    await waitFor(async () => {
      const held = await Promise.all(resales.map((hash) => Promise.all(
        nodes.map(async (i) => (await env.clients[i].getTempMessages(hash)).data?.length > 0),
      )));
      return held.flat().every(Boolean);
    }, { timeout: 60000, interval: 2000, label: 'every node holds every resale' });
    for (const hash of resales) {
      // eslint-disable-next-line no-await-in-loop
      await queueAppTx(hash);
    }
    await advanceBlocks(2);
    for (const [i, kind] of kinds.entries()) {
      // eslint-disable-next-line no-await-in-loop
      await listedEverywhere(kind, resales[i], nodes, 'every node lists the resale');
    }

    const mark = env.clients[registrar].getLastEventId();
    await reorgChain({ forkHeight });
    await waitForReorg(env.clients[registrar], (d) => d.forkHeight === forkHeight, 60000, { afterId: mark });
    await advanceBlocks(1);
    for (const kind of kinds) {
      // eslint-disable-next-line no-await-in-loop
      await listedEverywhere(kind, kind.updated.hash, nodes, 'every node lists the buyer\'s update again');
      for (const i of nodes) {
        // eslint-disable-next-line no-await-in-loop
        expect((await listedOn(i, kind.name)).owner, `${kind.label}: node ${i}'s row names the buyer`).to.equal(buyer.zelid);
      }
    }
    await startTicker();
  });
});
