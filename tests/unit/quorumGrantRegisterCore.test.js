'use strict';

const { expect } = require('chai');

const {
  grantState,
  onProbe,
  onPrepare,
  onAccept,
  onRenew,
  onRoster,
  onRelease,
} = require('../../ZelBack/src/services/quorumGrant/grantRegisterCore');
const rosterOverlay = require('../../ZelBack/src/services/quorumGrant/rosterOverlay');
const { selectCommittee } = require('../../ZelBack/src/services/utils/committeeSelector');

// Fixed clocks: every scenario is arithmetic over these, no Date.now anywhere.
const T0 = 1_000_000;
const TTL = 60_000;
const TUNABLES = { lockDelayMs: 30_000, maxTtlMs: 300_000 };

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

    it('stamps every promise with its instant — freshness is what revival yields to', () => {
      const { record } = onPrepare(null, { epoch: 3, candidate: 'bbbb:0' }, T0, TUNABLES);
      expect(record.promisedEpoch).to.equal(3);
      expect(record.promisedAt).to.equal(T0);
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

    it('the recorded grantee revives its own lapsed, unsuperseded term', () => {
      // How a restarted referee's cell rejoins the renewal quorum: its record
      // lapsed while the process was down, though the term lived on the other
      // cells. Safe by intersection - any successor needed a quorum that did
      // not include this sleeping cell.
      const at = T0 + TTL + 1;
      const { reply, record } = onRenew(heldRecord(), {
        epoch: 5, grantee: 'aaaa:0', ttlMs: TTL,
      }, at);
      expect(reply.ok).to.equal(true);
      expect(record.accepted.expiresAt).to.equal(at + TTL);
    });

    it('a lapsed term with a takeover in flight renews nothing - the revival yields', () => {
      // in flight = the promise is FRESH: stamped within the lock-delay of
      // this renewal's receipt
      const contested = { ...heldRecord({ promisedEpoch: 6 }), promisedAt: T0 + TTL - 1_000 };
      const { reply, record } = onRenew(contested, {
        epoch: 5, grantee: 'aaaa:0', ttlMs: TTL,
      }, T0 + TTL + 1, TUNABLES);
      expect(reply.code).to.equal('lapsed');
      expect(record).to.equal(null);
    });

    it('a stale promise cannot block revival — the ratchet unwinds past the lock-delay', () => {
      // The 1205 fight's other half: a promise nothing ever completed used to
      // block the recorded grantee's revival FOREVER. A pursuit that was going
      // to win completed inside the lock-delay; past it, the promise is a
      // residue, not a takeover.
      const at = T0 + TTL + 1;
      const residue = { ...heldRecord({ promisedEpoch: 6 }), promisedAt: at - TUNABLES.lockDelayMs - 1 };
      const { reply, record } = onRenew(residue, {
        epoch: 5, grantee: 'aaaa:0', ttlMs: TTL,
      }, at, TUNABLES);
      expect(reply.ok).to.equal(true);
      expect(record.accepted.expiresAt).to.equal(at + TTL);
    });

    it('a promise of unknown age does not block revival', () => {
      // pre-stamp journals: an unstamped promise cannot prove a takeover is
      // in flight, and permanent refusal is the ratchet being guarded against
      const unstamped = heldRecord({ promisedEpoch: 6 });
      const { reply } = onRenew(unstamped, {
        epoch: 5, grantee: 'aaaa:0', ttlMs: TTL,
      }, T0 + TTL + 1, TUNABLES);
      expect(reply.ok).to.equal(true);
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

  describe('roster', () => {
    // A fleet whose committee the tests derive with the same walk the code
    // runs; signatures never reach the core (the shell verifies carried
    // chains first), so plain distinct pubkeys are enough here.
    const KEY = 'myapp/master';
    const WALK_KEY = rosterOverlay.walkKeyFor(KEY, 0);
    const SIZE = 5;
    const membership = Array.from({ length: 10 }, (unused, i) => ({
      txhash: String(i + 1).padStart(2, '0').repeat(32),
      outidx: 0,
      pubkey: `owner-${i + 1}`,
      ip: `10.${i + 1}.0.1:16127`,
    }));
    const base = selectCommittee(membership, WALK_KEY, { size: SIZE });

    const outpoint = (node) => `${node.txhash}:${node.outidx}`;

    function linkAtop(seq, roster, excluded) {
      const remove = roster[0];
      const survivors = roster.filter((node) => node !== remove);
      const nextExcluded = new Set([...excluded, outpoint(remove)]);
      const added = rosterOverlay.nextReplacement(membership, WALK_KEY, survivors, nextExcluded);
      return {
        entry: {
          seq, remove: outpoint(remove), add: outpoint(added), at: T0 - 500_000,
        },
        roster: [...survivors, added],
        excluded: nextExcluded,
      };
    }

    const first = linkAtop(1, base.members, new Set());
    const second = linkAtop(2, first.roster, first.excluded);

    function context(overrides = {}) {
      return {
        key: KEY, membership, committeeSize: SIZE, ...overrides,
      };
    }

    function rosterRequest(overrides = {}) {
      return {
        epoch: 5,
        candidate: 'aaaa:0',
        remove: first.entry.remove,
        add: first.entry.add,
        seq: 1,
        fingerprint: 'fp-1',
        at: T0 - 10,
        ...overrides,
      };
    }

    it('records a valid proposal: entry journaled, stamp taken, reply names the seat', () => {
      const { reply, record } = onRoster(heldRecord(), rosterRequest(), T0, TUNABLES, context());
      expect(reply.ok).to.equal(true);
      expect(reply.seq).to.equal(1);
      expect(reply.remove).to.equal(first.entry.remove);
      expect(reply.add).to.equal(first.entry.add);
      expect(record.roster.fingerprint).to.equal('fp-1');
      expect(record.roster.changedAt).to.equal(T0);
      expect(record.roster.chain).to.have.length(1);
      expect(record.roster.chain[0].at).to.equal(T0 - 10);
    });

    it('only the recorded grantee of the live term, at its own epoch, proposes', () => {
      const wrongNode = onRoster(heldRecord(), rosterRequest({ candidate: 'bbbb:0' }), T0, TUNABLES, context());
      expect(wrongNode.reply.code).to.equal('not_grantee');
      const wrongEpoch = onRoster(heldRecord(), rosterRequest({ epoch: 4 }), T0, TUNABLES, context());
      expect(wrongEpoch.reply.code).to.equal('not_grantee');
      const lapsed = onRoster(heldRecord(), rosterRequest(), T0 + TTL + 1, TUNABLES, context());
      expect(lapsed.reply.code).to.equal('lapsed');
      const none = onRoster(null, rosterRequest(), T0, TUNABLES, context());
      expect(none.reply.code).to.equal('no_grant');
      const released = onRoster(heldRecord({ accepted: { released: true } }), rosterRequest(), T0, TUNABLES, context());
      expect(released.reply.code).to.equal('no_grant');
      const oneshot = onRoster(oneshotRecord(), rosterRequest({ epoch: 2, candidate: 'ffff:1' }), T0, TUNABLES, context());
      expect(oneshot.reply.code).to.equal('bad_mode');
    });

    it('the proposal must name the basis the grant is pinned to — membership and generation both', () => {
      const { reply } = onRoster(heldRecord(), rosterRequest({ fingerprint: 'fp-2' }), T0, TUNABLES, context());
      expect(reply.code).to.equal('wrong_fingerprint');
      const rolled = onRoster(heldRecord(), rosterRequest({ generation: 2 }), T0, TUNABLES, context());
      expect(rolled.reply.code).to.equal('wrong_generation');
    });

    it('a seq that does not extend the journal teaches the journal length', () => {
      const { reply } = onRoster(heldRecord(), rosterRequest({ seq: 2 }), T0, TUNABLES, context());
      expect(reply.code).to.equal('roster_seq');
      expect(reply.rosterSeq).to.equal(0);
    });

    it('one seat per TTL: a second change inside the window is refused with the wait', () => {
      const record = heldRecord();
      record.roster = { fingerprint: 'fp-1', changedAt: T0 - 100, chain: [first.entry] };
      const inside = onRoster(record, rosterRequest({
        seq: 2, remove: second.entry.remove, add: second.entry.add,
      }), T0, TUNABLES, context());
      expect(inside.reply.code).to.equal('roster_rate');
      expect(inside.reply.retryAfterMs).to.equal(TUNABLES.maxTtlMs - 100);

      record.roster.changedAt = T0 - TUNABLES.maxTtlMs;
      const outside = onRoster(record, rosterRequest({
        seq: 2, remove: second.entry.remove, add: second.entry.add,
      }), T0, TUNABLES, context());
      expect(outside.reply.ok).to.equal(true);
      expect(outside.record.roster.chain).to.have.length(2);
    });

    it('the removed seat must sit on the current roster', () => {
      const offRoster = membership.find(
        (node) => !base.members.some((member) => outpoint(member) === outpoint(node)),
      );
      const { reply } = onRoster(heldRecord(), rosterRequest({ remove: outpoint(offRoster) }), T0, TUNABLES, context());
      expect(reply.code).to.equal('roster_remove');
    });

    it('a hand-picked replacement is refused and the refusal teaches the walk answer', () => {
      const offWalk = membership.find(
        (node) => !base.members.some((member) => outpoint(member) === outpoint(node))
          && outpoint(node) !== first.entry.add,
      );
      const { reply } = onRoster(heldRecord(), rosterRequest({ add: outpoint(offWalk) }), T0, TUNABLES, context());
      expect(reply.code).to.equal('roster_add');
      expect(reply.expected).to.equal(first.entry.add);
    });

    it('a chain that has replaced a full committee is exhausted, not extended', () => {
      const record = heldRecord();
      let roster = base.members;
      let excluded = new Set();
      const chain = [];
      for (let seq = 1; seq <= SIZE; seq += 1) {
        const link = linkAtop(seq, roster, excluded);
        chain.push(link.entry);
        ({ roster, excluded } = link);
      }
      record.roster = { fingerprint: 'fp-1', changedAt: T0 - TUNABLES.maxTtlMs, chain };
      // the cap refuses before any seat is judged, so the named seats need
      // not resolve — on this fleet no valid sixth link even exists
      const { reply } = onRoster(record, rosterRequest({ seq: SIZE + 1 }), T0, TUNABLES, context());
      expect(reply.code).to.equal('roster_exhausted');
    });

    it('adopts verified carried entries it missed, then judges the proposal atop them', () => {
      const { reply, record } = onRoster(heldRecord(), rosterRequest({
        seq: 2, remove: second.entry.remove, add: second.entry.add,
      }), T0, TUNABLES, context({ verifiedCarriedChain: [first.entry] }));
      expect(reply.ok).to.equal(true);
      expect(record.roster.chain).to.have.length(2);
      expect(record.roster.chain[0].add).to.equal(first.entry.add);
    });

    it('a carried chain conflicting with the journal is refused, never chosen over it', () => {
      const record = heldRecord();
      record.roster = { fingerprint: 'fp-1', changedAt: T0 - TUNABLES.maxTtlMs, chain: [first.entry] };
      const fork = [{ ...first.entry, add: second.entry.add }, second.entry];
      const { reply } = onRoster(record, rosterRequest({
        seq: 3, remove: second.entry.remove, add: second.entry.add,
      }), T0, TUNABLES, context({ verifiedCarriedChain: fork }));
      expect(reply.code).to.equal('roster_conflict');
    });

    it('accepting a grant at a new basis clears the old chain; at the same basis it survives', () => {
      const record = heldRecord();
      record.roster = { fingerprint: 'fp-1', changedAt: T0 - 100, chain: [first.entry] };

      const sameBasis = onAccept(record, {
        epoch: 6, grantee: 'aaaa:0', mode: 'held', ttlMs: TTL, fingerprint: 'fp-1',
      }, T0, TUNABLES);
      expect(sameBasis.record.roster.chain).to.have.length(1);

      const lapsedAt = T0 + TTL + TUNABLES.lockDelayMs + 1;
      const newBasis = onAccept(record, {
        epoch: 7, grantee: 'bbbb:0', mode: 'held', ttlMs: TTL, fingerprint: 'fp-2',
      }, lapsedAt, TUNABLES);
      expect(newBasis.record.roster).to.equal(null);

      const reRolled = onAccept(record, {
        epoch: 7, grantee: 'bbbb:0', mode: 'held', ttlMs: TTL, fingerprint: 'fp-1', generation: 1,
      }, lapsedAt, TUNABLES);
      expect(reRolled.record.accepted.generation).to.equal(1);
      expect(reRolled.record.roster).to.equal(null);
    });

    it('accepting a grant at a new basis clears the old cancel chain too; at the same basis it survives', () => {
      const record = heldRecord();
      record.cancels = {
        fingerprint: 'fp-1',
        generation: 0,
        chain: [{
          seq: 1, cancel: `${'9'.repeat(64)}:0`, cert: { token: 'standing' }, at: T0,
        }],
      };

      const sameBasis = onAccept(record, {
        epoch: 6, grantee: 'aaaa:0', mode: 'held', ttlMs: TTL, fingerprint: 'fp-1',
      }, T0, TUNABLES);
      expect(sameBasis.record.cancels.chain).to.have.length(1);

      const lapsedAt = T0 + TTL + TUNABLES.lockDelayMs + 1;
      const newBasis = onAccept(record, {
        epoch: 7, grantee: 'bbbb:0', mode: 'held', ttlMs: TTL, fingerprint: 'fp-2',
      }, lapsedAt, TUNABLES);
      expect(newBasis.record.cancels).to.equal(null);
    });
  });

  // The refereeing-anchored lock-delay: the
  // successor's wait runs only while this grantor is refereeing. While the
  // register was closed — stale view, unresynced return — nobody could have
  // reclaimed the lapsed row, so the exclusivity window must not have burned:
  // the wait anchors at the LATER of the row's death and the grantor's return
  // to refereeing, carried beside the knobs as refereeingSinceMs. Without it
  // a coast that outlives lockDelay − slack inverts the plane's stated
  // ordering (grantClient.js: demotion before any successor can be seated).
  describe('the refereeing-anchored lock-delay', () => {
    const returnedAt = T0 + TTL + 100_000; // long past death + lockDelay
    const anchored = { ...TUNABLES, refereeingSinceMs: returnedAt };

    it('holds challengers for one lock-delay after the grantor returns to refereeing', () => {
      const { reply, record } = onPrepare(heldRecord(), { epoch: 9, candidate: 'cccc:0' }, returnedAt + 1, anchored);
      expect(reply.code).to.equal('lock_delay');
      expect(reply.retryAfterMs).to.equal(TUNABLES.lockDelayMs - 1);
      expect(record).to.equal(null);
    });

    it('holds challengers on accept behind the same anchor', () => {
      const { reply } = onAccept(heldRecord(), {
        epoch: 9, grantee: 'cccc:0', mode: 'held', ttlMs: TTL,
      }, returnedAt + 1, anchored);
      expect(reply.code).to.equal('lock_delay');
    });

    it('never delays the recorded grantee, whatever the anchor says', () => {
      const { reply } = onPrepare(heldRecord(), { epoch: 9, candidate: 'aaaa:0' }, returnedAt + 1, anchored);
      expect(reply.ok).to.equal(true);
    });

    it('frees challengers one lock-delay after the return', () => {
      const { reply } = onPrepare(
        heldRecord(),
        { epoch: 9, candidate: 'cccc:0' },
        returnedAt + TUNABLES.lockDelayMs + 1,
        anchored,
      );
      expect(reply.ok).to.equal(true);
    });

    it('an anchor older than the row death changes nothing', () => {
      const early = { ...TUNABLES, refereeingSinceMs: T0 }; // refereeing since before the term
      const wellPast = T0 + TTL + TUNABLES.lockDelayMs + 1;
      const { reply } = onPrepare(heldRecord(), { epoch: 9, candidate: 'cccc:0' }, wellPast, early);
      expect(reply.ok).to.equal(true);
    });

    it('an absent anchor keeps the row-death behaviour', () => {
      const wellPast = T0 + TTL + TUNABLES.lockDelayMs + 1;
      const { reply } = onPrepare(heldRecord(), { epoch: 9, candidate: 'cccc:0' }, wellPast, TUNABLES);
      expect(reply.ok).to.equal(true);
    });
  });
});
