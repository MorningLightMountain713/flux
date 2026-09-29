'use strict';

// Guards that answer a request before it reaches a handler.

const apicache = require('apicache');

const messageHelper = require('../messageHelper');

/**
 * Refuse a query string on an endpoint that reads none.
 *
 * The cache keys on the full request URL, so anything a caller puts in the query
 * string becomes part of the key whether or not the handler reads it. On an
 * endpoint that reads none, that turns the cache from a bound on the work into a
 * way of multiplying it: every novel parameter is a guaranteed miss that
 * recomputes the answer and retains another copy of it for the cache window.
 *
 * This runs BEFORE the cache middleware, so a refused request never reaches the
 * store.
 *
 * Decided on the RAW url, not on req.query, because the raw url is what the
 * cache keys on and parsing does not preserve it: express resolves '?=1' to an
 * empty query object, so a guard reading req.query waves it through while the
 * cache still files it under a key of its own. Anything that can vary the key
 * has to be answered here, whether or not it survives parsing.
 *
 * A trailing '?' with nothing after it carries no parameter and is allowed.
 *
 * Rejecting rather than ignoring is the point. A caller sending parameters an
 * endpoint does not accept has made a mistake, and quietly serving them an
 * answer hides it - while still costing a cache entry apiece.
 * @param {import('express').Request} req Request
 * @param {import('express').Response} res Response
 * @param {Function} next Next handler
 * @returns {*} next(), or a 400
 */
function rejectQueryParameters(req, res, next) {
  const url = req.originalUrl ?? req.url ?? '';
  const queryStart = url.indexOf('?');
  if (queryStart === -1 || queryStart === url.length - 1) return next();
  const errMessage = messageHelper.createErrorMessage(
    'This endpoint takes no query parameters',
    'BadRequest',
    400,
  );
  return res.status(400).json(errMessage);
}

/**
 * Hand a route handler's promise to express.
 *
 * Registering `(req, res) => handler(req, res)` drops it, so a rejection is
 * unhandled: node raises it to the uncaughtException handler in apiServer,
 * which exits the process. The caller gets no response at all, and the node
 * restarts - once per request. Routed through here a rejection reaches
 * express's error handler and answers 500, which is what a caller can act on
 * and what leaves the node serving everyone else.
 * @param {Function} handler Route handler taking (req, res)
 * @returns {Function} express handler
 */
function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
}

// A cached response is served to everyone who asks next, so the store must hold
// only answers this node would give again. Express's own failures are kept out
// by status: an allowlist rather than a blocklist, so a status nobody predicted
// is excluded rather than stored until someone notices, and a route that ever
// wants a 201 or a redirect cached names it here deliberately.
apicache.options({ statusCodes: { include: [200], exclude: [] } });

/**
 * Whether the answer just given is one worth remembering.
 *
 * apicache evaluates this when the response ends - and on a hit, before the
 * handler runs, where nothing has been recorded and the stored answer is served.
 * @param {object} _req Request, unused
 * @param {import('express').Response} res Response
 * @returns {boolean} false if the handler reported a failure
 */
function answeredWithoutFailure(_req, res) {
  return res.locals.payloadStatus !== 'error';
}

/**
 * apicache's middleware, refusing to remember an answer that reported a failure.
 *
 * The status rule above cannot see these. A handler in this tree reports an
 * error by answering 200 and putting `status: 'error'` in the body, so as far as
 * express and apicache are concerned it succeeded. /benchmark/getstoredbenchmark
 * is what that costs: it answers "No stored benchmark data available" for as
 * long as a booting node has not benchmarked yet, and it caches for an hour, so
 * the node goes on saying it for an hour after the benchmark has landed.
 *
 * The payload is recorded as the handler answers it, because that is the only
 * point at which it exists - by the time apicache asks, the body is a buffer it
 * is accumulating.
 *
 * Refusing failures rather than admitting successes, which is the opposite of
 * the status rule and deliberate: a cached route may answer a payload this node
 * did not build - the syncthing routes proxy syncthing's own - and those carry
 * no status field at all, so an allowlist would stop caching them.
 * @param {string} duration apicache duration, e.g. '30 seconds'
 * @returns {Function} express middleware
 */
function cache(duration) {
  const remember = apicache.middleware(duration, answeredWithoutFailure);

  // Named for what the route table shows: routeWiring.test.js finds the store in
  // a chain by this name when it checks that a guard runs ahead of it.
  return function cache(req, res, next) {
    const { json } = res;
    res.json = function recordThenAnswer(payload) {
      res.locals.payloadStatus = (payload && typeof payload === 'object') ? payload.status : undefined;
      return json.call(this, payload);
    };
    return remember(req, res, next);
  };
}

module.exports = {
  asyncRoute, cache, rejectQueryParameters,
};
