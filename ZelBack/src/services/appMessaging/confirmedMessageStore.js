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
 * verifies. Nothing else is judged here: who may sign it and what it had to pay
 * are decided from the stored message and this node's chain record.
 *
 * Storing marks the payment record resolved.
 */

const appsHashesCollection = config.get('database.daemon.collections.appsHashes');
const globalAppsMessages = config.get('database.appsglobal.collections.appsMessages');

const DUPLICATE_KEY = 11_000;

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
 * @returns {Promise<{stored: Array<{event: object, record: object}>, alreadyStored: string[],
 *   unpaid: string[], refused: Array<{hash: string, reason: string}>}>} `stored`
 *   holds each message stored by this call, as its event and the payment record
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
    try {
      // eslint-disable-next-line no-await-in-loop
      const event = await confirmedEvent(candidate, record);
      // eslint-disable-next-line no-await-in-loop
      const reason = await refusal(event);
      if (reason) result.refused.push({ hash, reason });
      else toInsert.push({ event, record });
    } catch (error) {
      result.refused.push({ hash, reason: error.message });
    }
  }

  if (toInsert.length) {
    const failedAt = new Set();
    await dbHelper.insertManyToDatabase(messagesDb, globalAppsMessages, toInsert.map(({ event }) => event.serialize()), { ordered: false })
      .catch((error) => {
        // A message another route stored meanwhile is already stored; any other
        // failure is this node's and is raised.
        const writeErrors = error.writeErrors ?? [];
        if (writeErrors.length === 0 || writeErrors.some((writeError) => writeError.code !== DUPLICATE_KEY)) throw error;
        writeErrors.forEach((writeError) => failedAt.add(writeError.index));
      });
    toInsert.forEach((entry, index) => {
      if (failedAt.has(index)) result.alreadyStored.push(entry.event.hash);
      else result.stored.push(entry);
    });
  }

  const resolved = [...result.stored.map(({ event }) => event.hash), ...result.alreadyStored];
  if (resolved.length) {
    await dbHelper.bulkWriteInDatabase(daemonDb, appsHashesCollection, resolved.map((hash) => ({
      updateOne: { filter: { hash }, update: { $set: { message: true, messageNotFound: false } } },
    })));
  }
  if (result.refused.length) {
    log.warn(`confirmedMessageStore - ${result.refused.length} message(s) not stored: ${result.refused.slice(0, 5).map((r) => `${r.hash} (${r.reason})`).join(', ')}`);
  }
  return result;
}

module.exports = {
  storeConfirmedMessages, confirmedEvent, paymentRecords, lookupBlockTime,
};
