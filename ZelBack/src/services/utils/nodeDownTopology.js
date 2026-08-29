'use strict';

const { PeerRings } = require('./peerRings');
const { extractIp } = require('./socketAddressUtils');

// The ring topology over the LIVE node list: jury and duty reads on the
// current membership for the peering layer, and at-fingerprint juries for
// certificate verification: a certificate is verified against the list it
// NAMES, rebuilt exactly or refused. Every view is keyed by the
// fingerprint it was built from, so a membership move can never serve a stale
// jury; an unrebuildable fingerprint answers null, never a substitution.
//
// Nodes are identified by collateral OUTPOINT throughout — the immutable name
// that certificates carry. The walk's owner is the list's pubkey and
// its address is the ip WITHOUT port, so co-tenants on one machine exclude
// each other whatever ports they serve.

// At-fingerprint ring builds are cached per fingerprint; the retained window
// bounds how many can exist, this bounds what we keep.
const AT_CACHE_LIMIT = 24;

/**
 * The walk's projection of one list record (Fluxnode or membership triple).
 *
 * @param {{txhash: string, outidx: number|string, pubkey: string, ip: string}} record
 * @returns {import('./peerRings').RingNode}
 */
function ringNodeOf(record) {
  const outpoint = `${record.txhash}:${record.outidx}`;
  return {
    key: outpoint,
    outpoint,
    owner: record.pubkey,
    addr: extractIp(record.ip),
  };
}

class NodeDownTopology {
  /** @type {() => Array<object>} */
  #nodes;

  /** @type {import('./membershipHistory').MembershipHistory} */
  #history;

  /** @type {{fingerprint: string|null, rings: PeerRings, byOutpoint: Map<string, object>} | null} */
  #current = null;

  /** @type {Map<string, PeerRings|null>} */
  #atCache = new Map();

  /**
   * @param {object} deps
   * @param {() => Array<object>} deps.nodes the live node list
   * @param {import('./membershipHistory').MembershipHistory} deps.membershipHistory
   *   the SAME history the state manager feeds; two fingerprint
   *   implementations that could disagree would be two committees
   */
  constructor({ nodes, membershipHistory }) {
    this.#nodes = nodes;
    this.#history = membershipHistory;
  }

  #currentView() {
    const fingerprint = this.#history.currentFingerprint();
    if (this.#current && this.#current.fingerprint === fingerprint && fingerprint !== null) {
      return this.#current;
    }
    const ringNodes = (this.#nodes() || [])
      .filter((node) => node && node.txhash && node.outidx !== undefined && node.outidx !== null)
      .map(ringNodeOf);
    this.#current = {
      fingerprint,
      rings: new PeerRings(ringNodes),
      byOutpoint: new Map(ringNodes.map((node) => [node.outpoint, node])),
    };
    return this.#current;
  }

  /**
   * @param {string} fingerprint
   * @returns {PeerRings | null} null when the fingerprint is outside the
   *   retained window
   */
  #ringsAt(fingerprint) {
    const current = this.#currentView();
    if (fingerprint === current.fingerprint) return current.rings;
    if (this.#atCache.has(fingerprint)) return this.#atCache.get(fingerprint);

    const triples = this.#history.membershipAt(fingerprint);
    const rings = triples === null ? null : new PeerRings(triples.map(ringNodeOf));
    this.#atCache.set(fingerprint, rings);
    while (this.#atCache.size > AT_CACHE_LIMIT) {
      this.#atCache.delete(this.#atCache.keys().next().value);
    }
    return rings;
  }

  /**
   * The subject's jury on the CURRENT membership, in walk order.
   *
   * @param {string} subjectOutpoint
   * @returns {Array<object> | null} null when the subject is not on the list
   */
  jury(subjectOutpoint) {
    const view = this.#currentView();
    const subject = view.byOutpoint.get(subjectOutpoint);
    return subject ? view.rings.jury(subject) : null;
  }

  /**
   * The subjects this node is a juror for, on the CURRENT membership.
   *
   * @param {string} myOutpoint
   * @returns {Array<object> | null}
   */
  duties(myOutpoint) {
    const view = this.#currentView();
    const me = view.byOutpoint.get(myOutpoint);
    return me ? view.rings.duties(me) : null;
  }

  /**
   * May observations of `otherOutpoint` feed suspicion — is it in my jury, or
   * am I in its? Answerable from the list alone, independent of which code
   * path opened any socket — PEER_SOURCE cannot carry witness status.
   *
   * @param {string} myOutpoint
   * @param {string} otherOutpoint
   * @returns {boolean}
   */
  isWitnessRelation(myOutpoint, otherOutpoint) {
    const view = this.#currentView();
    const me = view.byOutpoint.get(myOutpoint);
    if (!me) return false;
    return view.rings.isWitnessRelation(me, otherOutpoint);
  }

  /**
   * Deterministic non-witness top-up targets on the CURRENT membership
   * MUTATES `exclude`, as the walk requires.
   *
   * @param {string} myOutpoint
   * @param {number} want
   * @param {Set<string>} exclude outpoints never to pick; grows with each pick
   * @returns {Array<object>}
   */
  ringSuccessors(myOutpoint, want, exclude) {
    const view = this.#currentView();
    const me = view.byOutpoint.get(myOutpoint);
    return me ? view.rings.ringSuccessors(me, want, exclude) : [];
  }

  /**
   * The subject's jury at a NAMED fingerprint — what certificate verification
   * recomputes. Null when the fingerprint is outside the retained window
   * (verification must refuse, never substitute the current list); an empty
   * array when the membership is rebuildable but assigns no jurors.
   *
   * @param {string} fingerprint
   * @param {string} subjectOutpoint
   * @returns {Array<object> | null}
   */
  juryAt(fingerprint, subjectOutpoint) {
    const rings = this.#ringsAt(fingerprint);
    if (rings === null) return null;
    const subject = rings.get(subjectOutpoint);
    return subject ? rings.jury(subject) : [];
  }

  /**
   * Every retained fingerprint that assigns the subject a jury IDENTICAL to
   * the one at `fingerprint` — the unit that has to agree is the jury, not the
   * network list: a verdict cast under any of these answered the same
   * question. Null when `fingerprint` itself is unrebuildable.
   *
   * @param {string} subjectOutpoint
   * @param {string} fingerprint
   * @returns {Set<string> | null}
   */
  sameJuryFor(subjectOutpoint, fingerprint) {
    const base = this.juryAt(fingerprint, subjectOutpoint);
    if (base === null) return null;
    const identityOf = (jury) => jury.map((j) => `${j.outpoint}|${j.owner}`).join(',');
    const baseIdentity = identityOf(base);

    const same = new Set([fingerprint]);
    this.#history.retainedFingerprints().forEach((retained) => {
      if (same.has(retained)) return;
      const jury = this.juryAt(retained, subjectOutpoint);
      if (jury !== null && identityOf(jury) === baseIdentity) same.add(retained);
    });
    return same;
  }

  /**
   * Jurors sharing the subject's address on the list the COUNTER holds NOW —
   * the count-time co-tenant discard's input.
   * A juror or subject no longer on the current list contributes nothing.
   *
   * @param {string} subjectOutpoint
   * @param {Array<{outpoint: string}>} jury the jury being counted against
   * @returns {Set<string>} juror outpoints to discard
   */
  cotenants(subjectOutpoint, jury) {
    const view = this.#currentView();
    const subject = view.byOutpoint.get(subjectOutpoint);
    if (!subject) return new Set();
    const shared = new Set();
    jury.forEach((juror) => {
      const record = view.byOutpoint.get(juror.outpoint);
      if (record && record.addr === subject.addr) shared.add(juror.outpoint);
    });
    return shared;
  }
}

module.exports = {
  NodeDownTopology,
  ringNodeOf,
};
