/**
 * The userconfig every test runs against.
 *
 * FluxOS reads this off `globalThis`, set once by tests/init.js. It lives here
 * rather than inline in that file so a test that needs to vary a field can
 * build from the same base the global was built from — two independent copies
 * drift, and a test that "sets" config while the code reads the other one is
 * green without governing anything.
 *
 * Callers that override MUST restore: it is process-global state.
 */
function testUserconfig(overrides = {}) {
  return {
    initial: {
      ipaddress: '127.0.0.1',
      zelid: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC',
      kadena: 'kadena:3a2e6166907d0c2fb28a16cd6966a705de129e8358b9872d9cefe694e910d5b2?chainid=0',
      testnet: false,
      development: false,
      apiport: 16127,
      routerIP: '',
      pgpPrivateKey: '',
      pgpPublicKey: '',
      blockedPorts: [],
      blockedRepositories: [],
      ...overrides,
    },
  };
}

module.exports = { testUserconfig };
