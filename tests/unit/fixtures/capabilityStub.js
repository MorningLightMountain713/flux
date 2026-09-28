'use strict';

/**
 * A stand-in for the capability registry's reader side, for a module a test
 * loads through proxyquire. `set` moves a capability and releases every
 * `whenUp` waiting on a set that is now up.
 *
 * @param {Object<string, boolean>} [initial] capabilities up at the start
 * @returns {{state: Object<string, boolean>, isUp: Function, whenUp: Function,
 *   set: (name: string, up: boolean) => void}}
 */
function capabilityStub(initial = {}) {
  const state = { ...initial };
  const waiters = [];
  const names = (nameOrNames) => (Array.isArray(nameOrNames) ? nameOrNames : [nameOrNames]);
  const stub = {
    state,
    isUp: (nameOrNames) => names(nameOrNames).every((name) => state[name] === true),
    whenUp: (nameOrNames) => (stub.isUp(nameOrNames)
      ? Promise.resolve()
      : new Promise((resolve) => { waiters.push({ nameOrNames, resolve }); })),
    set(name, up) {
      state[name] = up;
      for (const waiter of [...waiters]) {
        if (stub.isUp(waiter.nameOrNames)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
    },
  };
  return stub;
}

module.exports = { capabilityStub };
