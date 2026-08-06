const { expect } = require('chai');

const appIdentity = require('../../ZelBack/src/services/utils/appIdentity');

describe('appIdentity', () => {
  describe('mintAppUuid', () => {
    // Every node decodes the same registration from the same transaction. If the
    // value were not a pure function of those two inputs, nodes would disagree
    // about which app a container belongs to and the whole scheme would need a
    // protocol change to distribute it.
    it('is derived, not assigned - the same name and txid always give the same value', () => {
      const a = appIdentity.mintAppUuid('myapp', 'ab12cd34');
      const b = appIdentity.mintAppUuid('myapp', 'ab12cd34');
      expect(a).to.equal(b);
      expect(a).to.match(/^[0-9a-f]{64}$/);
    });

    // The property the whole design exists for. An app expires, someone else
    // registers the same name, and that arrives in a DIFFERENT transaction - so
    // the new app cannot inherit any artifact keyed on the old one's identity.
    // Volume directories, syncthing folder ids and port reservations all outlive
    // the name handover; this is what stops them being reused across owners.
    it('gives a re-registered name a different identity, because the txid differs', () => {
      const firstHolder = appIdentity.mintAppUuid('myapp', 'aaaa1111');
      const secondHolder = appIdentity.mintAppUuid('myapp', 'bbbb2222');
      expect(secondHolder).to.not.equal(firstHolder);
    });

    it('distinguishes two apps registered in the same transaction', () => {
      expect(appIdentity.mintAppUuid('appone', 'ab12cd34'))
        .to.not.equal(appIdentity.mintAppUuid('apptwo', 'ab12cd34'));
    });

    // Minting is only ever correct with both halves. Half an answer would be
    // worse than none: it would be stable, look valid, and be wrong.
    it('refuses to mint from a missing name or txid', () => {
      expect(appIdentity.mintAppUuid('', 'ab12cd34')).to.equal(null);
      expect(appIdentity.mintAppUuid('myapp', '')).to.equal(null);
      expect(appIdentity.mintAppUuid('myapp', undefined)).to.equal(null);
    });
  });

  describe('identityFromUuid', () => {
    it('takes the first 12 hex characters, docker short-id style', () => {
      const uuid = appIdentity.mintAppUuid('myapp', 'ab12cd34');
      expect(appIdentity.identityFromUuid(uuid)).to.equal(uuid.slice(0, 12));
      expect(appIdentity.identityFromUuid(uuid)).to.have.lengthOf(12);
    });

    it('passes a missing uuid through rather than inventing a segment', () => {
      expect(appIdentity.identityFromUuid(null)).to.equal(null);
    });

    // Truncation must not undo what the uuid is for.
    it('keeps two holders of the same name apart after truncation', () => {
      const first = appIdentity.identityFromUuid(appIdentity.mintAppUuid('myapp', 'aaaa1111'));
      const second = appIdentity.identityFromUuid(appIdentity.mintAppUuid('myapp', 'bbbb2222'));
      expect(second).to.not.equal(first);
    });
  });
});
