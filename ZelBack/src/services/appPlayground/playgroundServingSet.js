const config = require('config');
const log = require('../../lib/log');
const fluxCommunicationUtils = require('../fluxCommunicationUtils');
const generalService = require('../generalService');
const { rankNodes } = require('../utils/rendezvousRank');

// Which nodes may serve a given caller, decided without asking anyone.
//
// Every other control on this feature is enforced from a gossiped record, so
// every other control has a window between a session starting and the fleet
// knowing about it. A caller who sends one request to every node at the same
// moment is inside that window on all of them at once: each node decides alone,
// having heard nothing, and each says yes. The per-node duty cycle does not help
// - it is identity-blind, so it caps each node at its own share and caps one
// caller across the fleet at nothing.
//
// The cost of that is not compute. It is that one actor can take the fleet's
// whole playground capacity in a single burst, hold it for a session, and repeat.
//
// So the caller does not choose the node: their identity and the current window
// do. Every node computes the same answer from data it already has, and a node
// outside the set refuses locally. NOTHING PROPAGATES, so there is nothing for a
// burst to outrun.

// Rendezvous (highest-random-weight) selection, the same construction
// DETERMINISTIC_PLACEMENT.md uses for app placement, keyed differently. Its
// relevant property here is stability: adding or removing one node moves only
// 1/M of the mapping, so a node whose list is a block stale computes almost the
// same set - the same members, give or take the boundary. Skew perturbs which
// nodes sit at the EDGE of a set, not how big the set is.
const AXIS = Object.freeze({
  IDENTITY: 'identity',
  ADDRESS: 'address',
});

// Matched case-insensitively against the node list's own spelling, which is
// upper case ("CUMULUS"/"NIMBUS"/"STRATUS") and NOT the daemon's legacy
// basic/super/bamf that generalService.nodeTier still maps from.
const SERVING_TIERS = Object.freeze(['NIMBUS', 'STRATUS']);

function setSize() {
  return config.fluxapps.playgroundServingSetSize ?? 32;
}

function windowMs() {
  return config.fluxapps.playgroundServingSetWindowMs ?? 24 * 60 * 60 * 1000;
}

/**
 * Whether the address axis is enforced.
 *
 * OFF until the node can see who is actually calling it. A browser reaches a
 * node through FDM, so the socket peer is the load balancer - and keying a
 * serving set on that would map EVERY caller arriving through FDM to the same
 * handful of nodes, making the feature unusable for everyone else. It needs
 * FDM to forward the client address and FluxOS to resolve it (the plan's §5a).
 * Turning this on before then is not a weaker control, it is an outage.
 */
function addressAxisEnabled() {
  return config.fluxapps.playgroundServingSetAddressAxis === true;
}

/**
 * The window a moment falls in.
 *
 * Wall clock, deliberately, and this is the one place the monotonic-clock rule
 * does not apply: a monotonic reading measures elapsed time on ONE machine and
 * by construction cannot agree with another's. What is needed here is a shared
 * coordinate, and every node's wall clock is disciplined to the same one. At a
 * 24 h window a node's drift would have to be hours to land it in a different
 * window, and the consequence even then is a different set rather than a wrong
 * one - the bound holds either way.
 */
function windowIndex(nowMs = Date.now()) {
  return Math.floor(nowMs / windowMs());
}

/**
 * The ranking key for one caller in one window. Everything that should move a
 * caller's set belongs in it and nothing else does.
 */
function rankKey(axis, axisValue, window) {
  return `${axis}|${axisValue}|${window}`;
}

/**
 * The nodes that serve one caller this window, best weight first.
 *
 * Filtered to the tiers that can run a session at all, because an unfiltered set
 * would spend most of its places on nodes that would refuse for their own
 * reasons. It is NOT filtered on Arcane: that is an attestation rather than
 * chain data, so no node can compute another's, and a set that cannot be
 * computed identically everywhere is not a set. Those places are simply spent -
 * which is what the set being larger than the budget pays for.
 *
 * @param {string} axisValue - the FluxID, or the resolved client address
 * @param {object} [options]
 * @param {string} [options.axis] - AXIS.IDENTITY (default) or AXIS.ADDRESS
 * @param {number} [options.now] - epoch ms, for tests
 * @returns {Promise<Array<object>>} up to setSize() Fluxnodes
 */
async function servingSet(axisValue, options = {}) {
  const axis = options.axis ?? AXIS.IDENTITY;
  const window = windowIndex(options.now);

  const nodes = await fluxCommunicationUtils.deterministicFluxList();
  const eligible = nodes.filter(
    (node) => node.tier && SERVING_TIERS.includes(String(node.tier).toUpperCase()),
  );

  return rankNodes(eligible, rankKey(axis, axisValue, window)).slice(0, setSize());
}

/**
 * Whether THIS node is one of the caller's.
 *
 * Fails closed. A node that cannot identify itself, or cannot read the node
 * list, cannot show it belongs in the set - and admitting on an unanswered
 * question is how a bound stops being one.
 *
 * @param {string} axisValue
 * @param {object} [options] - as servingSet
 * @returns {Promise<{serves: boolean, candidates: string[]}>} candidates are the
 *   addresses that DO serve, so a refusal can say where to go instead
 */
async function servesLocalNode(axisValue, options = {}) {
  try {
    const set = await servingSet(axisValue, options);
    if (!set.length) return { serves: false, candidates: [] };

    const collateral = await generalService.obtainNodeCollateralInformation();
    const serves = set.some(
      (node) => node.txhash === collateral.txhash
        && String(node.outidx) === String(collateral.txindex),
    );

    return { serves, candidates: set.map((node) => node.ip).filter(Boolean) };
  } catch (error) {
    log.warn(`playground: could not decide the serving set: ${error.message}`);
    return { serves: false, candidates: [] };
  }
}

module.exports = {
  AXIS,
  SERVING_TIERS,
  addressAxisEnabled,
  windowIndex,
  servingSet,
  servesLocalNode,
};
