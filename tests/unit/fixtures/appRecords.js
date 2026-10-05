'use strict';

const sinon = require('sinon');
const appRecords = require('../../../ZelBack/src/services/appDatabase/appRecords');
const specLibrary = require('../../../ZelBack/src/services/utils/specLibrary');
const moduleLoader = require('../../../ZelBack/src/lib/moduleLoader');
const { loadSpecLibrary } = require('./fluxSpec');

/**
 * The app registry a unit test's subject reads: a real AppRegistry held in
 * memory, or a registry whose every operation is a stub. Either is installed as
 * appRecords.registry() until sinon.restore().
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

function install(registry) {
  if (appRecords.registry.restore) appRecords.registry.restore();
  sinon.stub(appRecords, 'registry').returns(registry);
  return registry;
}

/**
 * A registry whose every operation is a sinon stub, named after the real
 * class's operations so that a test cannot stub one the class does not have.
 * Calling this again in the same test returns the registry already installed.
 * @returns {Object<string, sinon.SinonStub>}
 */
function stubRegistry() {
  if (appRecords.registry.restore) return appRecords.registry();
  const { AppRegistry } = specLibrary.loaded();
  const fake = {};
  for (const method of Object.getOwnPropertyNames(AppRegistry.prototype)) {
    if (method === 'constructor') continue;
    fake[method] = sinon.stub().resolves(DEFAULT_ANSWERS[method]);
  }
  return install(fake);
}

/**
 * A real AppRegistry over flux-spec's in-memory store: a test puts records in
 * and the subject finds them by the registry's own rules.
 * @returns {Promise<import('@runonflux/flux-spec-backend').AppRegistry>}
 */
async function inMemoryRegistry() {
  const { AppRegistry } = await loadSpecLibrary();
  const { InMemoryStorageProvider } = await moduleLoader.importModule('@runonflux/flux-spec-backend/testing');
  return install(new AppRegistry(new InMemoryStorageProvider()));
}

module.exports = { stubRegistry, inMemoryRegistry };
