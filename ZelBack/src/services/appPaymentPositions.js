'use strict';

const config = require('config');

const daemonServiceUtils = require('./daemonService/daemonServiceUtils');

/**
 * Every transaction paying an app payment address in a height range, with its
 * position in its block, from one address-index call.
 *
 * `blockindex` on a delta record is the transaction's position within its
 * block (fluxd's CAddressIndexKey.txindex); `index` on the same record is the
 * input or output index within the transaction.
 *
 * @param {number} start
 * @param {number} end
 * @returns {Promise<Map<string, {height: number, txIndex: number}>>} by txid
 */
async function appPaymentPositions(start, end) {
  // Every payment-collection address (the dev receiver is only in the array on dev builds).
  const appAddresses = config.get('fluxapps.appPaymentAddresses').map((entry) => entry.address);
  const result = await daemonServiceUtils.executeCall('getaddressdeltas', [{ addresses: appAddresses, start, end }]);
  if (result.status !== 'success') {
    throw new Error(`getaddressdeltas failed: ${result.data.message || result.data}`);
  }
  const positions = new Map();
  for (const delta of result.data) {
    if (delta.satoshis > 0 && !positions.has(delta.txid)) {
      if (!Number.isInteger(delta.blockindex)) {
        throw new Error(`getaddressdeltas returned no blockindex for ${delta.txid}`);
      }
      positions.set(delta.txid, { height: delta.height, txIndex: delta.blockindex });
    }
  }
  return positions;
}

module.exports = { appPaymentPositions };
