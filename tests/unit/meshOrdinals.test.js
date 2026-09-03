'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

// Canonical outpoints: node ids derive from them and refuse anything shorter.
const ME = `${'a'.repeat(64)}:0`;
const OTHER = `${'b'.repeat(64)}:0`;
const THIRD = `${'c'.repeat(64)}:1`;

// The consumer of ordinal grants: the joiner's scan (probe upward, found the
// first free), the own ordinal and every holder read off the synced record,
// and the release. The register is faked behind the seam it registers into.
function load(register = {}) {
  const seam = {
    probeOrdinal: sinon.stub().resolves({ decided: true, holder: null }),
    askOrdinal: sinon.stub().resolves({ answer: 'yes' }),
    releaseOrdinal: sinon.stub().resolves({ released: true }),
    ordinalHolders: sinon.stub().resolves(new Map()),
    vacateOrdinal: sinon.stub().resolves({ vacated: false, reason: 'no standing certificate' }),
    ...register,
  };
  const meshOrdinals = proxyquire('../../ZelBack/src/services/appMesh/meshOrdinals', {
    './ordinalRegisterSeam': seam,
    '../generalService': {
      obtainNodeCollateralInformation: sinon.stub().resolves({ txhash: 'a'.repeat(64), txindex: 0 }),
    },
  });
  return { meshOrdinals, seam };
}

// A register answering per ordinal: held[k] = holder outpoint, or absent = free.
function probes(held) {
  return sinon.stub().callsFake(async (app, k) => ({ decided: true, holder: held[k] ?? null }));
}

describe('meshOrdinals', () => {
  afterEach(() => sinon.restore());

  describe('claimOrdinal — the scan', () => {
    it('founds the lowest free ordinal, skipping the held ones without asking for them', async () => {
      const { meshOrdinals, seam } = load({ probeOrdinal: probes({ 0: OTHER }) });
      expect(await meshOrdinals.claimOrdinal('app', 3)).to.deep.equal({ state: 'granted', ordinal: 1 });
      expect(seam.askOrdinal.args).to.deep.equal([['app', 1]]);
    });

    it('a found that loses the race moves on to the next ordinal', async () => {
      const { meshOrdinals, seam } = load({
        askOrdinal: sinon.stub()
          .onFirstCall().resolves({ answer: 'no', holder: OTHER })
          .onSecondCall().resolves({ answer: 'yes' }),
      });
      expect(await meshOrdinals.claimOrdinal('app', 3)).to.deep.equal({ state: 'granted', ordinal: 1 });
      expect(seam.askOrdinal.args).to.deep.equal([['app', 0], ['app', 1]]);
    });

    it('an ordinal the register already shows as mine is mine, without a new ask', async () => {
      const { meshOrdinals, seam } = load({ probeOrdinal: probes({ 0: OTHER, 1: ME }) });
      expect(await meshOrdinals.claimOrdinal('app', 3)).to.deep.equal({ state: 'granted', ordinal: 1 });
      expect(seam.askOrdinal.callCount).to.equal(0);
    });

    it('an undecided probe is a wait, and nothing past it is asked', async () => {
      const { meshOrdinals, seam } = load({
        probeOrdinal: sinon.stub().resolves({ decided: false, holder: null }),
      });
      expect(await meshOrdinals.claimOrdinal('app', 3)).to.deep.equal({ state: 'wait', reason: 'undecided' });
      expect(seam.askOrdinal.callCount).to.equal(0);
    });

    it('a wait from the register passes through with its retry', async () => {
      const { meshOrdinals } = load({
        askOrdinal: sinon.stub().resolves({ answer: 'wait', retryAfterMs: 1500, reason: 'no quorum' }),
      });
      expect(await meshOrdinals.claimOrdinal('app', 3))
        .to.deep.equal({ state: 'wait', retryAfterMs: 1500, reason: 'no quorum' });
    });

    it('is a standby when every ordinal is held, and when the space is empty', async () => {
      const { meshOrdinals, seam } = load({ probeOrdinal: probes({ 0: OTHER, 1: THIRD }) });
      expect(await meshOrdinals.claimOrdinal('app', 2)).to.deep.equal({ state: 'standby', ordinal: null });
      expect(seam.askOrdinal.callCount).to.equal(0);
      expect(await meshOrdinals.claimOrdinal('app', 0)).to.deep.equal({ state: 'standby', ordinal: null });
    });

    // The vacate by certificate follows the derivation's placement-dead edge
    // (NODE_DOWN_SCENARIOS.md R9): a held ordinal whose holder the network
    // has certified down and stopped placing is reclaimed by the node that
    // needs the name, on its own scan — the register judges, the joiner asks.
    it("a held ordinal whose holder the register vacates is founded by the joiner — on the joiner's own pass", async () => {
      const { meshOrdinals, seam } = load({
        probeOrdinal: probes({ 0: OTHER }),
        vacateOrdinal: sinon.stub().resolves({ vacated: true }),
      });
      expect(await meshOrdinals.claimOrdinal('app', 3)).to.deep.equal({ state: 'granted', ordinal: 0 });
      expect(seam.vacateOrdinal.args).to.deep.equal([['app', 0, OTHER]]);
      expect(seam.askOrdinal.args).to.deep.equal([['app', 0]]);
    });

    it('a vacate the register refuses leaves the ordinal held, and the scan moves on', async () => {
      const { meshOrdinals, seam } = load({ probeOrdinal: probes({ 0: OTHER }) });
      expect(await meshOrdinals.claimOrdinal('app', 3)).to.deep.equal({ state: 'granted', ordinal: 1 });
      expect(seam.vacateOrdinal.args).to.deep.equal([['app', 0, OTHER]]);
      expect(seam.askOrdinal.args).to.deep.equal([['app', 1]]);
    });

    it('an ordinal the register shows as mine, and a free one, are never offered for a vacate', async () => {
      const mine = load({ probeOrdinal: probes({ 0: ME }) });
      expect(await mine.meshOrdinals.claimOrdinal('app', 3)).to.deep.equal({ state: 'granted', ordinal: 0 });
      expect(mine.seam.vacateOrdinal.callCount).to.equal(0);
      const free = load();
      expect(await free.meshOrdinals.claimOrdinal('app', 3)).to.deep.equal({ state: 'granted', ordinal: 0 });
      expect(free.seam.vacateOrdinal.callCount).to.equal(0);
    });

    it('never reads the holders record to find a free ordinal — the record can lag, the probe cannot', async () => {
      const { meshOrdinals, seam } = load({ probeOrdinal: probes({ 0: OTHER }) });
      await meshOrdinals.claimOrdinal('app', 3);
      expect(seam.ordinalHolders.callCount).to.equal(0);
    });
  });

  describe('the record — names come from what the fleet decided', () => {
    it('ownOrdinal is the ordinal the record names me for, or null', async () => {
      const { meshOrdinals } = load({ ordinalHolders: sinon.stub().resolves(new Map([[0, OTHER], [2, ME]])) });
      expect(await meshOrdinals.ownOrdinal('app')).to.equal(2);
      const none = load({ ordinalHolders: sinon.stub().resolves(new Map([[0, OTHER]])) });
      expect(await none.meshOrdinals.ownOrdinal('app')).to.equal(null);
    });

    it('holdersByNode maps every recorded holder to its node id, dropping ordinals beyond the cap', async () => {
      const { meshOrdinals } = load({
        ordinalHolders: sinon.stub().resolves(new Map([[0, OTHER], [1, ME], [7, THIRD]])),
      });
      const byNode = await meshOrdinals.holdersByNode('app', 3);
      expect([...byNode.entries()].sort()).to.deep.equal([
        [meshOrdinals.nodeIdOf(ME), 1],
        [meshOrdinals.nodeIdOf(OTHER), 0],
      ].sort());
    });
  });

  describe('the return re-probe — back from a partition, the record is not trusted until the committee confirms it', () => {
    it('before any return, ownOrdinal never probes', async () => {
      const { meshOrdinals, seam } = load({ ordinalHolders: sinon.stub().resolves(new Map([[1, ME]])) });
      expect(await meshOrdinals.ownOrdinal('app')).to.equal(1);
      expect(seam.probeOrdinal.callCount).to.equal(0);
    });

    it('after a return, the record\'s answer is probed once; a quorum naming another holder makes this node a standby', async () => {
      const { meshOrdinals, seam } = load({
        ordinalHolders: sinon.stub().resolves(new Map([[1, ME]])),
        probeOrdinal: sinon.stub().resolves({ decided: true, holder: OTHER }),
      });
      meshOrdinals.noteReturnFromUnreachability();
      expect(await meshOrdinals.ownOrdinal('app')).to.equal(null);
      expect(seam.probeOrdinal.args).to.deep.equal([['app', 1]]);
    });

    it('a quorum confirming this node restores the name, and the probe is not repeated until the next return', async () => {
      const { meshOrdinals, seam } = load({
        ordinalHolders: sinon.stub().resolves(new Map([[1, ME]])),
        probeOrdinal: sinon.stub().resolves({ decided: true, holder: ME }),
      });
      meshOrdinals.noteReturnFromUnreachability();
      expect(await meshOrdinals.ownOrdinal('app')).to.equal(1);
      expect(await meshOrdinals.ownOrdinal('app')).to.equal(1);
      expect(seam.probeOrdinal.callCount).to.equal(1);
      meshOrdinals.noteReturnFromUnreachability();
      await meshOrdinals.ownOrdinal('app');
      expect(seam.probeOrdinal.callCount).to.equal(2);
    });

    it('an undecided probe after a return keeps the node a standby, and asks again next pass', async () => {
      const { meshOrdinals, seam } = load({
        ordinalHolders: sinon.stub().resolves(new Map([[1, ME]])),
        probeOrdinal: sinon.stub().resolves({ decided: false, holder: null }),
      });
      meshOrdinals.noteReturnFromUnreachability();
      expect(await meshOrdinals.ownOrdinal('app')).to.equal(null);
      expect(await meshOrdinals.ownOrdinal('app')).to.equal(null);
      expect(seam.probeOrdinal.callCount).to.equal(2);
    });

    it('a record naming nothing of mine needs no probe after a return', async () => {
      const { meshOrdinals, seam } = load();
      meshOrdinals.noteReturnFromUnreachability();
      expect(await meshOrdinals.ownOrdinal('app')).to.equal(null);
      expect(seam.probeOrdinal.callCount).to.equal(0);
    });
  });

  describe('releaseOrdinal', () => {
    it('releases the ordinal the record names me for', async () => {
      const { meshOrdinals, seam } = load({ ordinalHolders: sinon.stub().resolves(new Map([[1, ME]])) });
      expect(await meshOrdinals.releaseOrdinal('app')).to.deep.equal({ released: true, ordinal: 1 });
      expect(seam.releaseOrdinal.args).to.deep.equal([['app', 1]]);
    });

    it('refuses when the record names nothing of mine, and asks the register for nothing', async () => {
      const { meshOrdinals, seam } = load();
      expect(await meshOrdinals.releaseOrdinal('app')).to.deep.equal({ released: false, ordinal: null, reason: 'none_held' });
      expect(seam.releaseOrdinal.callCount).to.equal(0);
    });
  });
});
