'use strict';

/*
 * Pricing regression oracle.
 *
 * Prices every spec in the on-chain corpus, plus the synthetic v9 fixtures,
 * through all four public pricing entry points, and writes the numbers to JSON.
 * Run it before a change and again after: the two dumps must be identical.
 *
 * It exists because a green unit suite does not prove a pricing refactor is
 * safe. proxyquire ignores a stub key that no longer matches a require, so a
 * test can keep passing while silently exercising different code. This compares
 * actual prices instead.
 *
 * Every seam is stubbed on a module singleton rather than by rewiring imports,
 * so the script survives code moving between modules — it only ever touches the
 * four exported entry points.
 *
 *   node tests/tools/price-oracle.js before.json
 *   ...make the change...
 *   node tests/tools/price-oracle.js after.json
 *   node tests/tools/price-oracle.js --compare before.json after.json
 *
 * Needs a flux-spec checkout for the spec corpus. Defaults to a sibling of this
 * repo; override with FLUX_SPEC_DIR.
 */
const path = require('path');
const fs = require('fs');

const REPO = path.resolve(__dirname, '..', '..');
process.env.NODE_CONFIG_DIR = path.join(REPO, 'tests', 'unit', 'globalconfig');

const SPEC_DIR = process.env.FLUX_SPEC_DIR || path.resolve(REPO, '..', 'flux-spec');
const sinon = require('sinon');
const dbHelper = require(REPO + '/ZelBack/src/services/dbHelper');
const daemonServiceMiscRpcs = require(REPO + '/ZelBack/src/services/daemonService/daemonServiceMiscRpcs');
const appsRepository = require(REPO + '/ZelBack/src/services/appDatabase/appsRepository');
const priceOracleState = require(REPO + '/ZelBack/src/services/pricing/priceOracleState');
const axios = require('axios');
const { resolveSpec } = require(REPO + '/ZelBack/src/services/utils/specCutover');

const CORPUS = path.join(SPEC_DIR, 'packages/spec-backend/test/fixtures/all-specs.json');
const V9_CORPUS = path.join(SPEC_DIR, 'packages/spec/test/fixtures/synthetic-v9-specs.json');
const OUT = process.argv[2];

if (OUT === '--compare') {
  const [, , , aPath, bPath] = process.argv;
  if (!aPath || !bPath) {
    console.error('usage: node tests/tools/price-oracle.js --compare <before.json> <after.json>');
    process.exit(2);
  }
  const a = JSON.parse(fs.readFileSync(aPath, 'utf8'));
  const b = JSON.parse(fs.readFileSync(bPath, 'utf8'));
  if (a.length !== b.length) {
    console.error(`row count differs: ${a.length} vs ${b.length}`);
    process.exit(1);
  }
  let differences = 0;
  let compared = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].name !== b[i].name) {
      console.error(`row order differs at ${i}: ${a[i].name} vs ${b[i].name}`);
      process.exit(1);
    }
    for (const k of ['onChain', 'fiatFlux', 'regFee', 'updFee', 'unreadable']) {
      compared += 1;
      const x = JSON.stringify(a[i][k]);
      const y = JSON.stringify(b[i][k]);
      if (x !== y) {
        differences += 1;
        if (differences <= 20) console.log(`DIFF ${a[i].name} ${k}\n  before: ${x}\n  after : ${y}`);
      }
    }
  }
  console.log(`${compared} fields compared, ${differences} differences`);
  process.exit(differences === 0 ? 0 : 1);
}

if (!OUT) {
  console.error('usage: node tests/tools/price-oracle.js <output.json>');
  console.error('       node tests/tools/price-oracle.js --compare <before.json> <after.json>');
  process.exit(2);
}
for (const f of [CORPUS, V9_CORPUS]) {
  if (!fs.existsSync(f)) {
    console.error(`missing spec corpus: ${f}\nSet FLUX_SPEC_DIR to a flux-spec checkout.`);
    process.exit(2);
  }
}
const HEIGHT = 2700000;
const PREV_HEIGHT = 2699000;
const FIXED_NOW = 1750000000000; // pinned so Date.now() cannot vary the dump

// Rates rich enough to exercise every branch of the v9 engine.
const V9_RATES = {
  cpuRate: 142857,
  memoryRate: 47619,
  storageRate: 19048,
  stdPortRate: 0,
  premPortRate: 1904762,
  staticIpRate: 1904762,
  minPrice: 942857,
  minPriceFluxSats: 1000000,
  standardPeriodSeconds: 2640000,
};

async function main() {
  sinon.stub(Date, 'now').returns(FIXED_NOW);
  process.stderr.write('[oracle] stubs installed\n');

  const fakeDb = { db: () => ({}) };
  sinon.stub(dbHelper, 'databaseConnection').returns(fakeDb);
  // chainparams price messages: none, so the config-declared price forks apply.
  sinon.stub(dbHelper, 'findInDatabase').resolves([]);
  sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced')
    .returns({ data: { synced: true, height: HEIGHT } });

  sinon.stub(priceOracleState, 'getPriceMessageHistory')
    .returns({ resolveAt: () => V9_RATES });
  sinon.stub(priceOracleState, 'getRateMessageHistory')
    .returns({ resolveAt: () => ({ fluxUsdPriceE4: 10000 }) });
  sinon.stub(priceOracleState, 'getPriceModifierHistory')
    .returns({ resolveAt: () => ({ fiatMarkupBp: 500, updateDiscountBp: 250 }) });
  sinon.stub(priceOracleState, 'getMarketplacePricingHistory').returns(null);

  sinon.stub(axios, 'get').callsFake(async (url) => {
    if (url.includes('getappspecsusdprice')) {
      return {
        data: {
          status: 'success',
          data: {
            height: -1, cpu: 0.15, ram: 0.05, hdd: 0.02, minPrice: 0.01,
            port: 2, scope: 4, staticip: 2, fluxmultiplier: 0.95,
            multiplier: 1, minUSDPrice: 0.99,
          },
        },
      };
    }
    if (url.includes('marketplace/listapps')) return { data: { status: 'success', data: [] } };
    // fiat rates: [ [ {code, rate} ], { FLUX } ]
    return { data: [[{ code: 'USD', rate: 60000 }], { FLUX: 0.00001 }] };
  });

  const appSpecHelpers = require(REPO + '/ZelBack/src/services/utils/appSpecHelpers');
  const messageVerifier = require(REPO + '/ZelBack/src/services/appMessaging/messageVerifier');

  const corpus = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
  const legacyDocs = (Array.isArray(corpus) ? corpus : Object.values(corpus))
    .filter((s) => s && s.version && s.version < 9);

  const results = [];
  process.stderr.write('[oracle] legacy docs: ' + legacyDocs.length + '\n');

  // ── Legacy: every readable spec in the corpus, priced four ways ──
  for (const doc of legacyDocs) {
    const row = { name: doc.name, version: doc.version, kind: 'legacy' };
    let spec = null;
    try {
      spec = await resolveSpec(doc);
    } catch (e) {
      spec = null;
    }
    if (!spec) {
      row.unreadable = true;
      results.push(row);
      continue;
    }

    // No prior registration on chain: registration-shaped quotes.
    appsRepository.getGlobalAppInfo.restore?.();
    sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(null);
    appsRepository.listAppMessagesByName.restore?.();
    sinon.stub(appsRepository, 'listAppMessagesByName').resolves([]);
    dbHelper.findOneInDatabase.restore?.();
    sinon.stub(dbHelper, 'findOneInDatabase').resolves(null);

    for (const [key, call] of [
      ['onChain', () => appSpecHelpers.getAppFluxOnChainPrice(doc)],
      ['fiatFlux', () => appSpecHelpers.getAppFiatAndFluxPrice(doc)],
      ['regFee', () => messageVerifier.computeRegistrationFee(spec, HEIGHT)],
      ['updFee', () => messageVerifier.computeUpdateFee(
        spec, spec, HEIGHT, PREV_HEIGHT, 0, Math.floor(FIXED_NOW / 1000),
      )],
    ]) {
      try {
        const value = await call();
        row[key] = typeof value === 'bigint' ? value.toString() : value;
      } catch (error) {
        row[key] = `ERR: ${error.message}`;
      }
    }
    results.push(row);
  }

  // ── v9: registration, update, and the free-update path ──
  const v9Fixtures = JSON.parse(fs.readFileSync(V9_CORPUS, 'utf8'));
  const v9Cases = [];
  for (const [key, doc] of Object.entries(v9Fixtures)) {
    v9Cases.push({ label: `v9-reg-${key}`, doc, prior: null });
    v9Cases.push({ label: `v9-upd-${key}`, doc, prior: doc });
  }
  process.stderr.write('[oracle] v9 cases: ' + v9Cases.length + '\n');

  for (const { label, doc, prior } of v9Cases) {
    const spec = await resolveSpec(doc);
    const prevSpec = prior ? await resolveSpec(prior) : null;
    const row = { name: label, version: 9, kind: 'v9' };

    appsRepository.getGlobalAppInfo.restore?.();
    dbHelper.findOneInDatabase.restore?.();
    appsRepository.listAppMessagesByName.restore?.();
    sinon.stub(appsRepository, 'listAppMessagesByName').resolves([]);
    sinon.stub(dbHelper, 'findOneInDatabase').resolves(prior);
    sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(prior ? {
      name: doc.name,
      spec: prevSpec,
      height: PREV_HEIGHT,
      registeredAt: Math.floor(FIXED_NOW / 1000) - 1000,
      isEncrypted: false,
      version: 9,
    } : null);

    for (const [key, call] of [
      ['onChain', () => appSpecHelpers.getAppFluxOnChainPrice(doc)],
      ['fiatFlux', () => appSpecHelpers.getAppFiatAndFluxPrice(doc)],
      ['regFee', () => messageVerifier.computeRegistrationFee(spec, HEIGHT)],
      ['updFee', () => (prevSpec ? messageVerifier.computeUpdateFee(
        spec, prevSpec, HEIGHT, PREV_HEIGHT, Math.floor(FIXED_NOW / 1000) - 1000,
        Math.floor(FIXED_NOW / 1000),
      ) : null)],
    ]) {
      try {
        const value = await call();
        row[key] = typeof value === 'bigint' ? value.toString() : value;
      } catch (error) {
        row[key] = `ERR: ${error.message}`;
      }
    }
    results.push(row);
  }

  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  const priced = results.filter((r) => !r.unreadable).length;
  console.log(`rows: ${results.length} | priced: ${priced} | unreadable: ${results.length - priced}`);
  console.log(`written: ${OUT}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('ORACLE FAILED:', e);
  process.exit(1);
});
