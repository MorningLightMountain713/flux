'use strict';

const daemonServiceMiscRpcs = require('../daemonService/daemonServiceMiscRpcs');
const appsRepository = require('../appDatabase/appsRepository');
const { resolveInstantiatedSpec } = require('../utils/specCutover');
const { getSpecPolicy } = require('../utils/specLibs');
const { buildPricingEngine, resolveMarketplacePricingCtx } = require('./buildPricingEngine');
const priceOracleState = require('./priceOracleState');

/**
 * The v9 pricing regime — one number.
 *
 * The on-chain price was raised to equal the display price, so a v9 app has a
 * single figure: what the screen quotes is what consensus demands. Every method
 * here reaches PricingEngine, and free-or-not is decided once inside
 * priceUpdate, which both the quote and the consensus path call. There is
 * deliberately no separate free-update rule at this layer — a second opinion
 * could only disagree with the authoritative one.
 *
 * Contrast legacyPricingRegime, where the display price and the chain floor are
 * two different numbers on purpose.
 */

/**
 * Whether on-chain pricing is active (at least one PriceMessage has been
 * published and is effective).
 * @returns {boolean}
 */
function isOnChainPricingActive() {
  const priceHistory = priceOracleState.getPriceMessageHistory();
  if (!priceHistory) return false;
  const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
  if (!syncStatus.data.synced) return false;
  const resolved = priceHistory.resolveAt(syncStatus.data.height);
  return resolved && Object.keys(resolved).length > 0;
}

/**
 * Get the current FLUX/USD rate from the oracle. Returns null if no oracle rate
 * is available (pre-activation or oracle down).
 * @returns {number|null} USD per FLUX, or null.
 */
function getOracleFluxUsdRate() {
  const rateHistory = priceOracleState.getRateMessageHistory();
  if (!rateHistory) return null;
  const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
  if (!syncStatus.data.synced) return null;
  const rateMsg = rateHistory.resolveAt(syncStatus.data.height);
  if (!rateMsg || !rateMsg.fluxUsdPriceE4) return null;
  return rateMsg.fluxUsdPriceE4 / 10000;
}

/**
 * Get the current fiat markup in basis points from PriceModifierHistory. Throws
 * when pricing state isn't ready (no modifier history / daemon not synced),
 * matching the fail-loud posture of onChainDisplayPrice rather than silently
 * pretending there's no markup. Returns 0 only when no PriceModifierMessage has
 * set the field — a genuine "no markup configured" state. The value is bounded
 * at the parse boundary, so this trusts it without re-checking.
 * @returns {number}
 */
function getFiatMarkupBp() {
  const modifierHistory = priceOracleState.getPriceModifierHistory();
  if (!modifierHistory) {
    throw new Error('Price modifier history is not available.');
  }
  const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
  if (!syncStatus.data.synced) {
    throw new Error('Daemon not yet synced.');
  }
  const resolved = modifierHistory.resolveAt(syncStatus.data.height);
  return resolved.fiatMarkupBp || 0;
}

/**
 * Price a v9 update for display, mirroring updateFee so the displayed figure
 * equals the consensus fee. The previous spec is priced at its own
 * registration-height rates for the unused-time credit. The one unavoidable
 * difference from consensus: "now" is the current wall clock, since the update
 * is not yet in a block and the confirming block time is unknown at preview
 * time.
 *
 * @param {object} spec - resolved new v9 spec
 * @param {object} existing - InstantiatedSpec of the prior registration
 * @param {number} daemonHeight - current chain height
 * @returns {Promise<number>} price in FLUX (decimal)
 */
async function onChainDisplayUpdatePrice(spec, existing, daemonHeight) {
  const prevSpec = await resolveInstantiatedSpec(existing);
  const prevHeight = existing.height;

  const oldEngine = await buildPricingEngine(prevHeight);
  const oldBreakdown = await oldEngine.price(prevSpec, {
    height: prevHeight,
    duration: prevSpec.ttl || 0,
    isEncrypted: existing.isEncrypted,
    ...resolveMarketplacePricingCtx(prevSpec, prevHeight),
  });
  const oldScaledPriceMicrodollars = oldBreakdown.marketplaceAdjustedMicrodollars;

  // Old spec's feature set off the breakdown just priced at the old rates (with
  // the old encryption bit). Mirrors updateFee so display == consensus on the
  // free-update feature check, including the cleartext->encrypted case.
  const { usedFeatureKeys } = await getSpecPolicy();
  const oldFeatures = usedFeatureKeys(oldBreakdown.features);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const remainingSeconds = Math.max(0, (existing.registeredAt + (prevSpec.ttl || 0)) - nowSeconds);

  const modifierHistory = priceOracleState.getPriceModifierHistory();
  const modParams = modifierHistory ? modifierHistory.resolveAt(daemonHeight) : null;
  const updateDiscountBp = (modParams && modParams.updateDiscountBp) || 0;

  // The app's register + update history. The free-update rule rate-limits on
  // it (5 in 24h, 8 in 48h, 10 in 120h); passing an empty list would silently
  // disable that cap and quote free for an owner consensus is about to charge.
  const recentEvents = await appsRepository.listAppMessagesByName(spec.name);

  const engine = await buildPricingEngine(daemonHeight);
  const result = await engine.priceUpdate(prevSpec, spec, {
    height: daemonHeight,
    duration: spec.ttl || 0,
    now: Date.now(),
    recentEvents,
    oldScaledPriceMicrodollars,
    oldFeatures,
    remainingSeconds,
    oldTtl: prevSpec.ttl || 0,
    updateDiscountBp,
    // priceUpdate prices the new spec internally, so this is the new spec's bit.
    isEncrypted: spec.isEncrypted,
    ...resolveMarketplacePricingCtx(spec, daemonHeight),
  });
  // REFUSED is a third outcome, and it carries a reason rather than a figure: the
  // update is free-shaped but the allowance is spent, so there is nothing to quote
  // (updateFee declines it outright for the same reason). Reaching for .total here
  // produced undefined / 1e8 = NaN, which serialises to a null price a caller cannot
  // tell from a real one. Thrown rather than returned, because this function already
  // reports 'no price, and here is why' by throwing — an unsynced daemon and an
  // invalid spec both do — and a second way of saying it is how the two callers of
  // one engine drifted apart in the first place. The name lets a UI branch without
  // matching on English; the message is the engine's own reason.
  if (result && result.refused) {
    const refusal = new Error(result.reason || 'update refused');
    refusal.name = 'UpdateRefused';
    throw refusal;
  }
  if (result && result.free) return 0;
  return result.total / 1e8;
}

/**
 * On-chain price in FLUX for display. A query before on-chain pricing is
 * bootstrapped throws rather than returning a misleading 0 — the displayed
 * price is what the customer pays, so a missing rate must fail loudly.
 *
 * @param {object} spec - resolved v9 spec
 * @returns {Promise<number>} Price in FLUX (decimal)
 */
async function onChainDisplayPrice(spec) {
  if (!isOnChainPricingActive()) {
    throw new Error('On-chain pricing is not yet active (no PriceMessage in force).');
  }

  const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
  if (!syncStatus.data.synced) {
    throw new Error('Daemon not yet synced.');
  }
  const daemonHeight = syncStatus.data.height;

  // Display == consensus: if an app of this name already exists, this preview
  // is an update, so price it through priceUpdate (with the unused-time credit)
  // exactly as updateFee will. Otherwise it's a registration and prices via
  // price().
  const existing = await appsRepository.getGlobalAppInfo(spec.name);
  if (existing) {
    return onChainDisplayUpdatePrice(spec, existing, daemonHeight);
  }

  const engine = await buildPricingEngine(daemonHeight);
  const breakdown = await engine.price(spec, {
    height: daemonHeight,
    duration: spec.ttl || 0,
    // Real encryption bit drives the encryptedSpec fee: a cleartext spec reports
    // false, a DecryptedCanonicalSpec (decrypted-from-encrypted) reports true.
    isEncrypted: spec.isEncrypted,
    ...resolveMarketplacePricingCtx(spec, daemonHeight),
  });
  return breakdown.total / 1e8;
}

/**
 * USD + FLUX quote for display. There is no free-update check here: the quote
 * routes through the same priceUpdate call consensus makes, and that call
 * returns 0 when the update is free.
 *
 * @param {object} spec - resolved v9 spec
 * @returns {Promise<{usd: number|null, flux: number, fluxDiscount: number, fiatMarkupBp: number}>}
 */
async function fiatAndFluxDisplayPrice(spec) {
  const fluxPrice = await onChainDisplayPrice(spec);
  const fluxUsdRate = getOracleFluxUsdRate();
  const fiatMarkupBp = getFiatMarkupBp();
  const fluxUsd = fluxUsdRate != null ? fluxPrice * fluxUsdRate : null;
  const usd = fluxUsd != null
    ? Number((fluxUsd * (1 + fiatMarkupBp / 10000)).toFixed(2))
    : null;

  return {
    usd,
    flux: Number(Number(fluxPrice).toFixed(2)),
    // fluxDiscount is a display percent (UI shows "-N%"); fiatMarkupBp is the raw value.
    fluxDiscount: fiatMarkupBp / 100,
    fiatMarkupBp,
  };
}

/**
 * Consensus registration fee in satoshis.
 * @param {object} spec - resolved v9 spec
 * @param {number} height - confirming block height
 * @returns {Promise<bigint>}
 */
async function registrationFee(spec, height) {
  const engine = await buildPricingEngine(height);
  const breakdown = await engine.price(spec, {
    height,
    duration: spec.ttl || 0,
    // Real encryption bit drives the encryptedSpec fee: a cleartext spec reports
    // false, a DecryptedCanonicalSpec (decrypted-from-encrypted) reports true.
    isEncrypted: spec.isEncrypted,
    ...resolveMarketplacePricingCtx(spec, height),
  });
  return BigInt(breakdown.total);
}

/**
 * The permanent message a v9 update supersedes, resolved by confirming height.
 *
 * The height is the only cutoff that works here. The update is already stored
 * when this is asked, so a cutoff admitting its own height returns the update
 * itself — and a spec priced against itself passes every rule in the free-update
 * policy (same ttl, same instances, same placement, same components, same
 * resources, same features), so the update costs nothing. Height also fixes the
 * cutoff on chain rather than on a timestamp the sender writes, so a backdated
 * update cannot reach behind a message that supersedes it.
 *
 * @param {string} name - App name
 * @param {{height: number, timestamp: number}} confirming - the update's
 *   confirming height and message timestamp
 * @returns {Promise<object|null>}
 */
async function supersededMessage(name, confirming) {
  return appsRepository.getPermanentMessageBeforeHeight(name, confirming.height);
}

/**
 * Consensus update fee in satoshis. Returns 0n when priceUpdate rules the
 * update free.
 *
 * @param {object} spec - resolved new v9 spec
 * @param {object} prevSpec - resolved previous spec
 * @param {number} height - confirming block height
 * @param {number} prevHeight - height the previous spec registered at
 * @param {number} prevRegisteredAt - unix seconds the previous spec registered at
 * @param {number} nowBlockTime - unix seconds of the confirming block
 * @returns {Promise<bigint>}
 */
async function updateFee(spec, prevSpec, height, prevHeight, prevRegisteredAt, nowBlockTime) {
  const engine = await buildPricingEngine(height);

  // Price the previous spec at its OWN registration-height rates, scaled to
  // its ttl: the basis for the unused-time credit refunds what was paid, at
  // the rates in force then. The pre-floor figure (marketplaceAdjusted) is
  // used so the credit is never itself raised to minPrice.
  const oldEngine = await buildPricingEngine(prevHeight);
  const oldBreakdown = await oldEngine.price(prevSpec, {
    height: prevHeight,
    duration: prevSpec.ttl || 0,
    isEncrypted: prevSpec.isEncrypted,
    ...resolveMarketplacePricingCtx(prevSpec, prevHeight),
  });
  const oldScaledPriceMicrodollars = oldBreakdown.marketplaceAdjustedMicrodollars;

  // Old spec's feature set, off the breakdown just priced at the old rates
  // (with the old spec's encryption bit). priceUpdate derives the new set from
  // the new breakdown; the free-update rule compares the two, so a feature
  // newly added on this update — including turning encryption on — blocks it.
  const { usedFeatureKeys } = await getSpecPolicy();
  const oldFeatures = usedFeatureKeys(oldBreakdown.features);

  // Unused wall-clock seconds left on the prior registration.
  const remainingSeconds = Math.max(0, (prevRegisteredAt + (prevSpec.ttl || 0)) - nowBlockTime);

  // Flat update discount (0x04 tag 9) resolved at the current height; absent => 0.
  const modifierHistory = priceOracleState.getPriceModifierHistory();
  const modParams = modifierHistory ? modifierHistory.resolveAt(height) : null;
  const updateDiscountBp = (modParams && modParams.updateDiscountBp) || 0;

  // The app's register + update history, so the free-update rate limit can
  // actually count something. With an empty list the cap (5 in 24h, 8 in 48h,
  // 10 in 120h) never fires and free updates are unbounded — every one of
  // which the whole network must relay, verify and store permanently.
  const recentEvents = await appsRepository.listAppMessagesByName(spec.name);

  const result = await engine.priceUpdate(prevSpec, spec, {
    height,
    duration: spec.ttl || 0,
    now: Date.now(),
    recentEvents,
    oldScaledPriceMicrodollars,
    oldFeatures,
    remainingSeconds,
    oldTtl: prevSpec.ttl || 0,
    updateDiscountBp,
    // priceUpdate prices the new spec internally, so this is the new spec's bit.
    isEncrypted: spec.isEncrypted,
    ...resolveMarketplacePricingCtx(spec, height),
  });
  // null = REFUSED: free-shaped but the allowance is spent. There is no
  // payable figure - pricing it would let the mandatory floor payment apply
  // an update that buys nothing, with a term restart the owner never asked
  // for. The caller declines the update outright.
  if (result && result.refused) return null;
  return (result && result.free) ? 0n : BigInt(result.total);
}

module.exports = {
  onChainDisplayPrice,
  fiatAndFluxDisplayPrice,
  registrationFee,
  supersededMessage,
  updateFee,
  isOnChainPricingActive,
};
