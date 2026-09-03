'use strict';

const {
  JUDGEMENT,
  DROP_REASON,
  VERDICT_LIFETIME_BLOCKS,
  FUTURE_BLOCKS_TOLERANCE,
  verdictPayload,
  assemble,
  verifyCertificate,
} = require('./nodeDownCertificates');
const { quorumThreshold } = require('./peerRings');
const { extractIp } = require('./socketAddressUtils');
const { NODE_DOWN_GRACE_MS, RESTART_GRACE_MS } = require('./appConstants');

const log = require('../../lib/log');

// The juror engine: observe, self-check, probe, record, push, wake and
// assemble as one state machine, every side
// effect injected. Observation in (a duty dropped, a duty dial failed, a
// verdict arrived, our own gates recovered), verdict push and certificate
// assembly out. No timer appears anywhere in the correctness path — verdicts
// age in blocks, and every trigger is an event.
//
// The pile is how a node remembers it has already looked: a juror's newer
// verdict REPLACES its
// older one; an `abstain` suppresses re-checking only while the inability
// stands — it stops standing on a verdict arriving while healthy and on the
// juror's own sick-to-healthy transition, which must re-open every pile it
// abstained into. A `reachable` stands only while the connection it vouched
// for is current: once the duty is no longer held, the next wake-up probes
// again instead of trusting a stale answer. An `unreachable` stands until it
// ages out OR the duty is held again: a re-held connection is evidence the
// subject returned, and without it a second death inside the verdict
// lifetime would never be looked at (formal/deferral-courtesy, reheld-*).
//
// The drop carries its reason. A subject that stops on purpose closes the
// held connection with a code, and the juror honours it: no look until the
// grace for that code has run, and then only if the duty is still unheld.
// An unannounced drop is looked at now.

const GRACE_MS = Object.freeze({
  [DROP_REASON.SHUTDOWN]: NODE_DOWN_GRACE_MS,
  [DROP_REASON.RESTART]: RESTART_GRACE_MS,
});

class NodeDownJuror {
  /** @type {object} */
  #deps;

  /**
   * subjectOutpoint → Map<jurorOutpoint, verdict>. Holds our own reachable
   * and abstain answers too — those never travel and never count.
   * @type {Map<string, Map<string, object>>}
   */
  #piles = new Map();

  /** Subjects whose pile already produced a certificate at ≥H, so arrival
   *  floods do not re-assemble until the pile falls below H again. */
  #assembled = new Set();

  /** Subjects with a probe currently in flight — one look at a time. */
  #probing = new Set();

  /**
   * The honoured drops: subject → {reason, droppedAt, height, lookAt}. One
   * per subject — a newer coded drop replaces an older one, and the grace
   * runs from the newest. Spent by the look at the grace end, or by the
   * duty being held again.
   * @type {Map<string, {reason: string, droppedAt: number, height: number, lookAt: number}>}
   */
  #deferrals = new Map();

  /**
   * @param {object} deps
   * @param {() => object|null} deps.topology NodeDownTopology
   * @param {() => string|null} deps.myOutpoint
   * @param {(outpoint: string) => string|null} deps.resolveOutpoint
   * @param {(socketAddress: string) => Promise<boolean>} deps.probe one fresh
   *   dial, now; resolves reachability
   * @param {() => boolean} deps.healthy NetworkHealthMonitor verdict — an
   *   unhealthy juror abstains rather than accuses
   * @param {() => string|null} deps.myAddress this node's DETECTED public ip,
   *   never its listed one — the hairpin belt must see what the list cannot
   *   yet: the walk already excludes listed co-tenants, so comparing listed
   *   addresses here would be dead code
   * @param {(socketAddress: string) => boolean} deps.isHeld
   * @param {(payload: Buffer) => (string|Promise<string>)} deps.signVerdict
   * @param {(owner: string, payload: Buffer, signature: string) => boolean} deps.verifySignature
   * @param {(socketAddress: string, verdict: object) => void} deps.pushVerdict
   *   one-way, over an EPHEMERAL connection — never a peering
   * @param {() => number} deps.currentHeight the verifier's own chain height
   * @param {() => string|null} deps.currentFingerprint the membership our own
   *   verdicts and assemblies name
   * @param {(certificate: object) => void} deps.onCertificate a pile crossed H
   * @param {() => number} [deps.now] wall clock in ms — the graces are
   *   wall-clock constants, so the grace end is a known instant
   * @param {object} [options]
   * @param {number} [options.maxAgeBlocks]
   */
  constructor(deps, options = {}) {
    this.#deps = { now: () => Date.now(), ...deps };
    this.maxAgeBlocks = options.maxAgeBlocks ?? VERDICT_LIFETIME_BLOCKS;
  }

  /**
   * A duty connection dropped, with what the far end said about it. An
   * unannounced drop is looked at now. A coded drop is honoured: recorded,
   * and looked at once at the grace end if the duty is still unheld.
   *
   * @param {string} subject outpoint
   * @param {string} reason a DROP_REASON
   * @returns {{honoured: boolean}} whether the drop was honoured (deferred)
   */
  noteDrop(subject, reason) {
    const droppedAt = this.#deps.now();
    if (!(reason in GRACE_MS)) {
      this.#deferrals.delete(subject);
      this.look(subject, 'drop', { droppedAt, reason: DROP_REASON.UNANNOUNCED });
      return { honoured: false };
    }
    this.#deferrals.set(subject, {
      reason, droppedAt, height: this.#deps.currentHeight(), lookAt: droppedAt + GRACE_MS[reason],
    });
    return { honoured: true };
  }

  /**
   * The duty is held again. Whatever was owed about the subject is over:
   * the deferral, this juror's own standing answer, and the pile it may
   * have assembled — a later death is a new incident.
   *
   * @param {string} subject outpoint
   */
  noteHeld(subject) {
    this.#deferrals.delete(subject);
    this.#piles.delete(subject);
    this.#assembled.delete(subject);
  }

  #pileFor(subject) {
    let pile = this.#piles.get(subject);
    if (!pile) {
      pile = new Map();
      this.#piles.set(subject, pile);
    }
    return pile;
  }

  /** Drop verdicts the freshness bound has retired; a pile below H re-arms
   *  assembly. Called on every read path so aging needs no timer. */
  #prune(subject) {
    const pile = this.#piles.get(subject);
    if (!pile) return;
    const now = this.#deps.currentHeight();
    pile.forEach((verdict, juror) => {
      if (now - verdict.height > this.maxAgeBlocks) pile.delete(juror);
    });
    if (pile.size === 0) this.#piles.delete(subject);
  }

  /** Whether our recorded answer for `subject` still stands (step 3 rules). */
  #standing(subject) {
    const mine = this.#piles.get(subject)?.get(this.#deps.myOutpoint());
    if (!mine) return false;
    if (this.#deps.currentHeight() - mine.height > this.maxAgeBlocks) return false;
    if (mine.judgement === JUDGEMENT.ABSTAIN) return !this.#deps.healthy();
    if (mine.judgement === JUDGEMENT.REACHABLE) {
      const socketAddress = this.#deps.resolveOutpoint(subject);
      return socketAddress !== null && this.#deps.isHeld(socketAddress);
    }
    return true; // an unreachable verdict stands until it ages out
  }

  /**
   * Steps 2–4: self-check, one fresh dial, record, push if unreachable.
   * Serialised per subject — a probe in flight absorbs further triggers.
   *
   * @param {string} subject outpoint
   * @param {string} reason journal only
   * @param {{droppedAt: number, reason: string}|null} [drop] the drop this
   *   look answers, when it answers one — a wake-up or a lapse answers none
   * @returns {Promise<void>}
   */
  async look(subject, reason, drop = null) {
    const myOutpoint = this.#deps.myOutpoint();
    const topology = this.#deps.topology();
    if (!myOutpoint || !topology || subject === myOutpoint) return;
    if (this.#probing.has(subject)) return;

    // Only a juror may raise suspicion: X must be one of my duties.
    const duties = topology.duties(myOutpoint);
    if (!duties || !duties.some((duty) => duty.outpoint === subject)) return;

    this.#prune(subject);
    if (this.#standing(subject)) return;

    const height = this.#deps.currentHeight();
    const fingerprint = this.#deps.currentFingerprint();
    const socketAddress = this.#deps.resolveOutpoint(subject);
    if (!socketAddress) return;

    // Self-check: an unhealthy juror is probably the broken one — abstain.
    // So must a juror whose DETECTED address matches the subject's (the
    // hairpin belt): a NAT that cannot hairpin would sign a permanent false
    // unreachable. Detected, not listed — the walk already excludes listed
    // co-tenants, so this belt exists precisely for the window the list has
    // not caught up with.
    const myAddress = this.#deps.myAddress();
    const shareAddress = myAddress !== null && extractIp(socketAddress) === myAddress;
    if (!this.#deps.healthy() || shareAddress) {
      this.#record(subject, {
        subject, juror: myOutpoint, judgement: JUDGEMENT.ABSTAIN, height, fingerprint,
      });
      return;
    }

    this.#probing.add(subject);
    let reachable;
    try {
      reachable = await this.#deps.probe(socketAddress);
    } catch (error) {
      reachable = false;
    } finally {
      this.#probing.delete(subject);
    }

    if (reachable) {
      // The loss was local — record it so later arrivals don't send us
      // probing again, and send nothing: a blip costs the network zero.
      this.#record(subject, {
        subject, juror: myOutpoint, judgement: JUDGEMENT.REACHABLE, height, fingerprint,
      });
      return;
    }

    const verdict = {
      subject,
      juror: myOutpoint,
      judgement: JUDGEMENT.UNREACHABLE,
      height,
      fingerprint,
      // the drop this look answers travels with the verdict, signed
      ...(drop ? { droppedAt: drop.droppedAt, reason: drop.reason } : {}),
    };
    const payload = verdictPayload(verdict);
    if (payload === null) return;
    verdict.signature = await this.#deps.signVerdict(payload);
    this.#record(subject, verdict);
    log.info(`nodeDownJuror: ${subject} unreachable at ${height} (${reason}${drop ? `, ${drop.reason} drop` : ''}); pushing to its jury`);

    // Push one-way to the other jurors, ephemeral transport (wire contract:
    // a verdict on a peering is silently ignored at the far end).
    (topology.jury(subject) || []).forEach((juror) => {
      if (juror.outpoint === myOutpoint) return;
      const target = this.#deps.resolveOutpoint(juror.outpoint);
      if (target) this.#deps.pushVerdict(target, verdict);
    });
  }

  #record(subject, verdict) {
    this.#pileFor(subject).set(verdict.juror, verdict);
    this.#maybeAssemble(subject);
  }

  /**
   * Step 6: validate an arriving verdict, pile it, and let it wake us
   * (step 5 — load-bearing: pure push stalls below H without it).
   *
   * @param {object} verdict
   * @returns {{piled: boolean, reason: string}}
   */
  onVerdictArrived(verdict) {
    const topology = this.#deps.topology();
    const myOutpoint = this.#deps.myOutpoint();
    if (!topology || !myOutpoint) return { piled: false, reason: 'not_ready' };

    if (!verdict || verdict.judgement !== JUDGEMENT.UNREACHABLE || !verdict.signature) {
      return { piled: false, reason: 'malformed' };
    }
    const payload = verdictPayload(verdict);
    if (payload === null) return { piled: false, reason: 'malformed' };

    // Only verdicts about MY duties reach my pile — anyone else's subject is
    // not mine to certify and the verdict is dropped, not stored.
    const duties = topology.duties(myOutpoint);
    if (!duties || !duties.some((duty) => duty.outpoint === verdict.subject)) {
      return { piled: false, reason: 'not_my_duty' };
    }

    const now = this.#deps.currentHeight();
    if (
      verdict.height > now + FUTURE_BLOCKS_TOLERANCE
      || now - verdict.height > this.maxAgeBlocks
    ) {
      return { piled: false, reason: 'stale' };
    }

    // Signer must be in watchers(subject) as THIS juror computes them at the
    // verdict's named fingerprint, and the signature must be that owner's.
    const watchers = topology.juryAt(verdict.fingerprint, verdict.subject);
    if (watchers === null) return { piled: false, reason: 'unknown_fingerprint' };
    const signer = watchers.find((watcher) => watcher.outpoint === verdict.juror);
    if (!signer) return { piled: false, reason: 'not_a_watcher' };
    if (!this.#deps.verifySignature(signer.owner, payload, verdict.signature)) {
      return { piled: false, reason: 'bad_signature' };
    }

    this.#record(verdict.subject, verdict);

    // The wake-up: an arrival triggers our own look, once per standing answer.
    this.look(verdict.subject, 'wake-up');
    return { piled: true, reason: 'piled' };
  }

  /** The juror's own sick-to-healthy transition re-opens every pile it
   *  abstained into — under collectors a non-collector juror receives no
   *  verdicts, so this transition is the only event it gets. */
  onHealthRecovered() {
    const myOutpoint = this.#deps.myOutpoint();
    if (!myOutpoint) return;
    this.#piles.forEach((pile, subject) => {
      const mine = pile.get(myOutpoint);
      if (mine && mine.judgement === JUDGEMENT.ABSTAIN) {
        this.look(subject, 'health-recovered');
      }
    });
  }

  /** Step 7: whoever's pile first holds H valid verdicts from distinct owners
   *  assembles — the pile IS the certificate. Re-arms when aging drops it
   *  below H. */
  #maybeAssemble(subject) {
    this.#prune(subject);
    const topology = this.#deps.topology();
    const myOutpoint = this.#deps.myOutpoint();
    const pile = this.#piles.get(subject);
    if (!topology || !pile) return;

    const fingerprint = this.#deps.currentFingerprint();
    const jury = topology.juryAt(fingerprint, subject);
    if (jury === null || !jury.length) return;

    const needed = quorumThreshold(jury.length);
    const distinct = new Set();
    pile.forEach((verdict) => {
      if (verdict.judgement !== JUDGEMENT.UNREACHABLE || !verdict.signature) return;
      const watcher = jury.find((juror) => juror.outpoint === verdict.juror);
      if (watcher) distinct.add(watcher.owner);
    });
    if (distinct.size < needed) {
      this.#assembled.delete(subject);
      return;
    }
    if (this.#assembled.has(subject)) return;

    const sameJury = topology.sameJuryFor(subject, fingerprint);
    const cotenants = topology.cotenants(subject, jury);
    const certificate = assemble(
      subject,
      myOutpoint,
      this.#deps.currentHeight(),
      fingerprint,
      [...pile.values()],
      jury,
      sameJury || new Set([fingerprint]),
      cotenants,
    );
    if (!certificate) return;

    // A node must never gossip what it would itself refuse (assembly mirrors
    // verification; this is the belt on that mirror).
    const verdictOk = verifyCertificate(
      certificate,
      jury,
      sameJury || new Set([fingerprint]),
      this.#deps.verifySignature,
      this.#deps.currentHeight(),
      this.maxAgeBlocks,
      cotenants,
    );
    if (!verdictOk.accepted) {
      log.warn(`nodeDownJuror: own assembly for ${subject} failed verification (${verdictOk.reason}) — not gossiped`);
      return;
    }

    this.#assembled.add(subject);
    this.#deps.onCertificate(certificate);
  }

  /**
   * The wiring's periodic housekeeping: the looks the honoured drops owe
   * once their grace has ended, and the prune of every pile against the
   * current height. The grace-end look is the one thing here correctness
   * depends on — it is the first pass after a known instant, not a wait for
   * information.
   */
  sweep() {
    const now = this.#deps.now();
    [...this.#deferrals.entries()].forEach(([subject, deferral]) => {
      if (now < deferral.lookAt) return;
      this.#deferrals.delete(subject);
      const socketAddress = this.#deps.resolveOutpoint(subject);
      if (socketAddress !== null && this.#deps.isHeld(socketAddress)) return;
      this.look(subject, 'grace-end', { droppedAt: deferral.droppedAt, reason: deferral.reason });
    });
    [...this.#piles.keys()].forEach((subject) => this.#maybeAssemble(subject));
  }

  /** Observability. */
  snapshot() {
    const piles = {};
    this.#piles.forEach((pile, subject) => {
      piles[subject] = Object.fromEntries(
        [...pile.entries()].map(([juror, verdict]) => [juror, verdict.judgement]),
      );
    });
    return { piles, assembled: [...this.#assembled], deferrals: Object.fromEntries(this.#deferrals) };
  }
}

module.exports = {
  NodeDownJuror,
  DROP_REASON,
};
