// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { registerEncryptedV9App, updateEncryptedV9App } from '../framework/content-helper.js';
import { queueAppTx, advanceBlocks } from '../framework/daemon-control.js';
import { waitFor, waitForAppInstalled } from '../framework/wait.js';
import {
  appContainersFor, getAppContainerStatus, execInContainer, fluxAppNetworkName,
} from '../framework/container.js';
import { authenticate } from '../auth.js';
import { appOwnerKey } from '../framework/keys.js';
import { pushBusybox } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';

const subnet = getSubnetConfig();
const nodeIp = (num) => subnet.nodeIp(num);

// App-level dependencies on a real fleet: the tier-1 model APP_RELATIONSHIPS.md
// §9 ships in v9.0 — pinned workloads whose edges pull an independently
// registered follower onto their node, ref-counted there, cascaded and reaped
// by relationshipResolver. Every app here is encrypted, so the graph functions
// are exercised through the sealed/resolved-view split, not the cleartext
// shortcut. What the unit suites cannot prove and this fleet does:
//   - pull-in + suppression: the follower (activation standalone:false,
//     stopWhenUnneeded:true) exists exactly where a requirer is pinned, and
//     nowhere else, with the requirer's install root-first behind its gate;
//   - the network dial: the requirer's container reaches the follower over the
//     follower's private docker network by docker DNS — the folded shareWith;
//   - the strength split under a real operator stop: a boundTo requirer is
//     stopped while its target is down and returns with it, while a
//     requires-strength sibling keeps running through the same outage;
//   - defer-not-fail: a consumer whose dependency is not registered yet stays
//     uninstalled without entering the spawner's error cache, and installs the
//     moment the dependency arrives — root-first;
//   - onRemove cascade on a real teardown: cancelling the dependency removes
//     its cascade-consumer first and leaves nothing behind;
//   - the ref-count reap: cancelling the last requirer reaps the follower
//     locally while its global registration lives on.
// The (standalone:true, stopWhenUnneeded:true) self-hold cell needs an
// UNPINNED pull-in (spawner-scheduled follower affinity — §9 tier 2) and stays
// unit-tested until that tier exists.
//
// nodes:3 with minOutgoing/minIncoming 1 (as the mesh suites); arcane so the
// harness policy grant opens appRelationships (bit 24) + its networkSharing
// child and nodes accept encrypted v9 apps. manageCollectorLifecycle on — the
// node-managed collector lifecycle is the runtime under test.
//
// Node 1 (index 0) hosts the collector + its two requirers; node 3 (index 2)
// hosts the late/cascade pair. Port slice: 31284-31288.

const HOST_IDX = 0; // node 1 — collector, game, bound
const LATE_IDX = 2; // node 3 — late consumer + its late-arriving dependency

describe('app dependencies: follower pull-in, strength split, cascade and reap', function () {
  let env;
  let hostAuth;
  const base = `e2edep${Date.now()}`;
  const apps = {
    collector: `${base}col`,
    game: `${base}game`,
    bound: `${base}bnd`,
    late: `${base}late`,
    latedep: `${base}ldep`,
  };

  const followerOverrides = { activation: { standalone: false, stopWhenUnneeded: true } };

  function echoComponents(imageApp, hostPort, reply) {
    return {
      web: {
        name: 'web',
        description: 'dependency suite echo component',
        image: `${REGISTRY_REPO_HOST}/${imageApp}:v1`,
        cpu: 0.5,
        memory: 300,
        rootFsGb: 2,
        entrypoint: ['/bin/busybox', 'sh', '-c',
          `while true; do /bin/busybox nc -l -p 8080 -e /bin/busybox echo ${reply}; done`],
        ports: { echo: { containerPort: 8080, hostPort } },
      },
    };
  }

  async function registerApp(name, { hostPort, reply, assignment, specOverrides, instances }) {
    await pushBusybox(name);
    const res = await registerEncryptedV9App(env.clients[0].url, {
      name,
      instances,
      assignment,
      specOverrides,
      components: echoComponents(name, hostPort, reply),
    });
    expect(res.status, `register ${name}: ${JSON.stringify(res)}`).to.equal('success');
    await queueAppTx(res.data);
  }

  // ttl 0 is the v9 cancellation. The spec content is moot for a cancel but
  // must still validate, so the app's own shape rides along unchanged.
  async function cancelApp(name, { hostPort, reply, assignment, specOverrides, instances }) {
    const res = await updateEncryptedV9App(env.clients[0].url, {
      name,
      instances,
      assignment,
      specOverrides,
      ttl: 0,
      components: echoComponents(name, hostPort, reply),
    });
    expect(res.status, `cancel ${name}: ${JSON.stringify(res)}`).to.equal('success');
    await queueAppTx(res.data);
    await advanceBlocks(3);
  }

  const shapes = {}; // name -> the register shape, so a cancel can restate it

  async function registerShaped(name, shape) {
    shapes[name] = shape;
    await registerApp(name, shape);
  }

  // all:true throughout: "gone" has to mean removed, not merely stopped. Docker ps
  // lists running containers by default, so a stopped one reads as absent and every
  // waitGone below would pass on an app that is still sitting there.
  async function containersOn(idx, name) {
    return appContainersFor(env.clients[idx].container, name, { all: true });
  }

  async function waitGone(idx, name, label, timeout = 240000) {
    await waitFor(async () => (await containersOn(idx, name)).length === 0,
      { timeout, interval: 5000, label });
  }

  async function waitRunning(idx, name, label, timeout = 240000) {
    await waitFor(async () => {
      const status = await getAppContainerStatus(env.clients[idx].container, name);
      return status?.status?.startsWith('Up') === true;
    }, { timeout, interval: 5000, label });
  }

  before(async function () {
    this.timeout(1200000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 3,
      tickerAutostart: false,
      arcane: true,
      configOverrides: {
        fluxapps: { manageCollectorLifecycle: true, minOutgoing: 1, minIncoming: 1 },
      },
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1, pricing: true });
    hostAuth = (await authenticate(env.clients[HOST_IDX].url, appOwnerKey())).zelidauth;
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('a pinned workload pulls its follower in, gated root-first, reachable over the shared network', async function () {
    this.timeout(900000);
    // The follower and its requirer are both pinned to node 1 (the enterprise
    // tier-1 shape). Registration order is consumer-friendly on purpose: the
    // requirer's install gate defers it until the follower is up, so the pair
    // converging at all IS the root-first ordering.
    await registerShaped(apps.collector, {
      hostPort: 31284,
      reply: 'DEP-OK',
      instances: 1,
      assignment: { targetIps: { [nodeIp(HOST_IDX + 1)]: ['s1'] } },
      specOverrides: followerOverrides,
    });
    await registerShaped(apps.game, {
      hostPort: 31285,
      reply: 'GAME-OK',
      instances: 1,
      assignment: { targetIps: { [nodeIp(HOST_IDX + 1)]: ['s1'] } },
      specOverrides: {
        dependencies: {
          [apps.collector]: {
            after: true, network: true, onRemove: 'detach',
          },
        },
      },
    });
    await advanceBlocks(3);

    await waitForAppInstalled(env.clients[HOST_IDX], apps.game, 480000);
    await waitRunning(HOST_IDX, apps.collector, 'collector running on the host node');
    await waitRunning(HOST_IDX, apps.game, 'game running on the host node');

    // The network dial: the game container sits on the collector's private
    // docker network and reaches it by docker DNS — what shareWith folded into.
    const [gameContainer] = await containersOn(HOST_IDX, apps.game);
    // Resolved, not spelled: the network is named from the collector's identity, which
    // this suite has no way to derive.
    const collectorNetwork = await fluxAppNetworkName(env.clients[HOST_IDX].container, apps.collector);
    expect(collectorNetwork, 'the collector has a docker network on the host node').to.be.a('string');
    // The address an author can actually write: a container's docker name carries the
    // app's minted identity, which does not exist when the spec does. APP_NETWORK_NAMING.md
    const collectorDnsName = `web.${apps.collector}`;
    const { stdout: networks } = await execInContainer(
      env.clients[HOST_IDX].container,
      `docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' ${gameContainer.name}`,
    );
    expect(networks, 'game attached to the collector network').to.include(collectorNetwork);
    await waitFor(async () => {
      const out = await execInContainer(
        env.clients[HOST_IDX].container,
        `docker exec ${gameContainer.name} /bin/busybox nc -w 5 ${collectorDnsName} 8080`,
      );
      return out.stdout.includes('DEP-OK');
    }, { timeout: 120000, interval: 5000, label: `game reaches the collector at ${collectorDnsName}` });

    // Suppression: the follower exists exactly where its requirer is, nowhere else.
    for (const idx of [1, 2]) {
      // eslint-disable-next-line no-await-in-loop
      const strays = await containersOn(idx, apps.collector);
      expect(strays, `no collector containers on node ${idx + 1}`).to.have.length(0);
    }
  });

  it('boundTo rides its target down and back; a requires sibling runs straight through', async function () {
    this.timeout(900000);
    await registerShaped(apps.bound, {
      hostPort: 31286,
      reply: 'BND-OK',
      instances: 1,
      assignment: { targetIps: { [nodeIp(HOST_IDX + 1)]: ['s1'] } },
      specOverrides: {
        dependencies: {
          // after is forced true and onRemove cascade — stated here anyway so
          // the fixture reads as the only legal boundTo shape.
          [apps.collector]: { strength: 'boundTo', after: true, onRemove: 'cascade' },
        },
      },
    });
    await advanceBlocks(3);
    await waitForAppInstalled(env.clients[HOST_IDX], apps.bound, 480000);
    await waitRunning(HOST_IDX, apps.bound, 'bound workload running');

    // A durable operator stop takes the collector down but leaves it INSTALLED —
    // the running axis, not the presence axis. The boundTo requirer must be
    // stopped by the reconciler; the requires-strength game keeps running (a
    // startup gate never kills a runner — §5's deliberate split).
    const stopRes = await env.clients[HOST_IDX].getAuthed(`/apps/appstop/${apps.collector}`, hostAuth);
    expect(stopRes.status, `appstop ${apps.collector}`).to.equal('success');

    await waitFor(async () => {
      // all:true — a STOPPED container is what this asserts, and docker ps lists only
      // running ones by default, so the stop it is waiting for would read as absent.
      const status = await getAppContainerStatus(
        env.clients[HOST_IDX].container, apps.bound, { all: true },
      );
      return status !== null && status.status?.startsWith('Up') !== true;
    }, { timeout: 240000, interval: 5000, label: 'boundTo workload stopped while its target is down' });
    const gameStatus = await getAppContainerStatus(env.clients[HOST_IDX].container, apps.game);
    expect(gameStatus?.status?.startsWith('Up'), 'requires-strength game still running').to.equal(true);

    // apprestart clears the durable operator lock; the collector returns, the
    // boundTo hold lifts, and the requirer restarts through its own policy.
    const startRes = await env.clients[HOST_IDX].getAuthed(`/apps/appstart/${apps.collector}`, hostAuth);
    expect(startRes.status, `appstart ${apps.collector}`).to.equal('success');
    await waitRunning(HOST_IDX, apps.collector, 'collector back up after appstart');
    await waitRunning(HOST_IDX, apps.bound, 'boundTo workload restarted once its target returned');
  });

  it('a consumer with an unregistered dependency defers without error-caching, then installs root-first', async function () {
    this.timeout(900000);
    await registerShaped(apps.late, {
      hostPort: 31287,
      reply: 'LATE-OK',
      instances: 1,
      assignment: { targetIps: { [nodeIp(LATE_IDX + 1)]: ['s1'] } },
      specOverrides: {
        dependencies: {
          [apps.latedep]: { network: true, onRemove: 'cascade' },
        },
      },
    });
    await advanceBlocks(3);

    // The spec is on the node; the app must not be. A bounded settle window
    // (spec visible + more blocks + a beat) keeps the negative honest without
    // an unbounded sleep.
    await waitFor(async () => {
      const specs = await env.clients[LATE_IDX].getAppSpecs(apps.late).catch(() => null);
      return specs?.status === 'success' && specs.data;
    }, { timeout: 180000, interval: 3000, label: 'late spec gossiped to its target node' });
    await advanceBlocks(5);
    expect(await containersOn(LATE_IDX, apps.late), 'late consumer stays uninstalled while its dependency does not exist')
      .to.have.length(0);

    // The dependency arrives — a deferred (never error-cached) consumer installs
    // the moment its gate opens, dependency first.
    await registerShaped(apps.latedep, {
      hostPort: 31288,
      reply: 'LDEP-OK',
      instances: 1,
      assignment: { targetIps: { [nodeIp(LATE_IDX + 1)]: ['s1'] } },
      specOverrides: followerOverrides,
    });
    await advanceBlocks(3);
    await waitForAppInstalled(env.clients[LATE_IDX], apps.late, 480000);
    await waitRunning(LATE_IDX, apps.latedep, 'late dependency running');
    await waitRunning(LATE_IDX, apps.late, 'late consumer running once its dependency arrived');
  });

  it('cancelling the dependency cascades its consumer first and leaves nothing behind', async function () {
    this.timeout(900000);
    // late's edge is onRemove: cascade — cancelling latedep on-chain must
    // remove late from the node ahead of it (a consumer never outlives its
    // dependency), and afterwards late must not reinstall: its gate defers on
    // the now-gone target.
    await cancelApp(apps.latedep, shapes[apps.latedep]);
    await waitGone(LATE_IDX, apps.late, 'cascade removed the consumer');
    await waitGone(LATE_IDX, apps.latedep, 'the cancelled dependency is gone');
    await advanceBlocks(3);
    expect(await containersOn(LATE_IDX, apps.late), 'the consumer stays deferred, not reinstalled')
      .to.have.length(0);
  });

  it('cancelling the last requirer reaps the follower locally; its registration lives on', async function () {
    this.timeout(900000);
    await cancelApp(apps.game, shapes[apps.game]);
    await waitGone(HOST_IDX, apps.game, 'game removed after its cancellation');
    // bound still requires the collector — the ref-count must keep it.
    const held = await getAppContainerStatus(env.clients[HOST_IDX].container, apps.collector);
    expect(held?.status?.startsWith('Up'), 'collector held while a requirer remains').to.equal(true);

    await cancelApp(apps.bound, shapes[apps.bound]);
    await waitGone(HOST_IDX, apps.bound, 'bound removed after its cancellation');
    await waitGone(HOST_IDX, apps.collector, 'orphaned follower reaped once nothing requires it');

    // The reap is node-local lifecycle, not a cancellation: the follower's
    // global registration must still be current.
    const specs = await env.clients[HOST_IDX].getAppSpecs(apps.collector);
    expect(specs?.status, 'collector registration outlives its local reap').to.equal('success');
  });
});
