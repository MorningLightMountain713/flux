import { readFileSync } from 'node:fs';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { registerEncryptedV9App, updateEncryptedV9App } from '../framework/content-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { queueAppTx, advanceBlock, advanceBlocks } from '../framework/daemon-control.js';
import { waitFor } from '../framework/wait.js';
import {
  getAppContainerStatus, isAppContainerRunning, execInContainer, appContainersFor,
} from '../framework/container.js';
import { dbClient, closeDb } from '../framework/db-client.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';

// Named-replica placement (v9) end to end: the sealed assignment map
// (identity -> [replicaNames]) alongside the cleartext placement identity set,
// instances derivation, per-replica hostPort overrides, the FLUX_* platform env
// (injected + ${FLUX_PORT_x} templated), declarative install/removal (a named
// replica installs on exactly its node; a de-named replica is removed from
// exactly its node), candidate->pinned mode switches, co-location of several
// replicas on one node, and the API-level validation rejects.
// Assertions ride the SSE event bus + per-node DB rows + docker inspect — never
// log scraping.
//
// nodes:5 with fluxapps.minOutgoing lowered to 2 (a 5-node full mesh only reaches
// ~2 outbound/node); arcane:true so nodes accept encrypted v9 apps and run the
// benchmark crypto. The ticker stays off: update convergence is driven by the
// reconcile sweep, which fires on block-height modulus (4-9 blocks x the post-PON
// speed multiplier), so the update tests advance blocks in explicit rounds.
//
// Port ranges are 35xxx per app (suite 53's apps sit on the default 31000).

const subnet = getSubnetConfig();
const nodeIp = (num) => subnet.nodeIp(num);

// The committed identity fixture the daemon-stub serves: the runner remaps only
// the IP per run, so node N's collateral outpoint is fixture[N-1].txhash:0 and
// targetOutpoints keys are writable up front.
const deterministicList = JSON.parse(
  readFileSync(new URL('../../fixtures/deterministic-list.json', import.meta.url), 'utf-8'),
);
const nodeOutpoint = (num) => `${deterministicList[num - 1].txhash}:0`;

// StartedAt of the app's (single) container, '' when absent. Whether this value
// moves across an update is the untouched-vs-recreated distinction.
async function containerStartedAt(client, appName) {
  const cont = await getAppContainerStatus(client.container, appName);
  if (!cont) return '';
  const { stdout } = await execInContainer(
    client.container,
    `docker inspect --format '{{.State.StartedAt}}' ${cont.name}`,
  );
  return stdout.trim();
}

// The container's env as a map (docker's last-duplicate-wins applied), null when
// the container is absent. The app image is a bare pause binary, so env is read
// from the container config, not an exec.
async function containerEnv(client, appName) {
  const cont = await getAppContainerStatus(client.container, appName);
  if (!cont) return null;
  const { stdout } = await execInContainer(
    client.container,
    `docker inspect --format '{{json .Config.Env}}' ${cont.name}`,
  );
  const entries = JSON.parse(stdout.trim());
  const env = {};
  for (const entry of entries) {
    const eq = entry.indexOf('=');
    env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

// Host ports the container actually binds (docker inspect HostConfig.PortBindings).
async function boundHostPorts(client, appName) {
  const cont = await getAppContainerStatus(client.container, appName);
  if (!cont) return [];
  const { stdout } = await execInContainer(
    client.container,
    `docker inspect --format '{{json .HostConfig.PortBindings}}' ${cont.name}`,
  );
  const bindings = JSON.parse(stdout.trim()) || {};
  return Object.values(bindings).flat().map((b) => Number(b.HostPort));
}

describe('replica placement (v9): assignment + placement, overrides, platform env, declarative convergence', function () {
  let env;

  const base = `repl${Date.now()}`;
  const nameSingle = `${base}a`; // named single replica + platform env/templating
  const nameOverride = `${base}b`; // two named replicas, per-replica hostPort override
  const nameCandidate = `${base}c`; // candidate identity set, later mode-switched
  const nameColoc = `${base}d`; // spec-valid co-location -> Phase-1 fail-loud
  const nameOutpoint = `${base}e`; // outpoint-keyed named replica

  // One component per app; each app gets its own 35xxx port slice.
  function webComponents(appName, { hostPort, env: userEnv = {}, replicaOverrides } = {}) {
    return {
      web: {
        name: 'web',
        description: 'replica placement component',
        image: `${REGISTRY_REPO_HOST}/${appName}:v1`,
        cpu: 0.5,
        memory: 300,
        rootFsGb: 2,
        persistentStorage: { sizeGb: 10, mounts: { '/data': { source: 'data', destination: '/data' } } },
        ports: { game: { containerPort: 8080, hostPort } },
        env: userEnv,
        ...(replicaOverrides ? { replicaOverrides } : {}),
      },
    };
  }

  async function registerApp(name, {
    placement, assignment, instances, components,
  }) {
    const res = await registerEncryptedV9App(env.clients[0].url, {
      name, placement, assignment, instances, components,
    });
    expect(res.status, `register ${name}`).to.equal('success');
    return res.data; // appHash
  }

  async function updateApp(name, {
    placement, assignment, instances, components,
  }) {
    const res = await updateEncryptedV9App(env.clients[0].url, {
      name, placement, assignment, instances, components,
    });
    expect(res.status, `update ${name}`).to.equal('success');
    await queueAppTx(res.data);
    await advanceBlocks(3);
    return res.data; // update message hash
  }

  // Update convergence runs at every block processed AT THE TIP — a block
  // processed during catch-up carries 2+ confirmations and skips the
  // convergence pass. So each round advances ONE block and waits for every
  // node to process THAT height. Anchoring on the height matters: a wait
  // satisfied by "any new block event" resolves on the PREVIOUS height's
  // event whenever the explorer runs a block behind, locking alternate
  // heights into catch-up. Waiting for the advanced height drains any lag
  // each round, so every height lands at tip and convergence (plus any
  // staggered adoption delay) is bounded within the round budget.
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

  // Node indices (into env.clients) whose docker runs the app's container.
  async function runningIndexes(appName) {
    const states = await Promise.all(env.clients.map((c) => isAppContainerRunning(c.container, appName)));
    return states.flatMap((running, i) => (running ? [i] : []));
  }

  // Indices of clients whose event buffer ever saw app:installed for the app.
  function installedEventIndexes(appName) {
    return env.clients.flatMap((c, i) => (
      c.getEventBuffer().some((e) => e.event === 'app:installed' && e.data.name === appName) ? [i] : []));
  }

  before(async function () {
    this.timeout(600000);
    env = await createTestEnv({
      hookCtx: this, nodes: 5, tickerAutostart: false, arcane: true,
      configOverrides: {
        fluxapps: {
          minOutgoing: 2,
          // A node a targeted app does NOT match defers that app for ~30-57min
          // before rescanning. The scale-up/mode-switch tests re-target exactly
          // such nodes mid-run, so the deferral must be short for the newly
          // named node to pick its replica up within the test window.
          // (NODE_CONFIG deep-merges, so the sibling spawnDeferrals keys keep
          // their defaults.)
          spawnDeferrals: { targetedNodesMs: { encrypted: 30000, standard: 30000 } },
          // Adoption staggering (rolling updates) is production pacing; shrink
          // it so a candidate instance's bounded-window adoption lands inside the
          // test windows.
          adoptionStaggerStepMs: 15000,
          adoptionStaggerWindowMs: 15000,
        },
      },
    });
    await bootAndPeer(env, { minOutbound: 2, minInbound: 2, pricing: true });

    await pushImage(nameSingle, 'v1');
    await pushImage(nameOverride, 'v1');
    await pushImage(nameCandidate, 'v1');
    await pushImage(nameColoc, 'v1');
    await pushImage(nameOutpoint, 'v1');

    // instances and the cleartext placement are omitted on every pinned app:
    // both are derived from the assignment.
    const singleHash = await registerApp(nameSingle, {
      assignment: { targetIps: { [nodeIp(2)]: ['s1'] } },
      components: webComponents(nameSingle, {
        hostPort: 35010,
        env: { ADVERTISE: '${FLUX_PORT_game}', RAW_HOME: '${HOME}' },
      }),
    });
    const overrideHash = await registerApp(nameOverride, {
      assignment: { targetIps: { [nodeIp(3)]: ['r1'], [nodeIp(4)]: ['r2'] } },
      components: webComponents(nameOverride, {
        hostPort: 35020,
        env: { ADVERTISE: '${FLUX_PORT_game}' },
        replicaOverrides: { r2: { ports: { game: { hostPort: 35021 } } } },
      }),
    });
    const candidateHash = await registerApp(nameCandidate, {
      placement: { targetIps: [nodeIp(1), nodeIp(2), nodeIp(5)] },
      instances: 2,
      components: webComponents(nameCandidate, { hostPort: 35030 }),
    });
    // Three replicas on ONE node with distinct effective ports: legal precisely
    // because the per-node effective hostPorts stay pairwise distinct.
    const colocHash = await registerApp(nameColoc, {
      assignment: { targetIps: { [nodeIp(5)]: ['d1', 'd2', 'd3'] } },
      components: webComponents(nameColoc, {
        hostPort: 35040,
        replicaOverrides: {
          d2: { ports: { game: { hostPort: 35041 } } },
          d3: { ports: { game: { hostPort: 35042 } } },
        },
      }),
    });
    const outpointHash = await registerApp(nameOutpoint, {
      assignment: { targetOutpoints: { [nodeOutpoint(4)]: ['o1'] } },
      components: webComponents(nameOutpoint, { hostPort: 35050 }),
    });

    await queueAppTx(singleHash);
    await queueAppTx(overrideHash);
    await queueAppTx(candidateHash);
    await queueAppTx(colocHash);
    await queueAppTx(outpointHash);
    await advanceBlocks(3);
  });

  after(async function () {
    this.timeout(30000);
    await closeDb();
    await env?.teardown();
  });

  it('installs a named replica on exactly the targeted node — no other node ever installs it', async function () {
    this.timeout(300000);
    await env.clients[1].waitForEvent('app:installed', (d) => d.name === nameSingle, 240000);
    await waitFor(
      async () => (await runningIndexes(nameSingle)).join(',') === '1',
      { timeout: 60000, interval: 3000, label: `${nameSingle} running on node 2 only` },
    );
    expect(installedEventIndexes(nameSingle), 'named placement is declarative: only the targeted node installs').to.deep.equal([1]);
  });

  it('injects the platform env and resolves ${FLUX_PORT_x} templating; non-FLUX ${...} passes through verbatim', async function () {
    this.timeout(60000);
    const envMap = await containerEnv(env.clients[1], nameSingle);
    expect(envMap, 'container present').to.not.equal(null);
    expect(envMap.FLUX_APP_NAME).to.equal(nameSingle);
    expect(envMap.FLUX_REPLICA).to.equal('s1');
    expect(envMap.FLUX_NODE_HOST_IP).to.equal(nodeIp(2));
    expect(envMap.FLUX_PORT_game).to.equal('35010');
    // The user's env value referenced ${FLUX_PORT_game}: substituted at create.
    expect(envMap.ADVERTISE).to.equal('35010');
    // ${HOME} is not our namespace: delivered untouched.
    expect(envMap.RAW_HOME).to.equal('${HOME}');
  });

  it('applies per-replica hostPort overrides: each node binds its effective port', async function () {
    this.timeout(300000);
    await env.clients[2].waitForEvent('app:installed', (d) => d.name === nameOverride, 240000);
    await env.clients[3].waitForEvent('app:installed', (d) => d.name === nameOverride, 240000);

    await waitFor(
      async () => (await runningIndexes(nameOverride)).join(',') === '2,3',
      { timeout: 60000, interval: 3000, label: `${nameOverride} running on nodes 3+4` },
    );

    const r1Env = await containerEnv(env.clients[2], nameOverride);
    expect(r1Env.FLUX_REPLICA).to.equal('r1');
    expect(r1Env.FLUX_PORT_game).to.equal('35020');
    expect(r1Env.ADVERTISE).to.equal('35020');
    expect(await boundHostPorts(env.clients[2], nameOverride)).to.deep.equal([35020]);

    const r2Env = await containerEnv(env.clients[3], nameOverride);
    expect(r2Env.FLUX_REPLICA).to.equal('r2');
    expect(r2Env.FLUX_PORT_game).to.equal('35021');
    expect(r2Env.ADVERTISE).to.equal('35021');
    expect(await boundHostPorts(env.clients[3], nameOverride)).to.deep.equal([35021]);
  });

  it('resolves an outpoint-keyed named replica onto the collateral node', async function () {
    this.timeout(300000);
    await env.clients[3].waitForEvent('app:installed', (d) => d.name === nameOutpoint, 240000);
    await waitFor(
      async () => (await runningIndexes(nameOutpoint)).join(',') === '3',
      { timeout: 60000, interval: 3000, label: `${nameOutpoint} running on node 4 only` },
    );
    const envMap = await containerEnv(env.clients[3], nameOutpoint);
    expect(envMap.FLUX_REPLICA).to.equal('o1');
    expect(installedEventIndexes(nameOutpoint)).to.deep.equal([3]);
  });

  it('keeps candidate semantics through the identity set: instances of the candidates run, unnamed', async function () {
    this.timeout(300000);
    // Candidates are nodes 1,2,5 (indexes 0,1,4) with instances:2 — any 2 of the
    // 3 converge; the non-candidates must never install.
    let stable = 0;
    let last = '';
    await waitFor(
      async () => {
        const running = await runningIndexes(nameCandidate);
        const key = running.join(',');
        const ok = running.length === 2 && running.every((i) => [0, 1, 4].includes(i));
        stable = ok && key === last ? stable + 1 : 0;
        last = key;
        return stable >= 2;
      },
      { timeout: 240000, interval: 3000, label: `${nameCandidate} converged to 2 candidate instances` },
    );
    const running = await runningIndexes(nameCandidate);
    for (const i of running) {
      // eslint-disable-next-line no-await-in-loop
      const envMap = await containerEnv(env.clients[i], nameCandidate);
      expect(envMap, 'running container env').to.not.equal(null);
      expect(envMap.FLUX_REPLICA, 'a candidate instance has no replica identity').to.equal(undefined);
    }
    expect(installedEventIndexes(nameCandidate).every((i) => [0, 1, 4].includes(i)), 'non-candidates never install a targeted app').to.equal(true);
  });

  it('co-locates several replicas on one targeted node, and nowhere else', async function () {
    this.timeout(300000);
    // Node 5 (index 4) is targeted with three names, so it deploys three
    // identities — one container each, qualified by replica name. The depth
    // (per-identity rows, claims, plans, addressing) belongs to the co-location
    // suite; here it only has to land on the targeted node alone.
    await env.clients[4].waitForEvent('app:installed', (d) => d.name === nameColoc, 240000);
    await waitFor(
      async () => (await appContainersFor(env.clients[4].container, nameColoc)).length === 3,
      { timeout: 120000, interval: 3000, label: `${nameColoc} three co-located containers on node 5` },
    );
    const names = (await appContainersFor(env.clients[4].container, nameColoc))
      .map((c) => c.name).sort();
    expect(names).to.deep.equal([
      `fluxweb_${nameColoc}_d1`, `fluxweb_${nameColoc}_d2`, `fluxweb_${nameColoc}_d3`,
    ]);
    expect(await runningIndexes(nameColoc), 'a named set installs only on its targeted node').to.deep.equal([4]);
  });

  it('scales up by assignment edit: the new replica installs, the running replica is untouched', async function () {
    this.timeout(420000);
    const startedBefore = await containerStartedAt(env.clients[1], nameSingle);
    expect(startedBefore, `${nameSingle} running before scale-up`).to.not.equal('');

    const updateHash = await updateApp(nameSingle, {
      assignment: { targetIps: { [nodeIp(2)]: ['s1'], [nodeIp(3)]: ['s2'] } },
      components: webComponents(nameSingle, {
        hostPort: 35010,
        env: { ADVERTISE: '${FLUX_PORT_game}', RAW_HOME: '${HOME}' },
        replicaOverrides: { s2: { ports: { game: { hostPort: 35011 } } } },
      }),
    });

    // The added replica installs via the spawner on its named node.
    await env.clients[2].waitForEvent('app:installed', (d) => d.name === nameSingle, 300000);
    await waitFor(
      async () => (await runningIndexes(nameSingle)).join(',') === '1,2',
      { timeout: 60000, interval: 3000, label: `${nameSingle} running on nodes 2+3` },
    );

    const s2Env = await containerEnv(env.clients[2], nameSingle);
    expect(s2Env.FLUX_REPLICA).to.equal('s2');
    expect(s2Env.FLUX_PORT_game).to.equal('35011');
    expect(s2Env.ADVERTISE).to.equal('35011');
    expect(await boundHostPorts(env.clients[2], nameSingle)).to.deep.equal([35011]);

    // The kept replica ADOPTS the new spec (installed row rewritten to the update
    // hash) with its container untouched — its effective view did not change.
    await untilWithBlocks(
      async () => (await dbClient(env.clients[1].num).getLocalApp(nameSingle))?.hash === updateHash,
      { label: `node 2 adopted ${nameSingle} v2` },
    );
    expect(await containerStartedAt(env.clients[1], nameSingle), 'untouched replica must not restart on scale-up').to.equal(startedBefore);
    const s1Env = await containerEnv(env.clients[1], nameSingle);
    expect(s1Env.FLUX_REPLICA).to.equal('s1');
    expect(s1Env.FLUX_PORT_game).to.equal('35010');
  });

  it('scales down surgically: exactly the de-named replica is removed, the survivor is untouched', async function () {
    this.timeout(420000);
    const survivorBefore = await containerStartedAt(env.clients[2], nameOverride);
    expect(survivorBefore, `${nameOverride} r1 running before scale-down`).to.not.equal('');

    // r2 (and its override) leave the spec; r1 stays.
    const updateHash = await updateApp(nameOverride, {
      assignment: { targetIps: { [nodeIp(3)]: ['r1'] } },
      components: webComponents(nameOverride, {
        hostPort: 35020,
        env: { ADVERTISE: '${FLUX_PORT_game}' },
      }),
    });

    // The de-named node removes its instance via the reconcile sweep.
    const removedAfter = env.clients[3].getLastEventId();
    await untilWithBlocks(
      async () => env.clients[3].getEventBuffer().some(
        (e) => e.event === 'app:removed' && e.id > removedAfter && e.data.name === nameOverride,
      ),
      { label: `node 4 removed de-named replica of ${nameOverride}` },
    );
    await waitFor(
      async () => (await runningIndexes(nameOverride)).join(',') === '2',
      { timeout: 60000, interval: 3000, label: `${nameOverride} running on node 3 only` },
    );

    // The survivor adopted the new spec without a restart: dropping a SIBLING's
    // override does not change this replica's effective view.
    await untilWithBlocks(
      async () => (await dbClient(env.clients[2].num).getLocalApp(nameOverride))?.hash === updateHash,
      { label: `node 3 adopted ${nameOverride} v2` },
    );
    expect(await containerStartedAt(env.clients[2], nameOverride), 'surviving replica must not restart on scale-down').to.equal(survivorBefore);
  });

  it('mode-switches candidate -> pinned: converges to the named node, de-targeted instances removed', async function () {
    this.timeout(420000);
    await updateApp(nameCandidate, {
      assignment: { targetIps: { [nodeIp(1)]: ['m1'] } },
      components: webComponents(nameCandidate, { hostPort: 35030 }),
    });

    await untilWithBlocks(
      async () => (await runningIndexes(nameCandidate)).join(',') === '0',
      { rounds: 60, label: `${nameCandidate} converged to node 1 only` },
    );
    // The kept node's own adoption is a scheduled rolling redeploy (the
    // de-targeted removals land first, deliberately) — wait for the recreated
    // container to carry the replica identity.
    await waitFor(
      async () => (await containerEnv(env.clients[0], nameCandidate))?.FLUX_REPLICA === 'm1',
      { timeout: 120000, interval: 3000, label: `${nameCandidate} node 1 adopted the named identity` },
    );
  });

  it('mode-switches pinned -> candidate: candidate semantics return, replica identity drops', async function () {
    // Churn from the earlier phases used to strand appsinstallinglocations rows
    // until their TTL — this test's old 1200s budget existed only to outwait
    // them. Aborted attempts and election losers now broadcast cleared claims,
    // and the compressed harness TTL (installingTtlS, 60s) is honored as the
    // crash backstop, so normal convergence pace bounds the respawn.
    this.timeout(300000);
    await updateApp(nameCandidate, {
      placement: { targetIps: [nodeIp(1), nodeIp(2), nodeIp(5)] },
      instances: 2,
      components: webComponents(nameCandidate, { hostPort: 35030 }),
    });

    let stable = 0;
    let last = '';
    await untilWithBlocks(
      async () => {
        const running = await runningIndexes(nameCandidate);
        const key = running.join(',');
        const ok = running.length === 2 && running.every((i) => [0, 1, 4].includes(i));
        stable = ok && key === last ? stable + 1 : 0;
        last = key;
        return stable >= 2;
      },
      { rounds: 200, label: `${nameCandidate} back to 2 candidate instances` },
    );
    const running = await runningIndexes(nameCandidate);
    for (const i of running) {
      // eslint-disable-next-line no-await-in-loop
      const envMap = await containerEnv(env.clients[i], nameCandidate);
      expect(envMap.FLUX_REPLICA, 'candidate instances carry no replica identity').to.equal(undefined);
    }

    // Every seat reservation for the app must already be released on every
    // node — the winners' rows by their running broadcasts, aborted and losing
    // attempts' by cleared claims. The short wait absorbs gossip propagation
    // only; a row that needed the TTL to die fails this.
    await waitFor(
      async () => {
        const rows = await Promise.all(
          env.clients.map((c) => dbClient(c.num).getAppInstallingLocations(nameCandidate)),
        );
        return rows.every((r) => r.length === 0);
      },
      { timeout: 30000, interval: 2000, label: `${nameCandidate} installing claims all released` },
    );
  });

  // The reject cases pass a precomputed contentHash: canonicalizing an invalid
  // spec throws in the toolkit itself, and the surface under test is the NODE's
  // validation of the opened submission — the register API must wire the
  // flux-spec error through as a field-precise message.
  const DUMMY_HASH = 'ab'.repeat(32);

  // The cleartext identity set must equal the sealed assignment's keys: a node
  // the public list claims but the assignment never names anyone for is the
  // closest analog of the old mixed pinned/candidate map, and it is what the
  // consistency invariant exists to catch.
  it('rejects a placement identity not covered by the assignment at the API with a field-precise message', async function () {
    this.timeout(60000);
    const res = await registerEncryptedV9App(env.clients[0].url, {
      name: `${base}mismatch`,
      contentHash: DUMMY_HASH,
      assignment: { targetIps: { [nodeIp(1)]: ['x1'] } },
      placement: { mode: 'pinned', targetIps: [nodeIp(1), nodeIp(2)] },
      components: webComponents(nameSingle, { hostPort: 35060 }),
    });
    expect(res.status).to.equal('error');
    expect(res.data.message).to.include('PLACEMENT_IDENTITY_MISMATCH');
  });

  it('rejects an override naming an undeclared replica at the API', async function () {
    this.timeout(60000);
    const res = await registerEncryptedV9App(env.clients[0].url, {
      name: `${base}ghost`,
      contentHash: DUMMY_HASH,
      assignment: { targetIps: { [nodeIp(1)]: ['x1'] } },
      components: webComponents(nameSingle, {
        hostPort: 35061,
        replicaOverrides: { ghost: { ports: { game: { hostPort: 35062 } } } },
      }),
    });
    expect(res.status).to.equal('error');
    expect(res.data.message).to.include('is not a declared replica name');
  });
});
