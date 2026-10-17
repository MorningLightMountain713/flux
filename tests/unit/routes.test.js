const { expect } = require('chai');
const sinon = require('sinon');
const routes = require('../../ZelBack/src/routes');
const routeTable = require('../../ZelBack/src/routeTableV1');
const { SERVICES_DIR } = require('../../ZelBack/src/routeBuilder');
const alwaysRespond = require('../../ZelBack/src/middlewares/alwaysRespond');
const isLocal = require('../../ZelBack/src/middlewares/isLocal');
const requireHttps = require('../../ZelBack/src/middlewares/requireHttps');
const appInspector = require('../../ZelBack/src/services/appManagement/appInspector');
const appController = require('../../ZelBack/src/services/appManagement/appController');
const monitoringOrchestrator = require('../../ZelBack/src/services/appMonitoring/monitoringOrchestrator');
const moduleLoader = require('../../ZelBack/src/lib/moduleLoader');
const capabilities = require('../../ZelBack/src/services/utils/capabilities');

// Every module a route names, loaded once: the names are data, so the modules are
// found by name. Loading a module runs none of its handlers.
const handlerModules = new Map();
// eslint-disable-next-line no-restricted-syntax
for (const modulePath of new Set(routeTable.map((route) => route.handler.split('#')[0]))) {
  handlerModules.set(modulePath, moduleLoader.load(modulePath, SERVICES_DIR));
}

// Nothing else builds the routing table, so a route wired to the wrong handler, or a
// middleware that was never mounted, reaches production unopposed. Build it against a
// recording app and assert what each path actually resolves to.
describe('routes tests', () => {
  let registered;

  before(() => {
    registered = [];
    const record = (method) => (path, ...handlers) => {
      registered.push({ method, path, handlers });
    };
    routes({
      get: record('get'),
      post: record('post'),
      put: record('put'),
      delete: record('delete'),
      use: record('use'),
      ws: record('ws'),
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  function routeFor(prefix) {
    const route = registered.find((r) => r.path === prefix || r.path.startsWith(`${prefix}/:`));
    expect(route, `no route registered for ${prefix}`).to.not.be.undefined;
    return route;
  }

  function invoke(prefix, req = {}, res = {}) {
    const route = routeFor(prefix);
    return route.handlers[route.handlers.length - 1](req, res);
  }

  it('should build the routing table', () => {
    expect(registered.length).to.be.greaterThan(0);
  });

  it('should register a callable handler for every route', () => {
    const bad = registered.filter((r) => r.handlers.some((h) => typeof h !== 'function'));

    expect(bad.map((r) => r.path)).to.deep.equal([]);
  });

  // The assertion above cannot fail: the builder wraps every route in a handler
  // that loads its module on the first call, so the handler is ALWAYS a function
  // - even when the function it names does not exist, which answers 500 on the
  // first request a user makes. Resolved without calling the handlers: invoking
  // ~400 production handlers to find out whether they exist is an outage.
  it('should wire every route to a function its service actually exports', () => {
    expect(handlerModules.size, 'no handler modules read - the scan is broken').to.be.greaterThan(20);

    const missing = routeTable
      .filter((route) => {
        const [modulePath, fn] = route.handler.split('#');
        return typeof handlerModules.get(modulePath)[fn] !== 'function';
      })
      .map((route) => `${route.method} ${route.path} -> ${route.handler}`);

    expect(missing, 'these routes name functions their module does not export').to.deep.equal([]);
  });

  describe('handler wiring', () => {
    it('should route appmonitor to the inspector handler', () => {
      const stub = sinon.stub(appInspector, 'appMonitorAPI');
      const req = {};
      const res = {};

      invoke('/apps/appmonitor', req, res);

      sinon.assert.calledOnceWithExactly(stub, req, res);
    });

    it('should route appstats to the inspector handler', () => {
      const stub = sinon.stub(appInspector, 'appStats');
      const req = {};
      const res = {};

      invoke('/apps/appstats', req, res);

      sinon.assert.calledOnceWithExactly(stub, req, res);
    });

    it('should route the monitoring control to the orchestrator', () => {
      const start = sinon.stub(monitoringOrchestrator, 'startAppMonitoringAPI');
      const stop = sinon.stub(monitoringOrchestrator, 'stopAppMonitoringAPI');

      invoke('/apps/startmonitoring');
      invoke('/apps/stopmonitoring');

      sinon.assert.calledOnce(start);
      sinon.assert.calledOnce(stop);
    });

    it('should route appstop to the controller', () => {
      const stub = sinon.stub(appController, 'appStop');
      const req = {};
      const res = {};

      invoke('/apps/appstop', req, res);

      sinon.assert.calledOnceWithExactly(stub, req, res);
    });
  });

  describe('middleware mounting', () => {
    // Repeating one of these must not collapse to a bodiless 304, or the caller cannot
    // tell whether the action ran.
    const CONTROL_ROUTES = [
      '/apps/appstart',
      '/apps/appstop',
      '/apps/apprestart',
      '/apps/apppause',
      '/apps/appunpause',
      '/apps/appremove',
      '/apps/redeploy',
      '/apps/redeploycomponent',
      // Retired, and the reason they need this most: the body is byte-identical
      // every time, so express ETags it and a revalidating caller gets an empty
      // 304 from the second call on - unable to read the deprecation notice that
      // is now the only thing these routes exist to serve.
      '/apps/startmonitoring',
      '/apps/stopmonitoring',
    ];

    CONTROL_ROUTES.forEach((prefix) => {
      it(`should answer ${prefix} in full on every call`, () => {
        expect(routeFor(prefix).handlers).to.include(alwaysRespond);
      });
    });

    it('should not mount alwaysRespond on read endpoints', () => {
      expect(routeFor('/apps/appstats').handlers).to.not.include(alwaysRespond);
      expect(routeFor('/apps/appmonitor').handlers).to.not.include(alwaysRespond);
    });

    it('should keep the arcane auth endpoints on https', () => {
      expect(routeFor('/arcane/authchallenge').handlers).to.include(requireHttps);
    });

    it('should keep the backend folder local only', () => {
      expect(routeFor('/flux/backendfolder').handlers).to.include(isLocal);
    });
  });

  describe('the login phrases', () => {
    afterEach(() => {
      capabilities.resetForTests();
    });

    // Runs the chain in front of the handler, as express would.
    function call(prefix) {
      const { handlers } = routeFor(prefix);
      const res = { setHeader: sinon.stub(), json: sinon.stub() };
      res.status = sinon.stub().returns(res);
      let reached = 0;
      handlers.slice(0, -1).every((middleware) => {
        let passed = false;
        middleware({}, res, () => { passed = true; });
        if (passed) reached += 1;
        return passed;
      });
      return { res, passedEvery: reached === handlers.length - 1 };
    }

    ['/id/loginphrase', '/id/emergencyphrase', '/zelid/loginphrase', '/zelid/emergencyphrase'].forEach((prefix) => {
      it(`should refuse ${prefix} until the local database is prepared`, () => {
        capabilities.setForTests('localDbPrepared', false);
        const refused = call(prefix);
        expect(refused.passedEvery).to.equal(false);
        sinon.assert.calledOnceWithExactly(refused.res.status, 503);
        expect(refused.res.json.firstCall.args[0].data.message).to.equal('Node is still preparing its database (localDbPrepared is not up)');

        capabilities.setForTests('localDbPrepared', true);
        expect(call(prefix).passedEvery).to.equal(true);
      });
    });
  });
});
