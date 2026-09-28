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
      '../dbHelper': {
        databaseConnection: () => ({ db: () => ({}) }),
        findInDatabase: async (_db, _collection, query) => stored.filter((m) => query.hash.$in.includes(m.hash)),
      },
      './decisionStore': { appliedFor: sinon.stub().callsFake(async (name) => applied.filter((d) => d.name === name)) },
      '../appMessaging/confirmedMessageStore': { lookupBlockTime },
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
