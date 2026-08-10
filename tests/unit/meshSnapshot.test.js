'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
const realFsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// Real filesystem, rebased from the production resolver dir into a temp dir:
// the atomic-write and generation semantics ARE the contract flux-dnsd pins
// (rename in the same directory, strictly increasing generation), so they are
// exercised, not stubbed.
const PROD_DIR = '/var/lib/flux-mesh/resolver';

describe('meshSnapshot', () => {
  let tmpDir;
  let meshSnapshot;

  const rebase = (p) => (typeof p === 'string' && p.startsWith(PROD_DIR)
    ? path.join(tmpDir, p.slice(PROD_DIR.length)) : p);

  beforeEach(async () => {
    tmpDir = await realFsp.mkdtemp(path.join(os.tmpdir(), 'mesh-snap-'));
    const fspShim = {};
    for (const method of ['readFile', 'writeFile', 'mkdir']) {
      fspShim[method] = (p, ...args) => realFsp[method](rebase(p), ...args);
    }
    fspShim.rename = (a, b) => realFsp.rename(rebase(a), rebase(b));
    meshSnapshot = proxyquire('../../ZelBack/src/services/appMesh/meshSnapshot', {
      'node:fs/promises': fspShim,
    });
  });

  afterEach(async () => {
    await realFsp.rm(tmpDir, { recursive: true, force: true });
    sinon.restore();
  });

  const APPS = [{
    name: 'myblog',
    components: {
      mysql: { ports: { galera: { port: 4567, proto: 'tcp' } } },
    },
    members: [
      { component: 'web', nodeId: '6f6437c5' },
      { component: 'web', nodeId: '57eac747' },
      { component: 'mysql', nodeId: '6f6437c5', ordinal: 0 },
    ],
    containers: [
      { component: 'web', sourceIp: '172.23.0.2' },
      { component: 'mysql', sourceIp: '172.23.0.3' },
    ],
  }];

  it('writes the contract shape with generation 1 and distinct addresses', async () => {
    const { generation, snapshot } = await meshSnapshot.writeSnapshot('6f6437c5', APPS);
    expect(generation).to.equal(1);
    const onDisk = JSON.parse(await realFsp.readFile(path.join(tmpDir, 'membership.json'), 'utf8'));
    expect(onDisk).to.deep.equal(snapshot);
    expect(onDisk.schemaVersion).to.equal(1);
    expect(onDisk.nodeId).to.equal('6f6437c5');
    const ips = onDisk.apps[0].members.map((m) => m.ip);
    expect(new Set(ips).size).to.equal(3);
    ips.forEach((ip) => expect(ip).to.match(/^10\.127\./));
    expect(onDisk.apps[0].members[2].ordinal).to.equal(0);
    expect(onDisk.apps[0].components).to.deep.equal(APPS[0].components);
    expect(onDisk.apps[0].containers).to.deep.equal(APPS[0].containers);
    // No temp file left behind.
    const files = await realFsp.readdir(tmpDir);
    expect(files).to.deep.equal(['membership.json']);
  });

  it('keeps every existing assignment across rewrites and strictly increases generation', async () => {
    const first = await meshSnapshot.writeSnapshot('6f6437c5', APPS);
    const grown = [{
      ...APPS[0],
      members: [...APPS[0].members, { component: 'mysql', nodeId: '57eac747' }],
    }];
    const second = await meshSnapshot.writeSnapshot('6f6437c5', grown);
    expect(second.generation).to.equal(2);
    for (const member of first.snapshot.apps[0].members) {
      const kept = second.snapshot.apps[0].members.find(
        (m) => m.component === member.component && m.nodeId === member.nodeId,
      );
      expect(kept.ip).to.equal(member.ip);
    }
    const fresh = second.snapshot.apps[0].members.find(
      (m) => m.component === 'mysql' && m.nodeId === '57eac747',
    );
    expect(first.snapshot.apps[0].members.map((m) => m.ip)).to.not.include(fresh.ip);
  });

  it('a departed member frees its address only after it leaves the ledger', async () => {
    await meshSnapshot.writeSnapshot('6f6437c5', APPS);
    const shrunk = [{ ...APPS[0], members: APPS[0].members.slice(0, 1) }];
    const second = await meshSnapshot.writeSnapshot('6f6437c5', shrunk);
    // The survivor keeps its address; the ledger now holds only the survivor.
    expect(second.snapshot.apps[0].members).to.have.lengthOf(1);
    const third = await meshSnapshot.writeSnapshot('6f6437c5', APPS);
    expect(third.generation).to.equal(3);
    const survivor = third.snapshot.apps[0].members.find(
      (m) => m.component === 'web' && m.nodeId === '6f6437c5',
    );
    expect(survivor.ip).to.equal(second.snapshot.apps[0].members[0].ip);
  });

  it('liveness never enters the snapshot — DNS carries membership only', async () => {
    // A caller that still marks a member unhealthy gets it silently dropped:
    // whether a member is up is the cluster software's own protocol to
    // decide, and hiding a member from discovery breaks bootstrap/rejoin.
    const apps = [{
      name: 'myblog',
      members: [
        { component: 'web', nodeId: '6f6437c5', healthy: false },
        { component: 'web', nodeId: '57eac747' },
      ],
      containers: [],
    }];
    const { snapshot } = await meshSnapshot.writeSnapshot('6f6437c5', apps);
    expect(snapshot.apps[0].members[0]).to.not.have.property('healthy');
    expect(snapshot.apps[0].members[1]).to.not.have.property('healthy');
  });

  it('components defaults to an empty map when the caller carries none', async () => {
    const apps = [{
      name: 'myblog',
      members: [{ component: 'web', nodeId: '6f6437c5' }],
      containers: [],
    }];
    const { snapshot } = await meshSnapshot.writeSnapshot('6f6437c5', apps);
    expect(snapshot.apps[0].components).to.deep.equal({});
  });

  describe('waitForGeneration — the membership long-poll park', () => {
    it('answers immediately when the generation already differs, in either direction', async () => {
      await meshSnapshot.writeSnapshot('6f6437c5', APPS); // generation 1
      // Behind: the level moved since the caller's read.
      expect(await meshSnapshot.waitForGeneration(0, 5000)).to.equal(1);
      // Ahead: a lost ledger restarts generations; a stale cursor must never wedge.
      expect(await meshSnapshot.waitForGeneration(7, 5000)).to.equal(1);
    });

    it('parks on the current generation and wakes on the next write', async () => {
      await meshSnapshot.writeSnapshot('6f6437c5', APPS);
      const woken = meshSnapshot.waitForGeneration(1, 30000);
      // Give the waiter its subscribe-then-read beat, then land a write.
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      await meshSnapshot.writeSnapshot('6f6437c5', APPS.map((app) => ({
        ...app, members: app.members.slice(0, 1),
      })));
      expect(await woken).to.equal(2);
    });

    it('times out to the unchanged generation — itself the answer "nothing happened"', async () => {
      await meshSnapshot.writeSnapshot('6f6437c5', APPS);
      expect(await meshSnapshot.waitForGeneration(1, 100)).to.equal(1);
    });
  });
});
