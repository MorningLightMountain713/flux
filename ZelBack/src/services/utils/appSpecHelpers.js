const config = require('config');
const dbHelper = require('../dbHelper');
const messageHelper = require('../messageHelper');
const serviceHelper = require('../serviceHelper');
const daemonServiceMiscRpcs = require('../daemonService/daemonServiceMiscRpcs');
const { resolveSpec } = require('./specCutover');
const appsRepository = require('../appDatabase/appsRepository');
const { buildPricingEngine, resolveMarketplacePricingCtx } = require('../pricing/buildPricingEngine');
const priceOracleState = require('../pricing/priceOracleState');
const { legacyGetAppFiatAndFluxPrice, legacyGetAppFluxOnChainPrice } = require('../pricing/legacyDisplayPricing');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const log = require('../../lib/log');

/**
 * Whether on-chain pricing is active (at least one PriceMessage has
 * been published and is effective). Before activation, the display
 * endpoints fall back to the legacy stats.runonflux.io pipeline.
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
 * Get the current FLUX/USD rate from the oracle. Returns null if no
 * oracle rate is available (pre-activation or oracle down).
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
 * Get the current fiat markup in basis points from PriceModifierHistory.
 * Returns 0 if no PriceModifierMessage has set the field.
 * @returns {number}
 */
function getFiatMarkupBp() {
  const modifierHistory = priceOracleState.getPriceModifierHistory();
  if (!modifierHistory) return 0;
  const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
  if (!syncStatus.data.synced) return 0;
  const resolved = modifierHistory.resolveAt(syncStatus.data.height);
  return resolved.fiatMarkupBp || 0;
}

/**
 * Get app Flux on-chain price (FLUX, decimal). Version-island: v1-v8 use the
 * legacy on-chain pricing; v9 uses PricingEngine. A v9 query before on-chain
 * pricing is bootstrapped throws (rather than returning a misleading 0) — the
 * displayed price is what the customer pays, so a missing rate must fail loudly.
 * @param {object} appSpecification - Application specification
 * @returns {Promise<number>} Price in FLUX (decimal)
 */
async function getAppFluxOnChainPrice(appSpecification) {
  const spec = await resolveSpec(appSpecification);

  if (spec.version < 9) {
    return legacyGetAppFluxOnChainPrice(appSpecification);
  }

  if (!isOnChainPricingActive()) {
    throw new Error('On-chain pricing is not yet active (no PriceMessage in force).');
  }

  const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
  if (!syncStatus.data.synced) {
    throw new Error('Daemon not yet synced.');
  }
  const daemonHeight = syncStatus.data.height;

  const engine = await buildPricingEngine(daemonHeight);
  const breakdown = await engine.price(spec, {
    height: daemonHeight,
    duration: spec.ttl || 0,
    ...resolveMarketplacePricingCtx(spec, daemonHeight),
  });
  return breakdown.total / 1e8;
}

function countEnterprisePortsOn(component) {
  const hostPorts = new Set();
  for (const p of Object.values(component.ports || {})) {
    if (p && p.hostPort != null) hostPorts.add(p.hostPort);
  }
  return [...hostPorts].filter((p) => fluxNetworkHelper.isPortEnterprise(p)).length;
}

function hasResourceGrowth(spec, prevSpec) {
  for (const [, compA] of spec.componentEntries()) {
    const compB = prevSpec.getComponent(compA.name);
    if (!compB) return true;
    if (compA.cpu > compB.cpu) return true;
    if (compA.memory > compB.memory) return true;
    const aStorage = (compA.persistentStorage && compA.persistentStorage.sizeGb) || 0;
    const bStorage = (compB.persistentStorage && compB.persistentStorage.sizeGb) || 0;
    if (aStorage > bStorage) return true;
    if (countEnterprisePortsOn(compA) > countEnterprisePortsOn(compB)) return true;
  }
  return false;
}

const SECONDS_PER_BLOCK = 30;
const MAX_FREE_EXTENSION_SECONDS = 8 * SECONDS_PER_BLOCK;

/**
 * Check if an app update qualifies as free (no effective fee).
 * Handles all version combinations (v1-v8 block-based and v9 TTL-based
 * expiry) by normalizing to wall-clock seconds.
 *
 * @param {import('@runonflux/flux-spec').FluxAppSpecBase} spec - New spec
 * @param {number} daemonHeight
 * @returns {Promise<boolean>}
 */
async function checkFreeAppUpdate(spec, daemonHeight) {
  const instantiated = await appsRepository.getGlobalAppInfo(spec.name);
  if (!instantiated) return false;

  const prevSpec = instantiated.isEncrypted
    ? await resolveSpec(instantiated.serialize())
    : instantiated.spec;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const newRemainingSeconds = spec.version >= 9
    ? spec.ttl
    : (spec.expire || 0) * SECONDS_PER_BLOCK;
  if (!newRemainingSeconds) return false;

  let oldRemainingSeconds;
  if (prevSpec.version >= 9) {
    if (!instantiated.registeredAt || !prevSpec.ttl) return false;
    oldRemainingSeconds = (instantiated.registeredAt + prevSpec.ttl) - nowSeconds;
  } else {
    if (!prevSpec.expire) return false;
    oldRemainingSeconds = (instantiated.expiresAtHeight - daemonHeight) * SECONDS_PER_BLOCK;
  }

  const extensionSeconds = newRemainingSeconds - oldRemainingSeconds;

  const placementMatch = spec.placement.staticIp === prevSpec.placement.staticIp;
  const targetsMatch = spec.placement.targetIps.length === prevSpec.placement.targetIps.length
    && spec.placement.targetOutpoints.length === prevSpec.placement.targetOutpoints.length
    && spec.placement.targetOperators.length === prevSpec.placement.targetOperators.length;
  const instancesMatch = spec.instances === prevSpec.instances;
  const extensionOk = extensionSeconds <= MAX_FREE_EXTENSION_SECONDS;

  if (!(placementMatch && targetsMatch && instancesMatch && extensionOk)) {
    log.info(`[checkFreeAppUpdate] App: ${spec.name}, RESULT: NOT FREE - basic conditions failed (placement: ${placementMatch}, targets: ${targetsMatch}, instances: ${instancesMatch}, extension: ${extensionOk})`);
    return false;
  }

  if (hasResourceGrowth(spec, prevSpec)) {
    log.info(`[checkFreeAppUpdate] App: ${spec.name}, RESULT: NOT FREE - resource changes detected`);
    return false;
  }

  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.appsglobal.database);
  const globalAppsMessages = config.database.appsglobal.collections.appsMessages;
  const query = { 'appSpecifications.name': spec.name };
  const projection = { projection: { _id: 0 } };
  const permanentAppMessage = await dbHelper.findInDatabase(database, globalAppsMessages, query, projection);

  // Free-update rate limits: max 10 updates in 5 days, 8 in 2 days, 5 in 1 day.
  let messagesInLasDays = permanentAppMessage.filter(
    (m) => (m.type === 'fluxappupdate' || m.type === 'zelappupdate')
      && m.height > daemonHeight - 3600,
  );
  if (!messagesInLasDays || messagesInLasDays.length === 0) {
    log.info(`[checkFreeAppUpdate] App: ${spec.name}, RESULT: FREE UPDATE (no recent updates)`);
    return true;
  }
  if (messagesInLasDays.length < 11) {
    messagesInLasDays = messagesInLasDays.filter((m) => m.height > daemonHeight - 1440);
    if (messagesInLasDays.length < 9) {
      messagesInLasDays = messagesInLasDays.filter((m) => m.height > daemonHeight - 720);
      if (messagesInLasDays.length < 6) {
        log.info(`[checkFreeAppUpdate] App: ${spec.name}, RESULT: FREE UPDATE (within rate limits)`);
        return true;
      }
    }
  }
  log.info(`[checkFreeAppUpdate] App: ${spec.name}, RESULT: NOT FREE - rate limit exceeded`);
  return false;
}

/**
 * Compute app price (USD + FLUX). Version-island: v1-v8 use the legacy display
 * pricing (with marketplace premium); v9 uses PricingEngine + the on-chain oracle.
 * Pure business logic: takes the parsed appSpecification, returns the price
 * object, throws on error (the *Api handler formats the response).
 * @param {object} appSpecification - parsed application specification
 * @returns {Promise<{usd: number|null, flux: number, fluxDiscount: number|string, fiatMarkupBp?: number}>}
 */
async function getAppFiatAndFluxPrice(appSpecification) {
  if (!appSpecification) {
    throw new Error('Invalid application specification provided.');
  }

  const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
  if (!syncStatus.data.synced) {
    throw new Error('Daemon not yet synced.');
  }
  const daemonHeight = syncStatus.data.height;
  const spec = await resolveSpec(appSpecification);

  if (spec.version < 9) {
    return legacyGetAppFiatAndFluxPrice(appSpecification, { resolveSpecFn: resolveSpec, checkFreeAppUpdateFn: checkFreeAppUpdate });
  }

  if (await checkFreeAppUpdate(spec, daemonHeight)) {
    return { usd: 0, flux: 0, fluxDiscount: 0 };
  }

  const fluxPrice = await getAppFluxOnChainPrice(appSpecification);
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
 * Express handler for the fiat+flux price quote. Reads/parses the request body
 * and formats the response; delegates pricing to getAppFiatAndFluxPrice.
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @returns {Promise<void>}
 */
async function getAppFiatAndFluxPriceApi(req, res) {
  let body = '';
  req.on('data', (data) => {
    body += data;
  });
  req.on('end', async () => {
    try {
      const appSpecification = serviceHelper.ensureObject(serviceHelper.ensureObject(body));
      const price = await getAppFiatAndFluxPrice(appSpecification);
      res.json(messageHelper.createDataMessage(price));
    } catch (error) {
      log.warn(error);
      const errorResponse = messageHelper.createErrorMessage(
        error.message || error,
        error.name,
        error.code,
      );
      res.json(errorResponse);
    }
  });
}

/**
 * Express handler alias for the price quote.
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @returns {Promise<void>}
 */
async function getAppPriceApi(req, res) {
  return getAppFiatAndFluxPriceApi(req, res);
}

module.exports = {
  getAppFiatAndFluxPrice,
  getAppFiatAndFluxPriceApi,
  getAppPriceApi,
  getAppFluxOnChainPrice,
  checkFreeAppUpdate,
};
