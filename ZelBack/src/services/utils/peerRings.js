'use strict';

const crypto = require('crypto');

// The node-down jury construction: M distinct owners walked over R hash rings
// (network-liveness/PEER_SELECTION_K_RINGS.md §3, §3.7; NODE_DOWN_CERTIFICATES.md §6.2).
// Pure — no I/O, no config, no clock. Every value here is a protocol constant: every
// node must compute the identical jury, duty set and quorum from the same list, so
// none of this may ever come from local configuration.
//
// The reference implementation is flux-peer-sim's peering.py, verified against a second
// (Rust) implementation; tests/unit/fixtures/rings-fixture.json carries its answers and
// this module must match them exactly. Two implementations that disagree about jury
// membership do not fail a test on their own — they evict different nodes.

const M_OWNERS = 14;
// Rings walked. Derived, not fitted: the walk takes exactly one juror from each ring,
// so it needs precisely as many rings as jurors.
const RING_BUDGET = M_OWNERS;
// §3.7 top-up floor: below this a node dials extra non-witness targets, because
// outbound is allocated by other nodes' walks and thin nodes are handed fewer.
const OUTBOUND_FLOOR = 12;

/**
 * Verdicts needed to certify a subject down: H = ceil(2/3 · |jury|), floored at 2.
 *
 * Derived from the subject's own jury, never fixed: a fleet below 15 owners
 * legitimately has smaller juries (§3.4) and a fixed H would fail them for having
 * been sized correctly. The floor means a jury of one cannot certify at all — a
 * single hairpin-failed probe must never be a quorum (formal/verdict-churn).
 *
 * @param {number} jurySize
 * @returns {number}
 */
function quorumThreshold(jurySize) {
  return Math.max(Math.ceil((2 * jurySize) / 3), 2);
}

/**
 * The derived inbound connection limit: max(16, min(N/160, 36)), truncated.
 * The same formula FluxPeerManager's inbound gate computes inline; at any fleet
 * below ~2,560 nodes it sits at the floor of 16 against a jury of 14.
 *
 * @param {number} fleetSize
 * @returns {number}
 */
function inboundCap(fleetSize) {
  const floor = 16;
  const ceiling = 36;
  const derived = fleetSize / 160;
  return Math.trunc(Math.max(floor, derived < ceiling ? derived : ceiling));
}

/**
 * @typedef {object} RingNode
 * @property {string} key node identity — what juries and duties are keyed by
 * @property {string} owner per-operator identity (the list's pubkey); one owner
 *   holds at most one jury slot
 * @property {string} addr public address WITHOUT port — the shared-address and
 *   hairpin exclusions compare on this
 * @property {string} outpoint collateral outpoint `txhash:outidx` — immutable,
 *   what ring positions hash
 */

/**
 * The ring topology over one committed node list. Construction sorts the list
 * R times by sha256("<ring>:<outpoint>"), so the orderings are a pure function
 * of the list and identical on every node.
 *
 * Instances are immutable views of one membership; build a new one per list
 * transition rather than mutating.
 */
class PeerRings {
  /** @type {RingNode[]} */
  #nodes;

  /** @type {Map<string, RingNode>} */
  #byKey = new Map();

  /** @type {RingNode[][]} */
  #rings = [];

  /** @type {Map<string, number>[]} */
  #ringPos = [];

  /** @type {Map<string, RingNode[]>} */
  #jury = new Map();

  /** @type {Map<string, RingNode[]> | null} */
  #duty = null;

  /**
   * @param {RingNode[]} nodes the committed node list
   */
  constructor(nodes) {
    this.#nodes = [...nodes];
    this.#nodes.forEach((node) => this.#byKey.set(node.key, node));
    for (let r = 0; r < RING_BUDGET; r += 1) {
      const ordered = this.#nodes
        .map((node) => ({
          node,
          sortKey: crypto.createHash('sha256').update(`${r}:${node.outpoint}`).digest(),
        }))
        .sort((a, b) => Buffer.compare(a.sortKey, b.sortKey))
        .map((entry) => entry.node);
      this.#rings.push(ordered);
      this.#ringPos.push(new Map(ordered.map((node, i) => [node.key, i])));
    }
  }

  /**
   * @param {string} key
   * @returns {RingNode | undefined}
   */
  get(key) {
    return this.#byKey.get(key);
  }

  /**
   * The M distinct owners assigned to watch `subject` — its guaranteed inbound.
   * In walk order, memoised; a pure function of the list.
   *
   * In each ring, step backwards from the subject until a candidate is eligible:
   * not the subject's owner (an operator never votes on itself — also the
   * hairpinning defence), not the subject's address, not an owner already
   * collected. The ring is SCANNED, never abandoned: skipping to the next ring on
   * a collision would bound the jury by the ring count and silently lower H on
   * networks holding eligible owners to spare.
   *
   * @param {RingNode} subject
   * @returns {RingNode[]}
   */
  jury(subject) {
    const cached = this.#jury.get(subject.key);
    if (cached) return cached;
    const picked = [];
    const seen = new Set();
    const n = this.#nodes.length;
    for (let r = 0; r < this.#rings.length; r += 1) {
      const idx = this.#ringPos[r].get(subject.key);
      if (idx === undefined) continue;
      const ring = this.#rings[r];
      for (let step = 1; step < n; step += 1) {
        const cand = ring[(((idx - step) % n) + n) % n];
        if (cand.key === subject.key) break;
        if (cand.owner === subject.owner || cand.addr === subject.addr) continue;
        if (seen.has(cand.owner)) continue;
        seen.add(cand.owner);
        picked.push(cand);
        break;
      }
      if (picked.length === M_OWNERS) break;
    }
    this.#jury.set(subject.key, picked);
    return picked;
  }

  /**
   * The subjects `me` is a juror for — its outbound duties, allocated by everyone
   * else's walk. Built by inverting every jury once; the per-caller scan is
   * O(N·R) and does not scale.
   *
   * @param {RingNode} me
   * @returns {RingNode[]}
   */
  duties(me) {
    if (!this.#duty) {
      const index = new Map(this.#nodes.map((node) => [node.key, []]));
      this.#nodes.forEach((subject) => {
        this.jury(subject).forEach((juror) => {
          index.get(juror.key).push(subject);
        });
      });
      this.#duty = index;
    }
    return this.#duty.get(me.key) || [];
  }

  /**
   * Whether observations of `otherKey` may feed suspicion: is that node in my
   * jury, or am I in its? Answerable at any instant from the list alone —
   * deliberately independent of which code path opened the socket.
   *
   * @param {RingNode} me
   * @param {string} otherKey
   * @returns {boolean}
   */
  isWitnessRelation(me, otherKey) {
    if (this.jury(me).some((node) => node.key === otherKey)) return true;
    return this.duties(me).some((node) => node.key === otherKey);
  }

  /**
   * Deterministic top-up targets — successors, walked the opposite way to a jury,
   * one per ring, distinct addresses. Scanned rather than abandoned so the §3.7
   * floor stays reachable when early candidates are excluded.
   *
   * MUTATES `exclude`: every pick is added, so a caller composing walks never
   * re-picks a candidate.
   *
   * @param {RingNode} me
   * @param {number} want
   * @param {Set<string>} exclude keys never to pick; grows with each pick
   * @returns {RingNode[]}
   */
  ringSuccessors(me, want, exclude) {
    const out = [];
    const n = this.#nodes.length;
    const seenAddr = new Set();
    for (let r = 0; r < this.#rings.length; r += 1) {
      if (out.length >= want) break;
      const idx = this.#ringPos[r].get(me.key);
      if (idx === undefined) continue;
      const ring = this.#rings[r];
      for (let step = 1; step < n; step += 1) {
        const cand = ring[(idx + step) % n];
        if (cand.key === me.key) break;
        // Distinct addresses, or minUniqueIpsOutgoing stays unsatisfiable.
        if (exclude.has(cand.key) || cand.addr === me.addr || seenAddr.has(cand.addr)) continue;
        seenAddr.add(cand.addr);
        exclude.add(cand.key);
        out.push(cand);
        break;
      }
    }
    return out;
  }
}

module.exports = {
  M_OWNERS,
  RING_BUDGET,
  OUTBOUND_FLOOR,
  quorumThreshold,
  inboundCap,
  PeerRings,
};
