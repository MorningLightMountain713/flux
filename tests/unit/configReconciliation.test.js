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
    expect(keys.size, 'the sweep found no config.get reads at all').to.be.greaterThan(300);
    expect([...keys.keys()], 'a setting every node reads was not found')
      .to.include.members(['fluxapps.appSyncMinCompletions', 'server.apiport']);
  });

  it('every setting the service layer names is one config ships', () => {
    const missing = reconciliation.missingKeys(production);
    const named = missing.map((m) => `${m.key} (read by ${m.files.join(', ')})`);
    expect(named, 'config/default.js does not ship these, so the code reads undefined and nothing says so').to.deep.equal([]);
  });

  it('names every missing key, not just the first, and exits 1', () => {
    const lines = [];
    const exits = [];
    const short = { ...production, fluxapps: { ...production.fluxapps }, server: { ...production.server } };
    delete short.fluxapps.appSyncMinCompletions;
    delete short.server.apiport;

    // The real reconcile() reads the real config, which is complete - so the
    // refusal path is driven through missingKeys with a config that is not.
    const missing = reconciliation.missingKeys(short);
    const keys = missing.map((m) => m.key);

    expect(keys, 'an operator fixing a config needs the whole list, not one restart per key')
      .to.deep.equal(['fluxapps.appSyncMinCompletions', 'server.apiport']);
    expect(missing[0].files, 'the report does not say who reads it').to.not.be.empty;

    // And the refusal itself: writes every name, then exits non-zero.
    reconciliation.reconcile({
      config: short,
      exit: (code) => exits.push(code),
      write: (line) => lines.push(line),
    });
    expect(exits, 'a node with an unreadable knob kept running').to.deep.equal([1]);
    expect(lines.some((l) => l.includes('fluxapps.appSyncMinCompletions')), 'the first missing key was not named').to.equal(true);
    expect(lines.some((l) => l.includes('server.apiport')), 'the report stopped at the first missing key').to.equal(true);

    // And it says nothing, and stops nothing, when the config is complete.
    const quiet = [];
    const quietExits = [];
    reconciliation.reconcile({
      config: production,
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
      const missing = reconciliation.missingKeys(production, dir);
      expect(missing.map((m) => m.key)).to.deep.equal(['fluxapps.aKnobNobodyShips']);
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
  it('nothing reads a setting by property access, which would answer undefined in silence', () => {
    const offenders = reconciliation.propertyReads()
      .map((r) => `${r.file}:${r.line}  ${r.text}`);
    expect(offenders, 'these read a knob in a way that cannot fail loudly').to.deep.equal([]);
  });

  it('finds a property read when there is one, so the check above is not passing on an empty sweep', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxcfg-'));
    try {
      fs.writeFileSync(path.join(dir, 'sneaky.js'), [
        "const config = require('config');",
        "const a = config.fluxapps.direct;",
        "const { viaDestructure } = config.fluxapps;",
        "const { fluxapps: { viaNested } } = config;",
        "const aliased = config.fluxapps;",
        'module.exports = { a, viaDestructure, viaNested, aliased };',
      ].join('\n'));
      const lines = reconciliation.propertyReads(dir).map((r) => r.line);
      expect(lines, 'a spelling of property access went unreported').to.deep.equal([2, 3, 4, 5]);
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
        .to.deep.equal(['fluxapps.nested.deeper', 'fluxapps.plain', 'fluxapps.spaced', 'server.apiport']);
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

describe('release config relations at boot', () => {
  const nodeDownCertificates = require('../../ZelBack/src/services/utils/nodeDownCertificates');

  // The window a running node has to take its lease in before the plane starts
  // governing. Denominated in blocks, spent in milliseconds, so the two sides
  // of it are set in different units by different hands.
  const ISSUE_TO_PUBLISH_SLACK_MS = 30 * 60 * 1000;

  function withFluxapps(over) {
    return { ...production, fluxapps: { ...production.fluxapps, ...over } };
  }

  it('the shipped config satisfies every relation', () => {
    const broken = reconciliation.brokenRelations(production).map((r) => r.name);
    expect(broken, 'a relation the shipped values do not satisfy').to.deep.equal([]);
  });

  it('a window too short for a referee restart stops a node whose plane is scheduled', () => {
    const lines = [];
    const exits = [];
    // 11 blocks is the floor at the shipped drain and ask timeout; 10 is under it.
    reconciliation.reconcile({
      config: withFluxapps({ quorumGrantPreWindowBlocks: 10, quorumGrantActivationHeight: 1_900_000 }),
      exit: (code) => exits.push(code),
      write: (line) => lines.push(line),
    });

    expect(exits, 'a node scheduled to cross with a window that cannot cover a restart kept booting').to.deep.equal([1]);
    expect(lines.join('\n'), 'the refusal did not name the arithmetic').to.match(/300000 \+ 5000 \+ 3 x 5000/);
    expect(lines.join('\n'), 'the refusal did not name the window it computed').to.include('300000 ms');
  });

  it('the same break only warns while the plane is not scheduled', () => {
    const lines = [];
    const exits = [];
    reconciliation.reconcile({
      config: withFluxapps({ quorumGrantPreWindowBlocks: 10, quorumGrantActivationHeight: null }),
      exit: (code) => exits.push(code),
      write: (line) => lines.push(line),
    });

    expect(exits, 'a fleet was stopped over a plane that reaches nothing until it is scheduled').to.deep.equal([]);
    expect(lines.join('\n'), 'a broken relation went unreported').to.include('quorumGrantPreWindowBlocks');
  });

  it('a drain that outlives the lease it drains is a relation of its own', () => {
    const broken = reconciliation.brokenRelations(
      withFluxapps({ quorumGrantDrainMs: 300_001, quorumGrantActivationHeight: 1_900_000 }),
    );

    expect(broken.map((r) => r.name), 'the drain relation did not break on its own')
      .to.deep.equal(['a drain ends inside the lease it drains']);
    expect(broken[0].armed, 'a scheduled plane did not arm the relation').to.equal(true);
  });

  // R3 is a relation between a shipped value and a constant in the code, so it
  // cannot drift at runtime and is not the boot check's business - only an edit
  // to either side can break it, and this is where that edit is caught.
  // Equality is exactly sufficient: a record is alive while
  // broadcastedAt > now - RECORD_LIFETIME_MS, its membership moment is at most
  // the slack older, and the prune keeps at >= now - retention.
  it('membership history still covers the oldest moment a live certificate can name', () => {
    const bound = nodeDownCertificates.RECORD_LIFETIME_MS + ISSUE_TO_PUBLISH_SLACK_MS;
    expect(production.fluxapps.membershipHistoryRetentionMs, `retention must cover ${bound} ms`)
      .to.be.at.least(bound);
  });
});

describe('what counts as a scheduled plane', () => {
  // `undefined !== null` is true, so a height read off a config that does not
  // carry the key would arm a relation and stop a boot that nothing threatens.
  it('arms on a height and on nothing else', () => {
    const armed = (height) => reconciliation
      .relations({ ...production, fluxapps: { ...production.fluxapps, quorumGrantActivationHeight: height } })
      .every((r) => r.armed);

    expect(armed(1_900_000), 'a scheduled height did not arm the relations').to.equal(true);
    expect(armed(null), 'null is not scheduled').to.equal(false);
    expect(armed(undefined), 'an absent height is not scheduled').to.equal(false);
  });
});
