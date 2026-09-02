'use strict';

// Mesh ordinals as grants. An ordinal (db-0, db-1, …) is one node's identity
// in an app's mesh, shared by every component that node hosts, and it is a
// write-once grant on the app's founding committee: decided exactly once,
// released by its holder on uninstall, vacated by the holder's node-down
// certificate. Nobody arbitrates a name; the register decided it.
//
// Two rules the scan model pinned (formal/ordinal-scan): the lowest free
// ordinal is found by probing the register per ordinal, never by reading the
// synced holders record — the record can lag a release, the probe cannot,
// and a stale reader leaves a hole in a space that must be dense; and a
// standby re-runs the scan every reconcile pass, so a vacancy that opened
// after its last scan is filled on the next one. Names, by contrast, come
// from the record: a lagging entry is a temporarily unknown name, never a
// collision.

const generalService = require('../generalService');
const seam = require('./ordinalRegisterSeam');
const meshDerivation = require('./meshDerivation');

const CLAIM = Object.freeze({
  GRANTED: 'granted',
  STANDBY: 'standby',
  WAIT: 'wait',
});

async function ownOutpoint() {
  const collateral = await generalService.obtainNodeCollateralInformation();
  return `${collateral.txhash}:${collateral.txindex}`;
}

function cap(instances) {
  return Number.isInteger(instances) && instances > 0 ? instances : 0;
}

/**
 * The joiner's scan: probe ordinals upward from 0 and found the first free
 * one. An ordinal the register already names this node for is this node's
 * (a grant is durable). A found can still lose to a concurrent founder — the
 * register decides once — and the scan moves on. An undecided probe or a
 * waiting register is a wait: nothing is assumed free.
 *
 * @param {string} appName
 * @param {number} instances the spec's instance count — the ordinal space
 * @returns {Promise<{state: string, ordinal?: number|null, retryAfterMs?: number, reason?: string}>}
 *   state is a CLAIM
 */
async function claimOrdinal(appName, instances) {
  const space = cap(instances);
  if (space === 0) return { state: CLAIM.STANDBY, ordinal: null };
  const me = await ownOutpoint();
  for (let ordinal = 0; ordinal < space; ordinal += 1) {
    // eslint-disable-next-line no-await-in-loop
    const probe = await seam.probeOrdinal(appName, ordinal);
    if (!probe.decided) return { state: CLAIM.WAIT, reason: 'undecided' };
    if (probe.holder === me) return { state: CLAIM.GRANTED, ordinal };
    if (probe.holder === null) {
      // eslint-disable-next-line no-await-in-loop
      const ask = await seam.askOrdinal(appName, ordinal);
      if (ask.answer === 'yes') return { state: CLAIM.GRANTED, ordinal };
      if (ask.answer === 'wait') {
        return {
          state: CLAIM.WAIT,
          ...(ask.retryAfterMs !== undefined ? { retryAfterMs: ask.retryAfterMs } : {}),
          ...(ask.reason !== undefined ? { reason: ask.reason } : {}),
        };
      }
    }
  }
  return { state: CLAIM.STANDBY, ordinal: null };
}

// The return re-probe, the register model's obligation on the consumer: a
// node back from a partition holds a record that may have been superseded
// while it was cut — its ordinal vacated and granted to another — so the
// record's answer for its OWN ordinal is not trusted until a quorum confirms
// it. Each return raises the epoch; each app's name is re-probed once per
// epoch; an undecided or contrary quorum leaves the node a standby until the
// next pass, or until the record catches up and names it no longer.
let returnEpoch = 0;
const verifiedEpoch = new Map(); // appName → the epoch at which a quorum confirmed the own ordinal

function noteReturnFromUnreachability() {
  returnEpoch += 1;
}

/**
 * The ordinal the synced record names this node for, or null: a standby, a
 * grant the record has not carried here yet, or a name a returning node has
 * not yet had confirmed by the committee.
 * @param {string} appName
 * @returns {Promise<number|null>}
 */
async function ownOrdinal(appName) {
  const me = await ownOutpoint();
  const holders = await seam.ordinalHolders(appName);
  const mine = [...holders.entries()].find(([, holder]) => holder === me);
  if (!mine) return null;
  const [ordinal] = mine;
  if ((verifiedEpoch.get(appName) ?? 0) >= returnEpoch) return ordinal;
  const probe = await seam.probeOrdinal(appName, ordinal);
  if (!probe.decided || probe.holder !== me) return null;
  verifiedEpoch.set(appName, returnEpoch);
  return ordinal;
}

function nodeIdOf(outpoint) {
  return meshDerivation.nodeId(outpoint);
}

/**
 * Every recorded holder's ordinal by node id, for the snapshot's names and
 * SRV feed. Ordinals outside the spec's space are ignored.
 * @param {string} appName
 * @param {number} instances
 * @returns {Promise<Map<string, number>>} nodeId → ordinal
 */
async function holdersByNode(appName, instances) {
  const space = cap(instances);
  const holders = await seam.ordinalHolders(appName);
  const byNode = new Map();
  holders.forEach((holder, ordinal) => {
    if (Number.isInteger(ordinal) && ordinal >= 0 && ordinal < space) {
      byNode.set(nodeIdOf(holder), ordinal);
    }
  });
  return byNode;
}

/**
 * Release the ordinal the record names this node for — on uninstall, never
 * on a restart. Refused when the record names nothing of this node's.
 * @param {string} appName
 * @returns {Promise<{released: boolean, ordinal: number|null, reason?: string}>}
 */
async function releaseOrdinal(appName) {
  const ordinal = await ownOrdinal(appName);
  if (ordinal === null) return { released: false, ordinal: null, reason: 'none_held' };
  const result = await seam.releaseOrdinal(appName, ordinal);
  verifiedEpoch.delete(appName);
  return {
    released: result.released === true,
    ordinal,
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
  };
}

module.exports = {
  CLAIM,
  claimOrdinal,
  ownOrdinal,
  noteReturnFromUnreachability,
  holdersByNode,
  releaseOrdinal,
  nodeIdOf,
};
