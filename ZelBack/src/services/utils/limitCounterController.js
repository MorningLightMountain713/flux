'use strict';

const config = require('config');
const messageHelper = require('../messageHelper');
const serviceHelper = require('../serviceHelper');
const limitCounter = require('./limitCounter');
const limitCounterStore = require('./limitCounterStore');
const limitCounterRecords = require('./limitCounterRecords');
const log = require('../../lib/log');

// The node-to-node face of the tally. One node asks another "may this caller
// start one", and gets an answer that has already taken the slot if the answer is
// yes.
//
// Nothing here is authenticated, and that is a deliberate reading of the threat
// rather than an omission. Forwarding the caller's own credential would let this
// node act as that caller elsewhere, which is a worse thing to hand over than the
// ability to spend someone's allowance. So the request carries a HASH of the
// caller and no credential, and the exposure is bounded to griefing: a peer can
// spend a caller's slots, but cannot become them, cannot enumerate anyone, and
// cannot learn who any key belongs to.
//
// Three guards keep that bound:
//   - the key must look like a key, so nobody grows the map with junk;
//   - the purpose must be one this node is configured for, same reason;
//   - this node must actually BE the counter for the key, or it declines. A node
//     that answered for keys it does not hold would be a counter for anyone who
//     asked, which is not a counter.

const KEY_PATTERN = /^[0-9a-f]{64}$/;

// Per-peer ceiling on asks. The guards above bound what a peer can create; this
// bounds how fast it can spend. Generous by design - a peer forwarding for many
// callers is the normal case, and the number only has to make grinding slower
// than simply waiting.
const PEER_WINDOW_MS = 60 * 1000;
const PEER_MAX_ASKS = config.fluxapps.limitCounterPeerAsksPerMinute ?? 600;
const peerAsks = new Map(); // peer -> { windowStart, count }

function peerAllowed(peer) {
  const now = Date.now();
  const seen = peerAsks.get(peer);
  if (!seen || now - seen.windowStart >= PEER_WINDOW_MS) {
    peerAsks.set(peer, { windowStart: now, count: 1 });
    return true;
  }
  seen.count += 1;
  return seen.count <= PEER_MAX_ASKS;
}

function configuredPurpose(purpose) {
  return typeof purpose === 'string' && Object.hasOwn(config.fluxapps.limitCounters ?? {}, purpose);
}

/**
 * Read and check what a peer sent.
 *
 * @returns {Promise<{ok: true, purpose: string, key: string}|{ok: false, code: number, message: string}>}
 */
async function readRequest(req) {
  const body = serviceHelper.ensureObject(req.body) ?? {};
  const { purpose, key } = body;

  if (!configuredPurpose(purpose)) {
    return { ok: false, code: 400, message: 'Unknown limit purpose' };
  }
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    return { ok: false, code: 400, message: 'Malformed limit key' };
  }
  // A deputy answers only for itself, from its own memory, and never over the
  // wire - so a request naming a deputy purpose is not one this node should serve.
  if (purpose.endsWith('#deputy')) {
    return { ok: false, code: 400, message: 'Unknown limit purpose' };
  }

  const role = await limitCounter.localRoleForKey(purpose, key).catch(() => null);
  if (role !== 'counter') {
    return { ok: false, code: 409, message: 'This node does not hold that tally' };
  }
  return { ok: true, purpose, key };
}

function peerOf(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * Take a slot, or refuse. The slot is taken before the answer is sent, so two
 * peers asking at once cannot both be told yes.
 */
async function reserve(req, res) {
  try {
    if (!peerAllowed(peerOf(req))) {
      return res.status(429).json(messageHelper.createErrorMessage('Too many limit asks'));
    }
    const parsed = await readRequest(req);
    if (!parsed.ok) {
      return res.status(parsed.code).json(messageHelper.createErrorMessage(parsed.message));
    }
    // Same reason as the local path: answer from what the records already know,
    // not from memory alone, or a restart hands the caller a fresh allowance.
    await limitCounterRecords.reconcile(parsed.purpose, parsed.key).catch((error) => {
      log.warn(`limitCounterController - could not reconcile from records: ${error.message}`);
    });
    const verdict = limitCounterStore.reserve(parsed.purpose, parsed.key);
    return res.json(messageHelper.createDataMessage(verdict));
  } catch (error) {
    log.error(`limitCounterController reserve: ${error.message}`);
    return res.status(500).json(messageHelper.createErrorMessage(error.message));
  }
}

/**
 * Give a slot back. A release for a token this node never issued is a no-op
 * rather than an error - the caller cannot tell the difference and there is
 * nothing useful it could do with the distinction.
 */
async function release(req, res) {
  try {
    if (!peerAllowed(peerOf(req))) {
      return res.status(429).json(messageHelper.createErrorMessage('Too many limit asks'));
    }
    const parsed = await readRequest(req);
    if (!parsed.ok) {
      return res.status(parsed.code).json(messageHelper.createErrorMessage(parsed.message));
    }
    const { token } = serviceHelper.ensureObject(req.body) ?? {};
    const released = limitCounterStore.release(parsed.purpose, parsed.key, token);
    return res.json(messageHelper.createDataMessage({ released }));
  } catch (error) {
    log.error(`limitCounterController release: ${error.message}`);
    return res.status(500).json(messageHelper.createErrorMessage(error.message));
  }
}

/** Test seam. */
function reset() {
  peerAsks.clear();
}

module.exports = {
  reserve,
  release,
  reset,
};
