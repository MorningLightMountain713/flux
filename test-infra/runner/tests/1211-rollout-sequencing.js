// weight: heavy
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

// The rollout's sequencing claim (§13.6): the plane ships everywhere INERT and
// governs only from an agreed block. Two things gate it and they answer different
// questions. The network-enforced version floor
// (config.minimumFluxOSAllowedVersion, refused at handshake) settles WHETHER a
// node has the code at all — a node without it is not on the network to elect
// anything. The activation height settles WHEN everyone starts using it, which a
// version cannot: each node satisfies a version comparison the moment IT upgrades,
// and the watchdog spreads upgrades over hours, so a version-only gate has a
// window in which some nodes grant while the rest still elect. A height is the one
// value every node answers identically, at the same time.
//
// Below the height the fleet is, behaviorally, the legacy world: the legacy
// election governs, apps serve, and not one grant is pursued anywhere. The
// dangerous rollout state is both regimes actuating at once, and this suite pins
// the half no other suite covers — the plane staying SILENT while scheduled for a
// block the chain has not reached. (The active half is every other 12xx suite; a
// version-evicted or genuinely old node is, to the plane, a listed-but-silent
// cell — 1213's dark-referee content, both flavors. Real wire interop with
// the deployed release is the v9 RELEASE qualification, tested in the
// rebase-time program, not a plane property.)

const HOLDERS = [0, 1, 2];

describe('rollout sequencing: the plane stays inert below the activation height', function () {
  let env;
  let name;

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 10,
      tickerAutostart: false,
      zmqTopics: ALL_ZMQ_TOPICS,
      configOverrides: {
        fluxapps: {
          quorumGrantMastership: true,
          quorumGrantHeldTtlMs: 90000,
          quorumGrantRenewIntervalMs: 10000,
          quorumGrantLockDelayMs: 15000,
          quorumGrantDemotionSlackMs: 5000,
          quorumGrantMaxTtlMs: 120000,
          quorumGrantDrainMs: 90000,
          quorumGrantMinHolderAgeMs: 0,
          quorumGrantPursuitIntervalMs: 10000,
          // Scheduled for a block this chain never reaches: the exact state every
          // node ships in until the activation block arrives.
          quorumGrantActivationHeight: 99_000_000,
        },
      },
    });
    await bootAndPeer(env);

    name = `e2einert${Date.now()}`;
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

  it('the legacy election seats exactly one master, and not one grant is pursued fleet-wide', async function () {
    this.timeout(420000);

    // The legacy regime converges: exactly one holder runs the container.
    await waitFor(async () => {
      const statuses = await Promise.all(HOLDERS.map(
        (i) => getAppContainerStatus(env.clients[i].container, name).catch(() => null),
      ));
      return statuses.filter((st) => st && st.status.startsWith('Up')).length === 1;
    }, { timeout: 240000, interval: 10000, label: 'the legacy election seats exactly one master' });

    // And the plane stays silent on EVERY node for a full pursuit+term cycle:
    // no grant granted, no founding served — the sequencing gate is the only
    // thing between the two regimes actuating at once, so its silence is the
    // whole claim.
    await Promise.all(env.clients.map((c) => assertNoEvent(
      c, 'quorumGrant:granted', () => true, 100000,
    )));
    const cells = await Promise.all(env.clients.map(async (client) => {
      try {
        const res = await fetch(
          `${client.url}/flux/quorumgrant/record?key=${encodeURIComponent(`${name}/master`)}`,
          { signal: AbortSignal.timeout(5000) },
        );
        const body = await res.json();
        return body?.data?.accepted ?? null;
      } catch {
        return null;
      }
    }));
    expect(cells.filter(Boolean), 'no register anywhere holds a grant').to.deep.equal([]);
  });
});
