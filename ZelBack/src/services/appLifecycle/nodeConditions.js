'use strict';

// Node-condition install failures: this node cannot serve the app right now
// and the app is blameless, so the installer DEFERS (the app places elsewhere
// or retries here) and never broadcasts a verdict on the app itself. Carried
// as `error.code`; a frozen enum so throwers and consumers cannot drift.
const NodeCondition = Object.freeze({
  NETWORK_DEPENDENCY_NOT_READY: 'NETWORK_DEPENDENCY_NOT_READY',
  BACKEND_TLS_UNAVAILABLE: 'BACKEND_TLS_UNAVAILABLE',
  MESH_UNAVAILABLE: 'MESH_UNAVAILABLE',
});

/**
 * Whether an error carries any node-condition code.
 * @param {Error|null|undefined} error
 * @returns {boolean}
 */
const isNodeCondition = (error) => Object.values(NodeCondition).includes(error?.code);

module.exports = {
  NodeCondition,
  isNodeCondition,
};
