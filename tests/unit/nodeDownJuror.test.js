'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');

const { MembershipHistory } = require('../../ZelBack/src/services/utils/membershipHistory');
const { NodeDownTopology } = require('../../ZelBack/src/services/utils/nodeDownTopology');
const { NodeDownJuror } = require('../../ZelBack/src/services/utils/nodeDownJuror');
const { JUDGEMENT, verdictPayload } = require('../../ZelBack/src/services/utils/nodeDownCertificates');

const T0 = 1_700_000_000_000;
const tick = () => new Promise((resolve) => { setImmediate(() => setImmediate(resolve)); });

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
    certificates: [],
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
    verifySignature: (owner, payload, signature) => signature === fakeSign(payload),
    pushVerdict: (socketAddress, verdict) => world.pushes.push({ socketAddress, verdict }),
    currentHeight: () => world.height,
    now: () => world.nowMs,
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

      world.height = 1020; // every verdict now past the 10-block lifetime
      world.juror.sweep();
      expect(world.juror.snapshot().piles[S]).to.equal(undefined);

      world.juror.onVerdictArrived(world.verdictFrom('j2:0'));
      await tick();
      world.juror.onVerdictArrived(world.verdictFrom('j3:0'));
      world.juror.onVerdictArrived(world.verdictFrom('j4:0'));
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
  const { NODE_DOWN_GRACE_MS, RESTART_GRACE_MS } = require('../../ZelBack/src/services/utils/appConstants');

  it('the graces are code constants nodes agree on: 420 s for a shutdown, 120 s for a restart', () => {
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
    const { honoured } = world.juror.noteDrop(S, 'shutdown');
    expect(honoured).to.equal(true);

    world.nowMs += NODE_DOWN_GRACE_MS - 1;
    world.juror.sweep();
    await tick();
    expect(world.probes).to.deep.equal([]);
    expect(world.pushes).to.deep.equal([]);

    world.nowMs += 1;
    world.juror.sweep();
    await tick();
    expect(world.probes).to.deep.equal([SUBJECT_ADDRESS]);
    expect(world.pushes.length).to.equal(5); // the other five jurors hear the verdict

    // looked once: the deferral is spent
    world.juror.sweep();
    await tick();
    expect(world.probes.length).to.equal(1);
  });

  it('a RESTARTING close waits the shorter grace', async () => {
    const world = makeWorld();
    world.juror.noteDrop(S, 'restart');
    world.nowMs += RESTART_GRACE_MS - 1;
    world.juror.sweep();
    await tick();
    expect(world.probes).to.deep.equal([]);
    world.nowMs += 1;
    world.juror.sweep();
    await tick();
    expect(world.probes).to.deep.equal([SUBJECT_ADDRESS]);
  });

  it('a duty held again before the grace ends is never looked at', async () => {
    const world = makeWorld();
    world.juror.noteDrop(S, 'shutdown');
    world.held.add(SUBJECT_ADDRESS);
    world.nowMs += NODE_DOWN_GRACE_MS;
    world.juror.sweep();
    await tick();
    expect(world.probes).to.deep.equal([]);
  });

  it('an unannounced drop while a deferral pends is looked at now: the deferral does not absorb a death', async () => {
    const world = makeWorld();
    world.juror.noteDrop(S, 'shutdown');
    world.juror.noteDrop(S, 'unannounced');
    await tick();
    expect(world.probes).to.deep.equal([SUBJECT_ADDRESS]);
    // and the old deferral is gone: the grace end owes nothing more
    world.nowMs += NODE_DOWN_GRACE_MS;
    world.juror.sweep();
    await tick();
    expect(world.probes.length).to.equal(1);
  });

  it('a later coded close replaces the deferral: the grace runs from the newest drop', async () => {
    const world = makeWorld();
    world.juror.noteDrop(S, 'shutdown');
    world.nowMs += NODE_DOWN_GRACE_MS - 1000;
    world.juror.noteDrop(S, 'shutdown');
    world.nowMs += 1000; // the first grace end
    world.juror.sweep();
    await tick();
    expect(world.probes).to.deep.equal([]);
    world.nowMs += NODE_DOWN_GRACE_MS - 1000;
    world.juror.sweep();
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
    world.juror.noteDrop(S, 'shutdown');
    world.juror.noteHeld(S);
    world.nowMs += NODE_DOWN_GRACE_MS;
    world.juror.sweep();
    await tick();
    expect(world.probes).to.deep.equal([]);
  });
});

describe('nodeDownJuror — the verdict names the drop it answers (P1)', () => {
  const { NODE_DOWN_GRACE_MS } = require('../../ZelBack/src/services/utils/appConstants');

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
    world.juror.noteDrop(S, 'shutdown');
    world.nowMs += NODE_DOWN_GRACE_MS;
    world.juror.sweep();
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
