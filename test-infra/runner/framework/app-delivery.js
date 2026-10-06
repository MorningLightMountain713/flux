// How an app the network already has reaches a fleet. The chain carries the
// message's payment and a node is handed the message it is missing; the node
// records the payment from its own scan, stores the message, decides it and
// lists the app. Nothing is written into a node's database.
import { advanceBlock, queueAppTx } from './daemon-control.js';
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
 * Waits for a node to decide a message it holds. The registry row of an
 * applied message is written before its decision is, so an applied answer
 * means the node lists the app.
 */
async function applied(client, message, name, timeout) {
  let verdict = null;
  await waitFor(async () => {
    const { status, data } = await client.request('GET', `/v2/apps/messages/${message.hash}/decision`);
    if (status !== 200 || data.data.decision === 'undecided') return false;
    verdict = data.data;
    return true;
  }, { timeout, interval: 1000, label: `node ${client.num} decides the message of ${name}` });
  if (verdict.decision !== 'applied') {
    throw new Error(`node ${client.num} decided the message of ${name} ${verdict.decision}${verdict.reason ? `: ${verdict.reason}` : ''}`);
  }
}

/**
 * Hands each of the given nodes a message whose payment the chain already
 * carries. Resolves once every one of them has applied it; a node that refuses
 * the message, or decides against it, fails the call with the node's own reason.
 *
 * @param {object} env - the test environment
 * @param {object} message - the message as signed
 * @param {number[]} indices - the nodes to hand it to; an index with no node is passed over
 * @param {{timeout?: number}} [options] - how long each node is given
 */
export async function handAppMessage(env, message, indices, { timeout = 120000 } = {}) {
  const clients = indices.map((i) => env.clients[i]).filter(Boolean);
  const { name } = message.appSpecifications;
  await Promise.all(clients.map(async (client) => {
    await hand(client, message, name, timeout);
    await applied(client, message, name, timeout);
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
