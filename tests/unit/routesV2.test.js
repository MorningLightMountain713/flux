'use strict';

// The /v2 surface, and the routing rule that keeps it portable.
//
// Express 5 compatibility is asserted STATICALLY over the source, because the
// failure it guards is silent: express 5's optional-group form `/x{/:id}`
// registers on express 4 WITHOUT THROWING and then matches nothing. A dead
// route looks exactly like a working one until a caller gets a 404, and the
// route table still lists it. So the rule is checked where it can be seen - in
// the path strings themselves - rather than by calling the routes and hoping a
// missing one is noticed.

const fs = require('node:fs');
const nodePath = require('node:path');

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const express = require('express');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const espree = require('espree');
const supertest = require('supertest');

chai.use(chaiAsPromised);
const { expect } = chai;

const ROOT = nodePath.join(__dirname, '../..');
const SOURCE = 'ZelBack/src/routesV2.js';

function v2Paths() {
  const src = fs.readFileSync(nodePath.join(ROOT, SOURCE), 'utf8');
  const ast = espree.parse(src, { ecmaVersion: 2022, sourceType: 'script', loc: true });
  const paths = [];
  const walk = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'CallExpression'
      && node.callee.type === 'MemberExpression'
      && node.callee.object.type === 'Identifier' && node.callee.object.name === 'router'
      && ['get', 'post', 'put', 'patch', 'delete', 'all'].includes(node.callee.property.name)
      && node.arguments.length
      && node.arguments[0].type === 'Literal'
      && typeof node.arguments[0].value === 'string') {
      paths.push({ method: node.callee.property.name, path: node.arguments[0].value, line: node.loc.start.line });
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'range') continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value.type === 'string') walk(value);
    }
  };
  walk(ast);
  return paths;
}

describe('routesV2 - the /v2 surface', () => {
  describe('every path is written in the express 4 AND 5 subset', () => {
    const paths = v2Paths();

    // A sweep that resolves nothing passes every assertion below it.
    it('found the routes to check', () => {
      expect(paths.length, 'no v2 routes were read out of the source').to.be.greaterThan(0);
      expect(paths.map((p) => p.path)).to.include('/operations/:id');
    });

    // `/x/:id?` is express 4 only - express 5's parser rejects it outright.
    it('declares no optional path parameter', () => {
      const offenders = paths.filter((p) => /:[A-Za-z0-9_]+\?/.test(p.path))
        .map((p) => `${SOURCE}:${p.line} ${p.method.toUpperCase()} ${p.path}`);
      expect(offenders, 'express 5 rejects `:param?`; take the operand from the query or the body').to.deep.equal([]);
    });

    // `/x{/:id}` is express 5 only - on express 4 it registers and matches
    // nothing, which is why this is the rule that matters most here.
    it('declares no optional group', () => {
      const offenders = paths.filter((p) => p.path.includes('{') || p.path.includes('}'))
        .map((p) => `${SOURCE}:${p.line} ${p.method.toUpperCase()} ${p.path}`);
      expect(offenders, 'an express 5 optional group silently matches NOTHING on express 4').to.deep.equal([]);
    });

    // Express 5 requires a named wildcard.
    it('declares no bare wildcard and no inline regex', () => {
      const offenders = paths.filter((p) => /\*(?![A-Za-z])/.test(p.path) || /\(/.test(p.path))
        .map((p) => `${SOURCE}:${p.line} ${p.method.toUpperCase()} ${p.path}`);
      expect(offenders, 'express 5 needs `/*name`, and drops inline regex params').to.deep.equal([]);
    });

    // NO CUSTOM VERBS (design §4a-bis). A state you can be IN is a state, and a
    // thing that HAPPENS is an operation, so every v2 mutation is PUT a state
    // or POST into a collection. A path whose last segment is a verb is the
    // shape this replaced, and it erodes one endpoint at a time unless the rule
    // is enforced rather than written down.
    it('declares no path ending in a verb', () => {
      const VERBS = /^(stop|start|restart|pause|unpause|resume|redeploy|rebuild|install|uninstall|remove|update|cancel|exec|backup|restore|reindex|rescan|enable|disable|create|delete|kill|reboot)$/i;
      const offenders = paths
        .filter((p) => VERBS.test(p.path.split('/').filter(Boolean).pop() || ''))
        .map((p) => `${SOURCE}:${p.line} ${p.method.toUpperCase()} ${p.path}`);
      expect(offenders, 'a state is PUT to /state; anything else is POSTed to /operations').to.deep.equal([]);
    });

    // The same rule from the other side: /actions/ was the shape this replaced.
    it('declares no /actions/ segment', () => {
      const offenders = paths.filter((p) => p.path.split('/').includes('actions'))
        .map((p) => `${SOURCE}:${p.line} ${p.method.toUpperCase()} ${p.path}`);
      expect(offenders, 'v2 has no custom verbs - see design §4a-bis').to.deep.equal([]);
    });

    // The proof that the subset above is really the intersection: every path
    // this surface declares is accepted by express's own parser as it stands.
    it('registers on the express in this tree without matching nothing', () => {
      paths.forEach((p) => {
        const probe = express.Router();
        expect(() => probe[p.method](p.path, (req, res) => res.end()), `${p.path} did not register`).to.not.throw();
      });
    });
  });

  // §5a's rule is that every v2 route lands with its OpenAPI entry. A contract
  // nothing checks is a document that drifts, so the two are compared here and
  // in BOTH directions - a stale entry for a route that no longer exists is as
  // misleading to a client as a missing one.
  describe('the OpenAPI contract matches the surface', () => {
    const spec = JSON.parse(fs.readFileSync(nodePath.join(ROOT, 'ZelBack/src/apiV2.openapi.json'), 'utf8'));
    const declared = v2Paths();
    // express `/operations/:id` is OpenAPI `/operations/{id}`
    const asOpenApi = (p) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

    it('has an entry for every route the router declares', () => {
      const missing = declared
        .filter((r) => !(spec.paths[asOpenApi(r.path)] || {})[r.method])
        .map((r) => `${r.method.toUpperCase()} ${asOpenApi(r.path)} is routed and undocumented`);
      expect(missing).to.deep.equal([]);
    });

    it('documents no route the router does not declare', () => {
      const routed = new Set(declared.map((r) => `${r.method} ${asOpenApi(r.path)}`));
      const orphans = [];
      Object.entries(spec.paths).forEach(([path, methods]) => {
        Object.keys(methods).forEach((method) => {
          if (!routed.has(`${method} ${path}`)) orphans.push(`${method.toUpperCase()} ${path} is documented and not routed`);
        });
      });
      expect(orphans).to.deep.equal([]);
    });

    // The error code enum IS the contract, so it cannot say something the
    // surface cannot answer.
    it('documents exactly the error codes the surface can answer', () => {
      const routerModule = require('../../ZelBack/src/routesV2');
      const documented = spec.components.schemas.Error.properties.error.properties.code.enum;
      expect([...documented].sort()).to.deep.equal(Object.keys(routerModule.CODE_TO_STATUS).sort());
    });

    it('is served under the /v2 prefix, so a documented path is not doubled', () => {
      expect(spec.servers.map((server) => server.url)).to.deep.equal(['/v2']);
      Object.keys(spec.paths).forEach((path) => {
        expect(path, 'the prefix belongs to the server, not the path').to.not.match(/^\/v2\//);
      });
    });
  });

  describe('the surface', () => {
    let app;
    let verifyPrivilege;
    let readOperation;
    let callerFluxId;

    beforeEach(() => {
      verifyPrivilege = sinon.stub().resolves(true);
      readOperation = sinon.stub().resolves(null);
      callerFluxId = sinon.stub().resolves(null);

      const router = proxyquire('../../ZelBack/src/routesV2', {
        './lib/log': {
          info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
        },
        './services/verificationHelper': { verifyPrivilege },
        './services/appManagement/operationsController': { readOperation, callerFluxId },
      });

      app = express();
      app.use('/v2', router);
      // A v1 route BELOW the mount, so a /v2 path that fell through would be
      // visible as this answering instead of the surface's own 404.
      app.get('/v2/operations/leaked', (req, res) => res.json({ v1: true }));
    });

    afterEach(() => sinon.restore());

    it('answers an operation in the v2 envelope, with a requestId', async () => {
      readOperation.resolves({ jobId: 'op_1', status: 'Running' });

      const res = await supertest(app).get('/v2/operations/op_1');

      expect(res.status).to.equal(200);
      expect(res.body.data).to.deep.equal({ jobId: 'op_1', status: 'Running' });
      expect(res.body.meta.requestId, 'every answer carries one').to.be.a('string');
      expect(res.headers['x-request-id']).to.equal(res.body.meta.requestId);
      expect(res.body).to.not.have.property('error');
    });

    it('echoes a caller-supplied request id rather than minting its own', async () => {
      readOperation.resolves({ jobId: 'op_1' });

      const res = await supertest(app).get('/v2/operations/op_1').set('X-Request-Id', 'given-by-the-caller');

      expect(res.body.meta.requestId).to.equal('given-by-the-caller');
    });

    // v1 answered 200 with the error in the body. The status code IS the answer
    // here, and it is derived from the code so the two cannot disagree.
    it('answers a missing operation 404, not 200', async () => {
      readOperation.resolves(null);

      const res = await supertest(app).get('/v2/operations/op_nope');

      expect(res.status).to.equal(404);
      expect(res.body.error.code).to.equal('NOT_FOUND');
      expect(res.body).to.not.have.property('data');
    });

    it('refuses a since cursor that is not a number', async () => {
      const res = await supertest(app).get('/v2/operations/op_1?since=soon');

      expect(res.status).to.equal(400);
      expect(res.body.error.code).to.equal('BAD_REQUEST');
      sinon.assert.notCalled(readOperation);
    });

    // Unknown, expired and not-yours are one answer, so a caller cannot learn
    // from the status code that someone else has an operation running.
    it('does not distinguish an operation that is not the caller\'s from one that does not exist', async () => {
      readOperation.resolves(null);
      callerFluxId.resolves('1SomeoneElse');

      const res = await supertest(app).get('/v2/operations/op_theirs');

      expect(res.status).to.equal(404);
      expect(JSON.stringify(res.body)).to.not.match(/forbid|denied|owner/i);
    });

    // Without the terminating 404 a typo under /v2 reaches a v1 handler and
    // answers in the wrong envelope.
    it('terminates its own surface rather than falling through to v1', async () => {
      const res = await supertest(app).get('/v2/operations/leaked/extra');

      expect(res.status).to.equal(404);
      expect(res.body.error.code).to.equal('NOT_FOUND');
      expect(res.body.v1, 'a v2 path reached a v1 handler').to.equal(undefined);
    });

    it('answers an unparseable body 400 rather than crashing the surface', async () => {
      const res = await supertest(app)
        .post('/v2/operations/op_1')
        .set('Content-Type', 'application/json')
        .send('{not json');

      expect(res.status).to.equal(400);
      expect(res.body.error.code).to.equal('BAD_REQUEST');
    });
  });

  describe('requireTier / requireAppTier', () => {
    let verifyPrivilege;
    let routerModule;
    let app;

    beforeEach(() => {
      verifyPrivilege = sinon.stub();
      routerModule = proxyquire('../../ZelBack/src/routesV2', {
        './lib/log': {
          info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
        },
        './services/verificationHelper': { verifyPrivilege },
        './services/appManagement/operationsController': { readOperation: sinon.stub(), callerFluxId: sinon.stub() },
      });

      const probe = express.Router();
      probe.use(routerModule.envelope);
      probe.get('/guarded/:appname', routerModule.requireAppTier(
        routerModule.Privilege.APP_OWNER,
        (req) => req.params.appname,
      ), (req, res) => res.ok({ reached: true }));
      probe.get('/unscoped', routerModule.requireTier(
        routerModule.Privilege.FLUX_TEAM,
      ), (req, res) => res.ok({ reached: true }));

      app = express();
      app.use('/v2', probe);
    });

    afterEach(() => sinon.restore());

    // The header value, never the request: verifyPrivilege throws a TypeError
    // on a request object so a wiring mistake cannot arrive looking like a
    // failed check.
    it('hands verifyPrivilege the zelidauth header and the app scope', async () => {
      verifyPrivilege.resolves(true);

      await supertest(app).get('/v2/guarded/myapp').set('zelidauth', 'the-header-value');

      sinon.assert.calledOnceWithExactly(verifyPrivilege, 'appowner', 'the-header-value', { appName: 'myapp' });
    });

    // The app-scoped form is separate rather than an optional argument, so
    // privilegeCallShape can see which call sites carry an app name. A computed
    // options object is an expression it cannot read.
    it('passes no app name for a privilege that reads none', async () => {
      verifyPrivilege.resolves(true);

      await supertest(app).get('/v2/unscoped').set('zelidauth', 'the-header-value');

      sinon.assert.calledOnceWithExactly(verifyPrivilege, 'fluxteam', 'the-header-value');
    });

    it('answers 401 and does not reach the handler when the tier is refused', async () => {
      verifyPrivilege.resolves(false);

      const res = await supertest(app).get('/v2/guarded/myapp');

      expect(res.status).to.equal(401);
      expect(res.body.error.code).to.equal('UNAUTHORIZED');
      expect(res.body.data).to.equal(undefined);
    });

    // A check that THREW is not a check that said no, and answering 401 for it
    // would tell a caller their credentials were wrong when the node is broken.
    it('answers 500 when the privilege check itself throws', async () => {
      verifyPrivilege.rejects(new TypeError('not a Privilege'));

      const res = await supertest(app).get('/v2/guarded/myapp');

      expect(res.status).to.equal(500);
      expect(res.body.error.code).to.equal('INTERNAL');
    });
  });

  describe('the error code is the contract', () => {
    const routerModule = require('../../ZelBack/src/routesV2');

    it('maps every code to a status in its own class', () => {
      const map = routerModule.CODE_TO_STATUS;
      expect(map.NOT_FOUND).to.equal(404);
      expect(map.UNAUTHORIZED).to.equal(401);
      expect(map.CONFLICT).to.equal(409);
      expect(map.INTERNAL).to.equal(500);
      Object.entries(map).forEach(([code, status]) => {
        expect(status, `${code} is not a 4xx or 5xx`).to.be.within(400, 599);
      });
    });

    it('is frozen, so a caller cannot add a code to it', () => {
      expect(Object.isFrozen(routerModule.CODE_TO_STATUS)).to.be.true;
    });
  });
});
