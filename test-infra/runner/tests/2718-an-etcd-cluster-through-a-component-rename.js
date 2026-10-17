// fleet: 3
/*
 * An etcd cluster through a component rename.
 *
 * A v9 mesh app runs etcd as `db`, one member on each of three nodes, each
 * member named by its mesh identity (db-0, db-1, db-2), and a `client` beside
 * each member writing to the cluster once a second by the members' names as
 * the cluster formed under them. etcd keeps each member's peer URLs in its own
 * membership list and ignores its startup flags once it has data, so a rename
 * is invisible to it only if every name it stored keeps reaching the same
 * member. Then `db` is renamed `database`:
 *   - the nodes recreate their member one at a time (named replicas roll by the
 *     adoption step), and every write the clients make meanwhile succeeds;
 *   - the cluster keeps the peers it stored, by the names it stored them, and
 *     the data it held;
 *   - a client connecting by the old names reaches every member;
 *   - a member restarted after the rename rejoins.
 */
import {
  describe, it, before, after, afterEach,
} from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { confirmOnChain } from '../framework/app-helper.js';
import { registerEncryptedV9App, updateEncryptedV9App } from '../framework/content-helper.js';
import { pushEtcdImage } from '../framework/registry-helper.js';
import { getSubnetConfig } from '../framework/subnet-config.js';
import { execInContainer, requireAppContainerName } from '../framework/container.js';
import { appView } from '../framework/app-view.js';
import { NotPresentError } from '../framework/errors.js';
import { waitFor } from '../framework/wait.js';
import { appIdentityFromUuid, appUuid } from '@runonflux/flux-spec';

const { gateway: GATEWAY } = getSubnetConfig();
const NODES = 3;
const CONVERGE_MS = 420000;
// Named replicas roll one adoption step apart. A member's recreate (stop,
// create, rejoin) is seconds; a minute apart, no two members are down at once.
const STEP_MS = 60000;

describe('an etcd cluster through a component rename', function () {
  let env;
  let view;
  let image;
  let app; // identity and the keys of the version last applied
  const name = `etcdrename${Date.now()}`;
  const ip = (i) => getSubnetConfig().nodeIp(i + 1);
  const url = (i) => env.clients[i].url;
  const fqdn = (member) => `${member}.${name}.mesh.flux`;
  const formed = ['db-0', 'db-1', 'db-2'];
  const assignment = () => ({ targetIps: Object.fromEntries([0, 1, 2].map((i) => [ip(i), [`s${i + 1}`]])) });

  const member = (componentName, extra = {}) => ({
    name: componentName,
    description: 'an etcd member, named by its mesh identity',
    image,
    cpu: 0.5,
    memory: 400,
    rootFsGb: 2,
    persistentStorage: { sizeGb: 1, mounts: { '/data': { source: 'data', destination: '/data' } } },
    meshPorts: { peer: { containerPort: 2380 }, client: { containerPort: 2379 } },
    env: {
      ETCD_INITIAL_CLUSTER: formed.map((m) => `${m}=http://${fqdn(m)}:2380`).join(','),
      ETCD_INITIAL_CLUSTER_STATE: 'new',
    },
    ...extra,
  });
  const client = () => ({
    name: 'client',
    description: 'writes to the cluster once a second by the names it formed under',
    image,
    cpu: 0.2,
    memory: 200,
    rootFsGb: 2,
    persistentStorage: { sizeGb: 1, mounts: { '/data': { source: 'data', destination: '/data' } } },
    entrypoint: ['/bin/sh', '/usr/local/bin/etcd-client'],
    env: { ENDPOINTS: formed.map((m) => `http://${fqdn(m)}:2379`).join(',') },
  });

  async function inComponent(index, component, command) {
    const container = await requireAppContainerName(env.clients[index].container, name, component);
    const r = await execInContainer(env.clients[index].container, `docker exec ${container} ${command}`);
    return { ok: r.exitCode === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
  }

  const etcdctl = (index, component, args) => inComponent(
    index, component, `/usr/local/bin/etcdctl --dial-timeout=2s --command-timeout=5s ${args}`,
  );

  async function members(index, component) {
    const r = await etcdctl(index, component, '--endpoints=http://127.0.0.1:2379 member list -w json');
    if (!r.ok) return null;
    return JSON.parse(r.out).members.map((m) => ({ name: m.name, peerURLs: m.peerURLs, started: Boolean(m.name) }));
  }

  // Every member answers, through the endpoints given.
  async function healthy(index, component, endpoints) {
    const r = await etcdctl(index, component, `--endpoints=${endpoints.join(',')} endpoint health -w json`);
    if (!r.ok) return false;
    const answers = JSON.parse(r.out);
    return answers.length === endpoints.length && answers.every((a) => a.health === true);
  }
  const byFormedNames = formed.map((m) => `http://${fqdn(m)}:2379`);

  async function containerOf(index, component) {
    const container = await requireAppContainerName(env.clients[index].container, name, component);
    const r = await execInContainer(env.clients[index].container, `docker inspect --format "{{json .}}" ${container}`);
    const inspected = JSON.parse(r.stdout);
    const envOf = (key) => inspected.Config.Env.find((e) => e.startsWith(`${key}=`))?.slice(key.length + 1) ?? null;
    return { startedAt: Date.parse(inspected.State.StartedAt), self: envOf('FLUX_MESH_SELF') };
  }

  // An update writes a node's hosted instance before it recreates the renamed
  // member, so the member is read once it runs again, started after its old one.
  async function recreatedOn(index, component, after) {
    let found = null;
    await waitFor(async () => {
      found = await containerOf(index, component).catch((error) => {
        if (error instanceof NotPresentError) return null;
        throw error;
      });
      return found !== null && found.startedAt > after;
    }, { timeout: CONVERGE_MS, interval: 2000, label: `node ${index} runs its ${component} member again` });
    return found;
  }

  // The client's record on a node: [{at: epoch seconds, ok: boolean, n}].
  async function probeLog(index) {
    const r = await inComponent(index, 'client', '/bin/busybox cat /data/probe.log');
    return r.out.split('\n').filter(Boolean).map((line) => {
      const [at, outcome, n] = line.split(' ');
      return { at: Number(at), ok: outcome === 'ok', n: Number(n) };
    });
  }

  before(async function () {
    this.timeout(1500000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      tickerAutostart: false,
      systemdMode: true,
      shutdownd: 'none',
      dnsd: 'real',
      arcane: true,
      // Founding photos pin committees at spec anchor heights, which needs the
      // anchored membership history the ZMQ delta machinery keeps.
      zmqTopics: ALL_ZMQ_TOPICS,
      configOverrides: {
        fluxapps: {
          meshReconcileIntervalMs: 15000,
          minOutgoing: 1,
          minIncoming: 1,
          quorumGrantMaxTtlMs: 30000,
          quorumGrantDrainMs: 20000,
          quorumGrantLockDelayMs: 10000,
          quorumGrantRenewIntervalMs: 5000,
          quorumGrantAskTimeoutMs: 3000,
          adoptionStaggerStepMs: STEP_MS,
          adoptionStaggerWindowMs: STEP_MS,
        },
      },
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1, pricing: true });
    // The mesh reconciler scopes its firewall to the default-route interface,
    // which a real node has and the harness network does not.
    await Promise.all(env.clients.map((c) => execInContainer(c.container, `ip route replace default via ${GATEWAY} dev eth0`)));
    view = appView(env, name, { component: 'db', timeout: CONVERGE_MS });

    image = await pushEtcdImage(name);
    const reg = await registerEncryptedV9App(url(0), {
      name,
      assignment: assignment(),
      specOverrides: { network: { mesh: true } },
      components: { db: member('db'), client: client() },
    });
    expect(reg.status, `the registration is accepted: ${JSON.stringify(reg).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(reg.data, env.clients);
    app = { identity: appIdentityFromUuid(appUuid(name, reg.data)), componentKeys: reg.componentKeys };
    await view.installedEverywhere(reg.data, [0, 1, 2], 'every node installs the app');
  });

  // A failed test keeps what only the nodes hold: each node's resolver feed and
  // the logs of the app's containers, etcd's own account among them.
  afterEach(async function () {
    if (this.currentTest.state !== 'failed' || !env) return;
    this.timeout(120000);
    // eslint-disable-next-line no-restricted-syntax
    for (const index of [0, 1, 2]) {
      const { container } = env.clients[index];
      // eslint-disable-next-line no-await-in-loop
      const feed = await execInContainer(container, 'cat /var/lib/flux-mesh/resolver/membership.json').catch(() => null);
      console.log(`--- node ${index} membership.json ---\n${feed?.stdout ?? '(none)'}`);
      // eslint-disable-next-line no-restricted-syntax
      for (const component of ['db', 'database', 'client']) {
        // eslint-disable-next-line no-await-in-loop
        const app = await requireAppContainerName(container, name, component).catch(() => null);
        if (!app) continue; // eslint-disable-line no-continue
        // eslint-disable-next-line no-await-in-loop
        const logs = await execInContainer(container, `docker logs --tail 150 ${app} 2>&1`).catch(() => null);
        console.log(`--- node ${index} ${component} (${app}) ---\n${logs?.stdout ?? '(none)'}`);
      }
    }
  });

  after(async function () {
    this.timeout(120000);
    await env?.teardown();
  });

  it('forms a three-member cluster by the members\' mesh names', async function () {
    this.timeout(CONVERGE_MS);
    await waitFor(() => healthy(0, 'db', byFormedNames), {
      timeout: CONVERGE_MS, interval: 5000, label: 'every member answers by its mesh name',
    });
    const list = await members(0, 'db');
    expect(list.map((m) => m.name).sort()).to.deep.equal(formed);
    expect(list.map((m) => m.peerURLs).flat().sort()).to.deep.equal(formed.map((m) => `http://${fqdn(m)}:2380`));
    expect((await etcdctl(0, 'db', '--endpoints=http://127.0.0.1:2379 put held before-the-rename')).ok).to.equal(true);
    // The clients write from the moment the cluster forms.
    await waitFor(async () => (await Promise.all([0, 1, 2].map(probeLog))).every((log) => log.some((e) => e.ok)), {
      timeout: 120000, interval: 5000, label: 'every client has written',
    });
  });

  it('renames db to database one node at a time, and every write meanwhile succeeds', async function () {
    this.timeout(CONVERGE_MS * 2);
    const was = await Promise.all([0, 1, 2].map((i) => containerOf(i, 'db')));
    const from = Math.floor(Date.now() / 1000);

    const res = await updateEncryptedV9App(url(0), {
      name,
      assignment: assignment(),
      specOverrides: { network: { mesh: true } },
      components: { database: member('database', { renamedFrom: 'db' }), client: client() },
      previousKeys: app.componentKeys,
      identity: app.identity,
    });
    expect(res.status, `the rename is accepted: ${JSON.stringify(res).slice(0, 300)}`).to.equal('success');
    expect(res.componentKeys.get('database'), 'database keeps db\'s key').to.equal(app.componentKeys.get('db'));
    await confirmOnChain(res.data, env.clients);
    await view.installedEverywhere(res.data, [0, 1, 2], 'every node applies the rename');
    app = { ...app, componentKeys: res.componentKeys };

    const now = await Promise.all([0, 1, 2].map((i) => recreatedOn(i, 'database', was[i].startedAt)));
    now.forEach((c, i) => {
      expect(c.self, `node ${i}: the member carries its new mesh name`).to.match(/^database-[0-2]$/);
    });
    const starts = now.map((c) => c.startedAt).sort((a, b) => a - b);
    expect(starts[1] - starts[0], 'the members are recreated a step apart').to.be.at.least(STEP_MS / 2);
    expect(starts[2] - starts[1], 'the members are recreated a step apart').to.be.at.least(STEP_MS / 2);

    await waitFor(() => healthy(0, 'database', byFormedNames), {
      timeout: CONVERGE_MS, interval: 5000, label: 'every member answers by the name it formed under',
    });
    // The window closes after the last member has rejoined and the clients have
    // written through it.
    await new Promise((resolve) => { setTimeout(resolve, 20000); });
    const to = Math.floor(Date.now() / 1000);

    // eslint-disable-next-line no-restricted-syntax
    for (const index of [0, 1, 2]) {
      // eslint-disable-next-line no-await-in-loop
      const during = (await probeLog(index)).filter((e) => e.at >= from && e.at <= to);
      // One write a second, each taking at most its 5 s timeout: a window of
      // (to - from) seconds holds at least (to - from) / 6 of them.
      expect(during.length, `node ${index}: the client wrote throughout`).to.be.at.least(Math.floor((to - from) / 6));
      expect(during.filter((e) => !e.ok).map((e) => e.at), `node ${index}: no write failed`).to.deep.equal([]);
    }
  });

  it('keeps the peers it stored, by the names it stored them, and the data it held', async function () {
    this.timeout(120000);
    const list = await members(0, 'database');
    expect(list.map((m) => m.peerURLs).flat().sort(), 'the peer URLs it formed with')
      .to.deep.equal(formed.map((m) => `http://${fqdn(m)}:2380`));
    expect(list.every((m) => m.started), 'every member started').to.equal(true);
    const held = await etcdctl(0, 'database', '--endpoints=http://127.0.0.1:2379 get held --print-value-only');
    expect(held.out).to.equal('before-the-rename');
  });

  it('answers a client connecting by the old names', async function () {
    this.timeout(120000);
    expect(await healthy(1, 'client', byFormedNames), 'every member, by the name it formed under').to.equal(true);
    const read = await etcdctl(1, 'client', `--endpoints=${byFormedNames.join(',')} get held --print-value-only`);
    expect(read.out).to.equal('before-the-rename');
  });

  it('rejoins a member restarted after the rename', async function () {
    this.timeout(CONVERGE_MS);
    const container = await requireAppContainerName(env.clients[1].container, name, 'database');
    const restarted = await execInContainer(env.clients[1].container, `docker restart ${container}`);
    expect(restarted.exitCode, 'the member restarts').to.equal(0);
    await waitFor(() => healthy(0, 'database', byFormedNames), {
      timeout: CONVERGE_MS, interval: 5000, label: 'the restarted member answers again',
    });
    const self = (await containerOf(1, 'database')).self;
    const write = await etcdctl(1, 'database', '--endpoints=http://127.0.0.1:2379 put after-restart rejoined');
    expect(write.ok, `${self} takes a write after its restart: ${write.err}`).to.equal(true);
    const read = await etcdctl(0, 'database', '--endpoints=http://127.0.0.1:2379 get after-restart --print-value-only');
    expect(read.out, 'and the cluster holds it').to.equal('rejoined');
  });
});
