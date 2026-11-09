// App payments as the chain carries them, for a fleet whose nodes record them
// from the daemon's address index (createTestEnv's `addressIndex`, with
// `unscanned`): each payment's delta under the address it paid at its height,
// and its verbose transaction, paying that address and carrying the message
// hash in its last output.
import { Chain, appPaymentAddress } from '@runonflux/flux-spec';

// The hash as a payment's last output carries it: OP_RETURN and the hash's ASCII text in hex.
const opReturn = (hash) => `OP_RETURN ${Buffer.from(hash, 'ascii').toString('hex')}`;

/**
 * The daemon's address index for these payments. Within a block each payment
 * takes its position in the order given, unless it names its own txIndex.
 * @param {Array<{hash: string, txid: string, height: number, value: number, txIndex?: number}>} payments
 * @returns {{deltas: object[], transactions: object[]}}
 */
export function addressIndexOf(payments) {
  const nextAtHeight = new Map();
  const deltas = [];
  const transactions = [];
  for (const payment of payments) {
    const blockindex = Number.isInteger(payment.txIndex) ? payment.txIndex : (nextAtHeight.get(payment.height) ?? 0);
    nextAtHeight.set(payment.height, Math.max(nextAtHeight.get(payment.height) ?? 0, blockindex + 1));
    const address = appPaymentAddress(Chain.HARNESS, payment.height);
    deltas.push({
      satoshis: payment.value, txid: payment.txid, index: 0, blockindex, height: payment.height, address,
    });
    transactions.push({
      txid: payment.txid,
      version: 1,
      locktime: 0,
      height: payment.height,
      vin: [],
      vout: [
        { value: payment.value / 1e8, valueSat: payment.value, n: 0, scriptPubKey: { addresses: [address] } },
        { value: 0, valueSat: 0, n: 1, scriptPubKey: { asm: opReturn(payment.hash) } },
      ],
    });
  }
  return { deltas, transactions };
}

/**
 * The message as its owner signed it, without anything a store added: what a
 * node is handed.
 * @param {object} message
 * @returns {object}
 */
export function signedMessage(message) {
  const {
    type, version, appSpecifications, hash, timestamp, signature,
  } = message;
  return {
    type, version, appSpecifications, hash, timestamp, signature,
  };
}
