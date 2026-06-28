const express = require('express');
const serviceHelper = require('../services/serviceHelper');

/**
 * API body-parsing middleware, gated by an allowlist of migrated routes.
 *
 * --- Why this exists ---
 * Half the POST handlers historically parsed the body themselves by listening
 * on the raw request stream (req.on('data') + ensureObject), instead of reading
 * the middleware-parsed req.body. That pattern is fragile (it hangs if a body
 * parser ran first and already drained the stream) and is what we are removing.
 * This middleware is the gate that lets us migrate those handlers one at a time
 * rather than in one risky all-at-once sweep.
 *
 * --- How it works ---
 * It sits in the global middleware slot (replacing the bare express.json) and
 * branches on a single question: is req.path in MIGRATED_ROUTES?
 *   - NOT migrated  -> plain express.json(), i.e. exactly today's behaviour, so
 *                      every un-touched handler keeps working unchanged.
 *   - migrated      -> capture the raw body and set req.body = ensureObject(raw);
 *                      the handler then reads req.body and owns no stream logic.
 * Migrating a handler = change it to read req.body + add its route here.
 *
 * --- Why ensureObject and not express.json/urlencoded by content-type ---
 * The current frontend posts JSON.stringify(body) with no explicit content-type,
 * which axios labels application/x-www-form-urlencoded. Trusting that header and
 * running express.urlencoded would qs-parse the JSON string into garbage, and
 * qs.parse never throws, so a "trust the header, fall back on error" scheme would
 * never reach the fallback. ensureObject's JSON-first / urlencoded-fallback order
 * is correct in every case (JSON.parse throws cleanly on a real form), so it
 * reproduces the legacy parse and stays transparent to the current frontend with
 * no frontend change required.
 *
 * --- Multipart ---
 * multipart/form-data bodies are deliberately left untouched (the stream is not
 * read here) so the content-blob file parser on the submission handlers can read
 * the blob parts directly.
 *
 * --- Future / removal path (this is a transitional shim) ---
 * 1. Build the content-blob multipart branch on the submission handlers.
 * 2. Fix the frontend to send a proper application/json content-type.
 * 3. Once a route's clients send correct content-types, drop that route from the
 *    ensureObject path to plain express.json.
 * 4. Migrate the remaining legacy req.on('data') handlers the same way, adding
 *    each route to MIGRATED_ROUTES.
 * 5. When the allowlist covers every POST route, delete the gate and make
 *    express.json({ type }) + express.urlencoded unconditional (the clean end
 *    state). Nothing here is meant to be permanent.
 */

// Routes whose handlers read req.body (migrated off the raw-stream listener).
const MIGRATED_ROUTES = new Set([
  '/apps/appregister',
  '/apps/appupdate',
  '/apps/verifyappregistrationspecifications',
  '/apps/verifyappupdatespecifications',
  '/apps/bloblocator',
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
