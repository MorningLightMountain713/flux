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
  installedApps: Object.freeze({
    database: config.get('database.appslocal.database'),
    collection: config.get('database.appslocal.collections.appsInformation'),
  }),
});

let storage = null;
let appRegistry = null;
let installedApps = null;

function provider() {
  if (!storage) storage = MongoStorageProvider.create(STORES);
  return storage;
}

/**
 * The app registry: the network's current record of each app.
 * @returns {import('@runonflux/flux-spec-backend').AppRegistry}
 */
function registry() {
  if (!appRegistry) {
    const { AppRegistry } = specLibrary.loaded();
    appRegistry = new AppRegistry(provider(), {
      onUnreadable: (stored, error) => log.warn(`appRegistry: a stored record cannot be read: ${error.message} (name=${stored.name}, version=${stored.version})`),
    });
  }
  return appRegistry;
}

/**
 * The installed apps: this node's record of each instance it runs and the
 * ledger of what it created for it.
 * @returns {import('@runonflux/flux-spec-backend').InstalledApps}
 */
function installed() {
  if (!installedApps) {
    const { InstalledApps } = specLibrary.loaded();
    installedApps = new InstalledApps(provider(), {
      onUnreadable: (stored, error) => log.warn(`installedApps: a stored record cannot be read: ${error.message} (name=${stored.name}, replica=${stored.replica ?? null}, version=${stored.version})`),
    });
  }
  return installedApps;
}

module.exports = { registry, installed, STORES };
