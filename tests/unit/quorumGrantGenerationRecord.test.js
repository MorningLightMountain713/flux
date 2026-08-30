'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const verificationHelper = require('../../ZelBack/src/services/verificationHelper');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const appsRepository = require('../../ZelBack/src/services/appDatabase/appsRepository');
const foundingCommittee = require('../../ZelBack/src/services/appMesh/foundingCommittee');
const messageStore = require('../../ZelBack/src/services/appMessaging/messageStore');
const ownerGenerationRecord = require('../../ZelBack/src/services/quorumGrant/ownerGenerationRecord');

// The owner generation record: one signed object that retires a grant key's
// world. The signature is the app OWNER's, verified against the verifier's
// own spec store — the record can never name its own authority.

// the repo's fixture pair: this WIF's address is the "owner" ZelID
const OWNER_WIF = '5JTeg79dTLzzHXoJPALMWuoGDM8QmLj4n5f6MeFjx8dzsirvjAh';
const OWNER = '1KoXq8mLxpNt3BSnNLq2HzKC39Ne2pVJtF';

function signedRecord(overrides = {}) {
  const record = {
    appName: 'myapp',
    role: 'founder',
    generation: 2,
    height: 500_100,
    at: 1_750_000_000_000,
    ...overrides,
  };
  record.signature = verificationHelper.signMessage(ownerGenerationRecord.canonical(record), OWNER_WIF);
  return record;
}

describe('quorumGrant ownerGenerationRecord', () => {
  describe('the record object', () => {
    it('signs and verifies against the owner address', () => {
      const record = signedRecord();
      expect(ownerGenerationRecord.verify(record, OWNER)).to.equal(true);
    });

    it('does not verify against a different owner or a tampered field', () => {
      const record = signedRecord();
      expect(ownerGenerationRecord.verify(record, '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).to.equal(false);
      expect(ownerGenerationRecord.verify({ ...record, generation: 3 }, OWNER)).to.equal(false);
      expect(ownerGenerationRecord.verify({ ...record, height: 1 }, OWNER)).to.equal(false);
    });

    it('rejects malformed shapes before any crypto runs', () => {
      expect(ownerGenerationRecord.wellFormed(signedRecord())).to.equal(true);
      expect(ownerGenerationRecord.wellFormed(signedRecord({ generation: 0 }))).to.equal(false);
      expect(ownerGenerationRecord.wellFormed(signedRecord({ generation: 1.5 }))).to.equal(false);
      expect(ownerGenerationRecord.wellFormed(signedRecord({ role: 'foun_der' }))).to.equal(false);
      expect(ownerGenerationRecord.wellFormed(signedRecord({ height: -1 }))).to.equal(false);
      expect(ownerGenerationRecord.wellFormed(null)).to.equal(false);
    });

    it('refuses fields that would shift the framing', () => {
      expect(ownerGenerationRecord.canonical({
        appName: 'my|app', role: 'founder', generation: 1, height: 1, at: 1,
      })).to.equal(null);
    });
  });

  describe('the store handler', () => {
    let updates;

    beforeEach(() => {
      updates = [];
      const collection = {
        updateOne: async (filter, update, options) => {
          updates.push({ filter, update, options });
          return { acknowledged: true };
        },
      };
      sinon.stub(dbHelper, 'databaseConnection').returns({ db: () => ({ collection: () => collection }) });
      sinon.stub(appsRepository, 'getGlobalAppOwner').resolves(OWNER);
      sinon.stub(foundingCommittee, 'materializeGeneration').resolves(true);
    });

    afterEach(() => {
      sinon.restore();
    });

    function stored(record) {
      return messageStore.storeAppStateEvent('grantgeneration', {
        message: { ...record, broadcastedAt: record.at },
        envelope: null,
      });
    }

    it('stores an owner-verified record, generation-newer-wins, durable', async () => {
      await stored(signedRecord());
      expect(updates).to.have.length(1);
      expect(updates[0].filter).to.deep.equal({
        type: 'grantgeneration', dedupKey: 'grantgeneration:myapp/founder',
      });
      const pipeline = JSON.stringify(updates[0].update);
      expect(pipeline).to.contain('$data.generation');
      // Explicitly null, never merely absent: a row written by a build that
      // stamped an expiry keeps its Date through an upsert that does not
      // clear it, and the collection's TTL index goes on reaping it — the
      // record then vanishes from the store and from boot sync with it.
      expect(updates[0].update[0].$set.expireAt).to.equal(null);
    });

    it('a founder-role record re-materializes the committee at its height', async () => {
      await stored(signedRecord());
      expect(foundingCommittee.materializeGeneration.calledOnce).to.equal(true);
      const passed = foundingCommittee.materializeGeneration.firstCall.args[0];
      expect(passed.height).to.equal(500_100);

      foundingCommittee.materializeGeneration.resetHistory();
      await stored(signedRecord({ role: 'master' }));
      expect(foundingCommittee.materializeGeneration.called).to.equal(false);
    });

    it('drops a record whose owner signature does not verify', async () => {
      const record = signedRecord();
      record.generation = 9; // fields moved after signing
      await stored(record);
      expect(updates).to.have.length(0);
    });

    it('drops a record for an app this node has no spec for', async () => {
      appsRepository.getGlobalAppOwner.resolves(null);
      await stored(signedRecord());
      expect(updates).to.have.length(0);
    });

    it('drops malformed records without touching the owner store', async () => {
      await stored(signedRecord({ generation: 0 }));
      await stored(signedRecord({ role: 'Bad Role' }));
      expect(updates).to.have.length(0);
      expect(appsRepository.getGlobalAppOwner.called).to.equal(false);
    });
  });
});
