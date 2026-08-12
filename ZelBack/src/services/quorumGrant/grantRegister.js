'use strict';

const config = require('config');
const dbHelper = require('../dbHelper');
const core = require('./grantRegisterCore');
const log = require('../../lib/log');

// The durable half of the grantor: one document per resource key, every
// decision journaled BEFORE the reply leaves. A promise that out-lived the
// reply but not the crash is how a quorum lies (QJM's fsync rule; the NATS
// 2025 analysis is the cautionary tale), so the write concern is journaled
// and the reply is sequenced strictly after the write returns.
//
// Restart discipline: for one maximum TTL after process start this grantor
// refuses to serve, with a retry hint. Promises survive crashes (they were
// journaled), but a register restored from backup or wiped cannot be told
// apart from one that never existed — waiting out the longest possible term
// makes every promise it might have forgotten expire before it can
// contradict one (§5's rejoin drain; Quorum Leases §3.7). The same wait
// makes restart-time expiry arithmetic boring: any term accepted before the
// restart has lapsed by the time serving resumes.
//
// Time here is the grantor's own wall clock, compared only against itself:
// terms must survive restart, and a monotonic reading does not. Nothing here
// ever compares another machine's timestamp to this clock — holders count
// their own safety from their own send times.

const collection = () => config.database.local.collections.quorumGrants;

function db() {
  const connection = dbHelper.databaseConnection();
  return connection ? connection.db(config.database.local.database) : null;
}

function tunables() {
  return {
    lockDelayMs: config.fluxapps.quorumGrantLockDelayMs ?? 30_000,
    maxTtlMs: config.fluxapps.quorumGrantMaxTtlMs ?? 300_000,
    drainMs: config.fluxapps.quorumGrantDrainMs
      ?? config.fluxapps.quorumGrantMaxTtlMs
      ?? 300_000,
  };
}

// Journaled: the driver returns only after the write reaches the journal.
const DURABLE = { writeConcern: { w: 1, j: true } };

let startedMs = process.hrtime.bigint() / 1_000_000n;

function monotonicMs() {
  return process.hrtime.bigint() / 1_000_000n;
}

/**
 * How much of the rejoin drain remains. 0 when this grantor may serve.
 * @returns {number}
 */
function drainRemainingMs() {
  const elapsed = Number(monotonicMs() - startedMs);
  return Math.max(0, tunables().drainMs - elapsed);
}

// One in-flight operation per key. Two interleaved read-modify-write passes
// over the same document would let the later read overwrite the earlier
// write — a promise silently un-made. The chain serializes per key and never
// rejects: each link swallows its predecessor's error (the predecessor's
// caller got it) and runs regardless.
const inFlight = new Map();

async function runAfter(previous, operation) {
  try {
    await previous;
  } catch {
    // the predecessor's failure was already answered to ITS caller;
    // this link runs regardless
  }
  return operation();
}

async function pruneAfter(key, run) {
  try {
    await run;
  } catch {
    // the run's rejection belongs to the caller awaiting it, not to cleanup
  } finally {
    if (inFlight.get(key) === run) inFlight.delete(key);
  }
}

function serialized(key, operation) {
  // Stays synchronous through the set() below on purpose: an await before
  // the new tail is registered would let two same-tick callers read the same
  // predecessor and run concurrently — the exact race being serialized away.
  const run = runAfter(inFlight.get(key) ?? Promise.resolve(), operation);
  inFlight.set(key, run);
  pruneAfter(key, run);
  return run;
}

/**
 * Load, decide, journal, and only then reply.
 *
 * @param {string} key resource key
 * @param {(record: object|null, nowMs: number, knobs: object) => {reply: object, record: object|null}} decide
 * @returns {Promise<object>} the core's reply, or a fail-closed refusal
 */
async function transact(key, decide) {
  const drainMs = drainRemainingMs();
  if (drainMs > 0) {
    return {
      ok: false, code: 'draining', retryAfterMs: drainMs, promisedEpoch: 0, accepted: null,
    };
  }

  const database = db();
  if (!database) {
    return {
      ok: false, code: 'unavailable', promisedEpoch: 0, accepted: null,
    };
  }

  return serialized(key, async () => {
    const knobs = tunables();
    const stored = await dbHelper.findOneInDatabase(database, collection(), { _id: key });
    const outcome = decide(stored, Date.now(), knobs);

    if (outcome.record) {
      await dbHelper.findOneAndUpdateInDatabase(
        database,
        collection(),
        { _id: key },
        {
          $set: {
            promisedEpoch: outcome.record.promisedEpoch,
            accepted: outcome.record.accepted ?? null,
            updatedAt: Date.now(),
          },
        },
        { upsert: true, ...DURABLE },
      );
    }

    return outcome.reply;
  }).catch((error) => {
    // A grantor that cannot persist must not answer as if it had: the reply
    // that matters is the one the journal would have remembered.
    log.error(`quorumGrant grantRegister ${key}: ${error.message}`);
    return {
      ok: false, code: 'unavailable', promisedEpoch: 0, accepted: null,
    };
  });
}

function badTtl(ttlMs, knobs) {
  return !Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > knobs.maxTtlMs;
}

/** Pre-vote: answers, changes nothing, and is served even without quorum intent. */
async function probe(key, request) {
  return transact(key, (record, nowMs, knobs) => (
    { reply: core.onProbe(record, request, nowMs, knobs), record: null }
  ));
}

async function prepare(key, request) {
  return transact(key, (record, nowMs, knobs) => core.onPrepare(record, request, nowMs, knobs));
}

async function accept(key, request) {
  return transact(key, (record, nowMs, knobs) => {
    if (request.mode === 'held' && badTtl(request.ttlMs, knobs)) {
      return {
        reply: {
          ok: false, code: 'bad_ttl', maxTtlMs: knobs.maxTtlMs, promisedEpoch: record?.promisedEpoch ?? 0, accepted: record?.accepted ?? null,
        },
        record: null,
      };
    }
    return core.onAccept(record, request, nowMs, knobs);
  });
}

async function renew(key, request) {
  return transact(key, (record, nowMs, knobs) => {
    if (badTtl(request.ttlMs, knobs)) {
      return {
        reply: {
          ok: false, code: 'bad_ttl', maxTtlMs: knobs.maxTtlMs, promisedEpoch: record?.promisedEpoch ?? 0, accepted: record?.accepted ?? null,
        },
        record: null,
      };
    }
    return core.onRenew(record, request, nowMs);
  });
}

async function release(key, request) {
  return transact(key, (record, nowMs) => core.onRelease(record, request, nowMs));
}

/**
 * The recorded state for a key, read-only — what the published record and
 * catch-up paths consume. Served during the drain: reading what the journal
 * holds contradicts nothing.
 */
async function read(key) {
  const database = db();
  if (!database) return null;
  return dbHelper.findOneInDatabase(database, collection(), { _id: key });
}

/** Test seam: restart the drain clock as if the process just started. */
function resetForTests(options = {}) {
  startedMs = options.startedMs ?? monotonicMs();
  inFlight.clear();
}

module.exports = {
  drainRemainingMs,
  probe,
  prepare,
  accept,
  renew,
  release,
  read,
  resetForTests,
};
