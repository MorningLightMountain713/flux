const fluxEventBus = require('./utils/fluxEventBus');

// Node DOS (denial-of-service) state: this FluxNode's aggregate health/eligibility
// score. Contributed to by the availability / IP-change / collision / fluxbench
// monitors and read by the eligibility, verification and app-spawn paths.
//
// Sticky DOS state is owned exclusively by whoever sets it (e.g. the app
// tampering blocklist enforcer). It is not cleared by setDosMessage(null) /
// setDosStateValue() from other checks, and takes precedence in getDosMessage(),
// getDosData() and isNodeDos() over the regular dosMessage/dosState.

let dosState = 0; // we can start at bigger number later
let dosMessage = null;
let stickyDosState = 0;
let stickyDosMessage = null;

/**
 * Emits the current effective DOS state on the event bus (SSE observability).
 * Every mutator calls this so observers see the true node DOS status, including
 * sticky precedence.
 */
function publishChanged() {
  fluxEventBus.publish('dos:changed', getDosData());
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
 * Getter for the raw regular dosMessage (ignores sticky).
 * @returns {string|null} dosMessage
 */
function getRawDosMessage() {
  return dosMessage;
}

/**
 * Getter for the effective dosMessage. Returns the sticky message if set,
 * otherwise the regular one.
 * @returns {string|null} dosMessage
 */
function getDosMessage() {
  return stickyDosMessage || dosMessage;
}

/**
 * Setter for the sticky DOS message. The sticky slot is not cleared by
 * setDosMessage(null); only the owner that set it should clear it via
 * clearStickyDosMessage().
 * @param {string} message
 */
function setStickyDosMessage(message) {
  stickyDosMessage = message;
  publishChanged();
}

/**
 * Getter for the sticky DOS message (ignores regular dosMessage).
 * @returns {string|null}
 */
function getStickyDosMessage() {
  return stickyDosMessage;
}

/**
 * Clears the sticky DOS message and sticky state value.
 */
function clearStickyDosMessage() {
  stickyDosMessage = null;
  stickyDosState = 0;
  publishChanged();
}

/**
 * Setter for the sticky DOS state value.
 * @param {number} value
 */
function setStickyDosStateValue(value) {
  stickyDosState = value;
  publishChanged();
}

/**
 * Whether the node is in a DOS state (effective value, sticky takes precedence).
 * @returns {boolean}
 */
function isNodeDos() {
  const effectiveState = stickyDosMessage ? stickyDosState : dosState;
  return effectiveState >= 100;
}

/**
 * Effective DOS data (sticky takes precedence), as consumed by the
 * /flux/dosstate endpoint and the node eligibility checks.
 * @returns {{dosState: number, dosMessage: string|null}}
 */
function getDosData() {
  return {
    dosState: stickyDosMessage ? stickyDosState : dosState,
    dosMessage: stickyDosMessage || dosMessage,
  };
}

module.exports = {
  getDosStateValue,
  setDosStateValue,
  addDosState,
  setDosMessage,
  getRawDosMessage,
  getDosMessage,
  setStickyDosMessage,
  getStickyDosMessage,
  clearStickyDosMessage,
  setStickyDosStateValue,
  isNodeDos,
  getDosData,
};
