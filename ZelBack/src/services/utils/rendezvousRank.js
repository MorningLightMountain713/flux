const crypto = require('crypto');

// Rendezvous (highest-random-weight) node selection.
//
// Every node computes the same ranking for the same key from the same node list,
// having asked no one. That is the whole point: a ranking that needs agreement is
// a ranking that can disagree, and anything built on it inherits the disagreement.
//
// Its other relevant property is stability. Adding or removing one node moves only
// 1/M of the mapping, so a node whose list is a block stale ranks almost
// identically - the same members, give or take the boundary. List skew perturbs
// which nodes sit at the EDGE of a ranking, not the top of it, which is what makes
// it safe to derive an owner from position 0.

/**
 * One node's weight for one key.
 *
 * The node's outpoint identifies it, not its address: an address changes with a
 * router and would reshuffle every ranking for a reason that has nothing to do
 * with the node. `outidx` arrives from the daemon as a STRING despite the
 * typedef, so it is interpolated rather than compared numerically anywhere.
 *
 * @param {string} key the ranking key
 * @param {object} node a deterministic-list node
 * @returns {string} hex weight
 */
function weightFor(key, node) {
  return crypto
    .createHash('sha256')
    .update(`${key}|${node.txhash}|${node.outidx}`)
    .digest('hex');
}

/**
 * Nodes ranked for a key, heaviest first.
 *
 * @param {object[]} nodes candidate nodes
 * @param {string} key the ranking key — everything that should change the ranking
 *   belongs in it (purpose, axis, value, window), so two uses cannot collide
 * @returns {object[]} a new array, ranked
 */
function rankNodes(nodes, key) {
  return (nodes || [])
    .map((node) => ({ node, weight: weightFor(key, node) }))
    .sort((a, b) => (a.weight < b.weight ? 1 : -1))
    .map((scored) => scored.node);
}

module.exports = {
  weightFor,
  rankNodes,
};
