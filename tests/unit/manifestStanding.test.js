'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const { loadSpecLibrary, V9_SUBMISSION } = require('./fixtures/fluxSpec');

// Which manifest an app stands on, from the rows a node holds and the listed row.
// The library's validity and rank rules are real; the registry is a fake.
const IDENTITY = `b${'a'.repeat(52)}`;
const SELLER = '1SellerAddressXXXXXXXXXXXXXXXXXXXX';
const BUYER = V9_SUBMISSION.owner;
let flux;

function row({
  hash, version, ownedFrom, signer = BUYER, applied = false, servable = true,
}) {
  return {
    identity: IDENTITY, hash, version, ownedFrom, signer, applied, data: { manifest: { identity: IDENTITY, version, ownedFrom } }, ...(servable ? { envelope: { v: 1 } } : {}),
  };
}

function load(repo = {}) {
  return proxyquire('../../ZelBack/src/services/appLifecycle/manifestStanding', {
    '../appDatabase/appsRepository': {
      getGlobalAppInfoByIdentity: sinon.stub().resolves(null),
      getContentManifests: sinon.stub().resolves([]),
      carriedManifestRanks: sinon.stub().resolves([]),
      listResolvedContentManifests: sinon.stub().resolves([]),
      ...repo,
    },
    '../utils/specLibs': { getSpec: async () => flux },
  });
}

describe('manifestStanding', () => {
  before(async function loadLibrary() {
    this.timeout(30_000);
    flux = await loadSpecLibrary();
  });

  // A listed app whose cleartext spec names a manifest or not.
  const listed = (owner, content = null) => ({
    name: 'myapp', identity: IDENTITY, owner, spec: { sealed: false, content },
  });

  describe('standingManifest', () => {
    it('stands on the highest-ranked row the listed owner signed: the ownership height first, the version within it', async () => {
      const rows = [
        row({ hash: 'seller7', version: 7, ownedFrom: 100, signer: SELLER }),
        row({ hash: 'buyer1', version: 1, ownedFrom: 200 }),
        row({ hash: 'buyer2', version: 2, ownedFrom: 200 }),
      ];
      const svc = load({ getGlobalAppInfoByIdentity: sinon.stub().resolves(listed(BUYER)), getContentManifests: sinon.stub().resolves(rows) });
      const { row: standing, aside } = await svc.standingManifest(IDENTITY);
      expect(standing.hash).to.equal('buyer2');
      expect(aside).to.equal(false);
    });

    it('ranks by the ownership height before the version: an owner holding the app a second time stands on what they signed this time, not a higher version from the first', async () => {
      const rows = [
        row({ hash: 'first9', version: 9, ownedFrom: 50 }),
        row({ hash: 'second1', version: 1, ownedFrom: 200 }),
      ];
      const svc = load({ getGlobalAppInfoByIdentity: sinon.stub().resolves(listed(BUYER)), getContentManifests: sinon.stub().resolves(rows) });
      const { row: standing } = await svc.standingManifest(IDENTITY);
      expect(standing.hash, 'version 1 of the later ownership, over version 9 of the earlier').to.equal('second1');
    });

    it('stands on the manifest the listed spec names when its signer is no longer the owner, and sets the racing one aside', async () => {
      const rows = [
        row({ hash: 'named', version: 3, ownedFrom: 100, signer: SELLER }),
        row({ hash: 'racing', version: 4, ownedFrom: 100, signer: SELLER }),
      ];
      const svc = load({ getGlobalAppInfoByIdentity: sinon.stub().resolves(listed(BUYER, { manifest: 'named' })), getContentManifests: sinon.stub().resolves(rows) });
      const { row: standing } = await svc.standingManifest(IDENTITY);
      expect(standing.hash, 'the named one, though the racing one ranks higher').to.equal('named');
    });

    it('stands on nothing, aside, when the spec names a manifest this node lacks', async () => {
      const rows = [row({ hash: 'racing', version: 4, ownedFrom: 100, signer: SELLER })];
      const svc = load({ getGlobalAppInfoByIdentity: sinon.stub().resolves(listed(BUYER, { manifest: 'named' })), getContentManifests: sinon.stub().resolves(rows) });
      const out = await svc.standingManifest(IDENTITY);
      expect(out.row).to.equal(null);
      expect(out.aside).to.equal(true);
    });

    it('stands on nothing, not aside, when no row is valid and the spec names none; the seller\'s row stands again if the row returns to the seller', async () => {
      const rows = [row({ hash: 'seller7', version: 7, ownedFrom: 100, signer: SELLER })];
      const getContentManifests = sinon.stub().resolves(rows);
      const asBuyer = load({ getGlobalAppInfoByIdentity: sinon.stub().resolves(listed(BUYER)), getContentManifests });
      expect(await asBuyer.standingManifest(IDENTITY)).to.include({ row: null, aside: false });
      const backToSeller = load({ getGlobalAppInfoByIdentity: sinon.stub().resolves(listed(SELLER)), getContentManifests });
      expect((await backToSeller.standingManifest(IDENTITY)).row.hash).to.equal('seller7');
    });

    it('ignores rows held unresolved, and stands on nothing for an app not listed', async () => {
      const rows = [row({ hash: 'held', version: 1, ownedFrom: 200, signer: null })];
      const svc = load({ getGlobalAppInfoByIdentity: sinon.stub().resolves(listed(BUYER)), getContentManifests: sinon.stub().resolves(rows) });
      expect((await svc.standingManifest(IDENTITY)).row).to.equal(null);
      const unlisted = load({ getContentManifests: sinon.stub().resolves([row({ hash: 'x', version: 1, ownedFrom: 0 })]) });
      expect(await unlisted.standingManifest(IDENTITY)).to.include({ app: null, row: null, aside: false });
    });

    it('does not stand on a row held unresolved though the spec names its hash: nothing stands, aside, until the row write resolves it', async () => {
      const rows = [row({ hash: 'named', version: 1, ownedFrom: 200, signer: null })];
      const svc = load({ getGlobalAppInfoByIdentity: sinon.stub().resolves(listed(BUYER, { manifest: 'named' })), getContentManifests: sinon.stub().resolves(rows) });
      expect(await svc.standingManifest(IDENTITY)).to.include({ row: null, aside: true });
    });

    it('opens an encrypted spec for the name it carries only when a row the listed owner did not sign needs it', async () => {
      // The sealed spec's own open: what a real EncryptedSpecV9 answers, as a seam.
      const decrypt = sinon.stub().resolves({ content: null });
      const sealed = { sealed: true, createProvider: async () => ({}), decrypt };
      const app = { name: 'myapp', identity: IDENTITY, owner: BUYER, spec: sealed };
      const own = load({ getGlobalAppInfoByIdentity: sinon.stub().resolves(app), getContentManifests: sinon.stub().resolves([row({ hash: 'b1', version: 1, ownedFrom: 200 })]) });
      expect((await own.standingManifest(IDENTITY)).row.hash).to.equal('b1');
      sinon.assert.notCalled(decrypt);
      const other = load({ getGlobalAppInfoByIdentity: sinon.stub().resolves(app), getContentManifests: sinon.stub().resolves([row({ hash: 's1', version: 1, ownedFrom: 100, signer: SELLER })]) });
      await other.standingManifest(IDENTITY);
      sinon.assert.calledOnce(decrypt);
    });
  });

  describe('highestVersionInOwnership', () => {
    it('counts only what this owner signed under this ownership, held or waiting in the pool', async () => {
      const svc = load({
        getContentManifests: sinon.stub().resolves([
          row({ hash: 's7', version: 7, ownedFrom: 100, signer: SELLER }),
          row({ hash: 'b1', version: 1, ownedFrom: 200 }),
          row({ hash: 'old3', version: 3, ownedFrom: 50 }), // the buyer's, from an earlier ownership
        ]),
        carriedManifestRanks: sinon.stub().resolves([{ version: 2, ownedFrom: 200 }, { version: 9, ownedFrom: 100 }]),
      });
      expect(await svc.highestVersionInOwnership(IDENTITY, { owner: BUYER, from: 200 })).to.equal(2);
      expect(await svc.highestVersionInOwnership(IDENTITY, { owner: BUYER, from: 300 })).to.equal(0);
    });
  });

  describe('standingIndex', () => {
    it('lists, per app, the rank of the manifest it stands on, only when that row arrived in a broadcast it can re-serve', async () => {
      const other = `b${'c'.repeat(52)}`;
      const svc = load({
        listResolvedContentManifests: sinon.stub().resolves([
          { identity: IDENTITY, hash: 'b2', version: 2, ownedFrom: 200, signer: BUYER, servable: true },
          { identity: IDENTITY, hash: 'b1', version: 1, ownedFrom: 200, signer: BUYER, servable: true },
          { identity: other, hash: 'o1', version: 1, ownedFrom: 0, signer: BUYER, servable: false },
        ]),
      });
      const standing = sinon.stub().callsFake(async (identity) => ({
        row: identity === IDENTITY ? row({ hash: 'b2', version: 2, ownedFrom: 200 }) : row({ hash: 'o1', version: 1, ownedFrom: 0 }),
      }));
      const index = await svc.standingIndex({ standing });
      expect(index).to.deep.equal([{ identity: IDENTITY, version: 2, ownedFrom: 200 }]);
    });
  });
});
