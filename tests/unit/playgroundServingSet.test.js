const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

const CONFIG = {
  fluxapps: {
    playgroundServingSetSize: 4,
    playgroundServingSetWindowMs: 86400000,
  },
};

// The node list's own spelling: upper case, and NOT the daemon's legacy
// basic/super/bamf. outidx arrives as a STRING despite the typedef.
const node = (n, tier = 'NIMBUS') => ({
  txhash: `hash${n}`,
  outidx: '0',
  ip: `10.0.0.${n}:16127`,
  tier,
});

describe('playgroundServingSet', () => {
  let stubs;

  function load(opts = {}) {
    stubs = {
      list: sinon.stub().resolves(opts.nodes ?? Array.from({ length: 40 }, (_, i) => node(i))),
      collateral: sinon.stub().resolves(opts.collateral ?? { txhash: 'hash0', txindex: 0 }),
      warn: sinon.stub(),
    };
    return proxyquire.load('../../ZelBack/src/services/appPlayground/playgroundServingSet', {
      config: opts.config ?? CONFIG,
      '../../lib/log': { info: sinon.stub(), warn: stubs.warn, error: sinon.stub() },
      '../fluxCommunicationUtils': { deterministicFluxList: stubs.list },
      '../generalService': { obtainNodeCollateralInformation: stubs.collateral },
    });
  }

  afterEach(() => sinon.restore());

  describe('servingSet', () => {
    it('returns exactly the configured number of nodes', async () => {
      const set = await load().servingSet({ fluxId: 'zelid1' });
      expect(set.length).to.equal(4);
    });

    // The whole point: every node computes the same answer from data it already
    // has, so a node outside the set refuses without asking anyone.
    it('is the same set whoever computes it', async () => {
      const a = await load().servingSet({ fluxId: 'zelid1' });
      const b = await load().servingSet({ fluxId: 'zelid1' });
      expect(a.map((x) => x.txhash)).to.deep.equal(b.map((x) => x.txhash));
    });

    it('gives different callers different sets', async () => {
      const mine = (await load().servingSet({ fluxId: 'zelid1' })).map((x) => x.txhash);
      const theirs = (await load().servingSet({ fluxId: 'zelid2' })).map((x) => x.txhash);
      expect(mine).to.not.deep.equal(theirs);
    });

    it('moves a caller to a different set in a different window', async () => {
      const set = load();
      const today = (await set.servingSet({ fluxId: 'zelid1' }, { now: 0 })).map((x) => x.txhash);
      const tomorrow = (await set.servingSet({ fluxId: 'zelid1' }, { now: 86400000 })).map((x) => x.txhash);
      expect(today).to.not.deep.equal(tomorrow);
    });

    // Tier is chain data, so every node can compute it for every other node.
    // Arcane deliberately is NOT filtered — it is an attestation, and a set that
    // cannot be computed identically everywhere is not a set.
    it('only ever picks nodes that could run a session', async () => {
      const nodes = [
        ...Array.from({ length: 10 }, (_, i) => node(i, 'CUMULUS')),
        ...Array.from({ length: 6 }, (_, i) => node(100 + i, 'STRATUS')),
      ];
      const set = await load({ nodes }).servingSet({ fluxId: 'zelid1' });
      expect(set.every((n) => n.tier === 'STRATUS')).to.equal(true);
    });

    it('matches the tier however it is cased', async () => {
      const nodes = Array.from({ length: 6 }, (_, i) => node(i, 'nimbus'));
      expect((await load({ nodes }).servingSet({ fluxId: 'zelid1' })).length).to.equal(4);
    });

    it('returns everything eligible when there is less than a full set', async () => {
      const nodes = Array.from({ length: 2 }, (_, i) => node(i));
      expect((await load({ nodes }).servingSet({ fluxId: 'zelid1' })).length).to.equal(2);
    });

    // Rendezvous hashing's whole point: removing a node moves only its own share
    // of the mapping, so a node whose list is a block stale computes almost the
    // same set. That is what makes the skew between nodes tolerable.
    it('barely moves when one node leaves the network', async () => {
      const nodes = Array.from({ length: 40 }, (_, i) => node(i));
      const before = (await load({ nodes }).servingSet({ fluxId: 'zelid1' })).map((x) => x.txhash);
      const after = (await load({ nodes: nodes.slice(1) }).servingSet({ fluxId: 'zelid1' })).map((x) => x.txhash);

      const kept = before.filter((h) => after.includes(h));
      expect(kept.length, 'most of the set survives a membership change').to.be.at.least(3);
    });
  });

  describe('servesLocalNode', () => {
    it('says yes when this node is in the set, and names the others', async () => {
      const set = load();
      const chosen = await set.servingSet({ fluxId: 'zelid1' });
      const mine = load({ collateral: { txhash: chosen[0].txhash, txindex: 0 } });

      const verdict = await mine.servesLocalNode({ fluxId: 'zelid1' });
      expect(verdict.serves).to.equal(true);
      expect(verdict.candidates).to.include(chosen[0].ip);
    });

    it('says no when this node is not, and still names where to go', async () => {
      const set = load();
      const chosen = (await set.servingSet({ fluxId: 'zelid1' })).map((x) => x.txhash);
      const outsider = Array.from({ length: 40 }, (_, i) => `hash${i}`)
        .find((h) => !chosen.includes(h));

      const verdict = await load({ collateral: { txhash: outsider, txindex: 0 } })
        .servesLocalNode({ fluxId: 'zelid1' });

      expect(verdict.serves).to.equal(false);
      expect(verdict.candidates.length, 'a refusal can say which nodes do').to.equal(4);
    });

    // Admitting on an unanswered question is how a bound stops being one.
    it('refuses when the node cannot identify itself', async () => {
      const mine = load();
      stubs.collateral.rejects(new Error('daemon down'));
      expect((await mine.servesLocalNode({ fluxId: 'zelid1' })).serves).to.equal(false);
    });

    it('refuses when the node list cannot be read', async () => {
      const mine = load();
      stubs.list.rejects(new Error('network state not started'));
      expect((await mine.servesLocalNode({ fluxId: 'zelid1' })).serves).to.equal(false);
    });

    it('refuses when no node on the network could serve anyone', async () => {
      const nodes = Array.from({ length: 10 }, (_, i) => node(i, 'CUMULUS'));
      expect((await load({ nodes }).servesLocalNode({ fluxId: 'zelid1' })).serves).to.equal(false);
    });

    // The daemon reports outidx as a string; the collateral read reports txindex
    // as a number. A strict compare between them is always false, which would
    // make every node believe it is outside every set.
    it('matches its own outpoint across the string/number split', async () => {
      const nodes = [{ ...node(0), outidx: '3' }];
      const verdict = await load({ nodes, collateral: { txhash: 'hash0', txindex: 3 } })
        .servesLocalNode({ fluxId: 'zelid1' });
      expect(verdict.serves).to.equal(true);
    });
  });

  describe('the address axis', () => {
    const on = { fluxapps: { ...CONFIG.fluxapps, playgroundServingSetAddressAxis: true } };
    // A browser reaches a node through FDM, so the socket peer is the load
    // balancer. Enforcing this before FDM forwards the client address would map
    // every caller onto one set and take the feature down for everyone else.
    it('is off unless explicitly turned on', () => {
      expect(load().addressAxisEnabled()).to.equal(false);
    });

    it('stays off when the config says anything other than true', () => {
      const cfg = { fluxapps: { ...CONFIG.fluxapps, playgroundServingSetAddressAxis: 'yes' } };
      expect(load({ config: cfg }).addressAxisEnabled()).to.equal(false);
    });

    it('turns on only for a literal true', () => {
      const cfg = { fluxapps: { ...CONFIG.fluxapps, playgroundServingSetAddressAxis: true } };
      expect(load({ config: cfg }).addressAxisEnabled()).to.equal(true);
    });

    it('scores an address differently from an identity of the same value', async () => {
      // Same value on both axes, so only the axis itself can separate them.
      const byIdentity = (await load().servingSet({ fluxId: 'x', sourceIp: 'x' })).map((n) => n.txhash);
      const byAddress = (await load({ config: on }).servingSet({ fluxId: 'x', sourceIp: 'x' }))
        .map((n) => n.txhash);
      expect(byIdentity).to.not.deep.equal(byAddress);
    });
  });

  // The set bounds a burst, so it keys on the thing a burster cannot cheaply
  // change. Minting a FluxID is free; an address is not.
  describe('which axis a caller is pinned on', () => {
    const on = { fluxapps: { ...CONFIG.fluxapps, playgroundServingSetAddressAxis: true } };
    const CALLER = '198.51.100.23';

    it('keys on the address when the axis is on', () => {
      expect(load({ config: on }).axisFor({ fluxId: 'zelid1', sourceIp: CALLER }))
        .to.deep.equal({ axis: 'address', value: CALLER });
    });

    it('keys on the identity when the axis is off', () => {
      expect(load().axisFor({ fluxId: 'zelid1', sourceIp: CALLER }))
        .to.deep.equal({ axis: 'identity', value: 'zelid1' });
    });

    it('falls back to identity when no address resolved', () => {
      expect(load({ config: on }).axisFor({ fluxId: 'zelid1', sourceIp: null }))
        .to.deep.equal({ axis: 'identity', value: 'zelid1' });
    });

    it('gives one address the same set however many FluxIDs it mints', async () => {
      const set = load({ config: on });
      const first = (await set.servingSet({ fluxId: 'zelid1', sourceIp: CALLER })).map((n) => n.txhash);
      const second = (await set.servingSet({ fluxId: 'zelid2', sourceIp: CALLER })).map((n) => n.txhash);
      const third = (await set.servingSet({ fluxId: 'zelid3', sourceIp: CALLER })).map((n) => n.txhash);
      expect(second).to.deep.equal(first);
      expect(third).to.deep.equal(first);
    });

    it('gives two addresses different sets', async () => {
      const set = load({ config: on });
      const mine = (await set.servingSet({ fluxId: 'zelid1', sourceIp: CALLER })).map((n) => n.txhash);
      const theirs = (await set.servingSet({ fluxId: 'zelid1', sourceIp: '198.51.100.24' })).map((n) => n.txhash);
      expect(theirs).to.not.deep.equal(mine);
    });

    // The switch changes the key, never the size - a node with it off still
    // serves every caller, which is what makes it safe to turn on partway.
    it('is the same size on either axis', async () => {
      const byIdentity = await load().servingSet({ fluxId: 'zelid1', sourceIp: CALLER });
      const byAddress = await load({ config: on }).servingSet({ fluxId: 'zelid1', sourceIp: CALLER });
      expect(byAddress.length).to.equal(byIdentity.length);
      expect(byAddress.length).to.equal(CONFIG.fluxapps.playgroundServingSetSize);
    });
  });
});
