'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');

const { MembershipHistory } = require('../../ZelBack/src/services/utils/membershipHistory');
const { NodeDownTopology } = require('../../ZelBack/src/services/utils/nodeDownTopology');
const { RECORD_LIFETIME_MS } = require('../../ZelBack/src/services/utils/nodeDownCertificates');

const T0 = 1_700_000_000_000;

// A world of seven nodes engineered so every exclusion has a witness:
// B shares S's machine (bare-ip form, so default-port normalization is on
// trial too), D shares S's owner, everyone else is clean.
const fluxnode = (tx, pubkey, ip) => ({
  txhash: tx, outidx: 0, pubkey, ip, added_height: 100,
});

const S = 'ts:0';
const A = 'ta:0';
const B = 'tb:0';
const C = 'tc:0';
const E = 'te:0';
const F = 'tf:0';

function makeWorld() {
  const history = new MembershipHistory();
  const world = {
    nodes: [
      fluxnode('ts', 'pkS', '10.0.0.1:16127'),
      fluxnode('ta', 'pkA', '10.0.0.2:16127'),
      fluxnode('tb', 'pkB', '10.0.0.1'),
      fluxnode('tc', 'pkC', '10.0.0.3:16127'),
      fluxnode('td', 'pkS', '10.0.0.4:16127'),
      fluxnode('te', 'pkE', '10.0.0.5:16127'),
      fluxnode('tf', 'pkF', '10.0.0.6:16127'),
    ],
    history,
    record(height, atMs) {
      return history.record(world.nodes, { height, hash: `h${height}` }, atMs);
    },
    setIp(outpoint, ip) {
      const target = world.nodes.find((n) => `${n.txhash}:${n.outidx}` === outpoint);
      target.ip = ip;
    },
  };
  world.topology = new NodeDownTopology({
    nodes: () => world.nodes,
    membershipHistory: history,
  });
  return world;
}

const outpoints = (jury) => jury.map((j) => j.outpoint).sort();

describe('nodeDownTopology', () => {
  describe('the current membership', () => {
    it('applies both walk exclusions, with bare-ip co-location detected', () => {
      const world = makeWorld();
      world.record(100, T0);
      // B shares S's ip (bare form), D shares S's owner — neither may judge S
      expect(outpoints(world.topology.jury(S))).to.deep.equal([A, C, E, F]);
    });

    it('duties are the exact inverse of juries, and witness relation reads both', () => {
      const world = makeWorld();
      world.record(100, T0);
      const all = world.nodes.map((n) => `${n.txhash}:${n.outidx}`);
      all.forEach((me) => {
        all.forEach((other) => {
          if (me === other) return;
          const inMyJury = world.topology.jury(me).some((j) => j.outpoint === other);
          const inTheirDuties = world.topology.duties(other).some((d) => d.outpoint === me);
          expect(inTheirDuties, `${other} duty of ${me}`).to.equal(inMyJury);
          expect(world.topology.isWitnessRelation(me, other)).to.equal(
            inMyJury || world.topology.jury(other).some((j) => j.outpoint === me),
          );
        });
      });
    });

    it('an unlisted outpoint answers null, never a guess', () => {
      const world = makeWorld();
      world.record(100, T0);
      expect(world.topology.jury('tz:0')).to.equal(null);
      expect(world.topology.duties('tz:0')).to.equal(null);
    });
  });

  describe('at-fingerprint juries — verification recomputes against the named list', () => {
    it('a rebuild across an address change yields the OLD jury, not the current one', () => {
      const world = makeWorld();
      const fp1 = world.record(100, T0);
      world.setIp(B, '10.0.0.9:16127');
      const fp2 = world.record(101, T0 + 1000);

      // current: B moved off S's machine, so it now judges S
      expect(outpoints(world.topology.jury(S))).to.deep.equal([A, B, C, E, F]);
      // at fp1 B was S's co-tenant — the rebuilt jury must still exclude it
      expect(outpoints(world.topology.juryAt(fp1, S))).to.deep.equal([A, C, E, F]);
      expect(outpoints(world.topology.juryAt(fp2, S))).to.deep.equal([A, B, C, E, F]);
    });

    it('an unrebuildable fingerprint answers null, and so does sameJuryFor over it', () => {
      const world = makeWorld();
      world.record(100, T0);
      expect(world.topology.juryAt('f'.repeat(64), S)).to.equal(null);
      expect(world.topology.sameJuryFor(S, 'f'.repeat(64))).to.equal(null);
    });

    it('sameJuryFor groups fingerprints whose change never touched this jury', () => {
      const world = makeWorld();
      const fp1 = world.record(100, T0);
      world.setIp(B, '10.0.0.9:16127');
      const fp2 = world.record(101, T0 + 1000);
      // F's move touches no exclusion involving S: same jury as fp2
      world.setIp(F, '10.0.0.7:16127');
      const fp3 = world.record(102, T0 + 2000);

      const same = world.topology.sameJuryFor(S, fp3);
      expect(same.has(fp3)).to.equal(true);
      expect(same.has(fp2)).to.equal(true);
      expect(same.has(fp1)).to.equal(false);
    });

    it('retention expiry removes the rebuild, exactly as verification requires', () => {
      const world = makeWorld();
      const fp1 = world.record(100, T0);
      world.setIp(B, '10.0.0.9:16127');
      const fp2 = world.record(101, T0 + 1000);
      world.setIp(F, '10.0.0.7:16127');
      const fp3 = world.record(102, T0 + 2000);
      world.setIp(F, '10.0.0.8:16127');
      world.record(103, T0 + RECORD_LIFETIME_MS + 60 * 60 * 1000);

      expect(world.topology.juryAt(fp1, S)).to.equal(null);
      expect(world.topology.juryAt(fp2, S)).to.equal(null);
      // fp3 is the parent of the transition that JUST happened: a membership
      // current until moments ago stays rebuildable whatever its age
      expect(world.topology.juryAt(fp3, S)).to.not.equal(null);
    });
  });

  describe('count-time co-tenants — the walk rule re-applied where knowledge is freshest', () => {
    it('names jurors sharing the subject address on the CURRENT list', () => {
      const world = makeWorld();
      world.record(100, T0);
      const jury = [{ outpoint: B }, { outpoint: A }, { outpoint: C }];
      expect([...world.topology.cotenants(S, jury)]).to.deep.equal([B]);
    });

    it('empties when the co-tenancy ends or the subject leaves the list', () => {
      const world = makeWorld();
      world.record(100, T0);
      world.setIp(B, '10.0.0.9:16127');
      world.record(101, T0 + 1000);
      expect(world.topology.cotenants(S, [{ outpoint: B }]).size).to.equal(0);

      world.nodes = world.nodes.filter((n) => n.txhash !== 'ts');
      world.record(102, T0 + 2000);
      expect(world.topology.cotenants(S, [{ outpoint: B }]).size).to.equal(0);
    });
  });

  describe('retainedFingerprints', () => {
    it('lists the rebuildable set newest first and prunes with retention', () => {
      const history = new MembershipHistory();
      const nodes = [fluxnode('ta', 'pkA', '10.0.0.2')];
      const fp1 = history.record(nodes, { height: 1, hash: 'a' }, T0);
      const fp2 = history.record(
        [...nodes, fluxnode('tb', 'pkB', '10.0.0.3')],
        { height: 2, hash: 'b' },
        T0 + 1000,
      );
      expect(history.retainedFingerprints()).to.deep.equal([fp2, fp1]);

      const fp3 = history.record(nodes, { height: 3, hash: 'c' }, T0 + 7 * 60 * 60 * 1000);
      expect(history.retainedFingerprints()).to.deep.equal([fp3, fp2]);
    });
  });
});
