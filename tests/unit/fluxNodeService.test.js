'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

describe('fluxNodeService — /mesh/membership', () => {
  let fluxNodeService;
  let stubs;

  const SNAPSHOT = {
    schemaVersion: 1,
    generation: 42,
    nodeId: 'a1b2c3d4',
    apps: [
      {
        name: 'myblog',
        members: [
          { component: 'db', nodeId: 'a1b2c3d4', ip: '10.127.0.5', ordinal: 1 },
          { component: 'db', nodeId: '9f21c377', ip: '10.127.0.7', ordinal: 0 },
          { component: 'db', nodeId: '77aa88bb', ip: '10.127.0.9' },
        ],
        containers: [{ component: 'db', sourceIp: '172.23.0.2' }],
      },
      {
        name: 'other',
        members: [{ component: 'api', nodeId: 'a1b2c3d4', ip: '10.90.1.4', ordinal: 0 }],
        containers: [{ component: 'api', sourceIp: '172.24.0.2' }],
      },
    ],
  };

  beforeEach(() => {
    stubs = {
      snapshot: SNAPSHOT,
      readCurrentSnapshot: sinon.stub().callsFake(async () => stubs.snapshot),
      waitForGeneration: sinon.stub().callsFake(async () => stubs.snapshot?.generation ?? 0),
    };
    fluxNodeService = proxyquire('../../ZelBack/src/services/fluxNodeService', {
      './appMesh/meshSnapshot': {
        readCurrentSnapshot: stubs.readCurrentSnapshot,
        waitForGeneration: stubs.waitForGeneration,
      },
    });
  });

  afterEach(() => sinon.restore());

  function request(remoteAddress, query = {}) {
    const res = { json: sinon.stub() };
    return {
      req: { socket: { remoteAddress }, query },
      res,
      body: () => res.json.firstCall.args[0],
    };
  }

  it('answers the caller its own app level: generation, self, canonical names, no addresses', async () => {
    const { req, res, body } = request('::ffff:172.23.0.2');
    await fluxNodeService.getMeshMembership(req, res);
    const { status, data } = body();
    expect(status).to.equal('success');
    expect(data.generation).to.equal(42);
    expect(data.app).to.equal('myblog');
    expect(data.self).to.deep.equal({
      component: 'db', member: 'db-1', ordinal: 1, fqdn: 'db-1.myblog.mesh.flux',
    });
    expect(data.members).to.deep.equal([
      {
        component: 'db', member: 'db-1', ordinal: 1, fqdn: 'db-1.myblog.mesh.flux',
      },
      {
        component: 'db', member: 'db-0', ordinal: 0, fqdn: 'db-0.myblog.mesh.flux',
      },
      // The standby: present in the membership, nodeid name, no ordinal.
      {
        component: 'db', member: 'db-77aa88bb', ordinal: null, fqdn: 'db-77aa88bb.myblog.mesh.flux',
      },
    ]);
    // Identity only — the presented addresses stay in DNS where they belong.
    expect(JSON.stringify(data)).to.not.include('10.127');
  });

  it('scopes by source address: another app sees only its own membership', async () => {
    const { req, res, body } = request('172.24.0.2');
    await fluxNodeService.getMeshMembership(req, res);
    expect(body().data.app).to.equal('other');
    expect(body().data.members).to.have.length(1);
  });

  it('refuses a caller the snapshot does not scope', async () => {
    const { req, res, body } = request('172.99.0.9');
    await fluxNodeService.getMeshMembership(req, res);
    expect(body().status).to.equal('error');
    expect(stubs.waitForGeneration.called).to.equal(false);
  });

  it('refuses everything when no snapshot exists yet', async () => {
    stubs.snapshot = null;
    const { req, res, body } = request('172.23.0.2');
    await fluxNodeService.getMeshMembership(req, res);
    expect(body().status).to.equal('error');
  });

  it('long-polls via waitForGeneration with the clamped timeout, then answers the fresh level', async () => {
    stubs.waitForGeneration.callsFake(async () => {
      stubs.snapshot = { ...SNAPSHOT, generation: 43 };
      return 43;
    });
    const { req, res, body } = request('172.23.0.2', { waitAfter: '42', timeoutS: '9999' });
    await fluxNodeService.getMeshMembership(req, res);
    expect(stubs.waitForGeneration.calledOnceWith(42, 600 * 1000)).to.equal(true);
    expect(body().data.generation).to.equal(43);
  });

  it('a plain read never parks, and a malformed waitAfter reads as plain', async () => {
    for (const query of [{}, { waitAfter: 'soon' }, { waitAfter: '-3' }]) {
      stubs.waitForGeneration.resetHistory();
      const { req, res, body } = request('172.23.0.2', query);
      // eslint-disable-next-line no-await-in-loop
      await fluxNodeService.getMeshMembership(req, res);
      expect(stubs.waitForGeneration.called, JSON.stringify(query)).to.equal(false);
      expect(body().data.generation).to.equal(42);
    }
  });

  it('refuses after the wait when the app left the mesh meanwhile', async () => {
    stubs.waitForGeneration.callsFake(async () => {
      stubs.snapshot = { ...SNAPSHOT, apps: [] };
      return 43;
    });
    const { req, res, body } = request('172.23.0.2', { waitAfter: '42' });
    await fluxNodeService.getMeshMembership(req, res);
    expect(body().status).to.equal('error');
  });
});
