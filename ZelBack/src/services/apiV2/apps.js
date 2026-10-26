'use strict';

const appQueryService = require('../appQuery/appQueryService');
const appHistory = require('../appDecisions/appHistory');
const appsRepository = require('../appDatabase/appsRepository');
const pricingRegime = require('../pricing/pricingRegime');
const { resolveSpec } = require('../utils/specCutover');
const transportHelper = require('../utils/transportHelper');
const { getSpecBackend, validatePrivateSubmission } = require('../utils/specLibs');
const { assertSubmittableTimestamp } = require('../appMessaging/submittableTimestamp');
const appSubmission = require('../appRequirements/appSubmission');
const appOperations = require('../appLifecycle/appOperations');
const ingressAttestationService = require('../appMessaging/ingressAttestationService');
const ingressCapture = require('../utils/ingressCapture');

/** The refusals a quote reports by name, for a client to branch on. */
const QUOTE_REFUSALS = new Set(['NotQuotable', 'StampedEarly', 'UpdateRefused']);

/** The message types a verification or a submission takes. */
const MESSAGE_TYPES = new Set(['fluxappregister', 'fluxappupdate']);

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
 * its signed time: `{ type, appSpecification, contentHash, extend, timestamp }`,
 * the fields the submission carries. A private spec arrives sealed to this
 * node's transport key exactly as it is submitted, and is opened the same way;
 * `contentHash`, when given, is the hash of the spec priced. A payment of `fee`
 * satoshis mined by `payBy` is accepted whichever block confirms it; after that
 * the message can no longer be paid.
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
  const {
    type, appSpecification, contentHash, extend = false, timestamp,
  } = req.body ?? {};
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
    // A sealed spec opens to a private one, held as an OpenedSpec; a spec in
    // the clear, or stored sealed, is read as it is.
    spec = appSpecification.transportEncrypted
      ? await validatePrivateSubmission(await transportHelper.openTransportEnvelope(appSpecification, {
        contentHash, timestamp, type,
      }))
      : await resolveSpec(appSpecification);
  } catch (error) {
    return res.fail('UNPROCESSABLE', error.message);
  }
  if (!spec) return res.fail('UNPROCESSABLE', 'appSpecification cannot be read on this node');
  if (contentHash !== undefined && spec.contentHash() !== contentHash) {
    return res.fail('UNPROCESSABLE', 'contentHash does not match appSpecification');
  }

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

/**
 * POST /v2/apps/verifications - checks a message before it is signed and paid
 * for, as its submission will: `{ type, appSpecification, contentHash,
 * timestamp }`, the fields the submission carries. `type` selects the checks a
 * registration or an update is held to. A private spec arrives sealed to this
 * node's transport key exactly as it is submitted. Answers the spec as the node
 * will broadcast it; refused with the reason the submission would give.
 * @param {import('express').Request} req
 * @param {import('express').Response} res carrying the v2 envelope
 * @returns {Promise<*>}
 */
async function verification(req, res) {
  const {
    type, appSpecification, contentHash, timestamp,
  } = req.body ?? {};
  if (!MESSAGE_TYPES.has(type)) return res.fail('BAD_REQUEST', 'type is fluxappregister or fluxappupdate');
  if (!appSpecification || typeof appSpecification !== 'object') {
    return res.fail('BAD_REQUEST', 'appSpecification is the message\'s specification');
  }

  const validate = type === 'fluxappregister' ? appSubmission.validateAppRegistration : appSubmission.validateAppUpdate;
  try {
    return res.ok({ appSpecification: await validate(appSpecification, { contentHash, timestamp, type }) });
  } catch (error) {
    return res.fail('UNPROCESSABLE', error.message);
  }
}

/**
 * POST /v2/apps/submissions - stores and broadcasts a signed message, the
 * verification's fields with `version` and `signature`, and answers its hash
 * once this node holds it. Its decision is read at the `Location` answered.
 * Refused when this node holds too few peers to broadcast it, and with the
 * reason for a message the network would refuse.
 * @param {import('express').Request} req
 * @param {import('express').Response} res carrying the v2 envelope
 * @returns {Promise<*>}
 */
async function submission(req, res) {
  const {
    type, version, appSpecification, contentHash, timestamp, extend, signature,
  } = req.body ?? {};
  if (!MESSAGE_TYPES.has(type)) return res.fail('BAD_REQUEST', 'type is fluxappregister or fluxappupdate');
  if (!appSubmission.holdsEnoughPeersToSubmit()) {
    return res.fail('UNAVAILABLE', 'this node does not hold enough peer connections to broadcast an app message');
  }

  const submit = type === 'fluxappregister' ? appSubmission.registerAppGlobaly : appOperations.updateAppGlobaly;
  let hash;
  try {
    hash = await submit({
      type, version, appSpecification, contentHash, timestamp, extend, signature,
    });
  } catch (error) {
    return res.fail('UNPROCESSABLE', error.message);
  }

  // Record and gossip where this message entered the network (best-effort).
  await ingressAttestationService.emit(hash, await ingressCapture.captureIngress(req));
  return res.created({ hash }, `/v2/apps/messages/${hash}/decision`);
}

module.exports = {
  activeStandby,
  ownerships,
  quote,
  submission,
  verification,
};
