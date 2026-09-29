'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
const config = require('config');

const dbHelper = require('../../ZelBack/src/services/dbHelper');
const capabilities = require('../../ZelBack/src/services/utils/capabilities');
const chainState = require('../../ZelBack/src/services/chainState');
const confirmedMessageStore = require('../../ZelBack/src/services/appMessaging/confirmedMessageStore');
const decisionStore = require('../../ZelBack/src/services/appDecisions/decisionStore');
const { RULE_VERSION } = require('../../ZelBack/src/services/appDecisions/decisionRule');

const OWNER = '1OwnerAddress';
const BUYER = '1BuyerAddress';

function messages() {
  return dbHelper.databaseConnection().db(config.get('database.appsglobal.database'))
    .collection(config.get('database.appsglobal.collections.appsMessages'));
}
function records() {
  return dbHelper.databaseConnection().db(config.get('database.daemon.database'))
    .collection(config.get('database.daemon.collections.appsHashes'));
}
function decisions() {
  return dbHelper.databaseConnection().db(config.get('database.appsglobal.database'))
    .collection(config.get('database.appsglobal.collections.appDecisions'));
}

// A stored message, as the fake parser below reads it: its spec names an owner,
// and its signature says who signed it.
async function store({
  hash, name = 'MyApp', type = 'fluxappregister', height, txIndex = 0, owner = OWNER, signer = OWNER, paid = true, timestamp,
}) {
  await messages().insertOne({
    hash, type, version: 1, timestamp: timestamp ?? height * 1000 + txIndex, signature: signer, appSpecifications: { name, owner, version: 8 },
  });
  if (paid) {
    await records().insertOne({
      hash, txid: `tx-${hash}`, height, txIndex, value: 100, message: true,
    });
  }
}

// Parsed events the rule can read: the spec's term is 1000 blocks.
function fakeEvent(doc) {
  return {
    spec: {
      version: 8,
      name: doc.appSpecifications.name,
      owner: doc.appSpecifications.owner,
      isExpired: (state, clock) => clock.currentHeight >= state.height + 1000,
    },
    signature: doc.signature,
    signaturePayloads: () => ['payload'],
  };
}

function fakeJudge(overrides = {}) {
  return {
    activationHeight: () => 0,
    registrationFee: async () => 10n,
    updateFee: async () => 10n,
    entitlementRefusal: async () => null,
    authorized: async (entry, { previousState }) => entry.signers.includes(previousState.owner),
    assertCompatible: () => {},
    mintUuid: (name, txid) => `uuid-${txid}`,
    identityFor: (spec) => spec.name,
    blockTime: async () => 0,
    isValidationError: () => false,
    ...overrides,
  };
}

function loadDecider(judge = fakeJudge()) {
  return proxyquire('../../ZelBack/src/services/appDecisions/decider', {
    './decisionJudge': { createJudge: async () => judge },
    '../utils/verifyPool': {
      // The signature field holds the signer's address.
      recover: async (items) => items.map((item) => [item.signature]),
    },
    '../appMessaging/appEventVerifier': { deserializeMessage: async (doc) => fakeEvent(doc) },
  });
}

async function decisionOf(hash) {
  return decisions().findOne({ hash }, { projection: { _id: 0 } });
}

async function verdict(hash) {
  const d = await decisionOf(hash);
  if (!d) return null;
  return d.decision === 'applied' ? 'applied' : d.reason;
}

describe('decider', function () {
  this.timeout(20_000);

  before(async () => {
    await dbHelper.initiateDB();
    await decisionStore.prepareCollection();
  });

  beforeEach(async () => {
    await Promise.all([messages().deleteMany({}), records().deleteMany({}), decisions().deleteMany({})]);
    capabilities.resetForTests();
    capabilities.setForTests('chainStateConsistent', true);
  });

  afterEach(() => sinon.restore());

  after(async () => {
    await Promise.all([messages().deleteMany({}), records().deleteMany({}), decisions().deleteMany({})]);
    capabilities.resetForTests();
  });

  it('decides every name holding a paid message with no decision, and nothing unpaid', async () => {
    await store({ hash: 'a1', name: 'Alpha', height: 100 });
    await store({ hash: 'b1', name: 'Beta', height: 110 });
    await store({ hash: 'c1', name: 'Gamma', height: 120, paid: false });
    const decider = loadDecider();

    decider.wakeAll();
    await decider.idle();

    expect(await verdict('a1')).to.equal('applied');
    expect(await verdict('b1')).to.equal('applied');
    expect(await decisionOf('c1')).to.equal(null);
    expect(await decisionOf('a1')).to.include({ name: 'alpha', ruleVersion: RULE_VERSION });
  });

  it('decides the names a wake names, and no other', async () => {
    await store({ hash: 'a1', name: 'Alpha', height: 100 });
    await store({ hash: 'b1', name: 'Beta', height: 110 });
    const decider = loadDecider();

    decider.wake(['a1']);
    await decider.idle();

    expect(await verdict('a1')).to.equal('applied');
    expect(await decisionOf('b1')).to.equal(null);
  });

  it('groups a name across letter cases', async () => {
    await store({ hash: 'r', name: 'MyApp', height: 100 });
    await store({
      hash: 'u', name: 'myapp', type: 'fluxappupdate', height: 200,
    });
    const decider = loadDecider();

    decider.wake(['u']);
    await decider.idle();

    expect(await verdict('r')).to.equal('applied');
    expect(await verdict('u')).to.equal('applied');
  });

  it('decides a name again from a late message earlier in chain order', async () => {
    // The transfer to BUYER arrives after the update BUYER signed: first the
    // update is unauthorized, then the transfer turns it applied.
    await store({ hash: 'r', height: 100 });
    await store({
      hash: 'byBuyer', type: 'fluxappupdate', height: 300, owner: BUYER, signer: BUYER,
    });
    const decider = loadDecider();
    decider.wakeAll();
    await decider.idle();
    expect(await verdict('byBuyer')).to.equal('unauthorized');

    await store({
      hash: 'transfer', type: 'fluxappupdate', height: 200, owner: BUYER, signer: OWNER,
    });
    decider.wake(['transfer']);
    await decider.idle();

    expect(await verdict('transfer')).to.equal('applied');
    expect(await verdict('byBuyer')).to.equal('applied');
  });

  it('decides again what an earlier rule version decided', async () => {
    await store({ hash: 'r', height: 100 });
    await decisions().insertOne({
      hash: 'r', name: 'myapp', decision: 'refused', reason: 'underpaid', ruleVersion: RULE_VERSION - 1, height: 100,
    });
    const decider = loadDecider();

    decider.wakeAll();
    await decider.idle();

    expect(await decisionOf('r')).to.include({ decision: 'applied', ruleVersion: RULE_VERSION });
  });

  it('leaves a message it cannot evaluate, and every later one for the name, undecided', async () => {
    await store({ hash: 'r', height: 100 });
    await store({ hash: 'u1', type: 'fluxappupdate', height: 200 });
    await store({ hash: 'u2', type: 'fluxappupdate', height: 300 });
    const decider = loadDecider();
    decider.wakeAll();
    await decider.idle();
    expect(await verdict('u2')).to.equal('applied');

    // A late message before them: the price history is now unavailable at 200.
    await store({ hash: 'u0', type: 'fluxappupdate', height: 150 });
    const blocked = loadDecider(fakeJudge({
      updateFee: async (spec, prevSpec, ctx) => {
        if (ctx.height === 200) throw new Error('price history not in force');
        return 10n;
      },
    }));
    blocked.wake(['u0']);
    await blocked.idle();

    expect(await verdict('u0')).to.equal('applied');
    expect(await decisionOf('u1')).to.equal(null);
    expect(await decisionOf('u2')).to.equal(null);
  });

  it('writes the triggering message\'s decision last, after the later ones and the listeners', async () => {
    await store({ hash: 'r', height: 100 });
    await store({ hash: 'u', type: 'fluxappupdate', height: 200 });
    const decider = loadDecider();
    const seen = [];
    decider.onDecided(async (name) => {
      seen.push({ name, trigger: await decisionOf('r'), later: await decisionOf('u') });
    });

    decider.wakeAll();
    await decider.idle();

    expect(seen).to.have.length(1);
    expect(seen[0].name).to.equal('myapp');
    expect(seen[0].trigger).to.equal(null);
    expect(seen[0].later).to.include({ decision: 'applied' });
    expect(await verdict('r')).to.equal('applied');
  });

  it('leaves the name undecided when a listener fails, and decides it on the next pass', async () => {
    await store({ hash: 'r', height: 100 });
    await store({ hash: 'u', type: 'fluxappupdate', height: 200 });
    const decider = loadDecider();
    let fail = true;
    decider.onDecided(async () => {
      if (fail) throw new Error('registry write failed');
    });

    decider.wakeAll();
    await decider.idle();
    expect(await decisionOf('r')).to.equal(null);

    fail = false;
    decider.wakeAll();
    await decider.idle();
    expect(await verdict('r')).to.equal('applied');
    expect(await verdict('u')).to.equal('applied');
  });

  it('lets a name wait while one of its payment records has no position', async () => {
    await store({ hash: 'r', height: 100 });
    await records().updateOne({ hash: 'r' }, { $unset: { txIndex: '' } });
    const decider = loadDecider();

    decider.wakeAll();
    await decider.idle();

    expect(await decisionOf('r')).to.equal(null);
  });

  it('decides only holding the chain-state lock', async () => {
    await store({ hash: 'r', height: 100 });
    const decider = loadDecider();
    let release;
    const held = chainState.exclusive(() => new Promise((resolve) => { release = resolve; }));

    decider.wakeAll();
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    expect(await decisionOf('r')).to.equal(null);

    release();
    await held;
    await decider.idle();
    expect(await verdict('r')).to.equal('applied');
  });

  it('waits for chain state to be consistent', async () => {
    await store({ hash: 'r', height: 100 });
    capabilities.setForTests('chainStateConsistent', false);
    const decider = loadDecider();

    decider.wakeAll();
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    expect(await decisionOf('r')).to.equal(null);

    capabilities.setForTests('chainStateConsistent', true);
    await decider.idle();
    expect(await verdict('r')).to.equal('applied');
  });

  it('runs a full pass each time the scan catches up, once started', async () => {
    const decider = loadDecider();
    decider.start();
    await decider.idle();

    await store({ hash: 'r', height: 100 });
    capabilities.setForTests('explorerSynced', true);
    await decider.idle();
    expect(await verdict('r')).to.equal('applied');

    await store({ hash: 's', name: 'Other', height: 110 });
    capabilities.setForTests('explorerSynced', false);
    capabilities.setForTests('explorerSynced', true);
    await decider.idle();
    expect(await verdict('s')).to.equal('applied');
  });

  it('is woken by what the store routes resolve, once started', async () => {
    await store({ hash: 'r', height: 100 });
    const decider = loadDecider();
    decider.start();
    await decider.idle();
    await decisions().deleteMany({});

    confirmedMessageStore.notifyStored(['r']);
    await decider.idle();

    expect(await verdict('r')).to.equal('applied');
  });

  it('answers every applied message of an app by its identity, whatever name it was applied under', async () => {
    await decisionStore.write([
      { hash: 'r', name: 'myapp', decision: 'applied', identity: 'ab12cd34ef56', height: 1 },
      { hash: 'u', name: 'myapp', decision: 'applied', identity: 'ab12cd34ef56', height: 2 },
      { hash: 'x', name: 'myapp', decision: 'refused', identity: null, height: 3 },
      { hash: 'r2', name: 'myapp', decision: 'applied', identity: 'cd34ef56ab12', height: 4 },
    ]);

    const { name, hashes } = await decisionStore.appliedHashesOf('ab12cd34ef56');

    expect(name).to.equal('myapp');
    expect(hashes.sort()).to.deep.equal(['r', 'u']);
    expect(await decisionStore.appliedHashesOf('ffffffffffff')).to.deep.equal({ name: null, hashes: [] });
  });
});
