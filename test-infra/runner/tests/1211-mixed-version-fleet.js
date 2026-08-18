// weight: heavy
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { bootAndPeer, installOnNodes, seedSyncScopedData } from '../framework/reconciler-suite.js';
import { buildSeedableSyncthingApp } from '../framework/seed-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { setSynced } from '../framework/syncthing-control.js';
import { getAppContainerStatus } from '../framework/container.js';
import { waitFor, waitForAppInstalled, waitForReconcileActuated, assertNoEvent } from '../framework/wait.js';

// The rollout surface (§13.6): old and new FluxOS coexist on one network, and
// the plane's whole safety story is SEQUENCING — it governs only once the
// network-enforced version floor (config.minimumFluxOSAllowedVersion, a
// per-release constant enforced peer-to-peer at handshake) reaches the release
// that carries the plane. Two fleets, two phases of the same rollout:
//
//   COEXISTENCE — the floor is below the plane's pin. The plane must be INERT
//   on every new node: the legacy election governs the mixed fleet, apps
//   serve, and not one grant is pursued. The dangerous world is both regimes
//   actuating at once; this phase proves the new one stays silent.
//
//   CUTOVER — new nodes carry a raised floor (how a real release raises it),
//   so they refuse the old node at handshake: network eviction, exactly as
//   production retires laggards. The plane now governs among the new nodes
//   and seats a master there. The old node's zombie copy is the documented
//   rollout boundary — the plane cannot depose what has no plane; production
//   bounds it by the upgrade cycle and by its location rows expiring
//   fleet-side (which drops its syncthing device off the survivors' folder
//   configs).
//
// Committees may seat old nodes as referees: the daemon's node list carries
// every staked node whatever its version, and an old referee is simply a
// silent cell — the heal path's job, proven in 1203/1208, exercised here
// under genuinely mixed membership.

const __dirname = dirname(fileURLToPath(import.meta.url));
const CURRENT_VERSION = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
).version;

const GRANT_TUNABLES = {
  quorumGrantMastership: true,
  quorumGrantHeldTtlMs: 90000,
  quorumGrantRenewIntervalMs: 10000,
  quorumGrantLockDelayMs: 15000,
  quorumGrantDemotionSlackMs: 5000,
  quorumGrantMaxTtlMs: 120000,
  quorumGrantDrainMs: 90000,
  quorumGrantMinHolderAgeMs: 0,
  quorumGrantPursuitIntervalMs: 10000,
  quorumGrantUnknownGraceMs: 30000,
};

describe('mixed-version fleet: coexistence — the plane stays inert below the floor', function () {
  let env;
  let name;
  const OLD = [6, 7, 8, 9];
  const HOLDERS = [6, 7, 8]; // all old: the legacy election is the regime under test

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 10,
      oldNodes: OLD,
      tickerAutostart: false,
      zmqTopics: ALL_ZMQ_TOPICS,
      configOverrides: {
        fluxapps: {
          ...GRANT_TUNABLES,
          // Pinned ABOVE any floor in force: the plane ships everywhere inert.
          quorumGrantMinFluxOSVersion: '99.0.0',
        },
      },
    });
    await bootAndPeer(env);

    name = `e2emixold${Date.now()}`;
    await pushImage(name, 'v1');
    const app = await buildSeedableSyncthingApp({ name, syncMode: 'activeStandby' });
    const installAfters = HOLDERS.map((i) => env.clients[i].getLastEventId());
    await installOnNodes(env, app, HOLDERS);
    await Promise.all(HOLDERS.map((i) => waitForAppInstalled(env.clients[i], name, 240000)));
    await Promise.all(HOLDERS.map(async (i, k) => {
      await waitForReconcileActuated(env.clients[i], `${name}_${name}`, 'dataCleared', 60000, { afterId: installAfters[k] });
      await seedSyncScopedData(env, name, i);
    }));
    await setSynced({ folder: `flux${name}_${name}` });
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('the legacy election seats exactly one master and no grant is ever pursued', async function () {
    this.timeout(420000);

    // The legacy regime converges: exactly one holder runs the container.
    await waitFor(async () => {
      const statuses = await Promise.all(HOLDERS.map(
        (i) => getAppContainerStatus(env.clients[i].container, name).catch(() => null),
      ));
      return statuses.filter((st) => st && st.status.startsWith('Up')).length === 1;
    }, { timeout: 240000, interval: 10000, label: 'the legacy election seats exactly one master' });

    // And the plane stayed silent on every NEW node for a full pursuit+term
    // cycle: no grant, no pursuit — the sequencing gate is the only thing
    // between the two regimes actuating at once.
    await Promise.all([0, 1, 2, 3, 4, 5].map((i) => assertNoEvent(
      env.clients[i], 'quorumGrant:granted', () => true, 100000,
    )));
  });
});

describe('mixed-version fleet: cutover — the floor rises and the plane takes over', function () {
  let env;
  let name;
  const OLD = [6]; // one laggard; the rest of the fleet carries the new release
  const NEW = [0, 1, 2, 3, 4, 5, 7, 8, 9];
  const HOLDERS = [0, 1, 6]; // two new holders, one old — the seat that must not matter

  async function readCell(clientIndex) {
    try {
      const res = await fetch(
        `${env.clients[clientIndex].url}/flux/quorumgrant/record?key=${encodeURIComponent(`${name}/master`)}`,
        { signal: AbortSignal.timeout(5000) },
      );
      const body = await res.json();
      return body?.data?.accepted ?? null;
    } catch {
      return null;
    }
  }

  async function quorumVerdict() {
    const cells = await Promise.all(NEW.map((i) => readCell(i)));
    const live = cells.filter((c) => c && c.grantee && !c.released);
    const counts = new Map();
    for (const cell of live) {
      counts.set(cell.grantee, (counts.get(cell.grantee) ?? 0) + 1);
    }
    for (const [grantee, count] of counts.entries()) {
      if (count >= 5) return { grantee };
    }
    return null;
  }

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 10,
      oldNodes: OLD,
      tickerAutostart: false,
      zmqTopics: ALL_ZMQ_TOPICS,
      configOverrides: {
        fluxapps: {
          ...GRANT_TUNABLES,
          quorumGrantMinFluxOSVersion: '8.13.1',
        },
      },
      // The raised floor rides the NEW release's config, exactly as in
      // production: new nodes refuse the old one at handshake. The old node
      // keeps its own (low) baked floor.
      nodeConfigOverrides: Object.fromEntries(
        NEW.map((i) => [i, { minimumFluxOSAllowedVersion: CURRENT_VERSION }]),
      ),
    });
    // bootAndPeer gates peer thresholds on node 0 (a NEW node here); the old
    // node only has to pass its own boot waits, which need no peers.
    await bootAndPeer(env);

    name = `e2emixcut${Date.now()}`;
    await pushImage(name, 'v1');
    const app = await buildSeedableSyncthingApp({ name, syncMode: 'activeStandby' });
    const installAfters = HOLDERS.map((i) => env.clients[i].getLastEventId());
    await installOnNodes(env, app, HOLDERS);
    await Promise.all(HOLDERS.map((i) => waitForAppInstalled(env.clients[i], name, 240000)));
    await Promise.all(HOLDERS.map(async (i, k) => {
      await waitForReconcileActuated(env.clients[i], `${name}_${name}`, 'dataCleared', 60000, { afterId: installAfters[k] });
      await seedSyncScopedData(env, name, i);
    }));
    await setSynced({ folder: `flux${name}_${name}` });
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('the old node is off the mesh, and the plane seats a master among the new holders', async function () {
    this.timeout(600000);

    // Network eviction: no new node lists the old node as a peer.
    const oldIp = env.clients[6].ip ?? null;
    await waitFor(async () => {
      const lists = await Promise.all(NEW.map(async (i) => {
        try {
          const res = await fetch(`${env.clients[i].url}/flux/connectedpeers`, { signal: AbortSignal.timeout(5000) });
          const body = await res.json();
          return JSON.stringify(body?.data ?? []);
        } catch {
          return '';
        }
      }));
      return oldIp === null || lists.every((l) => !l.includes(oldIp));
    }, { timeout: 120000, interval: 10000, label: 'the old node is refused by every new peer' });

    // The plane governs: a grant quorum forms among the NEW nodes and the
    // seated master is one of the NEW holders — the old holder's seat cannot
    // win a term it cannot ask for.
    let verdict = null;
    await waitFor(async () => {
      verdict = await quorumVerdict();
      return verdict !== null;
    }, { timeout: 300000, interval: 10000, label: 'a grant quorum forms among the new nodes' });

    const newHolderOutpoints = await Promise.all([0, 1].map(async (i) => {
      const status = await env.clients[i].getNodeStatus();
      return `${status.data.txhash}:${status.data.outidx}`;
    }));
    expect(newHolderOutpoints, 'the master is a NEW holder').to.include(verdict.grantee);

    // Exactly one master runs among the new holders. The old node's copy is
    // the documented rollout boundary: the plane cannot depose what has no
    // plane, and production bounds the zombie by the upgrade cycle and by its
    // location rows expiring fleet-side.
    const upNew = await Promise.all([0, 1].map(
      (i) => getAppContainerStatus(env.clients[i].container, name).catch(() => null),
    ));
    expect(upNew.filter((st) => st && st.status.startsWith('Up')).length, 'exactly one new-holder master').to.equal(1);
  });
});
