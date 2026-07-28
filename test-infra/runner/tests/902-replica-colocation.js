// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { registerEncryptedV9App, updateEncryptedV9App } from '../framework/content-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { queueAppTx, advanceBlock, advanceBlocks } from '../framework/daemon-control.js';
import { waitFor } from '../framework/wait.js';
import {
  appContainersFor, getAppContainerStatus, killAppContainer, execInContainer,
} from '../framework/container.js';
import { shutdowndControl, waitForShutdowndCall } from '../framework/shutdownd-control.js';
import { dbClient, closeDb } from '../framework/db-client.js';
import { authenticate } from '../auth.js';
import { appOwnerKey } from '../framework/keys.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';

// Two named replicas of one app on ONE node. Everything here turns on the
// runtime's identity atom being <component>_<app>_<replica> rather than
// <component>_<app>: two containers, two installed rows, two location rows, two
// seat claims, two shutdown plans — all for a single app on a single node, each
// addressable without disturbing its sibling.
//
// The properties under test, and why each is not merely cosmetic:
//   - identity reaches docker: qualified container names AND runonflux.replica
//     labels, since the labels are what the shutdown daemon groups containers by;
//   - effective ports are per-identity: siblings share a host, so a sibling
//     reading the other's ports is the concrete co-location hazard;
//   - every store keys per identity: a row keyed by app name alone would have one
//     sibling's write clobber the other's;
//   - seat claims are per identity and NEVER untagged for a named app: an
//     untagged claim beside tagged ones would over-count this node's seats on
//     peers, standing other nodes down while seats are actually unfilled;
//   - operations address one identity: kill, restart, de-target and drain each
//     hit exactly their target while the sibling keeps serving.
//
// nodes:5 with minOutgoing lowered to 2 (a 5-node full mesh only reaches ~2
// outbound/node); registration also demands minIncoming peers, which a smaller
// fleet does not reliably give the registering node. arcane:true so nodes accept
// encrypted v9 apps and the shutdown daemon is in play. Node 2 (index 1) is the
// co-location host throughout; the rest are observers whose DBs see the
// identities purely via gossip. The ticker stays off:
// update convergence rides the block-height reconcile sweep, so update tests
// advance blocks in explicit rounds.
//
// Port slice: 36xxx (suite 68 owns 35xxx).

const subnet = getSubnetConfig();
const nodeIp = (num) => subnet.nodeIp(num);

const HOST_NODE = 2; // 1-based node number hosting both replicas
const HOST_IDX = HOST_NODE - 1; // index into env.clients

describe('replica co-location: two named replicas of one app on one node, separately addressable', function () {
  let env;
  let host; // the co-location node's client
  let shutdownd; // its mock daemon control

  const base = `coloc${Date.now()}`;
  const appName = `${base}a`; // the co-located pair, s1 + s2
  const scaleName = `${base}b`; // starts single, scales to a co-located pair

  function webComponents(imageApp, { hostPort, replicaOverrides } = {}) {
    return {
      web: {
        name: 'web',
        description: 'co-location component',
        image: `${REGISTRY_REPO_HOST}/${imageApp}:v1`,
        cpu: 0.5,
        memory: 300,
        rootFsGb: 2,
        // Unsynced: co-located replicas reject synced persistent storage, and
        // each identity gets its own volume anyway.
        persistentStorage: { sizeGb: 10, mounts: { '/data': { source: 'data', destination: '/data' } } },
        ports: { game: { containerPort: 8080, hostPort } },
        env: { ADVERTISE: '${FLUX_PORT_game}' },
        // Only apps with graceful shutdown configured get a daemon plan, so
        // this is what puts the per-identity plans under test at all.
        shutdown: { gracefulTimeout: 5 },
        ...(replicaOverrides ? { replicaOverrides } : {}),
      },
    };
  }

  async function registerApp(name, { assignment, components }) {
    const res = await registerEncryptedV9App(env.clients[0].url, { name, assignment, components });
    expect(res.status, `register ${name}`).to.equal('success');
    await queueAppTx(res.data);
    await advanceBlocks(3);
    return res.data;
  }

  async function updateApp(name, { assignment, components }) {
    const res = await updateEncryptedV9App(env.clients[0].url, { name, assignment, components });
    expect(res.status, `update ${name}`).to.equal('success');
    await queueAppTx(res.data);
    await advanceBlocks(3);
    return res.data;
  }

  // Update convergence runs only at blocks processed AT THE TIP, so each round
  // advances ONE block and waits for every node to process THAT height —
  // anchoring on the height drains any explorer lag rather than letting
  // alternate heights fall into catch-up.
  async function untilWithBlocks(check, { rounds = 45, label } = {}) {
    for (let i = 0; i < rounds; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const { currentHeight } = await advanceBlock();
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(env.clients.map((c) => c.waitForEvent(
        'block:processed', (d) => d.height >= currentHeight, 60000,
      )));
      // eslint-disable-next-line no-await-in-loop
      if (await check()) return;
    }
    throw new Error(`${label} not reached within ${rounds} block-advancing rounds`);
  }

  // docker inspect of ONE identity's container. Every read below goes through a
  // replica-qualified lookup: on this node a bare app name is ambiguous.
  async function inspectReplica(appNameArg, replica, format) {
    const cont = await getAppContainerStatus(host.container, appNameArg, { replica });
    if (!cont) return null;
    const { stdout } = await execInContainer(
      host.container,
      `docker inspect --format '${format}' ${cont.name}`,
    );
    return stdout.trim();
  }

  async function replicaEnv(appNameArg, replica) {
    const raw = await inspectReplica(appNameArg, replica, '{{json .Config.Env}}');
    if (raw == null) return null;
    const out = {};
    for (const entry of JSON.parse(raw)) {
      const eq = entry.indexOf('=');
      out[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return out;
  }

  async function replicaLabels(appNameArg, replica) {
    const raw = await inspectReplica(appNameArg, replica, '{{json .Config.Labels}}');
    return raw == null ? null : JSON.parse(raw);
  }

  async function replicaHostPorts(appNameArg, replica) {
    const raw = await inspectReplica(appNameArg, replica, '{{json .HostConfig.PortBindings}}');
    if (raw == null) return [];
    return Object.values(JSON.parse(raw) || {}).flat().map((b) => Number(b.HostPort));
  }

  // StartedAt of one identity's container, '' when absent. Whether this moves is
  // the untouched-vs-recreated distinction that every "sibling undisturbed"
  // assertion rests on.
  async function replicaStartedAt(appNameArg, replica) {
    return (await inspectReplica(appNameArg, replica, '{{.State.StartedAt}}')) ?? '';
  }

  async function replicaRunning(appNameArg, replica) {
    return (await inspectReplica(appNameArg, replica, '{{.State.Running}}')) === 'true';
  }

  // The replica names present in the app's containers on the host node.
  async function runningReplicas(appNameArg) {
    const conts = await appContainersFor(host.container, appNameArg);
    return conts
      .filter((c) => c.status?.startsWith('Up'))
      .map((c) => c.name.split('_').pop())
      .sort();
  }

  before(async function () {
    this.timeout(600000);
    env = await createTestEnv({
      hookCtx: this, nodes: 5, tickerAutostart: false, arcane: true, shutdowndMock: true,
      configOverrides: {
        fluxapps: {
          minOutgoing: 2,
          // A targeted node that does not yet match an app defers it for tens of
          // minutes before rescanning; the co-located scale-up re-targets exactly
          // such a node mid-run, so the deferral must be short enough for the new
          // identity to be picked up inside the test window.
          spawnDeferrals: { targetedNodesMs: { encrypted: 30000, standard: 30000 } },
          // Rolling-update pacing is production behaviour; shrink it so an
          // identity-at-a-time rollout completes within the test windows.
          adoptionStaggerStepMs: 15000,
          adoptionStaggerWindowMs: 15000,
          // Nothing in this suite may release a seat claim by expiry: a claim row
          // that disappears must have been actively released. Renewal has to
          // undercut the TTL, so it moves with it.
          installingTtlS: 3600,
          installingRenewalS: 3000,
        },
      },
    });
    await bootAndPeer(env, { minOutbound: 2, minInbound: 2, pricing: true });
    host = env.clients[HOST_IDX];
    shutdownd = shutdowndControl(HOST_NODE);

    await pushImage(appName, 'v1');
    await pushImage(scaleName, 'v1');

    // Both replicas on ONE node with distinct effective host ports — the ports
    // are what make co-location legal, and s2's override is what keeps them
    // disjoint.
    await registerApp(appName, {
      assignment: { targetIps: { [nodeIp(HOST_NODE)]: ['s1', 's2'] } },
      components: webComponents(appName, {
        hostPort: 36010,
        replicaOverrides: { s2: { ports: { game: { hostPort: 36011 } } } },
      }),
    });

    // Registered with ONE replica; a later test adds a co-located sibling and
    // pins that the existing replica is not disturbed by the arrival.
    await registerApp(scaleName, {
      assignment: { targetIps: { [nodeIp(HOST_NODE)]: ['k1'] } },
      components: webComponents(scaleName, { hostPort: 36020 }),
    });
  });

  after(async function () {
    this.timeout(30000);
    await closeDb();
    await env?.teardown();
  });

  it('installs both identities on the one node, each as its own qualified container', async function () {
    this.timeout(420000);
    await waitFor(
      async () => (await runningReplicas(appName)).join(',') === 's1,s2',
      { timeout: 360000, interval: 3000, label: `${appName} s1+s2 both running on node ${HOST_NODE}` },
    );

    // Container names carry the replica segment, so the two identities cannot
    // collide on the docker daemon.
    const conts = await appContainersFor(host.container, appName);
    const names = conts.map((c) => c.name).sort();
    expect(names).to.deep.equal([`fluxweb_${appName}_s1`, `fluxweb_${appName}_s2`]);

    // Labels are the identity of record — the shutdown daemon groups containers
    // by runonflux.replica, so a missing label silently merges the siblings.
    const s1Labels = await replicaLabels(appName, 's1');
    const s2Labels = await replicaLabels(appName, 's2');
    expect(s1Labels['runonflux.app']).to.equal(appName);
    expect(s1Labels['runonflux.replica']).to.equal('s1');
    expect(s2Labels['runonflux.replica']).to.equal('s2');
    expect(s1Labels['runonflux.component']).to.equal('web');
  });

  it('gives each identity its own effective ports and platform env', async function () {
    this.timeout(60000);
    const s1Env = await replicaEnv(appName, 's1');
    const s2Env = await replicaEnv(appName, 's2');

    expect(s1Env.FLUX_REPLICA).to.equal('s1');
    expect(s2Env.FLUX_REPLICA).to.equal('s2');
    expect(s1Env.FLUX_PORT_game).to.equal('36010');
    expect(s2Env.FLUX_PORT_game).to.equal('36011');
    // The user's ${FLUX_PORT_game} reference resolves against the identity's OWN
    // effective port — a sibling's value here is the wrong-ports hazard.
    expect(s1Env.ADVERTISE).to.equal('36010');
    expect(s2Env.ADVERTISE).to.equal('36011');

    expect(await replicaHostPorts(appName, 's1')).to.deep.equal([36010]);
    expect(await replicaHostPorts(appName, 's2')).to.deep.equal([36011]);
  });

  it('keys the installed and location rows per identity, on the host and across the fleet', async function () {
    this.timeout(120000);
    // Installed state is per deployed identity: a replica must be installed
    // before anything may start it, and a single app-keyed row cannot answer
    // "is this replica installed here" — the question the spawner asks before
    // provisioning and the reconciler asks before actuating.
    const localRows = await dbClient(host.num).getLocalApps(appName);
    expect(localRows.map((r) => r.replica).sort()).to.deep.equal(['s1', 's2']);

    // Peers see two location rows for the SAME (name, ip): the pair is
    // distinguishable only by replica, so a row keyed (name, ip) alone would
    // collapse them into one and under-report the node.
    const observer = env.clients.find((c, i) => i !== HOST_IDX);
    await waitFor(
      async () => {
        const rows = (await observer.getAppLocations(appName)).data
          .filter((r) => r.ip.startsWith(nodeIp(HOST_NODE)));
        return rows.length === 2 && rows.every((r) => r.replica);
      },
      { timeout: 90000, interval: 3000, label: `${appName} two per-identity location rows on a peer` },
    );
    const rows = (await observer.getAppLocations(appName)).data
      .filter((r) => r.ip.startsWith(nodeIp(HOST_NODE)));
    expect(rows.map((r) => r.replica).sort()).to.deep.equal(['s1', 's2']);
  });

  it('releases every seat claim, and never announces an untagged claim for a named app', async function () {
    this.timeout(120000);
    // A named app announces one TAGGED claim per assigned identity and no
    // untagged one. An untagged row beside them would be a third seat for two
    // identities on capable peers — over-counting, which stands other nodes down
    // while seats are genuinely unfilled.
    for (const client of env.clients) {
      // eslint-disable-next-line no-await-in-loop
      const claims = await dbClient(client.num).getAppInstallingLocations(appName);
      const untagged = claims.filter((r) => r.replica == null);
      expect(untagged, `node ${client.num} holds an untagged claim for a named app`).to.deep.equal([]);
    }

    // With the TTL pinned far beyond this suite, a released claim is one the
    // install path actively cleared — not one that expired.
    await waitFor(
      async () => {
        const all = await Promise.all(
          env.clients.map((c) => dbClient(c.num).getAppInstallingLocations(appName)),
        );
        return all.every((rows) => rows.length === 0);
      },
      { timeout: 90000, interval: 3000, label: `${appName} claims released on every node` },
    );
  });

  it('holds one shutdown plan per identity on the daemon', async function () {
    this.timeout(120000);
    // The daemon keys plans owner:app[:replica]. Two plans for one app on one
    // node is the co-location shape; one plan would mean a sibling's drain
    // budget and component order were silently applied to both.
    await waitFor(
      async () => {
        const { plans } = await shutdownd.getState();
        const mine = plans.filter((k) => k.includes(`:${appName}`));
        return mine.length === 2 && mine.every((k) => /:(s1|s2)$/.test(k));
      },
      { timeout: 90000, interval: 3000, label: `${appName} two per-identity plans on the daemon` },
    );
  });

  it('recovers exactly the killed identity, leaving its sibling untouched', async function () {
    this.timeout(300000);
    const s2Before = await replicaStartedAt(appName, 's2');
    expect(s2Before, 's2 running before the kill').to.not.equal('');

    await killAppContainer(host.container, appName, 'web', 's1');
    await waitFor(
      async () => !(await replicaRunning(appName, 's1')),
      { timeout: 30000, interval: 1000, label: 's1 container gone' },
    );

    // The health monitor recreates the missing container from ITS identity's
    // view; handing it the sibling's view is what would bind the wrong ports.
    await waitFor(
      async () => replicaRunning(appName, 's1'),
      { timeout: 240000, interval: 3000, label: 's1 recreated' },
    );
    expect(await replicaHostPorts(appName, 's1'), 's1 rebuilt on its own port').to.deep.equal([36010]);
    expect((await replicaEnv(appName, 's1')).FLUX_REPLICA).to.equal('s1');

    // The sibling was never restarted.
    expect(await replicaStartedAt(appName, 's2'), 's2 must be undisturbed by s1 recovery').to.equal(s2Before);
  });

  it('bounces exactly one identity on a replica-scoped restart', async function () {
    this.timeout(180000);
    const s1Before = await replicaStartedAt(appName, 's1');
    const s2Before = await replicaStartedAt(appName, 's2');

    // Identity rides a structured query param: a two-segment name like app_s1
    // would misparse as the component_app form the route already accepts.
    const auth = await authenticate(host.url, appOwnerKey());
    const res = await host.getAuthed(`/apps/apprestart/${appName}?replica=s1`, auth.zelidauth);
    expect(res.status, `apprestart ?replica=s1: ${JSON.stringify(res.data)}`).to.equal('success');

    await waitFor(
      async () => (await replicaStartedAt(appName, 's1')) !== s1Before,
      { timeout: 120000, interval: 2000, label: 's1 restarted' },
    );
    expect(await replicaStartedAt(appName, 's2'), 's2 must not move on a replica-scoped restart').to.equal(s2Before);
    expect(await replicaRunning(appName, 's2'), 's2 still serving').to.equal(true);
  });

  it('adds a co-located sibling without disturbing the replica already running', async function () {
    this.timeout(420000);
    await waitFor(
      async () => (await runningReplicas(scaleName)).join(',') === 'k1',
      { timeout: 360000, interval: 3000, label: `${scaleName} k1 running` },
    );
    const k1Before = await replicaStartedAt(scaleName, 'k1');
    expect(k1Before, 'k1 running before scale-up').to.not.equal('');

    // A named replica is qualified even when alone on its node, so gaining a
    // sibling never rewrites the existing identity — no recreate, no rename.
    await updateApp(scaleName, {
      assignment: { targetIps: { [nodeIp(HOST_NODE)]: ['k1', 'k2'] } },
      components: webComponents(scaleName, {
        hostPort: 36020,
        replicaOverrides: { k2: { ports: { game: { hostPort: 36021 } } } },
      }),
    });

    await untilWithBlocks(
      async () => (await runningReplicas(scaleName)).join(',') === 'k1,k2',
      { rounds: 60, label: `${scaleName} scaled to a co-located pair` },
    );
    expect(await replicaStartedAt(scaleName, 'k1'), 'the existing replica must not restart when a sibling arrives').to.equal(k1Before);
    expect(await replicaHostPorts(scaleName, 'k2')).to.deep.equal([36021]);
  });

  it('drains and removes exactly the de-targeted identity', async function () {
    this.timeout(420000);
    const s1Before = await replicaStartedAt(appName, 's1');

    // s2 leaves the spec; s1 stays.
    await updateApp(appName, {
      assignment: { targetIps: { [nodeIp(HOST_NODE)]: ['s1'] } },
      components: webComponents(appName, { hostPort: 36010 }),
    });

    // The drain is aimed at s2's identity: a whole-app stop here would take the
    // surviving sibling down with it.
    const stopCall = await waitForShutdowndCall(
      shutdownd,
      (c) => c.method === 'begin_app_stop' && c.app === appName,
      { timeout: 300000 },
    );
    expect(stopCall.replica, 'the de-target drain must name the departing identity').to.equal('s2');

    await untilWithBlocks(
      async () => (await runningReplicas(appName)).join(',') === 's1',
      { rounds: 60, label: `${appName} converged to s1 alone` },
    );

    // s1 kept serving throughout, and only s2's rows and plan were reaped.
    expect(await replicaStartedAt(appName, 's1'), 'the surviving replica must not restart on a sibling removal').to.equal(s1Before);
    const localRows = await dbClient(host.num).getLocalApps(appName);
    expect(localRows.map((r) => r.replica)).to.deep.equal(['s1']);

    await waitFor(
      async () => {
        const { plans } = await shutdownd.getState();
        const mine = plans.filter((k) => k.includes(`:${appName}`));
        return mine.length === 1 && mine[0].endsWith(':s1');
      },
      { timeout: 120000, interval: 3000, label: `${appName} only s1's plan remains` },
    );
  });
});
