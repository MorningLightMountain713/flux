'use strict';

// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const proxyquire = require('proxyquire').noCallThru();
const { load } = require('@runonflux/flux-spec-cjs');


// Every update message the chain has ever carried, projected to the three
// numbers pricing reads: the height the replaced spec was confirmed at, its
// expire, and the height the update is priced at.
//
// Regenerated rather than committed - 3.2MB, and it is derived data:
//   cd ~/code/flux/flux-spec/packages/spec-backend
//   npm run fetch-fixtures && npm run export-pricing-rows
//
// SKIPPED when absent for a developer, REQUIRED in CI. A suite that fails on a
// missing fixture is one people learn to ignore; a suite that skips silently
// where it is meant to run is worse, because a green CI then says the corpus
// was checked when it was not. FLUX_CORPUS_REQUIRED is what tells the two
// apart, and CI sets it.
const ROWS_PATH = process.env.FLUX_PRICING_ROWS || path.join(
  __dirname, '..', '..', '..', 'flux-spec', 'packages', 'spec-backend',
  'test', 'fixtures', 'pricing-update-rows.json',
);
const CORPUS_REQUIRED = process.env.FLUX_CORPUS_REQUIRED === '1';

describe('the early-update credit, over every update on chain', function corpus() {
  this.timeout(120_000);

  let rows;
  let spec;

  before(async function loadCorpus() {
    if (!fs.existsSync(ROWS_PATH)) {
      if (CORPUS_REQUIRED) {
        throw new Error(
          `FLUX_CORPUS_REQUIRED is set and the pricing corpus is absent at ${ROWS_PATH}.\n`
          + '  Generate it:  cd ~/code/flux/flux-spec/packages/spec-backend\n'
          + '                npm run fetch-fixtures && npm run export-pricing-rows',
        );
      }
      this.skip();
    }
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
  const expireOf = (row) => row.prevExpire ?? spec.legacyDefaultExpire(row.prevHeight);

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
    // Priced off storage alone, so the monthly figure is a constant and only
    // the credit can move the answer.
    const CARD = {
      height: 0, cpu: 0, ram: 0, hdd: 100, port: 0, scope: 0, staticip: 0, minPrice: 0.001,
    };
    const APP = {
      name: 'app',
      owner: 'o',
      expire: EXPIRE,
      version: 8,
      instances: 1,
      pricesFlatPerApp: false,
      isEncrypted: false,
      placement: {
        staticIp: false, targetIps: [], targetOutpoints: [], targetOperators: [],
      },
      resourceTotals: () => ({ cpu: 0, memoryMb: 0, storageGb: 30 }),
      componentEntries: () => [],
      hasActiveStandbySyncthing: () => false,
      resourceTotalsFor: () => ({ cpu: 0, memoryMb: 0, storageGb: 30 }),
    };

    const loadRecording = (asked) => proxyquire('../../ZelBack/src/services/pricing/legacyPricingRegime', {
      '../utils/specLibs': {
        // The real library, with the two credit helpers wrapped to record what
        // they were asked. Spread rather than listed, because the regime also
        // reaches for the discount helpers and a stub that names only what this
        // test cares about breaks every time the regime uses one more.
        getSpec: async () => ({
          ...spec,
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
      '../utils/chainUtilities': {
        getChainParamsPriceUpdates: async () => [CARD],
      },
      '../utils/specCutover': {
        resolveSpec: async () => APP,
        resolveInstantiatedSpec: async () => APP,
      },
      '../daemonService/daemonServiceMiscRpcs': {
        isDaemonSynced: () => ({ data: { synced: true, height: UPDATE_HEIGHT } }),
      },
      '../dbHelper': {
        databaseConnection: () => ({ db: () => ({}) }),
        findOneInDatabase: async () => ({ height: PREV_HEIGHT, name: 'app' }),
      },
    });

    it('the charged fee and the displayed price credit the same fraction', async () => {
      // Asserted on the answers, not on which helper each path called. There is
      // one implementation of the credit now, inside the engine, so a test that
      // watched for three sites asking the same question would pass by
      // construction and say nothing.
      const regime = loadRecording([]);
      const asked = [];
      const credited = loadRecording(asked);

      const withCredit = Number(await credited.onChainDisplayPrice(APP));
      const feeWithCredit = Number(await regime.updateFee(APP, APP, UPDATE_HEIGHT, PREV_HEIGHT));

      // The same app with no prior registration: the price before any credit.
      const noPrevious = proxyquire('../../ZelBack/src/services/pricing/legacyPricingRegime', {
        '../utils/chainUtilities': { getChainParamsPriceUpdates: async () => [CARD] },
        '../utils/specCutover': { resolveSpec: async () => APP, resolveInstantiatedSpec: async () => APP },
        '../daemonService/daemonServiceMiscRpcs': {
          isDaemonSynced: () => ({ data: { synced: true, height: UPDATE_HEIGHT } }),
        },
        '../dbHelper': {
          databaseConnection: () => ({ db: () => ({}) }),
          findOneInDatabase: async () => null,
        },
      });
      const displayGross = Number(await noPrevious.onChainDisplayPrice(APP));
      const feeGross = Number(await noPrevious.registrationFee(APP, UPDATE_HEIGHT));

      const displayFraction = (displayGross - withCredit) / displayGross;
      // The fee carries a 0.9 both sides of the subtraction, so it cancels.
      const feeFraction = (Number(feeGross) - Number(feeWithCredit) / 0.9) / Number(feeGross);

      expect(displayFraction, 'the display path credited something').to.be.above(0);
      expect(feeFraction, 'display and charge credit the same fraction')
        // Both paths ceil to cents, so they agree to the cent and not beyond.
        .to.be.closeTo(displayFraction, 1e-4);
    });
  });
});
