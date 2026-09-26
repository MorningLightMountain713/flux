// fleet: 5
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { waitFor } from '../framework/wait.js';
import { dbClient } from '../framework/db-client.js';

// The tampering blocklist is a document in the signed policy bundle. A node on it whose
// own tamper score is over the threshold holds itself out of service, and releases that
// hold only when a bundle it has adopted no longer lists it.
//
// The rule this suite exists for: a document that cannot be read is not an empty one.
// A signature says who published a bundle, not that each document in it is the shape the
// reader expects, so a correctly signed bundle can carry a tampering document that is not
// a list - and reading that as "nobody is listed" would release a node the network had
// deliberately blocked.

const __dirname = dirname(fileURLToPath(import.meta.url));

// deterministic-list.json is the identity the daemon stub serves; the enforcer reads this
// node's collateral txhash from it and looks for that hash on the blocklist.
//
// Matched by position, not by the fixture's own `ip`: test-env renders the run's list as
// `deterministicList.slice(0, nodes).map((n, idx) => ({ ...n, ip: subnet.nodeIp(idx + 1) }))`,
// so the committed addresses are overwritten and only the ordering carries through.
const deterministicList = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'fixtures', 'deterministic-list.json'), 'utf-8'),
);
function txhashOfNode(nodeNum) {
  const entry = deterministicList[nodeNum - 1];
  if (!entry) throw new Error(`no deterministic identity at index ${nodeNum - 1}`);
  return entry.txhash;
}

// Enforcement tick pace for this suite; production is 12h.
const TAMPER_TICK_MS = 5_000;
// The backstop refresh, compressed so a published bundle reaches every node on its own.
const POLICY_REFRESH_MS = 15_000;
const DOS_PREFIX = 'Node flagged via tampering blocklist';

// TAMPER_SCORE_THRESHOLD is 10 and the comparison is strict, so 11 is the first score that
// trips it.
const OVER_THRESHOLD = 11;

const LISTED = 3;
const UNLISTED = 5;

async function dosMessageOn(client) {
  const res = await client.getDOSState();
  return res.data.dosMessage || '';
}

const control = (env, path, body) => fetch(`${env.stubControl}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body ?? {}),
}).then((r) => r.json());

// Published, then held by the node: its stored bundle carries the published sequence. A
// wait that ends here has something to judge; one that ended on the publish alone would
// judge whatever the node held before.
async function publishAndAdopt(env, nodeNums, path, body) {
  const { seq } = await control(env, path, body);
  expect(seq, `the stub re-signed on ${path}`).to.be.a('number');
  await Promise.all(nodeNums.map((n) => waitFor(
    async () => ((await dbClient(n).policyBundle())?.seq ?? -1) >= seq,
    { timeout: 120_000, interval: 1_000, label: `node ${n} adopts policy seq ${seq}` },
  )));
  return seq;
}

// Several ticks' worth, each read: a hold that appears and is withdrawn between two reads
// would otherwise pass a check made only at the end.
async function holdsForTicks(client, ticks, predicate, label) {
  const until = Date.now() + TAMPER_TICK_MS * ticks;
  while (Date.now() < until) {
    // eslint-disable-next-line no-await-in-loop
    expect(predicate(await dosMessageOn(client)), label).to.equal(true);
    // eslint-disable-next-line no-await-in-loop, no-promise-executor-return
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

describe('the tampering blocklist follows the signed bundle', function () {
  let env;

  before(async function () {
    this.timeout(600_000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 5,
      tickerAutostart: false,
      // Nodes 2-5 legacy (0-based indices). An attested Arcane node is exempt from
      // tampering enforcement by design, and the harness default is arcane - so on the
      // default every scenario below is vacuous.
      legacyNodes: [1, 2, 3, 4],
      // Submission-door sizing for a 5-node mesh: minOutgoing is what the mesh actually
      // yields (~2), and a node re-peering sits at a single inbound for a moment.
      configOverrides: {
        fluxapps: { minOutgoing: 2, minIncoming: 1, tamperingCheckIntervalMs: TAMPER_TICK_MS },
        policy: { refreshIntervalMs: POLICY_REFRESH_MS },
      },
    });
    await bootAndPeer(env, { minOutbound: 2, minInbound: 1 });
    await Promise.all([LISTED, UNLISTED].map((n) => dbClient(n).seedTamperingIncident({ severity: OVER_THRESHOLD })));
    await publishAndAdopt(env, [LISTED, UNLISTED], '/tampering-blocklist', [txhashOfNode(LISTED)]);
  });

  after(async function () {
    this.timeout(60_000);
    await control(env, '/reset').catch(() => {});
    await env?.teardown();
  });

  it('holds a listed node over the threshold out of service', async function () {
    this.timeout(120_000);
    const client = env.clients[LISTED - 1];
    await waitFor(
      async () => (await dosMessageOn(client)).includes(DOS_PREFIX),
      { timeout: 60_000, interval: 1_000, label: 'the tampering DOS to be set' },
    );
    expect((await client.getDOSState()).data.dosState).to.equal(100);
  });

  // The same bundle, the same score, a node it does not name. The listed node above is
  // what makes this a verdict rather than an enforcer that never ran.
  it('leaves an unlisted node alone with the same score', async function () {
    this.timeout(120_000);
    await holdsForTicks(env.clients[UNLISTED - 1], 4, (m) => !m.includes(DOS_PREFIX),
      'an unlisted node was held out of service');
  });

  it('keeps the hold when a newer bundle carries a tampering document that is not a list', async function () {
    this.timeout(240_000);
    const client = env.clients[LISTED - 1];
    expect(await dosMessageOn(client), 'the premise: the listed node is held').to.include(DOS_PREFIX);

    await publishAndAdopt(env, [LISTED], '/policy', { documents: { tamperingblockednodes: 'not a list' } });

    await holdsForTicks(client, 4, (m) => m.includes(DOS_PREFIX),
      'an unreadable tampering document released a blocked node');
  });

  // The positive the test above needs: the enforcer does release, on a document it can
  // read that no longer names the node.
  it('releases the hold when a bundle it adopts no longer lists the node', async function () {
    this.timeout(240_000);
    const client = env.clients[LISTED - 1];
    await publishAndAdopt(env, [LISTED], '/tampering-blocklist', []);
    await waitFor(
      async () => !(await dosMessageOn(client)).includes(DOS_PREFIX),
      { timeout: 60_000, interval: 1_000, label: 'the tampering DOS to be released' },
    );
  });
});
