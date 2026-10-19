// fleet: 4
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { listedIdentity, registerEncryptedV9App, updateEncryptedV9App } from '../framework/content-helper.js';
import { queueAppTx, advanceBlocks } from '../framework/daemon-control.js';
import { waitFor, waitForAppInstalled } from '../framework/wait.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { dbClient } from '../framework/db-client.js';

// A host that learns a mesh app after it was updated takes an ordinal no other
// host holds.
//
// Three nodes host a mesh app and found ordinals 0, 1 and 2. The app is then
// updated to four instances, and a fourth node that has never run joins: it
// learns the app from the network's history, not from watching it change, and
// is placed as the fourth host. It holds the app's registration and update
// before it starts, as a node does that first runs v9 after the update, so it
// decides both in one pass and never sees the app at its registration alone. The ordinal it founds is 3 - the lowest free
// one - and every ordinal names one host.
//
// An ordinal register is addressed by the app's founding height. The hosts that
// watched the registration hold that height; the joiner must reach the same one
// from history, or it asks a register nobody else writes, finds ordinal 0 free
// there, and takes it while node 0 holds it.

const NODES = 4;
const LATE = 3;
const FIRST_HOSTS = [0, 1, 2];

describe('a late host takes a free mesh ordinal', function () {
  let env;
  let name;
  let identity = null;
  let registrationHash = null;
  const holders = new Map(); // ordinal -> holder outpoint

  // The hash of the message a node lists the app at, or null.
  async function listedHash(client) {
    try {
      const res = await fetch(`${client.url}/apps/globalappsspecifications?appname=${encodeURIComponent(name)}`);
      const body = await res.json();
      return body.status === 'success' && Array.isArray(body.data) ? body.data[0]?.hash ?? null : null;
    } catch {
      return null;
    }
  }

  // The ordinal a node founds for the app after an event id, with its holder.
  function founded(client, afterId, timeout) {
    return client.waitForEvent(
      'quorumGrant:ordinalFounded',
      (data) => data.identity === identity,
      timeout,
      { afterId },
    );
  }

  before(async function () {
    this.timeout(600000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      deferredNodes: 1,
      tickerAutostart: false,
      arcane: true,
      // The founding photos pin committees at spec heights, which needs the
      // anchored membership history the ZMQ delta path keeps.
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

  it('three hosts found ordinals 0, 1 and 2', async function () {
    this.timeout(600000);
    name = `e2elateord${Date.now()}`;
    const marks = FIRST_HOSTS.map((i) => env.clients[i].getLastEventId());

    const reg = await registerEncryptedV9App(env.clients[0].url, {
      name, instances: 3, image: `${REGISTRY_REPO_HOST}/e2e-pause:v1`, specOverrides: { network: { mesh: true } },
    });
    expect(reg.status, JSON.stringify(reg)).to.equal('success');
    registrationHash = reg.data;
    await queueAppTx(reg.data);
    await advanceBlocks(3);

    await waitFor(async () => {
      const rows = await Promise.all(FIRST_HOSTS.map((i) => env.clients[i].getAppSpecs(name).catch(() => null)));
      return rows.every((r) => r?.status === 'success' && r.data?.name === name);
    }, { timeout: 120000, interval: 3000, label: `${name} listed on the first hosts` });
    identity = await listedIdentity(env.clients[0].url, name);
    await Promise.all(FIRST_HOSTS.map((i) => waitForAppInstalled(env.clients[i], name, 240000)));

    const events = await Promise.all(FIRST_HOSTS.map((i, k) => founded(env.clients[i], marks[k], 300000)));
    events.forEach((event) => holders.set(event.data.ordinal, event.data.holder));
    expect([...holders.keys()].sort(), 'one ordinal each, the lowest three').to.deep.equal([0, 1, 2]);
  });

  it('a node that learns the app after its update founds ordinal 3, held by no other host', async function () {
    this.timeout(900000);
    const update = await updateEncryptedV9App(env.clients[0].url, {
      name, instances: 4, image: `${REGISTRY_REPO_HOST}/e2e-pause:v1`, specOverrides: { network: { mesh: true } },
    });
    expect(update.status, JSON.stringify(update)).to.equal('success');
    await queueAppTx(update.data);
    await advanceBlocks(3);
    await waitFor(async () => {
      const hashes = await Promise.all(FIRST_HOSTS.map((i) => listedHash(env.clients[i])));
      return hashes.every((hash) => hash === update.data);
    }, { timeout: 120000, interval: 3000, label: `${name} listed at its update on the first hosts` });

    const hashes = [registrationHash, update.data];
    const history = await (await dbClient(1).messages()).find({ hash: { $in: hashes } }, { projection: { _id: 0 } }).toArray();
    expect(history.map((record) => record.hash).sort(), 'node 0 holds both messages').to.deep.equal([...hashes].sort());
    await (await dbClient(LATE + 1).messages()).insertMany(history);

    const late = await env.startNode(LATE);
    await waitForAppInstalled(late, name, 480000);
    const event = await founded(late, 0, 300000);

    // Where each node pins the app: every ordinal register is addressed by it.
    for (const index of [0, LATE]) {
      // eslint-disable-next-line no-await-in-loop
      const record = await dbClient(index + 1).foundingRecord(identity);
      console.log(`# founding on node ${index}: components ${JSON.stringify(record?.components ?? null)}; anchors [${Object.keys(record?.anchors ?? {}).join(', ')}]; specHeight ${record?.specHeight}; mappedHeight ${record?.mappedHeight}`);
    }

    expect(holders.get(event.data.ordinal), `ordinal ${event.data.ordinal} already held`).to.equal(undefined);
    expect(event.data.ordinal, 'the lowest free ordinal').to.equal(3);
  });
});
