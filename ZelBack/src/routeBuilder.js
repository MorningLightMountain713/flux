'use strict';

const path = require('node:path');

const { load } = require('./lib/moduleLoader');
const capabilities = require('./services/utils/capabilities');
const { asyncRoute, cache, rejectQueryParameters } = require('./services/utils/routeGuards');
const { alwaysRespond, isLocal, requireHttps } = require('./middlewares');

/**
 * Registers a route table on an express app or router.
 *
 * A route is data: its method and path, the capabilities it reads, its guards,
 * its cache and its handler, named as `<module under services/>#<function>`.
 * Each route is registered as guards, then the capability gate, then the cache,
 * then the handler, and a handler's module is loaded the first time the route is
 * called, so registering the table loads no service.
 *
 * A route declares `needs` (the capabilities it reads) or `none` (why it reads
 * none). The gate refuses while any capability in `needs` is down: 503 with
 * `Retry-After` and `Cache-Control: no-store`, naming the capability, in the
 * surface's own envelope. It runs ahead of the cache, so a refusal is never
 * stored and a stored answer is never served while the route is down.
 */

const SERVICES_DIR = path.join(__dirname, 'services');

const GUARDS = Object.freeze({
  alwaysRespond, isLocal, requireHttps, rejectQueryParameters,
});

// What a caller refused for a capability is told, and how long it is told to
// wait. The wait paces a client's polling; the capability's owner decides when
// it rises.
const REFUSALS = Object.freeze({
  bootReconcileDecided: { message: 'Node is still reconciling its applications after boot', retryAfterSeconds: 15 },
  policyVerified: { message: 'Node has not yet obtained the network policy', retryAfterSeconds: 30 },
  policyCurrent: { message: 'Node has not yet obtained the network policy', retryAfterSeconds: 30 },
  daemonReachable: { message: 'The Flux daemon is not reachable', retryAfterSeconds: 15 },
  explorerSynced: { message: 'Node is still scanning the chain', retryAfterSeconds: 30 },
  chainStateConsistent: { message: 'Node is rebuilding its chain state', retryAfterSeconds: 15 },
  appRegistryConsistent: { message: 'Node is still building the app registry', retryAfterSeconds: 30 },
  appStateSynced: { message: 'Node is still syncing app locations', retryAfterSeconds: 30 },
  nodeListPopulated: { message: 'Node has not yet read the node list', retryAfterSeconds: 15 },
});

const DEFAULT_RETRY_AFTER_SECONDS = 15;

/**
 * What to tell a caller refused because `capability` is down.
 * @param {string} capability
 * @returns {{message: string, retryAfterSeconds: number}}
 */
function refusalFor(capability) {
  const known = REFUSALS[capability];
  return {
    message: `${known ? known.message : 'Node is not ready'} (${capability} is not up)`,
    retryAfterSeconds: known ? known.retryAfterSeconds : DEFAULT_RETRY_AFTER_SECONDS,
  };
}

/**
 * The gate for a set of capabilities.
 * @param {string[]} needs
 * @param {function(import('express').Response, {capability: string, message: string}): *} refuse
 *   answers the refusal in the surface's envelope
 * @returns {Function} express middleware
 */
function capabilityGate(needs, refuse) {
  return function capabilityGateMiddleware(req, res, next) {
    const down = capabilities.firstNotUp(needs);
    if (!down) return next();
    const { message, retryAfterSeconds } = refusalFor(down);
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.setHeader('Cache-Control', 'no-store');
    return refuse(res, { capability: down, message });
  };
}

/**
 * The handler a route names, loaded on its first call. The module is kept and
 * the function read from it on every call, so a module's own exports are what
 * answers.
 * @param {string} ref `<module under baseDir>#<function>`
 * @param {string} [baseDir] the directory handler modules are named from
 * @returns {function(import('express').Request, import('express').Response): *}
 */
function handlerFor(ref, baseDir = SERVICES_DIR) {
  const [modulePath, fn] = ref.split('#');
  return function routeHandler(req, res) {
    return load(modulePath, baseDir)[fn](req, res);
  };
}

/**
 * The middleware chain a route registers, in order.
 * @param {object} route a route table entry
 * @param {{refuse: Function, baseDir?: string, guards?: object}} surface the
 *   surface's refusal, where its handler modules live, and the guards it adds to
 *   the shared ones
 * @returns {Function[]}
 */
function chainFor(route, { refuse, baseDir, guards = {} }) {
  const chain = (route.guards || []).map((name) => {
    const guard = guards[name] || GUARDS[name];
    if (!guard) throw new Error(`route ${route.method.toUpperCase()} ${route.path} names unknown guard ${name}`);
    return guard;
  });
  if (route.needs) chain.push(capabilityGate(route.needs, refuse));
  if (route.cache) chain.push(cache(route.cache));
  chain.push(asyncRoute(handlerFor(route.handler, baseDir)));
  return chain;
}

/**
 * Registers every route of a table.
 * @param {object} app express app or router
 * @param {object[]} table
 * @param {{refuse: Function, baseDir?: string}} surface
 */
function registerRoutes(app, table, surface) {
  table.forEach((route) => {
    app[route.method](route.path, ...chainFor(route, surface));
  });
}

module.exports = {
  capabilityGate,
  chainFor,
  handlerFor,
  refusalFor,
  registerRoutes,
  SERVICES_DIR,
};
