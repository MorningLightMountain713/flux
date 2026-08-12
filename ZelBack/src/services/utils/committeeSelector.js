'use strict';

const { rankNodes } = require('./rendezvousRank');
const { extractIp } = require('./socketAddressUtils');

// The committee for a resource key: the leading nodes of the key's rendezvous
// ranking that are pairwise distinct — by owner, by public address, and by
// network fault domain.
//
// Every node computes the same committee from the same list, having asked no
// one. That is the property everything downstream leans on: a quorum guarantee
// is only a guarantee if everyone agrees which nodes it is a quorum OF. So the
// walk consumes chain-derived data only — pubkey, address, and what can be read
// from the address itself. Anything a node knows only about itself (org
// attestation, Arcane status, health) is banned from the walk, because a set
// that cannot be computed identically everywhere is not a set.
//
// The quorum unit is the distinct OWNER (pubkey), never the node: one owner
// holds at most one seat however many nodes it runs, so key-splitting buys no
// seats. The shared-address exclusion is the same rule seen from the wire — two
// "owners" answering on one address are one failure domain and quite possibly
// one machine. Both are hard rules and never relax.
//
// Fault-domain diversity relaxes, by ladder. A hash-chosen committee can land
// its seats behind one provider or one router, which is a committee with the
// fault tolerance of one; walking with a network-prefix skip prevents that. But
// small or clustered fleets cannot always fill a committee at the tightest
// spread, and a committee that exists beats a spread that refuses — so the walk
// fills at the tightest rung that seats the full committee, and the chosen rung
// is reported. The org/ASN rung slots in ahead of the prefixes via `domainOf`
// once a shared, chain-distributable org table exists; today the prefixes are
// what every node can compute about every other.
//
// "Nothing lowers the denominator": on fleets with fewer distinct owners than
// the requested size, the committee shrinks to what exists — but below the
// floor it refuses outright rather than shrink its meaning. A 2-owner
// "committee" is not a smaller version of the guarantee, it is a different and
// weaker statement, and refusing is the honest answer.

const FLOOR_OWNERS = 3;

/**
 * The dotted-quad prefix domains, tightest first. A host that is not a
 * dotted quad (never true of fluxd-listed nodes today) is its own domain at
 * every rung — conservative in the direction that seats fewer neighbours.
 */
const RUNGS = Object.freeze([
  { name: 'slash16', domain: (host) => host.split('.').slice(0, 2).join('.') },
  { name: 'slash24', domain: (host) => host.split('.').slice(0, 3).join('.') },
  { name: 'address', domain: () => null },
]);

/**
 * A node is a candidate only if the walk can apply every rule to it. A node
 * missing its pubkey or address cannot be checked for distinctness, and a seat
 * that skipped a rule is a seat another implementation might not have granted.
 *
 * @param {object} node deterministic-list node
 * @returns {boolean}
 */
function eligible(node) {
  return Boolean(
    node
    && node.txhash
    && node.outidx !== undefined
    && node.outidx !== null
    && node.pubkey
    && extractIp(node.ip),
  );
}

/**
 * One pass down the ranking under one rung's domain rule.
 *
 * Scanning rather than abandoning: a collision skips the CANDIDATE and keeps
 * walking, so the walk cannot come up short while an eligible owner exists
 * further down. Skipping to a fallback on collision would bound the committee
 * by collision count, silently shrinking the quorum on exactly the fleets
 * where diversity is scarce.
 *
 * @param {object[]} ranked nodes, heaviest first
 * @param {number} size seats to fill
 * @param {(host: string, node: object) => string|null} domainFor rung rule;
 *   null exempts the candidate from the domain check
 * @returns {object[]} the seated nodes, ranking order
 */
function walkRanking(ranked, size, domainFor) {
  const seated = [];
  const owners = new Set();
  const hosts = new Set();
  const domains = new Set();

  for (let i = 0; i < ranked.length && seated.length < size; i += 1) {
    const node = ranked[i];
    const host = extractIp(node.ip);
    if (!owners.has(node.pubkey) && !hosts.has(host)) {
      const domain = domainFor(host, node);
      if (domain === null || !domains.has(domain)) {
        seated.push(node);
        owners.add(node.pubkey);
        hosts.add(host);
        if (domain !== null) domains.add(domain);
      }
    }
  }

  return seated;
}

/**
 * The committee for a key.
 *
 * The caller owns the key and everything in it (purpose prefix, app, role) —
 * two callers that must not collide must differ in the key, the same
 * discipline rendezvousRank documents. The caller also owns WHICH list is
 * ranked: committee pinning (the membership fingerprint a grant names) is the
 * caller's job, performed by choosing the node list this function ranks.
 *
 * @param {object[]} nodes the node list to rank — the caller pins WHICH list
 * @param {string} key fully-qualified resource key
 * @param {object} [options]
 * @param {number} [options.size] seats wanted (5 HELD / 9 ONE-SHOT; callers
 *   pass their mode's configured size)
 * @param {number} [options.floor] distinct owners below which selection
 *   refuses (default 3, and lowering it changes what a grant means — don't)
 * @param {(node: object, host: string) => string|null} [options.domainOf]
 *   tightest-rung fault domain (org/ASN when a shared table exists); a null
 *   return exempts that node from the rung rather than failing it
 * @returns {{members: object[], quorum: number, rung: string, refusal: null}
 *   | {members: null, quorum: 0, rung: null, refusal: string}}
 */
function selectCommittee(nodes, key, options = {}) {
  const size = options.size ?? 5;
  const floor = options.floor ?? FLOOR_OWNERS;

  const candidates = (nodes || []).filter(eligible);
  const ranked = rankNodes(candidates, key);

  // What the hard rules alone can seat decides the committee's size; the
  // ladder below only decides its spread. Computing the target first keeps
  // "how many" and "how spread" from trading against each other.
  const loosest = RUNGS[RUNGS.length - 1];
  const achievable = walkRanking(ranked, size, loosest.domain);

  if (achievable.length < floor) {
    return {
      members: null,
      quorum: 0,
      rung: null,
      refusal: `${achievable.length} seatable owners, floor is ${floor}`,
    };
  }

  const target = achievable.length;

  const rungs = options.domainOf
    ? [{ name: 'custom', domain: (host, node) => options.domainOf(node, host) }, ...RUNGS]
    : RUNGS;

  // The loosest rung reproduces `achievable` by construction, so this always
  // returns from inside the loop.
  for (let i = 0; i < rungs.length; i += 1) {
    const seated = walkRanking(ranked, target, rungs[i].domain);
    if (seated.length === target) {
      return {
        members: seated,
        quorum: Math.floor(target / 2) + 1,
        rung: rungs[i].name,
        refusal: null,
      };
    }
  }

  // Unreachable; typed here so a future rung edit that breaks the invariant
  // fails loudly instead of returning undefined.
  throw new Error('committeeSelector: no rung reproduced the achievable committee');
}

module.exports = {
  FLOOR_OWNERS,
  RUNGS,
  eligible,
  walkRanking,
  selectCommittee,
};
