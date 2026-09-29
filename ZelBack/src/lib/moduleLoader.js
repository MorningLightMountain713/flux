'use strict';

const path = require('node:path');

/**
 * The one place FluxOS loads a module after startup.
 *
 * The API listens after loading only its core - the capability registry, the
 * route tables, the route builder and the servers - and every service loads
 * after it: apiServer loads the process's services once it is listening, and the
 * HTTP layer names the handlers it hands requests to rather than importing them,
 * so each is loaded here the first time it is called. Every other module
 * requires what it uses at the top of its file.
 *
 * An ES module - a package that ships only ESM - is imported through
 * importModule, because CommonJS on the supported Node cannot require one.
 *
 * A module is named by its path under ZelBack/src, without the extension:
 * `services/appQuery/appQueryService`, `lib/socketIoHandlers/debugHandler`.
 * Node keeps every module it has loaded, so a module loads once however often
 * it is asked for.
 */

const SRC_DIR = path.join(__dirname, '..');

/**
 * The module a name refers to, loaded now if it is not yet.
 * @param {string} name path under `baseDir`, without the extension
 * @param {string} [baseDir] ZelBack/src unless a caller names another root
 * @returns {*} the module's exports
 */
function load(name, baseDir = SRC_DIR) {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(path.join(baseDir, name));
}

/**
 * An ES module, imported now if it is not yet.
 * @param {string} specifier a package name, or an absolute path
 * @returns {Promise<object>} the module namespace
 */
function importModule(specifier) {
  return import(specifier);
}

/**
 * A function that calls a module's function, loading the module on its first
 * call. The function is read from the module on every call, so a module's own
 * exports are what answer.
 * @param {string} name module path under ZelBack/src
 * @param {string} [fn] the exported function; the module itself when omitted
 * @returns {Function}
 */
function lazyFunction(name, fn) {
  return function loadedOnFirstCall(...args) {
    const loaded = load(name);
    return fn ? loaded[fn](...args) : loaded(...args);
  };
}

module.exports = {
  importModule,
  lazyFunction,
  load,
  SRC_DIR,
};
