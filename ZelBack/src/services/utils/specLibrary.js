'use strict';

const { load } = require('@runonflux/flux-spec-cjs');

// The process loads flux-spec once, before anything else runs (apiServer.initiate,
// and the unit suite's root hook), and from then on any code - synchronous code
// included - reaches it through loaded(). No config here: the unit suite's root
// hook requires this before a test file has chosen its config directory.
let loadedNamespace = null;

/**
 * Loads flux-spec. Awaited first thing at process start.
 * @returns {Promise<Readonly<Object>>}
 */
async function loadSpecLibrary() {
  loadedNamespace = await load();
  return loadedNamespace;
}

/**
 * flux-spec, already loaded. Throws when called before the process loaded it: a
 * caller that runs that early is out of order, and says so.
 * @returns {Readonly<Object>}
 */
function loaded() {
  if (!loadedNamespace) throw new Error('flux-spec is not loaded yet: specLibrary.loadSpecLibrary() runs first at process start');
  return loadedNamespace;
}

module.exports = { loadSpecLibrary, loaded };
