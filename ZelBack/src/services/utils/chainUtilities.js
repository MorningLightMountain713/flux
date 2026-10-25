'use strict';

const config = require('config');
const log = require('../../lib/log');
const priceOracleState = require('../pricing/priceOracleState');
const { loaded } = require('./specLibrary');
const { nodeChain } = require('./nodeChain');

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
 * The height app payments count from on this node's chain.
 * @returns {number}
 */
function appPaymentsFrom() {
  return loaded().APP_PAYMENTS_FROM.heightOn(nodeChain());
}

/**
 * Every address an app payment counts toward at a height on this node's chain,
 * oldest first.
 * @param {number} height
 * @returns {ReadonlyArray<string>}
 */
function appPaymentAddresses(height) {
  return loaded().APP_PAYMENT_ADDRESSES.at(nodeChain(), height);
}

/**
 * The address new deployments pay at a height on this node's chain.
 * @param {number} height
 * @returns {string}
 */
function currentAppPaymentAddress(height) {
  return loaded().appPaymentAddress(nodeChain(), height);
}

/**
 * The pre-v9 soft-fork message authorities. Used both as the legacy-price
 * authority and as part of the recognized-message-signer entry filter.
 * @returns {string[]}
 */
function legacyMessageAuthorities() {
  return config.get('fluxapps.legacyMessageAuthorities');
}

module.exports = {
  getChainParamsPriceUpdates,
  getChainTeamSupportAddressUpdates,
  appPaymentsFrom,
  appPaymentAddresses,
  currentAppPaymentAddress,
  legacyMessageAuthorities,
};
