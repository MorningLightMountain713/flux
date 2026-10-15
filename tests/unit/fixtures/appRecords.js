'use strict';

const sinon = require('sinon');
const appRecords = require('../../../ZelBack/src/services/appDatabase/appRecords');
const specLibrary = require('../../../ZelBack/src/services/utils/specLibrary');
const moduleLoader = require('../../../ZelBack/src/lib/moduleLoader');
const { loadSpecLibrary } = require('./fluxSpec');

/**
 * The app registry, the installed apps, the installed ledgers, the app
 * messages and the content manifests a unit test's subject reads: a real
 * collection held in memory, or one whose every operation is a stub. Either is
 * installed as appRecords.registry(), appRecords.installed(),
 * appRecords.ledgers(), appRecords.messages() or appRecords.manifests() until
 * sinon.restore().
 */

// What each operation answers until a test says otherwise.
const DEFAULT_ANSWERS = {
  byName: null,
  byIdentity: null,
  byNames: [],
  find: [],
  all: [],
  names: [],
  alive: [],
  pinnedTo: [],
  pinned: [],
  completeDerivedFields: 0,
};

function install(accessor, collection) {
  if (appRecords[accessor].restore) appRecords[accessor].restore();
  sinon.stub(appRecords, accessor).returns(collection);
  return collection;
}

function stubbed(CollectionClass, defaults) {
  const fake = {};
  for (const method of Object.getOwnPropertyNames(CollectionClass.prototype)) {
    if (method === 'constructor') continue;
    fake[method] = sinon.stub().resolves(defaults[method]);
  }
  return fake;
}

/**
 * A registry whose every operation is a sinon stub, named after the real
 * class's operations so that a test cannot stub one the class does not have.
 * Calling this again in the same test returns the registry already installed.
 * @returns {Object<string, sinon.SinonStub>}
 */
function stubRegistry() {
  if (appRecords.registry.restore) return appRecords.registry();
  return install('registry', stubbed(specLibrary.loaded().AppRegistry, DEFAULT_ANSWERS));
}

// What each installed-apps operation answers until a test says otherwise.
const INSTALLED_ANSWERS = {
  byName: null,
  byReplica: null,
  byIdentity: null,
  instancesOf: [],
  all: [],
  apps: [],
  names: [],
  keys: [],
  owed: [],
  legacyMoves: [],
  completeDerivedFields: 0,
};

// What each installed-ledgers operation answers until a test says otherwise.
const LEDGER_ANSWERS = {
  byInstance: null,
  byIdentifier: null,
  instancesOf: [],
  all: [],
  keys: [],
  addComponent: true,
};

/**
 * The installed apps with every operation a sinon stub, installed as
 * appRecords.installed(); calling it again in the same test returns it.
 * @returns {Object<string, sinon.SinonStub>}
 */
function stubInstalled() {
  if (appRecords.installed.restore) return appRecords.installed();
  return install('installed', stubbed(specLibrary.loaded().InstalledApps, INSTALLED_ANSWERS));
}

/**
 * The installed ledgers with every operation a sinon stub, installed as
 * appRecords.ledgers(); calling it again in the same test returns it.
 * @returns {Object<string, sinon.SinonStub>}
 */
function stubLedgers() {
  if (appRecords.ledgers.restore) return appRecords.ledgers();
  return install('ledgers', stubbed(specLibrary.loaded().InstalledLedgers, LEDGER_ANSWERS));
}

/**
 * A real AppRegistry over flux-spec's in-memory store: a test puts records in
 * and the subject finds them by the registry's own rules.
 * @returns {Promise<import('@runonflux/flux-spec-backend').AppRegistry>}
 */
async function inMemoryRegistry() {
  const { AppRegistry, Chain } = await loadSpecLibrary();
  const { InMemoryStorageProvider } = await moduleLoader.importModule('@runonflux/flux-spec-backend/testing');
  return install('registry', new AppRegistry(new InMemoryStorageProvider(), { chain: Chain.MAIN }));
}

/**
 * A real InstalledApps over flux-spec's in-memory store, installed as
 * appRecords.installed(), with the store beside it so a test can seed a stored
 * form the collection would not write itself.
 * @returns {Promise<{installed: import('@runonflux/flux-spec-backend').InstalledApps, provider: object}>}
 */
async function inMemoryInstalled() {
  const { InstalledApps, Chain } = await loadSpecLibrary();
  const { InMemoryStorageProvider } = await moduleLoader.importModule('@runonflux/flux-spec-backend/testing');
  const provider = new InMemoryStorageProvider();
  return { installed: install('installed', new InstalledApps(provider, { chain: Chain.MAIN })), provider };
}

/**
 * A real InstalledLedgers over flux-spec's in-memory store, installed as
 * appRecords.ledgers(), with the store beside it.
 * @returns {Promise<{ledgers: import('@runonflux/flux-spec-backend').InstalledLedgers, provider: object}>}
 */
async function inMemoryLedgers() {
  const { InstalledLedgers } = await loadSpecLibrary();
  const { InMemoryStorageProvider } = await moduleLoader.importModule('@runonflux/flux-spec-backend/testing');
  const provider = new InMemoryStorageProvider();
  return { ledgers: install('ledgers', new InstalledLedgers(provider)), provider };
}

// What each app-messages operation answers until a test says otherwise.
const MESSAGE_ANSWERS = {
  byHash: null,
  byHashes: [],
  payment: null,
  payments: new Map(),
  recordPayment: 'recorded',
  recordPayments: { recorded: [], standing: [] },
  awaitingContents: [],
  removePaymentsAbove: { kept: 0, removed: 0 },
  clearPayments: { kept: 0, removed: 0 },
  resetSyncState: 0,
  storeContents: { record: null, stored: false },
  signedByName: null,
  waitingTransfer: null,
  pool: [],
  windowsClosedBy: [],
  carriedManifestRanks: [],
  confirmed: [],
  confirmedSummaries: [],
  confirmedByHashes: [],
  confirmedNamed: [],
  confirmedFind: [],
  confirmedCount: 0,
  confirmedHashes: new Set(),
  paid: [],
  withoutPosition: [],
};

/**
 * The app messages with every operation a sinon stub, installed as
 * appRecords.messages(); calling it again in the same test returns it.
 * @returns {Object<string, sinon.SinonStub>}
 */
function stubMessages() {
  if (appRecords.messages.restore) return appRecords.messages();
  return install('messages', stubbed(specLibrary.loaded().AppMessages, MESSAGE_ANSWERS));
}

/**
 * A real AppMessages over flux-spec's in-memory store, installed as
 * appRecords.messages(), with the store beside it.
 * @returns {Promise<{messages: import('@runonflux/flux-spec-backend').AppMessages, provider: object}>}
 */
async function inMemoryMessages() {
  const { AppMessages } = await loadSpecLibrary();
  const { InMemoryStorageProvider } = await moduleLoader.importModule('@runonflux/flux-spec-backend/testing');
  const provider = new InMemoryStorageProvider();
  return { messages: install('messages', new AppMessages(provider)), provider };
}

// What each content-manifests operation answers until a test says otherwise.
const MANIFEST_ANSWERS = {
  byIdentity: [],
  byHash: null,
  put: { inserted: true },
  remove: true,
  removeAll: 0,
  dropHashless: 0,
  resolved: [],
  ranks: [],
  broadcasts: [],
  resolvedIdentities: [],
};

/**
 * The content manifests with every operation a sinon stub, installed as
 * appRecords.manifests(); calling it again in the same test returns it.
 * @returns {Object<string, sinon.SinonStub>}
 */
function stubManifests() {
  if (appRecords.manifests.restore) return appRecords.manifests();
  return install('manifests', stubbed(specLibrary.loaded().ContentManifests, MANIFEST_ANSWERS));
}

/**
 * A real ContentManifests over flux-spec's in-memory store, installed as
 * appRecords.manifests(), with the store beside it.
 * @returns {Promise<{manifests: import('@runonflux/flux-spec-backend').ContentManifests, provider: object}>}
 */
async function inMemoryManifests() {
  const { ContentManifests } = await loadSpecLibrary();
  const { InMemoryStorageProvider } = await moduleLoader.importModule('@runonflux/flux-spec-backend/testing');
  const provider = new InMemoryStorageProvider();
  return { manifests: install('manifests', new ContentManifests(provider)), provider };
}

/**
 * An installed record over a registered record, for a stub to answer with: the
 * real InstalledSpec when the record is a real InstantiatedSpec, else a
 * stand-in with the same shape over a plain object.
 * @param {object|null} record - an InstantiatedSpec, a plain stand-in, or null
 * @param {{replica?: string|null, owed?: object|null, componentKeys?: Map<string, string>|null}} [own]
 * @returns {object|null}
 */
function installedRecord(record, { replica = null, owed = null, componentKeys = null } = {}) {
  if (!record) return null;
  const { InstalledSpec, InstantiatedSpec } = specLibrary.loaded();
  if (record instanceof InstantiatedSpec) {
    return new InstalledSpec({
      record, replica, owed, componentKeys,
    });
  }
  // A plain row answers serialize() as a registered record does.
  const registered = typeof record.serialize === 'function'
    ? record
    : Object.defineProperty({ ...record }, 'serialize', { value: () => ({ ...record }), enumerable: false });
  return {
    record: registered,
    replica,
    owed,
    spec: record.spec,
    name: record.name,
    identity: record.identity ?? null,
    uuid: record.uuid ?? null,
    hash: record.hash ?? null,
    height: record.height ?? null,
    owner: record.owner ?? null,
    version: record.version ?? null,
    isEncrypted: record.isEncrypted ?? false,
    placement: record.placement,
    serialize: () => (typeof record.serialize === 'function' ? record.serialize() : { ...record }),
  };
}

module.exports = {
  stubRegistry, inMemoryRegistry, stubInstalled, inMemoryInstalled, stubLedgers, inMemoryLedgers, stubMessages, inMemoryMessages, stubManifests, inMemoryManifests, installedRecord,
};
