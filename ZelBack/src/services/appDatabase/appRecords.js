'use strict';

const config = require('config');
const log = require('../../lib/log');
const specLibrary = require('../utils/specLibrary');
const MongoStorageProvider = require('../providers/MongoStorageProvider');

/**
 * flux-spec's record collections over this node's database. FluxOS reads and
 * writes a record through its collection's operations, never a stored document.
 */

// Each logical store's database and collection.
const STORES = Object.freeze({
  appSpecs: Object.freeze({
    database: config.get('database.appsglobal.database'),
    collection: config.get('database.appsglobal.collections.appsInformation'),
  }),
});

let appRegistry = null;

function onUnreadable(stored, error) {
  log.warn(`appRegistry: a stored record cannot be read: ${error.message} (name=${stored.name}, version=${stored.version})`);
}

/**
 * The app registry: the network's current record of each app.
 * @returns {import('@runonflux/flux-spec-backend').AppRegistry}
 */
function registry() {
  if (!appRegistry) {
    const { AppRegistry } = specLibrary.loaded();
    appRegistry = new AppRegistry(MongoStorageProvider.create(STORES), { onUnreadable });
  }
  return appRegistry;
}

module.exports = { registry, STORES };
