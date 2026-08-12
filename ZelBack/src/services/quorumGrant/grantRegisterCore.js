'use strict';

const { selectCommittee } = require('../utils/committeeSelector');
const rosterOverlay = require('./rosterOverlay');

// The grantor's decision rules, pure. One record in, one request in, one
// verdict and possibly one changed record out — no clock reads, no I/O, so
// every rule is testable byte-for-byte and the persistence shell around it
// (grantRegister.js) stays too thin to hide a bug in.
//
// The protocol these rules implement is the two-phase grant (doc §4): a
// promise blocks lower epochs, an accept records a chosen value on fsync'd
// state, and every refusal carries what the grantor knows — the promised
// epoch and any recorded grant — because the caller's next correct move
// (adopt, back off, retry higher) is always computed FROM that knowledge.
// Silence teaches nothing and absence authorizes nothing.
//
// HELD terms add the machinery epochs alone do not give (§7): expiry, the
// incumbent shield while a grant is live, lock-delay after an involuntary
// lapse — binding CHALLENGERS only, never the recorded grantee, so the
// incumbent re-acquires immediately after an outage — and renewal that is
// only ever an extension of a live term; a lapsed term renews nothing and
// the holder goes back through the full acquisition path.
//
// ONE-SHOT registers are init-only (CASPaxos's x → x==∅ ? val₀ : x): the
// first recorded grantee is the answer forever, an identical re-accept is
// idempotent, and a different grantee is refused with the record — the
// candidate's obligation to adopt it is the client's half of the same rule.

const MODES = Object.freeze(['held', 'oneshot']);

/**
 * What the recorded grant means right now.
 *
 * @param {object|null} record persisted register doc
 * @param {number} nowMs grantor wall clock at receipt
 * @returns {'none'|'active'|'released'|'lapsed'}
 */
function grantState(record, nowMs) {
  const accepted = record?.accepted;
  if (!accepted) return 'none';
  if (accepted.released) return 'released';
  if (accepted.mode === 'oneshot') return 'active';
  return nowMs <= accepted.expiresAt ? 'active' : 'lapsed';
}

function isGrantee(accepted, candidate) {
  return Boolean(accepted) && accepted.grantee === candidate;
}

/**
 * Lock-delay: after an INVOLUNTARY lapse, challengers wait; the grantee never
 * does. A released grant carries no delay — the holder said goodbye, nothing
 * is in doubt.
 *
 * @returns {number} ms the candidate must still wait; 0 when free to proceed
 */
function lockDelayRemaining(record, candidate, nowMs, lockDelayMs) {
  if (grantState(record, nowMs) !== 'lapsed') return 0;
  if (isGrantee(record.accepted, candidate)) return 0;
  const lockedUntil = record.accepted.expiresAt + lockDelayMs;
  return Math.max(0, lockedUntil - nowMs);
}

/**
 * A refusal that teaches: every no carries the promised epoch and the record.
 */
function refusal(code, record, extra = {}) {
  return {
    ok: false,
    code,
    promisedEpoch: record?.promisedEpoch ?? 0,
    accepted: record?.accepted ?? null,
    ...extra,
  };
}

/**
 * Pre-vote. Answers exactly what a prepare would answer, changes nothing —
 * without this, any probe deposes a healthy holder by burning its epoch.
 */
function onProbe(record, request, nowMs, tunables) {
  const outcome = decidePrepare(record, request, nowMs, tunables);
  return { ...outcome.reply, probe: true };
}

/**
 * The shared prepare decision. onProbe reports it; onPrepare applies it.
 * @returns {{reply: object, record: object|null}} record null = no change
 */
function decidePrepare(record, request, nowMs, tunables) {
  const { epoch, candidate } = request;
  const promisedEpoch = record?.promisedEpoch ?? 0;
  const state = grantState(record, nowMs);

  // The incumbent shield (check-quorum's dual): while a term is live, a
  // challenger's prepare is refused WITHOUT advancing the promised epoch —
  // refusing was the point, and burning the epoch would let refused probes
  // depose by attrition. The incumbent itself passes: re-acquiring its own
  // seat is the recovery path, not a challenge. ONE-SHOT records do not
  // shield — the answer there is adoption, and prepare is how you learn it.
  if (state === 'active' && record.accepted.mode === 'held' && !isGrantee(record.accepted, candidate)) {
    return { reply: refusal('incumbent_active', record), record: null };
  }

  const waitMs = lockDelayRemaining(record, candidate, nowMs, tunables.lockDelayMs);
  if (waitMs > 0) {
    return { reply: refusal('lock_delay', record, { retryAfterMs: waitMs }), record: null };
  }

  if (epoch <= promisedEpoch) {
    return { reply: refusal('superseded', record), record: null };
  }

  return {
    reply: {
      ok: true,
      promised: true,
      promisedEpoch: epoch,
      accepted: record?.accepted ?? null,
    },
    record: { ...(record ?? {}), promisedEpoch: epoch },
  };
}

function onPrepare(record, request, nowMs, tunables) {
  return decidePrepare(record, request, nowMs, tunables);
}

/**
 * Accept: record the chosen value. `epoch >= promised` is Paxos; the rest is
 * the term machinery and the init-only register, each refusing with the
 * record so a correct client adopts instead of fighting.
 */
function onAccept(record, request, nowMs, tunables) {
  const {
    epoch, grantee, mode, ttlMs, fingerprint,
  } = request;

  if (!MODES.includes(mode)) {
    return { reply: refusal('bad_mode', record), record: null };
  }

  const promisedEpoch = record?.promisedEpoch ?? 0;
  const state = grantState(record, nowMs);

  if (record?.accepted && record.accepted.mode === 'oneshot') {
    if (record.accepted.grantee === grantee) {
      // Idempotent: a retried accept is the same decision, not a second one.
      return { reply: { ok: true, accepted: record.accepted }, record: null };
    }
    return { reply: refusal('already_granted', record), record: null };
  }

  if (state === 'active' && !isGrantee(record.accepted, grantee)) {
    // A live term refuses a different grantee even at a higher epoch. A
    // correct client never reaches this (its prepare was refused); a client
    // that skipped prepare is exactly who the belt is for.
    return { reply: refusal('incumbent_active', record), record: null };
  }

  const waitMs = lockDelayRemaining(record, grantee, nowMs, tunables.lockDelayMs);
  if (waitMs > 0) {
    return { reply: refusal('lock_delay', record, { retryAfterMs: waitMs }), record: null };
  }

  if (epoch < promisedEpoch) {
    return { reply: refusal('superseded', record), record: null };
  }

  const accepted = {
    epoch,
    grantee,
    mode,
    fingerprint: fingerprint ?? null,
    expiresAt: mode === 'held' ? nowMs + ttlMs : null,
    released: false,
  };

  // The roster chain is bound to its committee basis. A grant accepted at a
  // different fingerprint draws a fresh base committee, and an overlay from
  // the old world must not survive to reshape it.
  const rosterStale = record?.roster && record.roster.fingerprint !== accepted.fingerprint;

  return {
    reply: { ok: true, accepted },
    record: {
      ...(record ?? {}),
      promisedEpoch: Math.max(promisedEpoch, epoch),
      accepted,
      ...(rosterStale ? { roster: null } : {}),
    },
  };
}

/**
 * Renewal: an extension of a LIVE term by its own grantee at its own epoch.
 * Anything else — lapsed, released, wrong epoch, wrong grantee — is refused,
 * and a lapsed holder goes back through the full acquisition path
 * (etcd#11408's shape: "already in progress" is not a permission).
 *
 * The new expiry counts from the grantor's own receipt clock; what the HOLDER
 * may assume is counted from ITS send time — both conservative, neither
 * comparing one machine's clock to another's.
 */
function onRenew(record, request, nowMs) {
  const { epoch, grantee } = request;
  const state = grantState(record, nowMs);

  if (state === 'none' || state === 'released') {
    return { reply: refusal('no_grant', record), record: null };
  }
  if (record.accepted.mode !== 'held') {
    return { reply: refusal('bad_mode', record), record: null };
  }
  if (!isGrantee(record.accepted, grantee) || record.accepted.epoch !== epoch) {
    return { reply: refusal('not_grantee', record), record: null };
  }
  if (state === 'lapsed') {
    return { reply: refusal('lapsed', record), record: null };
  }

  const accepted = { ...record.accepted, expiresAt: nowMs + request.ttlMs };
  return {
    reply: { ok: true, renewed: true, accepted },
    record: { ...record, accepted },
  };
}

/**
 * A single-seat roster change: the recorded grantee proposes remove-X-add-Y
 * against the committee its grant is pinned to. Everything checkable is
 * checked here, from state the grantor holds:
 *
 *   - only the recorded grantee of the LIVE held term proposes — a lapsed
 *     or deposed holder reshapes nothing;
 *   - the proposal extends this grantor's journaled chain exactly; carried
 *     entries this grantor missed are adopted only when the shell has
 *     verified their quorum signatures AND they extend the journal without
 *     conflict (a fork at any seq is corruption, refused, never chosen);
 *   - at most one seat changes per TTL, stamped per grantor — pacing is a
 *     quorum property: consecutive changes need overlapping quorums, and
 *     the overlap always contains a fresh stamp;
 *   - the removed seat is on the roster; the added seat is the recomputed
 *     walk replacement, never the proposer's word.
 *
 * The reply names the entry; the SIGNED acceptance over it is the
 * controller's job, sequenced after the journal write like every reply.
 *
 * @param {object} context {key, membership, committeeSize,
 *   verifiedCarriedChain} — membership is the list the ask's fingerprint
 *   names, resolved by the caller; the carried chain arrives only after
 *   signature verification against that same membership
 */
function onRoster(record, request, nowMs, knobs, context) {
  const {
    epoch, candidate, remove, add, seq, fingerprint,
  } = request;
  const state = grantState(record, nowMs);

  if (state === 'none' || state === 'released') {
    return { reply: refusal('no_grant', record), record: null };
  }
  if (record.accepted.mode !== 'held') {
    return { reply: refusal('bad_mode', record), record: null };
  }
  if (!isGrantee(record.accepted, candidate) || record.accepted.epoch !== epoch) {
    return { reply: refusal('not_grantee', record), record: null };
  }
  if (state === 'lapsed') {
    return { reply: refusal('lapsed', record), record: null };
  }
  if ((record.accepted.fingerprint ?? null) !== fingerprint) {
    return { reply: refusal('wrong_fingerprint', record), record: null };
  }

  const journaled = record.roster?.fingerprint === fingerprint ? record.roster.chain : [];

  let chain = journaled;
  const carried = context.verifiedCarriedChain;
  if (carried && carried.length > journaled.length) {
    if (!rosterOverlay.extendsChain(journaled, carried)) {
      return { reply: refusal('roster_conflict', record, { rosterSeq: journaled.length }), record: null };
    }
    chain = carried;
  }

  if (seq !== chain.length + 1) {
    return { reply: refusal('roster_seq', record, { rosterSeq: chain.length }), record: null };
  }

  const changedAt = record.roster?.fingerprint === fingerprint ? record.roster.changedAt : undefined;
  if (changedAt !== undefined && nowMs - changedAt < knobs.maxTtlMs) {
    return {
      reply: refusal('roster_rate', record, {
        retryAfterMs: knobs.maxTtlMs - (nowMs - changedAt),
        rosterSeq: chain.length,
      }),
      record: null,
    };
  }

  const walkKey = `quorumgrant|${context.key}`;
  const base = selectCommittee(context.membership, walkKey, { size: context.committeeSize });
  if (base.refusal) {
    return { reply: refusal('no_committee', record), record: null };
  }
  if (chain.length >= rosterOverlay.chainCap(base.members.length)) {
    return { reply: refusal('roster_exhausted', record, { rosterSeq: chain.length }), record: null };
  }

  const roster = rosterOverlay.rosterAfter(base.members, context.membership, chain);
  if (!roster) {
    return { reply: refusal('roster_conflict', record, { rosterSeq: chain.length }), record: null };
  }
  if (!roster.some((node) => `${node.txhash}:${node.outidx}` === remove)) {
    return { reply: refusal('roster_remove', record, { rosterSeq: chain.length }), record: null };
  }

  const survivors = roster.filter((node) => `${node.txhash}:${node.outidx}` !== remove);
  const excluded = new Set(chain.map((entry) => entry.remove));
  excluded.add(remove);
  const expected = rosterOverlay.nextReplacement(context.membership, walkKey, survivors, excluded);
  if (!expected) {
    return { reply: refusal('roster_exhausted', record, { rosterSeq: chain.length }), record: null };
  }
  if (`${expected.txhash}:${expected.outidx}` !== add) {
    return {
      reply: refusal('roster_add', record, {
        expected: `${expected.txhash}:${expected.outidx}`,
        rosterSeq: chain.length,
      }),
      record: null,
    };
  }

  const entry = {
    seq, remove, add, at: request.at ?? nowMs,
  };
  return {
    reply: {
      ok: true, seq, remove, add,
    },
    record: {
      ...record,
      roster: { fingerprint, changedAt: nowMs, chain: [...chain, entry] },
    },
  };
}

/**
 * Voluntary release by the grantee: ends the term with no lock-delay. A
 * release for a grant this grantor never recorded is a no-op success — the
 * caller cannot tell the difference and has no correct use for it.
 */
function onRelease(record, request, nowMs) {
  const { epoch, grantee } = request;
  const state = grantState(record, nowMs);

  if (state === 'none' || state === 'released') {
    return { reply: { ok: true, released: true }, record: null };
  }
  if (record.accepted.mode !== 'held') {
    return { reply: refusal('bad_mode', record), record: null };
  }
  if (!isGrantee(record.accepted, grantee) || record.accepted.epoch !== epoch) {
    return { reply: refusal('not_grantee', record), record: null };
  }

  const accepted = { ...record.accepted, released: true };
  return {
    reply: { ok: true, released: true },
    record: { ...record, accepted },
  };
}

module.exports = {
  MODES,
  grantState,
  lockDelayRemaining,
  onProbe,
  onPrepare,
  onAccept,
  onRenew,
  onRoster,
  onRelease,
};
