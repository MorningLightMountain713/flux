'use strict';

const appQueryService = require('../appQuery/appQueryService');

/**
 * GET /v2/apps/activestandby - each installed activeStandby component this node is
 * running or holding, by app identity and replica, and the apps it cannot read
 * right now (appQueryService.activeStandbyComponents).
 * @param {import('express').Request} req
 * @param {import('express').Response} res carrying the v2 envelope
 * @returns {Promise<*>}
 */
async function activeStandby(req, res) {
  return res.ok(await appQueryService.activeStandbyComponents());
}

module.exports = {
  activeStandby,
};
