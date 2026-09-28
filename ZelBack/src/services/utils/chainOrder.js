'use strict';

/**
 * Chain order: the order the chain gives every node, so every node that orders
 * by it agrees. An entry's place is its block height, its transaction's position
 * in the block, and, for a transaction carrying several messages, the message's
 * output within it. The sender's timestamp and the order this node received or
 * stored entries play no part.
 */

/**
 * Whether an entry carries the positions chain order needs.
 * @param {{height?: number, txIndex?: number}} entry
 * @returns {boolean}
 */
function isPositioned(entry) {
  return Number.isInteger(entry?.height) && Number.isInteger(entry?.txIndex);
}

/**
 * Compares two positioned entries by chain order, for Array.prototype.sort.
 * @param {{height: number, txIndex: number, vout?: number}} a
 * @param {{height: number, txIndex: number, vout?: number}} b
 * @returns {number} negative when `a` comes first
 */
function compareChainOrder(a, b) {
  return a.height - b.height || a.txIndex - b.txIndex || (a.vout ?? 0) - (b.vout ?? 0);
}

module.exports = { compareChainOrder, isPositioned };
