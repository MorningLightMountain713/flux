'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

// classifyPeers is judged as a pure function over hostmap fixtures; the
// orchestration around it is driven through stubbed meshSsh/meshRefuseSet.
// The member and hostmap shapes mirror what evaluateCandidates and nebula's
// list-hostmap -json actually produce.
describe('meshDetector', () => {
  const MEMBER_A = {
    outpoint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0',
    nodeId: 'aaaa1111',
    address: 'fd00::a',
    block: 'fd00::a:0:0/96',
    caShas: ['fp-a'],
  };
  const MEMBER_B = {
    outpoint: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:1',
    nodeId: 'bbbb2222',
    address: 'fd00::b',
    block: 'fd00::b:0:0/96',
    caShas: ['fp-b-old', 'fp-b-new'],
  };
  const MEMBERS = [MEMBER_A, MEMBER_B];

  const tunnel = (issuer, vpnAddrs, unsafeNetworks = []) => ({
    vpnAddrs,
    cert: { details: { issuer, unsafeNetworks }, fingerprint: 'leaf' },
  });

  describe('classifyPeers', () => {
    let meshDetector;

    beforeEach(() => {
      meshDetector = require('../../ZelBack/src/services/appMesh/meshDetector'); // eslint-disable-line global-require
    });

    it('accepts a member claiming exactly its derived identity', () => {
      const { cheats, foreign } = meshDetector.classifyPeers([
        tunnel('fp-a', ['fd00::a'], ['fd00::a:0:0/96']),
        tunnel('fp-b-new', ['fd00::b'], ['fd00::b:0:0/96']),
      ], MEMBERS);
      expect(cheats).to.deep.equal([]);
      expect(foreign).to.deep.equal([]);
    });

    it('convicts a member claiming a sibling address under its own authority', () => {
      const { cheats } = meshDetector.classifyPeers([
        tunnel('fp-b-new', ['fd00::a'], []),
      ], MEMBERS);
      expect(cheats).to.have.length(1);
      expect(cheats[0].outpoint).to.equal(MEMBER_B.outpoint);
      expect(cheats[0].claimedAddrs).to.deep.equal(['fd00::a']);
      expect(cheats[0].expectedAddress).to.equal('fd00::b');
    });

    it('convicts a member routing beyond its own block', () => {
      const { cheats } = meshDetector.classifyPeers([
        tunnel('fp-a', ['fd00::a'], ['fd00::b:0:0/96']),
      ], MEMBERS);
      expect(cheats).to.have.length(1);
      expect(cheats[0].outpoint).to.equal(MEMBER_A.outpoint);
    });

    it('classifies a tunnel under an unknown authority as foreign, never a cheat', () => {
      const { cheats, foreign } = meshDetector.classifyPeers([
        tunnel('fp-evicted', ['fd00::c'], []),
      ], MEMBERS);
      expect(cheats).to.deep.equal([]);
      expect(foreign).to.deep.equal([{ issuer: 'fp-evicted', vpnAddrs: ['fd00::c'] }]);
    });

    it('convicts once per outpoint however many tunnels offend', () => {
      const { cheats } = meshDetector.classifyPeers([
        tunnel('fp-b-old', ['fd00::a'], []),
        tunnel('fp-b-new', ['fd00::a'], []),
      ], MEMBERS);
      expect(cheats).to.have.length(1);
    });

    it('a member with several authorities is judged under each', () => {
      const { cheats, foreign } = meshDetector.classifyPeers([
        tunnel('fp-b-old', ['fd00::b'], ['fd00::b:0:0/96']),
      ], MEMBERS);
      expect(cheats).to.deep.equal([]);
      expect(foreign).to.deep.equal([]);
    });
  });

  describe('detectImpersonation', () => {
    let meshDetector;
    let refused;
    let hostmapResult;

    beforeEach(() => {
      refused = [];
      meshDetector = proxyquire('../../ZelBack/src/services/appMesh/meshDetector', {
        './meshSsh': {
          listHostmap: sinon.stub().callsFake(async () => {
            if (hostmapResult instanceof Error) throw hostmapResult;
            return hostmapResult;
          }),
        },
        './meshRefuseSet': {
          refuseOutpoint: sinon.stub().callsFake(async (instance, outpoint) => {
            refused.push(outpoint);
          }),
        },
        '../../lib/log': {
          info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
        },
      });
    });

    afterEach(() => sinon.restore());

    it('refuses every convicted outpoint', async () => {
      hostmapResult = [tunnel('fp-a', ['fd00::b'], [])];
      const result = await meshDetector.detectImpersonation('ab12cd34ef56', MEMBERS);
      expect(result.checked).to.equal(true);
      expect(result.evicted).to.have.length(1);
      expect(refused).to.deep.equal([MEMBER_A.outpoint]);
    });

    it('judges nothing when the peer table is unreadable', async () => {
      hostmapResult = new Error('Connection refused');
      const result = await meshDetector.detectImpersonation('ab12cd34ef56', MEMBERS);
      expect(result.checked).to.equal(false);
      expect(refused).to.deep.equal([]);
    });
  });

  describe('awaitEvictionConverged', () => {
    let meshDetector;
    let tables;
    let clock;

    beforeEach(() => {
      tables = [];
      // The poll delay drives a fake clock, so the converge window elapses in
      // test time rather than wall time.
      clock = sinon.useFakeTimers();
      meshDetector = proxyquire('../../ZelBack/src/services/appMesh/meshDetector', {
        './meshSsh': {
          listHostmap: sinon.stub().callsFake(async () => {
            if (tables.length === 0) return [];
            return tables.length > 1 ? tables.shift() : tables[0];
          }),
        },
        '../serviceHelper': {
          delay: sinon.stub().callsFake(async (ms) => {
            clock.tick(ms);
          }),
        },
        '../../lib/log': {
          info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
        },
      });
    });

    afterEach(() => {
      clock.restore();
      sinon.restore();
    });

    it('true once every tunnel cites a trusted authority', async () => {
      tables = [
        [tunnel('fp-evicted', ['fd00::c'], [])],
        [tunnel('fp-a', ['fd00::a'], [])],
      ];
      const converged = await meshDetector.awaitEvictionConverged('ab12cd34ef56', new Set(['fp-a']));
      expect(converged).to.equal(true);
    });

    it('false when the untrusted tunnel persists past the window', async () => {
      tables = [[tunnel('fp-evicted', ['fd00::c'], [])]];
      const converged = await meshDetector.awaitEvictionConverged('ab12cd34ef56', new Set(['fp-a']));
      expect(converged).to.equal(false);
    });
  });
});
