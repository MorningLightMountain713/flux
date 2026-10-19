// fleet: 3
/*
 * The capability readout after boot.
 *
 * Once a node has booted and peered, /v2/node/capabilities reports every
 * capability present on it up, each with its first rise; the blame lists none
 * still waiting; the critical chain runs from a capability that waited on no
 * prerequisite, through prerequisites each declared by the next link, to the
 * capability that came up last. Restarted, the node's history holds the
 * process before this one, with its own rises, beside this one's.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { authenticate } from '../auth.js';
import { fluxTeamKey } from '../framework/keys.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { waitFor } from '../framework/wait.js';

const NODES = 3;
const SUBJECT = 0;
const UP_MS = 300000;

describe('the capability readout after boot', function () {
  let env;
  let capabilities = [];

  const node = () => env.clients[SUBJECT];

  let zelidauth = null;

  // A readout route's answer, as the Flux team; a session the node no longer
  // holds (a restart ends them) is renewed once.
  async function readout(path) {
    if (!zelidauth) ({ zelidauth } = await authenticate(node().url, fluxTeamKey()));
    let res = await node().getAuthed(`/v2/node${path}`, zelidauth, { noCache: true });
    if (!res?.data) {
      ({ zelidauth } = await authenticate(node().url, fluxTeamKey()));
      res = await node().getAuthed(`/v2/node${path}`, zelidauth, { noCache: true });
    }
    expect(res?.data, `/v2/node${path} answers: ${JSON.stringify(res).slice(0, 300)}`).to.exist;
    return res.data;
  }

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({ hookCtx: this, nodes: NODES, arcane: true });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1 });
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('reports every capability present on the node up, each with its first rise', async function () {
    this.timeout(UP_MS);
    await waitFor(async () => {
      capabilities = await readout('/capabilities');
      return capabilities.every((c) => c.state === 'up');
    }, {
      timeout: UP_MS,
      interval: 5000,
      label: 'every capability up',
    }).catch((error) => {
      const down = capabilities.filter((c) => c.state !== 'up').map((c) => `${c.name} ${c.state}: ${c.reason} (waiting on ${c.waitingOn})`);
      throw new Error(`${error.message}: ${down.join('; ')}`);
    });
    expect(capabilities.length, 'the node reports its capabilities').to.be.above(10);
    capabilities.forEach((c) => {
      expect(c.firstUp, `${c.name} has a first rise`).to.be.an('object');
      expect(c.firstUp.at, `${c.name} first rose no later than it rose last`).to.be.at.most(c.since);
    });
  });

  it('blames no capability for still waiting, slowest first', async function () {
    this.timeout(60000);
    const rows = await readout('/capabilities/blame');
    expect(rows.map((r) => r.name).sort()).to.deep.equal(capabilities.map((c) => c.name).sort());
    rows.forEach((r) => expect(r.upAfterMs, `${r.name} came up`).to.be.a('number'));
    const order = rows.map((r) => r.upAfterMs);
    expect(order, 'slowest first').to.deep.equal([...order].sort((a, b) => b - a));
  });

  it('follows a critical chain of what each capability waited on to the capability that came up last', async function () {
    this.timeout(60000);
    const chain = await readout('/capabilities/critical-chain');
    // The last capability up on a boot waited on something before it.
    expect(chain.length, 'the chain goes back past the last capability up').to.be.at.least(2);
    const byName = new Map(capabilities.map((c) => [c.name, c]));
    const last = capabilities.reduce((latest, c) => (c.firstUp.at >= latest.firstUp.at ? c : latest));
    expect(byName.get(chain[chain.length - 1].name).firstUp.at, 'the chain ends at the last capability up').to.equal(last.firstUp.at);
    for (let k = 1; k < chain.length; k += 1) {
      const waitedOn = [...byName.get(chain[k].name).needs, ...byName.get(chain[k].name).waits];
      expect(waitedOn, `${chain[k].name} declares or waited for ${chain[k - 1].name}`).to.include(chain[k - 1].name);
      expect(chain[k].upAfterMs, `${chain[k].name} came up after ${chain[k - 1].name}`).to.be.at.least(chain[k - 1].upAfterMs);
    }
    const first = byName.get(chain[0].name);
    const risenBefore = [...first.needs, ...first.waits].filter((n) => byName.get(n)?.firstUp && byName.get(n).firstUp.at <= first.firstUp.at);
    expect(risenBefore, `${first.name}, the first link, waited on no prerequisite that rose`).to.deep.equal([]);
  });

  it('holds the previous process in its history once restarted, beside this one', async function () {
    this.timeout(UP_MS);
    const before = await readout('/boot');
    await env.restartNode(SUBJECT);
    let boots = [];
    await waitFor(async () => {
      boots = await readout('/capabilities/history');
      return boots.length >= 2 && boots[0].startedAt !== before.startedAt;
    }, { timeout: UP_MS, interval: 5000, label: 'the history holds both processes' });
    const now = await readout('/boot');
    expect(boots[0].startedAt, 'the newest process is this one').to.equal(now.startedAt);
    const previous = boots.find((b) => b.startedAt === before.startedAt);
    expect(previous, 'the process before the restart is in the history').to.exist;
    const rose = new Set(previous.transitions.filter((t) => t.to === 'up').map((t) => t.name));
    capabilities.forEach((c) => expect(rose.has(c.name), `the previous process's history has ${c.name} rising`).to.equal(true));
  });
});
