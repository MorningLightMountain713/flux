'use strict';

const path = require('node:path');

const { expect } = require('chai');
const express = require('express');
const request = require('supertest');
const apicache = require('apicache');

const capabilities = require('../../ZelBack/src/services/utils/capabilities');
const { registerRoutes, chainFor } = require('../../ZelBack/src/routeBuilder');
const liveHandlers = require('./fixtures/routeHandlers/live');

const FIXTURES = path.join(__dirname, 'fixtures/routeHandlers');
const refuse = (res, { message }) => res.status(503).json({ status: 'error', data: { message } });
const surface = { refuse, baseDir: FIXTURES };

function appWith(table) {
  const app = express();
  // express logs a handler's error to stderr outside test mode
  app.set('env', 'test');
  registerRoutes(app, table, surface);
  return app;
}

describe('routeBuilder', () => {
  beforeEach(() => {
    capabilities.resetForTests();
    apicache.clear();
  });

  afterEach(() => {
    capabilities.resetForTests();
    apicache.clear();
  });

  it('registers guards, then the capability gate, then the cache, then the handler', () => {
    const chain = chainFor({
      method: 'get',
      path: '/x',
      guards: ['alwaysRespond', 'rejectQueryParameters'],
      needs: ['daemonReachable'],
      cache: '30 seconds',
      handler: 'counted#answer',
    }, surface);

    expect(chain.map((fn) => fn.name)).to.deep.equal([
      'alwaysRespond', 'rejectQueryParameters', 'capabilityGateMiddleware', 'cache', '',
    ]);
  });

  it('registers no gate for a route that reads no capability', () => {
    const chain = chainFor({
      method: 'get', path: '/x', none: 'reads nothing', handler: 'counted#answer',
    }, surface);

    expect(chain.map((fn) => fn.name)).to.not.include('capabilityGateMiddleware');
  });

  it('refuses while a capability is down: 503, Retry-After, no-store, naming the capability', async () => {
    const app = appWith([{
      method: 'get', path: '/held', needs: ['bootReconcileDecided'], handler: 'counted#answer',
    }]);

    const res = await request(app).get('/held');

    expect(res.status).to.equal(503);
    expect(res.headers['retry-after']).to.equal('15');
    expect(res.headers['cache-control']).to.equal('no-store');
    expect(res.body.data.message).to.equal('Node is still reconciling its applications after boot (bootReconcileDecided is not up)');
  });

  // An app created before the boot decision has no location record to be kept
  // by, and a redeploy uninstalls before the install that needs the policy: a
  // refusal the handler runs behind is not a refusal.
  it('never lets a refused call reach the handler', async () => {
    liveHandlers.resetCalls();
    const app = appWith([{
      method: 'get', path: '/held', needs: ['bootReconcileDecided'], handler: 'live#counted',
    }]);

    await request(app).get('/held');
    await request(app).get('/held');
    expect(liveHandlers.calls()).to.equal(0);

    capabilities.setForTests('bootReconcileDecided', true);
    await request(app).get('/held');
    expect(liveHandlers.calls()).to.equal(1);
  });

  // The remedies differ - boot settles on its own, policy may need another node -
  // so a caller has to be able to tell the two refusals apart.
  it('names the policy, not boot, when the policy is what is missing', async () => {
    capabilities.setForTests('bootReconcileDecided', true);
    const app = appWith([{
      method: 'get', path: '/redeploy', needs: ['bootReconcileDecided', 'policyVerified', 'policyCurrent'], handler: 'live#counted',
    }]);

    const res = await request(app).get('/redeploy');

    expect(res.body.data.message).to.match(/network policy/);
    expect(res.body.data.message).to.not.match(/boot/i);
  });

  it('names the first capability of a set that is down, and answers once all are up', async () => {
    const app = appWith([{
      method: 'get', path: '/held', needs: ['bootReconcileDecided', 'policyVerified'], handler: 'counted#answer',
    }]);
    capabilities.setForTests('bootReconcileDecided', true);

    const refused = await request(app).get('/held');
    expect(refused.status).to.equal(503);
    expect(refused.headers['retry-after']).to.equal('30');
    expect(refused.body.data.message).to.include('policyVerified is not up');

    capabilities.setForTests('policyVerified', true);
    const answered = await request(app).get('/held');
    expect(answered.status).to.equal(200);
    expect(answered.body).to.deep.equal({ answered: 'counted' });
  });

  it('never stores a refusal, and never serves a stored answer while the route is down', async () => {
    const app = appWith([{
      method: 'get', path: '/cached', needs: ['daemonReachable'], cache: '30 seconds', handler: 'counted#answer',
    }]);

    expect((await request(app).get('/cached')).status).to.equal(503);
    capabilities.setForTests('daemonReachable', true);
    expect((await request(app).get('/cached')).status).to.equal(200);
    capabilities.setForTests('daemonReachable', false);
    expect((await request(app).get('/cached')).status).to.equal(503);
  });

  it('loads a handler module on the first call, not at registration, and once', async () => {
    delete require.cache[path.join(FIXTURES, 'counted.js')];
    global.routeBuilderFixtureLoads = 0;
    const app = appWith([{
      method: 'get', path: '/lazy', none: 'reads nothing', handler: 'counted#answer',
    }]);
    expect(global.routeBuilderFixtureLoads).to.equal(0);

    await request(app).get('/lazy');
    await request(app).get('/lazy');

    expect(global.routeBuilderFixtureLoads).to.equal(1);
  });

  it('reads the handler function from its module on every call', async () => {
    const app = appWith([{
      method: 'get', path: '/live', none: 'reads nothing', handler: 'live#answer',
    }]);
    expect((await request(app).get('/live')).body).to.deep.equal({ answered: 'live' });
    const original = liveHandlers.answer;
    liveHandlers.answer = (req, res) => res.json({ answered: 'replaced' });
    try {
      expect((await request(app).get('/live')).body).to.deep.equal({ answered: 'replaced' });
    } finally {
      liveHandlers.answer = original;
    }
  });

  it('answers 500 for a handler that rejects, rather than dropping the promise', async () => {
    const app = appWith([{
      method: 'get', path: '/fails', none: 'reads nothing', handler: 'counted#reject',
    }]);

    expect((await request(app).get('/fails')).status).to.equal(500);
  });

  it('refuses to register a route naming an unknown guard', () => {
    expect(() => chainFor({
      method: 'get', path: '/x', guards: ['noSuchGuard'], none: 'reads nothing', handler: 'counted#answer',
    }, surface)).to.throw(/unknown guard noSuchGuard/);
  });
});
