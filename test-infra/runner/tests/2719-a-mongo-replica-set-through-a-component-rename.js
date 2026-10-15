// fleet: 3
/*
 * A Mongo replica set through a component rename.
 *
 * A v9 mesh app runs mongod as `db`, one member on each of three nodes, in a
 * replica set whose configuration names each member by its mesh name
 * (db-0.<app>.mesh.flux:27017 …), and a `client` beside each member writing to
 * the set once a second, with majority acknowledgement, by those names. A
 * replica set keeps its members' hosts in its own configuration and each member
 * finds itself among them, so a rename is invisible to it only if every name
 * it stored keeps reaching the same member. Then `db` is renamed `database`:
 *   - the nodes recreate their member one at a time; no acknowledged write is
 *     lost, and writes resume within one election when the primary's member is
 *     recreated;
 *   - the configuration keeps the hosts it named, one primary and two
 *     secondaries, all healthy;
 *   - a client connecting by the old names writes with majority acknowledgement;
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
import { mirrorImage } from '../framework/registry-helper.js';
import { getSubnetConfig } from '../framework/subnet-config.js';
import { execInContainer, requireAppContainerName } from '../framework/container.js';
import { appView } from '../framework/app-view.js';
import { waitFor } from '../framework/wait.js';
import { appIdentityFromUuid, appUuid } from '@runonflux/flux-spec';

const { gateway: GATEWAY } = getSubnetConfig();
const NODES = 3;
const CONVERGE_MS = 480000;
// Named replicas roll one adoption step apart; a minute apart, no two members
// are down at once.
const STEP_MS = 60000;
// mongo:7.0, the linux/amd64 entry and every other of its index.
const MONGO_IMAGE = 'registry-1.docker.io/library/mongo@sha256:9650758f83af117fc96699f030a44f9300bed839734e67012f56df05b2fd6290';
// The longest a client waits between acknowledged writes while the primary's
// member is recreated: the secondaries call an election after
// electionTimeoutMillis (10 s, the replica set default) without the primary's
// heartbeat, which comes every heartbeatIntervalMillis (2 s); a write attempted
// meanwhile waits serverSelectionTimeoutMS (5 s, set on the client) for a
// primary; and the client pauses 1 s between writes.
const ELECTION_GAP_S = 10 + 2 + 5 + 1;

// One write a second through URI, majority acknowledged, each outcome printed
// as "<epoch seconds> ok|fail <n>", the time the attempt began.
const PROBE_JS = [
  'const self = process.env.FLUX_MESH_SELF; let n = 0;',
  'while (true) {',
  '  n += 1; const at = Math.floor(Date.now() / 1000);',
  '  try {',
  "    db.getSiblingDB('probe').writes.insertOne({ client: self, n }, { writeConcern: { w: 'majority', wtimeout: 5000 } });",
  '    print(`${at} ok ${n}`);',
  '  } catch (e) { print(`${at} fail ${n}`); }',
  '  sleep(1000);',
  '}',
].join('\n');

describe('a Mongo replica set through a component rename', function () {
  let env;
  let view;
  let image;
  let app; // identity and the keys of the version last applied
  const name = `mongorename${Date.now()}`;
  const ip = (i) => getSubnetConfig().nodeIp(i + 1);
  const url = (i) => env.clients[i].url;
  const host = (member) => `${member}.${name}.mesh.flux:27017`;
  const formed = ['db-0', 'db-1', 'db-2'];
  const byFormedNames = `mongodb://${formed.map(host).join(',')}/?replicaSet=rs0&serverSelectionTimeoutMS=5000`;
  const assignment = () => ({ targetIps: Object.fromEntries([0, 1, 2].map((i) => [ip(i), [`s${i + 1}`]])) });

  const member = (componentName, extra = {}) => ({
    name: componentName,
    description: 'a replica set member, named by its mesh identity',
    image,
    cpu: 0.5,
    memory: 700,
    rootFsGb: 2,
    persistentStorage: { sizeGb: 2, mounts: { '/data/db': { source: 'db', destination: '/data/db' } } },
    meshPorts: { mongo: { containerPort: 27017 } },
    cmd: ['mongod', '--replSet', 'rs0', '--bind_ip_all', '--dbpath', '/data/db'],
    ...extra,
  });
  const client = () => ({
    name: 'client',
    description: 'writes to the set once a second by the names it formed under',
    image,
    cpu: 0.3,
    memory: 400,
    rootFsGb: 2,
    persistentStorage: { sizeGb: 1, mounts: { '/data/probe': { source: 'probe', destination: '/data/probe' } } },
    entrypoint: ['/bin/sh', '-c',
      'while true; do mongosh "$URI" --quiet --eval "$PROBE_JS" >> /data/probe/probe.log 2>/dev/null; sleep 2; done'],
    env: { URI: `${byFormedNames}&retryWrites=true`, PROBE_JS },
  });

  async function inComponent(index, component, command) {
    const container = await requireAppContainerName(env.clients[index].container, name, component);
    const r = await execInContainer(env.clients[index].container, ['docker', 'exec', container, ...command]);
    return { ok: r.exitCode === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
  }

  const mongosh = (index, component, js, uri = 'mongodb://127.0.0.1:27017/?directConnection=true') => inComponent(
    index, component, ['mongosh', uri, '--quiet', '--eval', js],
  );

  // The set as one member sees it: each member's host, state and health.
  async function setStatus(index, component) {
    const r = await mongosh(index, component, 'JSON.stringify(rs.status().members.map((m) => ({ host: m.name, state: m.stateStr, health: m.health })))');
    try { return r.ok ? JSON.parse(r.out) : null; } catch { return null; }
  }
  const settled = (status) => Array.isArray(status) && status.length === 3 && status.every((m) => m.health === 1)
    && status.filter((m) => m.state === 'PRIMARY').length === 1
    && status.filter((m) => m.state === 'SECONDARY').length === 2;

  async function containerOf(index, component) {
    const container = await requireAppContainerName(env.clients[index].container, name, component);
    const r = await execInContainer(env.clients[index].container, `docker inspect --format "{{json .}}" ${container}`);
    const inspected = JSON.parse(r.stdout);
    const envOf = (key) => inspected.Config.Env.find((e) => e.startsWith(`${key}=`))?.slice(key.length + 1) ?? null;
    return { startedAt: Date.parse(inspected.State.StartedAt), self: envOf('FLUX_MESH_SELF') };
  }

  // A client's record: [{at: epoch seconds, ok: boolean, n}], and its name.
  async function probeLog(index) {
    const r = await inComponent(index, 'client', ['cat', '/data/probe/probe.log']);
    return r.out.split('\n').filter((line) => /^\d+ (ok|fail) \d+$/.test(line)).map((line) => {
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

    image = await mirrorImage(MONGO_IMAGE, name);
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

  // A failed test keeps each node's resolver feed and the logs of the app's
  // containers, mongod's own account among them.
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
        const appContainer = await requireAppContainerName(container, name, component).catch(() => null);
        if (!appContainer) continue; // eslint-disable-line no-continue
        // eslint-disable-next-line no-await-in-loop
        const logs = await execInContainer(container, `docker logs --tail 150 ${appContainer} 2>&1`).catch(() => null);
        console.log(`--- node ${index} ${component} (${appContainer}) ---\n${logs?.stdout ?? '(none)'}`);
      }
    }
  });

  after(async function () {
    this.timeout(120000);
    await env?.teardown();
  });

  it('forms a replica set of three members by their mesh names', async function () {
    this.timeout(CONVERGE_MS);
    const config = JSON.stringify({ _id: 'rs0', members: formed.map((m, i) => ({ _id: i, host: host(m) })) });
    await waitFor(async () => (await mongosh(0, 'db', `JSON.stringify(rs.initiate(${config}))`)).out.includes('"ok":1'), {
      timeout: CONVERGE_MS, interval: 10000, label: 'the set is initiated with every member by its mesh name',
    });
    await waitFor(async () => settled(await setStatus(0, 'db')), {
      timeout: CONVERGE_MS, interval: 5000, label: 'one primary and two secondaries, all healthy',
    });
    const held = await mongosh(0, 'db', "db.getSiblingDB('kept').marks.insertOne({ held: 'before-the-rename' }, { writeConcern: { w: 'majority' } }).acknowledged", byFormedNames);
    expect(held.out, `a majority write by the formed names: ${held.err}`).to.equal('true');
    await waitFor(async () => (await Promise.all([0, 1, 2].map(probeLog))).every((log) => log.some((e) => e.ok)), {
      timeout: 180000, interval: 5000, label: 'every client has written',
    });
  });

  it('renames db to database one node at a time, losing no acknowledged write and resuming within one election', async function () {
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

    const now = await Promise.all([0, 1, 2].map((i) => containerOf(i, 'database')));
    now.forEach((c, i) => {
      expect(c.startedAt, `node ${i}: its member is recreated`).to.be.above(was[i].startedAt);
      expect(c.self, `node ${i}: the member carries its new mesh name`).to.match(/^database-[0-2]$/);
    });
    const starts = now.map((c) => c.startedAt).sort((a, b) => a - b);
    expect(starts[1] - starts[0], 'the members are recreated a step apart').to.be.at.least(STEP_MS / 2);
    expect(starts[2] - starts[1], 'the members are recreated a step apart').to.be.at.least(STEP_MS / 2);

    await waitFor(async () => settled(await setStatus(0, 'database')), {
      timeout: CONVERGE_MS, interval: 5000, label: 'one primary and two secondaries, all healthy, after the rename',
    });
    // The window closes after the last member has rejoined and the clients have
    // written through it.
    await new Promise((resolve) => { setTimeout(resolve, 20000); });
    const to = Math.floor(Date.now() / 1000);

    // eslint-disable-next-line no-restricted-syntax
    for (const index of [0, 1, 2]) {
      // eslint-disable-next-line no-await-in-loop
      const log = await probeLog(index);
      const during = log.filter((e) => e.at >= from && e.at <= to);
      const acknowledged = during.filter((e) => e.ok);
      // One attempt a second, each taking at most its 5 s server selection and
      // 5 s write timeout: a window of (to - from) seconds holds at least
      // (to - from) / 11 of them.
      expect(during.length, `node ${index}: the client wrote throughout`).to.be.at.least(Math.floor((to - from) / 11));
      const gaps = acknowledged.slice(1).map((e, i) => e.at - acknowledged[i].at);
      expect(Math.max(0, ...gaps), `node ${index}: writes resume within one election`).to.be.at.most(ELECTION_GAP_S);

      // eslint-disable-next-line no-await-in-loop
      const self = (await inComponent(index, 'client', ['printenv', 'FLUX_MESH_SELF'])).out;
      const ns = acknowledged.map((e) => e.n);
      // eslint-disable-next-line no-await-in-loop
      const kept = await mongosh(0, 'database', `db.getSiblingDB('probe').writes.countDocuments({ client: '${self}', n: { $in: ${JSON.stringify(ns)} } })`);
      expect(Number(kept.out), `node ${index}: every acknowledged write is kept`).to.equal(ns.length);
    }
  });

  it('keeps the hosts it named, and the data it held', async function () {
    this.timeout(120000);
    const hosts = await mongosh(0, 'database', 'JSON.stringify(rs.conf().members.map((m) => m.host))');
    expect(JSON.parse(hosts.out).sort(), 'the hosts it formed with').to.deep.equal(formed.map(host));
    const held = await mongosh(0, 'database', "db.getSiblingDB('kept').marks.findOne().held", byFormedNames);
    expect(held.out).to.equal('before-the-rename');
  });

  it('answers a client connecting by the old names', async function () {
    this.timeout(120000);
    const write = await mongosh(1, 'client', "db.getSiblingDB('kept').marks.insertOne({ after: 'the-rename' }, { writeConcern: { w: 'majority' } }).acknowledged", byFormedNames);
    expect(write.out, `a majority write by the formed names: ${write.err}`).to.equal('true');
  });

  it('rejoins a member restarted after the rename', async function () {
    this.timeout(CONVERGE_MS);
    const container = await requireAppContainerName(env.clients[1].container, name, 'database');
    const restarted = await execInContainer(env.clients[1].container, `docker restart ${container}`);
    expect(restarted.exitCode, 'the member restarts').to.equal(0);
    await waitFor(async () => settled(await setStatus(0, 'database')), {
      timeout: CONVERGE_MS, interval: 5000, label: 'the restarted member is healthy in the set again',
    });
    const write = await mongosh(0, 'database', "db.getSiblingDB('kept').marks.insertOne({ after: 'the-restart' }, { writeConcern: { w: 3, wtimeout: 30000 } }).acknowledged", byFormedNames);
    expect(write.out, `a write every member acknowledges: ${write.err}`).to.equal('true');
  });
});
