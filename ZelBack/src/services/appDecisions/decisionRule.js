'use strict';

/**
 * The rule that decides app messages: for one name, each paid message in chain
 * order gets one decision, applied or refused with a reason, from the chain
 * facts of this node's own scan, the message's contents, the addresses its
 * signature recovers to, and the decisions before it.
 *
 * Every chain-state question (fees, activation, entitlement, signer lists) is
 * asked of `judge`, so this function reads nothing but its arguments and every
 * node holding the same messages reaches the same decisions.
 *
 * A rule this node cannot evaluate (a price history not in force, a fault in
 * the code) is not a refusal: the walk stops before that message, which stays
 * undecided with every later one for the name, and the caller takes the name
 * again on its next run. A refusal written for it would be permanent and drop,
 * on this node alone, an app every other node keeps.
 */

/** Decisions carry the rule version they were made under. */
const RULE_VERSION = 1;

const APPLIED = 'applied';
const REFUSED = 'refused';

const REGISTRATION = 'registration';
const UPDATE = 'update';

/**
 * A stored message with everything the rule reads of it.
 * @typedef {object} DecisionEntry
 * @property {string} hash
 * @property {'registration'|'update'} type
 * @property {number} timestamp - the signed timestamp
 * @property {{txid: string, height: number, txIndex: number, valueSat: number,
 *   blockTime: ?number}} record - this node's payment record
 * @property {?object} spec - the parsed spec; null when it does not parse
 * @property {?object} event - the parsed event; null when the spec does not parse
 * @property {?string} contentHash - a v2 message's content hash
 * @property {string[]} signers - every address its signature recovers to
 * @property {?object} decision - its decision, once made
 */

function decisionFor(entry, name, fields) {
  return {
    hash: entry.hash,
    name,
    height: entry.record.height,
    txIndex: entry.record.txIndex,
    txid: entry.record.txid,
    valueSat: entry.record.valueSat,
    blockTime: entry.record.blockTime ?? null,
    type: entry.type,
    reason: null,
    fee: null,
    uuid: null,
    identity: null,
    termStart: null,
    ruleVersion: RULE_VERSION,
    ...fields,
  };
}

function refused(entry, name, reason, fee = null) {
  return decisionFor(entry, name, { decision: REFUSED, reason, fee: fee === null ? null : String(fee) });
}

/** The latest applied entry before index `i`, or null. */
function latestApplied(entries, i) {
  for (let k = i - 1; k >= 0; k -= 1) {
    if (entries[k].decision?.decision === APPLIED) return entries[k];
  }
  return null;
}

/** The state a predecessor stands in, as the spec's term accessors read it. */
function standingState(entry) {
  return { height: entry.record.height, registeredAt: entry.decision.termStart };
}

/**
 * The confirming block's time of `entry`, where the term it is measured
 * against needs one: a term with a start (a v9 term) is measured in block
 * time; one without (a v1-v8 term) in heights, and asks for none.
 */
async function blockTimeAgainst(entry, standing, judge) {
  if (Number.isFinite(entry.record.blockTime)) return entry.record.blockTime;
  if (standing.decision.termStart === null) return null;
  return judge.blockTime(entry);
}

/**
 * The applied updates for the name before index `i`, stamped with their
 * confirming blocks' times: what the free-update limit counts.
 */
async function appliedUpdatesBefore(entries, i, judge) {
  const events = [];
  for (let k = 0; k < i; k += 1) {
    const earlier = entries[k];
    if (earlier.decision?.decision === APPLIED && earlier.type === UPDATE) {
      // eslint-disable-next-line no-await-in-loop
      const blockTime = earlier.record.blockTime ?? await judge.blockTime(earlier);
      events.push({ type: 'fluxappupdate', timestamp: blockTime * 1000 });
    }
  }
  return events;
}

/**
 * One message's decision, or throws when this node cannot evaluate a rule.
 * @param {DecisionEntry[]} entries - the name's messages in chain order, every
 *   one before `i` decided
 * @param {number} i
 * @param {string} name
 * @param {object} judge
 * @returns {Promise<object>}
 */
async function decideOne(entries, i, name, judge) {
  const entry = entries[i];
  const { record, spec } = entry;

  // Every message, first: the owner's signed timestamp cannot change without
  // the owner's key, so a message carrying the timestamp of an earlier one for
  // the name is that message paid for again.
  if (entries.slice(0, i).some((earlier) => earlier.timestamp === entry.timestamp)) {
    return refused(entry, name, 'replayed');
  }

  if (!spec) return refused(entry, name, 'invalid');
  const activation = judge.activationHeight(spec.version);
  if (activation === undefined || record.height < activation) return refused(entry, name, 'not-activated');

  if (entry.type === REGISTRATION) {
    const standing = latestApplied(entries, i);
    if (standing) {
      const clock = { currentHeight: record.height, tipBlockTime: await blockTimeAgainst(entry, standing, judge) };
      if (!standing.spec.isExpired(standingState(standing), clock)) return refused(entry, name, 'name-held');
    }

    const fee = await judge.registrationFee(spec, record.height);
    if (fee === 0n) return refused(entry, name, 'pricing-unavailable');
    if (BigInt(record.valueSat) < fee) return refused(entry, name, 'underpaid', fee);

    if (await judge.entitlementRefusal(spec, record.height)) return refused(entry, name, 'not-entitled', fee);

    const uuid = judge.mintUuid(spec.name, record.txid);
    return decisionFor(entry, name, {
      decision: APPLIED,
      fee: String(fee),
      uuid,
      identity: judge.identityFor(spec, uuid),
      termStart: record.blockTime ?? null,
    });
  }

  const predecessor = latestApplied(entries, i);
  if (!predecessor) return refused(entry, name, 'nothing-to-update');

  const authorized = await judge.authorized(entry, {
    height: record.height,
    previousState: {
      owner: predecessor.spec.owner,
      spec: predecessor.spec,
      contentHash: predecessor.contentHash,
    },
  });
  if (!authorized) return refused(entry, name, 'unauthorized');

  try {
    judge.assertCompatible(predecessor.spec, spec);
  } catch {
    return refused(entry, name, 'incompatible');
  }

  const blockTime = await blockTimeAgainst(entry, predecessor, judge);
  const fee = await judge.updateFee(spec, predecessor.spec, {
    height: record.height,
    prevHeight: predecessor.record.height,
    prevRegisteredAt: predecessor.decision.termStart,
    nowBlockTime: blockTime,
    recentEvents: () => appliedUpdatesBefore(entries, i, judge),
  });
  if (fee === null) return refused(entry, name, 'free-allowance-spent');
  if (BigInt(record.valueSat) < fee) return refused(entry, name, 'underpaid', fee);

  if (await judge.entitlementRefusal(spec, record.height)) return refused(entry, name, 'not-entitled', fee);

  return decisionFor(entry, name, {
    decision: APPLIED,
    fee: String(fee),
    uuid: predecessor.decision.uuid,
    identity: predecessor.decision.identity,
    // A free update bought no time, so it keeps the term it supersedes.
    termStart: fee === 0n ? predecessor.decision.termStart : blockTime,
  });
}

/**
 * Decides a name's messages from `from` onwards.
 *
 * A spec the pricer rejects as invalid is `refused: invalid`; any other failure
 * of a rule stops the walk there.
 *
 * @param {object} params
 * @param {string} params.name - the name, lower-cased
 * @param {DecisionEntry[]} params.entries - every stored message for the name
 *   with a payment record, in chain order; those before `from` carry their
 *   decisions
 * @param {number} params.from - index of the first message to decide
 * @param {object} params.judge
 * @returns {Promise<{decisions: object[], blocked: ?{hash: string, error: Error}}>}
 *   the decisions made, in order, and the message the walk stopped before
 */
async function decideName({
  name, entries, from, judge,
}) {
  const decisions = [];
  const walked = entries.map((entry, index) => (index < from ? entry : { ...entry, decision: null }));
  for (let i = from; i < walked.length; i += 1) {
    let decision;
    try {
      // eslint-disable-next-line no-await-in-loop
      decision = await decideOne(walked, i, name, judge);
    } catch (error) {
      if (!judge.isValidationError(error)) return { decisions, blocked: { hash: walked[i].hash, error } };
      decision = refused(walked[i], name, 'invalid');
    }
    walked[i] = { ...walked[i], decision };
    decisions.push(decision);
  }
  return { decisions, blocked: null };
}

module.exports = {
  decideName,
  RULE_VERSION,
  APPLIED,
  REFUSED,
  REGISTRATION,
  UPDATE,
};
