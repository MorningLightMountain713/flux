/**
 * Ordering for stored soft-fork message rows.
 *
 * A row records where its message sits in the chain: the block height, and the
 * transaction's position within that block. Both are needed. Two messages can be
 * mined in one block, and which of them is in force depends on which came second
 * in the block — not on which of them this node wrote to the collection first,
 * which is what a query returns them in.
 *
 * The same pair orders the in-memory histories these rows rebuild, so a node that
 * restores from storage holds the state it would have held had it walked the
 * chain.
 */

/**
 * Sort rows into chain order in place, refusing any row that cannot be ordered.
 *
 * A row written before the position was recorded cannot be placed against
 * another message from its own block. Ordering it by whatever the query returned
 * would be the fork this ordering exists to close, so the rebuild stops and says
 * what to do about it.
 *
 * @param {Array<{height: number, txIndex: number, txid: string}>} rows
 * @param {string} collectionName - named in the refusal, so it says which to drop
 * @returns {Array} the same array, sorted
 * @throws {Error} if any row carries no position
 */
function inChainOrder(rows, collectionName) {
  for (const row of rows) {
    if (!Number.isInteger(row.txIndex)) {
      throw new Error(
        `${collectionName}: row ${row.txid} carries no txIndex, so it cannot be `
        + 'ordered against another message from the same block. It was stored before '
        + 'the position was recorded — drop the collection and let the chain scan '
        + 'rebuild it.',
      );
    }
  }
  return rows.sort((a, b) => a.height - b.height || a.txIndex - b.txIndex);
}

module.exports = { inChainOrder };
