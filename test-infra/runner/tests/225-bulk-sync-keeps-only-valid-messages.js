// fleet: 6
/*
 * A node that joins takes the app message log in batches from its peers and keeps exactly what
 * the owners signed, each where its own record of the chain places it, though a peer lies.
 *
 * Eleven apps carry 555 messages between them - registrations, long update chains and an owner
 * transfer - paid at chosen heights in the daemon's address index; every node starts with nothing
 * scanned and records the payments from it. The honest peers are handed every message, among them
 * an update whose signature is not its owner's and, after the transfer, an update the former owner
 * signed: a node stores both, and its decider refuses them.
 *
 * One peer lies. It holds the same log but serves an update whose contents no longer hash to its
 * hash, and another update with a block, txid and payment the chain does not give it. The joiner
 * first reaches only that peer: it must refuse the altered message and keep the misplaced one at
 * its own record. Then it reaches the honest peers, and takes the altered message whole.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { createTestEnv } from '../framework/test-env.js';
import chainStart from '../framework/chain-start.cjs';
import { authenticate, signBtcMessage } from '../auth.js';
import { appOwnerKey, fluxTeamKey, userKey } from '../framework/keys.js';
import { buildSeedableApp, buildSeedableUpdate } from '../framework/seed-helper.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { handAppMessages } from '../framework/app-delivery.js';
import { addressIndexOf, signedMessage } from '../framework/app-payments.js';
import { partition, healPartition } from '../framework/partition.js';
import { getSubnetConfig } from '../framework/subnet-config.js';
import { waitForDaemonReady, waitFor } from '../framework/wait.js';
import { dbClient } from '../framework/db-client.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';

const APPS = 10;
const UPDATES = 54;
const HONEST = [0, 1, 2, 3];
const LIAR = 4;
// The joiner: the last index, held back until the log is in place.
const JOINER = 5;
// what each payment is worth: above every fee these specs owe
const PAYMENT_SAT = 50e8;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

describe('a node that joins takes the log in batches and keeps only what the owners signed', function () {
  let env;
  dumpLogsOnFailure(() => env);

  const stamp = Date.now();
  // every message on chain, in chain order, with its payment
  const onChain = [];
  // the newest valid message of each app
  const governing = new Map();
  // hashes the joiner's decider must refuse
  const unauthorized = new Set();
  let altered;
  let misplaced;
  let joinerIp;
  // what the joiner held once only the lying peer had answered
  let afterLiar;
  let servedToJoiner;

  const onChainAt = (message, height) => {
    onChain.push({
      message: signedMessage(message), hash: message.hash, txid: sha256(`tx${message.hash}`), height, value: PAYMENT_SAT,
    });
  };

  async function triggerHashCheck(client) {
    const { zelidauth } = await authenticate(client.url, fluxTeamKey());
    await client.getAuthed('/apps/checkhashes', zelidauth, { noCache: true });
  }

  async function heldByJoiner(hashes) {
    return new Map((await dbClient(JOINER + 1).appMessages({ hash: { $in: hashes }, held: true })).map((m) => [m.hash, m]));
  }

  before(async function () {
    this.timeout(1500000);
    const base = chainStart.DEFAULT_INITIAL_HEIGHT - 2000;
    const owner = appOwnerKey();
    const newOwner = userKey();
    // what the lying peer serves in place of the honest message, by hash
    const lies = new Map();

    for (let k = 0; k < APPS; k += 1) {
      const name = `e2eBulk${k}x${stamp}`;
      // eslint-disable-next-line no-await-in-loop
      let current = await buildSeedableApp({ name });
      onChainAt(current.message, base + (k * 60));
      const chain = [current];
      for (let j = 1; j <= UPDATES; j += 1) {
        // eslint-disable-next-line no-await-in-loop
        current = await buildSeedableUpdate(current, (spec) => { spec.description = `${name} revision ${j}`; });
        onChainAt(current.message, base + (k * 60) + j);
        chain.push(current);
      }
      governing.set(name, current.hash);

      if (k === 0) {
        // Signed by nobody who owns it, and newest on chain, so it would govern the app if applied.
        const forged = await buildSeedableUpdate(current, (spec) => { spec.description = `${name} forged`; });
        const { type, version, timestamp } = forged.message;
        const spec = forged.message.appSpecifications;
        const signature = await signBtcMessage(`not this message ${timestamp}`, owner.privkey);
        const hash = sha256(type + version + JSON.stringify(spec) + timestamp + signature);
        onChainAt({ ...forged.message, signature, hash }, base + (k * 60) + UPDATES + 1);
        unauthorized.add(hash);
      }
      if (k === 1) {
        // Mid-chain; the lying peer serves its contents altered, so they no longer hash to its hash.
        const victim = chain[20].message;
        altered = { name, hash: victim.hash, description: victim.appSpecifications.description };
        lies.set(victim.hash, {
          ...signedMessage(victim),
          appSpecifications: { ...victim.appSpecifications, description: `${name} altered in transit` },
        });
      }
      if (k === 2) {
        // The lying peer places an old update above the app's newest, with another txid and payment.
        const honest = chain[10].message;
        misplaced = { name, hash: honest.hash, newest: current.hash };
        lies.set(honest.hash, {
          ...signedMessage(honest), height: base + (k * 60) + UPDATES + 1, txid: 'f'.repeat(64), valueSat: 1,
        });
      }
    }

    // Transferred to a new owner; then the former owner signs an update, then the new owner does.
    const transferName = `e2eBulkT${stamp}`;
    const transferBase = base + (APPS * 60);
    const registration = await buildSeedableApp({ name: transferName });
    onChainAt(registration.message, transferBase);
    const transfer = await buildSeedableUpdate(registration, (spec) => { spec.owner = newOwner.zelid; });
    onChainAt(transfer.message, transferBase + 1);
    const formerOwners = await buildSeedableUpdate(transfer, (spec) => { spec.description = `${transferName} by its former owner`; }, { signer: owner });
    onChainAt(formerOwners.message, transferBase + 2);
    unauthorized.add(formerOwners.hash);
    const newOwners = await buildSeedableUpdate(transfer, (spec) => { spec.description = `${transferName} by its new owner`; }, { signer: newOwner });
    onChainAt(newOwners.message, transferBase + 3);
    governing.set(transferName, newOwners.hash);

    env = await createTestEnv({
      hookCtx: this,
      nodes: 6,
      stubPeers: [LIAR],
      stubCapabilities: { [LIAR]: ['peerExchange', 'appMessageBatch'] },
      deferredNodes: 1,
      unscanned: true,
      addressIndex: addressIndexOf(onChain),
    });
    await bootAndPeer(env);
    joinerIp = getSubnetConfig().nodeIp(JOINER + 1);

    // The honest peers hold the log; each decides each message by its own rules.
    await handAppMessages(env, onChain.map(({ message }) => message), HONEST, { anyDecision: true });
    // The lying peer's log, given only now: the honest peers are not missing anything to ask it for.
    const liar = env.stubPeerClients.get(LIAR);
    await liar.loadBatchMessages(onChain.map(({ hash, message }) => lies.get(hash) ?? message));

    // First the joiner reaches the lying peer alone.
    const joiner = await env.startNode(JOINER);
    await partition(env, [JOINER], { cutChain: false, reachable: [LIAR] });
    await waitForDaemonReady(joiner);
    await joiner.waitForEvent('peers:added', (d) => d.ip === liar.ip, 300000);
    let mark = joiner.getLastEventId();
    await triggerHashCheck(joiner);
    await joiner.waitForEvent('hashSync:batchFetched', (d) => d.requests > 0, 600000, { afterId: mark });
    servedToJoiner = new Set(await liar.batchHashesServedTo(joinerIp));
    afterLiar = await heldByJoiner([altered.hash, misplaced.hash]);

    // Then the honest peers.
    await healPartition(env, [JOINER]);
    mark = joiner.getLastEventId();
    await env.startDiscovery([JOINER]);
    await joiner.waitForEvent('peers:added', (d) => HONEST.some((i) => getSubnetConfig().nodeIp(i + 1) === d.ip), 300000, { afterId: mark });
    await triggerHashCheck(joiner);
    await waitFor(async () => (await heldByJoiner(onChain.map((m) => m.hash))).size === onChain.length, {
      timeout: 600000, interval: 5000, label: 'the joiner holds every message the chain paid for',
    });
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('was served both lies by the lying peer, which alone it reached at first', function () {
    expect(servedToJoiner.has(altered.hash), 'the altered message served').to.equal(true);
    expect(servedToJoiner.has(misplaced.hash), 'the misplaced message served').to.equal(true);
  });

  it('refuses contents that do not hash to their hash, and takes the message whole from an honest peer', async function () {
    expect(afterLiar.has(altered.hash), 'held once only the lying peer had answered').to.equal(false);
    const held = (await heldByJoiner([altered.hash])).get(altered.hash);
    expect(held.appSpecifications.description).to.equal(altered.description);
  });

  it('keeps a message a peer misplaced at the txid, height and payment its own record of the chain gives', function () {
    const own = onChain.find((m) => m.hash === misplaced.hash);
    const held = afterLiar.get(misplaced.hash);
    expect(held, 'held from the lying peer').to.exist;
    expect({ txid: held.txid, height: held.height, value: held.value }).to.deep.equal({ txid: own.txid, height: own.height, value: own.value });
  });

  it('keeps every message the chain paid for, as its owner signed it, at its own record', async function () {
    const held = await heldByJoiner(onChain.map((m) => m.hash));
    const wrong = onChain.filter((m) => {
      const stored = held.get(m.hash);
      return !stored || stored.txid !== m.txid || stored.height !== m.height || stored.value !== m.value
        || stored.signature !== m.message.signature
        || stored.appSpecifications.description !== m.message.appSpecifications.description;
    }).map((m) => m.hash);
    expect(wrong, `${wrong.length} of ${onChain.length} not held as signed at their own record`).to.deep.equal([]);
  });

  it('refuses a forged signature and a former owner\'s update', async function () {
    const joiner = env.clients[JOINER];
    for (const hash of unauthorized) {
      // eslint-disable-next-line no-await-in-loop
      const { status, data } = await joiner.request('GET', `/v2/apps/messages/${hash}/decision`);
      expect(status, hash).to.equal(200);
      expect(data.data, hash).to.include({ decision: 'refused', reason: 'unauthorized' });
    }
  });

  it('holds the newest valid message of every app', async function () {
    this.timeout(300000);
    const db = dbClient(JOINER + 1);
    await waitFor(async () => {
      const held = await Promise.all([...governing.keys()].map(async (name) => (await db.globalAppSpec(name))?.hash));
      return held.every((hash, i) => hash === [...governing.values()][i]);
    }, { timeout: 240000, interval: 5000, label: 'every app held at its newest valid message' });
    expect((await db.globalAppSpec(misplaced.name)).hash, 'the app whose message the peer misplaced').to.equal(misplaced.newest);
  });
});
