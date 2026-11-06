'use strict';

const fluxEventBus = require('./utils/fluxEventBus');
const log = require('../lib/log');
const { nowMs } = require('./utils/monotonicClock');

// Node DOS (denial-of-service) state: this FluxNode's aggregate health/eligibility
// score. Contributed to by the availability / IP-change / collision / fluxbench
// monitors and read by the eligibility, verification and app-spawn paths.
//
// A sticky DOS declares the node unfit for the apps it already runs. It is not moved
// by setDosMessage(null) / setDosStateValue() from the availability checks, and takes
// precedence in getDosMessage(), getDosData() and isNodeDos() over the counted state.

let dosState = 0; // we can start at bigger number later
let dosMessage = null;

// The messages of the availability check that reaching this node ends. There is one
// message for every reason a node can be out of service, so each check clears only
// one it set itself.
const UNREACHABLE_MESSAGE = 'Flux communication is limited, other nodes on the network cannot reach yours through API calls';
const UNAVAILABLE_MESSAGE = 'Flux is not available for outside communication';
const BENCH_PUBLIC_IP_MESSAGE = 'Error getting publicIp from FluxBench';
const REACHABILITY_MESSAGES = [UNREACHABLE_MESSAGE, UNAVAILABLE_MESSAGE, BENCH_PUBLIC_IP_MESSAGE];
// Set while this node knows no address of its own, and ended when it learns one.
const IP_DETECTION_FAILED_MESSAGE = 'Flux IP detection failed';

// What the availability check has counted against this node, apart from the score
// the other checks share: the asks no peer answered as reachable, and the time it has
// been reachable with too few peer connections. The node's DOS state is the two added
// to the shared score (effectiveDosState), so a check that resets the shared score
// leaves these standing, and the availability check takes off only its own. The
// message it set is kept to end only that one.
let unreachablePoints = 0;
let shortfallPoints = 0;
let availabilityMessage = null;

// When this node last found itself reachable with too few peer connections, while it
// keeps doing so: null otherwise.
let peerShortfallSeenAt = null;

// Who may take this node out of service permanently. An owner is an IDENTITY, not a
// message: the reason is what an operator reads, and the owner is what a release is
// checked against. Adding a feature that DOSes the node means adding a value here,
// which is the point - an unknown owner is refused rather than accepted as a new one.
const StickyDosOwner = Object.freeze({
  RESIDENTIAL_DOS: 'residentialDos',
  APP_TAMPERING: 'appTampering',
  PEER_SET_STABILITY: 'peerSetStability',
  NODEJS_FLOOR: 'nodejsFloor',
  DOCKER_FLOOR: 'dockerFloor',
  MONGODB_FLOOR: 'mongodbFloor',
  CGROUP_FLOOR: 'cgroupFloor',
  HOST_STALL: 'hostStall',
});

// owner -> reason. One slot cannot express two owners: a second verdict either
// overwrites the first, stranding an owner that can no longer recognise - and so never
// release - its own DOS, or is dropped, and the node returns to service on the first
// owner's release for a condition that never lifted. The node is out of service while
// any owner holds it.
const stickyDosHolds = new Map();

// A hold is a verdict rather than a score: an owner holds the node out of service or
// it does not, and this is the value the enforcing readers test.
const STICKY_DOS_STATE = 100;

// Fired once each time the effective state crosses the limit (isNodeDos goes
// false → true); the node's self-defence removes its apps on it. In-process,
// because the event bus below feeds SSE only and nothing can subscribe to it.
const nodeDosListeners = [];
let wasNodeDos = false;

/**
 * Emits the current effective DOS state on the event bus (SSE observability).
 * Every mutator calls this so observers see the true node DOS status, including
 * sticky precedence. Also the one place the limit crossing is observed.
 */
function publishChanged() {
  fluxEventBus.publish('dos:changed', getDosData());
  const nowNodeDos = isNodeDos();
  if (nowNodeDos && !wasNodeDos) {
    for (const cb of nodeDosListeners) {
      try { cb(); } catch (error) { log.error(`nodeDosState - listener failed: ${error.message}`); }
    }
  }
  wasNodeDos = nowNodeDos;
}

/**
 * Registers a callback for the moment the node enters DOS state (the effective
 * value reaching the limit). Not fired again while it stays there; fired again
 * after it clears and re-crosses.
 * @param {function} callback
 */
function onNodeDos(callback) {
  nodeDosListeners.push(callback);
}

/**
 * Getter for the raw dosState value (ignores sticky).
 * @returns {number} dosState
 */
function getDosStateValue() {
  return dosState;
}

/**
 * Setter for dosState. Emits dos:changed.
 * @param {number} value New dosState
 */
function setDosStateValue(value) {
  dosState = value;
  publishChanged();
}

/**
 * Increments dosState by a delta. Emits dos:changed.
 * @param {number} delta Amount to add
 */
function addDosState(delta) {
  dosState += delta;
  publishChanged();
}

/**
 * Setter for the regular dosMessage.
 * @param {string} message New message
 */
function setDosMessage(message) {
  dosMessage = message;
  publishChanged();
}

/**
 * Ends the node's DOS when the message standing is one `owns` recognises.
 * @param {function(string): boolean} owns
 * @returns {void}
 */
function releaseDosOwnedBy(owns) {
  if (!dosMessage || !owns(dosMessage)) return;
  dosState = 0;
  dosMessage = null;
  publishChanged();
}

/**
 * Counts `points` against reaching this node.
 * @param {number} points
 * @returns {void}
 */
function countUnreachable(points) {
  unreachablePoints += points;
  publishChanged();
}

/**
 * Counts `perMinute` for each minute this node has been reachable with too few peer
 * connections, and one minute's worth the first time.
 * @param {number} perMinute
 * @returns {void}
 */
function countPeerShortfall(perMinute) {
  const now = nowMs();
  const minutes = peerShortfallSeenAt === null ? 1 : (now - peerShortfallSeenAt) / 60_000;
  peerShortfallSeenAt = now;
  shortfallPoints += perMinute * minutes;
  publishChanged();
}

/**
 * Sets `message` as the availability check's, when no message stands or `replace`
 * says this one outranks the one standing.
 * @param {string} message
 * @param {{replace?: boolean}} [options]
 * @returns {void}
 */
function holdAvailabilityDos(message, { replace = false } = {}) {
  if (dosMessage && !replace) return;
  availabilityMessage = message;
  dosMessage = message;
  publishChanged();
}

/**
 * Ends what the availability check counted against reaching this node, and the
 * message it sets for that if it is the one standing: the node was reached.
 * @returns {void}
 */
function releaseUnreachable() {
  unreachablePoints = 0;
  if (REACHABILITY_MESSAGES.includes(dosMessage)) {
    availabilityMessage = null;
    dosMessage = null;
  }
  publishChanged();
}

/**
 * Whether the availability check has counted too few peer connections.
 * @returns {boolean}
 */
function peerShortfallStands() {
  return peerShortfallSeenAt !== null || shortfallPoints !== 0;
}

/**
 * Ends what the availability check counted for too few peer connections, and its
 * message if that is the one standing: the node has enough.
 * @returns {void}
 */
function releaseShortfall() {
  shortfallPoints = 0;
  peerShortfallSeenAt = null;
  if (dosMessage && dosMessage === availabilityMessage && !REACHABILITY_MESSAGES.includes(dosMessage)) {
    availabilityMessage = null;
    dosMessage = null;
  }
  publishChanged();
}

/**
 * Forgets what the availability check counted and the message it set, as a DOS state
 * set from outside does.
 * @returns {void}
 */
function resetAvailabilityDos() {
  unreachablePoints = 0;
  shortfallPoints = 0;
  peerShortfallSeenAt = null;
  availabilityMessage = null;
}

/**
 * Getter for the raw regular dosMessage (ignores sticky).
 * @returns {string|null} dosMessage
 */
function getRawDosMessage() {
  return dosMessage;
}

/**
 * Why the node is out of service, or null when no owner holds it. Every reason, not
 * an arbitrary one: naming one of two would send an operator to lift a condition that
 * would not return the node to service.
 * @returns {string|null}
 */
function getStickyDosMessage() {
  if (!stickyDosHolds.size) return null;
  return [...stickyDosHolds.values()].join('; ');
}

/**
 * Getter for the effective dosMessage: every sticky reason if any owner holds the
 * node, otherwise the counted one.
 * @returns {string|null} dosMessage
 */
function getDosMessage() {
  return getStickyDosMessage() || dosMessage;
}

/**
 * Take this node out of service for as long as one owner says so. Idempotent per
 * owner.
 * @param {string} owner A StickyDosOwner value. An unknown one throws: it is a caller
 *   that was never given an identity, and accepting it would create a DOS nothing can
 *   ever release.
 * @param {string} reason What an operator reads, and what is reported.
 */
function setStickyDos(owner, reason) {
  if (!Object.values(StickyDosOwner).includes(owner)) {
    throw new Error(`setStickyDos: unknown owner ${owner}`);
  }
  if (stickyDosHolds.get(owner) === reason) return;
  stickyDosHolds.set(owner, reason);
  log.error(`Sticky DOS set by ${owner}: ${reason}`);
  publishChanged();
}

/**
 * Release one owner's verdict. Every other owner's stands, and the node stays out of
 * service until all of them have released - so a feature clearing its own condition
 * can never speak for one it knows nothing about.
 * @param {string} owner A StickyDosOwner value.
 */
function clearStickyDos(owner) {
  const reason = stickyDosHolds.get(owner);
  if (reason === undefined) return;
  stickyDosHolds.delete(owner);
  log.info(`Sticky DOS cleared by ${owner} (was: ${reason})`);
  publishChanged();
}

/**
 * @param {string} owner A StickyDosOwner value.
 * @returns {boolean} True while that owner holds this node out of service.
 */
function isStickyDosHeldBy(owner) {
  return stickyDosHolds.has(owner);
}

/** The DOS state a reader sees: the verdict while any owner holds it, the count otherwise. */
function effectiveDosState() {
  if (stickyDosHolds.size) return STICKY_DOS_STATE;
  const availabilityPoints = unreachablePoints + shortfallPoints;
  return availabilityPoints ? dosState + availabilityPoints : dosState;
}

/**
 * Whether the node is in a DOS state (effective value, sticky takes precedence).
 * @returns {boolean}
 */
function isNodeDos() {
  return effectiveDosState() >= 100;
}

/**
 * Effective DOS data (sticky takes precedence), as consumed by the
 * /flux/dosstate endpoint and the node eligibility checks.
 * @returns {{dosState: number, dosMessage: string|null}}
 */
function getDosData() {
  return {
    dosState: effectiveDosState(),
    dosMessage: getDosMessage(),
  };
}

module.exports = {
  onNodeDos,
  getDosStateValue,
  setDosStateValue,
  addDosState,
  setDosMessage,
  getRawDosMessage,
  getDosMessage,
  UNREACHABLE_MESSAGE,
  UNAVAILABLE_MESSAGE,
  BENCH_PUBLIC_IP_MESSAGE,
  IP_DETECTION_FAILED_MESSAGE,
  releaseDosOwnedBy,
  countUnreachable,
  countPeerShortfall,
  holdAvailabilityDos,
  releaseUnreachable,
  peerShortfallStands,
  releaseShortfall,
  resetAvailabilityDos,
  effectiveDosState,
  StickyDosOwner,
  setStickyDos,
  clearStickyDos,
  isStickyDosHeldBy,
  getStickyDosMessage,
  isNodeDos,
  getDosData,
};
