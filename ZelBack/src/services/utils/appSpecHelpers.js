const config = require('config');
const dbHelper = require('../dbHelper');
const messageHelper = require('../messageHelper');
const serviceHelper = require('../serviceHelper');
const daemonServiceMiscRpcs = require('../daemonService/daemonServiceMiscRpcs');
const { resolveSpec } = require('./specCutover');
const { appPricePerMonth } = require('./appUtilities');
const { getChainParamsPriceUpdates } = require('./chainUtilities');
const appsRepository = require('../appDatabase/appsRepository');
const { buildPricingEngine } = require('../pricing/buildPricingEngine');
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
 * Get the current fiat markup percentage from PriceModifierHistory.
 * Returns 0 if no PriceModifierMessage has set the field.
 * @returns {number}
 */
function getFiatMarkupPct() {
  const modifierHistory = priceOracleState.getPriceModifierHistory();
  if (!modifierHistory) return 0;
  const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
  if (!syncStatus.data.synced) return 0;
  const resolved = modifierHistory.resolveAt(syncStatus.data.height);
  return resolved.fiatMarkupPct || 0;
}

/**
 * Get app Flux on-chain price. v9 specs use PricingEngine; v1-v8 use
 * appPricePerMonth with chain rates.
 * @param {object} appSpecification - Application specification
 * @returns {Promise<number>} Price in FLUX (decimal)
 */
async function getAppFluxOnChainPrice(appSpecification) {
  if (!isOnChainPricingActive()) {
    return legacyGetAppFluxOnChainPrice(appSpecification);
  }

  const spec = await resolveSpec(appSpecification);

  const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
  if (!syncStatus.data.synced) {
    throw new Error('Daemon not yet synced.');
  }
  const daemonHeight = syncStatus.data.height;

  if (spec.version >= 9) {
    const engine = await buildPricingEngine(daemonHeight);
    const breakdown = await engine.price(spec, { height: daemonHeight, duration: spec.ttl || 0 });
    return breakdown.total / 1e8;
  }

  const appPrices = await getChainParamsPriceUpdates();
  const intervals = appPrices.filter((i) => i.height < daemonHeight);
  const priceSpecifications = intervals[intervals.length - 1];

  const blockHeightMultiplier = daemonHeight >= config.fluxapps.daemonPONFork ? 4 : 1;
  const defaultExpire = config.fluxapps.blocksLasting * blockHeightMultiplier;

  let appPrice = await appPricePerMonth(spec, daemonHeight, appPrices);
  const expireIn = spec.expire || defaultExpire;
  appPrice *= expireIn / defaultExpire;
  appPrice = Math.ceil(appPrice * 100) / 100;
  if (appPrice < priceSpecifications.minPrice) {
    appPrice = priceSpecifications.minPrice;
  }
  return appPrice;
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

/**
 * Check if an app update qualifies as free (no effective fee).
 *
 * Takes a class instance; mutates `spec.expire` on free updates to remove
 * any subscription extension — the caller is responsible for holding a
 * spec whose expire field is safe to mutate (the submission path already
 * uses a fresh instance).
 *
 * @param {import('@runonflux/flux-spec').FluxAppSpecBase} spec - New spec
 * @param {number} daemonHeight
 * @returns {Promise<boolean>}
 */
async function checkFreeAppUpdate(spec, daemonHeight) {
  const instantiated = await appsRepository.getGlobalAppInfo(spec.name);
  if (!instantiated || !spec.expire) return false;

  const prevSpec = instantiated.isEncrypted()
    ? await resolveSpec(instantiated.serialize())
    : instantiated.spec;

  if (!prevSpec.expire) return false;

  const newExpirationHeight = Number(daemonHeight) + spec.expire;
  const blocksToExtend = newExpirationHeight - instantiated.expiresAtHeight;

  const staticipMatch = (spec.staticip ?? false) === (prevSpec.staticip ?? false);
  const aNodes = spec.nodes || [];
  const bNodes = prevSpec.nodes || [];
  const nodesMatch = aNodes.length === bNodes.length;
  const instancesMatch = spec.instances === prevSpec.instances;
  const blocksOk = blocksToExtend <= 8;

  if (!(nodesMatch && instancesMatch && staticipMatch && blocksOk)) {
    log.info(`[checkFreeAppUpdate] App: ${spec.name}, RESULT: NOT FREE - basic conditions failed (nodes: ${nodesMatch}, instances: ${instancesMatch}, staticip: ${staticipMatch}, blocks: ${blocksOk})`);
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
 * Get app price with Fiat and Flux pricing.
 *
 * When on-chain pricing is active (PriceMessage published): FLUX price
 * from PricingEngine (v9) or chain rates (v1-v8), USD from oracle.
 *
 * Before activation: falls back to the legacy pipeline
 * (stats.runonflux.io USD rates + viprates FLUX/USD conversion).
 *
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @returns {Promise<void>} Price response
 */
async function getAppFiatAndFluxPrice(req, res) {
  if (!isOnChainPricingActive()) {
    return legacyGetAppFiatAndFluxPrice(req, res, { resolveSpecFn: resolveSpec, checkFreeAppUpdateFn: checkFreeAppUpdate });
  }

  let body = '';
  req.on('data', (data) => {
    body += data;
  });
  req.on('end', async () => {
    try {
      const appSpecification = serviceHelper.ensureObject(serviceHelper.ensureObject(body));
      if (!appSpecification) {
        throw new Error('Invalid application specification provided.');
      }

      const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
      if (!syncStatus.data.synced) {
        throw new Error('Daemon not yet synced.');
      }
      const daemonHeight = syncStatus.data.height;
      const spec = await resolveSpec(appSpecification);

      if (await checkFreeAppUpdate(spec, daemonHeight)) {
        const price = { usd: 0, flux: 0, fluxDiscount: 0 };
        return res.json(messageHelper.createDataMessage(price));
      }

      const fluxPrice = await getAppFluxOnChainPrice(appSpecification);
      const fluxUsdRate = getOracleFluxUsdRate();
      const fiatMarkupPct = getFiatMarkupPct();
      const fluxUsd = fluxUsdRate != null ? fluxPrice * fluxUsdRate : null;
      const usd = fluxUsd != null
        ? Number((fluxUsd * (1 + fiatMarkupPct / 100)).toFixed(2))
        : null;

      const price = {
        usd,
        flux: Number(Number(fluxPrice).toFixed(2)),
        fluxDiscount: fiatMarkupPct,
        fiatMarkupPct,
      };
      return res.json(messageHelper.createDataMessage(price));
    } catch (error) {
      log.warn(error);
      const errorResponse = messageHelper.createErrorMessage(
        error.message || error,
        error.name,
        error.code,
      );
      return res.json(errorResponse);
    }
  });
}

/**
 * Get app price (simplified wrapper)
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @returns {Promise<void>} Price response
 */
async function getAppPrice(req, res) {
  return getAppFiatAndFluxPrice(req, res);
}

module.exports = {
  getAppFiatAndFluxPrice,
  getAppPrice,
  getAppFluxOnChainPrice,
  checkFreeAppUpdate,
};
