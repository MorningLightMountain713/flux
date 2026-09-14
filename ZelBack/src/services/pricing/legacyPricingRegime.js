'use strict';

const config = require('config');
const axios = require('axios');
const dbHelper = require('../dbHelper');
const daemonServiceMiscRpcs = require('../daemonService/daemonServiceMiscRpcs');
const appsRepository = require('../appDatabase/appsRepository');
const { resolveSpec, resolveInstantiatedSpec } = require('../utils/specCutover');
const { getSpec } = require('../utils/specLibs');
const { getChainParamsPriceUpdates } = require('../utils/chainUtilities');
const cacheManager = require('../utils/cacheManager').default;
const log = require('../../lib/log');

/**
 * The v1-v8 pricing regime — two numbers, on purpose.
 *
 * The on-chain fee these specs must pay is a near-zero floor, so what an owner
 * is actually charged is the display price (with the marketplace premium).
 * "What the screen says" and "what the chain demands" are genuinely different
 * figures. Contrast v9PricingRegime, where the on-chain price was raised to
 * equal the display price and there is only one figure.
 *
 * Nothing here computes a price. The arithmetic is flux-spec's
 * LegacyPricingEngine, built with the rates and market data this file fetches
 * and handed the stored registration per call. What stays is the fetching, and
 * the shapes the rest of FluxOS expects back.
 */

const globalAppsInformation = config.get('database.appsglobal.collections.appsInformation');

const myShortCache = cacheManager.fluxRatesCache;
const myLongCache = cacheManager.appPriceBlockedRepoCache;

/** The height the daemon is synced to, or a refusal to price without one. */
function syncedHeight() {
  const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
  if (!syncStatus.data.synced) throw new Error('Daemon not yet synced.');
  return syncStatus.data.height;
}

/**
 * The operator's USD table. Cached long: a commercial rate card, not chain
 * state, and every quote reads it.
 */
async function usdRates() {
  if (myLongCache.has('appPrices')) return myLongCache.get('appPrices');

  const response = await axios
    .get(`${config.get('stats.baseUrl')}/apps/getappspecsusdprice`, { timeout: 5000 })
    .catch((error) => log.error(error));

  const table = response && response.data && response.data.status === 'success'
    ? response.data.data
    : config.get('fluxapps.usdprice');
  myLongCache.set('appPrices', table);
  return table;
}

/**
 * The marketplace templates, carrying the per-template price multiplier.
 *
 * Fetched per quote and uncached, as this has always behaved. A failure is
 * silent by design: the quote goes out without the multiplier rather than not
 * at all.
 */
async function marketplaceApps() {
  const response = await axios
    .get(`${config.get('stats.baseUrl')}/marketplace/listapps`)
    .catch((error) => log.error(error));

  if (response && response.data && response.data.status === 'success') return response.data.data;
  log.error('Unable to get marketplace information');
  return [];
}

/** USD per FLUX, from the rates feed, falling back to coingecko then config. */
async function fluxUsdRate() {
  if (myShortCache.has('fluxRates')) return myShortCache.get('fluxRates');

  const axiosConfig = { timeout: 5000 };
  const fiatRates = await axios
    .get(`${config.get('pricing.fluxRatesBaseUrl')}/rates`, axiosConfig)
    .catch((error) => log.error(error));

  if (fiatRates && fiatRates.data) {
    const rateObj = fiatRates.data[0].find((rate) => rate.code === 'USD');
    if (!rateObj) throw new Error('Unable to get USD rate.');
    const btcRateforFlux = fiatRates.data[1].FLUX;
    if (btcRateforFlux === undefined) throw new Error('Unable to get Flux USD Price.');
    const rate = rateObj.rate * btcRateforFlux;
    myShortCache.set('fluxRates', rate);
    return rate;
  }

  const fallback = await axios.get(
    `${config.get('pricing.coingeckoBaseUrl')}/api/v3/simple/price?vs_currencies=usd&ids=zelcash`,
    axiosConfig,
  );
  const rate = (fallback && fallback.data && fallback.data.zelcash && fallback.data.zelcash.usd)
    || config.get('fluxapps.fluxUSDRate');
  myShortCache.set('fluxRates', rate);
  return rate;
}

/** The app's stored registration, resolved. Null when never registered. */
async function storedRegistration(name) {
  const db = dbHelper.databaseConnection();
  const database = db.db(config.get('database.appsglobal.database'));
  const doc = await dbHelper.findOneInDatabase(
    database, globalAppsInformation, { name }, { projection: { _id: 0 } },
  );
  if (!doc) return null;
  return { spec: await resolveSpec(doc), height: doc.height };
}

/** The engine, built with whatever this call needs fetched. */
async function engineFor({ quote = false } = {}) {
  const { LegacyPricingEngine } = await getSpec();
  const chainRates = await getChainParamsPriceUpdates();
  if (!quote) return new LegacyPricingEngine({ chainRates });

  const [usd, marketplace, rate] = await Promise.all([
    usdRates(), marketplaceApps(), fluxUsdRate(),
  ]);
  return new LegacyPricingEngine({
    chainRates, usdRates: usd, marketplaceApps: marketplace, fluxUsdRate: rate,
  });
}

/**
 * Whether a v1-v8 update qualifies as free on the display price.
 *
 * A v9 spec must never be passed here. v9 decides free-or-not inside
 * PricingEngine.priceUpdate, which both its quote and consensus reach.
 *
 * @param {import('@runonflux/flux-spec').FluxAppSpecBase} spec - New spec (v1-v8)
 * @param {number} daemonHeight
 * @returns {Promise<boolean>}
 */
async function checkLegacyFreeUpdate(spec, daemonHeight) {
  const { checkLegacyFreeUpdate: rule } = await getSpec();
  const instantiated = await appsRepository.getGlobalAppInfo(spec.name);
  const messages = instantiated ? await appsRepository.listAppMessagesByName(spec.name) : [];

  const { free, reason } = rule({
    oldSpec: instantiated ? await resolveInstantiatedSpec(instantiated) : null,
    newSpec: spec,
    expiresAtHeight: instantiated && instantiated.expiresAtHeight,
    recentEvents: messages
      .filter((m) => m.type === 'fluxappupdate' || m.type === 'zelappupdate')
      .map((m) => m.height),
    height: daemonHeight,
  });
  // Every outcome says why: an operator reading "NOT FREE" with nothing else
  // cannot tell a rate limit from a spec the rule could never price.
  log.info(`[checkLegacyFreeUpdate] App: ${spec.name}, RESULT: ${free ? 'FREE UPDATE' : 'NOT FREE'} - ${reason}`);
  return free;
}

/**
 * On-chain price in FLUX for display — the near-zero floor, not what the owner
 * is charged. A fixed-2 string; every caller wraps it in Number().
 *
 * @param {object} spec - resolved v1-v8 spec
 * @returns {Promise<string>}
 */
async function onChainDisplayPrice(spec) {
  const height = syncedHeight();
  const engine = await engineFor();
  const previous = await storedRegistration(spec.name);
  return engine.chainFloorPrice(spec, { height, previous });
}

/**
 * USD + FLUX quote for display — the figure an owner actually pays, waived
 * entirely when the update is free.
 *
 * @param {object} spec - resolved v1-v8 spec
 * @param {object} appSpecification - the raw submitted document, for priceUSD:
 *   a marketplace field carried on the request that exists on no spec class
 * @returns {Promise<{usd: number, flux: number, fluxDiscount: number|string}>}
 */
async function fiatAndFluxDisplayPrice(spec, appSpecification) {
  const height = syncedHeight();
  if (await checkLegacyFreeUpdate(spec, height)) return { usd: 0, flux: 0, fluxDiscount: 0 };

  const engine = await engineFor({ quote: true });
  const previous = await storedRegistration(spec.name);
  return engine.quote(spec, { height, previous, priceUSD: appSpecification.priceUSD });
}

/**
 * Consensus registration fee in satoshis — the near-zero floor.
 * @param {object} spec - resolved v1-v8 spec
 * @param {number} height - confirming block height
 * @returns {Promise<bigint>}
 */
async function registrationFee(spec, height) {
  const engine = await engineFor();
  return engine.registrationFee(spec, height);
}

/**
 * The permanent message a v1-v8 update supersedes, resolved as this network has
 * always resolved it: newest message at or before the update's own timestamp.
 *
 * The update is already stored when this is asked, and its own record satisfies
 * that cutoff at the greatest height, so the answer is the update itself. Every
 * term of updateFee then cancels — same spec, same height, zero height
 * difference, full unused-time credit — and the fee is the minPrice floor.
 *
 * That IS the legacy rule: the chain floor and the display price are two
 * numbers on purpose, and the floor is what the network has enforced for every
 * legacy update since height 1004000. It is reproduced exactly rather than
 * corrected, because a node demanding the prorated figure would reject updates
 * every other node accepts, and no node can reprice history.
 *
 * @param {string} name - App name
 * @param {{height: number, timestamp: number}} confirming
 * @returns {Promise<object|null>}
 */
async function supersededMessage(name, confirming) {
  return appsRepository.getPreviousPermanentMessage(name, confirming.timestamp);
}

/**
 * Consensus update fee in satoshis, crediting the unused prior subscription.
 * prevRegisteredAt and nowBlockTime are part of the shared regime interface and
 * unused here: legacy credits unused time from the heights alone.
 *
 * @param {object} spec - resolved new v1-v8 spec
 * @param {object} prevSpec - resolved previous spec
 * @param {number} height - confirming block height
 * @param {number} prevHeight - height the previous spec registered at
 * @returns {Promise<bigint>}
 */
async function updateFee(spec, prevSpec, height, prevHeight) {
  const engine = await engineFor();
  return engine.updateFee(spec, prevSpec, height, prevHeight);
}

module.exports = {
  onChainDisplayPrice,
  fiatAndFluxDisplayPrice,
  registrationFee,
  supersededMessage,
  updateFee,
  checkLegacyFreeUpdate,
};
