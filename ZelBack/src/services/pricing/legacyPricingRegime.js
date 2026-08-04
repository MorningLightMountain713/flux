const config = require('config');
const axios = require('axios');
const dbHelper = require('../dbHelper');
const daemonServiceMiscRpcs = require('../daemonService/daemonServiceMiscRpcs');
const appsRepository = require('../appDatabase/appsRepository');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const { resolveSpec, resolveInstantiatedSpec } = require('../utils/specCutover');
const { appPricePerMonth } = require('../utils/appUtilities');
const { getChainParamsPriceUpdates } = require('../utils/chainUtilities');
const { getSpecBackend } = require('../utils/specLibs');
const { appsFolder } = require('../utils/appConstants');
const cacheManager = require('../utils/cacheManager').default;
const log = require('../../lib/log');

/**
 * The v1-v8 pricing regime — two numbers, on purpose.
 *
 * The on-chain fee these specs must pay is a near-zero floor, so what an owner
 * is actually charged is the display price computed here (with the marketplace
 * premium). "What the screen says" and "what the chain demands" are genuinely
 * different figures, and the free-update question is answered locally by
 * checkLegacyFreeUpdate. Nothing on chain consults that rule.
 *
 * Contrast v9PricingRegime, where the on-chain price was raised to equal the
 * display price and there is only one figure.
 *
 * Subscriptions here are denominated in blocks: the app dies when the chain
 * reaches height + expire, whatever wall clock that turns out to be. Nothing in
 * this module converts blocks to seconds — the 30-second block is difficulty's
 * target, not a guarantee, so a converted figure would be an estimate wearing
 * the costume of an exact one.
 */

const globalAppsInformation = config.database.appsglobal.collections.appsInformation;

const myShortCache = cacheManager.fluxRatesCache;
const myLongCache = cacheManager.appPriceBlockedRepoCache;

/**
 * How much longer a free update may push the expiry out, in blocks.
 */
const MAX_FREE_EXTENSION_BLOCKS = 8;

const SECONDS_PER_BLOCK = 30;

/**
 * How many free updates an owner may make in a given window. The same caps the
 * v9 rule applies (freeUpdatePolicy.checkRateLimit), so an owner is bounded the
 * same way whichever version they are on.
 *
 * Stated as durations, with the block counts derived. They were written out as
 * block counts once — 3600/1440/720 — which are those durations only at the
 * 120-second block time that preceded the PON fork. The fork quartered the
 * block time and the literals stayed, leaving every window a quarter of its
 * documented length and the cap four times more permissive than intended.
 * Nothing here re-derives a block count by hand for that reason.
 */
const FREE_UPDATE_WINDOWS = [
  { hours: 120, max: 10 },
  { hours: 48, max: 8 },
  { hours: 24, max: 5 },
];

/**
 * The default subscription length in blocks at a given height. The PON fork
 * quartered the block time, so the same wall-clock month costs four times as
 * many blocks after it.
 * @param {number} height
 * @returns {number} blocks
 */
function getDefaultExpire(height) {
  return height >= config.fluxapps.daemonPONFork
    ? config.fluxapps.blocksLasting * 4
    : config.fluxapps.blocksLasting;
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
 * Whether a v1-v8 update qualifies as free on the display price.
 *
 * A v9 spec must never be passed here. v9's on-chain price equals its display
 * price, so free-or-not is decided once, inside PricingEngine.priceUpdate, and
 * both the quote and consensus reach that same call. Answering here as well
 * would put a second, older opinion in front of the authoritative one.
 *
 * @param {import('@runonflux/flux-spec').FluxAppSpecBase} spec - New spec (v1-v8)
 * @param {number} daemonHeight
 * @returns {Promise<boolean>}
 */
async function checkLegacyFreeUpdate(spec, daemonHeight) {
  const instantiated = await appsRepository.getGlobalAppInfo(spec.name);
  if (!instantiated) return false;

  const prevSpec = await resolveInstantiatedSpec(instantiated);

  // Both sides must be legacy. A v9 registration can only ever be updated by
  // another v9 spec (UpdatePolicy.assertVersionTransition), so a legacy spec
  // quoted against one is not an update this rule can price. The new spec is
  // legacy by this function's contract.
  if (prevSpec.version >= 9) return false;

  if (!spec.expire || !prevSpec.expire) return false;

  // A free update must not buy more subscription. expiresAtHeight carries the
  // PON fork adjustment for a term bought when blocks were four times slower.
  const blocksToExtend = (daemonHeight + spec.expire) - instantiated.expiresAtHeight;

  const placementMatch = spec.placement.staticIp === prevSpec.placement.staticIp;
  // The targeting fields are arrays of node identity; the free-update bar
  // compares their lengths (the identity SET size).
  const targetsMatch = spec.placement.targetIps.length === prevSpec.placement.targetIps.length
    && spec.placement.targetOutpoints.length === prevSpec.placement.targetOutpoints.length
    && spec.placement.targetOperators.length === prevSpec.placement.targetOperators.length;
  const instancesMatch = spec.instances === prevSpec.instances;
  const extensionOk = blocksToExtend <= MAX_FREE_EXTENSION_BLOCKS;

  if (!(placementMatch && targetsMatch && instancesMatch && extensionOk)) {
    log.info(`[checkLegacyFreeUpdate] App: ${spec.name}, RESULT: NOT FREE - basic conditions failed (placement: ${placementMatch}, targets: ${targetsMatch}, instances: ${instancesMatch}, extension: ${extensionOk})`);
    return false;
  }

  if (hasResourceGrowth(spec, prevSpec)) {
    log.info(`[checkLegacyFreeUpdate] App: ${spec.name}, RESULT: NOT FREE - resource changes detected`);
    return false;
  }

  // The app's full message history (register + updates), via the repository —
  // the free-update rate limit counts recent update messages.
  const permanentAppMessage = await appsRepository.listAppMessagesByName(spec.name);

  const updates = permanentAppMessage.filter(
    (m) => m.type === 'fluxappupdate' || m.type === 'zelappupdate',
  );

  for (const { hours, max } of FREE_UPDATE_WINDOWS) {
    const blocks = (hours * 3600) / SECONDS_PER_BLOCK;
    const count = updates.filter((m) => m.height > daemonHeight - blocks).length;
    if (count > max) {
      log.info(`[checkLegacyFreeUpdate] App: ${spec.name}, RESULT: NOT FREE - rate limit exceeded (${count} updates in ${hours}h, max ${max})`);
      return false;
    }
  }
  log.info(`[checkLegacyFreeUpdate] App: ${spec.name}, RESULT: FREE UPDATE (within rate limits)`);
  return true;
}

/**
 * On-chain price in FLUX for display — the near-zero floor, not what the owner
 * is charged. Returned as a fixed-2 string, which is what this path has always
 * produced; every caller wraps it in Number().
 *
 * @param {object} spec - resolved v1-v8 spec
 * @returns {Promise<string>} Price in FLUX
 */
async function onChainDisplayPrice(spec) {
  const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
  if (!syncStatus.data.synced) {
    throw new Error('Daemon not yet synced.');
  }
  const daemonHeight = syncStatus.data.height;
  const appPrices = await getChainParamsPriceUpdates();
  const intervals = appPrices.filter((i) => i.height < daemonHeight);
  const priceSpecifications = intervals[intervals.length - 1];

  const blockHeightMultiplier = daemonHeight >= config.fluxapps.daemonPONFork ? 4 : 1;
  const defaultExpire = config.fluxapps.blocksLasting * blockHeightMultiplier;

  let actualPriceToPay = await appPricePerMonth(spec, daemonHeight, appPrices);
  const expireIn = spec.expire || defaultExpire;
  actualPriceToPay *= expireIn / defaultExpire;
  actualPriceToPay = Math.ceil(actualPriceToPay * 100) / 100;

  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.appsglobal.database);
  const appInfoDoc = await dbHelper.findOneInDatabase(
    database, globalAppsInformation, { name: spec.name }, { projection: { _id: 0 } },
  );
  if (appInfoDoc) {
    const prevSpec = await resolveSpec(appInfoDoc);
    let previousSpecsPrice = await appPricePerMonth(prevSpec, daemonHeight, appPrices);

    const previousBlockHeightMultiplier = appInfoDoc.height >= config.fluxapps.daemonPONFork ? 4 : 1;
    const previousDefaultExpire = config.fluxapps.blocksLasting * previousBlockHeightMultiplier;

    let previousExpireIn = previousSpecsPrice.expire || previousDefaultExpire;
    if (daemonHeight > 1315000) {
      previousExpireIn = prevSpec.expire || previousDefaultExpire;
    }

    if (appInfoDoc.height < config.fluxapps.daemonPONFork) {
      const originalExpireHeight = appInfoDoc.height + previousExpireIn;
      if (originalExpireHeight > config.fluxapps.daemonPONFork) {
        const blocksAfterFork = originalExpireHeight - config.fluxapps.daemonPONFork;
        const adjustedBlocksAfterFork = blocksAfterFork * 4;
        const adjustedExpireHeight = config.fluxapps.daemonPONFork + adjustedBlocksAfterFork;
        previousExpireIn = adjustedExpireHeight - appInfoDoc.height;
      }
    }
    const multiplierPrevious = previousExpireIn / previousDefaultExpire;
    previousSpecsPrice *= multiplierPrevious;
    previousSpecsPrice = Math.ceil(previousSpecsPrice * 100) / 100;

    let heightDifference = daemonHeight - appInfoDoc.height;
    if (appInfoDoc.height < config.fluxapps.daemonPONFork && daemonHeight >= config.fluxapps.daemonPONFork) {
      const blocksBeforeFork = config.fluxapps.daemonPONFork - appInfoDoc.height;
      const blocksAfterFork = daemonHeight - config.fluxapps.daemonPONFork;
      heightDifference = blocksBeforeFork + (blocksAfterFork * 4);
    }

    const perc = (previousExpireIn - heightDifference) / previousExpireIn;
    if (perc > 0) {
      actualPriceToPay -= (perc * previousSpecsPrice);
    }
  }

  const { DeploymentSpec } = await getSpecBackend();
  // Declared view: display pricing must match what every node computes.
  const { cpu, memoryMb: memory, storageGb: storage } = DeploymentSpec.fromSpec(spec, appsFolder, { replica: null }).resourceTotals();
  if (cpu < 3 && memory < 6000 && storage < 150) {
    actualPriceToPay *= 0.8;
  } else if (cpu < 7 && memory < 29000 && storage < 370) {
    actualPriceToPay *= 0.9;
  }

  if (spec.hasActiveStandbySyncthing()) {
    actualPriceToPay *= 0.8;
  }

  actualPriceToPay = Number(Math.ceil(actualPriceToPay * 100) / 100);
  if (actualPriceToPay < priceSpecifications.minPrice) {
    actualPriceToPay = priceSpecifications.minPrice;
  }
  return Number(actualPriceToPay).toFixed(2);
}

/**
 * USD + FLUX quote for display — the figure an owner actually pays, waived
 * entirely when checkLegacyFreeUpdate says the update is free.
 *
 * @param {object} spec - resolved v1-v8 spec
 * @param {object} appSpecification - the raw submitted document. Needed for
 *   priceUSD, a marketplace field carried on the request that exists on no spec
 *   class.
 * @returns {Promise<{usd: number, flux: number, fluxDiscount: number|string}>}
 */
async function fiatAndFluxDisplayPrice(spec, appSpecification) {
  const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
  if (!syncStatus.data.synced) {
    throw new Error('Daemon not yet synced.');
  }
  const daemonHeight = syncStatus.data.height;

  if (await checkLegacyFreeUpdate(spec, daemonHeight)) {
    return { usd: 0, flux: 0, fluxDiscount: 0 };
  }

  const axiosConfig = { timeout: 5000 };
  const appPrices = [];
  if (myLongCache.has('appPrices')) {
    appPrices.push(myLongCache.get('appPrices'));
  } else {
    const response = await axios.get(`${config.stats.apiBaseUrl}/apps/getappspecsusdprice`, axiosConfig).catch((error) => log.error(error));
    if (response && response.data && response.data.status === 'success') {
      myLongCache.set('appPrices', response.data.data);
      appPrices.push(response.data.data);
    } else {
      const fallback = config.fluxapps.usdprice;
      myLongCache.set('appPrices', fallback);
      appPrices.push(fallback);
    }
  }

  const blockHeightMultiplier = daemonHeight >= config.fluxapps.daemonPONFork ? 4 : 1;
  const defaultExpire = config.fluxapps.blocksLasting * blockHeightMultiplier;

  let actualPriceToPay = await appPricePerMonth(spec, daemonHeight, appPrices);
  const expireIn = spec.expire || defaultExpire;
  actualPriceToPay *= expireIn / defaultExpire;
  actualPriceToPay = Number(actualPriceToPay).toFixed(2);

  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.appsglobal.database);
  const appInfoDoc = await dbHelper.findOneInDatabase(
    database, globalAppsInformation, { name: spec.name }, { projection: { _id: 0 } },
  );
  if (appInfoDoc) {
    const prevSpec = await resolveSpec(appInfoDoc);
    let previousSpecsPrice = await appPricePerMonth(prevSpec, daemonHeight, appPrices);

    const previousBlockHeightMultiplier = appInfoDoc.height >= config.fluxapps.daemonPONFork ? 4 : 1;
    const previousDefaultExpire = config.fluxapps.blocksLasting * previousBlockHeightMultiplier;

    let previousExpireIn = previousSpecsPrice.expire || previousDefaultExpire;
    if (daemonHeight > 1315000) {
      previousExpireIn = prevSpec.expire || previousDefaultExpire;
    }

    if (appInfoDoc.height < config.fluxapps.daemonPONFork) {
      const originalExpireHeight = appInfoDoc.height + previousExpireIn;
      if (originalExpireHeight > config.fluxapps.daemonPONFork) {
        const blocksAfterFork = originalExpireHeight - config.fluxapps.daemonPONFork;
        const adjustedBlocksAfterFork = blocksAfterFork * 4;
        const adjustedExpireHeight = config.fluxapps.daemonPONFork + adjustedBlocksAfterFork;
        previousExpireIn = adjustedExpireHeight - appInfoDoc.height;
      }
    }
    const multiplierPrevious = previousExpireIn / previousDefaultExpire;
    previousSpecsPrice *= multiplierPrevious;
    previousSpecsPrice = Number(previousSpecsPrice).toFixed(2);

    let heightDifference = daemonHeight - appInfoDoc.height;
    if (appInfoDoc.height < config.fluxapps.daemonPONFork && daemonHeight >= config.fluxapps.daemonPONFork) {
      const blocksBeforeFork = config.fluxapps.daemonPONFork - appInfoDoc.height;
      const blocksAfterFork = daemonHeight - config.fluxapps.daemonPONFork;
      heightDifference = blocksBeforeFork + (blocksAfterFork * 4);
    }

    const perc = (previousExpireIn - heightDifference) / previousExpireIn;
    if (perc > 0) {
      actualPriceToPay -= (perc * previousSpecsPrice);
    }
  }

  const { DeploymentSpec } = await getSpecBackend();
  // Declared view: display pricing must match what every node computes.
  const { cpu, memoryMb: memory, storageGb: storage } = DeploymentSpec.fromSpec(spec, appsFolder, { replica: null }).resourceTotals();
  const applyHWDiscount = spec.version <= 3 || spec.instances < 4;
  if (applyHWDiscount) {
    if (cpu < 3 && memory < 6000 && storage < 150) {
      actualPriceToPay *= 0.8;
    } else if (cpu < 7 && memory < 29000 && storage < 370) {
      actualPriceToPay *= 0.9;
    }
  }

  if (spec.hasActiveStandbySyncthing()) {
    actualPriceToPay *= 0.8;
  }

  const marketplaceResponse = await axios.get(`${config.stats.apiBaseUrl}/marketplace/listapps`).catch((error) => log.error(error));
  let marketPlaceApps = [];
  if (marketplaceResponse && marketplaceResponse.data && marketplaceResponse.data.status === 'success') {
    marketPlaceApps = marketplaceResponse.data.data;
  } else {
    log.error('Unable to get marketplace information');
  }

  if (appSpecification.priceUSD) {
    if (appSpecification.priceUSD < actualPriceToPay) {
      throw new Error('USD price is not valid');
    }
    actualPriceToPay = Number(appSpecification.priceUSD).toFixed(2);
  } else {
    const marketPlaceApp = marketPlaceApps.find(
      (app) => spec.name.toLowerCase().startsWith(app.name.toLowerCase()),
    );
    if (marketPlaceApp && marketPlaceApp.multiplier > 1) {
      actualPriceToPay *= marketPlaceApp.multiplier;
    }
    actualPriceToPay = Number(actualPriceToPay * appPrices[0].multiplier).toFixed(2);
    if (actualPriceToPay < appPrices[0].minUSDPrice) {
      actualPriceToPay = Number(appPrices[0].minUSDPrice).toFixed(2);
    }
  }

  const subscriptionMonths = expireIn / defaultExpire;
  if (subscriptionMonths >= 9) {
    actualPriceToPay *= 0.88;
  } else if (subscriptionMonths >= 6) {
    actualPriceToPay *= 0.94;
  } else if (subscriptionMonths >= 3) {
    actualPriceToPay *= 0.97;
  }
  actualPriceToPay = Number(actualPriceToPay).toFixed(2);

  if (actualPriceToPay < appPrices[0].minUSDPrice) {
    actualPriceToPay = Number(appPrices[0].minUSDPrice).toFixed(2);
  }

  let fluxUSDRate;
  if (myShortCache.has('fluxRates')) {
    fluxUSDRate = myShortCache.get('fluxRates');
  } else {
    let fiatRates = await axios.get(config.fiatRates.ratesUrl, axiosConfig).catch((error) => log.error(error));
    if (fiatRates && fiatRates.data) {
      const rateObj = fiatRates.data[0].find((rate) => rate.code === 'USD');
      if (!rateObj) throw new Error('Unable to get USD rate.');
      const btcRateforFlux = fiatRates.data[1].FLUX;
      if (btcRateforFlux === undefined) throw new Error('Unable to get Flux USD Price.');
      fluxUSDRate = rateObj.rate * btcRateforFlux;
      myShortCache.set('fluxRates', fluxUSDRate);
    } else {
      fiatRates = await axios.get('https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&ids=zelcash', axiosConfig);
      if (fiatRates && fiatRates.data && fiatRates.data.zelcash && fiatRates.data.zelcash.usd) {
        fluxUSDRate = fiatRates.data.zelcash.usd;
      } else {
        ({ fluxUSDRate } = config.fluxapps);
      }
      myShortCache.set('fluxRates', fluxUSDRate);
    }
  }
  const fluxPrice = Number((actualPriceToPay / fluxUSDRate) * appPrices[0].fluxmultiplier);
  const fluxChainPrice = Number(await onChainDisplayPrice(spec));
  const price = {
    usd: Number(actualPriceToPay),
    flux: fluxChainPrice > fluxPrice ? Number(fluxChainPrice.toFixed(2)) : Number(fluxPrice.toFixed(2)),
    fluxDiscount: fluxChainPrice > fluxPrice ? 'Not possible to define discount' : Number(100 - (appPrices[0].fluxmultiplier * 100)),
  };
  return price;
}

/**
 * Consensus registration fee in satoshis — the near-zero floor.
 * @param {object} spec - resolved v1-v8 spec
 * @param {number} height - confirming block height
 * @returns {Promise<bigint>}
 */
async function registrationFee(spec, height) {
  const appPrices = await getChainParamsPriceUpdates();
  let appPrice = await appPricePerMonth(spec, height, appPrices);
  const defaultExpire = getDefaultExpire(height);
  const expireIn = spec.expire || defaultExpire;
  appPrice *= expireIn / defaultExpire;
  appPrice = Math.ceil(appPrice * 100) / 100;
  const intervals = appPrices.filter((p) => p.height < height);
  const priceSpec = intervals[intervals.length - 1];
  if (appPrice < priceSpec.minPrice) appPrice = priceSpec.minPrice;
  return BigInt(Math.round(appPrice * 1e8));
}

/**
 * The permanent message a v1-v8 update supersedes, resolved as this network has
 * always resolved it: newest message at or before the update's own timestamp.
 *
 * The update is already stored when this is asked, and its own record satisfies
 * that cutoff at the greatest height, so the answer is the update itself. Every
 * term of updateFee below then cancels — same spec, same height, zero height
 * difference, full unused-time credit — and the fee is the minPrice floor.
 *
 * That IS the legacy rule: the chain floor and the display price are two
 * numbers on purpose, and the floor is what the network has enforced for every
 * legacy update since height 1004000. It is reproduced exactly rather than
 * corrected, because a node demanding the prorated figure would reject updates
 * every other node accepts, and no node can reprice history.
 *
 * @param {string} name - App name
 * @param {{height: number, timestamp: number}} confirming - the update's
 *   confirming height and message timestamp
 * @returns {Promise<object|null>}
 */
async function supersededMessage(name, confirming) {
  return appsRepository.getPreviousPermanentMessage(name, confirming.timestamp);
}

/**
 * Consensus update fee in satoshis, crediting the unused portion of the prior
 * subscription. prevRegisteredAt and nowBlockTime are part of the shared regime
 * interface and unused here: legacy credits unused time by block count, not by
 * wall clock.
 *
 * @param {object} spec - resolved new v1-v8 spec
 * @param {object} prevSpec - resolved previous spec
 * @param {number} height - confirming block height
 * @param {number} prevHeight - height the previous spec registered at
 * @returns {Promise<bigint>}
 */
async function updateFee(spec, prevSpec, height, prevHeight) {
  const appPrices = await getChainParamsPriceUpdates();
  let appPrice = await appPricePerMonth(spec, height, appPrices);
  let previousSpecsPrice = await appPricePerMonth(prevSpec, prevHeight, appPrices);
  const defaultExpireCurrent = getDefaultExpire(height);
  const defaultExpirePrevious = getDefaultExpire(prevHeight);
  const currentExpireIn = spec.expire || defaultExpireCurrent;
  const previousExpireIn = prevSpec.expire || defaultExpirePrevious;
  appPrice *= currentExpireIn / defaultExpireCurrent;
  appPrice = Math.ceil(appPrice * 100) / 100;
  previousSpecsPrice *= previousExpireIn / defaultExpirePrevious;
  previousSpecsPrice = Math.ceil(previousSpecsPrice * 100) / 100;
  const heightDifference = height - prevHeight;
  const perc = (previousExpireIn - heightDifference) / previousExpireIn;
  let actualPriceToPay = appPrice * 0.9;
  if (perc > 0) {
    actualPriceToPay = (appPrice - (perc * previousSpecsPrice)) * 0.9;
  }
  actualPriceToPay = Number(Math.ceil(actualPriceToPay * 100) / 100);
  const intervals = appPrices.filter((p) => p.height < height);
  const priceSpec = intervals[intervals.length - 1];
  if (actualPriceToPay < priceSpec.minPrice) {
    actualPriceToPay = priceSpec.minPrice;
  }
  return BigInt(Math.round(actualPriceToPay * 1e8));
}

module.exports = {
  onChainDisplayPrice,
  fiatAndFluxDisplayPrice,
  registrationFee,
  supersededMessage,
  updateFee,
  checkLegacyFreeUpdate,
  getDefaultExpire,
};
