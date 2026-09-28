'use strict';

const { EventEmitter } = require('events');

const appSyncEvents = new EventEmitter();

const EVENTS = Object.freeze({
  EPHEMERAL_SYNC_COMPLETE: 'ephemeralSyncComplete',
  EPHEMERAL_SYNC_REFUSED: 'ephemeralSyncRefused',
  EPHEMERAL_SYNC_UNVERIFIED: 'ephemeralSyncUnverified',
  EPHEMERAL_SYNC_WRITE_FAILED: 'ephemeralSyncWriteFailed',
  EPHEMERAL_SYNC_PROGRESS: 'ephemeralSyncProgress',
  HASH_RESPONSE_RECEIVED: 'hashResponseReceived',
  HASH_UNRESOLVED: 'hashUnresolved',
  // An operator asked for a check of every missing app message; the orchestrator
  // runs it once no hash sync or registry build holds the node.
  HASH_CHECK_REQUESTED: 'hashCheckRequested',
  // a scoped reconnect pull answered: the store has caught up on what a
  // re-established peer saw while this node was away (peer key as argument)
  RECONNECT_SYNC_COMPLETE: 'reconnectSyncComplete',
});

module.exports = { appSyncEvents, EVENTS };
