// fleet: 4
/*
 * A node that joins takes a slice of the mainnet app message log in bulk, and ends where its
 * own record of the chain puts it.
 *
 * The fixture (test-infra/fixtures/mainnet-message-slice) is every permanent message of 198
 * mainnet apps, 1,050 messages, and a mainnet node's payment record of each. Its manifest names
 * the apps chosen for each case: every message type and spec version, enterprise apps, owner
 * transfers either side of block 2,000,000, same-block messages, renewals after expiry, names
 * re-registered by their owner and by another, hashes paid twice in one block, expiries that
 * cross the PON fork, and apps in force and expired at the scanned height.
 *
 * The chain carries each payment at its mainnet height, in the daemon's address index, and every
 * node starts with nothing scanned, so it records the payments from that index as a fresh node
 * does. The peers are handed the messages; the joiner takes them from its peers in batches. It must
 * keep every message, each at its own record's txid, height and payment, and hold every app whose
 * newest message is still in its term, at that message's height.
 *
 * The joiner is not an Arcane node. An Arcane node checks a subscription extension signed by a
 * usersToExtend address on an enterprise app by decrypting the spec, which needs keys no harness
 * node holds; a node that is not Arcane accepts it without the comparison, as the slice's
 * buckyorbit renewal shows.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { handAppMessages } from '../framework/app-delivery.js';
import { waitForDaemonReady, waitForOrchestratorState, waitFor } from '../framework/wait.js';
import { setSystemSecure, stopTicker } from '../framework/daemon-control.js';
import { getSubnetConfig } from '../framework/subnet-config.js';
import { dbClient } from '../framework/db-client.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';
import { addressIndexOf, signedMessage } from '../framework/app-payments.js';
import { Chain, expiresAtHeightFor } from '@runonflux/flux-spec';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'mainnet-message-slice');
const JOINER = 3;
const PEERS = [0, 1, 2];

const readLines = (file) => gunzipSync(readFileSync(join(FIXTURE, file))).toString().trim().split('\n').map((line) => JSON.parse(line));

// The height a v1-v8 app's term ends at on the harness chain, as flux-spec reads it.
const expirationHeight = (height, expire) => expiresAtHeightFor({ height, expire, chain: Chain.HARNESS });

// Within a block the slice's payments take their positions in their messages' timestamp order.
function paymentsInChainOrder(records, messageOf) {
  return [...records].sort((a, b) => a.height - b.height
    || messageOf.get(a.hash).timestamp - messageOf.get(b.hash).timestamp)
    .map(({
      hash, txid, height, value,
    }) => ({
      hash, txid, height, value,
    }));
}

describe('a node that joins takes a slice of the mainnet message log in bulk', function () {
  let env;
  dumpLogsOnFailure(() => env);

  const manifest = JSON.parse(readFileSync(join(FIXTURE, 'manifest.json'), 'utf-8'));
  const messages = readLines('messages.json.gz');
  const records = readLines('hashes.json.gz');
  const recordOf = new Map(records.map((record) => [record.hash, record]));
  // The newest message of each app, at its record's height.
  const newest = new Map();
  for (const message of messages) {
    const placed = {
      hash: message.hash,
      height: recordOf.get(message.hash).height,
      timestamp: message.timestamp,
      expire: message.appSpecifications.expire,
    };
    const { name } = message.appSpecifications;
    const held = newest.get(name);
    if (!held || placed.height > held.height || (placed.height === held.height && placed.timestamp > held.timestamp)) {
      newest.set(name, placed);
    }
  }
  const messageOf = new Map(messages.map((message) => [message.hash, message]));
  let fetched;

  before(async function () {
    this.timeout(1200000);
    // The chain starts above every payment in the slice, and carries each in its address index.
    env = await createTestEnv({
      hookCtx: this,
      nodes: 4,
      deferredNodes: 1,
      initialHeight: manifest.scannedHeight + 1,
      unscanned: true,
      addressIndex: addressIndexOf(paymentsInChainOrder(records, messageOf)),
    });
    await bootAndPeer(env);
    await stopTicker();

    // Each peer decides each message by its own rules; the joiner is what this suite judges.
    await handAppMessages(env, messages.map(signedMessage), PEERS, { anyDecision: true });
    await setSystemSecure(getSubnetConfig().nodeIp(JOINER + 1), false);

    const joiner = await env.startNode(JOINER);
    await waitForDaemonReady(joiner);
    await env.startDiscovery([JOINER]);
    fetched = await joiner.waitForEvent('hashSync:batchFetched', (d) => d.stored > 0, 600000);
    await waitForOrchestratorState(joiner, 'READY', 600000);
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('covers every message type and spec version', function () {
    expect(new Set(messages.map((m) => m.type))).to.have.all.keys('zelappregister', 'zelappupdate', 'fluxappregister', 'fluxappupdate');
    expect([...new Set(messages.map((m) => m.appSpecifications.version))].sort()).to.deep.equal([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('takes the slice in batches from its peers, every message of it', function () {
    expect(fetched.data, JSON.stringify(fetched.data)).to.include({ stored: messages.length, unheld: 0 });
  });

  it('keeps every message, each at its own record\'s txid, height and payment', async function () {
    const kept = new Map((await dbClient(JOINER + 1).appMessages({ held: true })).map((m) => [m.hash, m]));
    const missing = messages.filter((m) => !kept.has(m.hash)).map((m) => `${m.hash} ${m.type} v${m.appSpecifications.version} ${m.appSpecifications.name}`);
    expect(missing, `${missing.length} of ${messages.length} messages not kept`).to.deep.equal([]);
    const misplaced = messages.filter((message) => {
      const stored = kept.get(message.hash);
      const record = recordOf.get(message.hash);
      return stored.txid !== record.txid || stored.height !== record.height || stored.value !== record.value
        || stored.signature !== message.signature || stored.timestamp !== message.timestamp;
    }).map((m) => m.hash);
    expect(misplaced, `${misplaced.length} messages not at their own record`).to.deep.equal([]);
  });

  it('holds every app whose newest message is in its term at its scanned height', async function () {
    this.timeout(300000);
    const db = dbClient(JOINER + 1);
    const scanned = await db.explorerHeight();
    const expected = new Map([...newest].filter(([, m]) => expirationHeight(m.height, m.expire) > scanned));

    let held = new Map();
    await waitFor(async () => {
      held = new Map((await db.globalAppSpecs()).map((row) => [row.name, row]));
      return held.size === expected.size;
    }, { timeout: 180000, interval: 5000, label: `the joiner holds ${expected.size} apps` });
    const wrong = [...expected]
      .filter(([name, m]) => held.get(name)?.hash !== m.hash || held.get(name)?.height !== m.height)
      .map(([name, m]) => `${name}: ${held.get(name)?.hash}@${held.get(name)?.height} not ${m.hash}@${m.height}`);
    expect(wrong.length, `${wrong.length} apps at another message or height: ${wrong.join('; ')}`).to.equal(0);
  });
});
