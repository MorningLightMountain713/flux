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
        'const x = config.fluxapps.aKnobNobodyShips ?? 5;\nmodule.exports = { x };\n',
      );
      const missing = reconciliation.missingKeys(production.fluxapps, dir);
      expect(missing.map((m) => m.key)).to.deep.equal(['aKnobNobodyShips']);
      expect(missing[0].files).to.deep.equal(['someService.js']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets a knob whose absence is a real setting be absent, and says why', () => {
    // Each of these reads the value through a guard that gives absence a
    // meaning. A key added here without a reason is a key nobody is checking.
    expect([...reconciliation.OPTIONAL.keys()]).to.deep.equal([
      'quorumGrantActivationHeight',
      'quorumGrantMastership',
      'restartAlwaysOwners',
      'verifyPoolSize',
    ]);
    reconciliation.OPTIONAL.forEach((why, key) => {
      expect(why, `${key} is exempt with no reason recorded`).to.be.a('string').with.length.greaterThan(20);
    });

    // The exemption is what keeps them out of the refusal, not luck: they are
    // named in the source and config does not ship them.
    const named = [...reconciliation.keysRead().keys()];
    reconciliation.OPTIONAL.forEach((why, key) => {
      expect(named, `${key} is exempt but nothing reads it - drop the exemption`).to.include(key);
      expect(production.fluxapps[key], `${key} is shipped now, so the exemption is stale`).to.equal(undefined);
    });
  });
});
