'use strict';

const config = require('config');
const log = require('../../lib/log');
const specLibrary = require('../utils/specLibrary');
const MongoStorageProvider = require('../providers/MongoStorageProvider');
const { nodeChain } = require('../utils/nodeChain');

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
  hostedInstances: Object.freeze({
    database: config.get('database.appslocal.database'),
    collection: config.get('database.appslocal.collections.appsInformation'),
  }),
  instanceResources: Object.freeze({
    database: config.get('database.appslocal.database'),
    collection: config.get('database.appslocal.collections.instanceResources'),
  }),
  appMessages: Object.freeze({
    database: config.get('database.appsglobal.database'),
    collection: config.get('database.appsglobal.collections.appMessages'),
  }),
  contentManifests: Object.freeze({
    database: config.get('database.appsglobal.database'),
    collection: config.get('database.appsglobal.collections.appContentManifests'),
  }),
  appDecisions: Object.freeze({
    database: config.get('database.appsglobal.database'),
    collection: config.get('database.appsglobal.collections.appDecisions'),
  }),
});

let storage = null;
let appRegistry = null;
let hostedInstanceStore = null;
let instanceResourceStore = null;
let appMessages = null;
let contentManifests = null;
let appDecisions = null;

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
      chain: nodeChain(),
      onUnreadable: (stored, error) => log.warn(`appRegistry: a stored record cannot be read: ${error.message} (name=${stored.name}, version=${stored.version})`),
    });
  }
  return appRegistry;
}

/**
 * The hosted instances: this node's record of each instance it runs.
 * @returns {import('@runonflux/flux-spec-backend').HostedInstances}
 */
function hostedInstances() {
  if (!hostedInstanceStore) {
    const { HostedInstances } = specLibrary.loaded();
    hostedInstanceStore = new HostedInstances(provider(), {
      chain: nodeChain(),
      onUnreadable: (stored, error) => log.warn(`hostedInstances: a stored record cannot be read: ${error.message} (name=${stored.name}, replica=${stored.replica ?? null}, version=${stored.version})`),
    });
  }
  return hostedInstanceStore;
}

/**
 * The instance resources: what this node created for each instance it runs,
 * keyed as the hosted instance is.
 * @returns {import('@runonflux/flux-spec-backend').InstanceResourceStore}
 */
function instanceResources() {
  if (!instanceResourceStore) {
    const { InstanceResourceStore } = specLibrary.loaded();
    instanceResourceStore = new InstanceResourceStore(provider(), {
      onUnreadable: (stored, error) => log.warn(`instanceResources: a stored record cannot be read: ${error.message} (name=${stored.name}, replica=${stored.replica ?? null})`),
    });
  }
  return instanceResourceStore;
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
 * The decisions: one per decided app message, applied or refused with its
 * reason, keyed by the message's hash.
 * @returns {import('@runonflux/flux-spec-backend').AppDecisions}
 */
function decisions() {
  if (!appDecisions) {
    const { AppDecisions } = specLibrary.loaded();
    appDecisions = new AppDecisions(provider(), {
      onUnreadable: (stored, error) => log.warn(`appDecisions: a stored decision cannot be read: ${error.message} (hash=${stored.hash})`),
    });
  }
  return appDecisions;
}

/**
 * The hosted instance one of whose containers has an identifier, found through
 * its resources; null when no instance's resources name it.
 * @param {string} identifier
 * @returns {Promise<import('@runonflux/flux-spec-backend').HostedInstance|null>}
 */
async function hostedInstanceByIdentifier(identifier) {
  const resources = await instanceResources().byIdentifier(identifier);
  return resources ? hostedInstances().byReplica(resources.name, resources.replica, { includeOwed: true }) : null;
}

/**
 * The key a hosted instance and its resources share, as one string: the name
 * in any letter case, and the replica.
 * @param {{name: string, replica: string|null}} instance
 * @returns {string}
 */
function instanceKey({ name, replica }) {
  return `${String(name).toLowerCase()}\u0000${replica ?? ''}`;
}

module.exports = {
  registry, hostedInstances, instanceResources, messages, manifests, decisions, hostedInstanceByIdentifier, instanceKey, STORES,
};
