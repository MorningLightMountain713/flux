'use strict';

const production = require('../../../ZelBack/config/default');

/**
 * A config stub that answers get() and has() the way node-config does.
 *
 * The service layer reads every knob as `config.get('fluxapps.x')`, because
 * that THROWS by name on a key nobody ships where property access answers
 * undefined and says nothing. A test that hands the code a plain object takes
 * that guarantee away again: the object has no get(), so the read fails for the
 * wrong reason, and an object that did have one written by hand would not throw
 * where production throws.
 *
 * A Proxy rather than a copy, because tests mutate the stub between assertions
 * (`configStub.fluxapps.volumeOperations.stallTimeoutMs = 120`) and expect the
 * next read to see it.
 *
 * @param {object} obj the plain config object the test wants the code to see
 * @returns {object} the same object, answering get and has
 */
function asConfig(obj) {
  const step = (root, key) => String(key).split('.')
    .reduce((acc, part) => (acc == null ? undefined : acc[part]), root);

  // The stub OVERRIDES the shipped config, it does not replace it. A test that
  // cares about two knobs says two, and every other read answers what a node
  // would answer - which is also what node-config does with a deployment file
  // over default.js. Replacing it outright is how a stub ends up asserting
  // against numbers no node has.
  const resolve = (key) => {
    const own = step(obj, key);
    return own === undefined ? step(production, key) : own;
  };

  return new Proxy(obj, {
    get(target, prop, receiver) {
      if (prop === 'get') {
        return (key) => {
          const value = resolve(key);
          // node-config's own message, so a test asserting on it reads the same
          // string it would read from a node.
          if (value === undefined) throw new Error(`Configuration property "${key}" is not defined`);
          return value;
        };
      }
      if (prop === 'has') return (key) => resolve(key) !== undefined;
      return Reflect.get(target, prop, receiver);
    },
  });
}

module.exports = { asConfig };
