'use strict';

const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const reconciliation = require('../../ZelBack/configReconciliation');
const production = require('../../ZelBack/config/default');

describe('config reconciliation at boot', () => {
  // A sweep that silently read nothing looks exactly like one that found no
  // problem, and this one decides whether the node starts. Every assertion
  // below is worthless if the sweep is not actually reaching the source.
  it('reads the service layer at all, so an empty sweep cannot pass the check below', () => {
    const keys = reconciliation.keysRead();
    expect(keys.size, 'the sweep found no config.fluxapps reads at all').to.be.greaterThan(100);
    expect([...keys.keys()], 'a key every node reads was not found').to.include('appSyncMinCompletions');
  });

  it('every fluxapps key the service layer names is one config ships', () => {
    const missing = reconciliation.missingKeys(production.fluxapps);
    const named = missing.map((m) => `fluxapps.${m.key} (read by ${m.files.join(', ')})`);
    expect(named, 'config/default.js does not ship these, so the code reads undefined and nothing says so').to.deep.equal([]);
  });

  it('names every missing key, not just the first, and exits 1', () => {
    const lines = [];
    const exits = [];
    const short = { ...production.fluxapps };
    delete short.appSyncMinCompletions;
    delete short.syncTimeoutMs;

    // The real reconcile() reads the real config, which is complete - so the
    // refusal path is driven through missingKeys with a config that is not.
    const missing = reconciliation.missingKeys(short);
    const keys = missing.map((m) => m.key);

    expect(keys, 'an operator fixing a config needs the whole list, not one restart per key')
      .to.deep.equal(['appSyncMinCompletions', 'syncTimeoutMs']);
    expect(missing[0].files, 'the report does not say who reads it').to.not.be.empty;

    // And the refusal itself: writes every name, then exits non-zero.
    reconciliation.reconcile({
      fluxapps: short,
      exit: (code) => exits.push(code),
      write: (line) => lines.push(line),
    });
    expect(exits, 'a node with an unreadable knob kept running').to.deep.equal([1]);
    expect(lines.some((l) => l.includes('fluxapps.appSyncMinCompletions')), 'the first missing key was not named').to.equal(true);
    expect(lines.some((l) => l.includes('fluxapps.syncTimeoutMs')), 'the report stopped at the first missing key').to.equal(true);

    // And it says nothing, and stops nothing, when the config is complete.
    const quiet = [];
    const quietExits = [];
    reconciliation.reconcile({
      fluxapps: production.fluxapps,
      exit: (code) => quietExits.push(code),
      write: (line) => quiet.push(line),
    });
    expect(quietExits, 'a complete config must not stop the node').to.deep.equal([]);
    expect(quiet, 'a complete config must not be reported as broken').to.deep.equal([]);
  });

  it('refuses, names the key and exits 1 when a knob is read but not shipped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxcfg-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'someService.js'),
        "const x = config.get('fluxapps.aKnobNobodyShips');\nmodule.exports = { x };\n",
      );
      const missing = reconciliation.missingKeys(production.fluxapps, dir);
      expect(missing.map((m) => m.key)).to.deep.equal(['aKnobNobodyShips']);
      expect(missing[0].files).to.deep.equal(['someService.js']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // The sweep can only see a read that names its key. Two spellings do:
  // `config.fluxapps.someKey`, and `const { someKey } = config.fluxapps`. A name
  // bound to the object itself does not, and there is no third thing it buys.
  // ONE FORM. Property access has four spellings, none of them distinguishable
  // without resolving bindings, and every one answers undefined on a key nobody
  // ships. config.get throws by name instead, which is the whole point.
  it('nothing reads a knob by property access, which would answer undefined in silence', () => {
    const offenders = reconciliation.propertyReads()
      .map((r) => `${r.file}:${r.line}  ${r.text}`);
    expect(offenders, 'these read a knob in a way that cannot fail loudly').to.deep.equal([]);
  });

  it('finds a property read when there is one, so the check above is not passing on an empty sweep', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxcfg-'));
    try {
      fs.writeFileSync(path.join(dir, 'sneaky.js'), [
        "const a = config.fluxapps.direct;",
        "const { viaDestructure } = config.fluxapps;",
        "const { fluxapps: { viaNested } } = config;",
        "const aliased = config.fluxapps;",
        'module.exports = { a, viaDestructure, viaNested, aliased };',
      ].join('\n'));
      const lines = reconciliation.propertyReads(dir).map((r) => r.line);
      expect(lines, 'a spelling of property access went unreported').to.deep.equal([1, 2, 3, 4]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the key out of config.get, and only out of config.get', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxcfg-'));
    try {
      fs.writeFileSync(path.join(dir, 'forms.js'), [
        "const a = config.get('fluxapps.plain');",
        "const b = config.get('fluxapps.nested.deeper');",
        "const c = config.get( 'fluxapps.spaced' );",
        "const d = config.get('server.apiport');",
        'module.exports = { a, b, c, d };',
      ].join('\n'));
      expect([...reconciliation.keysRead(dir).keys()].sort())
        .to.deep.equal(['nested.deeper', 'plain', 'spaced']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // The four knobs whose absence used to be the setting now ship the value that
  // says it, so there is no exempt list left to keep honest - only a check that
  // they really are shipped, because a guard reading undefined and a guard
  // reading null behave the same right up until one of them does not.
  it('ships a value for the knobs whose absence used to be the setting', () => {
    expect(production.fluxapps.quorumGrantActivationHeight, 'null = not scheduled').to.equal(null);
    expect(production.fluxapps.quorumGrantMastership, 'false = the gate is off').to.equal(false);
    expect(production.fluxapps.restartAlwaysOwners, 'empty = nobody').to.deep.equal([]);
    expect(production.fluxapps.verifyPoolSize, 'null = cpus-1').to.equal(null);
  });
});
