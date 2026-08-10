const fs = require('fs');
const path = require('path');

// Real network I/O from a unit test makes its outcome depend on what else is
// listening on the machine. Loud failure instead of a lucky ECONNREFUSED.
const noRealNetwork = require('./noRealNetwork');
const { testUserconfig } = require('./fixtures/userconfig');

// adjustExternalIP rewrites config/userconfig.js — the node's real identity and
// IP. A unit test that reaches it without stubbing writeFile replaces the
// developer's own node configuration with fixture values, and the file is
// gitignored, so nothing ever shows the damage.
//
// Blocked here and reported in afterAll rather than thrown, because
// adjustExternalIP wraps the write in a try/catch that would swallow it — the
// same reason noRealNetwork reports after the fact.
//
// sinon.stub replaces this wrapper, so a test that stubs writeFile is
// unaffected; only an unstubbed write trips it.
const fsPromises = require('node:fs/promises');

const USERCONFIG_SUFFIX = path.join('config', 'userconfig.js');
const userconfigWrites = [];
const realWriteFile = fsPromises.writeFile;
let currentTest = '(unknown)';

fsPromises.writeFile = async function guardedWriteFile(file, ...rest) {
  if (String(file).endsWith(USERCONFIG_SUFFIX)) {
    userconfigWrites.push(currentTest);
    return undefined;
  }
  return realWriteFile.call(this, file, ...rest);
};

// Root hooks: name the test that opened each connection, and fail the run at
// the end if any did. Reported after the fact because these call paths all
// swallow connection errors — see noRealNetwork.js.
exports.mochaHooks = {
  beforeEach() {
    currentTest = this.currentTest ? this.currentTest.fullTitle() : '(unknown)';
    noRealNetwork.setCurrentTest(currentTest);
  },
  afterAll() {
    if (userconfigWrites.length) {
      for (const name of [...new Set(userconfigWrites)]) {
        console.error(`  wrote the real config/userconfig.js: ${name}`);
      }
      throw new Error(
        `${userconfigWrites.length} unit test write(s) to the real config/userconfig.js were blocked — `
        + 'stub writeFile on node:fs/promises in the tests listed above',
      );
    }
    const count = noRealNetwork.report();
    if (count) throw new Error(`${count} real network connection(s) attempted from unit tests — see the report above`);
  },
};

// Ensure log files exist so the log module doesn't throw ENOENT during tests
for (const name of ['error.log', 'debug.log', 'warn.log']) {
  const p = path.join(process.cwd(), name);
  if (!fs.existsSync(p)) fs.writeFileSync(p, '');
}

globalThis.userconfig = testUserconfig();
