'use strict';

const daemonStatus = require('../daemonService/daemonStatus');
const appsRepository = require('../appDatabase/appsRepository');
const { getSpecPolicy } = require('../utils/specLibs');
const { buildPricingEngine } = require('./buildPricingEngine');
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
  const syncStatus = daemonStatus.isDaemonSynced();
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
  const syncStatus = daemonStatus.isDaemonSynced();
  if (!syncStatus.data.synced) return null;
  const rateMsg = rateHistory.resolveAt(syncStatus.data.height);
  if (!rateMsg || !rateMsg.fluxUsdPriceE4) return null;
  return rateMsg.fluxUsdPriceE4 / 10_000;
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
  const syncStatus = daemonStatus.isDaemonSynced();
  if (!syncStatus.data.synced) {
    throw new Error('Daemon not yet synced.');
  }
  const resolved = modifierHistory.resolveAt(syncStatus.data.height);
  return resolved.fiatMarkupBp || 0;
}

/**
 * An update priced against its predecessor: the one computation consensus
 * (`updateFee`) and the quote (`onChainDisplayUpdatePrice`) both make, so the
 * two cannot drift.
 *
 * The predecessor's term is read through the spec's own accessors and its cost
 * arrives from its own regime (`prevTermCost`, see pricingRegime.termCost), so a
 * predecessor of any version is credited the unused share of what it cost.
 *
 * @param {object} spec - resolved new v9 spec
 * @param {object} prevSpec - resolved previous spec, of any version
 * @param {{height: number, prevState: {height: number, registeredAt: ?number},
 *   at: {tipBlockTime: number, currentHeight: number}, asOf: number,
 *   recentEvents: object[], prevTermCost: object}} ctx
 * @returns {Promise<object>} priceUpdate's result
 */
async function priceAgainstPredecessor(spec, prevSpec, {
  height, prevState, at, asOf, recentEvents, prevTermCost,
}) {
  const modifierHistory = priceOracleState.getPriceModifierHistory();
  const modParams = modifierHistory ? modifierHistory.resolveAt(height) : null;
  const updateDiscountBp = (modParams && modParams.updateDiscountBp) || 0;

  const engine = await buildPricingEngine(height);
  return engine.priceUpdate(prevSpec, spec, {
    height,
    duration: spec.ttl || 0,
    asOf,
    recentEvents,
    ...prevTermCost,
    remainingSeconds: prevSpec.remainingSeconds(prevState, at),
    oldTtl: prevSpec.termSeconds(prevState),
    updateDiscountBp,
    // priceUpdate prices the new spec internally, so this is the new spec's bit.
    isEncrypted: spec.isEncrypted,
  });
}

/**
 * On-chain display price for an update to an existing app.
 *
 * Priced exactly as consensus prices it (`priceAgainstPredecessor`), at the
 * current height and now: the update is not yet in a block and the confirming
 * block time is unknown at preview time.
 *
 * @param {object} spec - resolved new v9 spec
 * @param {object} existing - InstantiatedSpec of the prior registration
 * @param {number} daemonHeight - current chain height
 * @param {(spec: object, height: number) => Promise<object>} termCost - the
 *   predecessor's term cost, from its own regime
 * @returns {Promise<number>} price in FLUX (decimal)
 */
async function onChainDisplayUpdatePrice(spec, existing, daemonHeight, termCost) {
  // The app's register + update history. The free-update rule rate-limits on
  // it (5 in 24h, 8 in 48h, 10 in 120h); passing an empty list would silently
  // disable that cap and quote free for an owner consensus is about to charge.
  // A quote has no confirming block yet, so its windows end at the moment it
  // is asked.
  const recentEvents = await appsRepository.listAppMessagesByName(spec.name);
  const result = await priceAgainstPredecessor(spec, existing.spec, {
    height: daemonHeight,
    prevState: { height: existing.height, registeredAt: existing.registeredAt },
    at: { tipBlockTime: Math.floor(Date.now() / 1000), currentHeight: daemonHeight },
    asOf: Date.now(),
    recentEvents,
    prevTermCost: await termCost(existing.spec, existing.height),
  });
  // REFUSED is a third outcome, and it carries a reason rather than a figure: the
  // update is free-shaped but the allowance is spent, so there is nothing to quote
  // (updateFee declines it outright for the same reason). Thrown rather than
  // returned, because this function already reports 'no price, and here is why'
  // by throwing — an unsynced daemon and an invalid spec both do. The name lets a
  // UI branch without matching on English; the message is the engine's own reason.
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
 * @param {{termCost: (spec: object, height: number) => Promise<object>}} pricing -
 *   what a predecessor's term cost, from its own regime (pricingRegime.termCost)
 * @returns {Promise<number>} Price in FLUX (decimal)
 */
async function onChainDisplayPrice(spec, { termCost }) {
  if (!isOnChainPricingActive()) {
    throw new Error('On-chain pricing is not yet active (no PriceMessage in force).');
  }

  const syncStatus = daemonStatus.isDaemonSynced();
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
    return onChainDisplayUpdatePrice(spec, existing, daemonHeight, termCost);
  }

  const engine = await buildPricingEngine(daemonHeight);
  const breakdown = await engine.price(spec, {
    height: daemonHeight,
    duration: spec.ttl || 0,
    // Real encryption bit drives the encryptedSpec fee: a cleartext spec reports
    // false, a DecryptedCanonicalSpec (decrypted-from-encrypted) reports true.
    isEncrypted: spec.isEncrypted,
  });
  return breakdown.total / 1e8;
}

/**
 * The network price in FLUX, and what a customer paying in dollars is charged:
 * that price with the fiat markup, rounded up to .49/.99 (`fiatPrice`). The
 * dollar figure is never checked on chain. There is no free-update check here: the quote
 * routes through the same priceUpdate call consensus makes, and that call
 * returns 0 when the update is free.
 *
 * @param {object} spec - resolved v9 spec
 * @param {object} _appSpecification - the raw submitted document (read by the legacy regime only)
 * @param {{termCost: (spec: object, height: number) => Promise<object>}} pricing
 * @returns {Promise<{usd: number|null, flux: number, fluxDiscount: number, fiatMarkupBp: number}>}
 */
async function fiatAndFluxDisplayPrice(spec, _appSpecification, pricing) {
  const fluxPrice = await onChainDisplayPrice(spec, pricing);
  const fluxUsdRate = getOracleFluxUsdRate();
  const fiatMarkupBp = getFiatMarkupBp();
  const { fiatPrice } = await getSpecPolicy();
  const usd = fluxUsdRate != null ? fiatPrice(fluxPrice * fluxUsdRate, fiatMarkupBp) : null;

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
 * What a v9 term cost: the spec priced at the rates in force at `height`, for
 * its whole term, before the minimum-price floor, with every quantity the
 * pricer meters for it. An update credits the unused share of it.
 *
 * @param {object} spec - resolved v9 spec
 * @param {number} height - the height the term was bought at
 * @returns {Promise<{oldScaledPriceMicrodollars: number, oldMetered: Map<string, number>}>}
 */
async function termCost(spec, height) {
  const engine = await buildPricingEngine(height);
  const breakdown = await engine.price(spec, {
    height,
    duration: spec.termSeconds({ height }),
    isEncrypted: spec.isEncrypted,
  });
  const { meteredQuantities } = await getSpecPolicy();
  return {
    oldScaledPriceMicrodollars: breakdown.preFloorMicrodollars,
    oldMetered: meteredQuantities(breakdown),
  };
}

/**
 * Consensus update fee in satoshis. Returns 0n when priceUpdate rules the
 * update free, and null when it refuses it: free-shaped with the free-update
 * allowance spent, so there is no payable figure — pricing it would let the
 * mandatory floor payment apply an update that buys nothing, with a term
 * restart the owner never asked for.
 *
 * The free-update rate limit counts `recentEvents`, the app's events the chain
 * had accepted when this update confirmed, windowed by the confirming block's
 * time: every node counts the same events against the same window, however
 * late it reads the block.
 *
 * @param {object} spec - resolved new v9 spec
 * @param {object} prevSpec - resolved previous spec, of any version
 * @param {{height: number, prevHeight: number, prevRegisteredAt: ?number,
 *   nowBlockTime: number, recentEvents: object[], prevTermCost: object}} ctx -
 *   `prevTermCost` from the predecessor's own regime (pricingRegime.termCost)
 * @returns {Promise<bigint|null>}
 */
async function updateFee(spec, prevSpec, {
  height, prevHeight, prevRegisteredAt, nowBlockTime, recentEvents, prevTermCost,
}) {
  const result = await priceAgainstPredecessor(spec, prevSpec, {
    height,
    prevState: { height: prevHeight, registeredAt: prevRegisteredAt },
    at: { tipBlockTime: nowBlockTime, currentHeight: height },
    asOf: nowBlockTime * 1000,
    recentEvents,
    prevTermCost,
  });
  if (result && result.refused) return null;
  return (result && result.free) ? 0n : BigInt(result.total);
}

module.exports = {
  onChainDisplayPrice,
  fiatAndFluxDisplayPrice,
  registrationFee,
  supersededMessage,
  termCost,
  updateFee,
  isOnChainPricingActive,
};
