'use strict';

const { EventEmitter } = require('events');

// Told each time a move is recorded: `from`, the address a node left; `to`, the
// address it is at now; and `broadcastedAt`, when it moved (ms). Every path a move
// arrives by ends in messageStore.storeIPChangedMessage, so a listener hears each
// move however it reached this node.
const addressMoveEvents = new EventEmitter();

const EVENTS = Object.freeze({
  APPLIED: 'applied',
});

module.exports = { addressMoveEvents, EVENTS };
