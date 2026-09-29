'use strict';

const operationsController = require('../appManagement/operationsController');

/**
 * THE status resource every long-running v2 operation points at.
 *
 * Reads the operation through the same pure function v1's
 * /apps/operations/:jobId reads it through, and formats it in the v2 envelope.
 * Neither surface owns the operation; both are skins.
 *
 * A running operation is 200 with a non-terminal state. Completion is read from
 * the body, never inferred from the status code - a failed operation is still
 * a successful poll.
 * @param {import('express').Request} req
 * @param {import('express').Response} res carrying the v2 envelope
 * @returns {Promise<*>}
 */
async function read(req, res) {
  const sinceRaw = req.query.since;
  const since = sinceRaw === undefined ? null : Number(sinceRaw);
  if (since !== null && !Number.isFinite(since)) {
    return res.fail('BAD_REQUEST', 'since must be a number');
  }

  const view = await operationsController.readOperation({
    jobId: req.params.id,
    callerId: await operationsController.callerFluxId(req),
    sinceSeq: since,
  });

  // Unknown, expired and not-yours are ONE answer: a caller must not be able to
  // learn from a 403 that someone else has an operation running.
  if (!view) return res.fail('NOT_FOUND', 'operation not found');

  return res.ok(view);
}

module.exports = {
  read,
};
