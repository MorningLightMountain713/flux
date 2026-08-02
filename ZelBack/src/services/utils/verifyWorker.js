const { parentPort } = require('worker_threads');
const bitcoinMessage = require('bitcoinjs-message');
const { pubKeyToAddr } = require('./fluxCryptoUtils');

const BTC_PUBKEY_HASH = '00';

// Every reply carries back the id it was sent with, and exactly one result per
// item. The pool matches replies to batches by that id and refuses a reply
// whose length disagrees, so neither an extra message nor a short result array
// can attach one batch's verdicts to another batch's signatures.
parentPort.on('message', ({ id, items }) => {
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
  parentPort.postMessage({ id, results });
});
