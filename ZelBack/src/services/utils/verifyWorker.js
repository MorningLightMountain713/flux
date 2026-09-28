'use strict';

const { parentPort } = require('worker_threads');
const bitcoinMessage = require('bitcoinjs-message');
const { load } = require('@runonflux/flux-spec-cjs');
const { pubKeyToAddr } = require('./fluxCryptoUtils');
const { nativeRecoveryCurve } = require('./nativeRecoveryCurve');

const BTC_PUBKEY_HASH = '00';

const library = load();

/**
 * @param {Array<{messageToVerify: string, pubKey: string, signature: string}>} items
 * @returns {boolean[]}
 */
function verify(items) {
  const results = new Array(items.length);
  for (let i = 0; i < items.length; i++) {
    const { messageToVerify, pubKey, signature } = items[i];
    try {
      let address = pubKey;
      if (pubKey.length > 36) {
        address = pubKeyToAddr(pubKey, BTC_PUBKEY_HASH);
      }
      results[i] = bitcoinMessage.verify(messageToVerify, address, signature);
    } catch {
      results[i] = false;
    }
  }
  return results;
}

/**
 * Every address each item's signature recovers to, over each of its payloads.
 * The items are messages the chain carries, so a signature is judged on who
 * signed it and not on how it is spelled.
 *
 * @param {Array<{payloads: string[], signature: string}>} items
 * @returns {Promise<string[][]>}
 */
async function recover(items) {
  const { recoverSigners } = await library;
  const options = { allowLegacyEncoding: true, curve: nativeRecoveryCurve };
  const results = new Array(items.length);
  for (let i = 0; i < items.length; i++) {
    const { payloads, signature } = items[i];
    const found = new Set();
    for (const payload of payloads) {
      // eslint-disable-next-line no-await-in-loop
      for (const address of await recoverSigners(payload, signature, options)) found.add(address);
    }
    results[i] = [...found];
  }
  return results;
}

// Every reply carries back the id it was sent with, and exactly one result per
// item. The pool matches replies to batches by that id and refuses a reply
// whose length disagrees, so neither an extra message nor a short result array
// can attach one batch's verdicts to another batch's signatures. A batch this
// worker cannot compute at all is answered with its error, never with results.
const operations = { verify, recover };

parentPort.on('message', async ({ id, op = 'verify', items }) => {
  try {
    const operation = operations[op];
    if (!operation) throw new Error(`no operation '${op}'`);
    const results = await operation(items);
    parentPort.postMessage({ id, results });
  } catch (error) {
    parentPort.postMessage({ id, error: error.message });
  }
});
