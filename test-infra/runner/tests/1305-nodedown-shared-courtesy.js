// fleet: 16
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  describe, it, before, after, afterEach,
} from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { waitFor } from '../framework/wait.js';
import { dbClient } from '../framework/db-client.js';
import { waitForRowsOnEverySurvivor } from '../framework/nodedown-helper.js';
import { execInContainer, restartFluxos } from '../framework/container.js';
import { getSubnetConfig } from '../framework/subnet-config.js';
import { nodeKey } from '../framework/keys.js';
import { signBtcMessage } from '../auth.js';
import { harnessNow } from '../framework/harness-clock.js';

// The restart courtesy is the jury's count, not each juror's.
//   G. Jurors that miss restarts still count them. Before each of the twelve
//      honoured FluxOS restarts, a rotating group of three of the nodes that
//      hold the subject (its jury of 14 among them) is cut from it, so they do
//      not hold it at the close; every holder misses two or three. Each juror that saw a close forwards the
//      subject's signed stop to the others, so every juror counts all twelve
//      and the thirteenth is certified at the drop. Counted privately, no
//      survivor reaches twelve and the thirteenth is honoured by all.
//   H. Two signed stops for one process are a certified stop: one juror is
//      handed both, holds the subject's own proof that it lied, and every
//      node stores the `lie` row.
// The fleet is 16 nodes, as in 1303, so the quorum has no margin.

const subnet = getSubnetConfig();
const NODES = 16;
const SUBJECT = 5;
const RESTART_COURTESY = 12;
const MISSERS_PER_RESTART = 3;
const API_PORT = 16127;

const list = JSON.parse(
  readFileSync(new URL('../../fixtures/deterministic-list.json', import.meta.url), 'utf-8'),
);
const subjectOutpoint = `${list[SUBJECT].txhash}:${list[SUBJECT].outidx}`;
const subjectAddress = () => `${subnet.nodeIp(SUBJECT + 1)}:${API_PORT}`;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// A signed network message as a node puts it on the wire.
async function signedMessage(data, key, timestamp = harnessNow()) {
  const signature = await signBtcMessage(`1${JSON.stringify(data)}${timestamp}`, key.privkey);
  return {
    version: 1, timestamp, pubKey: key.pubkey, signature, data,
  };
}

describe('node-down: the restart courtesy is the jury\'s count', function () {
  let env;
  let survivors;
  // The survivors holding the subject once the fleet has settled: its jury
  // is its guaranteed inbound, so every juror is among them.
  let holders;
  const JURY = 14;

  const subjectContainer = () => env.clients[SUBJECT].container;

  // Whether node i holds the subject, in either direction.
  async function holdsSubject(i) {
    const [outbound, inbound] = await Promise.all([env.clients[i].getPeers(), env.clients[i].getIncomingPeers()]);
    const ip = subnet.nodeIp(SUBJECT + 1);
    return [...(outbound.data || []), ...(inbound.data || [])].includes(ip);
  }

  async function everyHolderHoldsSubject(label) {
    let missing = [];
    await waitFor(async () => {
      const held = await Promise.all(holders.map(holdsSubject));
      missing = holders.filter((_, n) => !held[n]);
      return missing.length === 0;
    }, { timeout: 180000, interval: 2000, label })
      .catch((error) => {
        throw new Error(`${error.message}\n    not holding the subject: ${JSON.stringify(missing)}`);
      });
  }

  // The harness starts discovery by API at fleet boot, so a restarted FluxOS
  // process starts with none: restart it by hand, as 1303 does.
  async function restartSubjectFluxos() {
    await restartFluxos(subjectContainer());
    await waitFor(async () => {
      try {
        await env.startDiscovery([SUBJECT]);
        return true;
      } catch (_e) {
        return false;
      }
    }, { timeout: 120000, interval: 2000, label: 'discovery restarted on the subject' });
  }

  const rows = (i) => dbClient(i + 1).getNodeDownRecords(subjectOutpoint);

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      tickerAutostart: false,
      // A verdict names the membership fingerprint, which needs the anchored
      // membership history the ZMQ delta path records; the polling default
      // carries none, and a juror then signs no verdict at all.
      zmqTopics: ALL_ZMQ_TOPICS,
    });
    survivors = env.clients.map((_, i) => i).filter((i) => i !== SUBJECT);
    await bootAndPeer(env);
  });

  afterEach(async function () {
    this.timeout(60000);
    await env?.healPartition([SUBJECT], survivors).catch(() => {});
  });

  after(async function () {
    this.timeout(60000);
    await env?.healPartition([SUBJECT], survivors).catch(() => {});
    await env?.teardown();
  });

  it('G. jurors that missed restarts count them from the others, and the thirteenth is certified at the drop', async function () {
    this.timeout(3600000);
    await waitFor(async () => {
      const held = await Promise.all(survivors.map(holdsSubject));
      holders = survivors.filter((_, n) => held[n]);
      return holders.length >= JURY;
    }, { timeout: 300000, interval: 5000, label: `at least ${JURY} survivors hold the subject` });
    expect((await rows(survivors[0])).length, 'nothing certified before the restarts').to.equal(0);

    const missed = new Map(holders.map((i) => [i, 0]));
    for (let restart = 0; restart < RESTART_COURTESY; restart += 1) {
      const missers = Array.from({ length: MISSERS_PER_RESTART },
        (_, k) => holders[(restart * MISSERS_PER_RESTART + k) % holders.length]);
      // Severed: the missers no longer hold the subject when it closes.
      // eslint-disable-next-line no-await-in-loop
      await env.partitionGroups([SUBJECT], missers);
      // eslint-disable-next-line no-await-in-loop
      await restartSubjectFluxos();
      // eslint-disable-next-line no-await-in-loop
      await env.healPartition([SUBJECT], missers);
      missers.forEach((i) => missed.set(i, missed.get(i) + 1));
      // eslint-disable-next-line no-await-in-loop
      await everyHolderHoldsSubject(`every holder holds the subject again after restart ${restart + 1}`);
    }
    // The premise: every holder missed at least two of the twelve, so none
    // saw twelve closes itself.
    expect(Math.min(...missed.values()), 'every holder missed some restarts').to.be.at.least(2);
    expect((await rows(survivors[0])).length, 'twelve honoured restarts leave no row').to.equal(0);

    // the forwards are pushed seconds after each close; give the last ones time
    await sleep(10_000);
    await restartSubjectFluxos();
    await waitForRowsOnEverySurvivor(survivors, subjectOutpoint, 1, { timeout: 240000 });
    const certified = (await rows(survivors[0]))[0];
    expect(certified.reason, 'the reason the socket carried').to.equal('restart');
    expect(new Date(certified.broadcastedAt).getTime() - new Date(certified.since).getTime(),
      'certified at the drop, not the grace end').to.be.below(120_000);
  });

  it('H. two signed stops for one process: every node stores the lie row', async function () {
    this.timeout(600000);
    const SENDER = survivors[0];
    const subjectKey = nodeKey(SUBJECT + 1);
    const senderKey = nodeKey(SENDER + 1);
    const processId = randomBytes(16).toString('hex');
    const lieKey = `nodedown:${subjectOutpoint}:lie:${processId}`;
    const lieRows = async (i) => (await rows(i)).filter((row) => row.dedupKey === lieKey);
    expect((await lieRows(SENDER)).length, 'no lie row before the proof').to.equal(0);

    // Two statements the subject signed for one process, at different times.
    const now = harnessNow();
    const stop = (at) => signedMessage({
      type: 'fluxprocessstop', version: 1, ip: subjectAddress(), processId, reason: 'restart',
    }, subjectKey, at);
    const statements = [await stop(now - 2000), await stop(now - 1000)];

    // Both forwarded, as a juror forwards, to every other survivor over an
    // ephemeral connection from the sender's own container; a survivor that is
    // not the subject's juror drops them.
    const notes = await Promise.all(statements.map((statement) => signedMessage(
      { type: 'fluxcourtesynote', version: 1, statement },
      senderKey,
    )));
    const payload = Buffer.from(JSON.stringify(notes)).toString('base64');
    const targets = survivors.filter((i) => i !== SENDER).map((i) => subnet.nodeIp(i + 1));
    const script = [
      "const WebSocket = require('ws');",
      `const notes = JSON.parse(Buffer.from('${payload}', 'base64').toString());`,
      `const targets = ${JSON.stringify(targets)};`,
      'const push = (ip) => new Promise((resolve) => {',
      `  const ws = new WebSocket('ws://' + ip + ':${API_PORT}/ws/flux/${API_PORT}', { headers: { 'X-Flux-Ephemeral': '1' } });`,
      "  ws.on('open', () => { notes.forEach((n) => ws.send(JSON.stringify(n))); setTimeout(() => { ws.close(); resolve(true); }, 1000); });",
      "  ws.on('error', (e) => { console.error(ip + ': ' + e.message); resolve(false); });",
      '});',
      '(async () => { let sent = 0; for (const ip of targets) { if (await push(ip)) sent += 1; } console.log(`sent ${sent}`); })();',
    ].join('\n');
    const { exitCode, stdout } = await execInContainer(
      env.clients[SENDER].container,
      `cd /flux && node -e "$(echo '${Buffer.from(script).toString('base64')}' | base64 -d)"`,
    );
    expect(exitCode, `the push from node ${SENDER}: ${stdout}`).to.equal(0);
    expect(String(stdout)).to.match(new RegExp(`sent ${targets.length}`));

    let counts = [];
    await waitFor(async () => {
      counts = await Promise.all(env.clients.map(async (_, i) => (await lieRows(i)).length));
      return counts.every((count) => count === 1);
    }, { timeout: 180000, interval: 5000, label: 'the lie row on every node' })
      .catch((error) => {
        throw new Error(`${error.message}\n    lie rows per node: ${JSON.stringify(counts)}`);
      });
    const [row] = await lieRows(SENDER);
    expect(row.reason).to.equal('lie');
    expect(new Date(row.since).getTime()).to.equal(now - 1000);
  });
});
