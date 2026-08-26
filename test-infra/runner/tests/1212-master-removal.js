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
import { waitFor, waitForAppInstalled, waitForReconcileActuated } from '../framework/wait.js';
import { authenticate } from '../auth.js';
import { appOwnerKey } from '../framework/keys.js';

// Removing the master's app from a LIVE node — scale-down, re-placement, an
// operator's local removal — is a failover the node itself must announce. The
// teardown releases the grant (the grant follows the data: a true removal
// destroys it), so a standby is seated with no lock-delay and the term never
// rests against a phantom. The dead-node suites (1203/1204) cannot see this
// hole: killing the node kills the Holder with it. Here the node STAYS UP —
// FluxOS keeps running, only the app leaves — which is exactly the state
// where a leaked Holder would keep renewing a term nobody serves.

const HOLDERS = [0, 1, 2];

describe('removing the master\'s app from a live node', function () {
  let env;
  let name;
  let holderOutpoints;
  let ownerAuths;

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
    const cells = await Promise.all(env.clients.map((_, i) => readCell(i)));
    const live = cells.filter((c) => c && c.grantee && !c.released);
    const counts = new Map();
    for (const cell of live) {
      counts.set(cell.grantee, (counts.get(cell.grantee) ?? 0) + 1);
    }
    for (const [grantee, count] of counts.entries()) {
      if (count >= 5) {
        const epoch = Math.max(...live.filter((c) => c.grantee === grantee).map((c) => c.epoch));
        return { grantee, epoch };
      }
    }
    return null;
  }

  async function runningMasters() {
    const statuses = await Promise.all(env.clients.map(
      (c) => getAppContainerStatus(c.container, name).catch(() => null),
    ));
    return statuses.filter((st) => st && st.status.startsWith('Up')).length;
  }

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 10,
      tickerAutostart: false,
      // The founding photos pin committees at spec anchor heights, which
      // needs the ANCHORED membership history — see 1209.
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
          quorumGrantUnknownGraceMs: 30000,
          quorumGrantActivationHeight: 2_100_000,
        },
      },
    });
    await bootAndPeer(env);

    name = `e2eremove${Date.now()}`;
    await pushImage(name, 'v1');
    const app = await buildSeedableSyncthingApp({ name, syncMode: 'activeStandby' });
    const installAfters = HOLDERS.map((i) => env.clients[i].getLastEventId());
    await installOnNodes(env, app, HOLDERS);
    await Promise.all(HOLDERS.map((i) => waitForAppInstalled(env.clients[i], name, 240000)));
    // Synced-on-every-holder before anything else — the stall ladder otherwise
    // removes the standbys mid-test (see 1209's before for the full account).
    await Promise.all(HOLDERS.map(async (i, k) => {
      await waitForReconcileActuated(env.clients[i], `${name}_${name}`, 'dataCleared', 60000, { afterId: installAfters[k] });
      await seedSyncScopedData(env, name, i);
    }));
    await setSynced({ folder: `flux${name}_${name}` });

    holderOutpoints = {};
    ownerAuths = new Map();
    for (const i of HOLDERS) {
      const status = await env.clients[i].getNodeStatus();
      holderOutpoints[i] = `${status.data.txhash}:${status.data.outidx}`;
      ownerAuths.set(i, (await authenticate(env.clients[i].url, appOwnerKey())).zelidauth);
    }
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('releases the grant with the data: a standby is seated fast, and the removed node never shields the term', async function () {
    this.timeout(600000);

    let first = null;
    await waitFor(async () => {
      first = await quorumVerdict();
      return first !== null;
    }, { timeout: 240000, interval: 10000, label: 'a grant quorum forms' });
    const masterIndex = Number(Object.keys(holderOutpoints).find((i) => holderOutpoints[i] === first.grantee));
    expect(Number.isInteger(masterIndex), `master ${first.grantee} maps to a holder`).to.equal(true);
    const standbys = HOLDERS.filter((i) => i !== masterIndex);
    const standbyAfters = new Map(standbys.map((i) => [i, env.clients[i].getLastEventId()]));

    await env.clients[masterIndex].removeApp(name, { zelidauth: ownerAuths.get(masterIndex) });

    // Voluntary release rides the teardown: a successor seats with no
    // lock-delay, on the standbys' next pursuit cadence.
    await Promise.any(standbys.map((i) => env.clients[i].waitForEvent(
      'quorumGrant:granted', (d) => d.key === `${name}/master`, 120000, { afterId: standbyAfters.get(i) },
    ))).catch((err) => {
      throw new Error(`no standby was seated after the removal (${err.errors?.[0]?.message ?? err.message})`);
    });
    let second = null;
    await waitFor(async () => {
      second = await quorumVerdict();
      return second !== null && second.grantee !== first.grantee;
    }, { timeout: 60000, interval: 5000, label: 'the successor holds the quorum view' });
    expect(second.epoch, 'the term moved strictly forward').to.be.greaterThan(first.epoch);

    // The removed node's container is gone, and exactly one master serves.
    await waitFor(async () => {
      const status = await getAppContainerStatus(env.clients[masterIndex].container, name, { all: true }).catch(() => null);
      return !status;
    }, { timeout: 120000, interval: 5000, label: 'the removed node\'s container is torn down' });
    await waitFor(async () => (await runningMasters()) === 1, {
      timeout: 120000, interval: 5000, label: 'exactly one master runs',
    });

    // The term SETTLES on the successor: a leaked Holder on the removed node
    // would keep renewing the old term (the standbys would rest forever) or
    // fight the new one — either way the verdict could not remain the
    // successor's. Hold the assertion across a full renewal interval.
    await new Promise((resolve) => { setTimeout(resolve, 30000); });
    const settled = await quorumVerdict();
    expect(settled, 'the quorum view stands').to.not.equal(null);
    expect(settled.grantee, 'the term stays with the successor').to.equal(second.grantee);
  });
});
