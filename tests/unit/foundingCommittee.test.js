'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const dbHelper = require('../../ZelBack/src/services/dbHelper');
const networkStateService = require('../../ZelBack/src/services/networkStateService');
const daemonServiceMiscRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceMiscRpcs');
const foundingCommittee = require('../../ZelBack/src/services/appMesh/foundingCommittee');

// Component-blind referees: the anchor side works from public registry
// metadata alone (name, height, version) and must never need the envelope
// opened; the mapping side works from the cleartext view and exists only
// where the view resolves. What matters at every branch is honesty — no
// photo is ever minted from a list this node did not witness — and world
// separation: a removed-and-re-added component pins at a fresh anchor.

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

function anchorDoc(overrides = {}) {
  return {
    name: 'myapp', height: REG_HEIGHT, version: 9, ...overrides,
  };
}

function meshView(overrides = {}) {
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
        store.set(query._id, { _id: query._id, ...(update.$setOnInsert ?? {}), ...(update.$set ?? {}) });
      } else {
        store.set(query._id, { ...existing, ...(update.$set ?? {}) });
      }
      return { value: store.get(query._id) };
    });
    sinon.stub(dbHelper, 'findInDatabase').callsFake(async () => [...store.values()]);
    sinon.stub(networkStateService, 'membershipFingerprintAt').returns(FP);
    sinon.stub(networkStateService, 'membershipAt').callsFake((fp) => (fp === FP || fp === CURRENT_FP ? fleet(12) : null));
    sinon.stub(networkStateService, 'membershipFingerprint').returns(CURRENT_FP);
    sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({ status: 'success', data: { synced: true } });
    sinon.stub(daemonServiceMiscRpcs, 'getCurrentDaemonHeight').returns(REG_HEIGHT + 10);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('the blinded token', () => {
    it('is 16 hex chars, deterministic, and distinct per app and component', () => {
      const a = foundingCommittee.founderToken('myapp', 'db');
      expect(a).to.match(/^[a-f0-9]{16}$/);
      expect(foundingCommittee.founderToken('myapp', 'db')).to.equal(a);
      expect(foundingCommittee.founderToken('myapp', 'web')).to.not.equal(a);
      expect(foundingCommittee.founderToken('other', 'db')).to.not.equal(a);
    });
  });

  describe('anchors from public metadata', () => {
    it('records a v9 anchor and photographs nine seats, journaled, no view needed', async () => {
      await foundingCommittee.recordAnchor(anchorDoc());
      const record = store.get('myapp');
      expect(record.generation).to.equal(0);
      const photo = record.anchors[String(REG_HEIGHT)];
      expect(photo.fingerprint).to.equal(FP);
      expect(photo.quorum).to.equal(5);
      expect(photo.members).to.have.length(9);
    });

    it('ignores pre-v9 specs and malformed docs', async () => {
      await foundingCommittee.recordAnchor(anchorDoc({ version: 8 }));
      await foundingCommittee.recordAnchor(anchorDoc({ height: undefined }));
      await foundingCommittee.recordAnchor({ height: 1, version: 9 });
      expect(store.size).to.equal(0);
    });

    it('outside its window the anchor is recorded with no photo — an honest gap', async () => {
      networkStateService.membershipFingerprintAt.returns(null);
      await foundingCommittee.recordAnchor(anchorDoc());
      const record = store.get('myapp');
      expect(record.specHeight).to.equal(REG_HEIGHT);
      expect(record.anchors).to.deep.equal({});
      expect(await foundingCommittee.refereeCommittee('myapp', REG_HEIGHT)).to.equal(null);
    });

    it('anchors apply in chain order and accumulate per update', async () => {
      await foundingCommittee.recordAnchor(anchorDoc({ height: 600_000 }));
      await foundingCommittee.recordAnchor(anchorDoc());
      const record = store.get('myapp');
      expect(record.specHeight).to.equal(600_000);
      expect(record.anchors[String(REG_HEIGHT)]).to.equal(undefined);

      await foundingCommittee.recordAnchor(anchorDoc({ height: 700_000 }));
      expect(store.get('myapp').anchors[String(700_000)].members).to.have.length(9);
      expect(store.get('myapp').anchors[String(600_000)].members).to.have.length(9);
    });
  });

  describe('the component mapping from the view', () => {
    it('maps components at their introducing height, mesh views only', async () => {
      await foundingCommittee.applyComponentView(meshView());
      expect(store.get('myapp').components.db.anchorHeight).to.equal(REG_HEIGHT);

      await foundingCommittee.applyComponentView({ ...meshView({ name: 'plain' }), network: {} });
      expect(store.get('plain')).to.equal(undefined);
    });

    it('an update keeps old anchors, pins new components, drops removed ones', async () => {
      await foundingCommittee.applyComponentView(meshView());
      await foundingCommittee.applyComponentView(meshView({
        height: 600_000, components: { db: {}, cache: {} },
      }));
      let record = store.get('myapp');
      expect(record.components.db.anchorHeight).to.equal(REG_HEIGHT);
      expect(record.components.cache.anchorHeight).to.equal(600_000);

      await foundingCommittee.applyComponentView(meshView({ height: 700_000 }));
      record = store.get('myapp');
      expect(record.components.cache).to.equal(undefined);
      expect(await foundingCommittee.componentAnchor('myapp', 'cache')).to.equal(null);
    });

    it('a re-added component is a NEW world at a new anchor', async () => {
      await foundingCommittee.applyComponentView(meshView({ components: { db: {}, cache: {} } }));
      await foundingCommittee.applyComponentView(meshView({ height: 600_000 }));
      await foundingCommittee.applyComponentView(meshView({
        height: 700_000, components: { db: {}, cache: {} },
      }));
      expect(store.get('myapp').components.cache.anchorHeight).to.equal(700_000);
      expect(store.get('myapp').components.db.anchorHeight).to.equal(REG_HEIGHT);
    });

    it('a stale view write changes nothing', async () => {
      await foundingCommittee.applyComponentView(meshView({ height: 600_000 }));
      await foundingCommittee.applyComponentView(meshView({
        height: REG_HEIGHT, components: { ghost: {} },
      }));
      expect(store.get('myapp').components.ghost).to.equal(undefined);
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

    it('a newer generation record photographs its height and re-deals the reads', async () => {
      await foundingCommittee.recordAnchor(anchorDoc());
      const ROLL_FP = 'e'.repeat(64);
      networkStateService.membershipFingerprintAt.withArgs(600_000).returns(ROLL_FP);
      networkStateService.membershipAt.callsFake((fp) => (fp === ROLL_FP || fp === CURRENT_FP || fp === FP ? fleet(12) : null));
      generationRows.set('grantgeneration:myapp/founder', generationRow(2, 600_000));

      const committee = await foundingCommittee.refereeCommittee('myapp', 600_000);
      expect(committee.generation).to.equal(2);
      expect(committee.anchor).to.equal(600_000);
      expect(committee.fingerprint).to.equal(ROLL_FP);
    });

    it('the roll lifts mapped anchors to at least its height, and later views advance past it', async () => {
      await foundingCommittee.applyComponentView(meshView());
      await foundingCommittee.materializeGeneration({ appName: 'myapp', generation: 1, height: 600_000 });
      expect(store.get('myapp').components.db.anchorHeight).to.equal(600_000);

      await foundingCommittee.applyComponentView(meshView({
        height: 700_000, components: { db: {}, cache: {} },
      }));
      expect(store.get('myapp').components.db.anchorHeight).to.equal(600_000);
      expect(store.get('myapp').components.cache.anchorHeight).to.equal(700_000);
    });

    it('a node whose window misses the named height answers null, not a stale generation', async () => {
      await foundingCommittee.recordAnchor(anchorDoc());
      networkStateService.membershipFingerprintAt.withArgs(600_000).returns(null);
      generationRows.set('grantgeneration:myapp/founder', generationRow(2, 600_000));
      expect(await foundingCommittee.refereeCommittee('myapp', REG_HEIGHT)).to.equal(null);
    });

    it('a lower generation never overwrites a higher one', async () => {
      await foundingCommittee.recordAnchor(anchorDoc());
      store.get('myapp').generation = 3;
      store.get('myapp').generationHeight = 650_000;
      const applied = await foundingCommittee.materializeGeneration({
        appName: 'myapp', generation: 2, height: 500_050,
      });
      expect(applied).to.equal(true); // the call succeeds; the write is a no-op
      expect(store.get('myapp').generation).to.equal(3);
    });

    it('the re-roll MINTS the row on a node that never held one — no envelope needed', async () => {
      const applied = await foundingCommittee.materializeGeneration({
        appName: 'myapp', generation: 1, height: 500_050,
      });
      expect(applied).to.equal(true);
      const record = store.get('myapp');
      expect(record.generation).to.equal(1);
      expect(record.anchors[String(500_050)].members).to.have.length(9);
    });

    it('an owner record rescues a photo-less referee end to end', async () => {
      generationRows.set('grantgeneration:myapp/founder', generationRow(1, 500_050));
      const committee = await foundingCommittee.refereeCommittee('myapp', 500_050);
      expect(committee).to.not.equal(null);
      expect(committee.generation).to.equal(1);
      expect(committee.members).to.have.length(9);
    });
  });

  describe('the referee committee', () => {
    it('the photo stands while a quorum of its owners remains listed', async () => {
      await foundingCommittee.recordAnchor(anchorDoc());
      const committee = await foundingCommittee.refereeCommittee('myapp', REG_HEIGHT);
      expect(committee.fingerprint).to.equal(FP);
      expect(committee.members).to.have.length(9);
    });

    it('a delisted member keeps its seat but loses its address', async () => {
      await foundingCommittee.recordAnchor(anchorDoc());
      const gone = store.get('myapp').anchors[String(REG_HEIGHT)].members[0];
      networkStateService.membershipAt.callsFake((fp) => {
        if (fp !== FP && fp !== CURRENT_FP) return null;
        return fleet(12).filter((node) => node.txhash !== gone.txhash);
      });
      const committee = await foundingCommittee.refereeCommittee('myapp', REG_HEIGHT);
      expect(committee.members.find((m) => m.txhash === gone.txhash).ip).to.equal(null);
    });

    it('rot never re-derives at read time — the photo answers, rotted or not', async () => {
      // The old exit rule re-pinned from the CURRENT list here — a moving
      // target two readers never share, the two-committees-one-register
      // hazard the model broke (formal/founder-pin-expiry). The flip
      // evaluator owns rot now; the read stays pinned.
      await foundingCommittee.recordAnchor(anchorDoc());
      const photo = store.get('myapp').anchors[String(REG_HEIGHT)];
      const survivor = photo.members[0];
      networkStateService.membershipAt.callsFake((fp) => {
        if (fp === FP) return fleet(12);
        if (fp === CURRENT_FP) {
          return [
            {
              txhash: survivor.txhash, outidx: 0, pubkey: survivor.pubkey, ip: survivor.ip,
            },
            ...fleet(11, 'n', 40),
          ];
        }
        return null;
      });
      const committee = await foundingCommittee.refereeCommittee('myapp', REG_HEIGHT);
      expect(committee.fingerprint).to.equal(FP);
      expect(committee.members.map((m) => m.txhash)).to.deep.equal(photo.members.map((m) => m.txhash));
    });

    it('no row, an unknown anchor, no current list — each answers null, never a guess', async () => {
      expect(await foundingCommittee.refereeCommittee('myapp', REG_HEIGHT)).to.equal(null);

      await foundingCommittee.recordAnchor(anchorDoc());
      expect(await foundingCommittee.refereeCommittee('myapp', 123_456)).to.equal(null);

      networkStateService.membershipFingerprint.returns(null);
      expect(await foundingCommittee.refereeCommittee('myapp', REG_HEIGHT)).to.equal(null);
    });
  });

  describe('the flip', () => {
    // Dials at code defaults: FlipN 720, GateLag 240, QuietZone 10. The
    // grid is intro + k*720; rot observed at REG_HEIGHT+10 puts the first
    // eligible rung at REG_HEIGHT+720.
    const ROT_SEEN = REG_HEIGHT + 10;
    const RUNG = REG_HEIGHT + 720;

    function rotTheFleet() {
      const photo = store.get('myapp').anchors[String(REG_HEIGHT)];
      const survivor = photo.members[0];
      networkStateService.membershipAt.callsFake((fp) => {
        if (fp === FP) return fleet(12);
        return [
          {
            txhash: survivor.txhash, outidx: 0, pubkey: survivor.pubkey, ip: survivor.ip,
          },
          ...fleet(11, 'n', 40),
        ];
      });
    }

    it('sustained rot stamps, recovery clears — no flip before the gate', async () => {
      await foundingCommittee.recordAnchor(anchorDoc());
      rotTheFleet();
      daemonServiceMiscRpcs.getCurrentDaemonHeight.returns(ROT_SEEN);
      await foundingCommittee.evaluateFlips();
      expect(store.get('myapp').anchors[String(REG_HEIGHT)].rotSinceHeight).to.equal(ROT_SEEN);
      expect(store.get('myapp').anchors[String(RUNG)]).to.equal(undefined);

      // the committee recovers: the stamp clears, nothing ever flips
      networkStateService.membershipAt.callsFake((fp) => (fp === FP || fp === CURRENT_FP ? fleet(12) : null));
      await foundingCommittee.evaluateFlips();
      expect(store.get('myapp').anchors[String(REG_HEIGHT)].rotSinceHeight).to.equal(undefined);
    });

    it('the flip mints at the grid height once rot has aged past the gate', async () => {
      await foundingCommittee.recordAnchor(anchorDoc());
      rotTheFleet();
      daemonServiceMiscRpcs.getCurrentDaemonHeight.returns(ROT_SEEN);
      await foundingCommittee.evaluateFlips();

      // gate not yet: the rung height has not arrived
      daemonServiceMiscRpcs.getCurrentDaemonHeight.returns(RUNG - 1);
      networkStateService.membershipFingerprintAt.callsFake((h) => (h === RUNG ? CURRENT_FP : FP));
      await foundingCommittee.evaluateFlips();
      expect(store.get('myapp').anchors[String(RUNG)]).to.equal(undefined);

      daemonServiceMiscRpcs.getCurrentDaemonHeight.returns(RUNG);
      await foundingCommittee.evaluateFlips();
      const minted = store.get('myapp').anchors[String(RUNG)];
      expect(minted.flipOf).to.equal(REG_HEIGHT);
      expect(minted.fingerprint).to.equal(CURRENT_FP);
      expect(minted.members).to.have.length(9);
    });

    it('a missed photo window delays the flip, never guesses it', async () => {
      await foundingCommittee.recordAnchor(anchorDoc());
      rotTheFleet();
      daemonServiceMiscRpcs.getCurrentDaemonHeight.returns(ROT_SEEN);
      await foundingCommittee.evaluateFlips();
      daemonServiceMiscRpcs.getCurrentDaemonHeight.returns(RUNG);
      networkStateService.membershipFingerprintAt.returns(null);
      await foundingCommittee.evaluateFlips();
      expect(store.get('myapp').anchors[String(RUNG)]).to.equal(undefined);
    });

    it('componentWorld walks the ladder and arms inside the quiet zone', async () => {
      await foundingCommittee.recordAnchor(anchorDoc());
      await foundingCommittee.applyComponentView(meshView());
      rotTheFleet();
      daemonServiceMiscRpcs.getCurrentDaemonHeight.returns(ROT_SEEN);
      await foundingCommittee.evaluateFlips();

      // far from the rung: not armed
      let world = await foundingCommittee.componentWorld('myapp', 'db');
      expect(world).to.deep.include({ intro: REG_HEIGHT, armed: false });
      expect(world.rungs).to.deep.equal([REG_HEIGHT]);

      // inside the quiet zone of the pending rung: armed
      daemonServiceMiscRpcs.getCurrentDaemonHeight.returns(RUNG - 5);
      world = await foundingCommittee.componentWorld('myapp', 'db');
      expect(world.armed).to.equal(true);

      // the rung mints: the ladder grows and the world disarms
      networkStateService.membershipFingerprintAt.callsFake((h) => (h === RUNG ? CURRENT_FP : FP));
      daemonServiceMiscRpcs.getCurrentDaemonHeight.returns(RUNG);
      await foundingCommittee.evaluateFlips();
      world = await foundingCommittee.componentWorld('myapp', 'db');
      expect(world.rungs).to.deep.equal([REG_HEIGHT, RUNG]);
      expect(world.armed).to.equal(false);
      expect(await foundingCommittee.newestRungFor('myapp', REG_HEIGHT)).to.equal(RUNG);
    });

    it('appWorld is the app\'s FIRST world — the earliest component intro — whatever the component ladder', async () => {
      // an ordinal register is per app, shared by every component a node
      // hosts, so its rung ladder is the app's oldest world's
      expect(await foundingCommittee.appWorld('myapp')).to.equal(null);
      await foundingCommittee.recordAnchor(anchorDoc());
      await foundingCommittee.applyComponentView(meshView());
      const byComponent = await foundingCommittee.componentWorld('myapp', 'db');
      const byApp = await foundingCommittee.appWorld('myapp');
      expect(byApp).to.deep.equal(byComponent);
      expect(byApp.intro).to.equal(REG_HEIGHT);
    });

    it('equality serve: a flipped-past basis is refused, the newest rung answers', async () => {
      await foundingCommittee.recordAnchor(anchorDoc());
      rotTheFleet();
      daemonServiceMiscRpcs.getCurrentDaemonHeight.returns(ROT_SEEN);
      await foundingCommittee.evaluateFlips();
      networkStateService.membershipFingerprintAt.callsFake((h) => (h === RUNG ? CURRENT_FP : FP));
      daemonServiceMiscRpcs.getCurrentDaemonHeight.returns(RUNG);
      await foundingCommittee.evaluateFlips();

      const minted = store.get('myapp').anchors[String(RUNG)];
      const member = minted.members[2];
      const oldAsk = await foundingCommittee.selfOnFoundingCommittee(
        'myapp', REG_HEIGHT, FP, 0, { txhash: member.txhash, txindex: 0 },
      );
      expect(oldAsk.member).to.equal(false);
      expect(oldAsk.reason).to.include('flipped past');

      const newAsk = await foundingCommittee.selfOnFoundingCommittee(
        'myapp', RUNG, CURRENT_FP, 0, { txhash: member.txhash, txindex: 0 },
      );
      expect(newAsk.member).to.equal(true);
    });

    it('founder serving gates on the own view: stale chain and self-delisted both refuse', async () => {
      await foundingCommittee.recordAnchor(anchorDoc());
      const member = store.get('myapp').anchors[String(REG_HEIGHT)].members[0];
      const collateral = { txhash: member.txhash, txindex: 0 };

      daemonServiceMiscRpcs.isDaemonSynced.returns({ status: 'success', data: { synced: false } });
      let verdict = await foundingCommittee.selfOnFoundingCommittee('myapp', REG_HEIGHT, FP, 0, collateral);
      expect(verdict.member).to.equal(false);
      expect(verdict.reason).to.include('stale');

      daemonServiceMiscRpcs.isDaemonSynced.returns({ status: 'success', data: { synced: true } });
      networkStateService.membershipAt.callsFake((fp) => {
        if (fp === FP) return fleet(12);
        if (fp === CURRENT_FP) return fleet(12).filter((node) => node.txhash !== member.txhash);
        return null;
      });
      verdict = await foundingCommittee.selfOnFoundingCommittee('myapp', REG_HEIGHT, FP, 0, collateral);
      expect(verdict.member).to.equal(false);
      expect(verdict.reason).to.include('no longer listed');
    });
  });

  describe('the grantor-side check', () => {
    it('membership keys on the anchor, blind to components', async () => {
      await foundingCommittee.recordAnchor(anchorDoc());
      const member = store.get('myapp').anchors[String(REG_HEIGHT)].members[2];
      const yes = await foundingCommittee.selfOnFoundingCommittee('myapp', REG_HEIGHT, FP, 0, {
        txhash: member.txhash, txindex: member.outidx,
      });
      expect(yes.member).to.equal(true);
      expect(yes.quorum).to.equal(5);

      const no = await foundingCommittee.selfOnFoundingCommittee('myapp', REG_HEIGHT, FP, 0, {
        txhash: 'f'.repeat(64), txindex: 0,
      });
      expect(no.member).to.equal(false);
    });

    it('refuses a basis this node does not agree with, and a retired generation teaching the current', async () => {
      await foundingCommittee.recordAnchor(anchorDoc());
      const member = store.get('myapp').anchors[String(REG_HEIGHT)].members[0];

      const basis = await foundingCommittee.selfOnFoundingCommittee('myapp', REG_HEIGHT, 'd'.repeat(64), 0, {
        txhash: member.txhash, txindex: member.outidx,
      });
      expect(basis.member).to.equal(false);
      expect(basis.reason).to.contain('different committee basis');

      const retired = await foundingCommittee.selfOnFoundingCommittee('myapp', REG_HEIGHT, FP, 1, {
        txhash: member.txhash, txindex: member.outidx,
      });
      expect(retired.member).to.equal(false);
      expect(retired.reason).to.contain('current is 0');
    });
  });
});
