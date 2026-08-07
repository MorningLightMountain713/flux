// weight: light
import { describe, it, before, after, beforeEach } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import {
  advanceBlocks, getJournal, clearJournal, resetNodeList,
} from '../framework/daemon-control.js';
import {
  waitForDaemonReady, waitForListAnchored, waitForSubscriptionMode, waitFor,
} from '../framework/wait.js';
import { getSubnetConfig } from '../framework/subnet-config.js';

const subnet = getSubnetConfig();

// The journal counts what reached the daemon. A cache hit produces no wire call and so
// no entry, which makes "was this cached" arithmetic rather than introspection.
async function callsTo(method, nodeIp) {
  const { total } = await getJournal({ method, sourceIp: nodeIp, server: 'fluxd' });
  return total;
}

describe('Daemon RPC: nothing is cached', function () {
  let env;
  let client;
  let nodeIp;

  before(async function () {
    this.timeout(180000);
    env = await createTestEnv({ hookCtx: this, nodes: 1, tickerAutostart: false });
    [client] = env.clients;
    nodeIp = subnet.nodeIp(1);
    await waitForDaemonReady(client);
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  beforeEach(async function () {
    this.timeout(20000);
    await clearJournal();
  });

  it('should ask the daemon again for a repeated read', async function () {
    this.timeout(60000);

    // Two identical requests inside what used to be a 20 second cache window.
    // noCache defeats the route's own apicache, so both requests reach the service and
    // the only thing that could collapse them into one wire call is an RPC cache.
    await client.get('/daemon/getblockcount', { noCache: true });
    await client.get('/daemon/getblockcount', { noCache: true });

    expect(await callsTo('getblockcount', nodeIp)).to.equal(2);
  });

  it('should ask the daemon again for a call that acts as well as answers', async function () {
    this.timeout(60000);

    // getnewaddress takes no parameters, so a cache keyed on the method name alone
    // returned the SAME address twice — fund both and you have funded one.
    await client.get('/daemon/getnewaddress', { noCache: true }).catch(() => null);
    await client.get('/daemon/getnewaddress', { noCache: true }).catch(() => null);

    expect(await callsTo('getnewaddress', nodeIp)).to.equal(2);
  });

  it('should ask the daemon again for the same block by hash', async function () {
    this.timeout(60000);

    const best = await client.get('/daemon/getbestblockhash', { noCache: true });
    const hash = best.data;
    expect(hash, 'no best block hash to ask for').to.be.a('string');
    await clearJournal();

    // A hash names the same block on either chain but not the same answer: the verbose
    // response carries confirmations, which grows every block and reads -1 once the
    // block leaves the main chain.
    await client.get(`/daemon/getblock/${hash}/2`, { noCache: true });
    await client.get(`/daemon/getblock/${hash}/2`, { noCache: true });

    expect(await callsTo('getblock', nodeIp)).to.equal(2);
  });
});

describe('Daemon RPC: what push costs against what polling cost', function () {
  let env;
  let client;
  let nodeIp;

  before(async function () {
    this.timeout(180000);
    env = await createTestEnv({
      hookCtx: this, nodes: 1, tickerAutostart: false, zmqTopics: ALL_ZMQ_TOPICS,
    });
    [client] = env.clients;
    nodeIp = subnet.nodeIp(1);
    await waitForDaemonReady(client);
    await waitForSubscriptionMode(client, 'nodeListSource', 'push');
    await waitForListAnchored(client);
  });

  after(async function () {
    this.timeout(30000);
    await resetNodeList().catch(() => {});
    await env?.teardown();
  });

  it('should not fetch the node list once per block', async function () {
    this.timeout(180000);

    await clearJournal();
    await advanceBlocks(10);

    // Let the last delta land before counting.
    await waitFor(async () => {
      const state = await client.getFluxInfo();
      return state.status === 'success';
    }, { timeout: 30000, interval: 2000, label: 'node responsive after the blocks' });

    // This is the claim the workstream rests on: the list used to be refetched roughly
    // once a block, at about 7 MB a time.
    expect(await callsTo('viewdeterministiczelnodelist', nodeIp)).to.equal(0);
  });

  it('should not poll the chain tip once the socket carries it', async function () {
    this.timeout(120000);

    await clearJournal();
    await advanceBlocks(6);

    // The authoritative pair still comes from RPC, but at a fraction of the old rate —
    // headers are what push cannot supply, not the height.
    const info = await callsTo('getblockchaininfo', nodeIp);
    expect(info).to.be.lessThan(6);
  });
});
