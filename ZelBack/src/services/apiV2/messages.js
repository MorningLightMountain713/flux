'use strict';

const messageDelivery = require('../appMessaging/messageDelivery');

/**
 * POST /v2/apps/messages - the contents of a paid app message this node is
 * missing. Unauthenticated: only contents whose hash this node's scan recorded a
 * payment for, and that pass every storage check, are stored.
 * @param {import('express').Request} req
 * @param {import('express').Response} res carrying the v2 envelope
 * @returns {Promise<*>}
 */
async function deliver(req, res) {
  const { outcome, reason } = await messageDelivery.deliverMessage(req.body);
  if (outcome === 'stored') return res.created({ hash: req.body.hash });
  if (outcome === 'held') return res.ok({ hash: req.body.hash, held: true });
  if (outcome === 'unpaid') return res.fail('NOT_FOUND', 'this node has recorded no payment for this hash');
  return res.fail('UNPROCESSABLE', reason);
}

module.exports = {
  deliver,
};
