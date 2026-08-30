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
// The epoch is this plane's FENCING TOKEN in the classical sense (Chubby's
// sequencer, Kleppmann's token): monotonic, carried with every grant, and
// only as strong as the resources that CHECK it. The register guarantees
// exactly one HOLDER per term; exactly one EFFECT is each consumer's half
// of the contract, enforced where its writes land — no coordination
// primitive can stop a stale process from running, only a resource can
// refuse its writes.
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
 * The wait runs only while this grantor is refereeing. While the register was
 * closed — stale chain view, an unresynced return — nobody could have
 * reclaimed the lapsed row, so the exclusivity window the incumbent is owed
 * must not have burned in its absence: the anchor is the LATER of the row's
 * death and the grantor's last return to refereeing (refereeingSinceMs,
 * carried beside the knobs by the controller). Anchored at row death alone,
 * a coast outliving lockDelay − demotionSlack inverts the holder's
 * stop-before-successor ordering the moment the grantor comes back. An
 * absent anchor keeps the row-death behaviour.
 *
 * @returns {number} ms the candidate must still wait; 0 when free to proceed
 */
function lockDelayRemaining(record, candidate, nowMs, lockDelayMs, refereeingSinceMs) {
  if (grantState(record, nowMs) !== 'lapsed') return 0;
  if (isGrantee(record.accepted, candidate)) return 0;
  const anchorMs = Math.max(record.accepted.expiresAt, refereeingSinceMs ?? 0);
  const lockedUntil = anchorMs + lockDelayMs;
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

  const waitMs = lockDelayRemaining(record, candidate, nowMs, tunables.lockDelayMs, tunables.refereeingSinceMs);
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
    // The stamp is what keeps a promise a claim about NOW: revival (onRenew)
    // yields only to a promise fresh within the lock-delay, because a pursuit
    // that was going to complete completed within it — an older promise is a
    // residue, and refusing forever on a residue is a ratchet, not a guard.
    record: { ...(record ?? {}), promisedEpoch: epoch, promisedAt: nowMs },
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

  const waitMs = lockDelayRemaining(record, grantee, nowMs, tunables.lockDelayMs, tunables.refereeingSinceMs);
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
    generation: request.generation ?? 0,
    expiresAt: mode === 'held' ? nowMs + ttlMs : null,
    released: false,
  };

  // Both overlays are bound to their committee basis — the membership AND
  // the generation. A grant accepted at either a different fingerprint or a
  // re-rolled generation draws a fresh base committee, and an overlay from
  // the old world must not survive to reshape it.
  const rosterStale = record?.roster
    && (record.roster.fingerprint !== accepted.fingerprint
      || (record.roster.generation ?? 0) !== accepted.generation);
  const cancelsStale = record?.cancels
    && (record.cancels.fingerprint !== accepted.fingerprint
      || (record.cancels.generation ?? 0) !== accepted.generation);

  return {
    reply: { ok: true, accepted },
    record: {
      ...(record ?? {}),
      promisedEpoch: Math.max(promisedEpoch, epoch),
      ...(epoch > promisedEpoch ? { promisedAt: nowMs } : {}),
      accepted,
      ...(rosterStale ? { roster: null } : {}),
      ...(cancelsStale ? { cancels: null } : {}),
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
function onRenew(record, request, nowMs, tunables) {
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
  // The recorded grantee may revive its own lapsed, unsuperseded term -
  // this is how a restarted referee's cell rejoins the renewal quorum: its
  // record lapsed while the process was down, though the term lived on the
  // other cells. Safe by intersection arithmetic - any successor needed a
  // quorum that did not include this sleeping cell, and this cell adopts
  // the higher epoch at its next prepare. A promise above the recorded epoch
  // means a takeover is in flight ONLY while it is fresh: a completing
  // pursuit completes within the lock-delay, so revival yields to a promise
  // stamped inside that window and to nothing older — a stale or unstamped
  // promise is a residue (a pursuit that died mid-flight), and refusing on
  // it forever is the ratchet the 1205 fleet measured, not a safety rule.
  // The promise itself stays durable either way: proposal ordering
  // (prepare/accept) never reads the stamp.
  if (state === 'lapsed' && (record.promisedEpoch ?? 0) > record.accepted.epoch) {
    const age = Number.isFinite(record.promisedAt) ? nowMs - record.promisedAt : Infinity;
    if (age <= (tunables?.lockDelayMs ?? 30_000)) {
      return { reply: refusal('lapsed', record), record: null };
    }
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
  const generation = request.generation ?? 0;
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
  if ((record.accepted.generation ?? 0) !== generation) {
    return { reply: refusal('wrong_generation', record), record: null };
  }

  const journaled = record.roster?.fingerprint === fingerprint
    && (record.roster.generation ?? 0) === generation
    ? record.roster.chain : [];

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

  const changedAt = record.roster?.fingerprint === fingerprint
    && (record.roster.generation ?? 0) === generation
    ? record.roster.changedAt : undefined;
  if (changedAt !== undefined && nowMs - changedAt < knobs.maxTtlMs) {
    return {
      reply: refusal('roster_rate', record, {
        retryAfterMs: knobs.maxTtlMs - (nowMs - changedAt),
        rosterSeq: chain.length,
      }),
      record: null,
    };
  }

  const walkKey = rosterOverlay.walkKeyFor(context.key, generation);
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
      roster: {
        fingerprint, generation, changedAt: nowMs, chain: [...chain, entry],
      },
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
