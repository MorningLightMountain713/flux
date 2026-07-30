const config = require('config');
const dbHelper = require('../dbHelper');
const nodeIdentityRepository = require('./nodeIdentityRepository');
const log = require('../../lib/log');

const nodeIdentityCollection = config.database.local.collections.nodeIdentity;
const MIGRATION_KEY = 'configMigration';
const MIGRATION_VERSION = 1;

function db() {
  const connection = dbHelper.databaseConnection();
  return connection ? connection.db(config.database.local.database) : null;
}

/**
 * Move node runtime state out of config/userconfig.js into the local database.
 *
 * Runs once per node, after mongo is up. Idempotent by construction rather than by
 * the version marker alone: every step is conditional on the database not already
 * holding the value.
 *
 * The direction matters. The file is only ever read *into* an empty database, never
 * the reverse — flux-configd rewrites userconfig.js on any reconfigure and emits an
 * empty keypair when it does, so a file-wins rule would blank a good key on the next
 * boot. Once the database holds an identity it is authoritative and the copy left in
 * the file is ignored.
 *
 * @returns {Promise<{migrated: string[]}>} which values were adopted
 */
async function migrateNodeIdentity() {
  const database = db();
  if (!database) {
    log.warn('Node identity migration skipped - database not available');
    return { migrated: [] };
  }

  const marker = await dbHelper.findOneInDatabase(
    database,
    nodeIdentityCollection,
    { _id: MIGRATION_KEY },
  );
  if (marker && marker.version >= MIGRATION_VERSION) {
    return { migrated: [] };
  }

  const { initial } = globalThis.userconfig;
  const migrated = [];

  const existingIdentity = await nodeIdentityRepository.getPgpIdentity();
  if (!existingIdentity && initial.pgpPrivateKey && initial.pgpPublicKey) {
    const adopted = await nodeIdentityRepository.setPgpIdentity({
      privateKey: initial.pgpPrivateKey,
      publicKey: initial.pgpPublicKey,
    });
    if (adopted) {
      migrated.push('pgpIdentity');
      log.info('Adopted the PGP keypair from userconfig.js into the local database');
    }
  }

  // Seeding the previous address preserves change detection across the upgrade. It is
  // a convenience, not a correctness requirement: adjustExternalIP already guards its
  // side effects on the previous value being a valid address, so an unseeded node
  // records the current address without treating it as a change.
  const existingIp = await nodeIdentityRepository.getLastKnownIp();
  const v4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}$/;
  if (!existingIp && initial.ipaddress && v4.test(initial.ipaddress)) {
    await nodeIdentityRepository.setLastKnownIp(initial.ipaddress);
    migrated.push('lastKnownIp');
    log.info('Adopted the last-known IP from userconfig.js into the local database');
  }

  // The marker retires the migration permanently, so it is only written once an identity
  // is settled. A boot that read the fallback config — configManager publishes it when
  // config/userconfig.js is unreadable — carries no keypair, and nothing here can tell
  // that apart from a node that never had one. Recording completion on such a boot would
  // strand the keypair still sitting in the operator's file.
  if (existingIdentity || migrated.includes('pgpIdentity')) {
    await dbHelper.findOneAndUpdateInDatabase(
      database,
      nodeIdentityCollection,
      { _id: MIGRATION_KEY },
      { $set: { version: MIGRATION_VERSION, at: Date.now() } },
      { upsert: true },
    );
  }

  return { migrated };
}

module.exports = {
  migrateNodeIdentity,
  MIGRATION_KEY,
  MIGRATION_VERSION,
};
