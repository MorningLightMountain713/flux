'use strict';

// Deployment Info Service - Query functions for app deployment information
const config = require('config');
const messageHelper = require('../messageHelper');
const daemonStatus = require('../daemonService/daemonStatus');
const chainUtilities = require('../utils/chainUtilities');
const log = require('../../lib/log');
const specLibrary = require('../utils/specLibrary');
const { nodeChain, specActivationHeights } = require('../utils/nodeChain');

/**
 * To get deployment information including prices and specifications.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function deploymentInformation(req, res) {
  try {
    // respond with information needed for application deployment regarding specification limitation and prices
    const syncStatus = daemonStatus.daemonSyncState();
    const daemonHeight = syncStatus.height;
    const deployAddr = chainUtilities.currentAppPaymentAddress(daemonHeight);
    // search in chainparams db for chainmessages of p version
    const appPrices = await chainUtilities.getChainParamsPriceUpdates();
    const portMin = config.get('fluxapps.portMin');
    const portMax = config.get('fluxapps.portMax');
    // The legacy term rules as this node's chain holds them: the default term
    // and the floor in the chain's first blocks, the ceiling in the blocks in
    // force at the tip, and the height the block time changed at.
    const {
      DEFAULT_LIFETIME_SECONDS, MAX_SUBSCRIPTION_SECONDS, MIN_SUBSCRIPTION_BLOCKS, BLOCKS_ALLOWANCE_INTERVAL,
    } = specLibrary.loaded();
    const chain = nodeChain();
    const information = {
      price: appPrices,
      appSpecsEnforcementHeights: specActivationHeights(),
      address: deployAddr,
      portMin,
      portMax,
      enterprisePorts: config.get('fluxapps.enterprisePorts'),
      bannedPorts: config.get('fluxapps.bannedPorts'),
      maxImageSize: config.get('fluxapps.maxImageSize'),
      minimumInstances: config.get('fluxapps.minimumInstances'),
      maximumInstances: config.get('fluxapps.maximumInstances'),
      blocksLasting: DEFAULT_LIFETIME_SECONDS / chain.blockTimes[0].seconds,
      minBlocksAllowance: MIN_SUBSCRIPTION_BLOCKS.at(chain, 0),
      // before the daemon reports a height, the ceiling at the chain's start
      maxBlocksAllowance: chain.blocksFor(MAX_SUBSCRIPTION_SECONDS, Number.isFinite(daemonHeight) ? daemonHeight : 0),
      blocksAllowanceInterval: BLOCKS_ALLOWANCE_INTERVAL,
      // The fork height itself, not just its effect above. maxBlocksAllowance
      // answers "how long may an app be paid for NOW"; a client working out
      // what an EXISTING app's expiry is has to ask the same question at that
      // app's own registration height, and rescale a term that straddles the
      // fork. It cannot do either without the height, and a client that
      // hardcodes it is keeping a second copy of a chain fact.
      daemonPONFork: chain.blockTimes[1].fromHeight,
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
