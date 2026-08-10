'use strict';

const crypto = require('crypto');
const config = require('config');
const log = require('../../lib/log');
const nodeIdentityRepository = require('../appDatabase/nodeIdentityRepository');

// Recognising a caller the node refused earlier, without the node being able to
// say who they are.
//
// The audit record seals the FluxID and the address to the fluxteam key, so the
// node holds evidence it cannot itself read - which is the point, and which
// also means it cannot look a returning caller up. A fingerprint closes that:
// the same caller always produces the same value, so the node can match a
// repeat visitor, while the value is meaningless to anyone without this node's
// secret. It cannot be reversed into a FluxID and cannot be compared across
// nodes, so it is useless for building a picture of who is trying what.

// What a mining session looks like, and why it takes all three.
//
// Each signal alone is wrong. A queue worker serves nothing and runs to the
// deadline too - but it is not burning a core. A transcoder or an image that
// compiles on first boot burns a core - but it answers on its port. Only mining
// does all three at once, which is what makes the combination specific enough
// to act on.
//
// Deliberately NOT included: outbound flow shape. It is the fiddliest to
// collect and the most redundant given the rest, and a session that pinned a
// core for its whole life while never answering anything is already unambiguous.

function cpuBusyThreshold() {
  return config.fluxapps.playgroundMinerCpuBusyFraction ?? 0.9;
}

function blockMs() {
  return config.fluxapps.playgroundMinerBlockMs ?? 24 * 60 * 60 * 1000;
}

/**
 * Whether a finished session has the mining shape.
 *
 * Pure: takes the behaviour record and answers. No docker, no database, so the
 * boundaries are directly testable - which matters, because this decides
 * whether somebody gets turned away for a day.
 *
 * @param {object} behaviour - from playgroundAudit.behaviour()
 * @returns {boolean}
 */
function looksLikeMining(behaviour) {
  if (!behaviour) return false;

  // Never measured is not the same as never busy. A session whose CPU could not
  // be sampled is left alone rather than judged on the other two signals, which
  // on their own describe an ordinary queue worker.
  if (typeof behaviour.cpuBusyFraction !== 'number') return false;

  return behaviour.cpuBusyFraction >= cpuBusyThreshold()
    && behaviour.everAcceptedConnection === false
    && behaviour.ranToDeadline === true;
}

/**
 * This node's fingerprinting secret, minted on first use and persisted.
 *
 * Cached after the first read: it is asked for on every session admission, and
 * it never changes for the life of the node.
 */
let cachedSecret = null;

async function fingerprintSecret() {
  if (cachedSecret) return cachedSecret;
  cachedSecret = await nodeIdentityRepository.getOrCreatePlaygroundFingerprintSecret(
    () => crypto.randomBytes(32).toString('hex'),
  );
  return cachedSecret;
}

/**
 * A stable, node-local, one-way fingerprint of a caller.
 *
 * Keyed on the same pair the duty cycle uses - the FluxID and the caller's
 * resolved address - so a block follows the same notion of "caller" the rate
 * limits do.
 *
 * @returns {Promise<string|null>} null when the secret is unavailable, which
 *   reads as "cannot tell" everywhere it is used
 */
async function fingerprint(fluxId, sourceIp) {
  const secret = await fingerprintSecret();
  if (!secret) return null;

  return crypto.createHmac('sha256', secret)
    .update(`${fluxId}|${sourceIp ?? ''}`)
    .digest('hex');
}

/**
 * Whether this caller was flagged recently enough to still be refused.
 *
 * Fails OPEN: a database that cannot be read means the node does not know, and
 * turning honest callers away on a storage blip is worse than letting a flagged
 * one through — the duty cycle still bounds what they can do, and the next
 * session flags them again.
 *
 * @param {Function} findFlagged - repository lookup, injected so the decision
 *   stays testable without a database
 * @returns {Promise<boolean>}
 */
async function isBlocked(fluxId, sourceIp, findFlagged) {
  try {
    const print = await fingerprint(fluxId, sourceIp);
    if (!print) return false;

    const since = Date.now() - blockMs();
    const hit = await findFlagged(print, since);
    return Boolean(hit);
  } catch (error) {
    log.warn(`playground: could not check the abuse blocklist: ${error.message}`);
    return false;
  }
}

/** Test seam: forget the cached secret. */
function reset() {
  cachedSecret = null;
}

module.exports = {
  looksLikeMining,
  fingerprint,
  isBlocked,
  blockMs,
  reset,
};
