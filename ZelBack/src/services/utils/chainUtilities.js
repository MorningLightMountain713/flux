'use strict';

const config = require('config');
const log = require('../../lib/log');
const priceOracleState = require('../pricing/priceOracleState');

/**
 * The v1-v8 price cards in force from each height, oldest first: chain state,
 * held in memory with the other price histories.
 * @returns {Promise<object[]>}
 */
async function getChainParamsPriceUpdates() {
  try {
    return [...await priceOracleState.getLegacyPriceSchedule()];
  } catch (error) {
    log.error(error);
    return [];
  }
}

/**
 * To get array of team support address updates
 * @returns {(object|object[])} Returns an array of team support addresses with height.
 */
function getChainTeamSupportAddressUpdates() {
  try {
    /* to be adjusted in the future to check database
    const db = dbHelper.databaseConnection();
    const database = db.db(config.database.chainparams.database);
    const chainParamsMessagesCollection = config.database.chainparams.collections.chainMessages;
    const query = { version: 'p' };
    const projection = {
      projection: {
        _id: 0,
      },
    };
    const priceMessages = await dbHelper.findInDatabase(database, chainParamsMessagesCollection, query, projection);
    */
    const addressForks = [];
    config.get('fluxapps.teamSupportAddress').forEach((address) => {
      addressForks.push(address);
    });
    // sort priceForks depending on height
    addressForks.sort((a, b) => {
      if (a.height > b.height) return 1;
      if (a.height < b.height) return -1;
      return 0;
    });
    return addressForks;
  } catch (error) {
    log.error(error);
    return [];
  }
}

/**
 * Whether an address is a valid app-payment receiver at a given height.
 * A payment counts toward an app's fee only if its receiver is one of the
 * configured payment addresses and the block is at or past that entry's
 * activeFromHeight.
 * @param {string} address
 * @param {number} height
 * @returns {boolean}
 */
function isAppPaymentReceiver(address, height) {
  return config.get('fluxapps.appPaymentAddresses').some(
    (entry) => entry.address === address && height >= entry.activeFromHeight,
  );
}

/**
 * The address new deployments pay to at a given height — the latest-activated
 * payment address. Ties (equal activeFromHeight) keep the earlier entry, so the
 * t1 base address wins over any same-height entry.
 * @param {number} daemonHeight
 * @returns {string}
 */
function currentAppPaymentAddress(daemonHeight) {
  const active = config.get('fluxapps.appPaymentAddresses').filter((entry) => daemonHeight >= entry.activeFromHeight);
  const latest = active.reduce(
    (best, entry) => (entry.activeFromHeight > best.activeFromHeight ? entry : best),
    active[0],
  );
  return latest.address;
}

/**
 * The pre-v9 soft-fork message authorities — the payment addresses flagged
 * legacyMessageAuthority (the v6+ multisigs). Used both as the legacy-price
 * authority and as part of the recognized-message-signer entry filter.
 * @returns {string[]}
 */
function legacyMessageAuthorities() {
  return config.get('fluxapps.appPaymentAddresses')
    .filter((entry) => entry.legacyMessageAuthority)
    .map((entry) => entry.address);
}

module.exports = {
  getChainParamsPriceUpdates,
  getChainTeamSupportAddressUpdates,
  isAppPaymentReceiver,
  currentAppPaymentAddress,
  legacyMessageAuthorities,
};
