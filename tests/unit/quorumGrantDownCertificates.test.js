'use strict';

const { expect } = require('chai');

const downCertificates = require('../../ZelBack/src/services/quorumGrant/downCertificates');

// The node-down store's seam into the grant plane. Until the store registers
// its provider, every answer is the fail-closed one: no certificate stands
// and nothing verifies — the cancel overlay is inert, never permissive. The
// registered provider must carry the full read contract or registration
// refuses: a partial provider would fail open at whichever call it lacks.

describe('quorumGrant downCertificates', () => {
  afterEach(() => downCertificates.resetForTests());

  describe('before a provider registers', () => {
    it('no certificate stands, no refutation exists, and no object verifies', async () => {
      expect(await downCertificates.standingCertificateFor('a'.repeat(64) + ':0')).to.equal(null);
      expect(await downCertificates.refutationFor('a'.repeat(64) + ':0')).to.equal(null);
      const { certificate, refutation } = downCertificates.verifiers();
      expect(certificate({ subject: 'x' })).to.deep.equal({ valid: false, subject: null });
      expect(refutation({ subject: 'x' }, { subject: 'x' })).to.equal(false);
    });
  });

  describe('registerProvider', () => {
    const provider = {
      standingCertificateFor: async (outpoint) => ({ subject: outpoint, token: 'standing' }),
      refutationFor: async (outpoint) => ({ subject: outpoint, token: 'alive' }),
      verifyCertificate: (cert) => ({ valid: cert.token === 'standing', subject: cert.subject }),
      verifyRefutation: (refutation, cert) => refutation.subject === cert.subject,
    };

    it('delegates lookups and verification to the registered provider', async () => {
      downCertificates.registerProvider(provider);
      const outpoint = 'b'.repeat(64) + ':1';
      const cert = await downCertificates.standingCertificateFor(outpoint);
      expect(cert.subject).to.equal(outpoint);

      const { certificate, refutation } = downCertificates.verifiers();
      expect(certificate(cert)).to.deep.equal({ valid: true, subject: outpoint });
      expect(refutation({ subject: outpoint }, cert)).to.equal(true);
      expect((await downCertificates.refutationFor(outpoint)).token).to.equal('alive');
    });

    it('refuses a provider missing any of the contract', () => {
      const partial = { ...provider };
      delete partial.verifyRefutation;
      expect(() => downCertificates.registerProvider(partial)).to.throw(/verifyRefutation/);
      // the refused registration left the inert default in place
      expect(downCertificates.verifiers().certificate({}).valid).to.equal(false);
    });

    it('resetForTests restores the inert default', async () => {
      downCertificates.registerProvider(provider);
      downCertificates.resetForTests();
      expect(await downCertificates.standingCertificateFor('c'.repeat(64) + ':0')).to.equal(null);
    });
  });
});
