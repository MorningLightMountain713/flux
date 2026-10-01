'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const verificationHelper = require('../../ZelBack/src/services/verificationHelper');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const appsRepository = require('../../ZelBack/src/services/appDatabase/appsRepository');
const appHistory = require('../../ZelBack/src/services/appDecisions/appHistory');
const foundingCommittee = require('../../ZelBack/src/services/appMesh/foundingCommittee');
const networkStateService = require('../../ZelBack/src/services/networkStateService');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const messageStore = require('../../ZelBack/src/services/appMessaging/messageStore');
const ownerGenerationRecord = require('../../ZelBack/src/services/quorumGrant/ownerGenerationRecord');

// The owner generation record: one signed object that retires a grant key's
// world. The signature is an app OWNER's, verified against the verifier's
// own applied history — the record can never name its own authority.

// the repo's fixture pair: this WIF's address is the "owner" ZelID
const OWNER_WIF = '5JTeg79dTLzzHXoJPALMWuoGDM8QmLj4n5f6MeFjx8dzsirvjAh';
const OWNER = '1KoXq8mLxpNt3BSnNLq2HzKC39Ne2pVJtF';
// a second owner, the buyer: the second fixture pair
const BUYER_WIF = '5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ';
const BUYER = '1GAehh7TsJAHuUAeKZcXf5CnwuGuGgyX2S';
const OWNED_FROM = 500_000;
const BOUGHT_AT = 600_000;

async function signedRecord(overrides = {}, wif = OWNER_WIF) {
  const record = {
    identity: 'myapp',
    role: 'founder',
    generation: 2,
    height: 500_100,
    at: 1_750_000_000_000,
    ownedFrom: OWNED_FROM,
    ...overrides,
  };
  record.signature = verificationHelper.signMessage(await ownerGenerationRecord.canonical(record), wif);
  return record;
}

describe('quorumGrant ownerGenerationRecord', () => {
  describe('the record object', () => {
    it('signs and verifies against the owner address', async () => {
      const record = await signedRecord();
      expect(await ownerGenerationRecord.verify(record, OWNER)).to.equal(true);
    });

    it('does not verify against a different owner or a tampered field, the ownership height included', async () => {
      const record = await signedRecord();
      expect(await ownerGenerationRecord.verify(record, '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).to.equal(false);
      expect(await ownerGenerationRecord.verify({ ...record, generation: 3 }, OWNER)).to.equal(false);
      expect(await ownerGenerationRecord.verify({ ...record, height: 1 }, OWNER)).to.equal(false);
      expect(await ownerGenerationRecord.verify({ ...record, ownedFrom: OWNED_FROM + 1 }, OWNER)).to.equal(false);
    });

    it('is valid for the app it names only: never for another app registered under the same name', async () => {
      const record = await signedRecord({ identity: 'ab12cd34ef56' });
      expect(await ownerGenerationRecord.verify(record, OWNER)).to.equal(true);
      expect(await ownerGenerationRecord.verify({ ...record, identity: 'cd34ef56ab12' }, OWNER)).to.equal(false);
    });

    it('rejects malformed shapes before any crypto runs', async () => {
      expect(await ownerGenerationRecord.wellFormed(await signedRecord())).to.equal(true);
      expect(await ownerGenerationRecord.wellFormed(await signedRecord({ generation: 0 }))).to.equal(false);
      expect(await ownerGenerationRecord.wellFormed(await signedRecord({ generation: 1.5 }))).to.equal(false);
      expect(await ownerGenerationRecord.wellFormed(await signedRecord({ role: 'foun_der' }))).to.equal(false);
      expect(await ownerGenerationRecord.wellFormed(await signedRecord({ height: -1 }))).to.equal(false);
      expect(await ownerGenerationRecord.wellFormed(await signedRecord({ ownedFrom: 0 }))).to.equal(false);
      const absent = await signedRecord();
      delete absent.ownedFrom;
      expect(await ownerGenerationRecord.wellFormed(absent)).to.equal(false);
      expect(await ownerGenerationRecord.wellFormed(null)).to.equal(false);
    });

    it('refuses fields that would shift the framing', async () => {
      expect(await ownerGenerationRecord.canonical({
        identity: 'my|app', role: 'founder', generation: 1, height: 1, at: 1, ownedFrom: 1,
      })).to.equal(null);
    });

    it('hashes the signed text as sha256 and 64 hex', async () => {
      expect(await ownerGenerationRecord.hash(await signedRecord())).to.match(/^sha256:[a-f0-9]{64}$/);
    });
  });

  describe('the store handler', () => {
    let writes;
    let rows; // every record the collection holds for the app
    let app;
    let owners;

    beforeEach(() => {
      writes = [];
      rows = [];
      app = { name: 'myapp', owner: OWNER, grants: null };
      owners = [{ owner: OWNER, from: OWNED_FROM }];
      sinon.stub(dbHelper, 'databaseConnection').returns({ db: () => ({}) });
      sinon.stub(dbHelper, 'updateOneInDatabase').callsFake(async (database, collection, filter, update, options) => {
        writes.push({ filter, update, options });
        if (!rows.some((r) => r.dedupKey === filter.dedupKey)) rows.push({ ...update.$setOnInsert, ...update.$set });
        return { acknowledged: true };
      });
      sinon.stub(dbHelper, 'findInDatabase').callsFake(async (database, collection, query) => rows
        .filter((r) => r.type === query.type && r.identity === query.identity && r.role === query.role));
      sinon.stub(appsRepository, 'getGlobalAppInfoByIdentity').callsFake(async () => app);
      sinon.stub(appHistory, 'ownerships').callsFake(async () => owners);
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

    it('keeps an owner-verified record as its own row, keyed by its hash, durable, and stands on it', async () => {
      const record = await signedRecord();
      await stored(record);
      expect(writes).to.have.length(1);
      expect(writes[0].filter).to.deep.equal({
        type: 'grantgeneration', dedupKey: `grantgeneration:myapp/founder/${await ownerGenerationRecord.hash(record)}`,
      });
      expect(writes[0].update.$setOnInsert).to.include({ identity: 'myapp', role: 'founder', signer: OWNER });
      // Explicitly null, never merely absent: a row written by a build that
      // stamped an expiry keeps its Date through an upsert that does not
      // clear it, and the collection's TTL index goes on reaping it.
      expect(writes[0].update.$set.expireAt).to.equal(null);
      expect(writes[0].options).to.deep.equal({ upsert: true });
      const { record: standing, aside } = await messageStore.standingGeneration('myapp', 'founder');
      expect(standing.data.generation).to.equal(2);
      expect(aside).to.equal(false);
    });

    it('a founder-role record that stands re-materializes the committee at its height', async () => {
      await stored(await signedRecord());
      expect(foundingCommittee.materializeGeneration.calledOnce).to.equal(true);
      expect(foundingCommittee.materializeGeneration.firstCall.args[0].height).to.equal(500_100);

      foundingCommittee.materializeGeneration.resetHistory();
      await stored(await signedRecord({ role: 'master' }));
      expect(foundingCommittee.materializeGeneration.called).to.equal(false);
    });

    it('drops a record no owner of the app signed', async () => {
      const record = await signedRecord();
      record.generation = 9; // fields moved after signing
      await stored(record);
      expect(writes).to.have.length(0);
    });

    it('drops a record whose ownership height is not one at which its signer took the app', async () => {
      await stored(await signedRecord({ ownedFrom: OWNED_FROM + 1 }));
      expect(writes).to.have.length(0);
    });

    it('resolves the owners from the applied history of the app the record names', async () => {
      await stored(await signedRecord());
      sinon.assert.calledWith(appsRepository.getGlobalAppInfoByIdentity, 'myapp');
      sinon.assert.calledWith(appHistory.ownerships, 'myapp');
    });

    it('drops a record for an app this node has no spec for', async () => {
      app = null;
      await stored(await signedRecord());
      expect(writes).to.have.length(0);
    });

    it('drops malformed records without touching the owner store', async () => {
      await stored(await signedRecord({ generation: 0 }));
      await stored(await signedRecord({ role: 'Bad Role' }));
      expect(writes).to.have.length(0);
      expect(appsRepository.getGlobalAppInfoByIdentity.called).to.equal(false);
    });

    it('a replay of a held record writes nothing new and notifies again, so listeners must be idempotent', async () => {
      const heard = [];
      const off = messageStore.onGrantGenerationRecord((event) => heard.push(event));
      try {
        const record = await signedRecord({ role: 'master' });
        await stored(record);
        await stored(record);
        expect(rows).to.have.length(1);
        expect(heard).to.have.length(2);
      } finally {
        off();
      }
    });

    it('stands on the highest generation the listed owner signed, and keeps a lower one aside rather than dropping it', async () => {
      await stored(await signedRecord({ role: 'master', generation: 5 }));
      await stored(await signedRecord({ role: 'master', generation: 2 }));
      expect(rows).to.have.length(2);
      const { record } = await messageStore.standingGeneration('myapp', 'master');
      expect(record.data.generation).to.equal(5);
    });

    // The sale. Alice (OWNER) sold to Bob (BUYER) at BOUGHT_AT; the spec Bob now
    // owns names, in its grants block, the record Alice signed that stands.
    describe('across a transfer', () => {
      const sold = async (namedRecord) => {
        app = { name: 'myapp', owner: BUYER, grants: namedRecord ? { master: await ownerGenerationRecord.hash(namedRecord) } : null };
        owners = [{ owner: OWNER, from: OWNED_FROM }, { owner: BUYER, from: BOUGHT_AT }];
      };

      it('keeps the seller\'s record it took before the sale; after the sale the one the spec names stands and the unnamed one is set aside', async () => {
        const named = await signedRecord({ role: 'master', generation: 1 });
        const racing = await signedRecord({ role: 'master', generation: 2 });
        await stored(named);
        await stored(racing);
        expect((await messageStore.standingGeneration('myapp', 'master')).record.data.generation).to.equal(2);
        await sold(named);
        const { record, aside } = await messageStore.standingGeneration('myapp', 'master');
        expect(record.data.generation).to.equal(1);
        expect(aside).to.equal(false);
        expect(rows).to.have.length(2);
      });

      it('a sale naming nothing puts every record of the seller aside: the app stands on its registration', async () => {
        await stored(await signedRecord({ role: 'master', generation: 2 }));
        await sold(null);
        expect(await messageStore.standingGeneration('myapp', 'master')).to.deep.include({ record: null, aside: false });
      });

      it('a sale naming a record this node never held leaves the node aside, serving nothing, until it arrives', async () => {
        const named = await signedRecord({ role: 'master', generation: 1 });
        await stored(await signedRecord({ role: 'master', generation: 2 }));
        await sold(named);
        expect(await messageStore.standingGeneration('myapp', 'master')).to.deep.include({ record: null, aside: true });
        await stored(named);
        expect((await messageStore.standingGeneration('myapp', 'master')).record.data.generation).to.equal(1);
      });

      it('takes the named record after the sale though an earlier owner signed it, and refuses one signed by nobody who ever owned the app', async () => {
        const named = await signedRecord({ role: 'master', generation: 1 });
        await sold(named);
        await stored(named);
        expect(rows).to.have.length(1);
        expect(rows[0].signer).to.equal(OWNER);
        const stranger = await signedRecord({ role: 'master', generation: 1, ownedFrom: BOUGHT_AT }, '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3');
        await stored(stranger);
        expect(rows).to.have.length(1);
      });

      it('the buyer\'s first record outranks whatever the seller signed, and must carry the height the buyer took the app', async () => {
        const named = await signedRecord({ role: 'master', generation: 7 });
        await stored(named);
        await sold(named);
        await stored(await signedRecord({ role: 'master', generation: 1, ownedFrom: OWNED_FROM }, BUYER_WIF));
        expect(rows).to.have.length(1);
        await stored(await signedRecord({ role: 'master', generation: 1, ownedFrom: BOUGHT_AT }, BUYER_WIF));
        expect(rows).to.have.length(2);
        const { record } = await messageStore.standingGeneration('myapp', 'master');
        expect(record.signer).to.equal(BUYER);
        expect(record.data.generation).to.equal(1);
      });

      it('an undone sale: the row returns to the seller and the record set aside stands again', async () => {
        const named = await signedRecord({ role: 'master', generation: 1 });
        const racing = await signedRecord({ role: 'master', generation: 2 });
        await stored(named);
        await stored(racing);
        await sold(named);
        expect((await messageStore.standingGeneration('myapp', 'master')).record.data.generation).to.equal(1);
        app = { name: 'myapp', owner: OWNER, grants: null };
        owners = [{ owner: OWNER, from: OWNED_FROM }];
        expect((await messageStore.standingGeneration('myapp', 'master')).record.data.generation).to.equal(2);
      });
    });

    it('at a new owner the node asks a sample of nodes for every record they hold, keeps what it lacked, and tells the listeners each role\'s standing generation', async () => {
      const named = await signedRecord({ role: 'master', generation: 1 });
      await stored(await signedRecord({ role: 'master', generation: 2 }));
      app = { name: 'myapp', owner: BUYER, grants: { master: await ownerGenerationRecord.hash(named) } };
      owners = [{ owner: OWNER, from: OWNED_FROM }, { owner: BUYER, from: BOUGHT_AT }];
      sinon.stub(networkStateService, 'getRandomSocketAddressSample').resolves(['198.51.100.7:16127']);
      sinon.stub(serviceHelper, 'axiosGet').callsFake(async (url) => ({
        data: { data: { records: url.endsWith('/master') ? [{ ...named, broadcastedAt: named.at }] : [] } },
      }));
      const heard = [];
      const off = messageStore.onGrantGenerationRecord((event) => heard.push(event));
      try {
        await messageStore.rejudgeGenerationRecords('myapp');
      } finally {
        off();
      }
      expect(serviceHelper.axiosGet.firstCall.args[0]).to.equal('http://198.51.100.7:16127/apps/grantgeneration/myapp/master');
      expect(rows.map((r) => r.data.generation).sort()).to.deep.equal([1, 2]);
      expect(heard.filter((e) => e.role === 'master').map((e) => e.generation)).to.deep.equal([1, 1]);
      expect(heard.filter((e) => e.role === 'founder').map((e) => e.generation)).to.deep.equal([0]);
    });

    it('a node that cannot be asked costs the others nothing', async () => {
      sinon.stub(networkStateService, 'getRandomSocketAddressSample').resolves(['198.51.100.7:16127', '198.51.100.8:16127']);
      sinon.stub(serviceHelper, 'axiosGet').callsFake(async (url) => {
        if (url.includes('100.7')) throw new Error('timeout');
        return { data: { data: { records: [] } } };
      });
      await messageStore.rejudgeGenerationRecords('myapp');
      expect(serviceHelper.axiosGet.callCount).to.equal(4);
    });

    // The product-side hook: the store owns the standing generation, and the
    // holder must act the moment its world ends — a bus event is harness
    // observability only, so listeners register here instead.
    it('a record that becomes the standing one notifies the registered listeners, and only while registered', async () => {
      const heard = [];
      const off = messageStore.onGrantGenerationRecord((event) => heard.push(event));
      try {
        await stored(await signedRecord({ role: 'master', generation: 2 }));
        expect(heard).to.deep.equal([{ identity: 'myapp', role: 'master', generation: 2 }]);
      } finally {
        off();
      }
      await stored(await signedRecord({ role: 'master', generation: 3 }));
      expect(heard).to.have.length(1);
    });

    it('a record that does not stand is kept and notifies nobody', async () => {
      const heard = [];
      const off = messageStore.onGrantGenerationRecord((event) => heard.push(event));
      try {
        await stored(await signedRecord({ role: 'master', generation: 5 }));
        heard.length = 0;
        await stored(await signedRecord({ role: 'master', generation: 2 }));
        expect(rows).to.have.length(2);
        expect(heard).to.deep.equal([]);
      } finally {
        off();
      }
    });

    it('a listener that throws costs the other listeners nothing', async () => {
      const heard = [];
      const offThrowing = messageStore.onGrantGenerationRecord(() => { throw new Error('boom'); });
      const offHearing = messageStore.onGrantGenerationRecord((event) => heard.push(event));
      try {
        await stored(await signedRecord({ role: 'master', generation: 2 }));
        expect(heard).to.have.length(1);
      } finally {
        offThrowing();
        offHearing();
      }
    });
  });
});
