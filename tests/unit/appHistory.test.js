'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

describe('appHistory', () => {
  let history;
  let stored;
  let applied;
  let lookupBlockTime;

  function decision(hash, fields) {
    return {
      hash, name: 'myapp', decision: 'applied', txIndex: 0, blockTime: null, ...fields,
    };
  }

  beforeEach(() => {
    stored = [];
    applied = [];
    lookupBlockTime = sinon.stub().callsFake(async (height) => height * 10);
    history = proxyquire('../../ZelBack/src/services/appDecisions/appHistory', {
      // The app messages: the confirmed messages the test holds, by hash.
      '../appDatabase/appRecords': {
        messages: () => ({
          confirmedByHashes: async (hashes) => stored.filter((m) => hashes.includes(m.hash)).map((m) => ({ hash: m.hash, permanentForm: () => m })),
        }),
        decisions: () => ({ appliedFor: async (name) => applied.filter((d) => d.name === name) }),
      },
      '../daemonService/daemonServiceBlockchainRpcs': { lookupBlockTime },
    });
  });

  afterEach(() => sinon.restore());

  it('answers a name\'s applied messages in chain order, in any letter case', async () => {
    applied = [
      decision('u', { type: 'update', height: 200, txIndex: 1 }),
      decision('r', { type: 'registration', height: 100 }),
      decision('u0', { type: 'update', height: 200, txIndex: 0 }),
    ];
    stored = [{ hash: 'r' }, { hash: 'u' }, { hash: 'u0' }];

    const answer = await history.appliedMessages('MyApp');

    expect(answer.map(({ message }) => message.hash)).to.deep.equal(['r', 'u0', 'u']);
    expect(answer[0].decision.type).to.equal('registration');
  });

  describe('the message an update replaces', () => {
    it('is the latest applied one, read as the decision rule reads it', async () => {
      applied = [
        decision('r', { type: 'registration', height: 100, termStart: 1000 }),
        decision('u', { type: 'update', height: 150, termStart: 1490 }),
      ];
      stored = [
        { hash: 'r', timestamp: 950_000, appSpecifications: { version: 9 } },
        { hash: 'u', timestamp: 1_490_000, appSpecifications: { version: 9 } },
      ];

      expect(await history.replacedBy('MyApp')).to.deep.equal({
        hash: 'u',
        prevAt: { time: 1490, height: 150 },
        prevRegisteredAt: 1490,
        // Its block (150 x 10 here) is later than its signing.
        signAfter: 1_500_000,
      });
      sinon.assert.calledOnceWithExactly(lookupBlockTime, 150);
    });

    it('reads a v1-v8 message by its block, which also starts a term recorded without a start', async () => {
      applied = [decision('r', {
        type: 'registration', height: 100, termStart: null, blockTime: 990,
      })];
      stored = [{ hash: 'r', timestamp: 9_999_999_000, appSpecifications: { version: 8 } }];

      const replaced = await history.replacedBy('myapp');

      expect(replaced.prevRegisteredAt).to.equal(990);
      expect(replaced.signAfter).to.equal(990_000);
      sinon.assert.notCalled(lookupBlockTime);
    });

    it('is null when nothing applied', async () => {
      expect(await history.replacedBy('myapp')).to.equal(null);
    });

    it('cannot be read when the daemon cannot say when its block was mined', async () => {
      applied = [decision('r', { type: 'registration', height: 100, termStart: 1000 })];
      stored = [{ hash: 'r', timestamp: 950_000, appSpecifications: { version: 9 } }];
      lookupBlockTime.resolves(null);

      const error = await history.replacedBy('myapp').catch((e) => e);

      expect(error).to.be.an('error');
      expect(error.message).to.match(/no block time for height 100/);
    });
  });

  it('leaves out a decision whose message is not held', async () => {
    applied = [decision('r', { type: 'registration', height: 100 })];
    expect(await history.appliedMessages('myapp')).to.deep.equal([]);
  });

  it('answers the latest applied message, of a type, below a height', async () => {
    applied = [
      decision('r1', { type: 'registration', height: 100 }),
      decision('u1', { type: 'update', height: 150 }),
      decision('r2', { type: 'registration', height: 300 }),
    ];
    stored = applied.map(({ hash }) => ({ hash }));

    expect((await history.latestApplied('myapp')).decision.hash).to.equal('r2');
    expect((await history.latestApplied('myapp', { type: 'update' })).decision.hash).to.equal('u1');
    expect((await history.latestApplied('myapp', { before: 300 })).decision.hash).to.equal('u1');
    expect((await history.latestApplied('myapp', { type: 'registration', before: 300 })).decision.hash).to.equal('r1');
    expect(await history.latestApplied('myapp', { before: 100 })).to.equal(null);
  });

  it('answers the applied messages of the app holding the name, leaving out an earlier app of the name', async () => {
    applied = [
      decision('r1', { type: 'registration', height: 100, uuid: 'first' }),
      decision('u1', { type: 'update', height: 150, uuid: 'first' }),
      decision('r2', { type: 'registration', height: 300, uuid: 'second' }),
      decision('u2', { type: 'update', height: 350, uuid: 'second' }),
    ];
    stored = applied.map(({ hash }) => ({ hash }));

    expect((await history.currentAppMessages('MyApp')).map(({ decision: d }) => d.hash)).to.deep.equal(['r2', 'u2']);
    expect(await history.appliedUpdateEvents('myapp')).to.deep.equal([{ type: 'fluxappupdate', timestamp: 3_500_000 }]);
  });

  it('answers no messages for a name nothing was applied to', async () => {
    expect(await history.currentAppMessages('myapp')).to.deep.equal([]);
  });

  it('answers each owner with the height they took the app and the grants block the message that began their ownership named', async () => {
    applied = [
      decision('r', { type: 'registration', height: 100 }),
      decision('u1', { type: 'update', height: 150 }),
      decision('t', { type: 'update', height: 200 }),
      decision('u2', { type: 'update', height: 250 }),
    ];
    stored = [
      { hash: 'r', appSpecifications: { owner: 'alice' } },
      { hash: 'u1', appSpecifications: { owner: 'alice', grants: { master: 'sha256:a1' } } },
      { hash: 't', appSpecifications: { owner: 'bob', grants: { master: 'sha256:a1' } } },
      { hash: 'u2', appSpecifications: { owner: 'bob', grants: { master: 'sha256:b1' } } },
    ];
    expect(await history.ownerships('myapp')).to.deep.equal([
      { owner: 'alice', from: 100, grants: null },
      { owner: 'bob', from: 200, grants: { master: 'sha256:a1' } },
    ]);
  });

  it('answers the identity of the app holding the name and its owners with the height each took it, leaving out an earlier app of the name', async () => {
    applied = [
      decision('r1', { type: 'registration', height: 100, uuid: 'first', identity: 'bfirst' }),
      decision('r2', { type: 'registration', height: 300, uuid: 'second', identity: 'bsecond' }),
      decision('t', { type: 'update', height: 400, uuid: 'second', identity: 'bsecond' }),
    ];
    stored = [
      { hash: 'r1', appSpecifications: { owner: 'carol' } },
      { hash: 'r2', appSpecifications: { owner: 'alice' } },
      { hash: 't', appSpecifications: { owner: 'bob', grants: { master: 'sha256:a1' } } },
    ];
    expect(await history.ownershipRecord('MyApp')).to.deep.equal({
      identity: 'bsecond',
      ownerships: [{ owner: 'alice', from: 300 }, { owner: 'bob', from: 400 }],
    });
  });

  it('answers no ownership record for a name nothing was applied to', async () => {
    expect(await history.ownershipRecord('myapp')).to.equal(null);
  });

  it('answers the version of the message that registered an app: the first applied message of the app with a uuid, or of the app holding the name', async () => {
    applied = [
      decision('r1', { type: 'registration', height: 100, uuid: 'first' }),
      decision('u1', { type: 'update', height: 150, uuid: 'first' }),
      decision('r2', { type: 'registration', height: 300, uuid: 'second' }),
      decision('u2', { type: 'update', height: 350, uuid: 'second' }),
    ];
    stored = [
      { hash: 'r1', appSpecifications: { version: 4 } }, { hash: 'u1', appSpecifications: { version: 8 } },
      { hash: 'r2', appSpecifications: { version: 8 } }, { hash: 'u2', appSpecifications: { version: 9 } },
    ];

    expect(await history.registrationVersionOf('MyApp'), 'the app holding the name, by its registration').to.equal(8);
    expect(await history.registrationVersionOf('myapp', 'first'), 'an earlier app of the name, by its uuid').to.equal(4);
    expect(await history.registrationVersionOf('myapp', 'nobody')).to.equal(null);
  });

  it('answers no registration version for a name nothing was applied to, or a registration whose message states none', async () => {
    expect(await history.registrationVersionOf('myapp')).to.equal(null);
    applied = [decision('r1', { type: 'registration', height: 100, uuid: 'first' })];
    stored = [{ hash: 'r1', appSpecifications: {} }];
    expect(await history.registrationVersionOf('myapp')).to.equal(null);
  });

  it('stamps the applied updates with their blocks\' times, asking the daemon only for a record without one', async () => {
    applied = [
      decision('r', { type: 'registration', height: 100 }),
      decision('u1', { type: 'update', height: 200, blockTime: 5000 }),
      decision('u2', { type: 'update', height: 300 }),
    ];
    stored = applied.map(({ hash }) => ({ hash }));

    expect(await history.appliedUpdateEvents('myapp')).to.deep.equal([
      { type: 'fluxappupdate', timestamp: 5_000_000 },
      { type: 'fluxappupdate', timestamp: 3_000_000 },
    ]);
    sinon.assert.calledOnceWithExactly(lookupBlockTime, 300);
  });
});
