'use strict';

// Deployment Info Service - Query functions for app deployment information
const config = require('config');
const messageHelper = require('../messageHelper');
const daemonServiceMiscRpcs = require('../daemonService/daemonServiceMiscRpcs');
const chainUtilities = require('../utils/chainUtilities');
const log = require('../../lib/log');

/**
 * To get deployment information including prices and specifications.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function deploymentInformation(req, res) {
  try {
    // respond with information needed for application deployment regarding specification limitation and prices
    const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
    const daemonHeight = syncStatus.data.height;
    const deployAddr = chainUtilities.currentAppPaymentAddress(daemonHeight);
    // search in chainparams db for chainmessages of p version
    const appPrices = await chainUtilities.getChainParamsPriceUpdates();
    const portMin = config.get('fluxapps.portMin');
    const portMax = config.get('fluxapps.portMax');
    // After fork block, chain works 4x faster, so we use the new max blocks allowance
    const maxAllowance = daemonHeight >= config.get('fluxapps.daemonPONFork')
      ? config.get('fluxapps.postPonMaxBlocksAllowance')
      : config.get('fluxapps.maxBlocksAllowance');
    const information = {
      price: appPrices,
      appSpecsEnforcementHeights: config.get('fluxapps.appSpecsEnforcementHeights'),
      address: deployAddr,
      portMin,
      portMax,
      enterprisePorts: config.get('fluxapps.enterprisePorts'),
      bannedPorts: config.get('fluxapps.bannedPorts'),
      maxImageSize: config.get('fluxapps.maxImageSize'),
      minimumInstances: config.get('fluxapps.minimumInstances'),
      maximumInstances: config.get('fluxapps.maximumInstances'),
      blocksLasting: config.get('fluxapps.blocksLasting'),
      minBlocksAllowance: config.get('fluxapps.minBlocksAllowance'),
      maxBlocksAllowance: maxAllowance,
      blocksAllowanceInterval: config.get('fluxapps.blocksAllowanceInterval'),
      // The fork height itself, not just its effect above. maxBlocksAllowance
      // answers "how long may an app be paid for NOW"; a client working out
      // what an EXISTING app's expiry is has to ask the same question at that
      // app's own registration height, and rescale a term that straddles the
      // fork. It cannot do either without the height, and a client that
      // hardcodes it is keeping a second copy of a chain fact.
      daemonPONFork: config.get('fluxapps.daemonPONFork'),
    };
    const respondPrice = messageHelper.createDataMessage(information);
    res.json(respondPrice);
  } catch (error) {
    log.warn(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

/**
 * To get application specification usd prices.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {object} Returns object with application specification usd prices.
 */
async function getAppSpecsUSDPrice(req, res) {
  try {
    const resMessage = messageHelper.createDataMessage(config.get('fluxapps.usdprice'));
    res.json(resMessage);
  } catch (error) {
    const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
    log.error(error);
  }
}

module.exports = {
  deploymentInformation,
  getAppSpecsUSDPrice,
};
