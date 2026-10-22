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
// assembly out. Verdicts age in blocks and every trigger is an event; the one
// instant the juror itself owes, the grace end of an honoured drop, is
// scheduled once at the drop and cancelled by the duty being held again.
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

// THE COURTESY. An honoured stop leaves no row anywhere, which is what makes
// it cheap and what makes it invisible to the rungs. A code is honoured only
// with the subject's signed stop statement (utils/processIdentity), and only
// so many times in the window; beyond that the juror looks at the drop as
// for an unannounced death, and the certificate forms with the real reason
// on it. Generous on purpose (2026-09-02): a release plus a hardware job is
// two reboots and costs nothing; tuned down in a release once the fleet
// shows what normal looks like.
//
// THE COUNT IS THE JURY'S, NOT THIS JUROR'S. A juror that missed a close
// would count fewer than the rest and honour a stop they refuse, and the
// certificate would fall short. So the count is the distinct signed stops
// this juror holds, whether it saw the close or another juror forwarded the
// statement; one forward is enough, because only the subject can sign one.
// Each stop is dated by when this juror first held it, on its own clock, so
// no node's clock decides whether another's stops count. A forward is
// accepted up to STOP_FORWARD_AGE_MS after the time the subject signed, and
// an honest subject's clock is within STOP_CLOSE_AGE_MS of the juror's, so a
// stop is first held at most their sum after its close. The window ends
// COURTESY_EARLY_EDGE_MS (more than that sum) early: a stop is never counted
// past the true window, and where jurors disagree near its edge they
// disagree leniently.
const SHUTDOWN_COURTESY = 4;
const RESTART_COURTESY = 12;
const COURTESY_WINDOW_MS = 24 * 60 * 60 * 1000;
// A statement on the closing connection counts only within this of the
// juror's clock: the network's message age.
const STOP_CLOSE_AGE_MS = 5 * 60 * 1000;
// A forwarded statement counts within this of the receiver's clock: room
// for one juror's acceptance at the close plus the jurors' clock difference
// and the forward's delivery.
const STOP_FORWARD_AGE_MS = 2 * STOP_CLOSE_AGE_MS;
const COURTESY_EARLY_EDGE_MS = 2 * STOP_FORWARD_AGE_MS;

const COURTESY = Object.freeze({
  [DROP_REASON.SHUTDOWN]: SHUTDOWN_COURTESY,
  [DROP_REASON.RESTART]: RESTART_COURTESY,
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

  /** subject → the handle of the look scheduled for its grace end. */
  #lookTimers = new Map();

  /**
   * The signed stops held: subject → reason → processId → {learnedAt,
   * statement}, learnedAt this juror's clock when it first held the
   * statement. Duties only; gone with the process.
   * @type {Map<string, Object<string, Map<string, {learnedAt: number, statement: object|null}>>>}
   */
  #courtesy = new Map();

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
   * @param {(socketAddress: string, statement: object) => void} [deps.pushNote]
   *   a subject's signed stop statement to another of its jurors, the same
   *   way
   * @param {() => number} deps.currentHeight the verifier's own chain height
   * @param {() => string|null} deps.currentFingerprint the membership our own
   *   verdicts and assemblies name
   * @param {(certificate: object) => void} deps.onCertificate a pile crossed H
   * @param {() => number} [deps.now] wall clock in ms — the graces are
   *   wall-clock constants, so the grace end is a known instant
   * @param {(fn: () => void, ms: number) => *} [deps.schedule] run `fn` once
   *   after `ms`; answers a handle for `cancel`
   * @param {(handle: *) => void} [deps.cancel]
   * @param {(subject: string) => Promise<number|undefined>} [deps.nextDeath]
   *   which death of the subject a verdict cast now would name: the highest
   *   number this node has seen certified for it, plus one. Undefined when
   *   the store cannot say; the verdict then names none and the assembly
   *   takes the number from the jurors that can
   * @param {object} [options]
   * @param {number} [options.maxAgeBlocks]
   */
  constructor(deps, options = {}) {
    this.#deps = {
      now: () => Date.now(),
      schedule: (fn, ms) => {
        const handle = setTimeout(fn, ms);
        if (handle.unref) handle.unref();
        return handle;
      },
      cancel: (handle) => clearTimeout(handle),
      ...deps,
    };
    this.maxAgeBlocks = options.maxAgeBlocks ?? VERDICT_LIFETIME_BLOCKS;
  }

  /**
   * A duty connection dropped, with what the far end said about it. An
   * unannounced drop is looked at now, and so is a coded one that carried no
   * accepted stop statement. A coded drop with one is honoured while the
   * courtesy lasts: recorded, and looked at once at the grace end if the
   * duty is still unheld.
   *
   * @param {string} subject outpoint
   * @param {string} reason a DROP_REASON
   * @param {{processId: string, statement: object}|null} [stop] the stop
   *   statement accepted on the closing connection
   * @returns {{honoured: boolean}} whether the drop was honoured (deferred)
   */
  noteDrop(subject, reason, stop = null) {
    const droppedAt = this.#deps.now();
    this.#spendDeferral(subject);
    const coded = reason in GRACE_MS;
    if (coded && !stop) {
      log.info(`nodeDownJuror - ${subject}: ${reason} close carried no accepted stop statement; looked at as unannounced`);
    }
    if (!coded || !stop || !this.#honours(subject, reason, stop)) {
      this.look(subject, 'drop', { droppedAt, reason: coded && stop ? reason : DROP_REASON.UNANNOUNCED });
      return { honoured: false };
    }
    this.#deferrals.set(subject, {
      reason, droppedAt, height: this.#deps.currentHeight(), lookAt: droppedAt + GRACE_MS[reason],
    });
    this.#lookTimers.set(subject, this.#deps.schedule(() => this.#graceEnd(subject), GRACE_MS[reason]));
    return { honoured: true };
  }

  /** The deferral and the look it owed, both gone. */
  #spendDeferral(subject) {
    this.#deferrals.delete(subject);
    const handle = this.#lookTimers.get(subject);
    if (handle === undefined) return;
    this.#lookTimers.delete(subject);
    this.#deps.cancel(handle);
  }

  /**
   * The grace end of an honoured drop: the one look it owes, if the duty is
   * still unheld. A re-held duty spent the deferral already.
   */
  #graceEnd(subject) {
    this.#lookTimers.delete(subject);
    const deferral = this.#deferrals.get(subject);
    if (!deferral) return;
    this.#deferrals.delete(subject);
    const socketAddress = this.#deps.resolveOutpoint(subject);
    if (socketAddress !== null && this.#deps.isHeld(socketAddress)) return;
    this.look(subject, 'grace-end', { droppedAt: deferral.droppedAt, reason: deferral.reason });
  }

  /**
   * Whether the stop being closed is honoured: fewer than the courtesy's
   * signed stops in the window, not counting this one. This one is held
   * after the decision, honoured or not.
   */
  #honours(subject, reason, stop) {
    const held = this.#stopsHeld(subject, reason);
    const counted = [...held.keys()].filter((id) => id !== stop.processId).length;
    this.learnStop(subject, reason, stop);
    if (counted >= COURTESY[reason]) {
      log.info(`nodeDownJuror - ${subject}: ${reason} close not honoured, ${counted} signed stops already in the window (courtesy ${COURTESY[reason]})`);
      return false;
    }
    log.info(`nodeDownJuror - ${subject}: ${reason} close honoured (${counted + 1} of ${COURTESY[reason]} in the window)`);
    return true;
  }

  /** The subject's signed stops for this reason still inside the window. */
  #stopsHeld(subject, reason) {
    let stops = this.#courtesy.get(subject);
    if (!stops) {
      stops = { [DROP_REASON.SHUTDOWN]: new Map(), [DROP_REASON.RESTART]: new Map() };
      this.#courtesy.set(subject, stops);
    }
    const edge = this.#deps.now() - (COURTESY_WINDOW_MS - COURTESY_EARLY_EDGE_MS);
    stops[reason].forEach(({ learnedAt }, id) => {
      if (learnedAt <= edge) stops[reason].delete(id);
    });
    return stops[reason];
  }

  /**
   * Hold a signed stop of the subject, dated now on this juror's clock, and
   * forward a stop new to this juror to the subject's other jurors: one
   * juror that held it is enough for every juror to count it.
   *
   * @param {string} subject outpoint
   * @param {string} reason DROP_REASON.SHUTDOWN or DROP_REASON.RESTART
   * @param {{processId: string, statement: object|null}} stop
   * @returns {boolean} whether it was new to this juror
   */
  learnStop(subject, reason, stop) {
    const held = this.#stopsHeld(subject, reason);
    if (held.has(stop.processId)) return false;
    held.set(stop.processId, { learnedAt: this.#deps.now(), statement: stop.statement ?? null });
    if (stop.statement && this.#deps.pushNote) this.#forward(subject, stop.statement);
    return true;
  }

  /** A signed stop to every other juror of the subject. */
  #forward(subject, statement) {
    const myOutpoint = this.#deps.myOutpoint();
    const topology = this.#deps.topology();
    if (!topology) return;
    (topology.jury(subject) || []).forEach((juror) => {
      if (juror.outpoint === myOutpoint) return;
      const target = this.#deps.resolveOutpoint(juror.outpoint);
      if (target) this.#deps.pushNote(target, statement);
    });
  }

  /**
   * Another juror forwarded a signed stop of the subject, already checked
   * as the subject's own and within the forward age. Held only for this
   * node's duties.
   *
   * @param {string} subject outpoint
   * @param {string} reason DROP_REASON.SHUTDOWN or DROP_REASON.RESTART
   * @param {{processId: string, statement: object}} stop
   * @returns {{held: boolean, reason: string}}
   */
  onNote(subject, reason, stop) {
    const topology = this.#deps.topology();
    const myOutpoint = this.#deps.myOutpoint();
    if (!topology || !myOutpoint) return { held: false, reason: 'not_ready' };
    const duties = topology.duties(myOutpoint);
    if (!duties || !duties.some((duty) => duty.outpoint === subject)) {
      return { held: false, reason: 'not_my_duty' };
    }
    if (!this.learnStop(subject, reason, stop)) return { held: false, reason: 'already_held' };
    return { held: true, reason: 'held' };
  }

  /**
   * Keep the courtesy memory of these duties only; the list has moved the
   * rest away.
   * @param {Set<string>} outpoints the duties still owed
   */
  retain(outpoints) {
    [...this.#courtesy.keys()].forEach((subject) => {
      if (outpoints.has(subject)) return;
      this.#courtesy.delete(subject);
      log.info(`nodeDownJuror - ${subject} left this node's duties; its courtesy record is dropped`);
    });
    [...this.#deferrals.keys()].forEach((subject) => {
      if (!outpoints.has(subject)) this.#spendDeferral(subject);
    });
  }

  /** Cancel every look still owed; the engine is going away. */
  stop() {
    [...this.#deferrals.keys()].forEach((subject) => this.#spendDeferral(subject));
  }

  /**
   * The duty is held again. Whatever was owed about the subject is over:
   * the deferral, this juror's own standing answer, and the pile it may
   * have assembled — a later death is a new incident.
   *
   * @param {string} subject outpoint
   */
  noteHeld(subject) {
    this.#spendDeferral(subject);
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

    // R2: no probe and no verdict inside an honoured grace, whatever wakes
    // us. The two looks that may come sooner — an unannounced drop, and the
    // grace end itself — spend the deferral before they call. A wake-up or
    // a lapse while it stands is declined: one juror that lost the close
    // frame cannot pull a jury holding the code into certifying an
    // announced stop.
    if (this.#deferrals.has(subject)) return;

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

    // Which death this is, as this juror counts them — signed, so the
    // certificate's number is the middle of its quorum and nothing the
    // subject or an assembler supplies.
    const death = this.#deps.nextDeath ? await this.#deps.nextDeath(subject) : undefined;
    const verdict = {
      subject,
      juror: myOutpoint,
      judgement: JUDGEMENT.UNREACHABLE,
      height,
      fingerprint,
      ...(Number.isInteger(death) && death > 0 ? { death } : {}),
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
    // A pile that aged below H since it last assembled re-arms before this
    // verdict lands, so the verdict that refills it assembles again.
    this.#maybeAssemble(subject);
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
  SHUTDOWN_COURTESY,
  RESTART_COURTESY,
  COURTESY_WINDOW_MS,
  COURTESY_EARLY_EDGE_MS,
  STOP_CLOSE_AGE_MS,
  STOP_FORWARD_AGE_MS,
};
