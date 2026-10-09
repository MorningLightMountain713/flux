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
  installedLedgers: Object.freeze({
    database: config.get('database.appslocal.database'),
    collection: config.get('database.appslocal.collections.installedLedgers'),
  }),
  appMessages: Object.freeze({
    database: config.get('database.appsglobal.database'),
    collection: config.get('database.appsglobal.collections.appMessages'),
  }),
  contentManifests: Object.freeze({
    database: config.get('database.appsglobal.database'),
    collection: config.get('database.appsglobal.collections.appContentManifests'),
  }),
});

let storage = null;
let appRegistry = null;
let installedApps = null;
let installedLedgers = null;
let appMessages = null;
let contentManifests = null;

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
 * The installed apps: this node's record of each instance it runs.
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

/**
 * The installed ledgers: what this node created for each instance it runs,
 * keyed as the installed record is.
 * @returns {import('@runonflux/flux-spec-backend').InstalledLedgers}
 */
function ledgers() {
  if (!installedLedgers) {
    const { InstalledLedgers } = specLibrary.loaded();
    installedLedgers = new InstalledLedgers(provider(), {
      onUnreadable: (stored, error) => log.warn(`installedLedgers: a stored ledger cannot be read: ${error.message} (name=${stored.name}, replica=${stored.replica ?? null})`),
    });
  }
  return installedLedgers;
}

/**
 * The app messages: one record per message hash, holding the chain's payment
 * and the verified contents as the node has them.
 * @returns {import('@runonflux/flux-spec-backend').AppMessages}
 */
function messages() {
  if (!appMessages) {
    const { AppMessages } = specLibrary.loaded();
    appMessages = new AppMessages(provider(), {
      onUnreadable: (stored, error) => log.warn(`appMessages: a stored record cannot be read: ${error.message} (hash=${stored.hash})`),
    });
  }
  return appMessages;
}

/**
 * The content manifests: one record per manifest this node holds for an app,
 * keyed by the app identity and the manifest's hash.
 * @returns {import('@runonflux/flux-spec-backend').ContentManifests}
 */
function manifests() {
  if (!contentManifests) {
    const { ContentManifests } = specLibrary.loaded();
    contentManifests = new ContentManifests(provider(), {
      onUnreadable: (stored, error) => log.warn(`contentManifests: a stored record cannot be read: ${error.message} (identity=${stored.identity}, hash=${stored.hash})`),
    });
  }
  return contentManifests;
}

/**
 * The installed record of the instance one of whose containers has an
 * identifier, found through its ledger; null when no ledger names it.
 * @param {string} identifier
 * @returns {Promise<import('@runonflux/flux-spec-backend').InstalledSpec|null>}
 */
async function installedByIdentifier(identifier) {
  const ledger = await ledgers().byIdentifier(identifier);
  return ledger ? installed().byReplica(ledger.name, ledger.replica, { includeOwed: true }) : null;
}

/**
 * The key an installed record and its ledger share, as one string: the name
 * in any letter case, and the replica.
 * @param {{name: string, replica: string|null}} instance
 * @returns {string}
 */
function instanceKey({ name, replica }) {
  return `${String(name).toLowerCase()}\u0000${replica ?? ''}`;
}

module.exports = {
  registry, installed, ledgers, messages, manifests, installedByIdentifier, instanceKey, STORES,
};
