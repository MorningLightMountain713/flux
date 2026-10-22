'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');

const { MembershipHistory } = require('../../ZelBack/src/services/utils/membershipHistory');
const { NodeDownTopology } = require('../../ZelBack/src/services/utils/nodeDownTopology');
const {
  NodeDownJuror, SHUTDOWN_COURTESY, RESTART_COURTESY, COURTESY_WINDOW_MS, COURTESY_EARLY_EDGE_MS,
} = require('../../ZelBack/src/services/utils/nodeDownJuror');
const { NODE_DOWN_GRACE_MS, RESTART_GRACE_MS } = require('../../ZelBack/src/services/utils/appConstants');
const { JUDGEMENT, verdictPayload } = require('../../ZelBack/src/services/utils/nodeDownCertificates');

const T0 = 1_700_000_000_000;
const tick = () => new Promise((resolve) => { setImmediate(() => setImmediate(resolve)); });
// A signed stop of a new process, as accepted from its statement.
let processSeq = 0;
const pid = () => {
  processSeq += 1;
  const processId = processSeq.toString(16).padStart(32, '0');
  return { processId, statement: { data: { type: 'fluxprocessstop', processId } } };
};

// The fake signature binds the exact payload bytes, so any field tampering
// fails verification naturally; owner binding is Branch 2's matrix.
const fakeSign = (payload) => `sig|${payload.toString('hex')}`;

const ME = 'j1:0';
const S = 's:0';

// Seven nodes, no shared owners or addresses: jury(S) is the other six,
// H = ceil(2/3 * 6) = 4. `me` is always a juror of S.
function makeWorld({ extraNodes = [], myDetectedIp = '10.0.0.11' } = {}) {
  const history = new MembershipHistory();
  const world = {
    myDetectedIp,
    nodes: [
      { txhash: 'j1', outidx: 0, pubkey: 'pk1', ip: '10.0.0.11:16127', added_height: 1 },
      { txhash: 'j2', outidx: 0, pubkey: 'pk2', ip: '10.0.0.12:16127', added_height: 1 },
      { txhash: 'j3', outidx: 0, pubkey: 'pk3', ip: '10.0.0.13:16127', added_height: 1 },
      { txhash: 'j4', outidx: 0, pubkey: 'pk4', ip: '10.0.0.14:16127', added_height: 1 },
      { txhash: 'j5', outidx: 0, pubkey: 'pk5', ip: '10.0.0.15:16127', added_height: 1 },
      { txhash: 'j6', outidx: 0, pubkey: 'pk6', ip: '10.0.0.16:16127', added_height: 1 },
      { txhash: 's', outidx: 0, pubkey: 'pkS', ip: '10.0.0.20:16127', added_height: 1 },
      ...extraNodes,
    ],
    history,
    height: 1000,
    nowMs: T0,
    healthy: true,
    held: new Set(),
    probeResult: false,
    probes: [],
    pushes: [],
    notes: [],
    proofs: [],
    certificates: [],
    // the looks the juror has scheduled: {due, fn}, fired by advance()
    timers: [],
  };
  // The clock moves: every look due by then fires, in order.
  world.advance = (ms) => {
    world.nowMs += ms;
    const due = world.timers.filter((t) => t.due <= world.nowMs).sort((a, b) => a.due - b.due);
    world.timers = world.timers.filter((t) => t.due > world.nowMs);
    due.forEach((t) => t.fn());
  };
  world.record = (height, atMs) => history.record(world.nodes, { height, hash: `h${height}` }, atMs);
  world.fp = world.record(999, T0);
  world.topology = new NodeDownTopology({
    nodes: () => world.nodes,
    membershipHistory: history,
  });
  world.juror = new NodeDownJuror({
    topology: () => world.topology,
    myOutpoint: () => ME,
    resolveOutpoint: (outpoint) => {
      const node = world.nodes.find((n) => `${n.txhash}:${n.outidx}` === outpoint);
      if (!node) return null;
      return node.ip.includes(':') ? node.ip : `${node.ip}:16127`;
    },
    probe: (socketAddress) => {
      world.probes.push(socketAddress);
      return Promise.resolve(world.probeResult);
    },
    healthy: () => world.healthy,
    myAddress: () => world.myDetectedIp,
    isHeld: (socketAddress) => world.held.has(socketAddress),
    signVerdict: (payload) => fakeSign(payload),
    nextDeath: (subject) => Promise.resolve(world.nextDeath?.(subject)),
    verifySignature: (owner, payload, signature) => signature === fakeSign(payload),
    pushVerdict: (socketAddress, verdict) => world.pushes.push({ socketAddress, verdict }),
    pushNote: (socketAddress, statement) => world.notes.push({ socketAddress, statement }),
    isLie: (a, b) => a.data.processId === b.data.processId && a.timestamp !== b.timestamp,
    onProof: (subject, a, b) => world.proofs.push({ subject, a, b }),
    currentHeight: () => world.height,
    now: () => world.nowMs,
    schedule: (fn, ms) => {
      const handle = { due: world.nowMs + ms, fn };
      world.timers.push(handle);
      return handle;
    },
    cancel: (handle) => {
      world.timers = world.timers.filter((t) => t !== handle);
    },
    currentFingerprint: () => history.currentFingerprint(),
    onCertificate: (certificate) => world.certificates.push(certificate),
  });
  world.verdictFrom = (jurorOutpoint, over = {}) => {
    const verdict = {
      subject: S,
      juror: jurorOutpoint,
      judgement: JUDGEMENT.UNREACHABLE,
      height: world.height,
      fingerprint: world.fp,
      ...over,
    };
    verdict.signature = over.signature ?? fakeSign(verdictPayload(verdict));
    return verdict;
  };
  return world;
}

describe('nodeDownJuror', () => {
  describe('the look: self-check, one fresh dial, record, push (steps 2-4)', () => {
    it('a failed probe signs one verdict and pushes it to the other jurors, never itself', async () => {
      const world = makeWorld();
      await world.juror.look(S, 'drop');

      expect(world.probes).to.deep.equal(['10.0.0.20:16127']);
      expect(world.pushes.length).to.equal(5); // jury of 6 minus me
      const targets = world.pushes.map((p) => p.socketAddress).sort();
      expect(targets).to.deep.equal(['10.0.0.12:16127', '10.0.0.13:16127', '10.0.0.14:16127', '10.0.0.15:16127', '10.0.0.16:16127']);
      const { verdict } = world.pushes[0];
      expect(verdict).to.include({
        subject: S, juror: ME, judgement: JUDGEMENT.UNREACHABLE, height: 1000, fingerprint: world.fp,
      });
      expect(verdict.signature).to.equal(fakeSign(verdictPayload(verdict)));
    });

    it('a successful probe records reachable and sends nothing — a blip costs zero messages', async () => {
      const world = makeWorld();
      world.probeResult = true;
      world.held.add('10.0.0.20:16127');
      await world.juror.look(S, 'drop');

      expect(world.pushes).to.deep.equal([]);
      expect(world.juror.snapshot().piles[S][ME]).to.equal(JUDGEMENT.REACHABLE);

      // standing while the connection is current: no second probe
      await world.juror.look(S, 'again');
      expect(world.probes.length).to.equal(1);

      // the connection goes away: reachable no longer stands, the next look probes
      world.held.delete('10.0.0.20:16127');
      await world.juror.look(S, 'after-drop');
      expect(world.probes.length).to.equal(2);
    });

    it('an unhealthy juror abstains without probing, and recovery re-opens every abstained pile', async () => {
      const world = makeWorld();
      world.healthy = false;
      await world.juror.look(S, 'drop');
      expect(world.probes).to.deep.equal([]);
      expect(world.juror.snapshot().piles[S][ME]).to.equal(JUDGEMENT.ABSTAIN);

      // abstain stands while the inability stands
      await world.juror.look(S, 'again');
      expect(world.probes).to.deep.equal([]);

      world.healthy = true;
      world.juror.onHealthRecovered();
      await tick();
      expect(world.probes).to.deep.equal(['10.0.0.20:16127']);
    });

    it('the hairpin belt abstains on the DETECTED address, which the list cannot yet see', async () => {
      // the list still shows me at .11 (so I remain S's juror — the walk
      // exclusion has nothing to act on), but my detected address is S's:
      // exactly the window the belt exists for
      const world = makeWorld({ myDetectedIp: '10.0.0.20' });
      await world.juror.look(S, 'drop');
      expect(world.probes).to.deep.equal([]);
      expect(world.pushes).to.deep.equal([]);
      expect(world.juror.snapshot().piles[S][ME]).to.equal(JUDGEMENT.ABSTAIN);
    });

    it('never looks at a subject that is not my duty, and never at itself', async () => {
      const world = makeWorld();
      await world.juror.look('zz:0', 'noise');
      await world.juror.look(ME, 'noise');
      expect(world.probes).to.deep.equal([]);
    });
  });

  describe('arrival validation (step 6)', () => {
    it('refuses what must never reach a pile, each for its own reason', async () => {
      const world = makeWorld();
      const cases = [
        [world.verdictFrom('j2:0', { judgement: JUDGEMENT.REACHABLE }), 'malformed'],
        [world.verdictFrom('j2:0', { subject: 'zz:0' }), 'not_my_duty'],
        [world.verdictFrom('j2:0', { height: 980 }), 'stale'],
        [world.verdictFrom('j2:0', { height: 1002 }), 'stale'],
        [world.verdictFrom('j2:0', { fingerprint: 'f'.repeat(64) }), 'unknown_fingerprint'],
        [world.verdictFrom('zz:0'), 'not_a_watcher'],
        [world.verdictFrom('j2:0', { signature: 'sig|deadbeef' }), 'bad_signature'],
      ];
      cases.forEach(([verdict, reason]) => {
        const result = world.juror.onVerdictArrived(verdict);
        expect(result.piled, reason).to.equal(false);
        expect(result.reason).to.equal(reason);
      });
      expect(world.juror.snapshot().piles[S]).to.equal(undefined);
    });

    it('a valid arrival piles and wakes our own look — the load-bearing wake-up (step 5)', async () => {
      const world = makeWorld();
      const result = world.juror.onVerdictArrived(world.verdictFrom('j2:0'));
      expect(result.piled).to.equal(true);
      await tick();
      // woken: we probed, failed, and pushed our own verdict
      expect(world.probes).to.deep.equal(['10.0.0.20:16127']);
      expect(world.pushes.length).to.equal(5);
    });
  });

  describe('assembly (step 7)', () => {
    it('the pile crossing H assembles ONCE, and the certificate is self-verified before gossip', async () => {
      const world = makeWorld();
      world.juror.onVerdictArrived(world.verdictFrom('j2:0'));
      await tick(); // wake-up adds our own unreachable verdict: 2 of 4 needed
      world.juror.onVerdictArrived(world.verdictFrom('j3:0'));
      expect(world.certificates.length).to.equal(0); // 3 distinct owners < H=4

      world.juror.onVerdictArrived(world.verdictFrom('j4:0'));
      expect(world.certificates.length).to.equal(1);
      const certificate = world.certificates[0];
      expect(certificate).to.include({ subject: S, assembler: ME, fingerprint: world.fp });
      expect(certificate.verdicts.length).to.equal(4);

      // more arrivals do not re-assemble while the pile stands at H
      world.juror.onVerdictArrived(world.verdictFrom('j5:0'));
      expect(world.certificates.length).to.equal(1);
    });

    it('aging re-arms assembly: a fresh round certifies again at a later height', async () => {
      const world = makeWorld();
      world.juror.onVerdictArrived(world.verdictFrom('j2:0'));
      await tick();
      world.juror.onVerdictArrived(world.verdictFrom('j3:0'));
      world.juror.onVerdictArrived(world.verdictFrom('j4:0'));
      expect(world.certificates.length).to.equal(1);

      world.height = 1020; // every verdict now past the 10-block lifetime: the next arrival re-arms
      world.juror.onVerdictArrived(world.verdictFrom('j2:0'));
      await tick();
      world.juror.onVerdictArrived(world.verdictFrom('j3:0'));
      world.juror.onVerdictArrived(world.verdictFrom('j4:0'));
      expect(world.certificates.length).to.equal(2);
    });

    it('a pile aged to one short of H re-assembles on the next verdict alone', async () => {
      // One verdict cast five blocks before the rest ages out on its own; the
      // pile stands at H-1 and nothing has read it since it assembled. The
      // verdict that refills it is the only call there will be.
      const world = makeWorld();
      world.juror.onVerdictArrived(world.verdictFrom('j2:0', { height: 995 }));
      await tick();
      world.juror.onVerdictArrived(world.verdictFrom('j3:0'));
      world.juror.onVerdictArrived(world.verdictFrom('j4:0'));
      expect(world.certificates.length).to.equal(1);

      world.height = 1006; // j2's verdict is past its lifetime, the other three are not
      world.juror.onVerdictArrived(world.verdictFrom('j5:0'));
      expect(world.certificates.length).to.equal(2);
    });

    it('a verdict cast under an older same-jury fingerprint counts toward H', async () => {
      // An eighth node makes jury(S) seven strong (H = 5), and its address
      // move keeps every jury identity intact while moving the fingerprint.
      const world = makeWorld({
        extraNodes: [{ txhash: 'u', outidx: 0, pubkey: 'pkU', ip: '10.0.0.30:16127', added_height: 1 }],
      });
      const fp1 = world.fp;
      const early = world.verdictFrom('j2:0'); // cast under fp1
      world.nodes.find((n) => n.txhash === 'u').ip = '10.0.0.31:16127';
      world.fp = world.record(1000, T0 + 1000);

      world.juror.onVerdictArrived(early);
      await tick(); // our own verdict, under fp2
      world.juror.onVerdictArrived(world.verdictFrom('j3:0'));
      world.juror.onVerdictArrived(world.verdictFrom('j4:0'));
      expect(world.certificates.length).to.equal(0);
      world.juror.onVerdictArrived(world.verdictFrom('j5:0'));

      expect(world.certificates.length).to.equal(1);
      const carried = world.certificates[0].verdicts.find((v) => v.juror === 'j2:0');
      expect(carried.fingerprint).to.equal(fp1);
    });
  });
});

describe('nodeDownJuror — the drop carries its reason (R2), and a re-held duty is evidence', () => {
  const SUBJECT_ADDRESS = '10.0.0.20:16127';

  it('the graces default to production\'s: 420 s for a shutdown, 120 s for a restart', () => {
    expect(NODE_DOWN_GRACE_MS).to.equal(420 * 1000);
    expect(RESTART_GRACE_MS).to.equal(120 * 1000);
  });

  it('an unannounced drop is looked at now', async () => {
    const world = makeWorld();
    const { honoured } = world.juror.noteDrop(S, 'unannounced');
    await tick();
    expect(honoured).to.equal(false);
    expect(world.probes).to.deep.equal([SUBJECT_ADDRESS]);
  });

  it('a SHUTTING_DOWN close is honoured: no probe and no verdict until the grace ends, then one look', async () => {
    const world = makeWorld();
    const { honoured } = world.juror.noteDrop(S, 'shutdown', pid());
    expect(honoured).to.equal(true);

    world.advance(NODE_DOWN_GRACE_MS - 1);
    await tick();
    expect(world.probes).to.deep.equal([]);
    expect(world.pushes).to.deep.equal([]);

    world.advance(1);
    await tick();
    expect(world.probes).to.deep.equal([SUBJECT_ADDRESS]);
    expect(world.pushes.length).to.equal(5); // the other five jurors hear the verdict

    // looked once: the deferral is spent
    world.advance(0);
    await tick();
    expect(world.probes.length).to.equal(1);
  });

  it('a RESTARTING close waits the shorter grace', async () => {
    const world = makeWorld();
    world.juror.noteDrop(S, 'restart', pid());
    world.advance(RESTART_GRACE_MS - 1);
    await tick();
    expect(world.probes).to.deep.equal([]);
    world.advance(1);
    await tick();
    expect(world.probes).to.deep.equal([SUBJECT_ADDRESS]);
  });

  it('a duty held again before the grace ends is never looked at', async () => {
    const world = makeWorld();
    world.juror.noteDrop(S, 'shutdown', pid());
    world.held.add(SUBJECT_ADDRESS);
    world.advance(NODE_DOWN_GRACE_MS);
    await tick();
    expect(world.probes).to.deep.equal([]);
  });

  it('a wake-up while a deferral pends is declined: no probe and no verdict until the grace end, whatever another juror saw', async () => {
    // One juror that lost the close frame probes and pushes; its verdict
    // wakes the rest. A juror holding the code stands by it — R2 — so the
    // one bad view cannot pull the jury into certifying an announced stop.
    const world = makeWorld();
    world.juror.noteDrop(S, 'shutdown', pid());
    await tick();
    const result = world.juror.onVerdictArrived(world.verdictFrom('j2:0'));
    await tick();
    expect(result.piled, 'the verdict is piled all the same').to.equal(true);
    expect(world.probes, 'but it wakes no look inside the grace').to.deep.equal([]);
    expect(world.pushes).to.deep.equal([]);

    world.advance(NODE_DOWN_GRACE_MS);
    await tick();
    expect(world.probes, 'the grace end looks once').to.deep.equal([SUBJECT_ADDRESS]);
  });

  it('an unannounced drop while a deferral pends is looked at now: the deferral does not absorb a death', async () => {
    const world = makeWorld();
    world.juror.noteDrop(S, 'shutdown', pid());
    world.juror.noteDrop(S, 'unannounced');
    await tick();
    expect(world.probes).to.deep.equal([SUBJECT_ADDRESS]);
    // and the old deferral is gone: the grace end owes nothing more
    world.advance(NODE_DOWN_GRACE_MS);
    await tick();
    expect(world.probes.length).to.equal(1);
  });

  it('a later coded close replaces the deferral: the grace runs from the newest drop', async () => {
    const world = makeWorld();
    world.juror.noteDrop(S, 'shutdown', pid());
    world.nowMs += NODE_DOWN_GRACE_MS - 1000;
    world.juror.noteDrop(S, 'shutdown', pid());
    world.advance(1000); // the first grace end
    await tick();
    expect(world.probes).to.deep.equal([]);
    world.advance(NODE_DOWN_GRACE_MS - 1000);
    await tick();
    expect(world.probes).to.deep.equal([SUBJECT_ADDRESS]);
  });

  it('re-holding the duty retires the standing answer: the next drop probes again instead of trusting it', async () => {
    const world = makeWorld();
    world.juror.noteDrop(S, 'unannounced');
    await tick();
    expect(world.probes.length).to.equal(1); // unreachable, signed, standing

    // as built, a second drop inside the verdict lifetime was skipped; the
    // duty being held again in between is what retires the answer
    world.juror.noteHeld(S);
    world.juror.noteDrop(S, 'unannounced');
    await tick();
    expect(world.probes.length).to.equal(2);
  });

  it('re-holding the duty retires the pile too, so a second death inside the lifetime is a new incident', async () => {
    const world = makeWorld();
    world.juror.onVerdictArrived(world.verdictFrom('j2:0'));
    await tick();
    world.juror.onVerdictArrived(world.verdictFrom('j3:0'));
    world.juror.onVerdictArrived(world.verdictFrom('j4:0'));
    expect(world.certificates.length).to.equal(1);

    world.juror.noteHeld(S);
    expect(world.juror.snapshot().piles[S]).to.equal(undefined);
    expect(world.juror.snapshot().assembled).to.deep.equal([]);

    world.juror.onVerdictArrived(world.verdictFrom('j2:0'));
    await tick();
    world.juror.onVerdictArrived(world.verdictFrom('j3:0'));
    world.juror.onVerdictArrived(world.verdictFrom('j4:0'));
    expect(world.certificates.length).to.equal(2);
  });

  it('re-holding the duty ends a pending deferral: nothing is owed at the old grace end', async () => {
    const world = makeWorld();
    world.juror.noteDrop(S, 'shutdown', pid());
    world.juror.noteHeld(S);
    world.advance(NODE_DOWN_GRACE_MS);
    await tick();
    expect(world.probes).to.deep.equal([]);
  });
});

describe('nodeDownJuror — the verdict names which death this is (formal/death-identity, nth)', () => {
  it('the verdict carries the number the store counts, signed; with no reading it names none and signs the five-field form', async () => {
    const world = makeWorld();
    world.nextDeath = () => 3;
    await world.juror.look(S, 'drop');
    expect(world.pushes[0].verdict.death).to.equal(3);
    expect(verdictPayload(world.pushes[0].verdict).toString()).to.match(/\|3$/);
    expect(world.pushes[0].verdict.signature).to.equal(fakeSign(verdictPayload(world.pushes[0].verdict)));

    const blind = makeWorld();
    blind.nextDeath = () => undefined;
    await blind.juror.look(S, 'drop');
    expect(blind.pushes[0].verdict).to.not.have.property('death');
    expect(verdictPayload(blind.pushes[0].verdict).toString().split('|').length).to.equal(5);
  });
});

describe('nodeDownJuror — the verdict names the drop it answers (P1)', () => {

  it('an unannounced drop\'s verdict carries the drop time and reason unannounced', async () => {
    const world = makeWorld();
    world.juror.noteDrop(S, 'unannounced');
    await tick();
    expect(world.pushes.length).to.equal(5);
    expect(world.pushes[0].verdict).to.include({ droppedAt: T0, reason: 'unannounced' });
    // the signature binds them: the payload is the seven-field form
    expect(verdictPayload(world.pushes[0].verdict).toString()).to.match(/\|1700000000000\|unannounced$/);
  });

  it('a grace-end look\'s verdict carries the honoured drop, not the look', async () => {
    const world = makeWorld();
    world.juror.noteDrop(S, 'shutdown', pid());
    world.advance(NODE_DOWN_GRACE_MS);
    await tick();
    expect(world.pushes[0].verdict).to.include({ droppedAt: T0, reason: 'shutdown' });
  });

  it('a wake-up look answers no drop: its verdict carries neither field', async () => {
    const world = makeWorld();
    world.juror.onVerdictArrived(world.verdictFrom('j2:0'));
    await tick();
    expect(world.pushes.length).to.equal(5);
    expect(world.pushes[0].verdict).to.not.have.property('droppedAt');
    expect(world.pushes[0].verdict).to.not.have.property('reason');
    expect(world.pushes[0].verdict.signature).to.equal(fakeSign(verdictPayload(world.pushes[0].verdict)));
  });

  it('the certificate this juror assembles carries since = the latest drop its jury saw', async () => {
    const world = makeWorld();
    world.juror.onVerdictArrived(world.verdictFrom('j2:0', { droppedAt: T0 - 5000, reason: 'unannounced' }));
    await tick();
    world.juror.onVerdictArrived(world.verdictFrom('j3:0', { droppedAt: T0 - 1000, reason: 'unannounced' }));
    world.juror.onVerdictArrived(world.verdictFrom('j4:0'));
    expect(world.certificates.length).to.equal(1);
    expect(world.certificates[0]).to.include({ since: T0 - 1000, reason: 'unannounced' });
  });
});

describe('nodeDownJuror — the courtesy: a clean stop is honoured only so many times per window (R7)', () => {
  const SUBJECT_ADDRESS = '10.0.0.20:16127';
  const COUNTED_FOR = COURTESY_WINDOW_MS - COURTESY_EARLY_EDGE_MS;

  it('the limits are code constants: four shutdowns and twelve restarts per 24 hours, the window ending 20 minutes early', () => {
    expect(SHUTDOWN_COURTESY).to.equal(4);
    expect(RESTART_COURTESY).to.equal(12);
    expect(COURTESY_WINDOW_MS).to.equal(24 * 60 * 60 * 1000);
    expect(COURTESY_EARLY_EDGE_MS).to.equal(20 * 60 * 1000);
  });

  // one honoured stop and return, the duty re-held
  async function cleanStop(world, reason, processId = pid()) {
    const { honoured } = world.juror.noteDrop(S, reason, processId);
    world.juror.noteHeld(S);
    world.nowMs += 1000;
    await tick();
    return honoured;
  }

  it('the fifth signed SHUTTING_DOWN close in the window is not honoured: the juror looks at the drop, and its verdict says shutdown', async () => {
    const world = makeWorld();
    for (let i = 0; i < SHUTDOWN_COURTESY; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect(await cleanStop(world, 'shutdown')).to.equal(true);
    }
    expect(world.probes).to.deep.equal([]);

    const { honoured } = world.juror.noteDrop(S, 'shutdown', pid());
    await tick();
    expect(honoured).to.equal(false);
    expect(world.probes).to.deep.equal([SUBJECT_ADDRESS]);
    expect(world.pushes[0].verdict).to.include({ droppedAt: world.nowMs, reason: 'shutdown' });
  });

  it('a coded close without an accepted stop statement is looked at now, as unannounced', async () => {
    const world = makeWorld();
    const { honoured } = world.juror.noteDrop(S, 'restart', null);
    await tick();
    expect(honoured).to.equal(false);
    expect(world.probes).to.deep.equal([SUBJECT_ADDRESS]);
    expect(world.pushes[0].verdict).to.include({ reason: 'unannounced' });
  });

  it('restarts have their own, longer courtesy', async () => {
    const world = makeWorld();
    for (let i = 0; i < RESTART_COURTESY; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect(await cleanStop(world, 'restart')).to.equal(true);
    }
    expect((world.juror.noteDrop(S, 'restart', pid())).honoured).to.equal(false);
    await tick();
    expect(world.pushes[0].verdict).to.include({ reason: 'restart' });
  });

  it('the courtesy is per subject, and restarts do not spend the shutdown courtesy', async () => {
    const world = makeWorld({ extraNodes: [{ txhash: 'u', outidx: 0, pubkey: 'pkU', ip: '10.0.0.30:16127', added_height: 1 }] });
    for (let i = 0; i < SHUTDOWN_COURTESY; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await cleanStop(world, 'shutdown');
    }
    expect(world.juror.noteDrop('u:0', 'shutdown', pid()).honoured).to.equal(true);
    expect(world.juror.noteDrop(S, 'restart', pid()).honoured).to.equal(true);
  });

  it('a stop counts until the window less its early edge has passed since this juror first held it', async () => {
    const before = makeWorld();
    const at = makeWorld();
    [before, at].forEach((world) => {
      for (let i = 0; i < SHUTDOWN_COURTESY; i += 1) world.juror.learnStop(S, 'shutdown', pid());
    });
    before.nowMs += COUNTED_FOR - 1;
    at.nowMs += COUNTED_FOR;
    expect(before.juror.noteDrop(S, 'shutdown', pid()).honoured).to.equal(false);
    expect(at.juror.noteDrop(S, 'shutdown', pid()).honoured).to.equal(true);
  });

  it('a refused stop is held too: it counts against the next', async () => {
    const world = makeWorld();
    for (let i = 0; i < SHUTDOWN_COURTESY; i += 1) world.juror.learnStop(S, 'shutdown', pid());
    world.nowMs += 1000;
    expect(world.juror.noteDrop(S, 'shutdown', pid()).honoured).to.equal(false);
    world.juror.noteHeld(S);
    // the four have left the window; the refused one has not
    world.nowMs += COUNTED_FOR - 1;
    for (let i = 0; i < SHUTDOWN_COURTESY - 1; i += 1) {
      expect(world.juror.noteDrop(S, 'shutdown', pid()).honoured).to.equal(true);
      world.juror.noteHeld(S);
    }
    expect(world.juror.noteDrop(S, 'shutdown', pid()).honoured).to.equal(false);
  });

  it('a stop held from another juror counts as one seen on the close', async () => {
    const world = makeWorld();
    for (let i = 0; i < SHUTDOWN_COURTESY; i += 1) {
      expect(world.juror.learnStop(S, 'shutdown', pid())).to.equal(true);
    }
    expect(world.juror.noteDrop(S, 'shutdown', pid()).honoured).to.equal(false);
  });

  it('one stop counts once, however many times it is held', async () => {
    const world = makeWorld();
    const id = pid();
    expect(world.juror.learnStop(S, 'shutdown', id)).to.equal(true);
    expect(world.juror.learnStop(S, 'shutdown', id)).to.equal(false);
    for (let i = 0; i < SHUTDOWN_COURTESY - 2; i += 1) world.juror.learnStop(S, 'shutdown', pid());
    expect(world.juror.noteDrop(S, 'shutdown', pid()).honoured).to.equal(true);
  });

  it('the stop being closed is not counted against itself, though another juror\'s forward of it arrived first', async () => {
    const world = makeWorld();
    for (let i = 0; i < SHUTDOWN_COURTESY - 1; i += 1) world.juror.learnStop(S, 'shutdown', pid());
    const closing = pid();
    world.juror.learnStop(S, 'shutdown', closing);
    expect(world.juror.noteDrop(S, 'shutdown', closing).honoured).to.equal(true);
  });

  it('an honoured stop that overruns is certified through the grace-end look and is not counted twice', async () => {
    const world = makeWorld();
    for (let i = 0; i < SHUTDOWN_COURTESY - 1; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await cleanStop(world, 'shutdown');
    }
    expect(world.juror.noteDrop(S, 'shutdown', pid()).honoured).to.equal(true); // the fourth
    world.advance(NODE_DOWN_GRACE_MS);
    await tick();
    expect(world.probes).to.deep.equal([SUBJECT_ADDRESS]);
    world.juror.noteHeld(S);
    // still the fourth signed stop in the window: the fifth is the one refused
    expect(world.juror.noteDrop(S, 'shutdown', pid()).honoured).to.equal(false);
  });

  it('the memory is kept for duties only, and dies with the juror', async () => {
    const world = makeWorld();
    for (let i = 0; i < SHUTDOWN_COURTESY; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await cleanStop(world, 'shutdown');
    }
    world.juror.retain(new Set(['j2:0']));
    expect(world.juror.noteDrop(S, 'shutdown', pid()).honoured).to.equal(true);
  });
});

describe('nodeDownJuror — the courtesy is the jury\'s: a signed stop one juror holds, every juror holds', () => {
  const OTHER_JURORS = ['10.0.0.12:16127', '10.0.0.13:16127', '10.0.0.14:16127', '10.0.0.15:16127', '10.0.0.16:16127'];

  it('a stop seen on the close is forwarded, as signed, to each other juror of the subject', () => {
    const world = makeWorld();
    const stop = pid();
    world.juror.noteDrop(S, 'restart', stop);
    expect(world.notes.map((note) => note.socketAddress).sort()).to.deep.equal(OTHER_JURORS);
    world.notes.forEach((note) => expect(note.statement).to.equal(stop.statement));
  });

  it('a forwarded stop new to this juror is held and forwarded on; one already held is neither', () => {
    const world = makeWorld();
    const stop = pid();
    expect(world.juror.onNote(S, 'restart', stop)).to.deep.equal({ held: true, reason: 'held' });
    expect(world.notes.length).to.equal(OTHER_JURORS.length);
    expect(world.juror.onNote(S, 'restart', stop)).to.deep.equal({ held: false, reason: 'already_held' });
    world.juror.noteDrop(S, 'restart', stop);
    expect(world.notes.length, 'nor forwarded again when its close is seen').to.equal(OTHER_JURORS.length);
  });

  it('a forwarded stop counts like one seen: the jury refuses together past the courtesy', () => {
    const world = makeWorld();
    for (let i = 0; i < SHUTDOWN_COURTESY; i += 1) world.juror.onNote(S, 'shutdown', pid());
    expect(world.juror.noteDrop(S, 'shutdown', pid()).honoured).to.equal(false);
  });

  it('a stop of a subject that is not this node\'s duty is not held', () => {
    const world = makeWorld();
    const { topology } = world;
    world.topology = { duties: () => [], jury: (subject) => topology.jury(subject) };
    expect(world.juror.onNote(S, 'restart', pid())).to.deep.equal({ held: false, reason: 'not_my_duty' });
    expect(world.notes).to.deep.equal([]);
  });

  describe('a proven lie', () => {
    const second = (stop, over = {}) => ({
      processId: stop.processId,
      statement: { ...stop.statement, timestamp: 2, ...over },
    });

    it('a forwarded statement for a held process that says something else raises the proof, once', () => {
      const world = makeWorld();
      const stop = pid();
      world.juror.noteDrop(S, 'restart', stop);
      const other = second(stop);
      world.juror.onNote(S, 'restart', other);
      world.juror.onNote(S, 'restart', second(stop, { timestamp: 3 }));
      expect(world.proofs).to.deep.equal([{ subject: S, a: stop.statement, b: other.statement }]);
    });

    it('a close carrying another statement for a process held from a forward raises it too', () => {
      const world = makeWorld();
      const stop = pid();
      world.juror.onNote(S, 'restart', stop);
      world.juror.noteDrop(S, 'restart', second(stop));
      expect(world.proofs.length).to.equal(1);
    });

    it('two statements of one process under different reasons are found', () => {
      const world = makeWorld();
      const stop = pid();
      world.juror.onNote(S, 'restart', stop);
      world.juror.onNote(S, 'shutdown', second(stop));
      expect(world.proofs.length).to.equal(1);
    });

    it('the same statement twice is no proof', () => {
      const world = makeWorld();
      const stop = pid();
      world.juror.onNote(S, 'restart', stop);
      world.juror.noteDrop(S, 'restart', stop);
      expect(world.proofs).to.deep.equal([]);
    });

    it('a subject that left this node\'s duties is forgotten, proof and all', () => {
      const world = makeWorld();
      const stop = pid();
      world.juror.onNote(S, 'restart', stop);
      world.juror.onNote(S, 'restart', second(stop));
      world.juror.retain(new Set());
      world.juror.onNote(S, 'restart', stop);
      world.juror.onNote(S, 'restart', second(stop));
      expect(world.proofs.length).to.equal(2);
    });
  });
});
