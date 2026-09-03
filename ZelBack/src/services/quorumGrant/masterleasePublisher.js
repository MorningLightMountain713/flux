'use strict';

const fluxNetworkHelper = require('../fluxNetworkHelper');
const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');
const messageStore = require('../appMessaging/messageStore');
const log = require('../../lib/log');

// Publishing the grant (doc §9): the winner tells the world, once granted —
// how standbys learn the master without polling, how FDM will read intent,
// and how a re-pinned committee adopts a founding it never granted. The
// record is advisory to everyone who reads it; the SAFETY lives in the
// registers and the fences, so a lost publish costs freshness, never
// correctness.

/**
 * Publish one grant as a `fluxmasterlease` broadcast, and store it locally —
 * a node is its own first subscriber, and its consumers must not depend on
 * the network echoing its own record back.
 *
 * @param {object} grant
 * @param {string} grant.key resource key, `<app>/<role>`
 * @param {string} grant.grantee grantee outpoint
 * @param {number} grant.epoch
 * @param {'held'|'oneshot'} grant.mode
 * @param {string} grant.fingerprint committee membership basis
 * @param {number} [grant.generation] the owner's re-roll counter the grant
 *   was written under; orders ahead of the epoch, so a re-rolled world's
 *   record replaces the retired one whatever epoch the old world reached
 * @param {number} [grant.ttlMs] held term duration; drives the record's expiry
 * @param {{chain: object[]}} [grant.roster] the committee's quorum-signed
 *   seat changes atop the generation's base — self-verifying, so the record
 *   is proof enough for any reader
 * @param {boolean} [grant.released] the row was given back or vacated: the
 *   record supersedes the founding's at the same epoch and names it free
 * @returns {Promise<boolean>} whether the record went out
 */
async function publishMasterlease(grant) {
  try {
    const slash = grant.key.indexOf('/');
    const appName = grant.key.slice(0, slash);
    const role = grant.key.slice(slash + 1);

    const ip = await fluxNetworkHelper.getLocalSocketAddress();
    if (!ip) return false;

    const message = {
      type: 'fluxmasterlease',
      version: 1,
      ip,
      appName,
      role,
      grantee: grant.grantee,
      epoch: grant.epoch,
      mode: grant.mode,
      generation: grant.generation ?? 0,
      fingerprint: grant.fingerprint,
      ...(grant.mode === 'held' ? { ttlMs: grant.ttlMs } : {}),
      ...(grant.roster ? { roster: grant.roster } : {}),
      // an ordinal given back or reclaimed: same row, same epoch, a newer
      // broadcast, and the flag every reader of the ordinal- prefix skips
      ...(grant.released === true ? { released: true } : {}),
      broadcastedAt: Date.now(),
    };

    const signed = await fluxCommunicationMessagesSender.broadcastMessageToAll(message);
    const envelope = signed
      ? {
        version: signed.version, timestamp: signed.timestamp, pubKey: signed.pubKey, signature: signed.signature,
      }
      : null;
    await messageStore.storeAppStateEvent(
      messageStore.APP_STATE_EVENT_TYPES.MASTERLEASE,
      { message, envelope, announcer: messageStore.LOCAL_ANNOUNCER },
    );
    return true;
  } catch (error) {
    log.warn(`masterlease publish failed for ${grant.key}: ${error.message}`);
    return false;
  }
}

module.exports = {
  publishMasterlease,
};
