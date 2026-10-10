'use strict';

/**
 * The userconfig every test runs against.
 *
 * FluxOS reads this off `globalThis`. tests/init.js sets it when the run loads,
 * for modules that read it when they are required, and again before every
 * test, so no test sees another's. It lives here rather than inline in that
 * file so a test that needs to vary a field can build from the same base the
 * global was built from — two independent copies drift, and a test that "sets"
 * config while the code reads the other one is green without governing
 * anything.
 *
 * A test that needs another config sets it in its own beforeEach or body; a
 * file that sets it when it loads changes it for every test that runs after.
 */
function testUserconfig(overrides = {}) {
  return {
    initial: {
      ipaddress: '127.0.0.1',
      zelid: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC',
      kadena: 'kadena:3a2e6166907d0c2fb28a16cd6966a705de129e8358b9872d9cefe694e910d5b2?chainid=0',
      testnet: false,
      development: false,
      apiport: 16_127,
      routerIP: '',
      pgpPrivateKey: '',
      pgpPublicKey: '',
      ...overrides,
    },
  };
}

module.exports = { testUserconfig };
