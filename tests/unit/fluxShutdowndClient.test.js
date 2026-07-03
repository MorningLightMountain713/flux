const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const { EventEmitter } = require('node:events');

// fluxShutdowndClient talks newline-delimited JSON-RPC over a unix socket. The
// tests mock `node:net` with a driveable fake socket and `globalState` for the
// Arcane gate + LB-state seam; everything else is the real client.

function makeFakeSocket() {
  const sock = new EventEmitter();
  sock.write = sinon.stub();
  sock.destroy = sinon.stub();
  return sock;
}

function load({ isArcane = true } = {}) {
  const sockets = [];
  const netStub = {
    createConnection: sinon.stub().callsFake(() => {
      const sock = makeFakeSocket();
      sockets.push(sock);
      return sock;
    }),
  };
  const globalStateStub = {
    isArcane: sinon.stub().returns(isArcane),
    setAppLbState: sinon.stub(),
  };
  const client = proxyquire('../../ZelBack/src/services/utils/fluxShutdowndClient', {
    'node:net': netStub,
    './globalState': globalStateStub,
    '../../lib/log': { warn: sinon.stub(), info: sinon.stub(), error: sinon.stub() },
  });
  return {
    client, netStub, globalStateStub, sockets,
  };
}

const okLine = (result) => `${JSON.stringify({ jsonrpc: '2.0', id: 1, result })}\n`;
const errLine = (code, message) => `${JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message } })}\n`;
const futureDeadline = () => Math.floor(Date.now() / 1000) + 30;

describe('fluxShutdowndClient', () => {
  afterEach(() => sinon.restore());

  describe('SHUTDOWN_REASON (wire-string mirror of the daemon ReasonCode)', () => {
    it('carries exactly the per-app reasons FluxOS emits, kebab-cased', () => {
      const { client } = load();
      expect(client.SHUTDOWN_REASON).to.deep.equal({
        TTL_EXPIRED: 'ttl-expired',
        USER_CANCEL: 'user-cancel',
        REDEPLOY: 'redeploy',
        EVICTION: 'eviction',
        MANUAL: 'manual',
      });
    });

    it('does not expose node-wide-only reasons (e.g. system)', () => {
      const { client } = load();
      expect(Object.values(client.SHUTDOWN_REASON)).to.not.include('system');
    });
  });

  describe('callRpc', () => {
    it('honors a custom timeoutMs over the 10s default', async () => {
      const clock = sinon.useFakeTimers();
      try {
        const { client, sockets } = load();
        const p = client.callRpc('noop', {}, { timeoutMs: 50 });
        let err;
        const done = p.catch((e) => { err = e; }); // attach before the reject fires
        sockets[0].emit('connect'); // connected, but the daemon never replies
        await clock.tickAsync(60);
        await done;
        expect(err).to.be.an('error');
        expect(err.isTimeout).to.equal(true);
      } finally {
        clock.restore();
      }
    });

    it('attaches the JSON-RPC error code to the rejection', async () => {
      const { client, sockets } = load();
      const p = client.callRpc('noop', {});
      let err;
      const done = p.catch((e) => { err = e; }); // attach before the reject fires
      sockets[0].emit('connect');
      sockets[0].emit('data', Buffer.from(errLine(-32010, 'node-pipeline-active')));
      await done;
      expect(err.rpcCode).to.equal(-32010);
    });
  });

  describe('beginAppStop', () => {
    it('short-circuits to not_arcane without opening a socket or touching the gate', async () => {
      const { client, netStub, globalStateStub } = load({ isArcane: false });
      const res = await client.beginAppStop('1own', 'app', 'ttl-expired', { deadline: futureDeadline() });
      expect(res).to.deep.equal({ outcome: 'not_arcane' });
      expect(netStub.createConnection.called).to.equal(false);
      expect(globalStateStub.setAppLbState.called).to.equal(false);
    });

    it('seeds the stopping LB gate synchronously, before the first await', () => {
      const { client, globalStateStub } = load();
      const deadline = futureDeadline();
      client.beginAppStop('1own', 'app', 'ttl-expired', { deadline }); // not awaited
      expect(globalStateStub.setAppLbState.calledOnce).to.equal(true);
      const [name, state, expiresAt] = globalStateStub.setAppLbState.firstCall.args;
      expect(name).to.equal('app');
      expect(state).to.equal('stopping');
      expect(expiresAt).to.be.greaterThan(deadline * 1000); // deadline ms + slack
    });

    it('returns the daemon end_state (complete)', async () => {
      const { client, sockets } = load();
      const p = client.beginAppStop('1own', 'app', 'ttl-expired', { deadline: futureDeadline() });
      sockets[0].emit('connect');
      sockets[0].emit('data', Buffer.from(okLine({ end_state: 'complete' })));
      expect(await p).to.deep.equal({ outcome: 'complete' });
    });

    it('passes through deadline and superseded end-states', async () => {
      for (const endState of ['deadline', 'superseded']) {
        const { client, sockets } = load();
        // eslint-disable-next-line no-await-in-loop
        const p = client.beginAppStop('1own', 'app', 'eviction', { deadline: futureDeadline() });
        sockets[0].emit('connect');
        sockets[0].emit('data', Buffer.from(okLine({ end_state: endState })));
        // eslint-disable-next-line no-await-in-loop
        expect(await p).to.deep.equal({ outcome: endState });
      }
    });

    it('maps a node-pipeline-active reject to rejected_pipeline_active', async () => {
      const { client, sockets } = load();
      const p = client.beginAppStop('1own', 'app', 'redeploy', { deadline: futureDeadline() });
      sockets[0].emit('connect');
      sockets[0].emit('data', Buffer.from(errLine(-32010, 'node-pipeline-active')));
      expect(await p).to.deep.equal({ outcome: 'rejected_pipeline_active' });
    });

    it('maps a socket error to unreachable', async () => {
      const { client, sockets } = load();
      const p = client.beginAppStop('1own', 'app', 'user-cancel', { deadline: futureDeadline() });
      const enoent = new Error('connect ENOENT');
      enoent.code = 'ENOENT';
      sockets[0].emit('error', enoent);
      expect(await p).to.deep.equal({ outcome: 'unreachable' });
    });

    it('maps a no-reply within the budget to timeout', async () => {
      const clock = sinon.useFakeTimers();
      try {
        const { client, sockets } = load();
        const p = client.beginAppStop('1own', 'app', 'manual', { deadline: 0 }); // deadline 0 -> timeout = slack
        sockets[0].emit('connect');
        await clock.tickAsync(120001); // past COMPLETION_SLACK_MS
        expect(await p).to.deep.equal({ outcome: 'timeout' });
      } finally {
        clock.restore();
      }
    });

    it('never rejects, even on a malformed daemon reply', async () => {
      const { client, sockets } = load();
      const p = client.beginAppStop('1own', 'app', 'ttl-expired', { deadline: futureDeadline() });
      sockets[0].emit('connect');
      sockets[0].emit('data', Buffer.from('not json\n'));
      expect(await p).to.deep.equal({ outcome: 'unreachable' });
    });
  });

  describe('forceAppStop', () => {
    it('short-circuits to not_arcane without opening a socket', async () => {
      const { client, netStub } = load({ isArcane: false });
      const res = await client.forceAppStop('1own', 'app');
      expect(res).to.deep.equal({ outcome: 'not_arcane' });
      expect(netStub.createConnection.called).to.equal(false);
    });

    it('maps the daemon end_state to the outcome (forced)', async () => {
      const { client, sockets } = load();
      const p = client.forceAppStop('1own', 'app');
      sockets[0].emit('connect');
      sockets[0].emit('data', Buffer.from(okLine({ end_state: 'forced' })));
      expect(await p).to.deep.equal({ outcome: 'forced' });
    });

    it('reports no_run when nothing was draining', async () => {
      const { client, sockets } = load();
      const p = client.forceAppStop('1own', 'app');
      sockets[0].emit('connect');
      sockets[0].emit('data', Buffer.from(okLine({ end_state: 'no_run' })));
      expect(await p).to.deep.equal({ outcome: 'no_run' });
    });

    it('returns unreachable when the socket errors', async () => {
      const { client, sockets } = load();
      const p = client.forceAppStop('1own', 'app');
      sockets[0].emit('error', new Error('ECONNREFUSED'));
      expect(await p).to.deep.equal({ outcome: 'unreachable' });
    });
  });
});
