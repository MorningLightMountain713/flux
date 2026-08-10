'use strict';

const { expect } = require('chai');

const {
  isValidAppNameAndOwner, verifyAppNameAndOwner, mintAppUuid, identityFromUuid,
} = require('../../ZelBack/src/services/utils/appIdentity');

describe('appIdentity tests', () => {
  const fluxId = '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC';
  const ethAddress = `0x${'aB3'.repeat(13)}c`;

  describe('isValidAppNameAndOwner tests', () => {
    [
      ['a Flux ID owner', 'my-app1', fluxId],
      ['an Ethereum owner', 'my-app1', ethAddress],
      ['a 63 character name', 'a'.repeat(63), fluxId],
      ['a one character name', 'a', fluxId],
    ].forEach(([description, name, owner]) => {
      it(`should accept ${description}`, () => {
        expect(isValidAppNameAndOwner(name, owner)).to.equal(true);
      });
    });

    [
      ['a name with an underscore', 'my_app', fluxId],
      ['a name with a space', 'my app', fluxId],
      ['a name starting with a hyphen', '-myapp', fluxId],
      ['a name ending with a hyphen', 'myapp-', fluxId],
      ['a name longer than 63 characters', 'a'.repeat(64), fluxId],
      ['an empty name', '', fluxId],
      ['a name that is not a string', ['myapp'], fluxId],
      ['no name', undefined, fluxId],
      ['an owner that is not a Flux ID or Ethereum address', 'myapp', 'my-owner'],
      ['an owner with a bad checksum', 'myapp', '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uD'],
      ['an Ethereum owner that is too long', 'myapp', `0x${'a'.repeat(41)}`],
      ['an owner that is not a string', 'myapp', { id: fluxId }],
      ['no owner', 'myapp', undefined],
    ].forEach(([description, name, owner]) => {
      it(`should refuse ${description}`, () => {
        expect(isValidAppNameAndOwner(name, owner)).to.equal(false);
      });
    });
  });

  describe('verifyAppNameAndOwner tests', () => {
    it('should return for a valid name and owner', () => {
      expect(() => verifyAppNameAndOwner('myapp', fluxId)).to.not.throw();
    });

    it('should throw for an invalid name', () => {
      expect(() => verifyAppNameAndOwner('my_app', fluxId)).to.throw('Invalid app name or owner');
    });

    it('should throw for an invalid owner', () => {
      expect(() => verifyAppNameAndOwner('myapp', 'my-owner')).to.throw('Invalid app name or owner');
    });
  });

  describe('mintAppUuid', () => {
    // Every node decodes the same registration from the same transaction. If the
    // value were not a pure function of those two inputs, nodes would disagree
    // about which app a container belongs to and the whole scheme would need a
    // protocol change to distribute it.
    it('is derived, not assigned - the same name and txid always give the same value', () => {
      const a = mintAppUuid('myapp', 'ab12cd34');
      const b = mintAppUuid('myapp', 'ab12cd34');
      expect(a).to.equal(b);
      expect(a).to.match(/^[0-9a-f]{64}$/);
    });

    // The property the whole design exists for. An app expires, someone else
    // registers the same name, and that arrives in a DIFFERENT transaction - so
    // the new app cannot inherit any artifact keyed on the old one's identity.
    // Volume directories, syncthing folder ids and port reservations all outlive
    // the name handover; this is what stops them being reused across owners.
    it('gives a re-registered name a different identity, because the txid differs', () => {
      const firstHolder = mintAppUuid('myapp', 'aaaa1111');
      const secondHolder = mintAppUuid('myapp', 'bbbb2222');
      expect(secondHolder).to.not.equal(firstHolder);
    });

    it('distinguishes two apps registered in the same transaction', () => {
      expect(mintAppUuid('appone', 'ab12cd34'))
        .to.not.equal(mintAppUuid('apptwo', 'ab12cd34'));
    });

    // Minting is only ever correct with both halves. Half an answer would be
    // worse than none: it would be stable, look valid, and be wrong.
    it('refuses to mint from a missing name or txid', () => {
      expect(mintAppUuid('', 'ab12cd34')).to.equal(null);
      expect(mintAppUuid('myapp', '')).to.equal(null);
      expect(mintAppUuid('myapp', undefined)).to.equal(null);
    });
  });

  describe('identityFromUuid', () => {
    it('takes the first 12 hex characters, docker short-id style', () => {
      const uuid = mintAppUuid('myapp', 'ab12cd34');
      expect(identityFromUuid(uuid)).to.equal(uuid.slice(0, 12));
      expect(identityFromUuid(uuid)).to.have.lengthOf(12);
    });

    it('passes a missing uuid through rather than inventing a segment', () => {
      expect(identityFromUuid(null)).to.equal(null);
    });

    // Truncation must not undo what the uuid is for.
    it('keeps two holders of the same name apart after truncation', () => {
      const first = identityFromUuid(mintAppUuid('myapp', 'aaaa1111'));
      const second = identityFromUuid(mintAppUuid('myapp', 'bbbb2222'));
      expect(second).to.not.equal(first);
    });
  });
});
