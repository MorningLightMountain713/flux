'use strict';

const { expect } = require('chai');

const { blame, criticalChain } = require('../../ZelBack/src/services/utils/capabilityReadout');

const STARTED = 1_000_000;

// A snapshot entry: up at `upAfterMs` after the start, or never when null.
function capability(name, needs, upAfterMs, comingUpMs = 0, extra = {}) {
  return {
    name,
    needs,
    waits: [],
    state: upAfterMs === null ? 'down' : 'up',
    reason: `${name} reason`,
    waitingOn: upAfterMs === null ? name : null,
    firstUp: upAfterMs === null ? null : { at: STARTED + upAfterMs, comingUpMs },
    ...extra,
  };
}

describe('capabilityReadout tests', () => {
  // mongo -> localDb -> registry, with explorer a second prerequisite of registry
  // that came up after localDb did.
  const boot = () => [
    capability('mongo', [], 100),
    capability('localDb', ['mongo'], 400, 300),
    capability('explorer', [], 900),
    capability('registry', ['localDb', 'explorer'], 1200, 1100),
    capability('policy', [], null),
  ];

  describe('blame', () => {
    it('puts what never came up first, then the slowest', () => {
      expect(blame(boot(), STARTED).map((row) => row.name))
        .to.deep.equal(['policy', 'registry', 'explorer', 'localDb', 'mongo']);
    });

    it('says how long after the start each came up, how long of that it was held, and by what', () => {
      const rows = Object.fromEntries(blame(boot(), STARTED).map((row) => [row.name, row]));
      expect(rows.registry).to.deep.equal({
        name: 'registry', upAfterMs: 1200, comingUpMs: 1100, waitedOn: 'explorer', state: 'up', reason: 'registry reason',
      });
      expect(rows.localDb.waitedOn).to.equal('mongo');
      expect(rows.mongo.waitedOn, 'one with no prerequisite waited on its own owner').to.equal(null);
    });

    it('names what a capability that never came up waits on now', () => {
      const row = blame(boot(), STARTED).find((r) => r.name === 'policy');
      expect(row).to.include({ upAfterMs: null, comingUpMs: null, waitedOn: 'policy', state: 'down' });
    });

    it('orders capabilities that rose together by name', () => {
      const rows = blame([capability('b', [], 5), capability('a', [], 5)], STARTED);
      expect(rows.map((row) => row.name)).to.deep.equal(['a', 'b']);
    });
  });

  describe('criticalChain', () => {
    it('follows the last capability up back through the prerequisite that rose last', () => {
      expect(criticalChain(boot(), STARTED)).to.deep.equal([
        { name: 'explorer', upAfterMs: 900, comingUpMs: 0 },
        { name: 'registry', upAfterMs: 1200, comingUpMs: 1100 },
      ]);
    });

    it('follows a chain more than one link deep', () => {
      const snapshot = [
        capability('mongo', [], 100),
        capability('localDb', ['mongo'], 400, 300),
        capability('registry', ['localDb'], 1200, 800),
      ];
      expect(criticalChain(snapshot, STARTED).map((link) => link.name)).to.deep.equal(['mongo', 'localDb', 'registry']);
    });

    it('takes what needs a prerequisite as the later of two that rose in the same millisecond', () => {
      const snapshot = [
        capability('messages', [], 500),
        capability('registry', ['messages'], 500, 20),
      ];
      expect(criticalChain(snapshot, STARTED).map((link) => link.name)).to.deep.equal(['messages', 'registry']);
    });

    it('follows what the code bringing a capability up waited for, beyond what it declares', () => {
      const snapshot = [
        capability('mongo', [], 100),
        capability('registry', ['mongo'], 1200, 0),
        capability('decided', [], 1500, 0, { waits: ['registry', 'mongo'] }),
        capability('passed', [], 2000, 0, { waits: ['decided'] }),
      ];
      expect(criticalChain(snapshot, STARTED).map((link) => link.name)).to.deep.equal(['mongo', 'registry', 'decided', 'passed']);
      expect(blame(snapshot, STARTED).find((row) => row.name === 'passed').waitedOn).to.equal('decided');
    });

    it('does not follow a wait for something that came up after the capability did', () => {
      const snapshot = [
        capability('mongo', [], 100),
        capability('late', [], 3000),
        capability('decided', ['mongo'], 1500, 0, { waits: ['late'] }),
      ];
      expect(blame(snapshot, STARTED).find((row) => row.name === 'decided').waitedOn).to.equal('mongo');
    });

    it('takes each capability once, though two rising together waited for each other', () => {
      const snapshot = [
        capability('a', [], 500, 0, { waits: ['b'] }),
        capability('b', [], 500, 0, { waits: ['a'] }),
      ];
      const chain = criticalChain(snapshot, STARTED).map((link) => link.name);
      expect(chain).to.have.lengthOf(2);
      expect(new Set(chain).size).to.equal(2);
    });

    it('is empty while nothing has come up', () => {
      expect(criticalChain([capability('mongo', [], null)], STARTED)).to.deep.equal([]);
    });
  });
});
