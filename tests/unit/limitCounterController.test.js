'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('limitCounterController tests', () => {
  let controller;
  let stubs;
  const KEY = 'a'.repeat(64);

  function load(opts = {}) {
    stubs = {
      // '??' would turn a deliberate null back into 'counter', which is the case
      // under test.
      localRoleForKey: sinon.stub().resolves('role' in opts ? opts.role : 'counter'),
      reserve: sinon.stub().returns({ allowed: true, token: 'tok', reason: null }),
      release: sinon.stub().returns(true),
    };
    return proxyquire('../../ZelBack/src/services/utils/limitCounterController', {
      config: {
        fluxapps: {
          limitCounters: { playground: {}, 'playground#deputy': {} },
          limitCounterPeerAsksPerMinute: opts.peerAsks ?? 600,
        },
      },
      '../messageHelper': {
        createErrorMessage: (message) => ({ status: 'error', data: { message } }),
        createDataMessage: (data) => ({ status: 'success', data }),
      },
      '../serviceHelper': { ensureObject: (o) => (o && typeof o === 'object' ? o : {}) },
      './limitCounter': { localRoleForKey: stubs.localRoleForKey },
      './limitCounterStore': { reserve: stubs.reserve, release: stubs.release },
      '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
    });
  }

  function mkRes() {
    const captured = { code: 200, body: null };
    return {
      captured,
      status(code) { captured.code = code; return this; },
      json(body) { captured.body = body; return body; },
    };
  }

  const mkReq = (body, peer = '10.0.0.1') => ({ body, socket: { remoteAddress: peer } });

  beforeEach(() => { controller = load(); });
  afterEach(() => { controller.reset(); sinon.restore(); });

  it('takes a slot for a key this node holds', async () => {
    const res = mkRes();
    await controller.reserve(mkReq({ purpose: 'playground', key: KEY }), res);

    expect(res.captured.body.status).to.equal('success');
    expect(res.captured.body.data.allowed).to.be.true;
    sinon.assert.calledOnceWithExactly(stubs.reserve, 'playground', KEY);
  });

  it('declines a key this node does not hold', async () => {
    // A node that answered for keys it does not hold would be a counter for
    // anyone who asked, which is not a counter at all.
    controller = load({ role: null });
    const res = mkRes();
    await controller.reserve(mkReq({ purpose: 'playground', key: KEY }), res);

    expect(res.captured.code).to.equal(409);
    expect(stubs.reserve.called).to.be.false;
  });

  it('declines when it is only the deputy — a deputy answers from its own memory', async () => {
    controller = load({ role: 'deputy' });
    const res = mkRes();
    await controller.reserve(mkReq({ purpose: 'playground', key: KEY }), res);

    expect(res.captured.code).to.equal(409);
    expect(stubs.reserve.called).to.be.false;
  });

  it('rejects a purpose this node is not configured for', async () => {
    // Otherwise any string grows the map, which is a memory hole reachable by
    // anyone who can reach the port.
    const res = mkRes();
    await controller.reserve(mkReq({ purpose: 'whatever', key: KEY }), res);

    expect(res.captured.code).to.equal(400);
    expect(stubs.reserve.called).to.be.false;
  });

  it('rejects a deputy purpose over the wire', async () => {
    // A deputy only ever answers locally, for itself. A request naming one is not
    // something this node should serve.
    const res = mkRes();
    await controller.reserve(mkReq({ purpose: 'playground#deputy', key: KEY }), res);

    expect(res.captured.code).to.equal(400);
    expect(stubs.reserve.called).to.be.false;
  });

  ['', 'short', 'A'.repeat(64), `${'a'.repeat(63)}z`, 'a'.repeat(65)].forEach((bad) => {
    it(`rejects a malformed key (${bad.slice(0, 12) || 'empty'})`, async () => {
      const res = mkRes();
      await controller.reserve(mkReq({ purpose: 'playground', key: bad }), res);

      expect(res.captured.code).to.equal(400);
      expect(stubs.reserve.called).to.be.false;
    });
  });

  it('rejects a missing body', async () => {
    const res = mkRes();
    await controller.reserve({ socket: { remoteAddress: '10.0.0.1' } }, res);

    expect(res.captured.code).to.equal(400);
  });

  it('caps how fast one peer can ask', async () => {
    controller = load({ peerAsks: 2 });
    const req = () => mkReq({ purpose: 'playground', key: KEY }, '10.0.0.9');

    await controller.reserve(req(), mkRes());
    await controller.reserve(req(), mkRes());
    const third = mkRes();
    await controller.reserve(req(), third);

    expect(third.captured.code).to.equal(429);
  });

  it('counts the cap per peer, not globally', async () => {
    controller = load({ peerAsks: 1 });
    await controller.reserve(mkReq({ purpose: 'playground', key: KEY }, '10.0.0.1'), mkRes());

    const other = mkRes();
    await controller.reserve(mkReq({ purpose: 'playground', key: KEY }, '10.0.0.2'), other);

    expect(other.captured.body.status).to.equal('success');
  });

  describe('release', () => {
    it('gives a slot back', async () => {
      const res = mkRes();
      await controller.release(mkReq({ purpose: 'playground', key: KEY, token: 'tok' }), res);

      expect(res.captured.body.data.released).to.be.true;
      sinon.assert.calledOnceWithExactly(stubs.release, 'playground', KEY, 'tok');
    });

    it('answers success for a token it never issued', async () => {
      // The caller cannot tell the difference and there is nothing useful it could
      // do with it, so this is a no-op rather than an error.
      stubs.release.returns(false);
      const res = mkRes();
      await controller.release(mkReq({ purpose: 'playground', key: KEY, token: 'nope' }), res);

      expect(res.captured.body.status).to.equal('success');
      expect(res.captured.body.data.released).to.be.false;
    });

    it('applies the same guards as reserve', async () => {
      controller = load({ role: null });
      const res = mkRes();
      await controller.release(mkReq({ purpose: 'playground', key: KEY, token: 'tok' }), res);

      expect(res.captured.code).to.equal(409);
      expect(stubs.release.called).to.be.false;
    });
  });
});
