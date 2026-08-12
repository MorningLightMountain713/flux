'use strict';

const { expect } = require('chai');

const {
  grantState,
  onProbe,
  onPrepare,
  onAccept,
  onRenew,
  onRelease,
} = require('../../ZelBack/src/services/quorumGrant/grantRegisterCore');

// Fixed clocks: every scenario is arithmetic over these, no Date.now anywhere.
const T0 = 1_000_000;
const TTL = 60_000;
const TUNABLES = { lockDelayMs: 30_000 };

function heldRecord(overrides = {}) {
  return {
    promisedEpoch: 5,
    accepted: {
      epoch: 5,
      grantee: 'aaaa:0',
      mode: 'held',
      fingerprint: 'fp-1',
      expiresAt: T0 + TTL,
      released: false,
      ...overrides.accepted,
    },
    ...('promisedEpoch' in overrides ? { promisedEpoch: overrides.promisedEpoch } : {}),
  };
}

function oneshotRecord() {
  return {
    promisedEpoch: 2,
    accepted: {
      epoch: 2,
      grantee: 'ffff:1',
      mode: 'oneshot',
      fingerprint: 'fp-reg',
      expiresAt: null,
      released: false,
    },
  };
}

describe('quorumGrant grantRegisterCore', () => {
  describe('grantState', () => {
    it('none / active / lapsed / released, by arithmetic alone', () => {
      expect(grantState(null, T0)).to.equal('none');
      expect(grantState({ promisedEpoch: 1 }, T0)).to.equal('none');
      expect(grantState(heldRecord(), T0 + 1)).to.equal('active');
      expect(grantState(heldRecord(), T0 + TTL)).to.equal('active');
      expect(grantState(heldRecord(), T0 + TTL + 1)).to.equal('lapsed');
      expect(grantState(heldRecord({ accepted: { released: true } }), T0)).to.equal('released');
    });

    it('a oneshot record never expires', () => {
      expect(grantState(oneshotRecord(), T0 + 1e12)).to.equal('active');
    });
  });

  describe('prepare', () => {
    it('promises a fresh key and persists the promise', () => {
      const { reply, record } = onPrepare(null, { epoch: 1, candidate: 'bbbb:0' }, T0, TUNABLES);
      expect(reply.ok).to.equal(true);
      expect(reply.promisedEpoch).to.equal(1);
      expect(reply.accepted).to.equal(null);
      expect(record.promisedEpoch).to.equal(1);
    });

    it('refuses an epoch at or below the promise, teaching the promised epoch', () => {
      const base = { promisedEpoch: 7, accepted: null };
      const at = onPrepare(base, { epoch: 7, candidate: 'bbbb:0' }, T0, TUNABLES);
      const below = onPrepare(base, { epoch: 3, candidate: 'bbbb:0' }, T0, TUNABLES);
      expect(at.reply.code).to.equal('superseded');
      expect(below.reply.code).to.equal('superseded');
      expect(below.reply.promisedEpoch).to.equal(7);
      expect(at.record).to.equal(null);
    });

    it('shields a live incumbent from challengers WITHOUT burning the epoch', () => {
      const base = heldRecord();
      const { reply, record } = onPrepare(base, { epoch: 9, candidate: 'cccc:0' }, T0, TUNABLES);
      expect(reply.code).to.equal('incumbent_active');
      expect(record).to.equal(null);
      // the shield must not advance the promise, or probes depose by attrition
      expect(base.promisedEpoch).to.equal(5);
    });

    it('lets the incumbent itself prepare while its term is live', () => {
      const { reply, record } = onPrepare(heldRecord(), { epoch: 6, candidate: 'aaaa:0' }, T0, TUNABLES);
      expect(reply.ok).to.equal(true);
      expect(record.promisedEpoch).to.equal(6);
      expect(reply.accepted.grantee).to.equal('aaaa:0');
    });

    it('holds challengers in lock-delay after an involuntary lapse', () => {
      const lapsedAt = T0 + TTL + 1;
      const { reply, record } = onPrepare(heldRecord(), { epoch: 9, candidate: 'cccc:0' }, lapsedAt, TUNABLES);
      expect(reply.code).to.equal('lock_delay');
      expect(reply.retryAfterMs).to.equal(TUNABLES.lockDelayMs - 1);
      expect(record).to.equal(null);
    });

    it('never delays the recorded grantee — incumbent priority at recovery', () => {
      const lapsedAt = T0 + TTL + 1;
      const { reply } = onPrepare(heldRecord(), { epoch: 9, candidate: 'aaaa:0' }, lapsedAt, TUNABLES);
      expect(reply.ok).to.equal(true);
    });

    it('frees challengers once the lock-delay has run', () => {
      const wellPast = T0 + TTL + TUNABLES.lockDelayMs + 1;
      const { reply } = onPrepare(heldRecord(), { epoch: 9, candidate: 'cccc:0' }, wellPast, TUNABLES);
      expect(reply.ok).to.equal(true);
      // the refusal-free promise still teaches the old record, for adoption
      expect(reply.accepted.grantee).to.equal('aaaa:0');
    });

    it('a released term carries no lock-delay at all', () => {
      const released = heldRecord({ accepted: { released: true } });
      const { reply } = onPrepare(released, { epoch: 9, candidate: 'cccc:0' }, T0 + 1, TUNABLES);
      expect(reply.ok).to.equal(true);
    });

    it('a oneshot record does not shield — prepare answers it for adoption', () => {
      const { reply, record } = onPrepare(oneshotRecord(), { epoch: 8, candidate: 'cccc:0' }, T0, TUNABLES);
      expect(reply.ok).to.equal(true);
      expect(reply.accepted.grantee).to.equal('ffff:1');
      expect(record.promisedEpoch).to.equal(8);
      expect(record.accepted.grantee).to.equal('ffff:1');
    });
  });

  describe('probe — the pre-vote', () => {
    it('answers what prepare would answer and never mutates', () => {
      const fresh = onProbe(null, { epoch: 1, candidate: 'bbbb:0' }, T0, TUNABLES);
      expect(fresh.ok).to.equal(true);
      expect(fresh.probe).to.equal(true);

      const shielded = onProbe(heldRecord(), { epoch: 9, candidate: 'cccc:0' }, T0, TUNABLES);
      expect(shielded.code).to.equal('incumbent_active');
      expect(shielded.probe).to.equal(true);
    });
  });

  describe('accept', () => {
    it('records a held grant, expiry counted from the grantor receipt clock', () => {
      const promised = { promisedEpoch: 3, accepted: null };
      const { reply, record } = onAccept(promised, {
        epoch: 3, grantee: 'bbbb:0', mode: 'held', ttlMs: TTL, fingerprint: 'fp-2',
      }, T0, TUNABLES);
      expect(reply.ok).to.equal(true);
      expect(record.accepted.expiresAt).to.equal(T0 + TTL);
      expect(record.accepted.released).to.equal(false);
      expect(record.promisedEpoch).to.equal(3);
    });

    it('accepts at exactly the promised epoch, refuses below it', () => {
      const promised = { promisedEpoch: 4, accepted: null };
      const at = onAccept(promised, {
        epoch: 4, grantee: 'bbbb:0', mode: 'held', ttlMs: TTL,
      }, T0, TUNABLES);
      const below = onAccept(promised, {
        epoch: 3, grantee: 'bbbb:0', mode: 'held', ttlMs: TTL,
      }, T0, TUNABLES);
      expect(at.reply.ok).to.equal(true);
      expect(below.reply.code).to.equal('superseded');
    });

    it('advances the promise when the accept carries a higher epoch — any rpc advances it', () => {
      const { record } = onAccept({ promisedEpoch: 2, accepted: null }, {
        epoch: 6, grantee: 'bbbb:0', mode: 'held', ttlMs: TTL,
      }, T0, TUNABLES);
      expect(record.promisedEpoch).to.equal(6);
    });

    it('refuses a different grantee while a term is live, even at a higher epoch', () => {
      const { reply, record } = onAccept(heldRecord(), {
        epoch: 9, grantee: 'cccc:0', mode: 'held', ttlMs: TTL,
      }, T0, TUNABLES);
      expect(reply.code).to.equal('incumbent_active');
      expect(record).to.equal(null);
    });

    it('lets the incumbent re-accept its own live seat', () => {
      const { reply, record } = onAccept(heldRecord(), {
        epoch: 6, grantee: 'aaaa:0', mode: 'held', ttlMs: TTL,
      }, T0 + 10, TUNABLES);
      expect(reply.ok).to.equal(true);
      expect(record.accepted.epoch).to.equal(6);
      expect(record.accepted.expiresAt).to.equal(T0 + 10 + TTL);
    });

    it('holds challengers in lock-delay on accept too', () => {
      const lapsedAt = T0 + TTL + 1;
      const { reply } = onAccept(heldRecord(), {
        epoch: 9, grantee: 'cccc:0', mode: 'held', ttlMs: TTL,
      }, lapsedAt, TUNABLES);
      expect(reply.code).to.equal('lock_delay');
    });

    it('a oneshot register is init-only: first write wins forever', () => {
      const first = onAccept({ promisedEpoch: 1, accepted: null }, {
        epoch: 1, grantee: 'ffff:1', mode: 'oneshot', fingerprint: 'fp-reg',
      }, T0, TUNABLES);
      expect(first.reply.ok).to.equal(true);
      expect(first.record.accepted.expiresAt).to.equal(null);

      const rival = onAccept(first.record, {
        epoch: 99, grantee: 'dddd:0', mode: 'oneshot',
      }, T0 + 1, TUNABLES);
      expect(rival.reply.code).to.equal('already_granted');
      expect(rival.reply.accepted.grantee).to.equal('ffff:1');
      expect(rival.record).to.equal(null);
    });

    it('a retried oneshot accept by the same grantee is idempotent, not a second decision', () => {
      const record = oneshotRecord();
      const retry = onAccept(record, {
        epoch: 2, grantee: 'ffff:1', mode: 'oneshot',
      }, T0 + 5, TUNABLES);
      expect(retry.reply.ok).to.equal(true);
      expect(retry.reply.accepted.grantee).to.equal('ffff:1');
      expect(retry.record).to.equal(null);
    });

    it('refuses a mode it does not know', () => {
      const { reply } = onAccept(null, {
        epoch: 1, grantee: 'bbbb:0', mode: 'lease', ttlMs: TTL,
      }, T0, TUNABLES);
      expect(reply.code).to.equal('bad_mode');
    });
  });

  describe('renew', () => {
    it('extends a live term from the grantor receipt clock', () => {
      const { reply, record } = onRenew(heldRecord(), {
        epoch: 5, grantee: 'aaaa:0', ttlMs: TTL,
      }, T0 + 20_000);
      expect(reply.ok).to.equal(true);
      expect(record.accepted.expiresAt).to.equal(T0 + 20_000 + TTL);
    });

    it('a lapsed term renews nothing — the full acquisition path is the way back', () => {
      const { reply, record } = onRenew(heldRecord(), {
        epoch: 5, grantee: 'aaaa:0', ttlMs: TTL,
      }, T0 + TTL + 1);
      expect(reply.code).to.equal('lapsed');
      expect(record).to.equal(null);
    });

    it('refuses the wrong grantee and the wrong epoch alike', () => {
      const wrongWho = onRenew(heldRecord(), { epoch: 5, grantee: 'cccc:0', ttlMs: TTL }, T0);
      const wrongEpoch = onRenew(heldRecord(), { epoch: 4, grantee: 'aaaa:0', ttlMs: TTL }, T0);
      expect(wrongWho.reply.code).to.equal('not_grantee');
      expect(wrongEpoch.reply.code).to.equal('not_grantee');
    });

    it('refuses where there is nothing to renew', () => {
      expect(onRenew(null, { epoch: 1, grantee: 'aaaa:0', ttlMs: TTL }, T0).reply.code).to.equal('no_grant');
      const released = heldRecord({ accepted: { released: true } });
      expect(onRenew(released, { epoch: 5, grantee: 'aaaa:0', ttlMs: TTL }, T0).reply.code).to.equal('no_grant');
      expect(onRenew(oneshotRecord(), { epoch: 2, grantee: 'ffff:1', ttlMs: TTL }, T0).reply.code).to.equal('bad_mode');
    });
  });

  describe('release', () => {
    it('ends the term voluntarily, and the next challenger pays no lock-delay', () => {
      const { reply, record } = onRelease(heldRecord(), { epoch: 5, grantee: 'aaaa:0' }, T0);
      expect(reply.ok).to.equal(true);
      expect(record.accepted.released).to.equal(true);

      const challenger = onPrepare(record, { epoch: 9, candidate: 'cccc:0' }, T0 + 1, TUNABLES);
      expect(challenger.reply.ok).to.equal(true);
    });

    it('is idempotent and forgiving of the never-issued', () => {
      expect(onRelease(null, { epoch: 1, grantee: 'x:0' }, T0).reply.ok).to.equal(true);
      const released = heldRecord({ accepted: { released: true } });
      expect(onRelease(released, { epoch: 5, grantee: 'aaaa:0' }, T0).reply.ok).to.equal(true);
    });

    it('only the grantee at the right epoch may release', () => {
      expect(onRelease(heldRecord(), { epoch: 5, grantee: 'cccc:0' }, T0).reply.code).to.equal('not_grantee');
      expect(onRelease(heldRecord(), { epoch: 4, grantee: 'aaaa:0' }, T0).reply.code).to.equal('not_grantee');
      expect(onRelease(oneshotRecord(), { epoch: 2, grantee: 'ffff:1' }, T0).reply.code).to.equal('bad_mode');
    });
  });

  describe('epoch monotonicity — the property everything hangs off', () => {
    it('no operation sequence ever lowers the promised epoch', () => {
      let record = null;
      let highWater = 0;
      const steps = [
        (r) => onPrepare(r, { epoch: 1, candidate: 'a:0' }, T0, TUNABLES),
        (r) => onAccept(r, {
          epoch: 1, grantee: 'a:0', mode: 'held', ttlMs: TTL,
        }, T0 + 1, TUNABLES),
        (r) => onRenew(r, { epoch: 1, grantee: 'a:0', ttlMs: TTL }, T0 + 2),
        (r) => onPrepare(r, { epoch: 4, candidate: 'a:0' }, T0 + 3, TUNABLES),
        (r) => onAccept(r, {
          epoch: 4, grantee: 'a:0', mode: 'held', ttlMs: TTL,
        }, T0 + 4, TUNABLES),
        (r) => onRelease(r, { epoch: 4, grantee: 'a:0' }, T0 + 5),
        (r) => onPrepare(r, { epoch: 2, candidate: 'b:0' }, T0 + 6, TUNABLES),
        (r) => onPrepare(r, { epoch: 9, candidate: 'b:0' }, T0 + 7, TUNABLES),
        (r) => onAccept(r, {
          epoch: 9, grantee: 'b:0', mode: 'held', ttlMs: TTL,
        }, T0 + 8, TUNABLES),
      ];
      steps.forEach((step) => {
        const outcome = step(record);
        if (outcome.record) ({ record } = outcome);
        expect(record.promisedEpoch).to.be.at.least(highWater);
        highWater = record.promisedEpoch;
      });
      expect(highWater).to.equal(9);
    });
  });
});
