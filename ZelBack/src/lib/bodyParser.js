const express = require('express');
const serviceHelper = require('../services/serviceHelper');

/**
 * API body-parsing middleware, gated by an allowlist of migrated routes.
 *
 * Legacy POST handlers read the raw request stream themselves
 * (req.on('data')) and run the accumulated body through ensureObject. As each
 * handler is migrated to read the middleware-parsed req.body, its route is
 * added to MIGRATED_ROUTES; every other route keeps today's behaviour (plain
 * express.json) untouched.
 *
 * TRANSITIONAL: the migrated routes reproduce the legacy ensureObject parse
 * (JSON first, urlencoded fallback) rather than committing to a single
 * express parser by content-type. The current frontend posts a JSON.stringify
 * body with no explicit content-type, which axios labels urlencoded — so
 * trusting the content-type and running express.urlencoded would qs-parse the
 * JSON string into garbage (qs.parse never throws). JSON-first/qs-fallback is
 * correct in every case. Once clients send a proper application/json
 * content-type, a migrated route can drop to plain express.json and, when the
 * allowlist covers every POST route, this gate can be removed entirely.
 */

// Routes whose handlers read req.body (migrated off the raw-stream listener).
const MIGRATED_ROUTES = new Set([
  '/apps/appregister',
  '/apps/appupdate',
  '/apps/verifyappregistrationspecifications',
  '/apps/verifyappupdatespecifications',
]);

// App specs can carry a large transport-encrypted base64 payload, and the
// legacy raw-stream path imposed no size limit — so the migrated parser uses a
// generous cap rather than express's 100kb default.
const BODY_LIMIT = '25mb';

// Capture the raw body as text for any content-type EXCEPT multipart, which is
// left untouched so the in-handler file parser can read the stream.
function migratedRawType(req) {
  const contentType = (req.headers['content-type'] || '').toLowerCase();
  return !contentType.startsWith('multipart/form-data');
}

const legacyJson = express.json();
const migratedRaw = express.text({ type: migratedRawType, limit: BODY_LIMIT });

// Reproduce the legacy ensureObject parse: JSON first, urlencoded fallback.
function ensureBodyObject(req, res, next) {
  if (typeof req.body === 'string') {
    req.body = serviceHelper.ensureObject(req.body);
  }
  next();
}

/**
 * Global body-parser dispatcher. Migrated routes capture the raw body and
 * ensureObject it; everything else keeps the legacy json-only behaviour.
 */
function bodyParser(req, res, next) {
  if (!MIGRATED_ROUTES.has(req.path)) {
    legacyJson(req, res, next);
    return;
  }
  migratedRaw(req, res, (err) => {
    if (err) {
      next(err);
      return;
    }
    ensureBodyObject(req, res, next);
  });
}

module.exports = { bodyParser, MIGRATED_ROUTES };
