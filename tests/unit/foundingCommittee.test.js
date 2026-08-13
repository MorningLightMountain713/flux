'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const dbHelper = require('../../ZelBack/src/services/dbHelper');
const appsRepository = require('../../ZelBack/src/services/appDatabase/appsRepository');
const networkStateService = require('../../ZelBack/src/services/networkStateService');
const foundingCommittee = require('../../ZelBack/src/services/appMesh/foundingCommittee');

// The photo, not the album: materialized once at registration processing,
// read back forever, with the §5 exit when the recorded owners rot off the
// list. What matters here is honesty at every branch — the module must
// never mint a photo it did not witness.

const FP = 'a'.repeat(64);
const CURRENT_FP = 'b'.repeat(64);

function fleet(count, tag = 'm', offset = 0) {
  return Array.from({ length: count }, (unused, i) => ({
    txhash: String(i + offset).padStart(2, '0').repeat(32).slice(0, 64),
    outidx: 0,
    pubkey: `owner-${tag}-${i}`,
    ip: `10.${i + offset}.0.1:16127`,
  }));
}

function meshSpec(overrides = {}) {
  return {
    name: 'myapp', height: 500_000, network: { mesh: true }, ...overrides,
  };
}

describe('foundingCommittee', () => {
  let store;

  let generationRows; // dedupKey -> event row for the grantgeneration reads

  beforeEach(() => {
    store = new Map();
    generationRows = new Map();
    sinon.stub(dbHelper, 'databaseConnection').returns({ db: () => ({}) });
    sinon.stub(dbHelper, 'findOneInDatabase').callsFake(async (d, coll, query) => {
      if (query.type === 'grantgeneration') return generationRows.get(query.dedupKey) ?? null;
      return store.get(query._id) ?? null;
    });
    sinon.stub(dbHelper, 'findOneAndUpdateInDatabase').callsFake(async (d, coll, query, update, options) => {
      expect(options.writeConcern).to.deep.equal({ w: 1, j: true });
      if (!store.has(query._id)) store.set(query._id, { _id: query._id, ...update.$setOnInsert });
      return { value: store.get(query._id) };
    });
    sinon.stub(dbHelper, 'updateOneInDatabase').callsFake(async (d, coll, query, update, options) => {
      expect(options.writeConcern).to.deep.equal({ w: 1, j: true });
      const existing = store.get(query._id);
      const guard = query.$or ? ((existing?.generation ?? null) === null || (existing?.generation ?? 0) < update.$set.generation) : true;
      if (existing && guard) store.set(query._id, { ...existing, ...update.$set });
      return { acknowledged: true };
    });
    sinon.stub(networkStateService, 'membershipFingerprintAt').returns(FP);
    sinon.stub(networkStateService, 'membershipAt').callsFake((fp) => (fp === FP || fp === CURRENT_FP ? fleet(12) : null));
    sinon.stub(networkStateService, 'membershipFingerprint').returns(CURRENT_FP);
    sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(meshSpec());
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('materialization', () => {
    it('materializes once for a mesh app, journaled, nine seats', async () => {
      await foundingCommittee.materializeFor(meshSpec());
      const record = store.get('myapp');
      expect(record.fingerprint).to.equal(FP);
      expect(record.members).to.have.length(9);
      expect(record.quorum).to.equal(5);

      networkStateService.membershipFingerprintAt.returns('c'.repeat(64));
      await foundingCommittee.materializeFor(meshSpec());
      expect(store.get('myapp').fingerprint).to.equal(FP); // absent-only
    });

    it('ignores non-mesh specs and malformed specs', async () => {
      await foundingCommittee.materializeFor({ name: 'plain', height: 1, network: {} });
      await foundingCommittee.materializeFor({ name: 'nether', height: Number.NaN, network: { mesh: true } });
      await foundingCommittee.materializeFor(null);
      expect(store.size).to.equal(0);
    });

    it('stores nothing when the registration height is outside its window', async () => {
      networkStateService.membershipFingerprintAt.returns(null);
      await foundingCommittee.materializeFor(meshSpec());
      expect(store.size).to.equal(0);
    });
  });

  describe('the effective committee', () => {
    it('the recorded photo stands while a quorum of its owners remains listed', async () => {
      await foundingCommittee.materializeFor(meshSpec());
      const committee = await foundingCommittee.effectiveCommittee('myapp');
      expect(committee.repinned).to.equal(false);
      expect(committee.fingerprint).to.equal(FP);
      expect(committee.members).to.have.length(9);
      expect(committee.members.every((m) => m.ip !== null)).to.equal(true);
    });

    it('a delisted member keeps its seat but loses its address', async () => {
      await foundingCommittee.materializeFor(meshSpec());
      const departed = store.get('myapp').members[0];
      networkStateService.membershipAt.callsFake(
        (fp) => (fp === CURRENT_FP
          ? fleet(12).filter((n) => `${n.txhash}:${n.outidx}` !== `${departed.txhash}:${departed.outidx}`)
          : fleet(12)),
      );
      const committee = await foundingCommittee.effectiveCommittee('myapp');
      expect(committee.repinned).to.equal(false);
      const seat = committee.members.find((m) => m.txhash === departed.txhash);
      expect(seat.ip).to.equal(null);
      expect(committee.members).to.have.length(9);
    });

    it('re-pins from the current list once the recorded owners rot below quorum', async () => {
      await foundingCommittee.materializeFor(meshSpec());
      const recorded = new Set(store.get('myapp').members.map((m) => `${m.txhash}:${m.outidx}`));
      // current list keeps only 3 of the recorded 9 (quorum is 5)
      const survivors = fleet(12).filter((n) => recorded.has(`${n.txhash}:${n.outidx}`)).slice(0, 3);
      const newcomers = fleet(9, 'new', 50);
      networkStateService.membershipAt.callsFake((fp) => (fp === CURRENT_FP ? [...survivors, ...newcomers] : fleet(12)));

      const committee = await foundingCommittee.effectiveCommittee('myapp');
      expect(committee.repinned).to.equal(true);
      expect(committee.fingerprint).to.equal(CURRENT_FP);
      expect(committee.members).to.have.length(9);
    });

    it('no record means wait — a young node never mints a basis of its own', async () => {
      const committee = await foundingCommittee.effectiveCommittee('ghost');
      expect(committee).to.equal(null);
    });

    it('answers null when it cannot even read the current list', async () => {
      await foundingCommittee.materializeFor(meshSpec());
      networkStateService.membershipFingerprint.returns(null);
      const committee = await foundingCommittee.effectiveCommittee('myapp');
      expect(committee).to.equal(null);
    });
  });

  describe('owner generations', () => {
    function generationRow(generation, height) {
      return {
        data: {
          appName: 'myapp', role: 'founder', generation, height, at: 1,
        },
      };
    }

    it('a newer generation record re-rolls the committee at its named height', async () => {
      await foundingCommittee.materializeFor(meshSpec());
      const before = await foundingCommittee.effectiveCommittee('myapp');
      expect(before.generation).to.equal(0);

      // the named height's list shares the fleet with today's (the owner
      // names a RECENT height, so its nodes are current nodes), differing
      // only in the fingerprint that names it
      const ROLL_FP = 'e'.repeat(64);
      networkStateService.membershipFingerprintAt.withArgs(600_000).returns(ROLL_FP);
      networkStateService.membershipAt.callsFake((fp) => (fp === ROLL_FP || fp === CURRENT_FP || fp === FP ? fleet(12) : null));
      generationRows.set('grantgeneration:myapp/founder', generationRow(2, 600_000));

      const after = await foundingCommittee.effectiveCommittee('myapp');
      expect(after.generation).to.equal(2);
      expect(after.fingerprint).to.equal(ROLL_FP);
      expect(after.repinned).to.equal(false);
      expect(after.members).to.have.length(9);
    });

    it('a node whose window misses the named height answers null, not a stale generation', async () => {
      await foundingCommittee.materializeFor(meshSpec());
      networkStateService.membershipFingerprintAt.withArgs(600_000).returns(null);
      generationRows.set('grantgeneration:myapp/founder', generationRow(2, 600_000));

      const committee = await foundingCommittee.effectiveCommittee('myapp');
      expect(committee).to.equal(null);
    });

    it('a lower generation never overwrites a higher one', async () => {
      await foundingCommittee.materializeFor(meshSpec());
      store.get('myapp').generation = 3;
      const applied = await foundingCommittee.materializeGeneration({
        appName: 'myapp', generation: 2, height: 500_050,
      });
      expect(applied).to.equal(true); // the call succeeds; the guarded write is a no-op
      expect(store.get('myapp').generation).to.equal(3);
    });

    it('the re-roll MINTS the photo on a node that never held one', async () => {
      const applied = await foundingCommittee.materializeGeneration({
        appName: 'myapp', generation: 1, height: 500_050,
      });
      expect(applied).to.equal(true);
      const record = store.get('myapp');
      expect(record.generation).to.equal(1);
      expect(record.quorum).to.equal(5);
      expect(record.members).to.have.length(9);
    });

    it('a record for a non-mesh app mints nothing', async () => {
      appsRepository.getGlobalAppInfo.resolves({ name: 'myapp', network: {} });
      const applied = await foundingCommittee.materializeGeneration({
        appName: 'myapp', generation: 1, height: 500_050,
      });
      expect(applied).to.equal(false);
      expect(store.has('myapp')).to.equal(false);
    });

    it('an owner record rescues a photo-less reader end to end', async () => {
      generationRows.set('grantgeneration:myapp/founder', generationRow(1, 500_050));
      const committee = await foundingCommittee.effectiveCommittee('myapp');
      expect(committee).to.not.equal(null);
      expect(committee.generation).to.equal(1);
      expect(committee.members).to.have.length(9);
    });
  });

  describe('the grantor-side check', () => {
    it('membership is answered from the same record the candidates use', async () => {
      await foundingCommittee.materializeFor(meshSpec());
      const member = store.get('myapp').members[2];
      const yes = await foundingCommittee.selfOnFoundingCommittee('myapp', FP, 0, {
        txhash: member.txhash, txindex: member.outidx,
      });
      expect(yes.member).to.equal(true);
      expect(yes.quorum).to.equal(5);

      const no = await foundingCommittee.selfOnFoundingCommittee('myapp', FP, 0, {
        txhash: 'f'.repeat(64), txindex: 0,
      });
      expect(no.member).to.equal(false);
    });

    it('refuses an ask naming a basis this node does not agree with', async () => {
      await foundingCommittee.materializeFor(meshSpec());
      const member = store.get('myapp').members[0];
      const outcome = await foundingCommittee.selfOnFoundingCommittee('myapp', 'd'.repeat(64), 0, {
        txhash: member.txhash, txindex: member.outidx,
      });
      expect(outcome.member).to.equal(false);
      expect(outcome.reason).to.contain('different committee basis');
    });

    it('refuses a retired generation, teaching the current one', async () => {
      await foundingCommittee.materializeFor(meshSpec());
      const member = store.get('myapp').members[0];
      const outcome = await foundingCommittee.selfOnFoundingCommittee('myapp', FP, 1, {
        txhash: member.txhash, txindex: member.outidx,
      });
      expect(outcome.member).to.equal(false);
      expect(outcome.reason).to.contain('current is 0');
    });
  });
});
