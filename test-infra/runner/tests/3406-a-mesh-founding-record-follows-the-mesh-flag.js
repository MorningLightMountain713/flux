// fleet: 4
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { listedIdentity, registerEncryptedV9App, updateEncryptedV9App } from '../framework/content-helper.js';
import { queueAppTx, advanceBlocks } from '../framework/daemon-control.js';
import { waitFor, waitForAppInstalled } from '../framework/wait.js';
import { pauseHostContainer, unpauseHostContainer } from '../framework/container.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { dbClient } from '../framework/db-client.js';

// An app's founding record follows its mesh flag, and every node holds the same
// one however it learned the app.
//
// Registered off the mesh, no node holds a record. Turned on, every host holds
// one pinned at that spec and founds an ordinal. Turned off, every record goes.
// Turned on again - with node 2 paused across that update and a fourth node,
// which has never run, holding the app's whole history - it is a new world:
// every node, the paused one and the late one included, holds one record
// pinned at the second turn-on alone, under the same component key, and the
// four hosts hold four different ordinals.

const NODES = 4;
const LATE = 3;
const PAUSED = 2;
const HOSTS = [0, 1, 2];
const IMAGE = `${REGISTRY_REPO_HOST}/e2e-pause:v1`;

describe('a mesh founding record follows the mesh flag', function () {
  let env;
  let name;
  let identity = null;
  const hashes = [];

  async function listedHash(client) {
    try {
      const res = await fetch(`${client.url}/apps/globalappsspecifications?appname=${encodeURIComponent(name)}`);
      const body = await res.json();
      return body.status === 'success' && Array.isArray(body.data) ? body.data[0]?.hash ?? null : null;
    } catch {
      return null;
    }
  }

  async function listedOn(indices, hash, label) {
    await waitFor(async () => (await Promise.all(indices.map((i) => listedHash(env.clients[i])))).every((h) => h === hash), {
      timeout: 180000, interval: 3000, label,
    });
  }

  async function submit(message) {
    expect(message.status, JSON.stringify(message)).to.equal('success');
    hashes.push(message.data);
    await queueAppTx(message.data);
    await advanceBlocks(3);
    return message.data;
  }

  const update = (mesh, instances = 3) => updateEncryptedV9App(env.clients[0].url, {
    name, instances, image: IMAGE, specOverrides: { network: { mesh } },
  });

  const recordOn = (index) => dbClient(index + 1).foundingRecord(identity);

  async function heightOf(hash) {
    return (await (await dbClient(1).messages()).findOne({ hash }, { projection: { _id: 0, height: 1 } }))?.height;
  }

  function foundedSince(index, afterId, timeout) {
    return env.clients[index].waitForEvent('quorumGrant:ordinalFounded', (data) => data.identity === identity, timeout, { afterId });
  }

  before(async function () {
    this.timeout(600000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      deferredNodes: 1,
      tickerAutostart: false,
      arcane: true,
      zmqTopics: ALL_ZMQ_TOPICS,
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
        },
      },
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1, pricing: true });
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('registered off the mesh, no host holds a founding record', async function () {
    this.timeout(600000);
    name = `e2emeshflag${Date.now()}`;
    const hash = await submit(await registerEncryptedV9App(env.clients[0].url, {
      name, instances: 3, image: IMAGE, specOverrides: { network: { mesh: false } },
    }));
    await listedOn(HOSTS, hash, `${name} listed on the hosts`);
    identity = await listedIdentity(env.clients[0].url, name);
    await Promise.all(HOSTS.map((i) => waitForAppInstalled(env.clients[i], name, 240000)));
    expect(await Promise.all(HOSTS.map(recordOn))).to.deep.equal([null, null, null]);
  });

  it('turned on, every host holds a record pinned at that spec and founds an ordinal', async function () {
    this.timeout(600000);
    const marks = HOSTS.map((i) => env.clients[i].getLastEventId());
    const hash = await submit(await update(true));
    await listedOn(HOSTS, hash, `${name} listed with mesh on`);
    const height = await heightOf(hash);

    const events = await Promise.all(HOSTS.map((i, k) => foundedSince(i, marks[k], 300000)));
    expect(events.map((e) => e.data.ordinal).sort()).to.deep.equal([0, 1, 2]);
    const records = await Promise.all(HOSTS.map(recordOn));
    records.forEach((record, k) => {
      expect(Object.values(record?.components ?? {}).map((c) => c.anchorHeight), `node ${HOSTS[k]} pins at the turn-on`).to.deep.equal([height]);
    });
  });

  it('turned off, every host deletes its record', async function () {
    this.timeout(600000);
    const hash = await submit(await update(false));
    await listedOn(HOSTS, hash, `${name} listed with mesh off`);
    await waitFor(async () => (await Promise.all(HOSTS.map(recordOn))).every((record) => record === null), {
      timeout: 60000, interval: 3000, label: 'no host holds a record with mesh off',
    });
  });

  it('turned on again, every node - paused across it, or learning it late - holds the same new world', async function () {
    this.timeout(1200000);
    const marks = HOSTS.map((i) => env.clients[i].getLastEventId());
    await pauseHostContainer(env.clients[PAUSED].container);
    let hash;
    try {
      hash = await submit(await update(true, 4));
      await listedOn([0, 1], hash, `${name} listed with mesh on again on the running hosts`);
    } finally {
      await unpauseHostContainer(env.clients[PAUSED].container);
    }
    await listedOn(HOSTS, hash, `${name} listed with mesh on again on every host`);
    const height = await heightOf(hash);

    const history = await (await dbClient(1).messages()).find({ hash: { $in: hashes } }, { projection: { _id: 0 } }).toArray();
    expect(history).to.have.lengthOf(hashes.length);
    await (await dbClient(LATE + 1).messages()).insertMany(history);
    const late = await env.startNode(LATE);
    await waitForAppInstalled(late, name, 480000);

    const events = await Promise.all([...HOSTS.map((i, k) => foundedSince(i, marks[k], 300000)), foundedSince(LATE, 0, 300000)]);
    expect(new Set(events.map((e) => e.data.ordinal)).size, 'four hosts, four ordinals').to.equal(4);

    const records = await Promise.all([...HOSTS, LATE].map(recordOn));
    records.forEach((record, k) => {
      const node = [...HOSTS, LATE][k];
      console.log(`# founding on node ${node}: components ${JSON.stringify(record?.components ?? null)}; anchors [${Object.keys(record?.anchors ?? {}).join(', ')}]`);
      expect(Object.values(record?.components ?? {}).map((c) => c.anchorHeight), `node ${node} pins at the second turn-on`).to.deep.equal([height]);
    });
    const keys = records.map((record) => Object.keys(record.components).join());
    expect(new Set(keys).size, 'one component key on every node').to.equal(1);
  });
});
