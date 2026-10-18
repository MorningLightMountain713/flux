// fleet: 3
/*
 * A month on one clock: the chain, the nodes and the signer move together.
 *
 * The suite shares the harness clock (harness-clock.js), so FluxOS judges a
 * message's timestamp and its payment's block on the same time, as a real
 * network does after a month:
 *   - a node's own clock and the chain's tip move by what the suite advances;
 *   - one node's clock set ahead moves that node alone;
 *   - a v9 app whose term has passed leaves every node;
 *   - its last owner renews it, and it comes back with the identity it held.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { appOwnerKey } from '../framework/keys.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { confirmOnChain } from '../framework/app-helper.js';
import { manifestStanding, registerEncryptedV9App, updateEncryptedV9App } from '../framework/content-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { appView } from '../framework/app-view.js';
import { getState } from '../framework/daemon-control.js';
import { advanceHarnessClock, harnessNow, setNodeClockSkew } from '../framework/harness-clock.js';
import { waitFor } from '../framework/wait.js';

const NODES = 3;
const CONVERGE_MS = 240000;
const HOUR_S = 3600;
const DAY_S = 24 * HOUR_S;
const TERM_S = 30 * DAY_S;
// what a node's clock may differ from the suite's by: the reads are not simultaneous
const SKEW_MS = 60000;

describe('a month on one clock', function () {
  let env;
  let view;
  let identity;
  const owner = appOwnerKey();
  const name = `onemonth${Date.now()}`;
  const shape = {
    instances: 3,
    ttl: TERM_S,
    components: {
      web: {
        name: 'web',
        description: 'a month on one clock',
        image: `${REGISTRY_REPO_HOST}/${name}:v1`,
        cpu: 0.5,
        memory: 300,
        rootFsGb: 2,
        persistentStorage: {
          sizeGb: 1,
          mounts: { '/appdata': { source: 'appdata', destination: '/appdata' } },
        },
        ports: { http: { containerPort: 80, hostPort: 31215 } },
      },
    },
  };
  const nodes = () => env.clients.map((c, i) => i).filter((i) => env.clients[i]);
  const url = (i) => env.clients[i].url;
  // the node's own clock: a login phrase begins with the time the node issued it, ms
  const nodeNow = async (i) => {
    const res = await env.clients[i].getLoginPhrase();
    expect(res.status, `node ${i} issues a login phrase: ${JSON.stringify(res).slice(0, 200)}`).to.equal('success');
    return Number(String(res.data).slice(0, 13));
  };

  before(async function () {
    this.timeout(1200000);
    env = await createTestEnv({ hookCtx: this, nodes: NODES, harnessClock: true });
    await bootAndPeer(env, { pricing: true });
    view = appView(env, name, { component: 'web', timeout: CONVERGE_MS });

    await pushImage(name, 'v1');
    const reg = await registerEncryptedV9App(url(0), { name, ownerKey: owner, ...shape });
    expect(reg.status, `the registration is accepted: ${JSON.stringify(reg).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(reg.data, nodes().map((i) => env.clients[i]));
    await waitFor(async () => (await Promise.all(nodes().map((i) => view.listedOn(i)))).every(Boolean), {
      timeout: CONVERGE_MS, interval: 5000, label: 'the app is listed on every node',
    });
    ({ identity } = await manifestStanding(url(0), name));
    expect(identity, 'the node holds the app\'s identity').to.be.a('string');
  });

  after(async function () {
    this.timeout(120000);
    if (env) await env.teardown();
  });

  it('moves every node\'s clock and the chain\'s tip by what the suite advances', async function () {
    this.timeout(CONVERGE_MS);
    const before = await Promise.all(nodes().map(nodeNow));
    const tipBefore = (await getState()).tipTime;
    await advanceHarnessClock(DAY_S);
    const now = harnessNow();
    const after = await Promise.all(nodes().map(nodeNow));
    after.forEach((t, k) => {
      expect(t - before[k], `node ${k}'s clock moved by the day`).to.be.at.least(DAY_S * 1000);
      expect(Math.abs(t - now), `node ${k} reads the suite's time`).to.be.below(SKEW_MS);
    });
    const tipAfter = (await getState()).tipTime;
    expect(tipAfter - tipBefore, 'the tip carries the day').to.be.at.least(DAY_S);
    expect(Math.abs(tipAfter * 1000 - now), 'the tip reads the suite\'s time').to.be.below(SKEW_MS);
  });

  it('runs one node\'s clock an hour ahead and leaves every other node and the tip on the suite\'s', async function () {
    this.timeout(CONVERGE_MS);
    const skewed = 2;
    try {
      await setNodeClockSkew(skewed, HOUR_S);
      const now = harnessNow();
      const read = await Promise.all(nodes().map(nodeNow));
      read.forEach((t, k) => {
        const expected = k === skewed ? now + HOUR_S * 1000 : now;
        expect(Math.abs(t - expected), `node ${k} reads ${k === skewed ? 'an hour past ' : ''}the suite's time`).to.be.below(SKEW_MS);
      });
      expect((await getState()).tipTime * 1000, 'the tip stays on the suite\'s time').to.be.below(harnessNow() + SKEW_MS);
    } finally {
      await setNodeClockSkew(skewed, 0);
    }
    expect(Math.abs((await nodeNow(skewed)) - harnessNow()), `node ${skewed} reads the suite's time again`).to.be.below(SKEW_MS);
  });

  it('removes a v9 app whose term has passed from every node', async function () {
    this.timeout(CONVERGE_MS);
    await advanceHarnessClock(TERM_S);
    await waitFor(async () => (await Promise.all(nodes().map((i) => view.listedOn(i)))).every((row) => row === null), {
      timeout: CONVERGE_MS, interval: 5000, label: 'the expired app leaves every node',
    });
  });

  it('lists the app again when its last owner renews it, with the identity it held', async function () {
    this.timeout(CONVERGE_MS * 2);
    const renewal = await updateEncryptedV9App(url(0), { name, ownerKey: owner, ...shape });
    expect(renewal.status, `the renewal is accepted: ${JSON.stringify(renewal).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(renewal.data, nodes().map((i) => env.clients[i]));
    // each node's word on the paid renewal, named in the failure when it refuses
    const decisionOn = async (i) => {
      const res = await fetch(`${url(i)}/v2/apps/messages/${renewal.data}/decision`);
      return res.ok ? (await res.json()).data ?? null : null;
    };
    let decisions = [];
    await waitFor(async () => {
      decisions = await Promise.all(nodes().map(decisionOn));
      return decisions.every((d) => d && d.decision !== 'undecided');
    }, { timeout: CONVERGE_MS, interval: 5000, label: 'every node decides the renewal' });
    decisions.forEach((d, k) => expect(d.decision, `node ${k} decides the renewal: ${JSON.stringify(d)}`).to.equal('applied'));
    await waitFor(async () => (await Promise.all(nodes().map((i) => view.listedOn(i)))).every(Boolean), {
      timeout: CONVERGE_MS, interval: 5000, label: 'the renewed app is listed on every node',
    });
    for (const i of nodes()) {
      // eslint-disable-next-line no-await-in-loop -- one node at a time, named in the failure
      expect((await manifestStanding(url(i), name)).identity, `node ${i} holds the identity the app held`).to.equal(identity);
    }
  });
});
