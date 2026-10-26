'use strict';

const appQueryService = require('../appQuery/appQueryService');
const appHistory = require('../appDecisions/appHistory');
const appsRepository = require('../appDatabase/appsRepository');
const pricingRegime = require('../pricing/pricingRegime');
const { resolveSpec } = require('../utils/specCutover');
const { getSpecBackend } = require('../utils/specLibs');
const { assertSubmittableTimestamp } = require('../appMessaging/submittableTimestamp');

/** The refusals a quote reports by name, for a client to branch on. */
const QUOTE_REFUSALS = new Set(['NotQuotable', 'StampedEarly', 'UpdateRefused']);

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

/**
 * POST /v2/apps/quotes - the fee consensus will charge a v9 message, fixed at
 * its signed time: `{ appSpecification, extend, timestamp }`, the fields the
 * submission carries. A payment of `fee` satoshis mined by `payBy` is accepted
 * whichever block confirms it; after that the message can no longer be paid.
 *
 * Refused, before anyone pays: a timestamp a submission would refuse; a message
 * for an app with another waiting in this node's pool for its payment; and by
 * name (`reason`) a v1-v8 spec (`NotQuotable`), an update signed at or before
 * the message it replaces (`StampedEarly`), and a free-shaped update with the
 * free allowance spent (`UpdateRefused`).
 * @param {import('express').Request} req
 * @param {import('express').Response} res carrying the v2 envelope
 * @returns {Promise<*>}
 */
async function quote(req, res) {
  const { appSpecification, extend = false, timestamp } = req.body ?? {};
  if (!appSpecification || typeof appSpecification !== 'object') {
    return res.fail('BAD_REQUEST', 'appSpecification is the message\'s specification');
  }
  if (!Number.isInteger(timestamp)) return res.fail('BAD_REQUEST', 'timestamp is the message\'s signed time in ms');
  if (typeof extend !== 'boolean') return res.fail('BAD_REQUEST', 'extend is a boolean');
  try {
    assertSubmittableTimestamp(timestamp);
  } catch (error) {
    return res.fail('UNPROCESSABLE', error.message);
  }

  let spec;
  try {
    spec = await resolveSpec(appSpecification);
  } catch (error) {
    return res.fail('UNPROCESSABLE', error.message);
  }
  if (!spec) return res.fail('UNPROCESSABLE', 'appSpecification cannot be read on this node');

  if (await appsRepository.getTempMessageByName(spec.name)) {
    return res.fail('CONFLICT', 'a message for this app is already waiting for its payment; wait for it to be applied');
  }

  try {
    const {
      fee, usd, fiatMarkupBp, at,
    } = await pricingRegime.messageQuote(spec, { timestamp, extend });
    const { PAYMENT_WINDOW_MS } = await getSpecBackend();
    return res.ok({
      fee: String(fee), usd, fiatMarkupBp, payBy: timestamp + PAYMENT_WINDOW_MS, pricedAt: at,
    });
  } catch (error) {
    if (QUOTE_REFUSALS.has(error.name)) return res.fail('UNPROCESSABLE', error.message, { reason: error.name });
    throw error;
  }
}

module.exports = {
  activeStandby,
  ownerships,
  quote,
};
