'use strict';

// The client's decision rules, pure — the half of the protocol that runs on
// the CANDIDATE. Everything here is arithmetic over replies already in hand;
// the loop that gathers them (grantClient.js) stays thin around it.
//
// The rules encode the client-side halves of §4 and §7:
//
//   - ADOPT-HIGHEST. A prepare quorum's answer is not "you may write your
//     value"; it is "here is what may already be chosen". If any reply
//     carries a recorded grant, the candidate MUST adopt the highest-epoch
//     one as the value — for ONE-SHOT that ends the story (the answer is
//     that grantee); for HELD it means the incumbent is known. Proposing
//     over a recorded value is the split-brain the two-phase form exists to
//     prevent.
//
//   - COUNT FROM SEND. What a grantor granted is counted on ITS clock; what
//     the holder may assume is counted from its own SEND instant — the whole
//     round trip charged to the holder, both sides conservative, no remote
//     timestamp ever compared to a local clock.
//
//   - THE MEDIAN, NOT THE MAX. The holder is safe while a QUORUM of grants
//     is live, so the safe-until instant is the quorum-th largest per-grantor
//     expiry. The max says "someone still grants me"; the mean says nothing;
//     both err unsafe, and the literature calls this the natural first
//     implementation error.
//
//   - UNANIMOUS WITNESSES OR NONE. Coasting through a committee outage is
//     permitted only while EVERY standby is reachable and affirms it cannot
//     reach quorum and is not holding or acquiring. One silent standby is a
//     possible challenger; unanimity fails closed (§7's witness coast).

/**
 * The epoch to propose after seeing this much of the world.
 * @param {number} highestSeen highest epoch in any reply, 0 when fresh
 * @returns {number}
 */
function nextEpoch(highestSeen) {
  return (Number.isSafeInteger(highestSeen) && highestSeen > 0 ? highestSeen : 0) + 1;
}

/**
 * The recorded grant a candidate is obliged to adopt: the highest-epoch
 * accepted record any reply carries — refusals included, because every
 * refusal teaches (grantors attach their record to every no).
 *
 * @param {Array<object>} replies grantor replies, any mix of ok and refusal
 * @returns {object|null} the accepted record to adopt, or null when the
 *   world is unwritten
 */
function adoptFrom(replies) {
  let adopted = null;
  (replies || []).forEach((reply) => {
    const accepted = reply?.accepted;
    if (!accepted) return;
    if (!adopted || accepted.epoch > adopted.epoch) adopted = accepted;
  });
  return adopted;
}

/**
 * The highest epoch the committee has taught us — promised or accepted —
 * which is what the next proposal must clear.
 * @param {Array<object>} replies
 * @returns {number}
 */
function highestEpochSeen(replies) {
  let highest = 0;
  (replies || []).forEach((reply) => {
    if (Number.isSafeInteger(reply?.promisedEpoch)) {
      highest = Math.max(highest, reply.promisedEpoch);
    }
    if (Number.isSafeInteger(reply?.accepted?.epoch)) {
      highest = Math.max(highest, reply.accepted.epoch);
    }
  });
  return highest;
}

/**
 * What a round of prepare replies amounts to.
 *
 * @param {Array<object>} replies one per grantor asked (missing/failed = absent)
 * @param {number} quorum the committee's quorum
 * @returns {{promised: boolean, adopt: object|null, highestEpoch: number,
 *   retryAfterMs: number}} `retryAfterMs` carries the largest lock-delay any
 *   grantor taught, 0 otherwise
 */
function prepareOutcome(replies, quorum) {
  const promises = (replies || []).filter((reply) => reply?.ok && reply.promised);
  let retryAfterMs = 0;
  (replies || []).forEach((reply) => {
    if (reply?.code === 'lock_delay' && Number.isSafeInteger(reply.retryAfterMs)) {
      retryAfterMs = Math.max(retryAfterMs, reply.retryAfterMs);
    }
  });
  return {
    promised: promises.length >= quorum,
    adopt: adoptFrom(replies),
    highestEpoch: highestEpochSeen(replies),
    retryAfterMs,
  };
}

/**
 * What a round of accept replies amounts to. "Winning" and "knowing you won"
 * are distinct states — held begins HERE, at the quorum of durable accepts,
 * never at the last prepare.
 *
 * @param {Array<object>} replies
 * @param {number} quorum
 * @returns {{granted: boolean, accepts: number, highestEpoch: number}}
 */
function acceptOutcome(replies, quorum) {
  const accepts = (replies || []).filter((reply) => reply?.ok && reply.accepted).length;
  return {
    granted: accepts >= quorum,
    accepts,
    highestEpoch: highestEpochSeen(replies),
  };
}

/**
 * The instant until which the holder may believe it holds: the quorum-th
 * largest of the per-grantor expiries, each counted from the holder's OWN
 * send instant for the last ack that grantor gave.
 *
 * @param {Array<{sentMs: number, ttlMs: number}>} acks the latest
 *   acknowledged renewal per distinct grantor — one entry per grantor
 * @param {number} quorum
 * @returns {number|null} monotonic ms, or null while no quorum of acks is live
 */
function safeUntilMs(acks, quorum) {
  const expiries = (acks || [])
    .filter((ack) => Number.isFinite(ack?.sentMs) && Number.isFinite(ack?.ttlMs))
    .map((ack) => ack.sentMs + ack.ttlMs)
    .sort((a, b) => b - a);
  if (expiries.length < quorum) return null;
  return expiries[quorum - 1];
}

/**
 * The holder's state at an instant. `jeopardy` is Chubby's word: the local
 * view has lapsed but the term the committee granted may still be running,
 * so the holder quiesces and re-earns rather than tearing down.
 *
 * @param {number} nowMs monotonic
 * @param {number|null} safeUntil from safeUntilMs
 * @param {number|null} demotionAt the self-demotion deadline, set by the loop
 * @returns {'held'|'jeopardy'|'lost'}
 */
function holderStateAt(nowMs, safeUntil, demotionAt) {
  if (safeUntil !== null && nowMs <= safeUntil) return 'held';
  if (demotionAt !== null && nowMs <= demotionAt) return 'jeopardy';
  return 'lost';
}

/**
 * Whether coasting through a total renewal-path outage is permitted (§7).
 *
 * @param {Array<string>} standbys every other holder of the app, by outpoint
 * @param {Map<string, object>} witnessReplies outpoint -> reply, where a
 *   reply is {quorumReachable: boolean, holding: boolean, acquiring: boolean}
 * @returns {{coast: boolean, reason: string|null}} the reason names the first
 *   standby that broke unanimity, for the demotion log
 */
/**
 * What a quorum of registers says about a term this node may still hold.
 *
 * A FluxOS restart wipes the in-memory holder while the container keeps
 * running, and the node cannot COUNT its way back: it knows the term ends no
 * LATER than when it lost track, but safety needs the EARLIEST possible end,
 * which is unbounded below. There is nothing to time. So it re-learns from the
 * grantors, which is sound exactly when acquisition is refused, because
 * grantRegister.read is served THROUGH the rejoin drain.
 *
 * Every rule here was forced by a violation trace in
 * fluxModels/formal/held-term-lifecycle:
 *
 *   a QUORUM at ONE epoch, never a single record. A round that reached one
 *   grantor and then died leaves an orphan row naming a node that never won,
 *   and recovering from it seated a second writer beside a legitimate master.
 *   §4's rule is "recorded on distinct owners = granted", and re-learning a
 *   term is subject to it exactly as winning one is. It is also why local
 *   persistence is the wrong primitive - a local file is one record, stale in
 *   the direction that hurts.
 *
 *   the EARLIEST remainder in the quorum bounds the term. It is live only
 *   while a quorum still says so.
 *
 *   the round trip is DISCOUNTED before the duration lands on this clock. Each
 *   remainingMs was computed on its grantor's own clock at an unknown instant
 *   inside the read window, so the only sound reading is the earliest: assume
 *   the whole trip is already spent. Adding an undiscounted remote figure to a
 *   local clock is the defect the model found in the first proposed fix, and
 *   it broke at every margin because the flaw is the conversion rather than
 *   any gap. Rate skew over what is left of the term is carried by the
 *   grantors' lock-delay - see §7 of QUORUM_GRANT_PRIMITIVE.md.
 *
 *   a discounted remainder of zero REFUSES rather than adopting a term it
 *   cannot serve.
 *
 * @param {Array<object>} replies one per grantor reached, each
 *   {grantee, epoch, remainingMs} as GET /flux/quorumgrant/record answers -
 *   a duration on the grantor's clock, never a deadline
 * @param {string} selfOutpoint
 * @param {number} quorum
 * @param {number} roundTripMs measured cost of the read, on this node's clock
 * @returns {{recovered: boolean, epoch: number|null, safeForMs: number,
 *   reason: string|null}}
 */
// The hard stop a demoted master gets, straight at docker. A term in the
// inequality below rather than an implementation detail of the consumer, so it
// lives here in the leaf: an assertion cannot reference a literal, and a
// back-require from the client to the consumer is a cycle. The consumer's own
// reconciler paths use docker's DEFAULT timeout, which measured over a minute
// on the fleet - a demotion routed through one of those breaks the inequality
// outright, which is what makes this value load-bearing.
const HARD_STOP_MS = 2_000;

/**
 * The one inequality the plane rests on, checked rather than commented.
 *
 * A demoted holder stops at `safeUntil + demotionSlackMs` on its own clock and
 * then takes the container down, which costs the hard-stop timeout. A
 * challenger may be granted at the grantors' expiry + `lockDelayMs` on THEIRS.
 * If the stop has not finished by then, both are running. So:
 *
 *     demotionSlackMs + hardStopMs  <  lockDelayMs
 *
 * STRICT, deliberately. The model works in whole ticks and finds `<=` safe;
 * at equality the two events race in continuous time, which no tick-based
 * model can see.
 *
 * The margin is not spare change. It is the entire clock-rate-skew budget of
 * the plane: §7's TTL:deadline ratio, which the design used to credit with
 * that job, is 1:1 in the code and absorbs nothing (see
 * QUORUM_GRANT_PRIMITIVE.md §7). At the shipped values the margin is 13,000ms
 * against a drift term that scales with TTL + slack, which is a one-sided
 * clock-rate error of 3.77%. Lowering lockDelayMs spends that silently, and
 * this is what notices.
 *
 * @param {{demotionSlackMs: number, hardStopMs: number, lockDelayMs: number}} timing
 * @returns {{safe: boolean, marginMs: number, reason: string|null}}
 */
function timingIsSafe(timing) {
  const slack = timing?.demotionSlackMs;
  const stop = timing?.hardStopMs;
  const lockDelay = timing?.lockDelayMs;
  const renewInterval = timing?.renewIntervalMs;
  if (![slack, stop, lockDelay, renewInterval].every((value) => Number.isFinite(value) && value >= 0)) {
    return { safe: false, marginMs: 0, reason: 'quorumGrant timing values are not all finite and non-negative' };
  }
  const marginMs = Math.max(0, lockDelay - slack - stop);
  if (!(slack + stop < lockDelay)) {
    return {
      safe: false,
      marginMs,
      reason: `quorumGrant timing is unsafe: demotion slack ${slack}ms + hard stop ${stop}ms `
        + `must be strictly under the grantors' lock-delay ${lockDelay}ms, `
        + 'or a demoted holder is still stopping when its successor is granted',
    };
  }
  // The refereeing-anchored lock-delay's companion: when the grantors
  // return, the successor's wait restarts at the return — the incumbent's
  // reclaim pass must land inside it, or the anchor buys nothing.
  if (!(renewInterval < lockDelay)) {
    return {
      safe: false,
      marginMs,
      reason: `quorumGrant timing is unsafe: the renewal interval ${renewInterval}ms `
        + `must sit strictly under the grantors' lock-delay ${lockDelay}ms, `
        + 'or a returning committee can seat a successor before the incumbent reclaims',
    };
  }
  return { safe: true, marginMs, reason: null };
}

/**
 * What a quorum of registers says the term IS - whoever holds it.
 *
 * The adoption half of the same question recoverOutcome asks about this node.
 * A tier-1 heal is a SWAP: remove X, add Y in one step, so {A,B,X} becomes
 * {A,B,Y} and the majorities {B,X} and {A,Y} share nobody. Raft permits
 * add-one or remove-one for exactly this reason, and X is only "dark" from
 * someone's point of view - a partitioned X votes happily.
 *
 * The fix is the one §5 already states for a ONE-SHOT re-pin - state transfer
 * with an activation gate, the grantor serves only once it holds the state -
 * and §7.1 never stated for HELD additions: an added seat ADOPTS the published
 * term before it serves, so it cannot be the swing vote for a challenger. It
 * arrives already knowing a term is live and refuses anyone else.
 *
 * Same rules as recovery, for the same reasons: a QUORUM at ONE epoch, and the
 * EARLIEST remainder in that quorum, because the term is live only while a
 * quorum still says so.
 *
 * @param {Array<object>} replies {grantee, epoch, remainingMs} per grantor read
 * @param {number} quorum
 * @returns {{grantee: string|null, epoch: number|null, remainingMs: number}}
 */
function quorumTerm(replies, quorum) {
  const live = (replies || []).filter((reply) => reply
    && typeof reply.grantee === 'string'
    && Number.isInteger(reply.epoch)
    && Number.isFinite(reply.remainingMs)
    && reply.remainingMs > 0);

  const byTerm = new Map();
  live.forEach((reply) => {
    const id = `${reply.grantee}@${reply.epoch}`;
    byTerm.set(id, [...(byTerm.get(id) ?? []), reply]);
  });

  let best = null;
  byTerm.forEach((rows) => {
    if (rows.length < quorum) return;
    if (best === null || rows[0].epoch > best[0].epoch) best = rows;
  });
  if (!best) return { grantee: null, epoch: null, remainingMs: 0 };
  return {
    grantee: best[0].grantee,
    epoch: best[0].epoch,
    remainingMs: Math.min(...best.map((reply) => reply.remainingMs)),
  };
}

function recoverOutcome(replies, selfOutpoint, quorum, roundTripMs) {
  const mine = (replies || []).filter((reply) => reply
    && reply.grantee === selfOutpoint
    && Number.isInteger(reply.epoch)
    && Number.isFinite(reply.remainingMs)
    // a row the grantor already calls lapsed cannot say the term is live
    && reply.remainingMs > 0);
  if (mine.length < quorum) {
    return {
      recovered: false, epoch: null, safeForMs: 0, reason: 'no quorum of registers names this node',
    };
  }

  // ONE epoch. Rows at different epochs are different terms, and a quorum
  // spread across two of them is not a quorum for either.
  const byEpoch = new Map();
  mine.forEach((reply) => {
    byEpoch.set(reply.epoch, [...(byEpoch.get(reply.epoch) ?? []), reply]);
  });
  let best = null;
  byEpoch.forEach((rows, epoch) => {
    if (rows.length >= quorum && (best === null || epoch > best.epoch)) best = { epoch, rows };
  });
  if (!best) {
    return {
      recovered: false, epoch: null, safeForMs: 0, reason: 'registers disagree on the epoch',
    };
  }

  const earliest = Math.min(...best.rows.map((reply) => reply.remainingMs));
  const trip = Number.isFinite(roundTripMs) && roundTripMs > 0 ? roundTripMs : 0;
  const safeForMs = earliest - trip;
  if (safeForMs <= 0) {
    return {
      recovered: false, epoch: null, safeForMs: 0, reason: 'no term remains once the read is discounted',
    };
  }
  return {
    recovered: true, epoch: best.epoch, safeForMs, reason: null,
  };
}

function coastVerdict(standbys, witnessReplies) {
  for (let i = 0; i < (standbys || []).length; i += 1) {
    const outpoint = standbys[i];
    const reply = witnessReplies?.get(outpoint);
    if (!reply) {
      return { coast: false, reason: `standby ${outpoint} unaccounted for` };
    }
    if (reply.quorumReachable) {
      return { coast: false, reason: `standby ${outpoint} can reach quorum` };
    }
    if (reply.holding || reply.acquiring) {
      return { coast: false, reason: `standby ${outpoint} holds or is acquiring` };
    }
  }
  return { coast: true, reason: null };
}

module.exports = {
  nextEpoch,
  adoptFrom,
  highestEpochSeen,
  prepareOutcome,
  acceptOutcome,
  safeUntilMs,
  holderStateAt,
  coastVerdict,
  recoverOutcome,
  timingIsSafe,
  quorumTerm,
  HARD_STOP_MS,
};
