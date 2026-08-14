// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { bootAndPeer, installOnNodes } from '../framework/reconciler-suite.js';
import { buildSeedableSyncthingApp } from '../framework/seed-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { blockOwnAddress, unblockOwnAddress, getAppContainerStatus } from '../framework/container.js';
import { waitFor, waitForAppInstalled } from '../framework/wait.js';
import { getSubnetConfig } from '../framework/subnet-config.js';

// A holder that cannot reach its OWN listed address.
//
// Holder unanimity asks every OTHER holder of an app whether it speaks the
// grant plane, and one silent holder puts the whole app on the legacy path
// everywhere — the symmetric fallback the design demands. What it must never
// do is ask THIS node: a node cannot always reach its own listed address from
// inside itself (NAT without hairpinning, ordinary across the fleet), so a
// node that probed itself would fail its own probe, hold unanimity false
// forever, and fall alone onto the legacy election while its peers — which
// reach it perfectly well from outside — stayed shielded by the grant. Two
// elections over one app: the exact asymmetry the rule exists to close.
//
// No partition can model this. The unreachable address belongs to the node
// doing the reaching, so the fault lives inside one node's own routing, and
// every fleet the harness has ever booted sits on a flat subnet where a node
// answers itself. That is why the defect this pins survived both the unit
// tests and every previous fleet run.
//
// Here all three holders are made blind to themselves BEFORE the app is ever
// installed, so the plane has never once engaged unblinded. It cannot then
// engage by accident: the acquisition that publishes `granted` runs only
// behind the unanimity gate, so the event IS the proof that the probe passed
// on a fleet where no holder can ask itself anything.

const HOLDERS = [0, 1, 2];

describe('a holder blind to its own address still speaks the grant plane', function () {
  let env;
  let name;
  let holderOutpoints;

  async function readCell(clientIndex) {
    try {
      const res = await fetch(
        `${env.clients[clientIndex].url}/flux/quorumgrant/record?key=${encodeURIComponent(`${name}/master`)}`,
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
    return statuses.filter((s) => s && s.status.startsWith('Up')).length;
  }

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 10,
      tickerAutostart: false,
      // The founding photos pin committees at spec anchor heights, which
      // needs the ANCHORED membership history — the ZMQ delta machinery
      // production runs. The harness default is the polling path, whose
      // history carries no chain anchors and can never answer at-height.
      zmqTopics: ALL_ZMQ_TOPICS,
      configOverrides: {
        fluxapps: {
          quorumGrantMastership: true,
          quorumGrantHeldTtlMs: 45000,
          quorumGrantRenewIntervalMs: 10000,
          quorumGrantLockDelayMs: 15000,
          quorumGrantDemotionSlackMs: 5000,
          quorumGrantMaxTtlMs: 60000,
          quorumGrantDrainMs: 45000,
          quorumGrantMinHolderAgeMs: 0,
          quorumGrantPursuitIntervalMs: 10000,
          quorumGrantUnknownGraceMs: 30000,
          quorumGrantUnanimityCacheMs: 15000,
        },
      },
    });
    await bootAndPeer(env);

    // Blinded before the app exists: the plane must come up this way, never
    // engage first and be blinded after. Only the holders are blinded — a
    // node hosting nothing never runs the probe for this app.
    for (const i of HOLDERS) {
      await blockOwnAddress(env.clients[i].container, getSubnetConfig().nodeIp(i + 1));
    }

    name = `e2eselfblind${Date.now()}`;
    await pushImage(name, 'v1');
    const app = await buildSeedableSyncthingApp({ name, mode: 'g' });
    await installOnNodes(env, app, HOLDERS);
    await Promise.all(HOLDERS.map((i) => waitForAppInstalled(env.clients[i], name, 240000)));

    holderOutpoints = {};
    for (const i of HOLDERS) {
      const status = await env.clients[i].getNodeStatus();
      holderOutpoints[i] = `${status.data.txhash}:${status.data.outidx}`;
    }
  });

  after(async function () {
    this.timeout(60000);
    for (const i of HOLDERS) {
      await unblockOwnAddress(env?.clients[i]?.container, getSubnetConfig().nodeIp(i + 1)).catch(() => {});
    }
    await env?.teardown();
  });

  it('the grant is acquired and seated though no holder can probe itself', async function () {
    // The three waits below are sequential and each carries its own budget;
    // the hook must outlast their sum, not match it.
    this.timeout(900000);

    // The granted event is the discriminator: nothing publishes it except an
    // acquisition, and no acquisition runs unless holder unanimity passed on
    // a node that could not have reached itself to be counted. Promise.any
    // reports every rejection as one opaque AggregateError, so the failure
    // states its own diagnosis instead.
    await Promise.any(HOLDERS.map((i) => env.clients[i].waitForEvent(
      'quorumGrant:granted', (d) => d.key === `${name}/master`, 300000,
    ))).catch(() => {
      throw new Error(
        `no holder acquired ${name}/master while blind to its own address - the `
        + 'unanimity probe is counting this node among the holders it must ask, '
        + 'and failing to reach itself',
      );
    });

    let verdict = null;
    await waitFor(async () => {
      verdict = await quorumVerdict();
      return verdict !== null;
    }, { timeout: 120000, interval: 5000, label: 'a grant quorum forms' });
    expect(Object.values(holderOutpoints), `grantee ${verdict.grantee}`).to.include(verdict.grantee);

    // The safety property rides along, though it is not what discriminates
    // here: the legacy election would also seat exactly one master. What the
    // grant adds is that the one running container is the one the registers
    // name.
    await waitFor(async () => (await runningMasters()) === 1, {
      timeout: 180000, interval: 10000, label: 'exactly one master container fleet-wide',
    });
    const masterIndex = Number(Object.keys(holderOutpoints).find((i) => holderOutpoints[i] === verdict.grantee));
    const masterStatus = await getAppContainerStatus(env.clients[masterIndex].container, name);
    expect(masterStatus && masterStatus.status.startsWith('Up'), 'the grantee is the node that runs').to.equal(true);
  });
});
