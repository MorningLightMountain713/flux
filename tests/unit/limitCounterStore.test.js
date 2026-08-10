'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('limitCounterStore tests', () => {
  let store;

  function load(opts = {}) {
    return proxyquire('../../ZelBack/src/services/utils/limitCounterStore', {
      config: {
        fluxapps: {
          limitCounters: {
            playground: {
              maxConcurrent: opts.maxConcurrent ?? 1,
              maxPerWindow: opts.maxPerWindow ?? 5,
              windowMs: opts.windowMs ?? 86400000,
            },
          },
          limitCounterLeaseMs: opts.leaseMs ?? 1800000,
        },
      },
      '../../lib/log': {
        info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
      },
    });
  }

  beforeEach(() => { store = load(); });
  afterEach(() => { store.reset(); sinon.restore(); });

  // Keys arrive hashed; any stable string stands in for one here.
  const K = 'key-1Caller';
  const take = () => store.reserve('playground', K);

  describe('reserve', () => {
    it('admits the first ask and hands back a token', () => {
      const r = take();

      expect(r.allowed).to.be.true;
      expect(r.token).to.be.a('string').with.length.greaterThan(0);
    });

    it('refuses a second simultaneous ask — the increment happens before the answer', () => {
      // The property the whole design rests on. A version that answered "you have
      // N left" and let the caller act would admit two askers who both read N.
      take();
      const second = take();

      expect(second.allowed).to.be.false;
      expect(second.reason).to.equal('concurrent');
    });

    it('admits up to the configured concurrency and no further', () => {
      store = load({ maxConcurrent: 3 });

      const verdicts = [take(), take(), take(), take()].map((r) => r.allowed);

      expect(verdicts).to.deep.equal([true, true, true, false]);
    });

    it('counts different callers separately', () => {
      store.reserve('playground', 'key-A');
      const other = store.reserve('playground', 'key-B');

      expect(other.allowed).to.be.true;
    });

    it('counts different keys separately — the axis and purpose are inside the key', () => {
      store.reserve('playground', 'key-identity-X');
      const byAddress = store.reserve('playground', 'key-address-X');

      expect(byAddress.allowed).to.be.true;
    });

    it('counts the same caller separately per purpose', () => {
      store.reserve('playground', 'key-identity-X');
      const other = store.reserve('somethingElse', 'key-other-X');

      expect(other.allowed).to.be.true;
    });

    it('refuses once the window allowance is spent, even with nothing running', () => {
      store = load({ maxConcurrent: 1, maxPerWindow: 2 });

      const first = take();
      store.release('playground', K, first.token);
      const second = take();
      store.release('playground', K, second.token);
      const third = take();

      expect(third.allowed).to.be.false;
      expect(third.reason).to.equal('window');
    });

    it('takes its limits from this node, never from the asker', () => {
      // A caller's own node proposing the limit it should be held to is not a
      // limit. reserve() accepts no limit argument at all — this asserts the shape.
      expect(store.reserve.length).to.equal(2);
      expect(store.limitsFor('playground')).to.include({ maxConcurrent: 1, maxPerWindow: 5 });
    });

    it('falls back to defaults for a purpose nobody configured', () => {
      expect(store.limitsFor('unconfigured')).to.include({ maxConcurrent: 1, maxPerWindow: 5 });
    });
  });

  describe('release', () => {
    it('frees the concurrency slot', () => {
      const first = take();
      store.release('playground', K, first.token);

      expect(take().allowed).to.be.true;
    });

    it('does NOT give back the window allowance', () => {
      // A session that ran and ended still happened. Un-counting completed work
      // would let a caller cycle through the window forever.
      store = load({ maxConcurrent: 1, maxPerWindow: 1 });
      const first = take();
      store.release('playground', K, first.token);

      const second = take();
      expect(second.allowed).to.be.false;
      expect(second.reason).to.equal('window');
    });

    it('ignores a token it never issued', () => {
      take();
      expect(store.release('playground', K, 'made-up')).to.be.false;
    });

    it('ignores a release for a key it holds nothing for', () => {
      expect(store.release('playground', 'key-nobody', 'x')).to.be.false;
    });
  });

  describe('lease expiry', () => {
    it('frees a slot whose lease ran out, so a dead submitter cannot lock a caller out', () => {
      const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['hrtime'] });
      store = load({ leaseMs: 1000 });
      take();
      expect(take().allowed, 'still held while the lease is live').to.be.false;

      clock.tick(1500);

      expect(take().allowed, 'freed once the lease expired').to.be.true;
      clock.restore();
    });
  });

  describe('adoptWindowUsage', () => {
    it('takes on a count this node never saw', () => {
      // What a counter does after a restart, or when a key moves to it because the
      // previous counter left the network.
      store = load({ maxConcurrent: 1, maxPerWindow: 3 });
      store.adoptWindowUsage('playground', K, 3);

      const r = take();
      expect(r.allowed).to.be.false;
      expect(r.reason).to.equal('window');
    });

    it('never lowers a count it already holds', () => {
      // A record arriving from elsewhere can only mean MORE has been used than
      // this node knows about, never less.
      store = load({ maxConcurrent: 5, maxPerWindow: 5 });
      take();
      take();

      expect(store.adoptWindowUsage('playground', K, 1)).to.equal(2);
    });
  });

  describe('sweep', () => {
    it('keeps a key still carrying usage in the current window', () => {
      // Dropping it would hand the caller their whole daily allowance back, which
      // is the bug the tally exists to prevent. Idle is not the same as spent.
      store = load({ maxConcurrent: 1, maxPerWindow: 1 });
      const first = take();
      store.release('playground', K, first.token);

      store.sweep();

      const second = take();
      expect(second.allowed).to.be.false;
      expect(second.reason).to.equal('window');
    });

    it('drops a key whose window has rolled over', () => {
      const clock = sinon.useFakeTimers({ now: 1_000_000_000_000, toFake: ['Date', 'hrtime'] });
      store = load({ windowMs: 1000 });
      const first = take();
      store.release('playground', K, first.token);

      clock.tick(2000);

      expect(store.sweep()).to.be.greaterThan(0);
      clock.restore();
    });

    it('keeps a key with a live lease', () => {
      take();
      store.sweep();

      expect(take().allowed, 'the live lease survived the sweep').to.be.false;
    });
  });
});
