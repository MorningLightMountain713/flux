'use strict';

const { expect } = require('chai');
const setReconciler = require('../../ZelBack/src/services/appMessaging/setReconciler');

const {
  bucketOf, bucketDigests, differingBuckets, DEFAULT_BUCKETS,
} = setReconciler;

describe('setReconciler', () => {
  describe('bucketOf', () => {
    it('returns a bucket within range and is deterministic', () => {
      const b = bucketOf('some|identity');
      expect(b).to.be.a('number').and.within(0, DEFAULT_BUCKETS - 1);
      expect(bucketOf('some|identity')).to.equal(b);
    });

    it('honours a custom bucket count', () => {
      for (let i = 0; i < 50; i += 1) {
        expect(bucketOf(`id-${i}`, 8)).to.be.within(0, 7);
      }
    });
  });

  describe('bucketDigests', () => {
    const identityOf = (r) => `${r.hash}|${r.node}`;

    it('is order-independent', () => {
      const a = [{ hash: 'h1', node: 'nA' }, { hash: 'h2', node: 'nB' }, { hash: 'h3', node: 'nC' }];
      const b = [a[2], a[0], a[1]];
      expect(bucketDigests(a, { identityOf })).to.deep.equal(bucketDigests(b, { identityOf }));
    });

    it('an empty set yields all-zero digests', () => {
      const digests = bucketDigests([], { identityOf });
      expect(digests).to.have.length(DEFAULT_BUCKETS);
      expect(digests.every((d) => d === '0'.repeat(64))).to.equal(true);
    });

    it('changes exactly one bucket when one member is added', () => {
      const base = [{ hash: 'h1', node: 'nA' }, { hash: 'h2', node: 'nB' }];
      const added = [...base, { hash: 'h3', node: 'nC' }];
      const d0 = bucketDigests(base, { identityOf });
      const d1 = bucketDigests(added, { identityOf });
      const changed = differingBuckets(d0, d1);
      expect(changed).to.deep.equal([bucketOf('h3|nC')]);
    });

    it('reflects a version bump (latest-wins identities)', () => {
      const v1 = [{ appName: 'app', version: 1 }];
      const v2 = [{ appName: 'app', version: 2 }];
      const opts = { identityOf: (r) => r.appName, versionOf: (r) => r.version };
      expect(bucketDigests(v1, opts)).to.not.deep.equal(bucketDigests(v2, opts));
    });

    it('two sets with the same members match on every bucket', () => {
      const s1 = [{ hash: 'h1', node: 'nA' }, { hash: 'h2', node: 'nB' }];
      const s2 = [{ hash: 'h2', node: 'nB' }, { hash: 'h1', node: 'nA' }];
      expect(differingBuckets(bucketDigests(s1, { identityOf }), bucketDigests(s2, { identityOf }))).to.deep.equal([]);
    });
  });

  describe('combineDigest', () => {
    const identityOf = (r) => `${r.hash}|${r.node}`;

    it('is order-independent and zero for an empty bucket', () => {
      const members = [{ hash: 'h1', node: 'nA' }, { hash: 'h1', node: 'nB' }];
      const a = setReconciler.combineDigest(members, { identityOf });
      expect(a).to.equal(setReconciler.combineDigest([members[1], members[0]], { identityOf }));
      expect(setReconciler.combineDigest([], { identityOf })).to.equal('0'.repeat(64));
    });
  });

  describe('differingBuckets', () => {
    it('lists only the indices that differ', () => {
      expect(differingBuckets(['a', 'b', 'c'], ['a', 'x', 'c'])).to.deep.equal([1]);
      expect(differingBuckets(['a', 'b'], ['a', 'b'])).to.deep.equal([]);
    });
  });
});
