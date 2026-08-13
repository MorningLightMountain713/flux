'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const dbHelper = require('../../ZelBack/src/services/dbHelper');
const appsRepository = require('../../ZelBack/src/services/appDatabase/appsRepository');
const networkStateService = require('../../ZelBack/src/services/networkStateService');
const foundingCommittee = require('../../ZelBack/src/services/appMesh/foundingCommittee');

// The photo, not the album: each component's founder register pins to the
// anchor that introduced it, photographed by every node whose window covers
// that height, read back forever. What matters here is honesty at every
// branch — the module must never mint a photo it did not witness — and
// world separation: a removed-and-re-added component must never inherit the
// dead world's committee, cells, or record.

const FP = 'a'.repeat(64);
const CURRENT_FP = 'b'.repeat(64);
const REG_HEIGHT = 500_000;

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
    name: 'myapp',
    height: REG_HEIGHT,
    network: { mesh: true },
    components: { db: {} },
    ...overrides,
  };
}

describe('foundingCommittee', () => {
  let store;

  let generationRows; // dedupKey -> event row for the grantgeneration reads

  function applySet(target, set) {
    const next = { ...target };
    Object.entries(set).forEach(([key, value]) => {
      if (key.startsWith('photos.')) {
        next.photos = { ...(next.photos ?? {}), [key.slice(7)]: value };
      } else {
        next[key] = value;
      }
    });
    return next;
  }

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
      const existing = store.get(query._id);
      if (!existing) {
        store.set(query._id, applySet({ _id: query._id, ...(update.$setOnInsert ?? {}) }, update.$set ?? {}));
      } else {
        store.set(query._id, applySet(existing, update.$set ?? {}));
      }
      return { value: store.get(query._id) };
    });
    sinon.stub(networkStateService, 'membershipFingerprintAt').returns(FP);
    sinon.stub(networkStateService, 'membershipAt').callsFake((fp) => (fp === FP || fp === CURRENT_FP ? fleet(12) : null));
    sinon.stub(networkStateService, 'membershipFingerprint').returns(CURRENT_FP);
    sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(meshSpec());
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('materialization at spec anchors', () => {
    it('a registration maps its components and photographs their anchor, journaled, nine seats', async () => {
      await foundingCommittee.materializeFor(meshSpec());
      const record = store.get('myapp');
      expect(record.generation).to.equal(0);
      expect(record.components).to.deep.equal({ db: { anchorHeight: REG_HEIGHT } });
      const photo = record.photos[String(REG_HEIGHT)];
      expect(photo.fingerprint).to.equal(FP);
      expect(photo.quorum).to.equal(5);
      expect(photo.members).to.have.length(9);
    });

    it('ignores non-mesh and malformed specs', async () => {
      await foundingCommittee.materializeFor({ name: 'plain', height: 1, components: { a: {} } });
      await foundingCommittee.materializeFor(meshSpec({ height: undefined }));
      await foundingCommittee.materializeFor(meshSpec({ components: {} }));
      expect(store.size).to.equal(0);
    });

    it('outside its window it keeps the mapping and stores no photo — spec arithmetic needs no membership', async () => {
      networkStateService.membershipFingerprintAt.returns(null);
      await foundingCommittee.materializeFor(meshSpec());
      const record = store.get('myapp');
      expect(record.components.db.anchorHeight).to.equal(REG_HEIGHT);
      expect(record.photos).to.deep.equal({});
      expect(await foundingCommittee.effectiveCommittee('myapp', 'db')).to.equal(null);
    });

    it('an update adding a component pins it at the update, keeping older anchors', async () => {
      await foundingCommittee.materializeFor(meshSpec());
      await foundingCommittee.materializeFor(meshSpec({
        height: 600_000, components: { db: {}, cache: {} },
      }));
      const record = store.get('myapp');
      expect(record.components.db.anchorHeight).to.equal(REG_HEIGHT);
      expect(record.components.cache.anchorHeight).to.equal(600_000);
      expect(record.photos[String(600_000)].members).to.have.length(9);
    });

    it('an update removing a component drops its mapping and its unshared photo', async () => {
      await foundingCommittee.materializeFor(meshSpec());
      await foundingCommittee.materializeFor(meshSpec({
        height: 600_000, components: { db: {}, cache: {} },
      }));
      await foundingCommittee.materializeFor(meshSpec({ height: 700_000 }));
      const record = store.get('myapp');
      expect(record.components.cache).to.equal(undefined);
      expect(record.photos[String(600_000)]).to.equal(undefined);
      expect(record.photos[String(REG_HEIGHT)]).to.not.equal(undefined);
      expect(await foundingCommittee.effectiveCommittee('myapp', 'cache')).to.equal(null);
    });

    it('a re-added component is a NEW world at a new anchor', async () => {
      await foundingCommittee.materializeFor(meshSpec({ components: { db: {}, cache: {} } }));
      await foundingCommittee.materializeFor(meshSpec({ height: 600_000 }));
      await foundingCommittee.materializeFor(meshSpec({
        height: 700_000, components: { db: {}, cache: {} },
      }));
      const record = store.get('myapp');
      expect(record.components.cache.anchorHeight).to.equal(700_000);
      expect(record.components.db.anchorHeight).to.equal(REG_HEIGHT);
    });

    it('spec anchors apply in chain order — a stale write changes nothing', async () => {
      await foundingCommittee.materializeFor(meshSpec({ height: 600_000 }));
      await foundingCommittee.materializeFor(meshSpec({
        height: REG_HEIGHT, components: { db: {}, ghost: {} },
      }));
      const record = store.get('myapp');
      expect(record.specHeight).to.equal(600_000);
      expect(record.components.ghost).to.equal(undefined);
    });
  });

  describe('the effective committee', () => {
    it('the photo stands while a quorum of its owners remains listed', async () => {
      await foundingCommittee.materializeFor(meshSpec());
      const committee = await foundingCommittee.effectiveCommittee('myapp', 'db');
      expect(committee.repinned).to.equal(false);
      expect(committee.fingerprint).to.equal(FP);
      expect(committee.anchor).to.equal(REG_HEIGHT);
      expect(committee.generation).to.equal(0);
      expect(committee.members).to.have.length(9);
    });

    it('a delisted member keeps its seat but loses its address', async () => {
      await foundingCommittee.materializeFor(meshSpec());
      const gone = store.get('myapp').photos[String(REG_HEIGHT)].members[0];
      networkStateService.membershipAt.callsFake((fp) => {
        if (fp !== FP && fp !== CURRENT_FP) return null;
        return fleet(12).filter((node) => node.txhash !== gone.txhash);
      });
      const committee = await foundingCommittee.effectiveCommittee('myapp', 'db');
      expect(committee.repinned).to.equal(false);
      const seat = committee.members.find((member) => member.txhash === gone.txhash);
      expect(seat.ip).to.equal(null);
      expect(committee.members).to.have.length(9);
    });

    it('re-pins from the current list once the recorded owners rot below quorum', async () => {
      await foundingCommittee.materializeFor(meshSpec());
      // eight of nine photo owners leave: a fresh fleet with one survivor
      const photo = store.get('myapp').photos[String(REG_HEIGHT)];
      const survivor = photo.members[0];
      networkStateService.membershipAt.callsFake((fp) => {
        if (fp === FP) return fleet(12);
        if (fp === CURRENT_FP) {
          return [
            { txhash: survivor.txhash, outidx: 0, pubkey: survivor.pubkey, ip: survivor.ip },
            ...fleet(11, 'n', 40),
          ];
        }
        return null;
      });
      const committee = await foundingCommittee.effectiveCommittee('myapp', 'db');
      expect(committee.repinned).to.equal(true);
      expect(committee.fingerprint).to.equal(CURRENT_FP);
      expect(committee.anchor).to.equal(REG_HEIGHT);
      expect(committee.members).to.have.length(9);
    });

    it('no record, no mapped component, no current list — each answers null, never a guess', async () => {
      expect(await foundingCommittee.effectiveCommittee('myapp', 'db')).to.equal(null);

      await foundingCommittee.materializeFor(meshSpec());
      expect(await foundingCommittee.effectiveCommittee('myapp', 'ghost')).to.equal(null);

      networkStateService.membershipFingerprint.returns(null);
      expect(await foundingCommittee.effectiveCommittee('myapp', 'db')).to.equal(null);
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

    it('a newer generation record re-deals every component at its named height', async () => {
      await foundingCommittee.materializeFor(meshSpec({ components: { db: {}, cache: {} } }));
      const ROLL_FP = 'e'.repeat(64);
      networkStateService.membershipFingerprintAt.withArgs(600_000).returns(ROLL_FP);
      networkStateService.membershipAt.callsFake((fp) => (fp === ROLL_FP || fp === CURRENT_FP || fp === FP ? fleet(12) : null));
      generationRows.set('grantgeneration:myapp/founder', generationRow(2, 600_000));

      const db2 = await foundingCommittee.effectiveCommittee('myapp', 'db');
      expect(db2.generation).to.equal(2);
      expect(db2.anchor).to.equal(600_000);
      expect(db2.fingerprint).to.equal(ROLL_FP);
      const cache2 = await foundingCommittee.effectiveCommittee('myapp', 'cache');
      expect(cache2.anchor).to.equal(600_000);
    });

    it('a component added after the roll advances past it', async () => {
      await foundingCommittee.materializeFor(meshSpec());
      await foundingCommittee.materializeGeneration({ appName: 'myapp', generation: 1, height: 600_000 });
      await foundingCommittee.materializeFor(meshSpec({
        height: 700_000, components: { db: {}, cache: {} },
      }));
      const record = store.get('myapp');
      expect(record.components.db.anchorHeight).to.equal(600_000);
      expect(record.components.cache.anchorHeight).to.equal(700_000);
    });

    it('a node whose window misses the named height answers null, not a stale generation', async () => {
      await foundingCommittee.materializeFor(meshSpec());
      networkStateService.membershipFingerprintAt.withArgs(600_000).returns(null);
      generationRows.set('grantgeneration:myapp/founder', generationRow(2, 600_000));
      expect(await foundingCommittee.effectiveCommittee('myapp', 'db')).to.equal(null);
    });

    it('a lower generation never overwrites a higher one', async () => {
      await foundingCommittee.materializeFor(meshSpec());
      store.get('myapp').generation = 3;
      store.get('myapp').generationHeight = 650_000;
      const applied = await foundingCommittee.materializeGeneration({
        appName: 'myapp', generation: 2, height: 500_050,
      });
      expect(applied).to.equal(true); // the call succeeds; the write is a no-op
      expect(store.get('myapp').generation).to.equal(3);
    });

    it('the re-roll MINTS row and mapping on a node that never held one', async () => {
      const applied = await foundingCommittee.materializeGeneration({
        appName: 'myapp', generation: 1, height: 500_050,
      });
      expect(applied).to.equal(true);
      const record = store.get('myapp');
      expect(record.generation).to.equal(1);
      expect(record.components.db.anchorHeight).to.equal(500_050);
      expect(record.photos[String(500_050)].members).to.have.length(9);
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
      generationRows.set('grantgeneration:myapp/founder', {
        data: {
          appName: 'myapp', role: 'founder', generation: 1, height: 500_050, at: 1,
        },
      });
      const committee = await foundingCommittee.effectiveCommittee('myapp', 'db');
      expect(committee).to.not.equal(null);
      expect(committee.generation).to.equal(1);
      expect(committee.anchor).to.equal(500_050);
      expect(committee.members).to.have.length(9);
    });
  });

  describe('the grantor-side check', () => {
    it('membership is answered from the same record the candidates use', async () => {
      await foundingCommittee.materializeFor(meshSpec());
      const member = store.get('myapp').photos[String(REG_HEIGHT)].members[2];
      const yes = await foundingCommittee.selfOnFoundingCommittee('myapp', 'db', FP, 0, {
        txhash: member.txhash, txindex: member.outidx,
      });
      expect(yes.member).to.equal(true);
      expect(yes.quorum).to.equal(5);
      expect(yes.anchor).to.equal(REG_HEIGHT);

      const no = await foundingCommittee.selfOnFoundingCommittee('myapp', 'db', FP, 0, {
        txhash: 'f'.repeat(64), txindex: 0,
      });
      expect(no.member).to.equal(false);
    });

    it('refuses an ask naming a basis this node does not agree with', async () => {
      await foundingCommittee.materializeFor(meshSpec());
      const member = store.get('myapp').photos[String(REG_HEIGHT)].members[0];
      const outcome = await foundingCommittee.selfOnFoundingCommittee('myapp', 'db', 'd'.repeat(64), 0, {
        txhash: member.txhash, txindex: member.outidx,
      });
      expect(outcome.member).to.equal(false);
      expect(outcome.reason).to.contain('different committee basis');
    });

    it('refuses a retired generation, teaching the current one', async () => {
      await foundingCommittee.materializeFor(meshSpec());
      const member = store.get('myapp').photos[String(REG_HEIGHT)].members[0];
      const outcome = await foundingCommittee.selfOnFoundingCommittee('myapp', 'db', FP, 1, {
        txhash: member.txhash, txindex: member.outidx,
      });
      expect(outcome.member).to.equal(false);
      expect(outcome.reason).to.contain('current is 0');
    });
  });
});
