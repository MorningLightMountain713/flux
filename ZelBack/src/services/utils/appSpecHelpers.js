const config = require('config');
const axios = require('axios');
const dbHelper = require('../dbHelper');
const messageHelper = require('../messageHelper');
const serviceHelper = require('../serviceHelper');
const daemonServiceMiscRpcs = require('../daemonService/daemonServiceMiscRpcs');
const { decryptToCleartextClass } = require('./specCutover');
const { appPricePerMonth } = require('./appUtilities');
const { getChainParamsPriceUpdates } = require('./chainUtilities');
const registryManager = require('../appDatabase/registryManager');
const appsRepository = require('../appDatabase/appsRepository');
const cacheManager = require('./cacheManager').default;
const { getSpecBackend } = require('./specLibs');
const { appsFolder } = require('./appConstants');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const log = require('../../lib/log');

// Database collections
const globalAppsInformation = config.database.appsglobal.collections.appsInformation;

// Cache for fiat rates
const myShortCache = cacheManager.fluxRatesCache;
const myLongCache = cacheManager.appPriceBlockedRepoCache;

/**
 * Get app Flux on-chain price
 * @param {object} appSpecification - Application specification
 * @returns {Promise<string>} Price in Flux
 */
async function getAppFluxOnChainPrice(appSpecification) {
  try {
    const spec = await decryptToCleartextClass(appSpecification);

    const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
    if (!syncStatus.data.synced) {
      throw new Error('Daemon not yet synced.');
    }
    const daemonHeight = syncStatus.data.height;
    const appPrices = await getChainParamsPriceUpdates();
    const intervals = appPrices.filter((i) => i.height < daemonHeight);
    const priceSpecifications = intervals[intervals.length - 1];

    // Get dynamic default expire based on whether we're past the PON fork
    // After fork, blocks are 4x faster, so 1 month = 88000 blocks instead of 22000
    const blockHeightMultiplier = daemonHeight >= config.fluxapps.daemonPONFork ? 4 : 1;
    const defaultExpire = config.fluxapps.blocksLasting * blockHeightMultiplier;

    let actualPriceToPay = await appPricePerMonth(spec, daemonHeight, appPrices);
    const expireIn = spec.expire || defaultExpire;
    const multiplier = expireIn / defaultExpire;
    actualPriceToPay *= multiplier;
    actualPriceToPay = Math.ceil(actualPriceToPay * 100) / 100;

    const db = dbHelper.databaseConnection();
    const database = db.db(config.database.appsglobal.database);
    const appInfoDoc = await dbHelper.findOneInDatabase(
      database,
      globalAppsInformation,
      { name: spec.name },
      { projection: { _id: 0 } },
    );
    if (appInfoDoc) {
      const prevSpec = await decryptToCleartextClass(appInfoDoc);
      let previousSpecsPrice = await appPricePerMonth(prevSpec, daemonHeight, appPrices);

      const previousBlockHeightMultiplier = appInfoDoc.height >= config.fluxapps.daemonPONFork ? 4 : 1;
      const previousDefaultExpire = config.fluxapps.blocksLasting * previousBlockHeightMultiplier;

      let previousExpireIn = previousSpecsPrice.expire || previousDefaultExpire; // bad typo bug line. Leave it like it is, this bug is a feature now.
      if (daemonHeight > 1315000) {
        previousExpireIn = prevSpec.expire || previousDefaultExpire;
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
    const { cpu, memory, storage } = DeploymentSpec.fromSpec(spec, appsFolder).totalResources();
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
  } catch (error) {
    log.warn(error);
    throw error;
  }
}

/**
 * Count enterprise ports on a component. Works uniformly across v1-v9
 * via the class's `ports` getter — the v1-v8 tcp/udp duplication is
 * collapsed via dedup on hostPort number.
 *
 * @param {import('@runonflux/flux-spec').AppComponentBase} component
 * @returns {number}
 */
function countEnterprisePortsOn(component) {
  const hostPorts = new Set();
  for (const p of Object.values(component.ports || {})) {
    if (p && p.hostPort != null) hostPorts.add(p.hostPort);
  }
  return [...hostPorts].filter((p) => fluxNetworkHelper.isPortEnterprise(p)).length;
}

/**
 * Whether the update introduces resource growth on any component — CPU,
 * RAM, storage, or enterprise port count. Missing components on the
 * previous side count as growth.
 *
 * @param {import('@runonflux/flux-spec').FluxAppSpecBase} spec
 * @param {import('@runonflux/flux-spec').FluxAppSpecBase} prevSpec
 * @returns {boolean}
 */
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
    ? await decryptToCleartextClass(instantiated.serialize())
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
 * Get app price with Fiat and Flux pricing
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @returns {Promise<void>} Price response
 */
async function getAppFiatAndFluxPrice(req, res) {
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
      const spec = await decryptToCleartextClass(appSpecification);

      // verifications skipped. This endpoint is only for price evaluation

      if (await checkFreeAppUpdate(spec, daemonHeight)) {
        const price = { usd: 0, flux: 0, fluxDiscount: 0 };
        return res.json(messageHelper.createDataMessage(price));
      }

      const axiosConfig = { timeout: 5000 };
      const appPrices = [];
      if (myLongCache.has('appPrices')) {
        appPrices.push(myLongCache.get('appPrices'));
      } else {
        const response = await axios.get('https://stats.runonflux.io/apps/getappspecsusdprice', axiosConfig).catch((error) => log.error(error));
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
      const multiplier = expireIn / defaultExpire;
      actualPriceToPay *= multiplier;
      actualPriceToPay = Number(actualPriceToPay).toFixed(2);

      const db = dbHelper.databaseConnection();
      const database = db.db(config.database.appsglobal.database);
      const appInfoDoc = await dbHelper.findOneInDatabase(
        database,
        globalAppsInformation,
        { name: spec.name },
        { projection: { _id: 0 } },
      );
      if (appInfoDoc) {
        const prevSpec = await decryptToCleartextClass(appInfoDoc);
        let previousSpecsPrice = await appPricePerMonth(prevSpec, daemonHeight, appPrices);

        const previousBlockHeightMultiplier = appInfoDoc.height >= config.fluxapps.daemonPONFork ? 4 : 1;
        const previousDefaultExpire = config.fluxapps.blocksLasting * previousBlockHeightMultiplier;

        let previousExpireIn = previousSpecsPrice.expire || previousDefaultExpire; // bad typo bug line. Leave it like it is, this bug is a feature now.
        if (daemonHeight > 1315000) {
          previousExpireIn = prevSpec.expire || previousDefaultExpire;
        }

        // Adjust previousExpireIn if app was registered before fork and expiration crosses fork
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

      const { DeploymentSpec: DS } = await getSpecBackend();
      const { cpu, memory, storage } = DS.fromSpec(spec, appsFolder).totalResources();
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

      const marketplaceResponse = await axios.get('https://stats.runonflux.io/marketplace/listapps').catch((error) => log.error(error));
      let marketPlaceApps = [];
      if (marketplaceResponse && marketplaceResponse.data && marketplaceResponse.data.status === 'success') {
        marketPlaceApps = marketplaceResponse.data.data;
      } else {
        log.error('Unable to get marketplace information');
      }

      if (appSpecification.priceUSD) {
        if (appSpecification.priceUSD < actualPriceToPay) {
          log.info(appSpecification.priceUSD);
          log.info(actualPriceToPay);
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

      // Apply subscription duration discount
      const subscriptionMonths = expireIn / defaultExpire;
      if (subscriptionMonths >= 9) {
        actualPriceToPay *= 0.88; // 12% discount
      } else if (subscriptionMonths >= 6) {
        actualPriceToPay *= 0.94; // 6% discount
      } else if (subscriptionMonths >= 3) {
        actualPriceToPay *= 0.97; // 3% discount
      }
      actualPriceToPay = Number(actualPriceToPay).toFixed(2);

      if (actualPriceToPay < appPrices[0].minUSDPrice) {
        actualPriceToPay = Number(appPrices[0].minUSDPrice).toFixed(2);
      }

      let fluxUSDRate;
      if (myShortCache.has('fluxRates')) {
        fluxUSDRate = myShortCache.get('fluxRates');
      } else {
        let fiatRates = await axios.get('https://viprates.runonflux.io/rates', axiosConfig).catch((error) => log.error(error));
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
            fluxUSDRate = config.fluxapps.fluxUSDRate;
          }
          myShortCache.set('fluxRates', fluxUSDRate);
        }
      }
      const fluxPrice = Number((actualPriceToPay / fluxUSDRate) * appPrices[0].fluxmultiplier);
      const fluxChainPrice = Number(await getAppFluxOnChainPrice(appSpecification));
      const price = {
        usd: Number(actualPriceToPay),
        flux: fluxChainPrice > fluxPrice ? Number(fluxChainPrice.toFixed(2)) : Number(fluxPrice.toFixed(2)),
        fluxDiscount: fluxChainPrice > fluxPrice ? 'Not possible to define discount' : Number(100 - (appPrices[0].fluxmultiplier * 100)),
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
