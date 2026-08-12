'use strict';

const crypto = require('crypto');
const config = require('config');

// The membership history: what the node list WAS, provable for a bounded
// window. A committee is only a committee if everyone agrees which list it
// was computed from, and "the current list" is not one list — every node
// holds it at its own height. So each list transition is recorded as an
// invertible delta between fingerprints, and any fingerprint inside the
// retained window can be rebuilt exactly and walked exactly.
//
// The fingerprint commits to precisely what committee selection consumes —
// the collateral outpoint (ranking position), the pubkey (owner grouping),
// and the address (the shared-address and fault-domain exclusions) — the
// (outpoint, pubkey, ip) triple rule from the certificates design, adopted
// verbatim. An address change alters no outpoint, so a fingerprint over
// outpoints alone would miss it and the history could not reconstruct who a
// walk excluded; that defect is why the triple is the unit.
//
// Retention is wall-bounded (~150 minutes — the location TTL plus formation
// margin) and count-bounded as a backstop. Outside the window the answer is
// null, never a guess: a fingerprint this node cannot rebuild is a committee
// this node cannot verify membership of, and refusing is the honest answer
// (strict verification, no tolerance matching).

const OUTPOINT = (triple) => `${triple.txhash}:${triple.outidx}`;

function retentionMs() {
  return config.fluxapps.membershipHistoryRetentionMs ?? 150 * 60 * 1000;
}

function maxEntries() {
  return config.fluxapps.membershipHistoryMaxEntries ?? 4000;
}

/**
 * The membership-relevant projection of one node record. Everything else on
 * the record (tier, heights, payment data) moves without moving committees,
 * and committing to it would churn fingerprints for reasons no walk can see.
 *
 * @param {object} node deterministic-list node
 * @returns {{txhash: string, outidx: string, pubkey: string, ip: string}}
 */
function tripleOf(node) {
  return {
    txhash: node.txhash,
    outidx: String(node.outidx),
    pubkey: node.pubkey,
    ip: node.ip,
  };
}

/**
 * The fingerprint of one membership: sha256 over the sorted triple lines.
 *
 * @param {Iterable<object>} triples membership triples
 * @returns {string} hex fingerprint
 */
function fingerprintOf(triples) {
  const lines = [];
  for (const triple of triples) {
    lines.push(`${OUTPOINT(triple)}|${triple.pubkey}|${triple.ip}`);
  }
  lines.sort();
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

class MembershipHistory {
  /**
   * Oldest first. Each entry is one transition:
   * {parentFingerprint, childFingerprint, height, hash, at,
   *  added: [triple], removed: [triple], changed: [{before, after}]}
   */
  #entries = [];

  /** @type {{fingerprint: string, byOutpoint: Map<string, object>} | null} */
  #current = null;

  /**
   * Record the membership a state change produced. Diffing happens against
   * the previously RECORDED membership, never against live node references —
   * the state manager mutates records in place, and a diff against a mutated
   * "before" would record no change at all.
   *
   * @param {Array<object>} nodes the full node list after the change
   * @param {{height: number, hash: string}} anchor the block the list now sits at
   * @param {number} [atMs] wall clock of the recording, injectable for tests
   * @returns {string} the fingerprint now current
   */
  record(nodes, anchor, atMs = Date.now()) {
    const byOutpoint = new Map();
    (nodes || []).forEach((node) => {
      if (!node || !node.txhash || node.outidx === undefined || node.outidx === null) return;
      const triple = tripleOf(node);
      byOutpoint.set(OUTPOINT(triple), triple);
    });
    const fingerprint = fingerprintOf(byOutpoint.values());

    if (!this.#current) {
      this.#current = { fingerprint, byOutpoint };
      return fingerprint;
    }
    if (this.#current.fingerprint === fingerprint) {
      // blocks that change nothing membership-relevant produce no entry —
      // tier and height churn must not shrink the reconstructable window
      return fingerprint;
    }

    const previous = this.#current.byOutpoint;
    const added = [];
    const changed = [];
    byOutpoint.forEach((triple, outpoint) => {
      const before = previous.get(outpoint);
      if (!before) {
        added.push(triple);
      } else if (before.pubkey !== triple.pubkey || before.ip !== triple.ip) {
        changed.push({ before, after: triple });
      }
    });
    const removed = [];
    previous.forEach((triple, outpoint) => {
      if (!byOutpoint.has(outpoint)) removed.push(triple);
    });

    this.#entries.push({
      parentFingerprint: this.#current.fingerprint,
      childFingerprint: fingerprint,
      height: anchor?.height ?? null,
      hash: anchor?.hash ?? null,
      at: atMs,
      added,
      removed,
      changed,
    });
    this.#current = { fingerprint, byOutpoint };
    this.#prune(atMs);
    return fingerprint;
  }

  #prune(nowMs) {
    const oldestAllowed = nowMs - retentionMs();
    while (
      this.#entries.length
      && (this.#entries[0].at < oldestAllowed || this.#entries.length > maxEntries())
    ) {
      this.#entries.shift();
    }
  }

  /** @returns {string|null} the fingerprint of the membership held now */
  currentFingerprint() {
    return this.#current?.fingerprint ?? null;
  }

  /**
   * The membership at a fingerprint, or null when it falls outside the
   * retained window. The walk starts from the current membership and applies
   * each entry's inverse, newest first, until the target is reached — so the
   * cost is proportional to how far back the fingerprint is, and the answer
   * is exact or absent, never approximate.
   *
   * @param {string} fingerprint
   * @returns {Array<object>|null} membership triples, walkable by the
   *   committee selector (txhash, outidx, pubkey, ip)
   */
  membershipAt(fingerprint) {
    if (!this.#current || !fingerprint) return null;

    if (fingerprint === this.#current.fingerprint) {
      return [...this.#current.byOutpoint.values()];
    }

    const state = new Map(this.#current.byOutpoint);
    for (let i = this.#entries.length - 1; i >= 0; i -= 1) {
      const entry = this.#entries[i];
      entry.added.forEach((triple) => state.delete(OUTPOINT(triple)));
      entry.removed.forEach((triple) => state.set(OUTPOINT(triple), triple));
      entry.changed.forEach(({ before }) => state.set(OUTPOINT(before), before));
      if (entry.parentFingerprint === fingerprint) {
        return [...state.values()];
      }
    }
    return null;
  }

  /**
   * The fingerprint that was current AT a height: the newest recorded
   * transition at or below it. How a founding ask resolves its app's
   * registration height to the committee basis it must name.
   *
   * @param {number} height
   * @returns {string|null} null when the height precedes the window or
   *   nothing is recorded
   */
  fingerprintAt(height) {
    if (!this.#current) return null;
    for (let i = this.#entries.length - 1; i >= 0; i -= 1) {
      const entry = this.#entries[i];
      if (entry.height !== null && entry.height <= height) {
        return entry.childFingerprint;
      }
    }
    // no transition at or below the height is knowable only as "the window
    // does not reach back that far" — unless nothing was ever recorded past
    // the seed, in which case the seed membership is all there has ever been
    return this.#entries.length ? null : this.#current.fingerprint;
  }

  /** How many transitions the window currently holds — an observability hook. */
  entryCount() {
    return this.#entries.length;
  }

  reset() {
    this.#entries = [];
    this.#current = null;
  }
}

module.exports = {
  MembershipHistory,
  fingerprintOf,
  tripleOf,
};
