'use strict';

const daemonStatus = require('../daemonService/daemonStatus');
const appRecords = require('../appDatabase/appRecords');
const appHistory = require('../appDecisions/appHistory');
const { getSpecPolicy, getSpecBackend } = require('../utils/specLibs');
const { buildPricingEngine, pricesInForceAt } = require('./buildPricingEngine');
const priceOracleState = require('./priceOracleState');
const entitlementsState = require('../entitlementsState');

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
 * The moment a message stamped at `timestamp` is quoted at: its signed time,
 * and the next block's height — the earliest that can confirm its payment.
 * @param {number} timestamp - ms
 * @returns {Promise<{time: number, height: number}>}
 * @throws {Error} while the daemon is not synced: there is no next block to name
 */
async function quoteMoment(timestamp) {
  const syncStatus = daemonStatus.daemonSyncState();
  if (!syncStatus.synced) throw new Error('Daemon not yet synced.');
  const { priceMoment } = await getSpecBackend();
  return priceMoment({ timestamp, height: syncStatus.height + 1 });
}

function pricesInForce(priceHistory, at) {
  const resolved = priceHistory.resolveAt(at);
  return Boolean(resolved) && Object.keys(resolved).length > 0;
}

/**
 * Refuse a moment no PriceMessage is in force at: every rate would read 0 and
 * the engine would price any v9 term at nothing.
 * @param {{time: number, height: number}} at
 * @throws {Error} `PricingNotActive`
 */
function assertPricingActive(at) {
  const priceHistory = priceOracleState.getPriceMessageHistory();
  if (!priceHistory || !pricesInForce(priceHistory, at)) {
    const error = new Error('On-chain pricing is not yet active (no PriceMessage in force).');
    error.name = 'PricingNotActive';
    throw error;
  }
}

/**
 * The prices in force for a message signed at `timestamp`: the moment its
 * quote is priced at (`pricedAt`), and the rates, FLUX/USD rate and price
 * modifiers there. flux-spec-policy's PricingEngine.from builds from them the
 * engine the quote prices with.
 * @param {number} timestamp - ms
 * @returns {Promise<{pricedAt: {time: number, height: number}, prices: object,
 *   fluxUsdPriceE4: ?number, modifiers: object}>}
 * @throws {Error} `PricingNotActive`; and while the daemon is not synced
 */
async function pricesInForceFor(timestamp) {
  const at = await quoteMoment(timestamp);
  assertPricingActive(at);
  return { pricedAt: at, ...(await pricesInForceAt(at)) };
}

/**
 * Whether a v9 spec has a price at a moment: a PriceMessage is in force there.
 * Without one every rate reads 0 and the engine prices any v9 term at nothing.
 *
 * @param {{time: number, height: number}} at
 * @returns {Promise<boolean>}
 * @throws {Error} while the price message history is not built: the question
 *   has an answer this node cannot give yet
 */
async function pricedAt(at) {
  const priceHistory = priceOracleState.getPriceMessageHistory();
  if (!priceHistory) throw new Error('price message history is not built');
  return pricesInForce(priceHistory, at);
}

/**
 * The fiat markup in basis points in force at a moment. Throws when there is no
 * modifier history, matching the fail-loud posture of onChainDisplayPrice
 * rather than silently pretending there's no markup. Returns 0 only when no
 * PriceModifierMessage has set the field — a genuine "no markup configured"
 * state. The value is bounded at the parse boundary, so this trusts it without
 * re-checking.
 * @param {{time: number, height: number}} at
 * @returns {number}
 */
function getFiatMarkupBp(at) {
  const modifierHistory = priceOracleState.getPriceModifierHistory();
  if (!modifierHistory) {
    throw new Error('Price modifier history is not available.');
  }
  return modifierHistory.resolveAt(at).fiatMarkupBp || 0;
}

/**
 * An update priced against its predecessor: the one computation consensus
 * (`updateFee`) and the quote (`quoteUpdate`) both make, so the two cannot
 * drift.
 *
 * Everything is measured at the update's moment: the rates in force there, the
 * credit for the unused share of the predecessor's term at its signed time
 * (`remainingSecondsAt`, the term read as its start plus its length), and the
 * free-update windows ending there. The predecessor's cost arrives from its own
 * regime (`prevTermCost`, see pricingRegime.termCost), so a predecessor of any
 * version is credited the unused share of what it cost.
 *
 * @param {object} spec - resolved new v9 spec
 * @param {object} prevSpec - resolved previous spec, of any version
 * @param {{at: {time: number, height: number}, prevState: {height: number, registeredAt: number},
 *   recentEvents: object[], prevTermCost: object, extend: boolean}} ctx -
 *   `extend` is the event's signed renewal flag; a renewal is never free
 * @returns {Promise<object>} priceUpdate's result
 */
async function priceAgainstPredecessor(spec, prevSpec, {
  at, prevState, recentEvents, prevTermCost, extend,
}) {
  const engine = await buildPricingEngine(at);
  return engine.priceUpdate(prevSpec, spec, {
    height: at.height,
    duration: spec.ttl || 0,
    asOf: at.time * 1000,
    recentEvents,
    ...prevTermCost,
    remainingSeconds: prevSpec.remainingSecondsAt(prevState, at.time),
    oldTtl: prevSpec.termSeconds(prevState),
    extend,
    // priceUpdate prices the new spec internally, so this is the new spec's bit.
    isEncrypted: spec.isEncrypted,
  });
}

/**
 * The fee an update to an existing app will be charged, priced exactly as
 * consensus prices it (`priceAgainstPredecessor`) at the update's moment,
 * against the message it replaces as the decision rule reads it
 * (`replacedMessage`).
 *
 * @param {object} spec - resolved new v9 spec
 * @param {object} existing - RegisteredSpec of the app as it stands
 * @param {{at: {time: number, height: number}, timestamp: number, extend: boolean}} message -
 *   the update's moment, its signed timestamp in ms and its renewal flag
 * @param {(spec: object, at: object) => Promise<object>} termCost - the
 *   predecessor's term cost, from its own regime
 * @returns {Promise<object>} priceUpdate's result
 * @throws {Error} `StampedEarly` when the update is signed at or before the
 *   message it replaces was mined or signed, which consensus refuses
 */
async function quoteUpdate(spec, existing, { at, timestamp, extend }, termCost) {
  const replaced = await appHistory.replacedBy(spec.name);
  if (!replaced || replaced.hash !== existing.hash) {
    throw new Error(`The app ${spec.name} as listed is not the latest applied message; it cannot be quoted yet.`);
  }
  const { prevAt, prevRegisteredAt, signAfter } = replaced;
  if (timestamp <= signAfter) {
    const early = new Error('An update must be signed after the message it replaces was mined and signed.');
    early.name = 'StampedEarly';
    throw early;
  }
  // The app's register + update history. The free-update rule rate-limits on
  // it (5 in 24h, 8 in 48h, 10 in 120h); passing an empty list would silently
  // disable that cap and quote free for an owner consensus is about to charge.
  return priceAgainstPredecessor(spec, existing.spec, {
    at,
    prevState: { height: prevAt.height, registeredAt: prevRegisteredAt },
    recentEvents: await appHistory.appliedUpdateEvents(spec.name),
    prevTermCost: await termCost(existing.spec, prevAt),
    extend,
  });
}

/**
 * The fee in satoshis consensus will charge a message stamped at `timestamp`,
 * whichever block in its payment window confirms it: an update to an app that
 * exists (with the unused-time credit), else a registration. A query before
 * on-chain pricing is bootstrapped throws rather than returning a misleading 0
 * — the price is what the customer pays, so a missing rate must fail loudly.
 *
 * @param {object} spec - resolved v9 spec
 * @param {{termCost: (spec: object, at: object) => Promise<object>}} pricing -
 *   what a predecessor's term cost, from its own regime (pricingRegime.termCost)
 * @param {{timestamp: number, extend: boolean}} message - the message's signed
 *   timestamp in ms and its renewal flag
 * @returns {Promise<{fee: bigint, at: {time: number, height: number}}>} the fee
 *   and the moment it was priced at
 * @throws {Error} `UpdateRefused` when the update is free-shaped with the free
 *   allowance spent; `StampedEarly` (see quoteUpdate); `PricingNotActive`
 */
async function messageFee(spec, { termCost }, { timestamp, extend }) {
  const at = await quoteMoment(timestamp);
  assertPricingActive(at);

  const existing = await appRecords.registry().byName(spec.name);
  if (existing) {
    const result = await quoteUpdate(spec, existing, { at, timestamp, extend }, termCost);
    // REFUSED is a third outcome, and it carries a reason rather than a figure:
    // the update is free-shaped but the allowance is spent, so there is nothing
    // to quote (updateFee declines it outright for the same reason). The name
    // lets a UI branch without matching on English; the message is the engine's
    // own reason.
    if (result && result.refused) {
      const refusal = new Error(result.reason || 'update refused');
      refusal.name = 'UpdateRefused';
      throw refusal;
    }
    if (result && result.free) return { fee: 0n, at };
    return { fee: BigInt(result.total), at };
  }

  return { fee: await registrationFee(spec, at), at };
}

/**
 * The on-chain price in FLUX of a message stamped at `timestamp` (now when
 * absent): `messageFee` in FLUX.
 *
 * @param {object} spec - resolved v9 spec
 * @param {{termCost: (spec: object, at: object) => Promise<object>}} pricing
 * @param {{timestamp?: number, extend?: boolean}} [message]
 * @returns {Promise<number>} Price in FLUX (decimal)
 */
async function onChainDisplayPrice(spec, pricing, { timestamp = Date.now(), extend = false } = {}) {
  const { fee } = await messageFee(spec, pricing, { timestamp, extend });
  return Number(fee) / 1e8;
}

/**
 * A message's quote: the fee in satoshis consensus will charge it
 * (`messageFee`), and what a customer paying in dollars is charged — that fee
 * with the fiat markup, rounded up to .49/.99 (`PricingEngine.fiatPriceOf`), at
 * the rates in force at the message's moment. The dollar figure is never
 * checked on chain.
 *
 * @param {object} spec - resolved v9 spec
 * @param {{termCost: (spec: object, at: object) => Promise<object>}} pricing
 * @param {{timestamp: number, extend: boolean}} message
 * @returns {Promise<{fee: bigint, usd: number|null, fiatMarkupBp: number,
 *   at: {time: number, height: number}}>}
 */
async function messageQuote(spec, pricing, message) {
  const { fee, at } = await messageFee(spec, pricing, message);
  const fiatMarkupBp = getFiatMarkupBp(at);
  const usd = (await buildPricingEngine(at)).fiatPriceOf(fee);
  return {
    fee, usd, fiatMarkupBp, at,
  };
}

/**
 * The quote of a message signed now, in the v1 display shape. There is no
 * free-update check here: the price routes through the same priceUpdate call
 * consensus makes, and that call returns 0 when the update is free.
 *
 * @param {object} spec - resolved v9 spec
 * @param {object} _appSpecification - the raw submitted document (read by the legacy regime only)
 * @param {{termCost: (spec: object, at: object) => Promise<object>}} pricing
 * @returns {Promise<{usd: number|null, flux: number, fluxDiscount: number, fiatMarkupBp: number}>}
 */
async function fiatAndFluxDisplayPrice(spec, _appSpecification, pricing) {
  const { fee, usd, fiatMarkupBp } = await messageQuote(spec, pricing, { timestamp: Date.now(), extend: false });
  return {
    usd,
    flux: Number((Number(fee) / 1e8).toFixed(2)),
    // fluxDiscount is a display percent (UI shows "-N%"); fiatMarkupBp is the raw value.
    fluxDiscount: fiatMarkupBp / 100,
    fiatMarkupBp,
  };
}

/**
 * Consensus registration fee in satoshis.
 * @param {object} spec - resolved v9 spec
 * @param {{time: number, height: number}} at - the registration's moment
 * @returns {Promise<bigint>}
 */
async function registrationFee(spec, at) {
  const engine = await buildPricingEngine(at);
  const breakdown = await engine.price(spec, {
    height: at.height,
    duration: spec.ttl || 0,
    // Real encryption bit drives the encryptedSpec fee: a cleartext spec reports
    // false, a OpenedSpec (decrypted-from-encrypted) reports true.
    isEncrypted: spec.isEncrypted,
  });
  return BigInt(breakdown.total);
}

/**
 * What a v9 term cost: the spec priced at the rates in force at the moment it
 * was bought, for its whole term, before the minimum-price floor, with every
 * quantity the pricer meters for it. An update credits the unused share of it.
 *
 * @param {object} spec - resolved v9 spec
 * @param {{time: number, height: number}} at - the moment the term was bought at
 * @returns {Promise<{oldScaledPriceMicrodollars: number, oldMetered: Map<string, number>}>}
 */
async function termCost(spec, at) {
  const engine = await buildPricingEngine(at);
  const breakdown = await engine.price(spec, {
    height: at.height,
    duration: spec.termSeconds({ height: at.height }),
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
 * The free-update rate limit counts what `recentEvents()` answers: the app's
 * applied updates before this one, stamped with their confirming blocks' times,
 * windowed by this update's signed time: every node counts the same events
 * against the same window, however late it reads the block.
 *
 * @param {object} spec - resolved new v9 spec
 * @param {object} prevSpec - resolved previous spec, of any version
 * @param {{at: {time: number, height: number}, prevAt: {time: number, height: number},
 *   prevRegisteredAt: number, extend: boolean, recentEvents: () => Promise<object[]>,
 *   prevTermCost: object}} ctx - the update's moment, and the term the predecessor
 *   holds (started at `prevRegisteredAt`, bought at `prevAt`); `prevTermCost`
 *   from the predecessor's own regime (pricingRegime.termCost)
 * @returns {Promise<bigint|null>}
 */
async function updateFee(spec, prevSpec, {
  at, prevAt, prevRegisteredAt, extend, recentEvents, prevTermCost,
}) {
  const result = await priceAgainstPredecessor(spec, prevSpec, {
    at,
    prevState: { height: prevAt.height, registeredAt: prevRegisteredAt },
    recentEvents: await recentEvents(),
    prevTermCost,
    extend,
  });
  if (result && result.refused) return null;
  return (result && result.free) ? 0n : BigInt(result.total);
}

/**
 * Why a spec's owner is not entitled, at `height`, to the features the spec
 * uses, or null when it is. A sealed spec is judged on the feature summary it
 * carries in the clear, so every node answers alike.
 *
 * @param {object} spec - resolved v9 spec, readable or sealed
 * @param {number} height
 * @returns {Promise<string|null>}
 * @throws {Error} while the policy-group history is not built: the question
 *   has an answer this node cannot give yet
 */
async function entitlementRefusal(spec, height) {
  const entitlements = entitlementsState.getFeatureEntitlements();
  if (!entitlements) throw new Error('feature entitlements are not built');
  const { PolicyGroupMessage } = await getSpecPolicy();
  let fluxid;
  try {
    fluxid = PolicyGroupMessage.encodeFluxid(spec.owner).bytes;
  } catch {
    return `owner '${spec.owner}' is not a fluxid a policy group can name`;
  }
  const result = entitlements.check(fluxid, spec, height, spec.isEncrypted);
  return result.allowed ? null : result.reason;
}

module.exports = {
  entitlementRefusal,
  messageQuote,
  onChainDisplayPrice,
  fiatAndFluxDisplayPrice,
  pricedAt,
  pricesInForceFor,
  registrationFee,
  termCost,
  updateFee,
};
