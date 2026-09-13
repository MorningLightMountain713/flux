'use strict';

const crypto = require('node:crypto');
const express = require('express');
const log = require('./lib/log');
const { Privilege, authOf } = require('./services/utils/privileges');
const verificationHelper = require('./services/verificationHelper');
const operationsController = require('./services/appManagement/operationsController');

/**
 * The /v2 HTTP surface.
 *
 * v1 IS FROZEN. It keeps its shape for as long as it serves clients, which is
 * why this is a second surface rather than a change to the first: real status
 * codes, one envelope, auth as middleware, and no mutating GETs. Both are
 * skins over the same business functions - a v2 route calls the bare action,
 * never a v1 `*Api` handler and never an HTTP hop to v1.
 *
 * EXPRESS 5 COMPATIBILITY IS A ROUTING RULE, NOT A DEPENDENCY. This tree is on
 * express 4, whose path parser is not express 5's, so every path here is
 * written in the subset both accept:
 *
 *   - REQUIRED path params only. Express 4's `/x/:id?` is invalid in express 5,
 *     and express 5's `/x{/:id}` REGISTERS WITHOUT THROWING on express 4 and
 *     then matches nothing - a silently dead route. A route that wants an
 *     optional operand takes it from the query string or the body.
 *   - No bare `*`. Express 5 requires a named wildcard (`/*path`).
 *   - No inline regex params.
 *
 * That is also the style guide's own rule ("no optional path params that
 * silently coalesce"), so a v2 route written correctly is express-5-safe by
 * construction. The guard in tests/unit/routesV2.test.js is what keeps it so.
 *
 * NO apicache. v1's response cache keys on the full request URL with no size
 * limit; a v2 route declares its own cache and key function or has none.
 */

const router = express.Router();

const BODY_LIMIT = '25mb';

/**
 * A machine-readable error code is the contract; the HTTP status is derived
 * from it so the two can never disagree. v1 answered 200 with an error in the
 * body - that is not carried forward.
 */
const CODE_TO_STATUS = Object.freeze({
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  NOT_IMPLEMENTED: 501,
  UPSTREAM: 502,
  UNAVAILABLE: 503,
});

/**
 * The envelope, attached once per request.
 *
 * `data` and `error` are mutually exclusive, and `meta.requestId` is on every
 * answer so a caller can quote one line of their log and have it found.
 */
function envelope(req, res, next) {
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();
  res.set('X-Request-Id', requestId);

  const idempotencyKey = req.headers['idempotency-key'] || null;
  req.idempotencyKey = idempotencyKey;

  const meta = (extra) => ({ requestId, ...(extra || {}) });

  res.ok = (data, extra) => res.status(200).json({ data, meta: meta(extra) });
  res.created = (data, location) => {
    if (location) res.set('Location', location);
    return res.status(201).json({ data, meta: meta() });
  };
  res.accepted = (operationId) => {
    const statusUrl = `/v2/operations/${operationId}`;
    res.set('Location', statusUrl);
    return res.status(202).json({
      data: { operationId, state: 'pending', statusUrl },
      meta: meta(),
    });
  };
  res.noContent = () => res.status(204).end();
  res.fail = (code, message, extra) => res.status(CODE_TO_STATUS[code] || 500).json({
    error: {
      code, message, ...(extra || {}),
    },
    meta: meta(),
  });
  return next();
}
// BEFORE the body parser, so a request whose body cannot be parsed is still
// answered in this envelope. Attached the other way round, a malformed body
// reaches the error handler with no res.fail on it and can only be a bare 500.
router.use(envelope);

// This surface owns its body parsing. The global gate in lib/bodyParser.js
// exempts /v2 precisely so that this is the only parser that runs here, which
// is what keeps a raw-stream route from fighting a parser that already drained
// it. A route needing raw bytes mounts express.raw() on its own sub-router.
router.use(express.json({ limit: BODY_LIMIT }));

/**
 * Auth as middleware rather than the first ten lines of every handler.
 *
 * It wraps the SAME verificationHelper.verifyPrivilege v1 calls, so zelidauth
 * and tier semantics are identical - this changes where the check lives, not
 * what it decides. It takes the header value, not the request: verifyPrivilege
 * throws a TypeError on a request object, deliberately, so a wiring mistake
 * cannot arrive wearing the face of a failed check.
 *
 * @param {string} privilege one of Privilege
 * @param {function(import('express').Request): object} [options] app scoping
 */
function requireTier(privilege, options = () => ({})) {
  return async (req, res, next) => {
    try {
      const authorized = await verificationHelper.verifyPrivilege(privilege, authOf(req), options(req));
      if (!authorized) return res.fail('UNAUTHORIZED', 'insufficient privilege');
      return next();
    } catch (error) {
      log.error(`routesV2 requireTier: ${error.message}`);
      return res.fail('INTERNAL', 'privilege check failed');
    }
  };
}

/**
 * Wrap an async handler so a rejection becomes an answer rather than an
 * unhandled rejection and a connection that never closes. Express 4 does not
 * await a handler's promise; express 5 does, and this is correct under both.
 */
const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/**
 * THE status resource every long-running v2 operation points at.
 *
 * Reads the operation through the same pure function v1's
 * /apps/operations/:jobId reads it through, and formats it in this envelope.
 * Neither surface owns the operation; both are skins.
 *
 * A running operation is 200 with a non-terminal state. Completion is read from
 * the body, never inferred from the status code - a failed operation is still
 * a successful poll.
 */
router.get('/operations/:id', route(async (req, res) => {
  const sinceRaw = req.query.since;
  const since = sinceRaw === undefined ? null : Number(sinceRaw);
  if (since !== null && !Number.isFinite(since)) {
    return res.fail('BAD_REQUEST', 'since must be a number');
  }

  const view = await operationsController.readOperation({
    jobId: req.params.id,
    callerId: await operationsController.callerFluxId(req),
    sinceSeq: since,
  });

  // Unknown, expired and not-yours are ONE answer: a caller must not be able to
  // learn from a 403 that someone else has an operation running.
  if (!view) return res.fail('NOT_FOUND', 'operation not found');

  return res.ok(view);
}));

// A terminating 404, so an unmatched /v2 path is answered HERE rather than
// falling through to the frozen v1 routes. Without it a typo in a v2 path could
// reach a v1 handler and answer in the wrong envelope.
router.use((req, res) => res.fail('NOT_FOUND', 'unknown v2 endpoint'));

// The surface's own error handler. Four arguments, which is how express knows
// what it is - three would register it as one more route.
// eslint-disable-next-line no-unused-vars
router.use((error, req, res, next) => {
  log.error(`routesV2 ${req.method} ${req.path}: ${error.message}`);
  if (res.headersSent) return res.end();
  // The envelope is the first middleware on this surface, so res.fail is
  // normally attached by now. Guarded anyway: a failure ahead of it has no way
  // to answer in the envelope, and a bare 500 beats a second throw in here.
  if (typeof res.fail !== 'function') return res.status(500).end();
  if (error.type === 'entity.too.large') return res.fail('UNPROCESSABLE', 'request body too large');
  if (error.type === 'entity.parse.failed') return res.fail('BAD_REQUEST', 'request body is not valid JSON');
  return res.fail('INTERNAL', 'unexpected error');
});

module.exports = router;
module.exports.CODE_TO_STATUS = CODE_TO_STATUS;
module.exports.requireTier = requireTier;
module.exports.Privilege = Privilege;
// Exported so a test can mount the surface's pieces without reaching into the
// router's middleware stack by index, which changes whenever the order does.
module.exports.envelope = envelope;
