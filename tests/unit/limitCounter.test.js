const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('limitCounter tests', () => {
  let stubs;
  let limitCounter;

  // Real outpoints, so the ranking runs the actual hash rather than a shadow of it.
  const node = (n) => ({ txhash: `${n}`.repeat(64).slice(0, 64), outidx: '0', ip: `10.0.0.${n}:16127` });
  const FLEET = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(node);

  function load(opts = {}) {
    stubs = {
      deterministicFluxList: sinon.stub().resolves(opts.nodes ?? FLEET),
      obtainNodeCollateralInformation: sinon.stub().resolves(
        opts.collateral ?? { txhash: 'not-in-the-list', txindex: 0 },
      ),
    };
    return proxyquire('../../ZelBack/src/services/utils/limitCounter', {
      '../fluxCommunicationUtils': { deterministicFluxList: stubs.deterministicFluxList },
      '../generalService': { obtainNodeCollateralInformation: stubs.obtainNodeCollateralInformation },
    });
  }

  afterEach(() => sinon.restore());

  describe('countersFor', () => {
    it('gives every node the same counter for the same key', async () => {
      // The whole design rests on this: a counter that had to be agreed could be
      // disagreed about, and then a caller has two counters and twice the allowance.
      limitCounter = load();
      const a = await limitCounter.countersFor('playground', 'identity', '1CallerZelId');
      const b = await limitCounter.countersFor('playground', 'identity', '1CallerZelId');

      expect(a.counter.txhash).to.equal(b.counter.txhash);
      expect(a.deputy.txhash).to.equal(b.deputy.txhash);
    });

    it('gives different callers different counters', async () => {
      limitCounter = load();
      const counters = await Promise.all(
        ['1Aaa', '1Bbb', '1Ccc', '1Ddd', '1Eee'].map(
          (id) => limitCounter.countersFor('playground', 'identity', id).then((r) => r.counter.txhash),
        ),
      );

      expect(new Set(counters).size).to.be.greaterThan(1);
    });

    // Asserted across a spread of callers rather than one: with a fleet this size
    // two keys land on the same top node about one time in nine, so a single
    // comparison would fail on chance rather than on a defect.
    const CALLERS = ['1Aaa', '1Bbb', '1Ccc', '1Ddd', '1Eee', '1Fff', '1Ggg', '1Hhh'];

    async function countersAcross(purpose, axis) {
      return Promise.all(CALLERS.map(
        (id) => limitCounter.countersFor(purpose, axis, id).then((r) => r.counter.txhash),
      ));
    }

    it('puts the purpose in the key, so one counter outage cannot take every limit', async () => {
      limitCounter = load();
      const playground = await countersAcross('playground', 'identity');
      const other = await countersAcross('somethingElse', 'identity');

      expect(playground).to.not.deep.equal(other);
    });

    it('puts the axis in the key, so a caller is counted separately per axis', async () => {
      limitCounter = load();
      const byIdentity = await countersAcross('playground', 'identity');
      const byAddress = await countersAcross('playground', 'address');

      expect(byIdentity).to.not.deep.equal(byAddress);
    });

    it('never picks the counter as its own deputy', async () => {
      limitCounter = load();
      const { counter, deputy } = await limitCounter.countersFor('playground', 'identity', '1CallerZelId');

      expect(counter.txhash).to.not.equal(deputy.txhash);
    });

    it('answers with nulls rather than throwing when the node list is empty', async () => {
      limitCounter = load({ nodes: [] });

      expect(await limitCounter.countersFor('playground', 'identity', 'X'))
        .to.deep.equal({ counter: null, deputy: null });
    });

    it('has a deputy of null on a one-node network', async () => {
      limitCounter = load({ nodes: [node(1)] });
      const { counter, deputy } = await limitCounter.countersFor('playground', 'identity', 'X');

      expect(counter).to.not.be.null;
      expect(deputy).to.be.null;
    });

    it('does not filter the pool by tier — a counter counts, it does not run the work', async () => {
      // Deliberate: a node that cannot perform the work is still a good counter, so
      // no capability question enters a decision that must be identical everywhere.
      limitCounter = load({ nodes: FLEET.map((n) => ({ ...n, tier: 'CUMULUS' })) });
      const { counter } = await limitCounter.countersFor('playground', 'identity', 'X');

      expect(counter).to.not.be.null;
    });
  });

  describe('localRole', () => {
    async function roleWhenSelfIs(which) {
      limitCounter = load();
      const { counter, deputy } = await limitCounter.countersFor('playground', 'identity', '1CallerZelId');
      const self = which === 'counter' ? counter : deputy;
      limitCounter = load({ collateral: { txhash: self.txhash, txindex: self.outidx } });
      return limitCounter.localRole('playground', 'identity', '1CallerZelId');
    }

    it('reports counter when this node is the counter', async () => {
      expect(await roleWhenSelfIs('counter')).to.equal('counter');
    });

    it('reports deputy when this node is the deputy', async () => {
      expect(await roleWhenSelfIs('deputy')).to.equal('deputy');
    });

    it('reports null for a node that is neither', async () => {
      limitCounter = load();
      expect(await limitCounter.localRole('playground', 'identity', '1CallerZelId')).to.be.null;
    });

    it('reports null when the node list is empty', async () => {
      limitCounter = load({ nodes: [] });
      expect(await limitCounter.localRole('playground', 'identity', 'X')).to.be.null;
    });

    it('matches an outidx that arrives as a string against a numeric txindex', async () => {
      // The daemon hands outidx back as a string despite the typedef; comparing
      // them numerically would make a node fail to recognise itself.
      limitCounter = load();
      const { counter } = await limitCounter.countersFor('playground', 'identity', '1CallerZelId');
      limitCounter = load({ collateral: { txhash: counter.txhash, txindex: 0 } });

      expect(await limitCounter.localRole('playground', 'identity', '1CallerZelId')).to.equal('counter');
    });
  });
});
