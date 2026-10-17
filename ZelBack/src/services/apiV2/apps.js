'use strict';

const appQueryService = require('../appQuery/appQueryService');
const appHistory = require('../appDecisions/appHistory');

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

/**
 * GET /v2/apps/:name/ownerships - the identity of the app that holds a name and
 * who has owned it, each owner with the height they took it
 * (appHistory.ownershipRecord). FluxDrive confirms an owner's write by it.
 * @param {import('express').Request} req
 * @param {import('express').Response} res carrying the v2 envelope
 * @returns {Promise<*>}
 */
async function ownerships(req, res) {
  const record = await appHistory.ownershipRecord(req.params.name);
  if (!record) return res.fail('NOT_FOUND', 'no app holding this name has applied');
  return res.ok({ name: req.params.name, ...record });
}

module.exports = {
  activeStandby,
  ownerships,
};
