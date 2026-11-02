'use strict';

const log = require('../../lib/log');
const fluxEventBus = require('../utils/fluxEventBus');
const networkStateService = require('../networkStateService');
const peerIdentityService = require('../peerIdentityService');
const mastershipGrantGate = require('../appLifecycle/mastershipGrantGate');
const { extractIp } = require('../utils/socketAddressUtils');
const { nowMs } = require('../utils/monotonicClock');

// The peer fence: the syncthing side of an activeStandby master changing hands.
//
// When this node's grant replaces another holder, that node may still be
// writing - wedged, partitioned, or simply not yet told. Its data must not reach
// this node's copy, so its device is kept off the app's folders until it can
// show its copy cannot win: it holds none of the app's activeStandby components
// - nothing running, nothing committed to start, no folder sending - in an
// answer it signed for this call. A receiveonly folder's local changes carry an
// empty version vector and never win, so a folder that has stopped sending is
// the whole of what is asked.
//
// Declarative: the syncthing monitor consults fenceFor() every pass and keeps
// the folder's device list and the device's autoAcceptFolders in agreement with
// it, so a missed pass cannot forget the fence and syncthing's auto-accept
// cannot silently reverse it. A node that does not answer, or whose answer
// cannot be shown to be its own, stays fenced.

// app identity -> { outpoint, host, address, since }
const fences = new Map();

// app identity -> the lift ask in flight, so a fence costs one ask at a time
// however many of the app's folders consult it in a pass
const liftAsks = new Map();

/**
 * Fence the node a grant this node now holds replaced. Resolved to a host now:
 * the fence outlives the replaced node's list entry, and a fence that could no
 * longer name its target would lift by accident.
 * @param {string} identity The app's identity.
 * @param {string} replacedOutpoint `txhash:outidx` of the node replaced.
 */
function raiseFence(identity, replacedOutpoint) {
  const membership = networkStateService.membershipAt(networkStateService.membershipFingerprint()) ?? [];
  const node = membership.find((entry) => `${entry.txhash}:${entry.outidx}` === replacedOutpoint);
  if (!node) {
    log.warn(`syncthingPeerFence - replaced master ${replacedOutpoint} of ${identity} is not listed; nothing to fence`);
    return;
  }
  fences.set(identity, {
    outpoint: replacedOutpoint, host: extractIp(node.ip), address: node.ip, since: nowMs(),
  });
  log.warn(`syncthingPeerFence - fencing ${extractIp(node.ip)} out of ${identity}'s folders until it shows it holds none of them`);
  fluxEventBus.publish('syncthing:fenceRaised', {
    app: identity, replaced: replacedOutpoint, host: extractIp(node.ip),
  });
}

function liftFence(identity, fence, reason) {
  if (fences.get(identity) !== fence) return;
  fences.delete(identity);
  log.info(`syncthingPeerFence - fence on ${identity} lifted: ${reason}`);
  fluxEventBus.publish('syncthing:fenceLifted', { app: identity, reason });
}

/**
 * Asks the fenced node, over a challenge it must sign, which components it holds.
 * @param {string} identity
 * @param {object} fence
 * @param {string[]} names Every name the node may hold the app's activeStandby components under.
 * @returns {Promise<void>}
 */
async function askToLift(identity, fence, names) {
  const { IdentityVerdict, AnswerPurpose } = peerIdentityService;
  try {
    const asked = await peerIdentityService.askSigned(
      fence.address,
      '/apps/heldcomponents',
      AnswerPurpose.HELD_COMPONENTS,
    );
    if (asked.verdict !== IdentityVerdict.VERIFIED) return;
    const { held } = asked.answer;
    if (!Array.isArray(held) || names.some((name) => held.includes(name))) return;
    liftFence(identity, fence, 'the replaced node holds none of the app\'s components');
  } catch (error) {
    log.warn(`syncthingPeerFence - asking ${fence.host} about ${identity} failed, fence stands: ${error.message}`);
  }
}

/**
 * The standing fence for an app, or null. Consulting it asks the fenced node,
 * one ask at a time, whether it still holds any of the app's components.
 * @param {string} identity The app's identity.
 * @param {string[]} names Every name the fenced node may hold the app's
 *   activeStandby components under: each one's identifier and folder id.
 * @returns {{outpoint: string, host: string, address: string, since: number}|null}
 */
function fenceFor(identity, names) {
  const fence = fences.get(identity) ?? null;
  if (fence && !liftAsks.has(identity)) {
    const ask = askToLift(identity, fence, names).finally(() => liftAsks.delete(identity));
    liftAsks.set(identity, ask);
  }
  return fence;
}

mastershipGrantGate.onMasterReplaced(raiseFence);

/** Test seam: resolves once every lift ask in flight has settled. */
function liftAsksSettled() {
  return Promise.all([...liftAsks.values()]);
}

/** Test seam. */
function resetForTests() {
  fences.clear();
  liftAsks.clear();
}

module.exports = {
  fenceFor,
  raiseFence,
  liftAsksSettled,
  resetForTests,
};
