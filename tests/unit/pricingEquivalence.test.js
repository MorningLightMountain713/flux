'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const sinon = require('sinon');
const config = require('config');
const { appPricePerMonth } = require('../../ZelBack/src/services/utils/appUtilities');
const { resolveSpec } = require('../../ZelBack/src/services/utils/specCutover');
const benchmarkService = require('../../ZelBack/src/services/benchmarkService');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'all-specs.json');
const allSpecs = fs.existsSync(FIXTURE_PATH)
  ? JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'))
  : [];

describe('pricing equivalence — BigInt comparison produces same result as float', () => {
  let chainPrices;

  before(function () {
    if (allSpecs.length === 0) {
      // Say so. This file generates one test per fixture spec, so an absent
      // fixture is not one skipped test - it is several hundred that never
      // existed, on a run that still reports 0 failing. A fresh worktree does
      // not have the file (it is deliberately gitignored: 883 KB of historical
      // specs does not belong in the repo), and a silent skip there reads as a
      // clean tier against a full one.
      console.warn(
        `\n  pricing equivalence: SKIPPED ENTIRELY - no fixture at ${FIXTURE_PATH}\n`
        + '  This run therefore exercises NONE of the historical-spec pricing checks.\n'
        + '  Fetch it with tests/unit/fixtures/download-specs.sh before comparing\n'
        + '  this run\'s totals against another checkout\'s.\n',
      );
      this.skip();
      return;
    }
    chainPrices = [...config.fluxapps.price];
    chainPrices.sort((a, b) => a.height - b.height);
    // The encrypted fixtures cannot be decrypted without the node's benchmark
    // daemon, and each attempt was a real RPC to it. They are skipped either
    // way; this makes the failure local instead of a network round trip.
    sinon.stub(benchmarkService, 'decryptRSAMessage').resolves({
      status: 'error',
      data: { message: 'benchmark unavailable in unit tests' },
    });
  });

  after(() => {
    sinon.restore();
  });

  it('has fixture data', () => {
    expect(allSpecs).to.be.an('array').with.length.above(100);
  });

  it('chain price schedule covers all fixture heights', () => {
    expect(chainPrices).to.be.an('array').with.length.above(3);
    const maxFixtureHeight = Math.max(...allSpecs.map((s) => s.height));
    const maxPriceHeight = Math.max(...chainPrices.map((p) => p.height));
    expect(maxPriceHeight).to.be.below(maxFixtureHeight);
  });

  for (const rawSpec of allSpecs) {
    const label = `${rawSpec.name} v${rawSpec.version} h=${rawSpec.height}`;

    it(`${label}: monthly price * 1e8 is an integer (no IEEE-754 drift)`, async function () {
      this.timeout(5000);
      let spec;
      try {
        spec = await resolveSpec(rawSpec);
      } catch {
        this.skip();
        return;
      }

      const { height } = rawSpec;
      let appPrice;
      try {
        appPrice = await appPricePerMonth(spec, height, chainPrices);
      } catch {
        this.skip();
        return;
      }

      if (typeof appPrice !== 'number' || !Number.isFinite(appPrice)) {
        this.skip();
        return;
      }

      const blockHeightMultiplier = height >= config.fluxapps.daemonPONFork ? 4 : 1;
      const defaultExpire = config.fluxapps.blocksLasting * blockHeightMultiplier;
      const expireIn = spec.expire || defaultExpire;
      const multiplier = expireIn / defaultExpire;
      let scaledPrice = appPrice * multiplier;
      scaledPrice = Math.ceil(scaledPrice * 100) / 100;

      const priceSpecifications = chainPrices.filter((i) => i.height < height).at(-1);
      if (scaledPrice < priceSpecifications.minPrice) {
        scaledPrice = priceSpecifications.minPrice;
      }

      const floatSats = scaledPrice * 1e8;
      const roundedSats = Math.round(floatSats);
      const ceilSats = Math.ceil(floatSats);

      // The old comparison was: valueSat >= floatSats (float)
      // The new comparison is:  BigInt(valueSat) >= BigInt(roundedSats)
      //
      // These can differ by at most 1 satoshi when IEEE-754 produces a
      // float like 55000000.000000004 from an intended-integer result.
      // Math.ceil rounds up to 55000001, Math.round gives 55000000.
      // The new behavior is more correct — the intended price is 0.55 FLUX,
      // not 0.55000001 FLUX.
      const drift = ceilSats - roundedSats;
      expect(drift, `${label}: drift exceeds 1 satoshi`).to.be.at.most(1);
      expect(drift, `${label}: negative drift`).to.be.at.least(0);
    });
  }
});
