'use strict';

const { EventEmitter } = require('events');

const appSyncEvents = new EventEmitter();

const EVENTS = Object.freeze({
  EPHEMERAL_SYNC_COMPLETE: 'ephemeralSyncComplete',
  EPHEMERAL_SYNC_REFUSED: 'ephemeralSyncRefused',
  EPHEMERAL_SYNC_UNVERIFIED: 'ephemeralSyncUnverified',
  EPHEMERAL_SYNC_PROGRESS: 'ephemeralSyncProgress',
  HASH_RESPONSE_RECEIVED: 'hashResponseReceived',
  HASH_UNRESOLVED: 'hashUnresolved',
  // a scoped reconnect pull answered: the store has caught up on what a
  // re-established peer saw while this node was away (peer key as argument)
  RECONNECT_SYNC_COMPLETE: 'reconnectSyncComplete',
  // a peer that declined this node's state-sync request can answer it now
  // (peer key and connection id as arguments)
  PEER_STATE_SYNC_READY: 'peerStateSyncReady',
});

module.exports = { appSyncEvents, EVENTS };
