'use strict';

const config = require('config');

const dbHelper = require('../dbHelper');
const log = require('../../lib/log');
const networkStateService = require('../networkStateService');
const verificationHelper = require('../verificationHelper');
const downCertificates = require('../quorumGrant/downCertificates');
const { APP_STATE_EVENT_TYPES } = require('./messageStore');
const { globalAppStateEvents, CLOCK_SKEW_ALLOWANCE_MS, NODE_DOWN_GRACE_MS } = require('../utils/appConstants');
const {
  verifyCertificate,
  standingRowsHold,
  PLACEMENT_FREEZE_ROWS,
  LOCKOUT_ROWS,
  RECORD_LIFETIME_MS,
  VERDICT_LIFETIME_BLOCKS,
  FUTURE_BLOCKS_TOLERANCE,
  DROP_REASON,
} = require('../utils/nodeDownCertificates');
const { normalizeSocketAddress } = require('../utils/socketAddressUtils');

// The nodedown record store: one row PER CERTIFICATION, keyed on the
// certificate — never a constant dedupKey, or re-certification overwrites
// the one row and the rungs' count has nothing to count.
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
 * Every unexpired nodedown row for a subject as the message that carried it,
 * oldest first — what a door hands a locked-out dialer before it closes, so
 * the dialer's own store can reach the count whichever rows it missed while
 * it was dark.
 *
 * @param {string} subject collateral outpoint
 * @returns {Promise<Array<{certificate: object, broadcastedAt: number}>>}
 */
async function certificatesFor(subject) {
  const rows = await liveRowsFor(subject);
  return rows
    .sort((a, b) => new Date(a.broadcastedAt) - new Date(b.broadcastedAt))
    .map((row) => ({
      certificate: row.data.certificate,
      broadcastedAt: new Date(row.broadcastedAt).getTime(),
    }));
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

    // The drop the jury saw. A certificate whose verdicts saw none dates it
    // from its broadcast. A drop after the broadcast (beyond skew) or older
    // than two graces before it is not this death: the derivation negates
    // the subject's rows at since + the grace, so since is what a stored
    // certificate is FOR, and it is bounded here against the one wall-clock
    // fact every reader holds — the row's broadcast time.
    const since = certificate.since ?? broadcastedAt;
    const reason = certificate.reason ?? DROP_REASON.UNANNOUNCED;
    if (since > broadcastedAt + skew || broadcastedAt - since > 2 * NODE_DOWN_GRACE_MS) {
      return { accepted: false, rebroadcast: false, reason: 'since_out_of_range' };
    }

    // A node already holding a standing certificate for the subject drops
    // further copies without relaying: concurrent assemblies cost the fleet
    // one flood. A refuted record is a PAST incident, and what arrives now
    // is one of three things, told apart by when its drop was and when it
    // was certified against the record held and the return that refuted it:
    //   - the record's own row again (a replay over sync): accepted, not news;
    //   - a NEW death, its drop later than the return: news, its own row;
    //   - an OLDER death this node had missed, certified before the record's
    //     own drop: stored for the count, not news;
    //   - the SAME death under another assembler's height — every assembler
    //     stamps its own, so one death reaches a node under several, and a
    //     second row would count the death twice. On the fleet it did: rows
    //     re-served by a reconnect pull locked a node out at its third
    //     death. Refused, not stored.
    const dedupKey = `nodedown:${certificate.subject}:${certificate.height}`;
    const live = await liveRowsFor(certificate.subject);
    let superseded = false;
    if (live.length) {
      const announced = (await eventsCollection().find(
        { type: APP_STATE_EVENT_TYPES.APPRUNNING, outpoint: certificate.subject },
        { projection: { broadcastedAt: 1 } },
      ).toArray()).map((row) => new Date(row.broadcastedAt).getTime()).sort((a, b) => a - b);
      // the return that refuted a row: the first announcement at or after it
      const refutedAt = (row) => {
        const at = new Date(row.broadcastedAt).getTime();
        const answer = announced.find((when) => when >= at);
        return answer === undefined ? null : answer;
      };
      const newest = live.reduce((a, b) => (new Date(b.broadcastedAt) > new Date(a.broadcastedAt) ? b : a));
      if (refutedAt(newest) === null) {
        return { accepted: false, rebroadcast: false, reason: 'already_standing' };
      }
      if (live.some((row) => row.dedupKey === dedupKey)) {
        superseded = true;
      } else {
        // The same death as a row held, under another assembler's height: its
        // drop no later than the return that refuted that row, certified no
        // earlier than that row's drop. Every row held is asked, not the
        // newest alone — a second assembly of an older death is not a death
        // this node missed.
        const sameDeath = live.some((row) => {
          const answered = refutedAt(row);
          return answered !== null && since <= answered && broadcastedAt >= new Date(row.since).getTime();
        });
        if (sameDeath) {
          return { accepted: false, rebroadcast: false, reason: 'same_death' };
        }
        superseded = since <= refutedAt(newest);
      }
    }

    const listed = networkStateService.networkState()
      .find((node) => `${node.txhash}:${node.outidx}` === certificate.subject);
    const ip = listed ? normalizeSocketAddress(listed.ip) : null;

    await eventsCollection().updateOne(
      {
        type: APP_STATE_EVENT_TYPES.NODEDOWN,
        dedupKey,
      },
      {
        $set: {
          type: APP_STATE_EVENT_TYPES.NODEDOWN,
          dedupKey,
          subject: certificate.subject,
          ip,
          broadcastedAt: new Date(broadcastedAt),
          since: new Date(since),
          reason,
          expireAt: new Date(broadcastedAt + RECORD_LIFETIME_MS),
          data: { certificate },
          envelope,
          receivedAt: new Date(),
        },
      },
      { upsert: true },
    );
    return {
      accepted: true, rebroadcast: true, reason: 'stored', superseded,
    };
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
 * The rungs for a subject, counted over every unexpired certification row —
 * refuted ones included, since each is a death the network certified. Rows
 * are synced, so every node counts the same.
 */
async function rowExpiries(subject) {
  const live = await liveRowsFor(subject);
  return live.map((row) => new Date(row.expireAt).getTime());
}

/**
 * Placement freeze: the subject's own spawner declines new apps; nothing
 * else changes.
 *
 * @param {string} subject collateral outpoint
 * @returns {Promise<{frozen: boolean, count: number, liftsAt: number|null}>}
 */
async function placementFreezeFor(subject) {
  const { held, count, liftsAt } = standingRowsHold(await rowExpiries(subject), Date.now(), PLACEMENT_FREEZE_ROWS);
  return { frozen: held, count, liftsAt };
}

/**
 * Lockout: peers refuse the subject's inbound, its jurors stand down, and
 * it removes every app it holds.
 *
 * @param {string} subject collateral outpoint
 * @returns {Promise<{lockedOut: boolean, count: number, liftsAt: number|null}>}
 */
async function lockoutFor(subject) {
  const { held, count, liftsAt } = standingRowsHold(await rowExpiries(subject), Date.now(), LOCKOUT_ROWS);
  return { lockedOut: held, count, liftsAt };
}

/**
 * The listed subject at an address — what a node has for itself before it
 * knows its outpoint. An address the list does not carry has no rows.
 *
 * @param {string} socketAddress ip or ip:port
 * @returns {string|null} outpoint
 */
function listedSubjectAt(socketAddress) {
  const wanted = normalizeSocketAddress(socketAddress);
  const listed = networkStateService.networkState().find((node) => {
    const nodeAddress = normalizeSocketAddress(node.ip);
    return nodeAddress === wanted || nodeAddress?.split(':')[0] === wanted;
  });
  return listed ? `${listed.txhash}:${listed.outidx}` : null;
}

async function placementFreezeForAddress(socketAddress) {
  const subject = listedSubjectAt(socketAddress);
  if (!subject) return { frozen: false, count: 0, liftsAt: null };
  return placementFreezeFor(subject);
}

async function lockoutForAddress(socketAddress) {
  const subject = listedSubjectAt(socketAddress);
  if (!subject) return { lockedOut: false, count: 0, liftsAt: null };
  return lockoutFor(subject);
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
  certificatesFor,
  recordStateFor,
  placementFreezeFor,
  placementFreezeForAddress,
  lockoutFor,
  lockoutForAddress,
  refutationFor,
  verifyRefutation,
  registerWithGrantPlane,
};
