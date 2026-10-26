'use strict';


const log = require('../../lib/log');
const serviceHelper = require('../serviceHelper');
const daemonServiceBlockchainRpcs = require('../daemonService/daemonServiceBlockchainRpcs');
const appEventVerifier = require('./appEventVerifier');
const { getSpecBackend } = require('../utils/specLibs');
const appRecords = require('../appDatabase/appRecords');
const { nodeChain } = require('../utils/nodeChain');

/**
 * The one way an app message whose payment is mined is stored.
 *
 * A message is stored only when this node's scan recorded its payment, and it is
 * stored with that record's chain facts (txid, height, payment, block time),
 * never with the sender's. It is stored only when its contents hash to the
 * payment's hash and, for an encrypted v9 message, its Arcane attestation
 * verifies. Nothing else is judged here: whether its spec is valid, who may sign
 * it and what it had to pay are decided from the stored message and this node's
 * chain record.
 *
 * A legacy message's hash covers its spec as sent, so one whose spec this
 * library cannot read is stored when that text hashes to the payment, and the
 * decider refuses it as invalid. A v2 message's hash covers only its content
 * hash; its contents are bound to that by reading the spec, so a v2 message
 * whose spec this library cannot read cannot be checked, and is not stored.
 *
 * Storing marks the payment record resolved.
 */



const storedListeners = [];

/**
 * Registers `fn(hashes)`, called after every store call that resolves hashes,
 * newly stored or already held: what is stored is decided afterwards, never by
 * the route that stored it.
 * @param {(hashes: string[]) => void} fn
 * @returns {() => void} unsubscribe
 */
function onStored(fn) {
  storedListeners.push(fn);
  return () => {
    const index = storedListeners.indexOf(fn);
    if (index !== -1) storedListeners.splice(index, 1);
  };
}

/**
 * Tells the listeners hashes are held: for a route that meets a message it has
 * already stored.
 * @param {string[]} hashes
 */
function notifyStored(hashes) {
  if (hashes.length) storedListeners.forEach((fn) => fn(hashes));
}

/**
 * The confirmed event a message's contents and a payment record make together.
 * @param {object} contents The message as signed: type, version, specifications,
 *   hash, timestamp, signature, and for v2 the content hash, extend flag and
 *   attestation. Any chain facts it carries are ignored.
 * @param {{txid: string, height: number, value: number, blockTime?: number|null}} record
 * @returns {Promise<object>} ConfirmedAppEvent (v2) or AppEventLegacy
 */
async function confirmedEvent(contents, record) {
  const { AppEventLegacy, ConfirmedAppEvent } = await getSpecBackend();
  const chain = {
    txid: serviceHelper.ensureString(record.txid),
    height: serviceHelper.ensureNumber(record.height),
    valueSat: serviceHelper.ensureNumber(record.value),
  };

  if (contents.version === 2) {
    // registeredAt anchors v9's time-based expiry (registeredAt + ttl); a
    // coerced 0/NaN stores an app every liveness query reads as long-dead.
    const registeredAt = serviceHelper.ensureNumber(record.blockTime ?? await daemonServiceBlockchainRpcs.lookupBlockTime(record.height));
    if (!Number.isFinite(registeredAt) || registeredAt <= 0) {
      throw new Error(`no confirming block time for ${contents.hash} at height ${record.height}`);
    }
    return ConfirmedAppEvent.deserialize({
      type: contents.type,
      version: contents.version,
      appSpecifications: contents.appSpecifications,
      contentHash: contents.contentHash,
      hash: contents.hash,
      timestamp: contents.timestamp,
      extend: contents.extend ?? false,
      signature: contents.signature,
      ...chain,
      registeredAt,
      arcaneAttestation: contents.arcaneAttestation || null,
      contentManifest: contents.contentManifest ?? null,
    });
  }

  return AppEventLegacy.deserialize({
    type: contents.type,
    version: contents.version,
    appSpecifications: contents.appSpecifications,
    hash: contents.hash,
    timestamp: contents.timestamp,
    signature: contents.signature,
    ...chain,
  }, { chain: nodeChain() });
}

/**
 * This node's payment record for each hash its scan has recorded, except one
 * whose transaction the chain does not hold (`notOnChain`): that is no payment.
 * @param {string[]} hashes
 * @returns {Promise<Map<string, object>>} by hash
 */
async function paymentRecords(hashes) {
  return appRecords.messages().payments(hashes);
}

/**
 * A legacy message whose spec this library cannot read, as stored: its contents
 * as sent, with this node's chain facts. Null unless the spec as sent hashes to
 * the paid hash by the legacy hash, which a v2 message's hash never is.
 * @param {object} contents
 * @returns {Promise<object|null>}
 */
async function unreadableLegacyMessage(contents) {
  const spec = contents.appSpecifications;
  if (!spec || typeof spec !== 'object') return null;
  const { computeMessageHash } = await getSpecBackend();
  const hash = computeMessageHash(contents.type, contents.version, spec, contents.timestamp, contents.signature);
  if (hash !== contents.hash) return null;
  return {
    type: contents.type,
    version: contents.version,
    appSpecifications: spec,
    hash: contents.hash,
    timestamp: contents.timestamp,
    signature: contents.signature,
  };
}

/**
 * The contents an event's stored form carries: the signed message, without the
 * chain facts the payment half holds.
 * @param {object} serialized
 * @returns {object}
 */
function signedContents(serialized) {
  const contents = { ...serialized };
  for (const field of ['txid', 'height', 'valueSat', 'registeredAt']) delete contents[field];
  return contents;
}

/**
 * Why a message cannot be stored against a payment record, or null when it can.
 * @param {object} event
 * @returns {Promise<string|null>}
 */
async function refusal(event) {
  if (!event.verifyHash().valid) return 'contents do not hash to the paid hash';
  if (event.requiresArcaneAttestation() && !await appEventVerifier.verifyAttestation(event)) {
    return 'Arcane attestation does not verify';
  }
  return null;
}

/**
 * Stores app messages whose payments this node's scan recorded.
 *
 * @param {object[]} candidates Messages' contents, from any route.
 * @returns {Promise<{stored: Array<{hash: string, event: ?object, record: object}>,
 *   alreadyStored: string[], unpaid: string[], refused: Array<{hash: string, reason: string}>}>}
 *   `stored` holds each message stored by this call, as its event (null for a
 *   legacy message whose spec this library cannot read) and the payment record
 *   it was stored with, in the order given.
 */
async function storeConfirmedMessages(candidates) {
  const result = {
    stored: [], alreadyStored: [], unpaid: [], refused: [],
  };
  if (candidates.length === 0) return result;
  const messages = appRecords.messages();
  const hashes = [...new Set(candidates.map((candidate) => candidate.hash))];
  const existing = new Set((await messages.byHashes(hashes)).filter((record) => record.isHeld).map((record) => record.hash));
  const records = await paymentRecords(hashes);
  const seen = new Set();
  for (const candidate of candidates) {
    const { hash } = candidate;
    if (seen.has(hash)) continue;
    seen.add(hash);
    if (existing.has(hash)) {
      result.alreadyStored.push(hash);
      continue;
    }
    const record = records.get(hash);
    if (!record) {
      result.unpaid.push(hash);
      continue;
    }
    // A voided payment's contents are held like any other's; the decider refuses
    // them as unclaimed while the void stands, and decides them anew when a
    // rewind drops it.
    let event = null;
    let contents;
    try {
      // eslint-disable-next-line no-await-in-loop
      event = await confirmedEvent(candidate, record);
      contents = signedContents(event.serialize());
    } catch (error) {
      // eslint-disable-next-line no-await-in-loop
      contents = await unreadableLegacyMessage(candidate);
      if (!contents) {
        result.refused.push({ hash, reason: error.message });
        continue;
      }
    }
    if (event) {
      // eslint-disable-next-line no-await-in-loop
      const reason = await refusal(event);
      if (reason) {
        result.refused.push({ hash, reason });
        continue;
      }
      if (record.blockTime == null && Number.isFinite(event.registeredAt)) {
        // eslint-disable-next-line no-await-in-loop
        await messages.setBlockTime(hash, event.registeredAt);
      }
    }
    // eslint-disable-next-line no-await-in-loop
    const { stored } = await messages.storeContents(contents);
    if (stored) result.stored.push({ hash, event, record });
    else result.alreadyStored.push(hash);
  }
  const resolved = [...result.stored.map(({ hash }) => hash), ...result.alreadyStored];
  notifyStored(resolved);
  if (result.refused.length) {
    log.warn(`confirmedMessageStore - ${result.refused.length} message(s) not stored: ${result.refused.slice(0, 5).map((r) => `${r.hash} (${r.reason})`).join(', ')}`);
  }
  return result;
}

module.exports = {
  storeConfirmedMessages, confirmedEvent, paymentRecords, onStored, notifyStored,
};
