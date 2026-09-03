'use strict';

const { EventEmitter } = require('events');

const appSyncEvents = new EventEmitter();

const EVENTS = Object.freeze({
  EPHEMERAL_SYNC_COMPLETE: 'ephemeralSyncComplete',
  SPAWNER_READY: 'spawnerReady',
  READINESS_LOST: 'readinessLost',
  HASH_RESPONSE_RECEIVED: 'hashResponseReceived',
  HASH_UNRESOLVED: 'hashUnresolved',
  // a scoped reconnect pull answered: the store has caught up on what a
  // re-established peer saw while this node was away (peer key as argument)
  RECONNECT_SYNC_COMPLETE: 'reconnectSyncComplete',
});

module.exports = { appSyncEvents, EVENTS };
