'use strict';

const { expect } = require('chai');

const {
  TYPES,
  fieldsFor,
  canonical,
  sign,
  verify,
} = require('../../ZelBack/src/services/quorumGrant/signedEnvelope');

// The repo's own verification fixture pair (verificationHelper.test.js).
// Signing and verifying against the true crypto path is the point — a stubbed
// signature would test string concatenation and call it a security property.
const WIF = '5JTeg79dTLzzHXoJPALMWuoGDM8QmLj4n5f6MeFjx8dzsirvjAh';
const PUBKEY = '0474eb4690689bb408139249eda7f361b7881c4254ccbe303d3b4d58c2b48897d0f070b44944941998551f9ea0e1befd96f13adf171c07c885e62d0c2af56d3dab';
// One hex digit flipped: not this signer. Wrong key or invalid key, the
// verifier's answer must be the same no.
const WRONG_PUBKEY = `${PUBKEY.slice(0, -1)}c`;

describe('quorumGrant signedEnvelope', () => {
  describe('canonical', () => {
    it('is domain-separated per type', () => {
      const prepare = canonical('prepare', ['app-1/master', 4]);
      const accept = canonical('accept', ['app-1/master', 4]);
      expect(prepare).to.equal('fluxquorumgrant-prepare:app-1/master|4');
      expect(accept).to.equal('fluxquorumgrant-accept:app-1/master|4');
      expect(prepare).to.not.equal(accept);
    });

    it('refuses unknown types — a typo must not mint a new domain', () => {
      expect(canonical('grant', ['k'])).to.equal(null);
      expect(canonical('', ['k'])).to.equal(null);
    });

    it('refuses fields carrying the separator — framing is not negotiable', () => {
      expect(canonical('prepare', ['app|master', 1])).to.equal(null);
    });

    it('refuses non-scalar fields and empty field lists', () => {
      expect(canonical('prepare', [{ key: 'k' }])).to.equal(null);
      expect(canonical('prepare', [undefined])).to.equal(null);
      expect(canonical('prepare', [null])).to.equal(null);
      expect(canonical('prepare', [])).to.equal(null);
      expect(canonical('prepare', 'not-an-array')).to.equal(null);
    });

    it('numbers and strings encode identically to their string forms', () => {
      expect(canonical('renew', ['k', 7])).to.equal(canonical('renew', ['k', '7']));
    });
  });

  describe('sign and verify', () => {
    it('round-trips through the real secp256k1 path', () => {
      const fields = ['app-1/master', 3, 'aaaa:0', 'fp-1', 1750000000];
      const signed = sign('prepare', fields, WIF);
      expect(signed).to.not.equal(null);
      expect(verify('prepare', fields, signed.signature, PUBKEY)).to.equal(true);
    });

    it('a signature does not survive a changed field', () => {
      const fields = ['app-1/master', 3, 'aaaa:0', 'fp-1', 1750000000];
      const signed = sign('prepare', fields, WIF);
      const tampered = ['app-1/master', 4, 'aaaa:0', 'fp-1', 1750000000];
      expect(verify('prepare', tampered, signed.signature, PUBKEY)).to.equal(false);
    });

    it('a signature does not survive a type swap — no cross-domain replay', () => {
      const fields = ['app-1/master', 3];
      const signed = sign('prepare', fields, WIF);
      expect(verify('accept', fields, signed.signature, PUBKEY)).to.equal(false);
    });

    it('a signature does not survive a field-boundary shift', () => {
      const signed = sign('renew', ['app-1', 'master7'], WIF);
      expect(verify('renew', ['app-1master', '7'], signed.signature, PUBKEY)).to.equal(false);
    });

    it('the wrong key does not verify', () => {
      const fields = ['app-1/master', 3];
      const signed = sign('prepare', fields, WIF);
      expect(verify('prepare', fields, signed.signature, WRONG_PUBKEY)).to.equal(false);
    });

    it('verify fails closed on missing inputs', () => {
      const signed = sign('prepare', ['k', 1], WIF);
      expect(verify('prepare', ['k', 1], signed.signature, '')).to.equal(false);
      expect(verify('prepare', ['k', 1], '', PUBKEY)).to.equal(false);
      expect(verify('prepare', ['k|1'], signed.signature, PUBKEY)).to.equal(false);
    });

    it('sign refuses what canonical refuses', () => {
      expect(sign('prepare', ['bad|field'], WIF)).to.equal(null);
      expect(sign('nonsense', ['k'], WIF)).to.equal(null);
    });

    it('a vacate signs the ask, never the certificate it carries', () => {
      // the certificate is self-verifying through the node-down store's seam,
      // exactly as a cancel-chain entry is; binding it here would stop one
      // signature serving every cell of the committee
      const ask = {
        key: 'app/ordinal-0@500', candidate: 'aaaa:0', generation: 2, fingerprint: 'f'.repeat(64), at: 5, cert: { subject: 'bbbb:1' },
      };
      expect(fieldsFor('vacate', ask)).to.deep.equal(['app/ordinal-0@500', 'aaaa:0', 2, 'f'.repeat(64), 5]);
      expect(TYPES).to.include('vacate');
    });

    // The term acceptance a referee signs on accept and renew (STEP_ACROSS_DESIGN
    // D1): the term's identity and nothing on any clock — no timestamp, no
    // expiry — so a quorum of them proves "this committee accepted this grantee
    // at this epoch" to a referee that was never on that committee.
    it('termaccept is the term\'s identity: key, fingerprint, generation, epoch, grantee', () => {
      expect(TYPES).to.include('termaccept');
      const fields = fieldsFor('termaccept', {
        key: 'app/master', fingerprint: 'f'.repeat(64), generation: 2, epoch: 7, grantee: 'aaaa:0',
      });
      expect(fields).to.deep.equal(['app/master', 'f'.repeat(64), 2, 7, 'aaaa:0']);
      const signed = sign('termaccept', fields, WIF);
      expect(verify('termaccept', fields, signed.signature, PUBKEY)).to.equal(true);
      expect(verify('termaccept', fields, signed.signature, WRONG_PUBKEY)).to.equal(false);
      expect(verify('termaccept', ['app/master', 'f'.repeat(64), 2, 8, 'aaaa:0'], signed.signature, PUBKEY), 'another epoch is another term').to.equal(false);
    });

    it('every declared type signs and verifies', () => {
      TYPES.forEach((type) => {
        const fields = ['key', 1, 'value'];
        const signed = sign(type, fields, WIF);
        expect(signed, type).to.not.equal(null);
        expect(verify(type, fields, signed.signature, PUBKEY), type).to.equal(true);
      });
    });
  });
});
