'use strict';

const config = require('config');
const dbHelper = require('../dbHelper');
const decisionStore = require('./decisionStore');
const appRecords = require('../appDatabase/appRecords');
const { getSpecPolicy } = require('../utils/specLibs');
const { compareChainOrder } = require('../utils/chainOrder');
const log = require('../../lib/log');

/**
 * The voids: every UnclaimedPaymentMessage the scan recorded, as the
 * in-memory history the library keeps, built from the stored rows on every
 * rewind like the price histories and installed beside them (chainState).
 *
 * A void that reaches a payment, UnclaimedPaymentHistory.voidOf, voids its
 * hash: the payment record is marked, so hash sync stops asking peers for it
 * and the confirmed store refuses contents for it, and the hash's decision is
 * removed, so the decider decides the name again from that message, which the
 * rule refuses as unclaimed. A rewind that drops a void gives the hash back:
 * the record is unmarked and the decision removed again, so the name is
 * decided anew, as the design reads it.
 */

let history = null;

function collectionName() {
  return config.get('database.chainparams.collections.unclaimedPaymentMessages');
}

/**
 * The stored voids as the library's history, beside the live one. The live
 * state is untouched until `installUnclaimedPaymentState` swaps it in.
 * @returns {Promise<{unclaimedPaymentHistory: object}>}
 */
async function buildUnclaimedPaymentState() {
  const { UnclaimedPaymentHistory } = await getSpecPolicy();
  const built = new UnclaimedPaymentHistory();
  const database = dbHelper.databaseConnection().db(config.get('database.chainparams.database'));
  const docs = await dbHelper.findInDatabase(database, collectionName(), {}, { projection: { _id: 0 } });
  docs.sort(compareChainOrder);
  for (const doc of docs) {
    built.add(doc.message, doc.height, doc.txIndex);
  }
  return { unclaimedPaymentHistory: built };
}

/**
 * Make the built history the live one. Synchronous, so no reader sees it
 * half installed.
 * @param {{unclaimedPaymentHistory: object}} built
 */
function installUnclaimedPaymentState(built) {
  ({ unclaimedPaymentHistory: history } = built);
}

function getUnclaimedPaymentHistory() { return history; }

/**
 * Whether a recorded void reaches a payment: the bootstrap, which records the
 * voids before the payments, marks each payment record with it.
 * @param {string} hash the app message hash
 * @param {number} paymentHeight the payment's height
 * @returns {boolean}
 */
function isVoided(hash, paymentHeight) {
  return Boolean(history && history.voidOf(hash, paymentHeight));
}

async function paymentRecord(hash) {
  return appRecords.messages().payment(hash);
}

async function markVoided(hash, voided) {
  if (voided) await appRecords.messages().markVoided(hash);
  else await appRecords.messages().unmarkVoided([hash]);
}

/**
 * Applies a void the scan just recorded: when it reaches the payment it
 * names, the hash is marked voided and its decision removed, and the decider
 * is woken for it. A void for a payment this node has no record of, or
 * outside the payment's window, changes nothing.
 *
 * @param {object} message the parsed UnclaimedPaymentMessage
 * @param {number} height the void's height
 * @param {(hashes: string[]) => void} wake the decider's wake
 * @returns {Promise<boolean>} whether the hash was voided
 */
async function applyVoid(message, height, wake) {
  const { UnclaimedPaymentMessage: { voidsPayment } } = await getSpecPolicy();
  const record = await paymentRecord(message.hashHex);
  if (!record) return false;
  if (!voidsPayment(height, record.height)) {
    log.info(`unclaimedPayments - a void at ${height} does not reach the payment of ${message.hashHex} at ${record.height}`);
    return false;
  }
  await markVoided(message.hashHex, true);
  await decisionStore.undecide([message.hashHex]);
  log.info(`unclaimedPayments - ${message.hashHex} voided by the message at ${height}; its payment at ${record.height}`);
  wake([message.hashHex]);
  return true;
}

/**
 * On a rewind to a height: every hash the dropped voids named is judged again
 * by the voids that remain, and a hash no remaining void reaches is unmarked
 * and undecided, so the decider decides its name anew. Runs after the rows
 * above the height are gone and before the history is rebuilt, so the live
 * history still holds the dropped voids: they are read before the first
 * await, since the rebuild that follows swaps the history.
 *
 * @param {number} height
 * @param {(hashes: string[]) => void} wake the decider's wake
 * @returns {Promise<string[]>} the hashes given back
 */
async function onRewind(height, wake) {
  if (!history) return [];
  const entries = [...history.entries()];
  const dropped = entries.filter((entry) => entry.chainHeight >= height);
  const { UnclaimedPaymentMessage: { voidsPayment } } = await getSpecPolicy();
  const given = [];
  for (const hash of new Set(dropped.map((entry) => entry.message.hashHex))) {
    // eslint-disable-next-line no-await-in-loop
    const record = await paymentRecord(hash);
    if (!record || !record.voided) continue;
    const stillVoided = entries.some((entry) => entry.message.hashHex === hash
      && entry.chainHeight < height && voidsPayment(entry.chainHeight, record.height));
    if (stillVoided) continue;
    // eslint-disable-next-line no-await-in-loop
    await markVoided(hash, false);
    // eslint-disable-next-line no-await-in-loop
    await decisionStore.undecide([hash]);
    given.push(hash);
  }
  if (given.length) {
    log.info(`unclaimedPayments - a rewind to ${height} gave back ${given.length} hash(es): ${given.join(', ')}`);
    wake(given);
  }
  return given;
}

module.exports = {
  buildUnclaimedPaymentState,
  installUnclaimedPaymentState,
  getUnclaimedPaymentHistory,
  isVoided,
  applyVoid,
  onRewind,
};
