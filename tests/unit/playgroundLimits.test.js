'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

const CONFIG = {
  fluxapps: {
    playgroundSessionCpu: 2,
    playgroundSessionMemoryMb: 4096,
    playgroundSessionRootFsGb: 10,
    playgroundSessionImageMaxBytes: 2e9,
    playgroundNodeSessionsPerHour: 2,
    playgroundCallerSessionsPerHour: 3,
    playgroundWindowMs: 3600000,
  },
};

function loadLimits() {
  return proxyquire.load('../../ZelBack/src/services/appPlayground/playgroundLimits', {
    config: CONFIG,
  });
}

function totals(overrides = {}) {
  return {
    cpu: 1,
    memoryMb: 1024,
    storageGb: 0,
    rootFsGb: 4,
    swapGb: 0,
    hostDiskGb: 4,
    componentCount: 1,
    ...overrides,
  };
}

describe('playgroundLimits', () => {
  let limits;

  beforeEach(() => {
    limits = loadLimits();
    limits.reset();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('ceilingShortfall', () => {
    it('admits a spec inside every dimension', () => {
      expect(limits.ceilingShortfall(totals())).to.equal(null);
    });

    it('admits a spec sitting exactly on the ceiling', () => {
      const onTheLine = totals({
        cpu: 2, memoryMb: 4096, rootFsGb: 10, componentCount: 3,
      });
      expect(limits.ceilingShortfall(onTheLine)).to.equal(null);
    });

    // The ceiling is an admission filter, never a degrade: the whole point of
    // replacing testappinstall is that a spec runs at what it declares or not at
    // all, so a refusal has to hand back both numbers for the owner to act on.
    it('refuses too much cpu, naming the asked-for and allowed figures', () => {
      const reason = limits.ceilingShortfall(totals({ cpu: 4 }));
      expect(reason).to.be.a('string');
      expect(reason).to.include('4');
      expect(reason).to.include('2');
    });

    it('refuses too much memory, naming both figures', () => {
      const reason = limits.ceilingShortfall(totals({ memoryMb: 8192 }));
      expect(reason).to.include('8192');
      expect(reason).to.include('4096');
    });

    it('refuses too much rootFs, naming both figures', () => {
      const reason = limits.ceilingShortfall(totals({ rootFsGb: 40 }));
      expect(reason).to.include('40');
      expect(reason).to.include('10');
    });

    // No component check any more: a five-component app that fits the resource
    // ceiling costs this node exactly what a one-component app using the same
    // costs it. Pull bandwidth was the real concern and the runner bounds that
    // with an aggregate image budget instead.
    it('admits a many-component spec that fits every resource dimension', () => {
      expect(limits.ceilingShortfall(totals({ componentCount: 8 }))).to.equal(null);
    });

    it('refuses any swap, and says how to make the spec runnable', () => {
      const reason = limits.ceilingShortfall(totals({ swapGb: 1 }));
      expect(reason).to.include('swap');
      expect(reason).to.include('0');
    });

    it('refuses any persistent storage, and says how to make the spec runnable', () => {
      const reason = limits.ceilingShortfall(totals({ storageGb: 5 }));
      expect(reason).to.include('persistent storage');
      expect(reason).to.include('0');
    });

    // resourceTotals() returns null for a sealed v8 spec - "cannot tell", not
    // zero. Admitting on that is how a ceiling silently stops being one.
    it('refuses a spec whose resources cannot be read, rather than admitting it', () => {
      const reason = limits.ceilingShortfall(null);
      expect(reason).to.be.a('string');
      expect(reason).to.include('cannot measure');
    });
  });

  describe('RollingWindow', () => {
    it('allows up to the limit and then refuses', () => {
      const window = new limits.RollingWindow(2);
      expect(window.consume('k').allowed).to.equal(true);
      expect(window.consume('k').allowed).to.equal(true);
      expect(window.consume('k').allowed).to.equal(false);
    });

    it('reports how long until the next slot exists', () => {
      const window = new limits.RollingWindow(1);
      window.consume('k');
      const refused = window.consume('k');
      expect(refused.allowed).to.equal(false);
      expect(refused.retryAfterMs).to.be.greaterThan(0);
      expect(refused.retryAfterMs).to.be.at.most(3600000);
    });

    it('counts each key independently', () => {
      const window = new limits.RollingWindow(1);
      expect(window.consume('a').allowed).to.equal(true);
      expect(window.consume('b').allowed).to.equal(true);
      expect(window.consume('a').allowed).to.equal(false);
    });

    it('frees a slot again once refunded', () => {
      const window = new limits.RollingWindow(1);
      window.consume('k');
      expect(window.consume('k').allowed).to.equal(false);
      window.refund('k');
      expect(window.consume('k').allowed).to.equal(true);
    });

    it('ignores a refund for a key that holds nothing', () => {
      const window = new limits.RollingWindow(1);
      expect(() => window.refund('never-seen')).to.not.throw();
      expect(window.consume('never-seen').allowed).to.equal(true);
    });

    // Entries age out on the monotonic clock. A wall-clock window would hand
    // back the whole allowance to anyone who could move the node's clock, and
    // would step backwards on its own over an NTP correction.
    it('ages entries out of the window', () => {
      const window = new limits.RollingWindow(1);
      const base = process.hrtime.bigint();
      const clock = sinon.stub(process.hrtime, 'bigint');

      clock.returns(base);
      expect(window.consume('k').allowed).to.equal(true);
      expect(window.consume('k').allowed).to.equal(false);

      // One hour and a second later, the first hit is outside the window.
      clock.returns(base + 3601n * 1_000_000_000n);
      expect(window.consume('k').allowed).to.equal(true);
    });
  });

  describe('consumeSessionSlot', () => {
    it('allows a caller within both windows', () => {
      const slot = limits.consumeSessionSlot('zelid1', '1.2.3.4');
      expect(slot.allowed).to.equal(true);
      expect(slot.scope).to.equal(null);
    });

    it('refuses once the node has run its sessions for the hour', () => {
      limits.consumeSessionSlot('zelid1', '1.2.3.4');
      limits.consumeSessionSlot('zelid2', '5.6.7.8');

      const third = limits.consumeSessionSlot('zelid3', '9.9.9.9');
      expect(third.allowed).to.equal(false);
      expect(third.scope).to.equal('node');
      // The node limit is identity-blind on purpose: it is the security wall,
      // and it must not be escapable by minting another FluxID.
      expect(third.message).to.include('node');
    });

    // The node slot is taken first to check capacity, so a caller refused on
    // their OWN limit must not silently consume one of the node's - otherwise
    // one caller hammering their limit exhausts the node's for everybody.
    it('gives the node slot back when the caller is the one over their limit', () => {
      const caller = loadLimits();
      caller.reset();

      const cfg = { ...CONFIG, fluxapps: { ...CONFIG.fluxapps, playgroundCallerSessionsPerHour: 1, playgroundNodeSessionsPerHour: 5 } };
      const scoped = proxyquire.load('../../ZelBack/src/services/appPlayground/playgroundLimits', { config: cfg });
      scoped.reset();

      expect(scoped.consumeSessionSlot('zelid1', '1.2.3.4').allowed).to.equal(true);

      const refused = scoped.consumeSessionSlot('zelid1', '1.2.3.4');
      expect(refused.allowed).to.equal(false);
      expect(refused.scope).to.equal('caller');

      // Four node slots must remain, not three: the refused attempt cost the
      // node nothing because no session ran.
      for (let i = 0; i < 4; i += 1) {
        expect(scoped.consumeSessionSlot(`other${i}`, `10.0.0.${i}`).allowed).to.equal(true);
      }
    });

    it('keys the caller limit on FluxID and address together', () => {
      expect(limits.callerKey('zelid1', '1.2.3.4')).to.not.equal(limits.callerKey('zelid1', '5.6.7.8'));
      expect(limits.callerKey('zelid1', '1.2.3.4')).to.not.equal(limits.callerKey('zelid2', '1.2.3.4'));
    });

    it('treats a missing address as its own bucket rather than throwing', () => {
      expect(limits.callerKey('zelid1', null)).to.equal('zelid1|');
    });
  });
});
