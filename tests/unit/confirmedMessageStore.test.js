'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

const domain = require('./fixtures/appDomain');
const fluxSpec = require('./fixtures/fluxSpec');
const { asConfig } = require('./fixtures/config');

describe('confirmedMessageStore', () => {
  let records;
  let storedHashes;
  let inserted;
  let insertError;
  let resolvedOps;
  let attestationValid;
  let store;

  beforeEach(() => {
    records = new Map();
    storedHashes = new Set();
    inserted = [];
    insertError = null;
    resolvedOps = [];
    attestationValid = true;
    store = proxyquire('../../ZelBack/src/services/appMessaging/confirmedMessageStore', {
      config: asConfig({
        database: {
          daemon: { database: 'daemondb', collections: { appsHashes: 'appsHashes' } },
          appsglobal: { database: 'globalapps', collections: { appsMessages: 'appsMessages' } },
        },
      }),
      '../../lib/log': { warn: sinon.stub(), info: sinon.stub(), error: sinon.stub() },
      '../dbHelper': {
        databaseConnection: () => ({ db: (name) => name }),
        findInDatabase: async (_db, collection, query) => (collection === 'appsHashes'
          ? query.hash.$in.filter((hash) => records.has(hash)).map((hash) => records.get(hash))
          : query.hash.$in.filter((hash) => storedHashes.has(hash)).map((hash) => ({ hash }))),
        insertManyToDatabase: async (_db, _collection, docs) => {
          if (insertError) throw insertError;
          inserted.push(...docs);
        },
        bulkWriteInDatabase: async (_db, _collection, ops) => { resolvedOps.push(...ops); },
      },
      '../daemonService/daemonServiceBlockchainRpcs': {
        getBlock: sinon.stub().resolves({ status: 'success', data: { time: 1_750_000_000 } }),
      },
      './appEventVerifier': { verifyAttestation: async () => attestationValid },
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  function pay(message, facts = {}) {
    records.set(message.hash, {
      hash: message.hash, txid: 'own-txid', height: 2_000_100, txIndex: 4, value: 300_000_000, blockTime: 1_760_000_000, ...facts,
    });
  }

  it('stores a message with this node\'s chain facts, never the ones it arrived with', async () => {
    const message = { ...await domain.paidTempMessage({ version: 1 }), txid: 'peer-txid', height: 5, valueSat: 1 };
    pay(message);

    const result = await store.storeConfirmedMessages([message]);

    expect(result.stored.map(({ event }) => event.hash)).to.deep.equal([message.hash]);
    expect(inserted).to.have.length(1);
    expect(inserted[0]).to.include({ txid: 'own-txid', height: 2_000_100, valueSat: 300_000_000 });
  });

  it('takes a v9 term start from the payment record\'s block time', async () => {
    const message = await domain.paidTempMessage({ version: 2 });
    pay(message, { blockTime: 1_761_000_000 });

    await store.storeConfirmedMessages([message]);

    expect(inserted[0].registeredAt).to.equal(1_761_000_000);
  });

  it('does not store a message whose payment this node has not recorded', async () => {
    const message = await domain.paidTempMessage({ version: 1 });

    const result = await store.storeConfirmedMessages([message]);

    expect(result.unpaid).to.deep.equal([message.hash]);
    expect(inserted).to.deep.equal([]);
    expect(resolvedOps).to.deep.equal([]);
  });

  it('does not store contents that do not hash to the paid hash', async () => {
    const message = await domain.paidTempMessage({ version: 1 });
    const tampered = { ...message, timestamp: message.timestamp + 1 };
    pay(tampered);

    const result = await store.storeConfirmedMessages([tampered]);

    expect(result.refused).to.deep.equal([{ hash: message.hash, reason: 'contents do not hash to the paid hash' }]);
    expect(inserted).to.deep.equal([]);
  });

  async function sealedMessage() {
    const flux = await fluxSpec.loadSpecLibrary();
    const cleartext = await fluxSpec.v9Spec({}, { encrypted: true });
    const sealed = await flux.EncryptedSpecV9.fromSpec(
      cleartext, await flux.EncryptedSpecV9.createProviderFor(cleartext.name, cleartext.owner),
    );
    return domain.paidTempMessage({ version: 2, spec: sealed, contentHash: cleartext.contentHash() });
  }

  it('does not store an encrypted message whose attestation does not verify', async () => {
    const message = await sealedMessage();
    pay(message);
    attestationValid = false;

    const result = await store.storeConfirmedMessages([message]);

    expect(result.refused).to.deep.equal([{ hash: message.hash, reason: 'Arcane attestation does not verify' }]);
    expect(inserted).to.deep.equal([]);
  });

  it('stores an encrypted message whose attestation verifies', async () => {
    const message = await sealedMessage();
    pay(message);

    const result = await store.storeConfirmedMessages([message]);

    expect(result.stored.map(({ event }) => event.hash)).to.deep.equal([message.hash]);
  });

  it('reports a message already stored, and marks its payment resolved', async () => {
    const message = await domain.paidTempMessage({ version: 1 });
    pay(message);
    storedHashes.add(message.hash);

    const result = await store.storeConfirmedMessages([message]);

    expect(result.alreadyStored).to.deep.equal([message.hash]);
    expect(inserted).to.deep.equal([]);
    expect(resolvedOps.map((op) => op.updateOne.filter.hash)).to.deep.equal([message.hash]);
  });

  it('marks every stored message\'s payment resolved', async () => {
    const message = await domain.paidTempMessage({ version: 1 });
    pay(message);

    await store.storeConfirmedMessages([message]);

    expect(resolvedOps).to.deep.equal([
      { updateOne: { filter: { hash: message.hash }, update: { $set: { message: true, messageNotFound: false } } } },
    ]);
  });

  it('counts a message another route stored meanwhile as already stored', async () => {
    const message = await domain.paidTempMessage({ version: 1 });
    pay(message);
    insertError = Object.assign(new Error('E11000 duplicate key'), { writeErrors: [{ index: 0, code: 11_000 }] });

    const result = await store.storeConfirmedMessages([message]);

    expect(result.stored).to.deep.equal([]);
    expect(result.alreadyStored).to.deep.equal([message.hash]);
  });

  it('raises any other failure to write', async () => {
    const message = await domain.paidTempMessage({ version: 1 });
    pay(message);
    insertError = new Error('write concern timeout');

    let raised = null;
    await store.storeConfirmedMessages([message]).catch((error) => { raised = error; });

    expect(raised?.message).to.equal('write concern timeout');
    expect(resolvedOps).to.deep.equal([]);
  });
});
