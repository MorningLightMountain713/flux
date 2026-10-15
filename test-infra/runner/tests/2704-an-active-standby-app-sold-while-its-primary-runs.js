// fleet: 12
/*
 * An activeStandby app sold while its primary holds the term.
 *
 * A v9 encrypted app whose one component syncs activeStandby names three nodes:
 * its primary's, its standby's, and a node that boots after the sale. The owner
 * sells it through the door while the standby is off the network. Then:
 *   - the primary keeps the term and its container, through the drain the sale
 *     starts: no cell serves the key for DRAIN_BLOCKS after the transfer applies,
 *     so no other node can be seated and the primary coasts;
 *   - the standby returns holding the sale and is still a standby;
 *   - the node that boots afterwards installs the app as sold, as a standby;
 *   - the buyer's update applies on all three and the seller's is refused;
 *   - a resale undone by a rewind leaves every row as it stood.
 *
 * The app names exactly as many nodes as it has instances, so every named node's
 * spawner places it whatever the fault-domain share says. The two hosts are
 * chosen outside env.establishedNodes. The standby's outage ends inside the
 * node-down grace, past which the fleet certifies a node down.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { loadSharedConfig } from '../framework/coupled-knobs.js';
import { appOwnerKey } from '../framework/keys.js';
import { buyerKey, transferApp } from '../framework/transfer-helper.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { confirmOnChain } from '../framework/app-helper.js';
import { registerEncryptedV9App, updateEncryptedV9App } from '../framework/content-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { nodeOutpoint } from '../framework/seed-helper.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';
import { appDataRoot, appSyncthingFolderId, execInContainer } from '../framework/container.js';
import { setSynced } from '../framework/syncthing-control.js';
import { grantPlaneOverrides, grantVerdict } from '../framework/grant-record.js';
import { appView } from '../framework/app-view.js';
import {
  advanceBlocks, getState, queueAppTx, reorgChain, startTicker, stopTicker,
} from '../framework/daemon-control.js';
import {
  waitFor, waitForDaemonReady, waitForInstallSettled, waitForReorg,
} from '../framework/wait.js';
import { appIdentityFromUuid, appUuid } from '@runonflux/flux-spec';

const NODES = 11;
const FRESH = 10; // boots after the sale
const QUORUM = 5;
// The blocks a sale's committee drains before it serves: production's value.
const DRAIN_BLOCKS = 20;
const CONVERGE_MS = 300000;
const DOOR_REFUSAL = /does not correspond with Flux App owner/;
// The answers a grantor gives only past its return gate, so only while it
// referees: every earlier refusal (stale chain, boot sync incomplete, record not
// re-fetched since it returned) comes before these.
const REFEREEING = new Set(['refusedCommittee', 'refusedUnadopted', 'refusedHolder', 'served']);
const OUTAGE_LIMIT_MS = (loadSharedConfig().fluxapps.nodeDownGraceS - 20) * 1000;

describe('an activeStandby app sold while its primary runs', function () {
  let env;
  let primary;
  let standby;
  let registrar;
  let key; // `<identity>/master`
  let registered;
  let sold;
  let updated;
  let primaryContainer;
  let masterGrantee;
  const seller = appOwnerKey();
  const buyer = buyerKey();
  const name = `standbysale${Date.now()}`;
  let shape;
  let view;

  const indexOfGrantee = (grantee) => env.clients.findIndex((c, i) => c && nodeOutpoint(i) === grantee);
  const verdict = () => grantVerdict(env.clients, key, { quorum: QUORUM });

  // A synced folder holds bytes on every holder, or the stall ladder removes the
  // standbys: written after each holder's install, which clears its volume.
  async function seedData(index) {
    const dir = `${await appDataRoot(env.clients[index].container, name, null)}/appdata`;
    const r = await execInContainer(env.clients[index].container, `sh -c 'mkdir -p ${dir} && echo seeded > ${dir}/seed-data'`);
    expect(r.exitCode, `seed data written on node ${index}: ${r.output}`).to.equal(0);
  }

  before(async function () {
    this.timeout(1200000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      deferredNodes: 1,
      tickerAutostart: false,
      zmqTopics: ALL_ZMQ_TOPICS,
      configOverrides: {
        fluxapps: grantPlaneOverrides({
          quorumGrantGenerationDrainBlocks: DRAIN_BLOCKS, adoptionStaggerStepMs: 5000, adoptionStaggerWindowMs: 10000,
        }),
      },
    });
    await bootAndPeer(env, { pricing: true });
    view = appView(env, name, { component: 'web', timeout: CONVERGE_MS });

    const running = Array.from({ length: FRESH }, (_, i) => i);
    const ordinary = running.filter((i) => !env.establishedNodes.includes(i));
    const [first, second] = ordinary;
    registrar = running.find((i) => i !== first && i !== second);
    expect(buyer.zelid, 'the fixture names two owners').to.not.equal(seller.zelid);

    await pushImage(name, 'v1');
    const ip = (i) => getSubnetConfig().nodeIp(i + 1);
    shape = {
      instances: 3,
      placement: { targetIps: [ip(first), ip(second), ip(FRESH)] },
      components: {
        web: {
          name: 'web',
          description: 'sold while its primary runs',
          image: `${REGISTRY_REPO_HOST}/${name}:v1`,
          cpu: 0.5,
          memory: 300,
          rootFsGb: 2,
          persistentStorage: {
            sizeGb: 1,
            mounts: { '/appdata': { source: 'appdata', destination: '/appdata' } },
            sync: { mode: 'activeStandby' },
          },
          ports: { http: { containerPort: 80, hostPort: 31210 } },
        },
      },
    };
    const reg = await registerEncryptedV9App(env.clients[registrar].url, { name, ...shape });
    expect(reg.status, `the registration is accepted: ${JSON.stringify(reg).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(reg.data, env.clients.filter(Boolean));
    const uuid = appUuid(name, reg.data);
    registered = {
      spec: { name, owner: seller.zelid, hash: reg.data }, hash: reg.data, uuid, identity: appIdentityFromUuid(uuid),
    };
    key = `${registered.identity}/master`;

    await Promise.all([first, second].map((i) => waitForInstallSettled(env.clients[i], name, CONVERGE_MS)));
    await Promise.all([first, second].map((i) => seedData(i)));
    await setSynced({ folder: await appSyncthingFolderId(env.clients[first], name, 'web') });

    let term = null;
    await waitFor(async () => {
      term = await verdict();
      return term !== null;
    }, { timeout: CONVERGE_MS, interval: 10000, label: 'a term forms' });
    primary = indexOfGrantee(term.grantee);
    expect([first, second], 'the term is held by one of the two hosts').to.include(primary);
    standby = primary === first ? second : first;
  });

  after(async function () {
    this.timeout(120000);
    await env?.teardown();
  });

  it('runs the app on its primary, with the standby stopped', async function () {
    this.timeout(CONVERGE_MS);
    await waitFor(async () => (await view.containerOn(primary)).running && !(await view.containerOn(standby)).running, {
      timeout: CONVERGE_MS, interval: 5000, label: 'the primary runs and the standby is stopped',
    });
    primaryContainer = await view.containerOn(primary);
    masterGrantee = (await verdict()).grantee;
    expect(await view.runningCount(), 'exactly one master runs').to.equal(1);
  });

  it('keeps the primary\'s term and container through a sale made while the standby is away', async function () {
    this.timeout(1200000);
    await env.disconnectNode(standby);
    const wentAway = Date.now();
    const awayFrom = env.clients[standby].getLastEventId();
    const stayers = env.clients.map((c, i) => (c && i !== standby ? i : -1)).filter((i) => i >= 0);
    const result = await transferApp(env.clients[registrar].url, seller, registered, stayers.map((i) => env.clients[i]), {
      v9: shape,
    });
    await env.reconnectNode(standby);
    expect(Date.now() - wentAway, 'the standby was away for less than the node-down grace').to.be.below(OUTAGE_LIMIT_MS);
    expect(result.status, `the sale is accepted: ${JSON.stringify(result).slice(0, 300)}`).to.equal('success');
    sold = result.app;

    await view.listedEverywhere(sold.spec.hash, stayers, 'every node that stayed lists the sale');
    await view.installedEverywhere(sold.spec.hash, [primary], 'the primary adopts the sale');
    expect((await view.installedOn(primary)).owner, 'the primary\'s record names the buyer').to.equal(buyer.zelid);

    // A grantor back from an outage referees a key only once it has re-fetched
    // the published record, and refuses every ask until then: a witness poll
    // counts no vouch from it. The chain is held while it returns, so the drain
    // the sale started cannot end before it referees again.
    await stopTicker();
    try {
      await env.clients[standby].waitForEvent(
        'quorumGrant:served',
        (data) => data?.key === key && REFEREEING.has(data?.outcome),
        CONVERGE_MS,
        { afterId: awayFrom },
      );
    } finally {
      await startTicker();
    }

    // The drain's lift lands inside one of the primary's passes, between its
    // step into the sale's world (refused: the cells still drain) and its
    // witness poll. The chain is held one block short of the lift; the first
    // prepare refused as draining after the primary processed that block is a
    // pass's step, and the lift block is made at once, before that pass polls.
    const client = env.clients[primary];
    const DRAINING = /is draining until height (\d+)/;
    const drainingAsk = (type) => (data) => data?.type === type && DRAINING.test(data?.reason ?? '');
    const first = await client.waitForEvent('quorumGrant:askRefused', drainingAsk('probe'), CONVERGE_MS);
    const liftAt = Number(DRAINING.exec(first.data.reason)[1]);
    await stopTicker();
    let lift;
    let verdictAtLift;
    try {
      const { currentHeight } = await getState();
      expect(currentHeight, 'the chain is held short of the lift').to.be.below(liftAt);
      await advanceBlocks(liftAt - 1 - currentHeight);
      const heldAt = await client.waitForEvent('block:processed', (data) => data?.height === liftAt - 1, CONVERGE_MS);
      const refused = await client.waitForEvent('quorumGrant:askRefused', drainingAsk('prepare'), CONVERGE_MS, { afterId: heldAt.id });
      await advanceBlocks(1);
      lift = await client.waitForEvent('block:processed', (data) => data?.height === liftAt, CONVERGE_MS, { afterId: refused.id });
      verdictAtLift = await client.waitForEvent('quorumGrant:assess', () => true, CONVERGE_MS, { afterId: refused.id });
    } finally {
      await startTicker();
    }
    // the witness poll of the pass the lift landed in vouches no takeover:
    // every cell's stranger door is shut for a lock-delay past the lift
    expect(lift.id, 'the primary processed the lift before its pass judged').to.be.below(verdictAtLift.id);
    expect(verdictAtLift.data.outcome, 'the verdict of the pass the lift landed in').to.equal('coast');

    // Past the drain the sale started, the primary steps across and renews: the
    // same grantee holds a live term, and its container never stopped.
    await client.waitForEvent('quorumGrant:steppedAcross', () => true, CONVERGE_MS, { afterId: lift.id });
    await waitFor(async () => (await verdict())?.grantee === masterGrantee, {
      timeout: CONVERGE_MS, interval: 5000, label: 'the primary holds a live term past the drain',
    });
    const now = await view.containerOn(primary);
    expect(now.id, 'the primary\'s container was not recreated').to.equal(primaryContainer.id);
    expect(now.startedAt, 'the primary\'s container was not restarted').to.equal(primaryContainer.startedAt);
    expect(now.running, 'the primary\'s container runs').to.equal(true);
    expect(await view.runningCount(), 'exactly one master runs').to.equal(1);
    const demoted = await client.waitForEvent('quorumGrant:demoted', () => true, 1000).then(() => true, () => false);
    expect(demoted, 'the primary was never demoted').to.equal(false);
  });

  it('brings the standby back holding the sale, still a standby', async function () {
    this.timeout(CONVERGE_MS * 2);
    await waitForDaemonReady(env.clients[standby]);
    await view.installedEverywhere(sold.spec.hash, [standby], 'the standby adopts the sale');
    expect((await view.installedOn(standby)).owner, 'the standby\'s record names the buyer').to.equal(buyer.zelid);
    expect((await view.containerOn(standby)).running, 'the standby is stopped').to.equal(false);
    expect((await verdict())?.grantee, 'the primary still holds the term').to.equal(masterGrantee);
  });

  it('installs the app as sold, as a standby, on a node that boots afterwards', async function () {
    this.timeout(CONVERGE_MS * 2);
    const fresh = await env.startNode(FRESH);
    await waitForDaemonReady(fresh);
    await env.startDiscovery([FRESH]);
    await view.installedEverywhere(sold.spec.hash, [FRESH], 'the fresh node installs the app as sold');
    await seedData(FRESH);
    expect((await view.installedOn(FRESH)).owner, 'the fresh node\'s record names the buyer').to.equal(buyer.zelid);
    expect((await view.containerOn(FRESH)).running, 'the fresh node holds it as a standby').to.equal(false);
    expect((await verdict())?.grantee, 'the primary still holds the term').to.equal(masterGrantee);
    expect(await view.runningCount(), 'exactly one master runs').to.equal(1);
  });

  it('applies the buyer\'s update on all three nodes and refuses the seller\'s', async function () {
    this.timeout(1200000);
    const refused = await updateEncryptedV9App(env.clients[registrar].url, {
      name, ...shape, owner: buyer.zelid, ownerKey: seller, specOverrides: { description: 'updated by the seller' },
    });
    expect(refused.status, 'the seller\'s update at the door').to.equal('error');
    expect(refused.data?.message ?? refused.data, 'the door names the owner check').to.match(DOOR_REFUSAL);

    const res = await updateEncryptedV9App(env.clients[registrar].url, {
      name, ...shape, owner: buyer.zelid, ownerKey: buyer, specOverrides: { description: 'updated by the buyer' },
    });
    expect(res.status, `the buyer's update is accepted: ${JSON.stringify(res).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(res.data, env.clients.filter(Boolean));
    updated = res.data;
    await view.installedEverywhere(updated, [primary, standby, FRESH], 'every node runs the buyer\'s update');
    expect(await view.runningCount(), 'exactly one master runs').to.equal(1);
  });

  it('leaves every row as it stood before a resale that a rewind undoes', async function () {
    this.timeout(1200000);
    const nodes = env.clients.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
    await stopTicker();
    const forkHeight = (await getState()).currentHeight;
    const resale = await updateEncryptedV9App(env.clients[registrar].url, {
      name, ...shape, owner: seller.zelid, ownerKey: buyer,
    });
    expect(resale.status, `the resale is accepted: ${JSON.stringify(resale).slice(0, 300)}`).to.equal('success');
    await waitFor(async () => {
      const held = await Promise.all(nodes.map(async (i) => (await env.clients[i].getTempMessages(resale.data)).data?.length > 0));
      return held.every(Boolean);
    }, { timeout: 60000, interval: 2000, label: 'every node holds the resale' });
    await queueAppTx(resale.data);
    await advanceBlocks(2);
    await view.listedEverywhere(resale.data, nodes, 'every node lists the resale');

    const mark = env.clients[registrar].getLastEventId();
    await reorgChain({ forkHeight });
    await waitForReorg(env.clients[registrar], (d) => d.forkHeight === forkHeight, 60000, { afterId: mark });
    await advanceBlocks(1);
    await view.listedEverywhere(updated, nodes, 'every node lists the buyer\'s update again');
    for (const i of nodes) {
      // eslint-disable-next-line no-await-in-loop
      expect((await view.listedOn(i)).owner, `node ${i}'s row names the buyer`).to.equal(buyer.zelid);
    }
    await startTicker();
  });
});
