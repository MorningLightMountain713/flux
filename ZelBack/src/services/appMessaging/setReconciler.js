const crypto = require('crypto');

// Bucketed-digest set reconciliation — the scalable core shared by the content-manifest
// and ingress-attestation anti-entropy syncs.
//
// Instead of exchanging a whole index every round (O(set size) forever, even when nothing
// changed), each side summarizes its set as K fixed buckets, each with a digest. Peers
// exchange the K digests (fixed size), find the buckets whose digests differ, and fetch
// only those buckets' records. A converged pair matches on every digest → zero fetch,
// O(K) constant regardless of set size; divergence costs O(differing buckets).
//
// A bucket digest is the XOR of sha256(identity|version) over its members:
//   - XOR is commutative/associative, so it is independent of the (unbounded) DB order
//     and can later be maintained incrementally (xor in on insert, xor out on removal).
//   - Including `version` makes the digest change when a latest-wins value advances
//     (content manifests); an immutable set (ingress attestations) passes a constant.
// Members are uniquely keyed in both collections, so the XOR cannot be fooled by a
// duplicate cancelling itself out.
//
// NOTE: digests/bucket contents are computed on demand from an indexed read (O(set size)
// server-side, but only when a reconcile request is served — a few peers every refresh
// period). Materializing the K digests into a side table would make serving O(K) too; it
// is the remaining future optimization, deliberately deferred (it adds drift maintenance).

const DEFAULT_BUCKETS = 256;
const DIGEST_BYTES = 32;

/** Map an item identity to a bucket index in [0, buckets). */
function bucketOf(identity, buckets = DEFAULT_BUCKETS) {
  const h = crypto.createHash('sha256').update(String(identity)).digest();
  return ((h[0] << 8) | h[1]) % buckets;
}

/** The per-member contribution to a bucket digest. */
function itemHash(identity, version) {
  return crypto.createHash('sha256').update(`${identity}|${version}`).digest();
}

/**
 * Compute the K bucket digests for a collection of items.
 * @param {Iterable} items
 * @param {object} opts - { identityOf, versionOf?, buckets? }
 * @returns {string[]} K hex digests
 */
function bucketDigests(items, opts) {
  const {
    identityOf,
    versionOf = () => '',
    buckets = DEFAULT_BUCKETS,
  } = opts;
  const acc = Array.from({ length: buckets }, () => Buffer.alloc(DIGEST_BYTES));
  for (const item of items) {
    const identity = identityOf(item);
    const b = bucketOf(identity, buckets);
    const ih = itemHash(identity, versionOf(item));
    const target = acc[b];
    for (let i = 0; i < DIGEST_BYTES; i += 1) target[i] ^= ih[i];
  }
  return acc.map((buf) => buf.toString('hex'));
}

/**
 * The digest of a single bucket's members — XOR of each member's itemHash. Used to
 * (re)materialize one bucket of a maintained digest table without touching the rest.
 * @returns {string} hex digest
 */
function combineDigest(items, opts) {
  const { identityOf, versionOf = () => '' } = opts;
  const acc = Buffer.alloc(DIGEST_BYTES);
  for (const item of items) {
    const ih = itemHash(identityOf(item), versionOf(item));
    for (let i = 0; i < DIGEST_BYTES; i += 1) acc[i] ^= ih[i];
  }
  return acc.toString('hex');
}

/** The digest of an empty bucket. */
const ZERO_DIGEST = '0'.repeat(DIGEST_BYTES * 2);

/** Bucket indices where the local and peer digest vectors disagree. */
function differingBuckets(localDigests, peerDigests) {
  const out = [];
  const n = Math.max(localDigests.length, peerDigests.length);
  for (let b = 0; b < n; b += 1) {
    if (localDigests[b] !== peerDigests[b]) out.push(b);
  }
  return out;
}

module.exports = {
  DEFAULT_BUCKETS,
  ZERO_DIGEST,
  bucketOf,
  itemHash,
  bucketDigests,
  combineDigest,
  differingBuckets,
};
