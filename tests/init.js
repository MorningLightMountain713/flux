const fs = require('fs');
const path = require('path');

// Real network I/O from a unit test makes its outcome depend on what else is
// listening on the machine. Loud failure instead of a lucky ECONNREFUSED.
const noRealNetwork = require('./noRealNetwork');

// Root hooks: name the test that opened each connection, and fail the run at
// the end if any did. Reported after the fact because these call paths all
// swallow connection errors — see noRealNetwork.js.
exports.mochaHooks = {
  beforeEach() {
    noRealNetwork.setCurrentTest(this.currentTest ? this.currentTest.fullTitle() : '(unknown)');
  },
  afterAll() {
    const count = noRealNetwork.report();
    if (count) throw new Error(`${count} real network connection(s) attempted from unit tests — see the report above`);
  },
};

// Ensure log files exist so the log module doesn't throw ENOENT during tests
for (const name of ['error.log', 'debug.log', 'warn.log']) {
  const p = path.join(process.cwd(), name);
  if (!fs.existsSync(p)) fs.writeFileSync(p, '');
}

globalThis.userconfig = {
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
  },
};
