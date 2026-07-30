// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { restartFluxos } from '../framework/container.js';
import { waitFor } from '../framework/wait.js';
import { dbClient } from '../framework/db-client.js';
import {
  POLICY_PATHS,
  setEnterpriseNodes,
  setTamperingBlocklist,
  failPaths,
  healPaths,
  policyRequestCounts,
  clearPolicyRequestCounts,
  resetExternalStub,
} from '../framework/external-stub-control.js';

// policyStore holds the documents the network enforces — which images may run, which owners
// may install on which enterprise nodes, which nodes are DOSed for tampering. Its unit tests
// stub mongo, the filesystem and the network, so what they cannot show is the only property
// that matters in production: that a node keeps enforcing when the source of those documents
// is unreachable, across a restart, against real storage.
//
// The observable for the enterprise map is GET /flux/enterpriseappowners, which serves
// enterpriseConfig's deduped owner union straight out of the store. Nothing serves the blocked
// repository list, so that document is not exercised here; it shares every code path with the
// enterprise map except its validator.
//
// Refresh intervals are hours, so a FluxOS restart is the trigger for a fetch throughout —
// restartFluxos wipes in-memory state without touching the container, which is exactly the
// boundary these tests care about.

const __dirname = dirname(fileURLToPath(import.meta.url));
const seededEnterpriseNodes = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', 'helpers', 'enterprisenodes.json'), 'utf-8'),
);
// What the shipped seed entitles, as the endpoint reports it: the deduped union of the
// tracked file's owners. This is the floor a node with no cache falls back to.
const SEEDED_OWNERS = [...new Set(Object.values(seededEnterpriseNodes).flat())];

const PUBLISHED_OWNERS = ['1PublishedOwnerAaaaaaaaaaaaaaaaaaaa', '1PublishedOwnerBbbbbbbbbbbbbbbbbbbb'];
const PUBLISHED_MAP = { '02e2e0000000000000000000000000000000000000000000000000000000000001': PUBLISHED_OWNERS };

// deterministic-list.json is the identity the daemon stub serves; the tampering enforcer reads
// this node's collateral txhash from it and looks for that hash on the blocklist.
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
const TAMPER_TICK_MS = 5000;
const DOS_PREFIX = 'Node flagged via tampering blocklist';

async function dosMessageOn(client) {
  const res = await client.getDOSState();
  return res.data.dosMessage || '';
}

async function ownersOn(client) {
  const res = await client.get('/flux/enterpriseappowners', { noCache: true });
  return res.data;
}

describe('Policy distribution: enforcement survives an unreachable source', function () {
  let env;

  before(async function () {
    this.timeout(600000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 5,
      tickerAutostart: false,
      // Submission-door sizing for a 5-node mesh: minOutgoing is what the mesh actually
      // yields (~2), and minIncoming drops to 1 because every scenario here restarts FluxOS
      // on a node, and a freshly re-peered node sits at a single inbound for a moment.
      //
      // The tampering enforcer runs every 12h in production, so the clear branch — a second
      // tick, after the first set a DOS — is unreachable at that pace. Compressed to 5s;
      // threshold and behaviour are untouched.
      configOverrides: {
        fluxapps: { minOutgoing: 2, minIncoming: 1, tamperingCheckIntervalMs: TAMPER_TICK_MS },
      },
    });
    await bootAndPeer(env, { minOutbound: 2, minInbound: 1 });
  });

  after(async function () {
    this.timeout(60000);
    await resetExternalStub().catch(() => {});
  });

  describe('the enterprise owner map', function () {
    it('caches what it fetched, in storage rather than in the process', async function () {
      this.timeout(240000);
      await healPaths();
      await setEnterpriseNodes(PUBLISHED_MAP);

      await restartFluxos(env.clients[0].container);

      expect(await ownersOn(env.clients[0])).to.have.members(PUBLISHED_OWNERS);

      const cached = await dbClient(1).policyDocument('enterpriseNodes');
      expect(cached, 'the fetched document must be persisted, not just held in memory').to.not.be.null;
      expect(cached.payload).to.deep.equal(PUBLISHED_MAP);
      expect(cached.etag, 'the etag is what makes the next fetch conditional').to.be.a('string');
    });

    it('keeps enforcing across a restart while the source is unreachable', async function () {
      // The whole reason the last-known-good layer exists. Before it, a node that restarted
      // during an outage came up with the release-time file and silently lost every change
      // since — for an allow-list, that means refusing owners it should admit.
      this.timeout(240000);
      await failPaths({ [POLICY_PATHS.enterpriseNodes]: 503 });

      await restartFluxos(env.clients[0].container);

      expect(await ownersOn(env.clients[0])).to.have.members(PUBLISHED_OWNERS);
    });

    it('revalidates conditionally instead of re-downloading', async function () {
      // Without If-None-Match every node pulls every document in full on every interval.
      // The cached etag has to survive the restart for this to be a 304 rather than a 200.
      this.timeout(240000);
      await healPaths();
      await clearPolicyRequestCounts();

      await restartFluxos(env.clients[0].container);

      const counts = await policyRequestCounts();
      const enterprise = counts[POLICY_PATHS.enterpriseNodes] || { 200: 0, 304: 0 };
      expect(enterprise['304'], 'an unchanged document must revalidate, not re-download').to.be.at.least(1);
      expect(enterprise['200']).to.equal(0);
      expect(await ownersOn(env.clients[0])).to.have.members(PUBLISHED_OWNERS);
    });

    it('falls back to the shipped seed when it has no cache and no source', async function () {
      // A node installed during an outage has never fetched anything. The tracked helpers/
      // copy is its floor — not an empty document, which for an allow-list would refuse
      // every enterprise owner on the network.
      this.timeout(240000);
      const node = env.clients[1];
      await dbClient(2).deletePolicyDocument('enterpriseNodes');
      await failPaths({ [POLICY_PATHS.enterpriseNodes]: 503 });

      await restartFluxos(node.container);

      expect(await ownersOn(node)).to.have.members(SEEDED_OWNERS);
      await healPaths();
    });
  });

  describe('the tampering blocklist', function () {
    it('DOSes a listed node whose tamper score is over the threshold', async function () {
      this.timeout(240000);
      const nodeNum = 3;
      await healPaths();
      await setTamperingBlocklist([txhashOfNode(nodeNum)]);
      // TAMPER_SCORE_THRESHOLD is 10 and the comparison is strict, so 11 is the first
      // score that trips it.
      await dbClient(nodeNum).seedTamperingIncident({ severity: 11 });

      await restartFluxos(env.clients[nodeNum - 1].container);

      const res = await env.clients[nodeNum - 1].getDOSState();
      expect(res.data.dosMessage).to.include(DOS_PREFIX);
      expect(res.data.dosState).to.equal(100);
    });

    it('does not DOS a node when the blocklist cannot be read', async function () {
      // An unreadable blocklist is not an empty one, and it is not a listing either. Treating
      // "could not ask" as an answer in either direction is the bug this guards: on the clear
      // side it once released a node the network had deliberately blocked.
      this.timeout(240000);
      const nodeNum = 4;
      await setTamperingBlocklist([txhashOfNode(nodeNum)]);
      await dbClient(nodeNum).seedTamperingIncident({ severity: 11 });
      await failPaths({ [POLICY_PATHS.tamperingBlocklist]: 503 });

      await restartFluxos(env.clients[nodeNum - 1].container);

      const res = await env.clients[nodeNum - 1].getDOSState();
      expect(res.data.dosMessage || '').to.not.include(DOS_PREFIX);
      await healPaths();
    });

    it('does not release a node it has already DOSed when the blocklist stops being readable', async function () {
      // The regression this whole contract exists for. fetchBlocklist used to return [] on any
      // failure, so the next tick saw an unlisted node and cleared the sticky DOS — an
      // unreachable source released a node the network had deliberately blocked, and nothing
      // said so. Needs two ticks in one process: the first sets the DOS, the second runs with
      // the source down. Sticky DOS is in-memory, so a restart would give a clean slate and
      // prove nothing.
      this.timeout(240000);
      const nodeNum = 2;
      const client = env.clients[nodeNum - 1];
      await healPaths();
      await setTamperingBlocklist([txhashOfNode(nodeNum)]);
      await dbClient(nodeNum).seedTamperingIncident({ severity: 11 });

      await restartFluxos(client.container);
      await waitFor(
        async () => (await dosMessageOn(client)).includes(DOS_PREFIX),
        { timeout: 60000, interval: 1000, label: 'the tampering DOS to be set' },
      );

      await failPaths({ [POLICY_PATHS.tamperingBlocklist]: 503 });

      // Several ticks' worth: every one of them must decline to clear.
      await new Promise((r) => { setTimeout(r, TAMPER_TICK_MS * 4); });

      expect(await dosMessageOn(client), 'an unreadable blocklist must not release a blocked node')
        .to.include(DOS_PREFIX);
      await healPaths();
    });

    it('leaves an unlisted node alone even with a score over the threshold', async function () {
      this.timeout(240000);
      const nodeNum = 5;
      await healPaths();
      await setTamperingBlocklist([]);
      await dbClient(nodeNum).seedTamperingIncident({ severity: 50 });

      await restartFluxos(env.clients[nodeNum - 1].container);

      const res = await env.clients[nodeNum - 1].getDOSState();
      expect(res.data.dosMessage || '').to.not.include(DOS_PREFIX);
    });
  });
});
