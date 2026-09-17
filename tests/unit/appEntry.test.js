// An entry point pins four environment variables before its first require, and what
// they are worth is only visible in a process that actually loaded it. So this loads
// each real entry point in a child, and reads the environment back out.
//
// A child rather than an in-process require: both pull the service tree, which leaves
// timers and connections open, and those must not outlive one test. The require.main
// guard in each is what makes loading it safe at all - without it the child would
// start a node.
//
// Both are covered because both are entry points. app.js is what fluxos.service runs,
// and apiServer.js self-starts under `require.main === module`, so a process can begin
// at either and has to answer the same way whichever it began at.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const repoRoot = path.join(__dirname, '..', '..');

// WHAT AN ENTRY POINT IS, rather than a list of the ones we remembered.
//
// A hand-written list is the rot: a third entry point added later is covered by
// nothing and nothing fails, and the pins are exactly the kind of thing whose
// absence is invisible until a node is disclosing stack traces in production.
//
// A root-level file that reaches into ZelBack is a file a process can begin at
// and that pulls the service tree with it, so it has to settle the environment
// before it does. Everything else at the root is named below with its reason.
const NOT_AN_ENTRY_POINT = new Map([
  ['init.js', 'writes config/userconfig.js with inquirer and never reads node-config'],
  ['sampleUserConfig.js', 'a data file - the template init.js writes from'],
]);

// Dotfiles are tooling configuration, read by eslint and never by node as a
// program - they are not files a process can begin at.
const rootJsFiles = fs.readdirSync(repoRoot)
  .filter((name) => name.endsWith('.js') && !name.startsWith('.'))
  .sort();

const ENTRY_POINTS = rootJsFiles
  .filter((name) => !NOT_AN_ENTRY_POINT.has(name))
  .map((name) => ({ name, file: path.join(repoRoot, name) }));

// The child starts with every one of these already set, and set wrongly. A value taken
// from the environment changes what the node discloses without any file saying so, which
// is the whole reason the pins assign rather than default. Seeded here so each assertion
// below can fail: against an inherited environment they would all pass on absence.
const HOSTILE_ENV = {
  NODE_ENV: 'development',
  NODE_CONFIG_ENV: 'production',
  NODE_CONFIG: '{"fluxSpecifics":{"apiPort":9999}}',
  NODE_CONFIG_DIR: '/tmp/not-the-pinned-config-directory',
};

/**
 * Loads a real entry point in a child process and reports what it left behind.
 * @param {string} entryFile - absolute path to the entry point
 * @returns {Promise<{env: object, stderr: string}>}
 */
function loadEntryPoint(entryFile) {
  const script = `require(${JSON.stringify(entryFile)});
    process.stdout.write(JSON.stringify({
      NODE_ENV: process.env.NODE_ENV ?? null,
      NODE_CONFIG_ENV: process.env.NODE_CONFIG_ENV ?? null,
      NODE_CONFIG: process.env.NODE_CONFIG ?? null,
      NODE_CONFIG_DIR: process.env.NODE_CONFIG_DIR ?? null,
    }));
    process.exit(0);`;

  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...HOSTILE_ENV };
    execFile(process.execPath, ['-e', script], { env, timeout: 60_000 }, (error, stdout, stderr) => {
      if (error && !stdout) {
        reject(new Error(`${entryFile} could not be loaded: ${error.message}\n${stderr}`));
        return;
      }
      resolve({ env: JSON.parse(stdout), stderr });
    });
  });
}

describe('which files are entry points', () => {
  // There is deliberately no test that "every root file is covered": the list
  // below IS every root file minus the exemptions, so such a test cannot fail
  // and would only look like cover. What makes a new entry point safe is the
  // derivation itself - a file dropped at the root is described and run through
  // every assertion in this file without anyone adding it to a list. Verified
  // by planting one: it was picked up and failed the require-order check.
  //
  // So the only thing left to check is the escape hatch.
  it('names a reason for every root file it does not treat as an entry point', () => {
    NOT_AN_ENTRY_POINT.forEach((why, name) => {
      expect(rootJsFiles, `${name} is exempt but no longer exists - drop the exemption`).to.include(name);
      expect(why, `${name} is exempt with no reason recorded`).to.be.a('string').with.length.greaterThan(20);
      expect(
        fs.readFileSync(path.join(repoRoot, name), 'utf8'),
        `${name} now reaches into ZelBack, so the reason it was exempt no longer holds`,
      ).to.not.contain("require('./ZelBack/");
    });
  });

  it('found entry points at all, so an empty list cannot pass every check below', () => {
    expect(ENTRY_POINTS.map((e) => e.name)).to.include.members(['app.js', 'apiServer.js']);
  });
});

ENTRY_POINTS.forEach(({ name, file }) => {
  describe(`the entry point: ${name}`, function () {
    this.timeout(90_000);

    let loaded;

    before(async () => {
      loaded = await loadEntryPoint(file);
    });

    // Express hands a caller the exception stack instead of the status text, and
    // apicache stamps its version onto every cached response, unless this says
    // production. Both read it after the entry point has loaded, so the assertion is
    // on the value the entry point leaves set.
    it('runs the node in production mode, whatever the environment asked for', () => {
      expect(loaded.env.NODE_ENV).to.equal('production');
    });

    // node-config names its deployment from the environment, preferring this variable
    // to NODE_ENV, and prints a warning for a name it has no file for. ZelBack/config
    // holds default.js alone, so production must not reach it. That is why the two are
    // pinned together and neither is pinned on its own.
    it('leaves the config deployment where it was, and says nothing on startup', () => {
      expect(loaded.env.NODE_CONFIG_ENV).to.equal('development');
      expect(loaded.stderr).to.not.contain('did not match any deployment config file names');
    });

    // A config directory that moves, or a NODE_CONFIG merged over every file, redirects
    // an endpoint without changing a single line of the node's own code.
    //
    // Asserted on the process rather than on the file that set it: what matters is the
    // state a loaded entry point is in, not which line put it there.
    it('pins the config directory and closes the one that is merged over it', () => {
      expect(loaded.env.NODE_CONFIG_DIR).to.equal(`${repoRoot}/ZelBack/config/`);
      expect(loaded.env.NODE_CONFIG).to.equal(null);
    });

    // Both of these are order-dependent and neither fails visibly when the order
    // is wrong: node-config, express and apicache read the environment as they
    // load, so a require placed above the pins answers the question first, and
    // the reconciliation has to run before anything reads a knob rather than
    // after something has already read undefined.
    //
    // Asserted on the source because the damage is silent in the end state: the
    // variables are still set afterwards either way.
    it('pins the environment and reconciles config before it requires anything else', () => {
      const source = fs.readFileSync(file, 'utf8');
      const requires = [...source.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
      expect(requires[0], 'something is required above the environment pins').to.equal('./ZelBack/pinEnvironment');
      expect(requires[1], 'a knob could be read before the config reconciliation runs').to.equal('./ZelBack/configReconciliation');
    });
  });
});
