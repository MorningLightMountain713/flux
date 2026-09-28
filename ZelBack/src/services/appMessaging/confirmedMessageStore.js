'use strict';

const config = require('config');

const log = require('../../lib/log');
const dbHelper = require('../dbHelper');
const serviceHelper = require('../serviceHelper');
const daemonServiceBlockchainRpcs = require('../daemonService/daemonServiceBlockchainRpcs');
const appEventVerifier = require('./appEventVerifier');
const { getSpecBackend } = require('../utils/specLibs');

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

const appsHashesCollection = config.get('database.daemon.collections.appsHashes');
const globalAppsMessages = config.get('database.appsglobal.collections.appsMessages');

const DUPLICATE_KEY = 11_000;

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
 * The confirming block's time, for a payment record made before the scan kept it.
 * @param {number} height
 * @returns {Promise<number|null>}
 */
async function lookupBlockTime(height) {
  const blockInfo = await daemonServiceBlockchainRpcs.getBlock({ hashheight: String(height), verbosity: 1 });
  if (blockInfo.status === 'success' && Number.isFinite(blockInfo.data.time)) {
    return blockInfo.data.time;
  }
  return null;
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
    const registeredAt = serviceHelper.ensureNumber(record.blockTime ?? await lookupBlockTime(record.height));
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
  });
}

/**
 * This node's payment record for each hash its scan has recorded.
 * @param {string[]} hashes
 * @returns {Promise<Map<string, object>>} by hash
 */
async function paymentRecords(hashes) {
  const daemonDb = dbHelper.databaseConnection().db(config.get('database.daemon.database'));
  const records = await dbHelper.findInDatabase(
    daemonDb, appsHashesCollection, { hash: { $in: hashes } }, { projection: { _id: 0 } },
  );
  return new Map(records.map((record) => [record.hash, record]));
}

/**
 * A legacy message whose spec this library cannot read, as stored: its contents
 * as sent, with this node's chain facts. Null unless the spec as sent hashes to
 * the paid hash by the legacy hash, which a v2 message's hash never is.
 * @param {object} contents
 * @param {{txid: string, height: number, value: number}} record
 * @returns {Promise<object|null>}
 */
async function unreadableLegacyMessage(contents, record) {
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
    txid: serviceHelper.ensureString(record.txid),
    height: serviceHelper.ensureNumber(record.height),
    valueSat: serviceHelper.ensureNumber(record.value),
  };
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

  const connection = dbHelper.databaseConnection();
  const messagesDb = connection.db(config.get('database.appsglobal.database'));
  const daemonDb = connection.db(config.get('database.daemon.database'));
  const hashes = [...new Set(candidates.map((candidate) => candidate.hash))];

  const existing = new Set((await dbHelper.findInDatabase(
    messagesDb, globalAppsMessages, { hash: { $in: hashes } }, { projection: { _id: 0, hash: 1 } },
  )).map((doc) => doc.hash));
  const records = await paymentRecords(hashes);

  const toInsert = [];
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
    let event;
    try {
      // eslint-disable-next-line no-await-in-loop
      event = await confirmedEvent(candidate, record);
    } catch (error) {
      // eslint-disable-next-line no-await-in-loop
      const doc = await unreadableLegacyMessage(candidate, record);
      if (doc) toInsert.push({ hash, event: null, doc, record });
      else result.refused.push({ hash, reason: error.message });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const reason = await refusal(event);
    if (reason) result.refused.push({ hash, reason });
    else toInsert.push({ hash, event, doc: event.serialize(), record });
  }

  if (toInsert.length) {
    const failedAt = new Set();
    await dbHelper.insertManyToDatabase(messagesDb, globalAppsMessages, toInsert.map(({ doc }) => doc), { ordered: false })
      .catch((error) => {
        // A message another route stored meanwhile is already stored; any other
        // failure is this node's and is raised.
        const writeErrors = error.writeErrors ?? [];
        if (writeErrors.length === 0 || writeErrors.some((writeError) => writeError.code !== DUPLICATE_KEY)) throw error;
        writeErrors.forEach((writeError) => failedAt.add(writeError.index));
      });
    toInsert.forEach(({ hash, event, record }, index) => {
      if (failedAt.has(index)) result.alreadyStored.push(hash);
      else result.stored.push({ hash, event, record });
    });
  }

  const resolved = [...result.stored.map(({ hash }) => hash), ...result.alreadyStored];
  if (resolved.length) {
    await dbHelper.bulkWriteInDatabase(daemonDb, appsHashesCollection, resolved.map((hash) => ({
      updateOne: { filter: { hash }, update: { $set: { message: true, messageNotFound: false } } },
    })));
  }
  notifyStored(resolved);
  if (result.refused.length) {
    log.warn(`confirmedMessageStore - ${result.refused.length} message(s) not stored: ${result.refused.slice(0, 5).map((r) => `${r.hash} (${r.reason})`).join(', ')}`);
  }
  return result;
}

module.exports = {
  storeConfirmedMessages, confirmedEvent, paymentRecords, lookupBlockTime, onStored, notifyStored,
};
