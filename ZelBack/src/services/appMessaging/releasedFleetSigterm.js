'use strict';

// ============================================================================
// RELEASED-FLEET COMPATIBILITY: DELETE ONCE THE NETWORK'S FLOOR VERSION IS V9.
//
// Released FluxOS (8.x) learns that a node stopped cleanly only from a signed
// `fluxnodesigterm` broadcast, which shortens that node's location rows to
// sigtermExpiryS (420 s); without it the rows live out locationTtlS (7500 s),
// and its apps are not placed elsewhere for up to two hours. v9 learns a stop
// from the close code on the held connection and reads nothing here.
//
// So while released nodes remain, a v9 node sends the broadcast when its
// machine shuts down, and passes on every copy it receives, so the message
// crosses v9 nodes to the released ones beyond them.
//
// Delete this module together with its three hooks, each marked
// "RELEASED-FLEET COMPATIBILITY":
//   - the send in nodeProcess.handleSigterm
//   - the relay registered for `fluxnodesigterm` in fluxCommunication
//   - the `fluxnodesigterm` case in fluxCommunicationUtils.broadcastTarget
// ============================================================================

const log = require('../../lib/log');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');
const appRecords = require('../appDatabase/appRecords');

// Released handleNodeSigtermMessage accepts a copy up to this old.
const MAX_AGE_MS = 240_000;

// The most the broadcast may add to a shutdown.
const SEND_BUDGET_MS = 2000;

/**
 * Broadcast `fluxnodesigterm` to every held peer, as released FluxOS does when
 * its machine shuts down: only from a node that holds apps, since a released
 * receiver acts only on a node it lists apps for. Bounded by SEND_BUDGET_MS and
 * never throws: the stop goes on whatever happens here.
 *
 * @returns {Promise<boolean>} whether it was sent
 */
async function announceShutdown() {
  const send = async () => {
    const hosted = await appRecords.hostedInstances().apps();
    if (!hosted.length) return false;
    const ip = await fluxNetworkHelper.getLocalSocketAddress();
    if (!ip) {
      log.warn('releasedFleetSigterm - no local address, fluxnodesigterm not sent');
      return false;
    }
    await fluxCommunicationMessagesSender.broadcastMessageToAll({
      type: 'fluxnodesigterm',
      version: 1,
      ip,
      broadcastedAt: Date.now(),
    });
    log.info(`releasedFleetSigterm - fluxnodesigterm sent for ${ip}`);
    return true;
  };

  let timer;
  const budget = new Promise((resolve) => {
    timer = setTimeout(() => resolve('budget'), SEND_BUDGET_MS);
  });
  try {
    const outcome = await Promise.race([send(), budget]);
    if (outcome === 'budget') {
      log.warn(`releasedFleetSigterm - fluxnodesigterm not sent within ${SEND_BUDGET_MS}ms, stopping without it`);
      return false;
    }
    return outcome;
  } catch (error) {
    log.warn(`releasedFleetSigterm - fluxnodesigterm not sent: ${error.message}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { announceShutdown, MAX_AGE_MS };
