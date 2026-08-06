const config = require('config');
const crypto = require('crypto');
const axios = require('axios');
const fluxCommunicationUtils = require('../fluxCommunicationUtils');
const generalService = require('../generalService');
const log = require('../../lib/log');
const limitCounterStore = require('./limitCounterStore');
const limitCounterRecords = require('./limitCounterRecords');
const { rankNodes } = require('./rendezvousRank');
const { extractIp, extractPort } = require('./socketAddressUtils');
const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');

// Which node holds the tally for one limit.
//
// A per-caller limit that each node enforces from its own state is not a limit:
// ask every node at once and every one says yes, because none has heard of the
// others. Gossiping the answer does not fix it either - a burst simply outruns
// the propagation, which is the same hole with more moving parts.
//
// So one node holds the tally for each limit key, and is asked. Whichever node a
// caller reaches forwards the QUESTION (never the work) to that counter, which
// answers from state only it holds. Thirty-two simultaneous requests become
// thirty-two questions to one node, which says yes once. This is the standard
// sharded-rate-limiter shape: a single counter per key makes the increment atomic
// and removes the need to agree on anything.
//
// The counter is derived, never elected. Every node computes the same one from the
// chain-derived node list, so there is nothing to coordinate and nothing that can
// be stale except the list itself.
//
// "Counter", not "owner": an owner in this codebase is the FluxID an app belongs
// to (io.runonflux.owner, ownerZelid, appownerabove), and one word for two things
// in one call stack is how a reader ends up applying the wrong one.
//
// The pool is NOT filtered by tier or capability. A counter counts; it does not
// run the work being counted. That is deliberate - a node unable to perform the
// work is still a perfectly good counter, so the pool is the whole fleet and no
// capability question enters a decision that has to be identical everywhere.

/**
 * The nodes authoritative for one limit key: the counter, and the single deputy
 * that stands in when the counter cannot be reached.
 *
 * The key carries the purpose as well as the axis, so two different limits on the
 * same caller land on different counters. That spreads the load and stops one
 * feature's counter outage from taking every limit on that caller with it.
 *
 * There is deliberately no time component. Counter assignment that rotated would discard
 * the count at every rotation, which is the thing being counted.
 *
 * @param {string} purpose what is being limited, e.g. 'playground'
 * @param {string} axis which axis of the caller, e.g. 'identity'
 * @param {string} axisValue the caller's value on that axis
 * @returns {Promise<{counter: object|null, deputy: object|null}>}
 */
async function countersFor(purpose, axis, axisValue) {
  return countersForKey(purpose, keyHash(purpose, axis, axisValue));
}

/**
 * The same, for a node that holds only the hashed key.
 *
 * The ranking is over the HASH rather than the caller, which is what lets a node
 * receiving a request verify it is genuinely the counter for it. Ranking on the
 * raw value would mean the receiver could not check — and a node that answers for
 * keys it does not hold is a counter for anyone who asks, which is no counter.
 */
async function countersForKey(purpose, key) {
  const nodes = await fluxCommunicationUtils.deterministicFluxList();
  const ranked = rankNodes(nodes, `${purpose}|${key}`);
  return { counter: ranked[0] ?? null, deputy: ranked[1] ?? null };
}

/**
 * This node's role for one limit key: 'counter', 'deputy', or null.
 *
 * Fails closed. A node that cannot identify itself cannot show it holds either
 * role, and answering a limit question it does not hold is how a bound stops
 * being one.
 *
 * @param {string} purpose
 * @param {string} axis
 * @param {string} axisValue
 * @returns {Promise<'counter'|'deputy'|null>}
 */
async function localRole(purpose, axis, axisValue) {
  return localRoleForKey(purpose, keyHash(purpose, axis, axisValue));
}

/**
 * This node's role for a hashed key: 'counter', 'deputy', or null.
 *
 * @param {string} purpose
 * @param {string} key
 * @returns {Promise<'counter'|'deputy'|null>}
 */
async function localRoleForKey(purpose, key) {
  const { counter, deputy } = await countersForKey(purpose, key);
  if (!counter && !deputy) return null;

  const collateral = await generalService.obtainNodeCollateralInformation();
  const isSelf = (node) => node
    && node.txhash === collateral.txhash
    && String(node.outidx) === String(collateral.txindex);

  if (isSelf(counter)) return 'counter';
  if (isSelf(deputy)) return 'deputy';
  return null;
}


// The purpose a DEPUTY reserves under while the counter is unreachable. Separate
// so its (meaner) numbers are visible in config rather than hidden in a branch,
// and so the two tallies stay apart - they cannot see each other anyway.
function deputyPurpose(purpose) {
  return `${purpose}#deputy`;
}

/**
 * What travels between nodes in place of the caller.
 *
 * A tally needs to recognise the same caller twice; it never needs to know who
 * they are. Sending the FluxID would put it in clear on every hop between nodes -
 * and the gossiped record covering the same caller is encrypted precisely because
 * that value is worth protecting, so shipping it plainly here would undo that.
 *
 * Not a defence against a node that already has a FluxID in mind and wants to
 * confirm it - that is one hash away for anyone. It stops the thing that matters:
 * harvesting identities in bulk from traffic that is not addressed to you.
 *
 * @returns {string} the tally key
 */
function keyHash(purpose, axis, axisValue) {
  return crypto.createHash('sha256').update(`${purpose}|${axis}|${axisValue}`).digest('hex');
}

function askTimeoutMs() {
  return config.fluxapps.limitCounterAskTimeoutMs ?? 3000;
}

/**
 * Put the question to the node holding a tally.
 *
 * A non-answer is not a no. Unreachable says nothing about whether the caller has
 * room, so it is reported as such and the deputy rule decides - conflating them
 * would make one node's outage look like a caller over their limit.
 *
 * @returns {Promise<object|null>} the verdict, or null if the node did not answer
 */
async function askNode(node, purpose, key) {
  if (!node || !node.ip) return null;
  const ip = extractIp(node.ip);
  const port = extractPort(node.ip);
  const res = await axios
    .post(`http://${ip}:${port}/flux/limitcounter/reserve`, { purpose, key }, { timeout: askTimeoutMs() })
    .catch(() => null);
  if (!res || !res.data || res.data.status !== 'success') return null;
  return res.data.data;
}

/**
 * May this caller start one, and take the slot if so.
 *
 * Whichever node a caller reached asks the one node holding their tally. Thirty-two
 * simultaneous requests become thirty-two questions to one node, which says yes as
 * many times as the limit allows and no thereafter.
 *
 * When that node cannot be reached, exactly ONE other node may answer - the
 * deputy - and only under the tighter deputy limit. That is what keeps the
 * fallback from becoming the hole: a rule every node could apply for itself would
 * be thirty-two independent yeses, which is the situation being fixed.
 *
 * @returns {Promise<{allowed: boolean, token: string|null, at: 'counter'|'deputy'|null, reason: string|null}>}
 */
async function reserve(purpose, axis, axisValue) {
  const role = await localRole(purpose, axis, axisValue).catch(() => null);

  if (role === 'counter') {
    const key = keyHash(purpose, axis, axisValue);
    // Records first. A counter that just restarted, or has just taken this key
    // over from a node that left the network, would otherwise start the caller's
    // day again - making "wait for a restart" the way to reset a quota.
    await limitCounterRecords.reconcile(purpose, key).catch((error) => {
      log.warn(`limitCounter - could not reconcile ${purpose} from records: ${error.message}`);
    });
    const verdict = limitCounterStore.reserve(purpose, key);
    return { ...verdict, at: 'counter' };
  }

  const { counter } = await countersFor(purpose, axis, axisValue);
  const answer = await askNode(counter, purpose, keyHash(purpose, axis, axisValue));
  if (answer) return { ...answer, at: 'counter' };

  if (role === 'deputy') {
    log.warn(`limitCounter - ${purpose} counter unreachable for a caller; answering as deputy under the reduced limit`);
    const verdict = limitCounterStore.reserve(deputyPurpose(purpose), keyHash(deputyPurpose(purpose), axis, axisValue));
    return { ...verdict, at: 'deputy' };
  }

  return {
    allowed: false, token: null, at: null, reason: 'counterUnreachable',
  };
}

/**
 * Give a slot back. Directed at whichever node issued it, which the caller knows
 * because the reservation said so - a release sent to the wrong node frees
 * nothing and leaves the real slot held until its lease expires.
 */
async function release(purpose, axis, axisValue, token, at) {
  if (!token) return;
  const effective = at === 'deputy' ? deputyPurpose(purpose) : purpose;
  const role = await localRole(purpose, axis, axisValue).catch(() => null);

  if ((at === 'counter' && role === 'counter') || (at === 'deputy' && role === 'deputy')) {
    limitCounterStore.release(effective, keyHash(effective, axis, axisValue), token);
    return;
  }

  const { counter, deputy } = await countersFor(purpose, axis, axisValue);
  const node = at === 'deputy' ? deputy : counter;
  if (!node || !node.ip) return;
  await axios
    .post(`http://${extractIp(node.ip)}:${extractPort(node.ip)}/flux/limitcounter/release`,
      { purpose: effective, key: keyHash(effective, axis, axisValue), token }, { timeout: askTimeoutMs() })
    .catch(() => {
      // The lease expires by itself; a lost release costs one lease-length of a
      // slot staying held, never a slot held forever.
      log.warn(`limitCounter - could not return a ${purpose} slot; it will expire on its lease`);
    });
}

/**
 * Tell the fleet a caller has started something, so the count outlives the node
 * holding it.
 *
 * Sent AFTER the slot was granted rather than instead of asking for it. Gossip
 * takes seconds to cross the mesh and a burst does not wait, so this could never
 * bound a burst - the counter does that. This bounds what a restart forgets.
 *
 * Carries the same hash the counter is keyed on, never the caller: the record
 * reaches every node, and an identity in it would broadcast who uses what.
 *
 * Capability-gated, so a node that does not understand the type is not sent it.
 * Fire-and-forget: a caller must not wait on a broadcast, and a lost record costs
 * accuracy after a restart, not correctness now.
 */
async function announce(purpose, axis, axisValue, sessionId, endsAtMs) {
  const record = {
    type: 'fluxlimitcounterrecord',
    version: 1,
    purpose,
    key: keyHash(purpose, axis, axisValue),
    sessionId,
    startedAt: Date.now(),
    endsAt: endsAtMs,
  };
  await limitCounterRecords.store(record).catch(() => {});
  await fluxCommunicationMessagesSender
    .broadcastMessageToAll(record, { requireCapability: 'limitCounterRecords' })
    .catch((error) => {
      log.warn(`limitCounter - could not announce a ${purpose} record: ${error.message}`);
    });
}

/**
 * Take in a record a peer announced. Stored by every node, not only the counter:
 * the key moves when a node leaves the network, and the node it moves to has to
 * find the history already there.
 */
async function acceptRecord(record) {
  if (!record || record.type !== 'fluxlimitcounterrecord') return false;
  const stored = await limitCounterRecords.store(record);
  if (!stored) return false;
  const role = await localRoleForKey(record.purpose, record.key).catch(() => null);
  if (role === 'counter') {
    await limitCounterRecords.reconcile(record.purpose, record.key).catch(() => {});
  }
  return true;
}

module.exports = {
  countersFor,
  countersForKey,
  localRole,
  localRoleForKey,
  reserve,
  release,
  deputyPurpose,
  keyHash,
  announce,
  acceptRecord,
};
