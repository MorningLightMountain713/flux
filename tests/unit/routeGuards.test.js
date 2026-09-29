// The guards that run before a route's response cache.
//
// The cache keys on the full request URL, so the guard's job is to stop a
// parameter the handler never reads from becoming part of that key. These
// assert through a real express stack with the real cache middleware behind
// them, because the ordering - guard first, cache second - is the whole point
// and a direct call to the guard cannot show it.

const { expect } = require('chai');
const express = require('express');
const request = require('supertest');
const apicache = require('apicache');

const {
  answerDaemonUnavailable,
  asyncRoute,
  isDaemonUnavailable,
  rejectQueryParameters,
} = require('../../ZelBack/src/services/utils/routeGuards');

describe('routeGuards', () => {
  describe('rejectQueryParameters', () => {
    let app;
    let server;
    let handlerCalls;

    // apicache's store and its expiry timers are module-global, so this suite
    // both starts clean and leaves nothing behind for whatever runs next
    beforeEach(() => {
      apicache.clear();
      handlerCalls = 0;
      app = express();
      app.get(
        '/answer',
        rejectQueryParameters,
        apicache.middleware('30 seconds', (req, res) => res.statusCode === 200),
        (req, res) => {
          handlerCalls += 1;
          res.json({ status: 'success', data: { answer: 42 } });
        },
      );
    });

    afterEach(() => {
      apicache.clear();
      if (server) { server.close(); server = null; }
    });

    // One server for the test, rather than one per request. supertest binds a
    // fresh ephemeral server on every request(app) call, and a test making
    // several of them opens several - which under a full-suite load produced a
    // transient 'Parse Error: Expected HTTP/' from a socket that was not the
    // one being spoken to. The lifetime is explicit here instead.
    const get = (path) => {
      if (!server) server = app.listen(0);
      return request(server).get(path);
    };

    it('answers a request that carries no query string', async () => {
      const res = await get('/answer');
      expect(res.status).to.equal(200);
      expect(res.body.data.answer).to.equal(42);
      expect(handlerCalls).to.equal(1);
    });

    it('refuses a query parameter the endpoint does not read', async () => {
      const res = await get('/answer?x=1');
      expect(res.status).to.equal(400);
      expect(res.body.status).to.equal('error');
      expect(res.body.data.message).to.equal('This endpoint takes no query parameters');
    });

    it('refuses a parameter with no value, and one repeated', async () => {
      expect((await get('/answer?x')).status).to.equal(400);
      expect((await get('/answer?x=1&x=2')).status).to.equal(400);
    });

    // express resolves '?=1' to an empty query object, so a guard reading
    // req.query waves it through - while the cache still files it under a key
    // of its own. The decision has to be made on the raw url.
    it('refuses a query string that parses to nothing but still varies the url', async () => {
      expect((await get('/answer?=1')).status).to.equal(400);
      expect((await get('/answer?&&')).status).to.equal(400);
    });

    it('answers a bare question mark, which carries no parameter', async () => {
      const res = await get('/answer?');
      expect(res.status).to.equal(200);
    });

    it('never lets a refused request reach the handler', async () => {
      await get('/answer?x=1');
      await get('/answer?y=2');
      expect(handlerCalls).to.equal(0);
    });

    // the defect this exists for: without the guard each novel query string is
    // a distinct cache key, so it both recomputes the answer and retains
    // another copy of it for the cache window
    it('keeps the cache to one entry however many parameters are tried', async () => {
      await get('/answer');
      await get('/answer?x=1');
      await get('/answer?x=2');
      await get('/answer?x=3');
      await get('/answer');

      expect(handlerCalls).to.equal(1);
      // scoped to this route: the index is module-global, so asserting on its
      // whole contents would make this test hostage to anything else cached
      const mine = apicache.getIndex().all.filter((key) => key.includes('/answer'));
      expect(mine).to.have.lengthOf(1);
    });
  });

  describe('isDaemonUnavailable', () => {
    it('is true while the daemon loads its block index', () => {
      expect(isDaemonUnavailable({ code: -28, message: 'Loading block index...' })).to.equal(true);
    });

    it('is true when nothing answers on the daemon port', () => {
      ['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT'].forEach((code) => {
        expect(isDaemonUnavailable({ code }), code).to.equal(true);
      });
    });

    it('is false for an answer the daemon gave', () => {
      expect(isDaemonUnavailable({ code: -5, message: 'No information available about transaction' })).to.equal(false);
      expect(isDaemonUnavailable(new Error('Unrecognised Flux Node tier'))).to.equal(false);
      expect(isDaemonUnavailable(undefined)).to.equal(false);
    });
  });

  describe('answerDaemonUnavailable', () => {
    let app;
    let server;
    let daemonError;
    let handlerCalls;

    // A handler that asks the daemon and reports what it raised, the way
    // getNodeTier does, through a real express stack so the status, the header
    // and the body are what a caller receives.
    beforeEach(() => {
      handlerCalls = 0;
      app = express();
      app.get('/flux/nodetier', (req, res) => {
        if (answerDaemonUnavailable(res, daemonError)) return;
        handlerCalls += 1;
        res.json({
          status: 'error',
          data: { code: daemonError.code, name: daemonError.name, message: daemonError.message },
        });
      });
    });

    afterEach(() => {
      if (server) { server.close(); server = null; }
    });

    const get = (path) => {
      if (!server) server = app.listen(0);
      return request(server).get(path);
    };

    const raised = (message, code) => Object.assign(new Error(message), { code });

    it('refuses while the daemon is still loading', async () => {
      daemonError = raised('Loading block index...', -28);
      const res = await get('/flux/nodetier');
      expect(res.status).to.equal(503);
      expect(res.body).to.deep.equal({
        status: 'error',
        data: { code: 503, name: 'ServiceUnavailable', message: 'Loading block index...' },
      });
      expect(handlerCalls).to.equal(0);
    });

    it('says when to come back', async () => {
      daemonError = raised('Loading block index...', -28);
      const res = await get('/flux/nodetier');
      expect(res.headers['retry-after']).to.equal('5');
    });

    it('refuses while nothing is listening on the daemon port', async () => {
      daemonError = raised('connect ECONNREFUSED 127.0.0.1:16124', 'ECONNREFUSED');
      const res = await get('/flux/nodetier');
      expect(res.status).to.equal(503);
      expect(res.body.data.name).to.equal('ServiceUnavailable');
      expect(res.headers['retry-after']).to.equal('5');
      expect(handlerCalls).to.equal(0);
    });

    // A daemon that answered with an error of its own gave a verdict: the
    // handler reports it, as it does any error that is not the daemon's absence.
    it('leaves a daemon error that is an answer to the handler', async () => {
      daemonError = raised('Invalid parameter', -8);
      const res = await get('/flux/nodetier');
      expect(res.status).to.equal(200);
      expect(res.body).to.deep.equal({
        status: 'error',
        data: { code: -8, name: 'Error', message: 'Invalid parameter' },
      });
      expect(handlerCalls).to.equal(1);
    });

    it('leaves an error with no code to the handler', async () => {
      daemonError = new Error('Unrecognised Flux node tier');
      const res = await get('/flux/nodetier');
      expect(res.status).to.equal(200);
      expect(res.body.data.message).to.equal('Unrecognised Flux node tier');
      expect(handlerCalls).to.equal(1);
    });
  });
  // Every route is registered through this. A handler that rejects must reach
  // express, because the alternative is not a 500 - it is an unhandled
  // rejection, apiServer's uncaughtException handler, and process.exit.
  describe('asyncRoute', () => {
    it('hands a rejection to express rather than dropping it', async () => {
      const boom = new Error('handler-exploded');
      let forwarded;

      await asyncRoute(async () => { throw boom; })({}, {}, (err) => { forwarded = err; });

      expect(forwarded).to.equal(boom);
    });

    it('answers 500, so the caller is told rather than left waiting', async () => {
      const app = express();
      app.get('/boom', asyncRoute(async () => { throw new Error('handler-exploded'); }));

      const res = await request(app).get('/boom');

      expect(res.status).to.equal(500);
    });

    it('leaves a handler that resolves exactly as it was', async () => {
      const app = express();
      app.get('/fine', asyncRoute(async (req, res) => res.status(200).json({ ok: true })));

      const res = await request(app).get('/fine');

      expect(res.status).to.equal(200);
      expect(res.body).to.deep.equal({ ok: true });
    });
  });
});
