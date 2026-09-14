'use strict';

// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const proxyquire = require('proxyquire').noCallThru();
const { load } = require('@runonflux/flux-spec-cjs');

const regime = require('../../ZelBack/src/services/pricing/legacyPricingRegime');

// Every update message the chain has ever carried, projected to the three
// numbers pricing reads: the height the replaced spec was confirmed at, its
// expire, and the height the update is priced at.
//
// Regenerated rather than committed - 3.2MB, and it is derived data:
//   cd ~/code/flux/flux-spec/packages/spec-backend
//   npm run fetch-fixtures && npm run export-pricing-rows
//
// SKIPPED when absent, never failed. A developer without the corpus gets a
// green suite that says so; a suite that fails on a missing fixture is one
// people learn to ignore.
const ROWS_PATH = path.join(
  __dirname, '..', '..', '..', 'flux-spec', 'packages', 'spec-backend',
  'test', 'fixtures', 'pricing-update-rows.json',
);

describe('the early-update credit, over every update on chain', function corpus() {
  this.timeout(120_000);

  let rows;
  let spec;

  before(async function loadCorpus() {
    if (!fs.existsSync(ROWS_PATH)) this.skip();
    this.timeout(120_000);
    spec = await load();
    rows = JSON.parse(fs.readFileSync(ROWS_PATH, 'utf8'));
  });

  // The credit as the source computes it, without the async plumbing: the
  // helper resolves the same two functions out of the spec library.
  const credit = (row, expire) => {
    const paid = spec.subscriptionSeconds({ height: row.prevHeight, expire });
    const elapsed = spec.secondsBetweenHeights(row.prevHeight, row.updateHeight);
    return (paid - elapsed) / paid;
  };

  // A v1-v5 spec carries no expire; pricing substitutes the default for the
  // height it was registered at, which is what these rows are priced from.
  const expireOf = (row) => row.prevExpire ?? regime.getDefaultExpire(row.prevHeight);

  it('never reports a credit above the whole subscription', () => {
    const bad = rows.filter((r) => credit(r, expireOf(r)) > 1);
    expect(bad.length, `${bad.length} rows claim more time than was bought`).to.equal(0);
  });

  it('never reports a credit that is not a number', () => {
    const bad = rows.filter((r) => !Number.isFinite(credit(r, expireOf(r))));
    expect(bad.length, `${bad.length} rows compute to NaN or Infinity`).to.equal(0);
  });

  // The defect itself, stated as an invariant over real history: while the
  // subscription still has time left, the credit must be positive. The old
  // arithmetic went negative here and paid nothing back.
  it('credits every update that lands before its expiry height', () => {
    const bad = rows.filter((r) => {
      const expire = expireOf(r);
      const expiresAt = spec.expiresAtHeightFor({ height: r.prevHeight, expire });
      return r.updateHeight < expiresAt && credit(r, expire) <= 0;
    });
    expect(bad.length, `${bad.length} rows had time left and got nothing`).to.equal(0);
  });

  it('credits nothing to an update that lands at or after its expiry height', () => {
    const bad = rows.filter((r) => {
      const expire = expireOf(r);
      const expiresAt = spec.expiresAtHeightFor({ height: r.prevHeight, expire });
      return r.updateHeight >= expiresAt && credit(r, expire) > 0;
    });
    expect(bad.length, `${bad.length} spent rows were still credited`).to.equal(0);
  });

  // The rows that cross the PON fork are the whole reason this rule is in
  // seconds. Asserted as a population rather than a count, so the test does not
  // have to be repinned when the corpus grows.
  it('credits the fork-crossing rows, which is where the block arithmetic failed', () => {
    const FORK = require('config').get('fluxapps.daemonPONFork');
    const crossing = rows.filter((r) => r.prevHeight < FORK && r.updateHeight >= FORK);
    expect(crossing.length, 'the corpus should contain fork-crossing updates').to.be.above(0);

    const withTimeLeft = crossing.filter((r) => {
      const expire = expireOf(r);
      return r.updateHeight < spec.expiresAtHeightFor({ height: r.prevHeight, expire });
    });
    const uncredited = withTimeLeft.filter((r) => credit(r, expireOf(r)) <= 0);
    expect(uncredited.length, `${uncredited.length} of ${withTimeLeft.length} crossing rows got nothing`).to.equal(0);
  });

  // THE ONE THAT WOULD HAVE CAUGHT THIS. Three sites price an update - two
  // display prices and the fee actually charged - and they disagreed on 723 of
  // these rows, each carrying its own block-space conversion. Driven here for
  // real, with the credit's two inputs recorded: if any site grows its own
  // arithmetic again, the arguments stop matching.
  describe('the three sites that price an update read one credit', () => {
    const FORK = require('config').get('fluxapps.daemonPONFork');
    const PREV_HEIGHT = FORK - 20_000;
    const UPDATE_HEIGHT = FORK + 40_000;
    const EXPIRE = 40_000;

    // Loads the regime with the spec library wrapped, so every question the
    // credit asks is recorded. Everything else is stubbed to the same values
    // for all three, so the only thing that can differ is the credit.
    const loadRecording = (asked) => proxyquire('../../ZelBack/src/services/pricing/legacyPricingRegime', {
      '../utils/specLibs': {
        getSpec: async () => ({
          subscriptionSeconds: (args) => {
            asked.push(`subscription ${args.height}/${args.expire}`);
            return spec.subscriptionSeconds(args);
          },
          secondsBetweenHeights: (from, to) => {
            asked.push(`elapsed ${from}->${to}`);
            return spec.secondsBetweenHeights(from, to);
          },
        }),
      },
      '../utils/appUtilities': { appPricePerMonth: async () => 1000 },
      '../utils/chainUtilities': {
        getChainParamsPriceUpdates: async () => [{ height: 0, minPrice: 0.001 }],
      },
      '../utils/specCutover': {
        resolveSpec: async () => ({ expire: EXPIRE, name: 'app', owner: 'o' }),
        resolveInstantiatedSpec: async () => ({ expire: EXPIRE, name: 'app', owner: 'o' }),
      },
      '../daemonService/daemonServiceMiscRpcs': {
        isDaemonSynced: () => ({ data: { synced: true, height: UPDATE_HEIGHT } }),
      },
      '../dbHelper': {
        databaseConnection: () => ({ db: () => ({}) }),
        findOneInDatabase: async () => ({ height: PREV_HEIGHT, name: 'app' }),
      },
    });

    it('the charged fee and the displayed price ask the credit the same question', async () => {
      const chargeAsked = [];
      await loadRecording(chargeAsked).updateFee(
        { expire: EXPIRE }, { expire: EXPIRE }, UPDATE_HEIGHT, PREV_HEIGHT,
      );

      const displayAsked = [];
      await loadRecording(displayAsked).onChainDisplayPrice({
        expire: EXPIRE,
        name: 'app',
        owner: 'o',
        resourceTotals: () => ({ cpu: 1, memoryMb: 1000, storageGb: 10 }),
        hasActiveStandbySyncthing: () => false,
      });

      expect(chargeAsked, 'the fee path consulted the credit').to.not.be.empty;
      expect(displayAsked, 'the display path consulted the credit').to.not.be.empty;
      expect(displayAsked, 'display and charge must price the same update identically')
        .to.deep.equal(chargeAsked);
    });
  });
});
