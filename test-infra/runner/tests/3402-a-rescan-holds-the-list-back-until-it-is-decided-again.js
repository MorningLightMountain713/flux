// fleet: 3
/*
 * A rescan holds the app list back until it is decided again.
 *
 * One node is rescanned from below the block that paid for an app it lists,
 * and held at the point where the rewind has rebuilt its histories and chain
 * state is not yet consistent. While it is held, that node reports chain state
 * and the app list not consistent and serves no app list, and still takes a
 * registration relayed to it: its scan is stopped too, so it holds the contents
 * without the payment. Released, it raises both again, lists the rescanned app
 * under the identity it held, and applies the registration that arrived
 * meanwhile.
 *
 * The apps are installed nowhere: every spawner is held for them.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { authenticate } from '../auth.js';
import { fluxTeamKey } from '../framework/keys.js';
import { bootAndPeer, holdSpawnerExcept } from '../framework/reconciler-suite.js';
import { buildSeedableApp } from '../framework/seed-helper.js';
import { deliverAppMessage } from '../framework/app-delivery.js';
import { advanceBlock, queueAppTx } from '../framework/daemon-control.js';
import { capabilityStates, waitForCapabilityState } from '../framework/capability-state.js';
import { dbClient } from '../framework/db-client.js';
import { waitFor } from '../framework/wait.js';

const NODES = 3;
const RUNNING = [0, 1, 2];
const REGISTRAR = 0; // handed every message the chain pays for
const RESCANNED = 1;
const HELD = 'chainState:beforeConsistent';
const CONVERGE_MS = 240000;

describe('a rescan holds the app list back until it is decided again', function () {
  let env;
  const base = `rescan${Date.now()}`;
  const listed = {}; // listed before the rescan, from below whose payment it rescans
  const meanwhile = {}; // paid and relayed while the rescanned node is held
  let released = true;

  const node = () => env.clients[RESCANNED];
  const stored = (hash) => dbClient(RESCANNED + 1).decision(hash);

  async function decisionOn(index, hash) {
    const { status, data } = await env.clients[index].request('GET', `/v2/apps/messages/${hash}/decision`);
    return status === 200 ? data.data : null;
  }

  async function appliedOn(hash, indices, label) {
    let decisions = [];
    await waitFor(async () => {
      decisions = await Promise.all(indices.map((i) => decisionOn(i, hash)));
      return decisions.every((d) => d && d.decision !== 'undecided');
    }, { timeout: CONVERGE_MS, interval: 3000, label });
    decisions.forEach((d, k) => expect(d, `node ${indices[k]}: ${label}`).to.include({ decision: 'applied' }));
  }

  async function listedOn(index, name) {
    const res = await fetch(`${env.clients[index].url}/apps/globalappsspecifications?appname=${encodeURIComponent(name)}`);
    const body = await res.json().catch(() => null);
    return { status: res.status, row: body?.status === 'success' && Array.isArray(body.data) ? body.data[0] ?? null : null };
  }

  async function release() {
    await node().releaseCheckpoint(HELD);
    released = true;
  }

  before(async function () {
    this.timeout(1200000);
    env = await createTestEnv({ hookCtx: this, nodes: NODES, arcane: true });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1 });
    listed.app = await buildSeedableApp({ name: `${base}l`, instances: 3 });
    meanwhile.app = await buildSeedableApp({ name: `${base}m`, instances: 3 });
    await holdSpawnerExcept(env, listed.app.spec.name, []);
    await holdSpawnerExcept(env, meanwhile.app.spec.name, []);
    await deliverAppMessage(env, listed.app.message, [REGISTRAR]);
    await appliedOn(listed.app.hash, RUNNING, 'every node applies the registration the rescan reaches below');
    listed.identity = (await listedOn(RESCANNED, listed.app.spec.name)).row?.identity;
    expect(listed.identity, 'the node to be rescanned lists the app under an identity').to.be.a('string').and.not.equal('');
    listed.height = (await stored(listed.app.hash))?.height;
    expect(Number.isInteger(listed.height), 'the decision names the block that paid for it').to.equal(true);
  });

  after(async function () {
    this.timeout(60000);
    if (!released) await release().catch(() => {});
    await env?.teardown();
  });

  it('holds chain state and the app list down while the rescan is held', async function () {
    this.timeout(CONVERGE_MS);
    await node().holdCheckpoint(HELD);
    released = false;
    const mark = node().getLastEventId();
    const { zelidauth } = await authenticate(node().url, fluxTeamKey());
    const res = await node().getAuthed(`/explorer/rescan/${listed.height - 1}`, zelidauth);
    expect(res.status, `the rescan starts: ${JSON.stringify(res)}`).to.equal('success');
    await node().waitForEvent('checkpoint:held', (d) => d.name === HELD, 120000, { afterId: mark });

    const states = await capabilityStates(node());
    expect(states.get('chainStateConsistent').state, 'chain state is not consistent while held').to.not.equal('up');
    expect(states.get('appRegistryConsistent').state, 'the app list is not consistent while held').to.not.equal('up');
  });

  it('serves no app list while the rescan is held', async function () {
    this.timeout(60000);
    const { status, row } = await listedOn(RESCANNED, listed.app.spec.name);
    expect(status, 'the list is refused, not served').to.equal(503);
    expect(row).to.equal(null);
  });

  it('takes a registration relayed to it while the rescan is held', async function () {
    this.timeout(CONVERGE_MS);
    await deliverAppMessage(env, meanwhile.app.message, [REGISTRAR]);
    await waitFor(async () => (await (await dbClient(RESCANNED + 1).messages()).findOne({ hash: meanwhile.app.hash, held: true })) !== null, {
      timeout: 60000, interval: 2000, label: 'the held node stores the registration relayed to it',
    });
  });

  it('lists the rescanned app under the identity it held, and applies what arrived meanwhile, once released', async function () {
    this.timeout(CONVERGE_MS * 2);
    await release();
    await waitForCapabilityState(node(), 'chainStateConsistent', 'up', { timeout: CONVERGE_MS });
    await waitForCapabilityState(node(), 'appRegistryConsistent', 'up', { timeout: CONVERGE_MS });
    await appliedOn(listed.app.hash, [RESCANNED], 'the rescanned node applies the app again');
    await appliedOn(meanwhile.app.hash, RUNNING, 'every node applies the registration that arrived meanwhile');
    let row = null;
    await waitFor(async () => {
      ({ row } = await listedOn(RESCANNED, listed.app.spec.name));
      return row?.hash === listed.app.hash;
    }, { timeout: CONVERGE_MS, interval: 3000, label: 'the rescanned node lists the app again' });
    expect(row.identity, 'the identity it held').to.equal(listed.identity);
    expect((await listedOn(RESCANNED, meanwhile.app.spec.name)).row?.hash).to.equal(meanwhile.app.hash);
  });
});
