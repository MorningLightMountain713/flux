'use strict';

/**
 * App message contents over the peer protocol, in batches.
 *
 * A fluxapprequest v3 names up to MAX_REQUEST_HASHES message hashes and carries
 * a requestId. A peer advertising appMessageBatch answers with fluxappmessagesync
 * frames for that requestId, each signed once and carrying at most
 * MAX_FRAME_BYTES of messages, the last marked done. A frame is taken only for a
 * request this node has open to the peer that sent it, and only for hashes that
 * request named.
 *
 * A request settles when its last frame has been stored, when the connection it
 * was sent on closes, or when FRAME_WAIT_MS pass without a frame: with the
 * number of messages it stored and the hashes it named that are still not held.
 */

const crypto = require('crypto');
const log = require('../../lib/log');
const confirmedMessageStore = require('./confirmedMessageStore');
const { peerManager } = require('../utils/peerState');
const { appSyncEvents, EVENTS } = require('../utils/appSyncEvents');

/** The most hashes one request names. */
const MAX_REQUEST_HASHES = 10_000;

/**
 * The most bytes of messages one frame carries, leaving room for the envelope
 * under an 8 MiB frame. A single message larger than this goes in a frame alone.
 */
const MAX_FRAME_BYTES = (8 * 1024 * 1024) - (64 * 1024);

/** How long an open request waits for its next frame before it settles unanswered. */
const FRAME_WAIT_MS = 60 * 1000;

/** The peer capability that says a peer answers v3. */
const CAPABILITY = 'appMessageBatch';

const open = new Map();

function settle(request, closed) {
  if (!open.delete(request.requestId)) return;
  clearTimeout(request.timer);
  request.resolve({
    requestId: request.requestId,
    peerKey: request.peerKey,
    stored: request.stored,
    missing: [...request.pending],
    closed,
  });
}

function awaitNextFrame(request) {
  clearTimeout(request.timer);
  request.timer = setTimeout(() => settle(request, true), FRAME_WAIT_MS);
  request.timer.unref();
}

/**
 * Opens a request to a peer for the contents of these hashes.
 * @param {string} peerKey the peer's ip:port
 * @param {string[]} hashes at most MAX_REQUEST_HASHES
 * @returns {{requestId: string, message: object, done: Promise<{requestId: string,
 *   peerKey: string, stored: number, missing: string[], closed: boolean}>}} the
 *   message to sign and send, and the request's outcome; `closed` is true when
 *   it settled without the peer's last frame
 */
function openRequest(peerKey, hashes) {
  if (hashes.length > MAX_REQUEST_HASHES) {
    throw new Error(`a message batch request names at most ${MAX_REQUEST_HASHES} hashes, not ${hashes.length}`);
  }
  const requestId = crypto.randomUUID();
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  const request = {
    requestId, peerKey, pending: new Set(hashes), stored: 0, resolve, timer: null,
  };
  open.set(requestId, request);
  awaitNextFrame(request);
  return {
    requestId,
    message: {
      type: 'fluxapprequest', version: 3, hashes, requestId,
    },
    done,
  };
}

/**
 * Takes a fluxappmessagesync frame from a peer: stores the messages the open
 * request names, and settles the request on its last frame.
 * @param {object} data the frame's data
 * @param {string} peerKey the sending peer's ip:port
 * @returns {Promise<void>}
 */
async function receiveFrame(data, peerKey) {
  const request = open.get(data?.requestId);
  if (!request || request.peerKey !== peerKey) {
    log.warn(`messageBatchRequests - a message batch from ${peerKey} answers no request open to it`);
    return;
  }
  awaitNextFrame(request);
  const messages = Array.isArray(data.messages)
    ? data.messages.filter((message) => message && request.pending.has(message.hash))
    : [];
  if (messages.length) {
    const storage = await confirmedMessageStore.storeConfirmedMessages(messages);
    for (const { hash } of storage.stored) {
      request.pending.delete(hash);
      appSyncEvents.emit(EVENTS.HASH_RESPONSE_RECEIVED, hash);
    }
    for (const hash of storage.alreadyStored) request.pending.delete(hash);
    request.stored += storage.stored.length;
  }
  if (data.done === true) settle(request, false);
}

// A request is answered on the connection it was sent on; once that closes, the
// rest of its answer cannot arrive.
peerManager.on('peer:removed', ({ ip, port }) => {
  const key = `${ip}:${port}`;
  for (const request of [...open.values()]) {
    if (request.peerKey === key) settle(request, true);
  }
});

module.exports = {
  CAPABILITY,
  FRAME_WAIT_MS,
  MAX_FRAME_BYTES,
  MAX_REQUEST_HASHES,
  openRequest,
  receiveFrame,
};
