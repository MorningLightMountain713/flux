const config = require('config');
const axios = require('axios');
const dbHelper = require('../dbHelper');
const daemonServiceMiscRpcs = require('../daemonService/daemonServiceMiscRpcs');
const { resolveSpec } = require('../utils/specCutover');
const { appPricePerMonth } = require('../utils/appUtilities');
const { getChainParamsPriceUpdates } = require('../utils/chainUtilities');
const { getSpecBackend } = require('../utils/specLibs');
const { appsFolder } = require('../utils/appConstants');
const cacheManager = require('../utils/cacheManager').default;
const log = require('../../lib/log');

const globalAppsInformation = config.database.appsglobal.collections.appsInformation;

const myShortCache = cacheManager.fluxRatesCache;
const myLongCache = cacheManager.appPriceBlockedRepoCache;

async function legacyGetAppFluxOnChainPrice(appSpecification) {
  const spec = await resolveSpec(appSpecification);

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
}

// Legacy (v1-v8) USD/FLUX display pricing. Pure business logic: takes the
// parsed appSpecification, returns the price object ({ usd, flux, fluxDiscount }),
// and throws on error so the *Api handler formats the response. The caller reads
// the request body (version dispatch needs the spec version up front, so the body
// can't be left for this function to read off the stream).
async function legacyGetAppFiatAndFluxPrice(appSpecification, { resolveSpecFn, checkFreeAppUpdateFn }) {
  if (!appSpecification) {
    throw new Error('Invalid application specification provided.');
  }

  const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
  if (!syncStatus.data.synced) {
    throw new Error('Daemon not yet synced.');
  }
  const daemonHeight = syncStatus.data.height;
  const spec = await resolveSpecFn(appSpecification);

  if (await checkFreeAppUpdateFn(spec, daemonHeight)) {
    return { usd: 0, flux: 0, fluxDiscount: 0 };
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
  actualPriceToPay *= expireIn / defaultExpire;
  actualPriceToPay = Number(actualPriceToPay).toFixed(2);

  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.appsglobal.database);
  const appInfoDoc = await dbHelper.findOneInDatabase(
    database, globalAppsInformation, { name: spec.name }, { projection: { _id: 0 } },
  );
  if (appInfoDoc) {
    const prevSpec = await resolveSpecFn(appInfoDoc);
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
  const fluxChainPrice = Number(await legacyGetAppFluxOnChainPrice(appSpecification));
  const price = {
    usd: Number(actualPriceToPay),
    flux: fluxChainPrice > fluxPrice ? Number(fluxChainPrice.toFixed(2)) : Number(fluxPrice.toFixed(2)),
    fluxDiscount: fluxChainPrice > fluxPrice ? 'Not possible to define discount' : Number(100 - (appPrices[0].fluxmultiplier * 100)),
  };
  return price;
}

module.exports = { legacyGetAppFiatAndFluxPrice, legacyGetAppFluxOnChainPrice };
