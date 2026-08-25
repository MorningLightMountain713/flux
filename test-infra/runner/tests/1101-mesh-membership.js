// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { registerEncryptedV9App } from '../framework/content-helper.js';
import {
  queueAppTx, advanceBlocks, setHeight, getState,
} from '../framework/daemon-control.js';
import { waitFor, waitForAppInstalled } from '../framework/wait.js';
import { authenticate } from '../auth.js';
import { appOwnerKey, fluxTeamKey } from '../framework/keys.js';
import { execInContainer, pauseHostContainer, unpauseHostContainer } from '../framework/container.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';

// Mesh membership across a real 3-node fleet, without the overlay data plane:
// every node hosting a mesh app derives the same member set from the
// fluxapprunning broadcasts alone. What must hold:
//   1. ADMISSION — a registered mesh app installs on all three nodes, and every
//      node's reconciler admits its two peers: voucher verified against the
//      mesh-purpose key, anchor fresh, outpoint in the hosting set, authority
//      pinned. Self is a local fact, never a candidate — it rides the snapshot,
//      so each node's member set is exactly the other two outpoints. A
//      transport port from the 16226-16299 pool, real authority + host
//      certificates on disk.
//   2. RESOLVER FEED — each node writes the membership snapshot the resolver
//      consumes, carrying the app's full member set.
//   3. REFUSAL is local and reversible — refusing an outpoint on one node
//      drops that member there (reason: refused) and nowhere else; unrefusing
//      re-admits it from the stored broadcast with no new gossip.
//   4. FRESHNESS is enforced — advance the chain past the anchor window and
//      the stored vouchers stop being believed (reason: stale-anchor).
// The overlay units are absent here by design (no systemd): the runtime stage
// retries each pass exactly as production would on a node whose units are
// missing, and unitActive stays false. Suites 1102/1103 run the data plane.

const MESH_PORT_MIN = 16226;
const MESH_PORT_MAX = 16299;

describe('mesh membership across a multi-node fleet', function () {
  let env;
  let name;
  let ownerAuths; // zelidauth per node, app-owner key
  let teamAuth0; // zelidauth on node 0, flux-team key

  async function meshStatus(clientIndex, auth = ownerAuths[clientIndex]) {
    const res = await fetch(`${env.clients[clientIndex].url}/apps/mesh/status/${name}`, {
      headers: { zelidauth: auth },
    });
    return res.json();
  }

  async function meshLever(pathname, body) {
    const res = await fetch(`${env.clients[0].url}${pathname}`, {
      method: 'POST',
      headers: { zelidauth: teamAuth0, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  before(async function () {
    this.timeout(540000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 3,
      tickerAutostart: false,
      arcane: true,
      // Peering sized for a 3-node ring (nodes >= 2*minOutgoing+1): the fleet
      // settles as the 3-cycle 0->1, 1->2, 2->0, one outbound and one inbound
      // per node, and any higher target churns on deduped redials forever.
      configOverrides: {
        fluxapps: { meshReconcileIntervalMs: 15000, minOutgoing: 1, minIncoming: 1 },
      },
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1, pricing: true });
    ownerAuths = await Promise.all(env.clients.map(async (c) => (await authenticate(c.url, appOwnerKey())).zelidauth));
    teamAuth0 = (await authenticate(env.clients[0].url, fluxTeamKey())).zelidauth;
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('registers a mesh app and the spawner installs it on all three nodes', async function () {
    this.timeout(360000);
    name = `e2emesh${Date.now()}`;

    const reg = await registerEncryptedV9App(env.clients[0].url, {
      name,
      instances: 3,
      image: `${REGISTRY_REPO_HOST}/e2e-pause:v1`,
      specOverrides: { network: { mesh: true } },
    });
    expect(reg.status, JSON.stringify(reg)).to.equal('success');
    await queueAppTx(reg.data);
    await advanceBlocks(3);

    await waitFor(async () => {
      const rows = await Promise.all(env.clients.map((c) => c.getAppSpecs(name).catch(() => null)));
      return rows.every((r) => r && r.status === 'success' && r.data && r.data.name === name);
    }, { timeout: 120000, interval: 3000, label: `global spec for ${name} on all nodes` });

    await Promise.all(env.clients.map((c) => waitForAppInstalled(c, name, 240000)));
  });

  it('every node admits its two peers, with a pool port and real certificates', async function () {
    this.timeout(240000);

    await waitFor(async () => {
      const statuses = await Promise.all(env.clients.map((_, i) => meshStatus(i)));
      return statuses.every((s) => s.status === 'success'
        && s.data.meshEnabled === true
        && (s.data.lastPass?.members?.length ?? 0) === 2
        && (s.data.lastPass.rejected?.length ?? 0) === 0);
    }, { timeout: 180000, interval: 5000, label: 'every node admits its two peers' });

    const statuses = await Promise.all(env.clients.map((_, i) => meshStatus(i)));
    const memberSets = statuses.map((s) => s.data.lastPass.members.map((m) => m.outpoint).sort());
    // Three pairwise-distinct 2-sets over three outpoints: each node holds
    // exactly the other two.
    const keys = memberSets.map((set) => set.join('|'));
    expect(new Set(keys).size).to.equal(3);
    expect(new Set(memberSets.flat()).size).to.equal(3);

    for (const s of statuses) {
      expect(s.data.port).to.be.within(MESH_PORT_MIN, MESH_PORT_MAX);
      expect(s.data.certificates.authority, 'authority certificate').to.not.equal(null);
      expect(s.data.certificates.host, 'host certificate').to.not.equal(null);
      expect(s.data.unitActive).to.equal(false);
      expect(s.data.refused).to.deep.equal([]);
    }
  });

  it('writes the resolver membership snapshot on every node', async function () {
    this.timeout(120000);

    await waitFor(async () => {
      const reads = await Promise.all(env.clients.map((c) => execInContainer(
        c.container, 'cat /var/lib/flux-mesh/resolver/membership.json 2>/dev/null || echo ""',
      )));
      return reads.every((r) => {
        if (!r.stdout.trim()) return false;
        const snapshot = JSON.parse(r.stdout);
        const app = snapshot.apps?.find((a) => a.name === name);
        return Number.isInteger(snapshot.generation) && snapshot.generation >= 1
          && app && app.members.length === 3;
      });
    }, { timeout: 90000, interval: 5000, label: 'resolver snapshot carries the app on all nodes' });
  });

  it('a refused outpoint drops on the refusing node only, and unrefuse re-admits it', async function () {
    this.timeout(240000);

    const before0 = await meshStatus(0);
    const victim = before0.data.lastPass.members[0];
    expect(victim, 'an admitted peer').to.not.equal(undefined);

    const refused = await meshLever('/apps/mesh/refuse', { appname: name, outpoint: victim.outpoint });
    expect(refused.status, JSON.stringify(refused)).to.equal('success');

    await waitFor(async () => {
      const s = await meshStatus(0);
      return s.data.refused.includes(victim.outpoint)
        && s.data.lastPass.members.length === 1
        && !s.data.lastPass.members.some((m) => m.outpoint === victim.outpoint);
    }, { timeout: 90000, interval: 5000, label: 'refusing node drops the member' });

    const other = await meshStatus(1);
    expect(other.data.lastPass.members, 'refusal must not propagate').to.have.length(2);

    const unrefused = await meshLever('/apps/mesh/unrefuse', { appname: name, outpoint: victim.outpoint });
    expect(unrefused.status, JSON.stringify(unrefused)).to.equal('success');

    await waitFor(async () => {
      const s = await meshStatus(0);
      return !s.data.refused.includes(victim.outpoint)
        && s.data.lastPass.members.length === 2;
    }, { timeout: 90000, interval: 5000, label: 'unrefuse re-admits from the stored broadcast' });
  });

  it('a chain jump past the anchor window stops the stored vouchers being believed', async function () {
    this.timeout(240000);

    // Freeze the voucher owners first: every apprunning broadcast re-anchors
    // the stored vouchers at the broadcaster's current tip, so an unpaused
    // peer closes the staleness window at its next ~30s beat — and the 15s
    // pass cadence can miss the window entirely (the measured gate-3 window
    // was 7.3s, wholly between two passes; earlier greens were phase luck).
    // Paused, the peers cannot re-anchor, so the jump stays past the window
    // until the assertion has seen a pass reject on it.
    await Promise.all([1, 2].map((i) => pauseHostContainer(env.clients[i].container)));
    try {
      const { currentHeight } = await getState();
      await setHeight(currentHeight + 250);

      await waitFor(async () => {
        const s = await meshStatus(0);
        return (s.data.lastPass.rejected ?? []).some((r) => r.reason === 'stale-anchor');
      }, { timeout: 120000, interval: 5000, label: 'stale-anchor rejections appear' });
    } finally {
      await Promise.all([1, 2].map((i) => unpauseHostContainer(env.clients[i].container)));
    }
  });
});
