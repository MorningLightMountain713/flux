'use strict';

const config = require('config');
const dbHelper = require('../dbHelper');

const localDatabaseName = config.get('database.local.database');
const ownAddressCollection = config.get('database.local.collections.ownAddress');

const RECORD_ID = 'own';

function collection() {
  const connection = dbHelper.databaseConnection();
  return connection ? connection.db(localDatabaseName).collection(ownAddressCollection) : null;
}

/**
 * This node's own address record: null before it has adopted an address.
 *
 * `socketAddress` is the address it adopted. When a move took it there,
 * `movedFrom` is where it moved from and `movedAt` when (ms), `ipChanged` whether
 * the IP changed or only the port, and `announce` whether the move is told to the
 * network. The rest records which of the move's steps that cannot be read back
 * from the node itself are done, each by the `movedAt` of the move it was done
 * for: `appsHandledAt`, `announcedAt`, `geolocatedAt`, `confirmationAcceptedAt`,
 * and `settledAt` once the move is wholly in place.
 * @returns {Promise<object|null>}
 */
async function read() {
  const records = collection();
  if (!records) return null;
  const record = await records.findOne({ _id: RECORD_ID }, { projection: { _id: 0 } });
  return record ?? null;
}

/**
 * @param {object} fields
 * @returns {Promise<void>}
 */
async function update(fields) {
  await collection().updateOne({ _id: RECORD_ID }, { $set: fields });
}

/**
 * Adopts `socketAddress` without a move.
 * @param {string} socketAddress
 * @returns {Promise<void>}
 */
async function adopt(socketAddress) {
  await collection().updateOne(
    { _id: RECORD_ID },
    {
      $set: {
        socketAddress, movedFrom: null, movedAt: null, recordedAt: new Date(),
      },
    },
    { upsert: true },
  );
}

/**
 * Records a move, none of its steps done.
 * @param {{socketAddress: string, movedFrom: string, movedAt: number, ipChanged: boolean, announce: boolean}} move
 * @returns {Promise<void>}
 */
async function recordMove(move) {
  await collection().updateOne(
    { _id: RECORD_ID },
    {
      $set: {
        ...move,
        appsHandledAt: null,
        announcedAt: null,
        geolocatedAt: null,
        confirmationAcceptedAt: null,
        settledAt: null,
        recordedAt: new Date(),
      },
    },
    { upsert: true },
  );
}

module.exports = {
  adopt,
  read,
  recordMove,
  update,
};
