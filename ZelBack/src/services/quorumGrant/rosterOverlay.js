'use strict';

const { rankNodes } = require('../utils/rendezvousRank');
const { extractIp } = require('../utils/socketAddressUtils');
const { selectCommittee, eligible, RUNGS } = require('../utils/committeeSelector');
const signedEnvelope = require('./signedEnvelope');

// The roster overlay: how a pinned committee heals a dark seat without
// anyone's reachability opinion ever picking a member.
//
// A chain of single-seat entries — {seq, remove, add}, each backed by a
// quorum of grantor signatures — overlays the base committee the fingerprint
// derives. Everything about an entry is forced: the proposer must be the
// recorded grantee, the removed seat must be on the roster, and the added
// seat is THE next eligible node in the deterministic walk, recomputed by
// every judge and every verifier from the same membership. What the quorum's
// signatures attest is the one thing arithmetic cannot: that the committee
// itself judged the change worth making. Signatures for the judgment, the
// walk for the seat — a colluding quorum still cannot hand-pick a member.
//
// One seat per entry is load-bearing, not a simplification: rosters one
// entry apart share all seats but one, and any acceptance quorum for entry
// N+1 must intersect any quorum drawn from the roster at N — so a stale
// participant always meets someone whose journal carries the newer chain.
// Multi-seat entries are exactly the point where that argument stops
// composing (Raft's single-server-change rule).
//
// The chain is bound to its base: acceptance signatures cover the
// fingerprint, so entries can never be replayed against a committee drawn
// from a different membership. A fresh acquisition at a new fingerprint
// starts a fresh chain.

const OUTPOINT_PATTERN = /^[0-9a-f]{64}:\d{1,6}$/;

// Shape bounds on what arrives off the wire, ahead of any cryptography: a
// committee never exceeds single digits, so anything past these is not a
// bigger committee, it is a bigger bill for the verifier.
const MAX_ACCEPTANCES = 16;
const MAX_CHAIN_ENTRIES = 32;

function outpointOf(node) {
  return `${node.txhash}:${node.outidx}`;
}

/**
 * The walk key a held committee derives from — always generation-salted,
 * generation 0 included. The generation is the owner's re-roll counter: a
 * new number re-deals the seats from the very same membership, which is the
 * whole escape when the standing committee is dark on a list that has not
 * changed. One unconditional spelling, so every derivation site runs the
 * same path and a site that failed to resolve the generation produces a key
 * nobody else agrees with, loudly, instead of quietly deriving yesterday's
 * committee.
 *
 * @param {string} key resource key (`<app>/<role>`)
 * @param {number} generation the owner's current generation for the key
 * @returns {string}
 */
function walkKeyFor(key, generation) {
  return `quorumgrant|${key}@${generation}`;
}

/**
 * The chain length past which extension refuses: one full committee's worth
 * of seats. A chain that has replaced as many seats as the base ever had is
 * describing a world the base no longer resembles — re-acquisition at the
 * current fingerprint (a fresh base) or the owner re-roll is the honest
 * continuation, not a longer overlay. The rate limit already makes reaching
 * this slow; the cap makes it finite.
 *
 * @param {number} committeeSize
 * @returns {number}
 */
function chainCap(committeeSize) {
  return committeeSize;
}

/**
 * Shape of one entry, before any cryptography: the walk and the signatures
 * both assume these fields parse.
 *
 * @param {object} entry
 * @returns {boolean}
 */
function entryWellFormed(entry) {
  return Boolean(
    entry
    && Number.isSafeInteger(entry.seq) && entry.seq >= 1
    && typeof entry.remove === 'string' && OUTPOINT_PATTERN.test(entry.remove)
    && typeof entry.add === 'string' && OUTPOINT_PATTERN.test(entry.add)
    && Array.isArray(entry.acceptances)
    && entry.acceptances.length <= MAX_ACCEPTANCES
    && entry.acceptances.every(
      (acceptance) => acceptance
        && typeof acceptance.grantor === 'string' && OUTPOINT_PATTERN.test(acceptance.grantor)
        && typeof acceptance.signature === 'string' && acceptance.signature.length > 0
        && acceptance.signature.length <= 256,
    ),
  );
}

/**
 * Wire-shape gate for a whole carried chain — run before any signature is
 * checked, so a malformed object costs a parse, never a verification.
 *
 * @param {unknown} chain
 * @returns {boolean}
 */
function chainWellFormed(chain) {
  return Array.isArray(chain)
    && chain.length <= MAX_CHAIN_ENTRIES
    && chain.every(entryWellFormed);
}

/**
 * The replacement seat for one removal: the first node down the key's
 * rendezvous ranking that is not seated, not previously removed, and
 * pairwise distinct from every survivor — by owner and address always, and
 * by fault domain at the tightest rung that admits anyone at all.
 *
 * The rung ladder here is selectCommittee's discipline at single-seat
 * granularity: spread is preferred, but a replacement that exists beats a
 * rung that refuses, so the walk relaxes rung by rung before giving up.
 * Deterministic throughout — every judge and verifier lands on the same
 * node or the same null.
 *
 * @param {object[]} membership the membership the fingerprint names
 * @param {string} walkKey the committee's fully-qualified walk key
 * @param {object[]} survivors the roster minus the seat being removed
 * @param {Set<string>} excluded outpoints removed by this or any earlier entry
 * @param {(node: object, host: string) => string|null} [domainOf] the custom
 *   tightest rung, when a shared location table exists (selectCommittee's hook)
 * @returns {object|null} the forced replacement, or null when no eligible
 *   node remains
 */
function nextReplacement(membership, walkKey, survivors, excluded, domainOf) {
  const candidates = (membership || []).filter(eligible);
  const ranked = rankNodes(candidates, walkKey);

  const seatedOutpoints = new Set(survivors.map(outpointOf));
  const owners = new Set(survivors.map((node) => node.pubkey));
  const hosts = new Set(survivors.map((node) => extractIp(node.ip)));

  const rungs = domainOf
    ? [{ name: 'custom', domain: (host, node) => domainOf(node, host) }, ...RUNGS]
    : RUNGS;

  for (let r = 0; r < rungs.length; r += 1) {
    const domains = new Set();
    survivors.forEach((node) => {
      const domain = rungs[r].domain(extractIp(node.ip), node);
      if (domain !== null) domains.add(domain);
    });
    for (let i = 0; i < ranked.length; i += 1) {
      const node = ranked[i];
      const outpoint = outpointOf(node);
      if (seatedOutpoints.has(outpoint) || excluded.has(outpoint)) continue;
      const host = extractIp(node.ip);
      if (owners.has(node.pubkey) || hosts.has(host)) continue;
      const domain = rungs[r].domain(host, node);
      if (domain === null || !domains.has(domain)) return node;
    }
  }
  return null;
}

/**
 * Apply a chain this node already judged — its own journal, where every
 * entry passed the full gauntlet before being written. Membership lookups
 * only; no cryptography re-run on what the journal remembers.
 *
 * @param {object[]} baseMembers the committee the fingerprint derives
 * @param {object[]} membership the membership the fingerprint names
 * @param {object[]} chain journaled entries, seq order
 * @returns {object[]|null} the effective roster, or null when an entry names
 *   a node the membership does not hold (a journal from another world)
 */
function rosterAfter(baseMembers, membership, chain) {
  const byOutpoint = new Map((membership || []).map((node) => [outpointOf(node), node]));
  let roster = [...baseMembers];
  for (let i = 0; i < (chain || []).length; i += 1) {
    const entry = chain[i];
    const added = byOutpoint.get(entry.add);
    if (!added) return null;
    const before = roster.length;
    roster = roster.filter((node) => outpointOf(node) !== entry.remove);
    if (roster.length !== before - 1) return null;
    roster.push(added);
  }
  return roster;
}

/**
 * Full verification of a carried chain — what a grantor runs before adopting
 * entries it never judged, and what any third party runs on the published
 * record. For each entry, in order:
 *
 *   - the seq is exactly the next link;
 *   - the removed seat sits on the roster so far;
 *   - the added seat is the recomputed walk replacement — the quorum's word
 *     is necessary but not sufficient, so collusion cannot seat a friend;
 *   - a quorum of the PRE-change roster signed it, each signature verifying
 *     against the signer's registered key from the membership itself.
 *
 * @param {object[]} membership the membership the fingerprint names
 * @param {string} key resource key (`<app>/<role>`)
 * @param {string} fingerprint the membership basis the signatures bind to
 * @param {number} generation the generation the chain overlays — signatures
 *   bind it beside the fingerprint, so a retired world's chain can never
 *   reshape a re-rolled committee
 * @param {number} committeeSize the mode's configured size
 * @param {object[]} chain carried entries, seq order
 * @returns {{members: object[], quorum: number}|null} the effective roster,
 *   or null when anything fails to verify
 */
function verifyChain(membership, key, fingerprint, generation, committeeSize, chain) {
  if (!Array.isArray(chain)) return null;
  const walkKey = walkKeyFor(key, generation);
  const base = selectCommittee(membership, walkKey, { size: committeeSize });
  if (base.refusal) return null;
  if (chain.length > chainCap(base.members.length)) return null;

  let roster = base.members;
  const excluded = new Set();

  for (let i = 0; i < chain.length; i += 1) {
    const entry = chain[i];
    if (!entryWellFormed(entry) || entry.seq !== i + 1) return null;

    const removed = roster.find((node) => outpointOf(node) === entry.remove);
    if (!removed) return null;

    const survivors = roster.filter((node) => outpointOf(node) !== entry.remove);
    excluded.add(entry.remove);
    const expected = nextReplacement(membership, walkKey, survivors, excluded);
    if (!expected || outpointOf(expected) !== entry.add) return null;

    const preChange = new Map(roster.map((node) => [outpointOf(node), node]));
    const signers = new Set();
    for (let a = 0; a < entry.acceptances.length; a += 1) {
      const acceptance = entry.acceptances[a];
      const signer = preChange.get(acceptance.grantor);
      if (!signer || signers.has(acceptance.grantor)) continue;
      const fields = signedEnvelope.fieldsFor('rosteraccept', {
        key, fingerprint, generation, seq: entry.seq, remove: entry.remove, add: entry.add,
      });
      if (signedEnvelope.verify('rosteraccept', fields, acceptance.signature, signer.pubkey)) {
        signers.add(acceptance.grantor);
      }
    }
    if (signers.size < base.quorum) return null;

    roster = [...survivors, expected];
  }

  return { members: roster, quorum: base.quorum };
}

/**
 * Whether a journaled chain and a carried chain agree where they overlap —
 * the fork refusal. Two quorum-signed entries at one seq cannot both exist
 * (their acceptance quorums would have to intersect in a grantor that signed
 * both, and a grantor signs one entry per link), so a disagreement means one
 * side is corrupt and adoption must refuse rather than choose.
 *
 * @param {object[]} journaled this grantor's own entries
 * @param {object[]} carried the longer chain offered for adoption
 * @returns {boolean}
 */
function extendsChain(journaled, carried) {
  if (!Array.isArray(journaled) || !Array.isArray(carried)) return false;
  if (carried.length < journaled.length) return false;
  for (let i = 0; i < journaled.length; i += 1) {
    const own = journaled[i];
    const offered = carried[i];
    if (own.seq !== offered.seq || own.remove !== offered.remove || own.add !== offered.add) {
      return false;
    }
  }
  return true;
}

module.exports = {
  chainCap,
  entryWellFormed,
  chainWellFormed,
  walkKeyFor,
  nextReplacement,
  rosterAfter,
  verifyChain,
  extendsChain,
};
