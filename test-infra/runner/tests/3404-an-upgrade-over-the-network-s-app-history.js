// fleet: 4
// base-image: FLUX_E2E_BASE_TAG
/*
 * A node upgraded to v9 over the network's whole app history keeps the app list
 * the network serves, within the boot bound.
 *
 * The corpus (test-infra/app-corpus/fetch.mjs, named by E2E_APP_CORPUS) is
 * every permanent app message of a network, the app list a released node of it
 * serves, and the chain tip both were read at. The fleet's chain starts at that
 * tip. A node on the released image is given the corpus as that release keeps
 * it and boots on it, serving the list the network serves. It is then upgraded:
 * the first v9 start moves the messages, positions their payments, decides every
 * one and derives the list from the decisions.
 *
 * Then: the list it reaches is the release's at the same height, less exactly
 * the apps the rules refuse (README §8 of the boot-phases design: the apps
 * leaving at the upgrade, by name); every app it removes, adds or lists at
 * another message is printed with the node's decision on each of its messages;
 * and the list is consistent within the boot bound, system.bootSyncTimeoutMs
 * from the start of FluxOS.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createRequire } from 'node:module';
import { createTestEnv } from '../framework/test-env.js';
import { authenticate } from '../auth.js';
import { fluxTeamKey } from '../framework/keys.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import {
  LEGACY_INDEXES, legacyPaymentRows, legacyPermanentMessages, loadAppCorpus, seedPaymentPositions,
} from '../framework/app-corpus.js';
import { dbClient } from '../framework/db-client.js';
import { stopTicker } from '../framework/daemon-control.js';
import { waitFor, waitForDaemonReady } from '../framework/wait.js';

const require = createRequire(import.meta.url);
const production = require('../../../ZelBack/config/default.js');

const BASE_TAG = process.env.FLUX_E2E_BASE_TAG;
const TAG = process.env.FLUX_E2E_TAG;
const CORPUS = process.env.E2E_APP_CORPUS;
// Three nodes beside it: a running node needs peers at the threshold before it
// asks for the network's policy.
const NODES = 4;
const SUBJECT = 3; // boots on the release, then is upgraded
const BOOT_BOUND_MS = production.system.bootSyncTimeoutMs;
// The apps the first derivation removes from the network's list: refused by the
// rules the network's release does not enforce.
const EXPECTED_REMOVED = ['claimcalc', 'ipshow', 'mole'];
const UPGRADE_MS = 1200000;
const RELEASE_LIST_MS = 900000;

describe('an upgrade over the network\'s app history', function () {
  let env;
  let corpus;
  let zelidauth = null;
  const node = () => env.clients[SUBJECT];

  // Every app the node lists, by lower-cased name.
  async function listOn() {
    const res = await fetch(`${node().url}/apps/globalappsspecifications`);
    const body = await res.json();
    if (body.status !== 'success' || !Array.isArray(body.data)) return null;
    return new Map(body.data.map((row) => [row.name.toLowerCase(), row]));
  }

  async function readout(path) {
    if (!zelidauth) ({ zelidauth } = await authenticate(node().url, fluxTeamKey()));
    let res = await node().getAuthed(`/v2/node${path}`, zelidauth, { noCache: true });
    if (!res?.data) {
      ({ zelidauth } = await authenticate(node().url, fluxTeamKey()));
      res = await node().getAuthed(`/v2/node${path}`, zelidauth, { noCache: true });
    }
    return res?.data ?? null;
  }

  before(async function () {
    this.timeout(UPGRADE_MS);
    if (!BASE_TAG) {
      throw new Error('FLUX_E2E_BASE_TAG names the node image of the released FluxOS the network runs: build it with FLUX_E2E_TAG=<base-tag> ./test-infra/build-release-image.sh <release tag>');
    }
    if (!CORPUS) {
      throw new Error('E2E_APP_CORPUS names the corpus file: node test-infra/app-corpus/fetch.mjs <file>');
    }
    corpus = loadAppCorpus(CORPUS);
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      deferredNodes: 1,
      nodeImageTags: { [SUBJECT]: BASE_TAG },
      initialHeight: corpus.tip,
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1 });
    // The chain stands still from here, so the release and the upgraded node
    // judge every term at the same height.
    await stopTicker();
    await dbClient(SUBJECT + 1).seedLegacyAppStore({
      payments: legacyPaymentRows(corpus),
      messages: legacyPermanentMessages(corpus),
      listed: corpus.listed,
      indexes: LEGACY_INDEXES,
    });
    await seedPaymentPositions(corpus);
    const client = await env.startNode(SUBJECT);
    await waitForDaemonReady(client);
    await env.startDiscovery([SUBJECT]);
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  // The decisions the node holds on every message of an app, in chain order:
  // why it lists the app where it does, or not at all.
  async function decisionsFor(name) {
    const messages = corpus.messages
      .filter((m) => String((m.appSpecifications ?? m.zelAppSpecifications)?.name ?? '').toLowerCase() === name)
      .sort((a, b) => a.height - b.height || a.txIndex - b.txIndex);
    const lines = await Promise.all(messages.map(async (m) => {
      const { status, data } = await node().request('GET', `/v2/apps/messages/${m.hash}/decision`);
      const d = status === 200 ? data.data : { decision: `HTTP ${status}` };
      return `${m.type}@${m.height}:${m.hash.slice(0, 8)} paid ${m.valueSat} ${d.decision}${d.reason ? ` ${d.reason}` : ''}${d.fee ? ` fee ${d.fee}` : ''}`;
    }));
    return `${name}: ${lines.join(' | ')}`;
  }

  // The release's own list at the fleet's height: what the network serves once
  // every term ended by then has left it. The network's list was read at the
  // corpus tip and still carries an app whose term ends there.
  let release = null;

  // The release serves its list once its boot hash sync has run with its peers
  // and it has rebuilt the list from every message it holds.
  it('serves the network\'s app list on the release, from the history it was given', async function () {
    this.timeout(RELEASE_LIST_MS);
    await waitFor(async () => {
      release = await listOn();
      return release !== null && release.size > 0;
    }, { timeout: RELEASE_LIST_MS, interval: 5000, label: 'the released node serves its app list' });
    const network = new Map(corpus.listed.map((row) => [row.name.toLowerCase(), row]));
    const missing = [...network.keys()].filter((name) => !release.has(name)).sort();
    const extra = [...release.keys()].filter((name) => !network.has(name)).sort();
    const moved = [...release.keys()].filter((name) => network.has(name) && release.get(name).hash !== network.get(name).hash).sort();
    console.log(`# release: ${release.size} listed; missing [${missing.map((name) => `${name}@${network.get(name).height}+${network.get(name).expire ?? '-'}`).join(', ')}]; extra [${extra.join(', ')}]; on another message [${moved.join(', ')}]`);
    expect(extra, 'the release lists an app the network does not').to.deep.equal([]);
    expect(moved, 'the release lists an app at a message the network does not').to.deep.equal([]);
    const res = await fetch(`${node().url}/explorer/scannedheight`);
    const scanned = (await res.json())?.data?.generalScannedHeight;
    expect(Number.isInteger(scanned), 'the release answers its scanned height').to.equal(true);
    const unended = missing.filter((name) => {
      const row = network.get(name);
      return !Number.isInteger(row.expire) || row.height + row.expire > scanned;
    });
    expect(unended, `apps the release does not list whose term had not ended at its height ${scanned}`).to.deep.equal([]);
  });

  it('lists the release\'s apps on v9, less exactly the apps the rules refuse', async function () {
    this.timeout(UPGRADE_MS);
    expect(release, 'the release served its list').to.not.equal(null);
    await env.upgradeNode(SUBJECT, { tag: TAG, readyTimeoutMs: UPGRADE_MS });
    await waitFor(async () => (await readout('/capabilities'))?.find((c) => c.name === 'appRegistryConsistent')?.state === 'up', {
      timeout: UPGRADE_MS, interval: 10000, label: 'the upgraded node\'s app list is consistent',
    });
    const listed = await listOn();
    const removed = [...release.keys()].filter((name) => !listed.has(name)).sort();
    const added = [...listed.keys()].filter((name) => !release.has(name)).sort();
    const moved = [...listed.keys()].filter((name) => release.has(name) && listed.get(name).hash !== release.get(name).hash).sort();
    console.log(`# upgrade over ${corpus.messages.length} messages (${corpus.source}, ${corpus.fetchedAt}, tip ${corpus.tip}): `
      + `${listed.size} listed; removed [${removed.join(', ')}]; added [${added.join(', ')}]; on another message [${moved.join(', ')}]`);
    for (const name of [...removed, ...added, ...moved]) {
      // eslint-disable-next-line no-await-in-loop
      console.log(`# decisions: ${await decisionsFor(name)}`);
    }
    expect(removed, 'the apps the upgrade removes').to.deep.equal(EXPECTED_REMOVED);
    expect(added, 'apps the release does not list').to.deep.equal([]);
    expect(moved, 'apps listed at a message the release does not list them at').to.deep.equal([]);
  });

  it('reaches a consistent app list within the boot bound from the start of FluxOS', async function () {
    this.timeout(60000);
    const blame = await readout('/capabilities/blame');
    const registry = blame.find((row) => row.name === 'appRegistryConsistent');
    const boot = await readout('/boot');
    console.log(`# boot: appRegistryConsistent up after ${registry.upAfterMs} ms; slowest: ${blame.slice(0, 5).map((r) => `${r.name} ${r.upAfterMs}`).join(', ')}`);
    console.log(`# boot: ${boot.transitions.filter((t) => t.to === 'up').map((t) => `${t.name}+${t.at - boot.startedAt}`).join(' ')}`);
    expect(registry.upAfterMs, `the app list is consistent within ${BOOT_BOUND_MS} ms of FluxOS starting`).to.be.below(BOOT_BOUND_MS);
  });
});
