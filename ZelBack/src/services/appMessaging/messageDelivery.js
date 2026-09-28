'use strict';

const appsRepository = require('../appDatabase/appsRepository');
const confirmedMessageStore = require('./confirmedMessageStore');
const messageStore = require('./messageStore');
const messageVerifier = require('./messageVerifier');
const fluxCommunication = require('../fluxCommunication');

/**
 * Takes the contents of a paid app message this node is missing, from anyone.
 *
 * Needs no authentication: the contents must be for a hash this node's scan
 * recorded a payment for and holds no message for, and pass the checks every
 * route stores through, so nothing unpaid enters by it. A message it stores is
 * announced to this node's peers, which fetch and relay it in turn.
 *
 * @param {object} contents The message as signed.
 * @returns {Promise<{outcome: 'stored'|'held'|'unpaid'|'refused', reason?: string}>}
 */
async function deliverMessage(contents) {
  if (!contents || typeof contents !== 'object' || typeof contents.hash !== 'string') {
    return { outcome: 'refused', reason: 'not an app message' };
  }
  const { hash } = contents;
  const records = await confirmedMessageStore.paymentRecords([hash]);
  if (!records.has(hash)) return { outcome: 'unpaid' };
  if (await appsRepository.getPermanentMessage(hash)) return { outcome: 'held' };

  const intake = await messageStore.storeAppTemporaryMessage(contents);
  if (intake instanceof Error) return { outcome: 'refused', reason: intake.message };
  if (!await messageVerifier.checkAndRequestApp(hash, 2)) {
    return { outcome: 'refused', reason: 'not stored' };
  }
  await fluxCommunication.announceAppMessage(contents);
  return { outcome: 'stored' };
}

module.exports = { deliverMessage };
