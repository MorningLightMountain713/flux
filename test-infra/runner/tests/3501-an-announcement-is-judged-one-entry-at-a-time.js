// fleet: 4
import {
  describe, it, before, after,
} from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { getSubnetConfig } from '../framework/subnet-config.js';
import { assertNoEvent } from '../framework/wait.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { execInContainer } from '../framework/container.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';

// A version 2 apprunning message names every app its sender holds. Each entry is
// judged on its own: one without a name and a hash is refused and the rest of the
// message is stored and relayed as if it were not there. Each node says what it
// did with a message in one network:apprunning event: the entries it wrote, the
// names it refused, whether it cleared the sender's rows, and whether it relayed.
//
// The stub peer is a listed node with its own key. Nodes 1 and 2 cannot reach it,
// so they hear what it says only through node 0's relay, and a message node 0
// does not store goes no further.

const REAL_NODES = 3;
const STUB_INDEX = 3;
const realNodes = Array.from({ length: REAL_NODES }, (_unused, i) => i);
const BEHIND_RELAY = [1, 2];
// A node names itself in its messages by its socket address, a stub by its IP.
const bare = (address) => String(address).replace(/:16127$/, '');

describe('an announcement is judged one entry at a time', function () {
  let env;
  dumpLogsOnFailure(() => env);
  let stub;
  const stamp = Date.now();
  const stubIp = () => getSubnetConfig().nodeIp(STUB_INDEX + 1);
  // Whether node i lists the app at the address, read now.
  const locatedAt = async (i, name, address) => (await env.clients[i].getAppLocationsAt(name, address)).length > 0;
  const marks = () => realNodes.map((i) => env.clients[i].getLastEventId());
  // What each node did with the message from `ip` that names `name`, after `afterIds`.
  const handledBy = (nodes, afterIds, ip, name, timeout = 60000) => Promise.all(nodes.map(async (i) => (await env.clients[i].waitForEvent(
    'network:apprunning',
    (d) => bare(d.ip) === bare(ip) && [...(d.apps ?? []).map((a) => a.name), ...(d.refused ?? [])].includes(name),
    timeout,
    { afterId: afterIds[i] },
  )).data));
  const everyNodeStored = async (afterIds, ip, name) => {
    const handled = await handledBy(realNodes, afterIds, ip, name);
    handled.forEach((d, i) => expect(d.apps.map((a) => a.name), `node ${i} did not store ${name}`).to.include(name));
    return handled;
  };
  const message = (apps) => ({
    type: 'fluxapprunning', version: 2, apps, ip: stubIp(), broadcastedAt: Date.now(), osUptime: 10000, staticIp: false,
  });

  before(async function () {
    this.timeout(420000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: REAL_NODES + 1,
      stubPeers: [STUB_INDEX],
      stubPeeredWith: { [STUB_INDEX]: [0] },
      tickerAutostart: false,
      configOverrides: { fluxapps: { minOutgoing: 1, minIncoming: 1 } },
    });
    stub = env.stubPeerClients.get(STUB_INDEX);
    // Nodes 1 and 2 cannot reach the stub, cut off before the fleet peers so
    // neither ever holds a connection to it.
    await Promise.all(BEHIND_RELAY.map(async (i) => {
      const cut = await execInContainer(env.clients[i].container,
        `iptables -I INPUT -s ${stubIp()} -j DROP && iptables -I OUTPUT -d ${stubIp()} -j DROP`);
      if (cut.exitCode !== 0) throw new Error(`fixture: node ${i} could not cut the stub off (exit ${cut.exitCode}): ${cut.output}`);
    }));
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1 });
    const peeredWithStub = await Promise.all(BEHIND_RELAY.map(async (i) => {
      const [outgoing, incoming] = await Promise.all([env.clients[i].getPeers(), env.clients[i].getIncomingPeers()]);
      return JSON.stringify([...(outgoing.data ?? []), ...(incoming.data ?? [])]).includes(stubIp());
    }));
    expect(peeredWithStub, 'fixture: a node behind the relay is peered with the stub').to.deep.equal([false, false]);
    expect(await stub.connectedNodes(), 'fixture: the stub holds connections beyond node 0').to.equal(1);
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('stores and relays the entries with a name and hash, and refuses the one without', async function () {
    this.timeout(120000);
    const kept = `e2eentrykept${stamp}`;
    const refused = `e2eentryrefused${stamp}`;
    const afterIds = marks();

    const sent = await stub.broadcast(message([
      { name: kept, hash: `hash-${kept}`, runningSince: new Date().toISOString() },
      { name: refused, runningSince: new Date().toISOString() },
    ]));
    expect(sent.sent, 'fixture: the message reached node 0 and no other').to.equal(1);

    const handled = await everyNodeStored(afterIds, stubIp(), kept);
    handled.forEach((d, i) => {
      expect(d.refused, `node ${i} did not refuse the entry without a hash`).to.deep.equal([refused]);
      expect(d.apps.map((a) => a.name), `node ${i} wrote the entry without a hash`).to.not.include(refused);
    });
    expect(handled[0].relayed, 'node 0 did not relay the message to the nodes behind it').to.equal(true);
    // eslint-disable-next-line no-restricted-syntax
    for (const i of realNodes) {
      // eslint-disable-next-line no-await-in-loop
      expect(await locatedAt(i, kept, stubIp()), `node ${i} lists no location for the entry with a hash`).to.equal(true);
      // eslint-disable-next-line no-await-in-loop
      expect(await locatedAt(i, refused, stubIp()), `node ${i} lists a location for the entry without a hash`).to.equal(false);
    }
  });

  // An empty v2 message deletes the sender's rows. A message whose entries were
  // all refused named apps: it stores nothing, goes no further, and is never
  // read as one that named none.
  it('stores and relays nothing of a message whose every entry is refused, and keeps the sender\'s rows', async function () {
    this.timeout(180000);
    const held = `e2eentryheld${stamp}`;
    const refusedOnly = `e2eentryrefusedonly${stamp}`;
    const marker = `e2eentrymarker${stamp}`;
    let afterIds = marks();
    await stub.runApp(held, { hash: `hash-${held}` });
    await everyNodeStored(afterIds, stubIp(), held);

    afterIds = marks();
    await stub.broadcast(message([{ name: refusedOnly }]));
    // A node handles one peer's messages in the order they were sent, so a node
    // that stored this has handled the refused message before it. It names every
    // app the stub holds, as a node's announcement does.
    await stub.broadcast(message([held, marker].map((name) => ({ name, hash: `hash-${name}`, runningSince: new Date().toISOString() }))));
    await everyNodeStored(afterIds, stubIp(), marker);

    const [onNodeZero] = await handledBy([0], afterIds, stubIp(), refusedOnly);
    expect(onNodeZero).to.deep.include({ apps: [], refused: [refusedOnly], cleared: false, relayed: false });
    // Relayed, it would have reached them before the marker did.
    await Promise.all(BEHIND_RELAY.map((i) => assertNoEvent(env.clients[i], 'network:apprunning',
      (d) => d.refused?.includes(refusedOnly), 0, { afterId: afterIds[i] })));
    // eslint-disable-next-line no-restricted-syntax
    for (const i of realNodes) {
      // eslint-disable-next-line no-await-in-loop
      expect(await locatedAt(i, held, stubIp()), `node ${i} deleted the sender's rows`).to.equal(true);
    }
  });

  // What the case above guards against is real: a message naming no apps does
  // delete the sender's rows, on node 0 and on the nodes behind it.
  it('deletes the sender\'s rows on a message that names no apps', async function () {
    this.timeout(120000);
    const held = `e2eentrycleared${stamp}`;
    let afterIds = marks();
    await stub.runApp(held, { hash: `hash-${held}` });
    await everyNodeStored(afterIds, stubIp(), held);

    afterIds = marks();
    await stub.broadcast(message([]));
    await Promise.all(realNodes.map((i) => env.clients[i].waitForEvent(
      'network:apprunning', (d) => bare(d.ip) === bare(stubIp()) && d.cleared === true, 60000, { afterId: afterIds[i] },
    )));
    // eslint-disable-next-line no-restricted-syntax
    for (const i of realNodes) {
      // eslint-disable-next-line no-await-in-loop
      expect(await locatedAt(i, held, stubIp()), `node ${i} kept the sender's rows`).to.equal(false);
    }
  });
});
