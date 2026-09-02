'use strict';

const config = require('config');

const dbHelper = require('../dbHelper');
const log = require('../../lib/log');
const networkStateService = require('../networkStateService');
const verificationHelper = require('../verificationHelper');
const downCertificates = require('../quorumGrant/downCertificates');
const { APP_STATE_EVENT_TYPES } = require('./messageStore');
const { globalAppStateEvents, CLOCK_SKEW_ALLOWANCE_MS } = require('../utils/appConstants');
const {
  verifyCertificate,
  quarantineFromExpiries,
  RECORD_LIFETIME_MS,
  VERDICT_LIFETIME_BLOCKS,
  FUTURE_BLOCKS_TOLERANCE,
} = require('../utils/nodeDownCertificates');
const { normalizeSocketAddress } = require('../utils/socketAddressUtils');

// The nodedown record store: one row PER CERTIFICATION, keyed on the
// certificate — never a constant dedupKey, or re-certification overwrites
// the one row and the flap-quarantine count has nothing to count.
// Verification runs at EVERY intake, gossip and sync alike, and an invalid
// certificate is never stored and never relayed — a forgery dies at its
// first hop.
//
// Record semantics throughout: a row STANDS while it is unexpired and no
// apprunning announcement from the subject carries broadcastedAt >= the
// row's (the pipeline's own $gte rule — in production the refutation IS the
// apprunning announcement, already signed and already stored). An arriving
// certificate is a duplicate only while a standing row exists; a refuted or
// lapsed row means a new incident and a new row. No window, no timer.

/**
 * Cold verification of one certificate — synchronous and CPU-only, as the
 * grant-plane contract requires: jury recomputed at the NAMED fingerprint
 * from the in-memory membership history, signatures against the list's own
 * pubkeys, strict exact-or-refuse.
 *
 * @param {object} certificate {subject, assembler, height, fingerprint, verdicts[]}
 * @returns {{valid: boolean, subject: string|null, reason: string,
 *   counted?: number, needed?: number, discarded?: object}}
 */
function verifyNodeDownCertificate(certificate) {
  if (
    !certificate
    || typeof certificate.subject !== 'string'
    || typeof certificate.fingerprint !== 'string'
    || !Number.isFinite(certificate.height)
    || !Array.isArray(certificate.verdicts)
  ) {
    return { valid: false, subject: null, reason: 'malformed' };
  }

  const topology = networkStateService.nodeDownTopology();
  const height = networkStateService.chainHeight();
  if (!topology || height === null) {
    return { valid: false, subject: null, reason: 'not_ready' };
  }
  if (certificate.height > height + FUTURE_BLOCKS_TOLERANCE) {
    return { valid: false, subject: null, reason: 'future_height' };
  }

  const watchers = topology.juryAt(certificate.fingerprint, certificate.subject);
  if (watchers === null) {
    return { valid: false, subject: null, reason: 'unknown_fingerprint' };
  }
  const sameJury = topology.sameJuryFor(certificate.subject, certificate.fingerprint)
    || new Set([certificate.fingerprint]);
  const cotenants = topology.cotenants(certificate.subject, watchers);

  // Verdict freshness is measured at the CERTIFICATE's height, not this
  // reader's: the window proves the verdicts were fresh when the quorum
  // formed, and a record stands for six hours — a reader measuring against
  // its own height could never restore a certificate older than the verdict
  // lifetime, unsyncing the record for almost all of its life. Total age is
  // bounded by the record lifetime at intake, and the future check above
  // keeps the anchor honest against this reader's chain.
  const verdict = verifyCertificate(
    certificate,
    watchers,
    sameJury,
    (owner, payload, signature) => verificationHelper
      .verifyMessage(payload.toString(), owner, signature) === true,
    certificate.height,
    VERDICT_LIFETIME_BLOCKS,
    cotenants,
  );
  return {
    valid: verdict.accepted,
    subject: verdict.accepted ? certificate.subject : null,
    reason: verdict.reason,
    counted: verdict.counted,
    needed: verdict.needed,
    discarded: verdict.discarded,
  };
}

function eventsCollection() {
  const db = dbHelper.databaseConnection();
  return db.db(config.database.appsglobal.database).collection(globalAppStateEvents);
}

const RECORD_STATE = Object.freeze({
  STANDING: 'standing',
  REFUTED: 'refuted',
  NONE: 'none',
});

/**
 * The subject's unexpired nodedown rows. Expiry is checked here as well as
 * by the TTL index — a TTL sweep lags deletion by up to a minute.
 *
 * @param {string} subject collateral outpoint
 * @returns {Promise<Array<object>>}
 */
async function liveRowsFor(subject) {
  const rows = await eventsCollection()
    .find({ type: APP_STATE_EVENT_TYPES.NODEDOWN, subject })
    .toArray();
  const now = Date.now();
  return rows.filter((row) => new Date(row.expireAt).getTime() > now);
}

/**
 * The subject's freshest unexpired nodedown row and the announcement that
 * refuted it, if any.
 *
 * @param {string} subject collateral outpoint
 * @returns {Promise<{row: object, refutation: object|null} | null>}
 */
async function latestRecordFor(subject) {
  const live = await liveRowsFor(subject);
  if (!live.length) return null;
  const row = live.reduce((newest, candidate) => (
    new Date(candidate.broadcastedAt) > new Date(newest.broadcastedAt) ? candidate : newest
  ));

  const refutation = await eventsCollection().findOne({
    type: APP_STATE_EVENT_TYPES.APPRUNNING,
    outpoint: subject,
    broadcastedAt: { $gte: new Date(row.broadcastedAt) },
  });
  return { row, refutation: refutation || null };
}

/**
 * Intake for a nodedown broadcast, gossip and sync paths alike.
 *
 * @param {object} params
 * @param {object} params.message {certificate, broadcastedAt}
 * @param {object} [params.envelope] the broadcast envelope, stored verbatim
 * @returns {Promise<{accepted: boolean, rebroadcast: boolean, reason: string}>}
 */
async function handleNodeDownEvent({ message, envelope = null }) {
  try {
    const certificate = message?.certificate;
    const broadcastedAt = message?.broadcastedAt;
    if (!certificate || !Number.isFinite(broadcastedAt)) {
      return { accepted: false, rebroadcast: false, reason: 'malformed' };
    }
    const skew = Number.isFinite(CLOCK_SKEW_ALLOWANCE_MS) ? CLOCK_SKEW_ALLOWANCE_MS : 0;
    const now = Date.now();
    if (broadcastedAt > now + skew) {
      return { accepted: false, rebroadcast: false, reason: 'future' };
    }
    if (broadcastedAt + RECORD_LIFETIME_MS <= now) {
      return { accepted: false, rebroadcast: false, reason: 'expired' };
    }

    const check = verifyNodeDownCertificate(certificate);
    if (!check.valid) {
      return { accepted: false, rebroadcast: false, reason: check.reason };
    }

    // A node already holding a standing certificate for the subject drops
    // further copies without relaying: concurrent assemblies cost the fleet
    // one flood. A refuted or lapsed record is a PAST incident — store anew.
    const held = await latestRecordFor(certificate.subject);
    if (held && !held.refutation) {
      return { accepted: false, rebroadcast: false, reason: 'already_standing' };
    }

    const listed = networkStateService.networkState()
      .find((node) => `${node.txhash}:${node.outidx}` === certificate.subject);
    const ip = listed ? normalizeSocketAddress(listed.ip) : null;

    await eventsCollection().updateOne(
      {
        type: APP_STATE_EVENT_TYPES.NODEDOWN,
        dedupKey: `nodedown:${certificate.subject}:${certificate.height}`,
      },
      {
        $set: {
          type: APP_STATE_EVENT_TYPES.NODEDOWN,
          dedupKey: `nodedown:${certificate.subject}:${certificate.height}`,
          subject: certificate.subject,
          ip,
          broadcastedAt: new Date(broadcastedAt),
          expireAt: new Date(broadcastedAt + RECORD_LIFETIME_MS),
          data: { certificate },
          envelope,
          receivedAt: new Date(),
        },
      },
      { upsert: true },
    );
    return { accepted: true, rebroadcast: true, reason: 'stored' };
  } catch (err) {
    log.error(`nodeDownStore.handleNodeDownEvent: ${err.message}`);
    return { accepted: false, rebroadcast: false, reason: 'error' };
  }
}

/**
 * R5a+b: the standing certificate for a node, or null — standing means
 * unexpired AND unrefuted. Carries the record's broadcastedAt so the $gte
 * refutation rule is checkable against it.
 *
 * @param {string} outpoint
 * @returns {Promise<object|null>}
 */
async function standingCertificateFor(outpoint) {
  const held = await latestRecordFor(outpoint);
  if (!held || held.refutation) return null;
  return {
    ...held.row.data.certificate,
    broadcastedAt: new Date(held.row.broadcastedAt).getTime(),
  };
}

/**
 * Where the subject's latest record stands, named by its row key so a
 * reader can tell one record's lapse from the next record's.
 *
 * @param {string} subject collateral outpoint
 * @returns {Promise<{state: string, key: string|null}>} state is a RECORD_STATE
 */
async function recordStateFor(subject) {
  const held = await latestRecordFor(subject);
  if (!held) return { state: RECORD_STATE.NONE, key: null };
  return {
    state: held.refutation ? RECORD_STATE.REFUTED : RECORD_STATE.STANDING,
    key: held.row.dedupKey,
  };
}

/**
 * The severe quarantine verdict for a subject, counted over every unexpired
 * certification row — refuted ones included, since each is a death the
 * network certified. Rows are synced, so every node counts the same.
 *
 * @param {string} subject collateral outpoint
 * @returns {Promise<{quarantined: boolean, count: number, liftsAt: number|null}>}
 */
async function quarantineFor(subject) {
  const live = await liveRowsFor(subject);
  return quarantineFromExpiries(live.map((row) => new Date(row.expireAt).getTime()), Date.now());
}

/**
 * The same verdict looked up by a node's listed address — what a node has
 * for itself before it knows its outpoint. An address the list does not
 * carry has no rows to count.
 *
 * @param {string} socketAddress ip or ip:port
 * @returns {Promise<{quarantined: boolean, count: number, liftsAt: number|null}>}
 */
async function quarantineForAddress(socketAddress) {
  const wanted = normalizeSocketAddress(socketAddress);
  const listed = wanted
    ? networkStateService.networkState().find((node) => normalizeSocketAddress(node.ip) === wanted)
    : undefined;
  if (!listed) return { quarantined: false, count: 0, liftsAt: null };
  return quarantineFor(`${listed.txhash}:${listed.outidx}`);
}

/**
 * The announcement that revoked the subject's latest certificate, or null —
 * a merely-lapsed certificate has none, so its cancellation stands.
 *
 * @param {string} outpoint
 * @returns {Promise<object|null>}
 */
async function refutationFor(outpoint) {
  const held = await latestRecordFor(outpoint);
  if (!held || !held.refutation) return null;
  return {
    broadcastedAt: new Date(held.refutation.broadcastedAt).getTime(),
    data: held.refutation.data ?? null,
    envelope: held.refutation.envelope ?? null,
  };
}

/**
 * The $gte rule: the subject's announcement supersedes the certificate when
 * stamped at or after it — a tie goes to the announcement, or a returning
 * node waits out a block it already survived.
 *
 * @param {object} refutation {broadcastedAt}
 * @param {object} certificate {broadcastedAt}
 * @returns {boolean}
 */
function verifyRefutation(refutation, certificate) {
  const alive = refutation?.broadcastedAt;
  const cert = certificate?.broadcastedAt;
  if (!Number.isFinite(alive) || !Number.isFinite(cert)) return false;
  return alive >= cert;
}

/**
 * Wire this store in as the grant plane's certificate provider. Called once
 * at service wiring; until then the plane stays inert and fail-closed.
 */
function registerWithGrantPlane() {
  downCertificates.registerProvider({
    standingCertificateFor,
    refutationFor,
    verifyCertificate: (certificate) => {
      const check = verifyNodeDownCertificate(certificate);
      return { valid: check.valid, subject: check.subject };
    },
    verifyRefutation,
  });
}

module.exports = {
  RECORD_STATE,
  verifyNodeDownCertificate,
  handleNodeDownEvent,
  standingCertificateFor,
  recordStateFor,
  quarantineFor,
  quarantineForAddress,
  refutationFor,
  verifyRefutation,
  registerWithGrantPlane,
};
