// How an app the network already has reaches a fleet. The chain carries the
// message's payment and a node is handed the message it is missing; the node
// records the payment from its own scan, stores the message, decides it and
// lists the app. Nothing is written into a node's database.
import { advanceBlock, queueAppTx } from './daemon-control.js';
import { dbClient } from './db-client.js';
import { partition, healPartition } from './partition.js';
import { getSubnetConfig } from './subnet-config.js';
import { waitFor } from './wait.js';

// The messages this process has had paid for, by hash: a message is paid for
// once however many nodes it is handed to.
const paid = new Set();

async function pay(message, valueSat) {
  if (paid.has(message.hash)) return;
  paid.add(message.hash);
  await queueAppTx(message.hash, valueSat);
  await advanceBlock();
}

/**
 * Hands a node a paid message it is missing. The node answers that it has
 * recorded no payment until its scan reaches the paying block, so the hand-over
 * is repeated until the node takes the message or refuses it.
 */
async function hand(client, message, name, timeout) {
  let refusal = null;
  await waitFor(async () => {
    const { status, data } = await client.request('POST', '/v2/apps/messages', { body: message });
    if (status === 422) {
      refusal = data?.error?.message ?? 'no reason given';
      return true;
    }
    return status === 201 || status === 200;
  }, { timeout, interval: 1000, label: `node ${client.num} takes the message of ${name} once its scan has the payment` });
  if (refusal !== null) throw new Error(`node ${client.num} refused the message of ${name}: ${refusal}`);
}

/**
 * Waits for a node to decide a message it holds, and returns the decision. The
 * registry row of an applied message is written before its decision is, so an
 * applied answer means the node lists the app. With `anyDecision` false, any
 * other decision fails the call with the node's reason.
 */
async function decided(client, message, name, timeout, anyDecision) {
  let verdict = null;
  await waitFor(async () => {
    const { status, data } = await client.request('GET', `/v2/apps/messages/${message.hash}/decision`);
    if (status !== 200 || data.data.decision === 'undecided') return false;
    verdict = data.data;
    return true;
  }, { timeout, interval: 1000, label: `node ${client.num} decides the message of ${name}` });
  if (!anyDecision && verdict.decision !== 'applied') {
    throw new Error(`node ${client.num} decided the message of ${name} ${verdict.decision}${verdict.reason ? `: ${verdict.reason}` : ''}`);
  }
  return verdict;
}

/**
 * Hands each of the given nodes a message whose payment the chain already
 * carries. Resolves once every one of them has applied it; a node that refuses
 * the message, or decides against it, fails the call with the node's own reason.
 *
 * @param {object} env - the test environment
 * @param {object} message - the message as signed
 * @param {number[]} indices - the nodes to hand it to; an index with no node is passed over
 * @param {{timeout?: number, anyDecision?: boolean}} [options] - how long each node is
 *   given, and whether a decision other than applied is accepted
 * @returns {Promise<object[]>} each node's decision, in the order of `indices`
 */
export async function handAppMessage(env, message, indices, { timeout = 120000, anyDecision = false } = {}) {
  const clients = indices.map((i) => env.clients[i]).filter(Boolean);
  const { name } = message.appSpecifications;
  return Promise.all(clients.map(async (client) => {
    await hand(client, message, name, timeout);
    return decided(client, message, name, timeout, anyDecision);
  }));
}

/**
 * Gives a fleet an app message the way the network does: its payment is mined
 * and each of the given nodes is handed the message. Every other node learns of
 * the message from its peers, in its own time.
 *
 * @param {object} env - the test environment
 * @param {object} message - a fixture's `message`: a registration or an update, as signed
 * @param {number[]} indices - the nodes to hand it to
 * @param {{valueSat?: number, timeout?: number}} [options] - what the payment is
 *   worth when not the stub chain's default, and how long each node is given
 */
export async function deliverAppMessage(env, message, indices, { valueSat, timeout = 120000 } = {}) {
  await pay(message, valueSat);
  await handAppMessage(env, message, indices, { timeout });
}

/**
 * Hands each of the given nodes every message of a log whose payments the chain
 * already carries, `concurrency` messages to a node at once.
 *
 * @param {object} env - the test environment
 * @param {object[]} messages - the messages as signed
 * @param {number[]} indices - the nodes to hand them to
 * @param {{concurrency?: number, anyDecision?: boolean, timeout?: number}} [options]
 */
export async function handAppMessages(env, messages, indices, { concurrency = 20, anyDecision = false, timeout = 300000 } = {}) {
  await Promise.all(indices.map(async (index) => {
    const next = [...messages];
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (next.length) {
        // eslint-disable-next-line no-await-in-loop
        await handAppMessage(env, next.shift(), [index], { timeout, anyDecision });
      }
    }));
  }));
}

/**
 * Waits until each of the given nodes has applied every message. A node decides
 * a message when it is handed it, and decides it again when an earlier message
 * of its app arrives: an update handed before its registration is refused at
 * first and applied once the registration lands.
 *
 * @param {object} env - the test environment
 * @param {object[]} messages - the messages as signed
 * @param {number[]} indices - the nodes
 * @param {{timeout?: number}} [options]
 */
export async function awaitApplied(env, messages, indices, { timeout = 300000 } = {}) {
  await Promise.all(indices.map(async (index) => {
    const client = env.clients[index];
    let pending = messages.map((message) => message.hash);
    await waitFor(async () => {
      const still = [];
      for (let i = 0; i < pending.length; i += 50) {
        // eslint-disable-next-line no-await-in-loop
        const answers = await Promise.all(pending.slice(i, i + 50).map(async (hash) => {
          const { status, data } = await client.request('GET', `/v2/apps/messages/${hash}/decision`);
          return status === 200 && data.data.decision === 'applied' ? null : hash;
        }));
        still.push(...answers.filter(Boolean));
      }
      pending = still;
      return pending.length === 0;
    }, { timeout, interval: 5000, label: `node ${index} applies every message (${pending.length} not yet)` });
  }));
}

/**
 * Messages a running node missed: while it is cut off from the fleet (its chain
 * feed kept), their payments are mined in one block, in the order given, and the
 * node's scan records them; the peers are handed the messages and announce them
 * to everyone but it. Then it reaches the fleet again and holds a peer. No other
 * block is mined, so its hash sync has failed to find the messages once and asks
 * again at the next block, which the caller mines. The ticker must be stopped.
 *
 * @param {object} env - the test environment
 * @param {object[]} messages - the messages as signed, in chain order
 * @param {{cutOff: number, peers: number[]}} nodes - the node that misses them, and
 *   the nodes handed them
 */
export async function deliverWhileCutOff(env, messages, { cutOff, peers }) {
  const node = env.clients[cutOff];
  await partition(env, [cutOff], { cutChain: false });
  for (const message of messages) {
    // eslint-disable-next-line no-await-in-loop
    await queueAppTx(message.hash);
    paid.add(message.hash);
  }
  await advanceBlock();
  const hashes = messages.map((message) => message.hash);
  await waitFor(async () => (await dbClient(cutOff + 1).appMessages({ hash: { $in: hashes }, paid: true })).length === hashes.length, {
    timeout: 120000, interval: 2000, label: `node ${cutOff} records the payments of ${hashes.length} messages`,
  });
  await handAppMessages(env, messages, peers, { anyDecision: true });
  await awaitApplied(env, messages, peers);
  await healPartition(env, [cutOff]);
  const peerIps = new Set(peers.map((i) => getSubnetConfig().nodeIp(i + 1)));
  const mark = node.getLastEventId();
  await env.startDiscovery([cutOff]);
  await node.waitForEvent('peers:added', (d) => peerIps.has(d.ip), 300000, { afterId: mark });
}
