'use strict';

const appsRepository = require('../appDatabase/appsRepository');
const confirmedMessageStore = require('../appMessaging/confirmedMessageStore');
const messageDelivery = require('../appMessaging/messageDelivery');
const temporaryPoolSweep = require('../appMessaging/temporaryPoolSweep');
const decisionStore = require('../appDecisions/decisionStore');
const { REFUSED } = require('../appDecisions/decisionRule');

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

/**
 * GET /v2/apps/messages/:hash/decision - what this node holds about an app
 * message. A decision is this node's word on a paid message; an applied one
 * names the owner and the identity the message gave the app, which is what a
 * write held for that message is checked against. An unpayable record outranks
 * a copy still held: the copy's payment can no longer come. A copy, or a
 * recorded payment, with neither is waiting on the decider. A node that holds
 * nothing answers 404, which says nothing about the message.
 * @param {import('express').Request} req
 * @param {import('express').Response} res carrying the v2 envelope
 * @returns {Promise<*>}
 */
async function decision(req, res) {
  const { hash } = req.params;
  const decided = (await decisionStore.decisionsFor([hash])).get(hash);
  if (decided && decided.decision === REFUSED) return res.ok({ hash, decision: REFUSED, reason: decided.reason });
  if (decided) {
    const message = await appsRepository.getPermanentMessage(hash);
    return res.ok({ hash, decision: decided.decision, owner: message?.appSpecifications?.owner ?? null, identity: decided.identity ?? null });
  }
  if (await temporaryPoolSweep.unpayableRecord(hash)) return res.ok({ hash, decision: 'unpayable' });
  const held = await appsRepository.getPermanentMessage(hash)
    || await appsRepository.getTempMessage(hash)
    || (await confirmedMessageStore.paymentRecords([hash])).has(hash);
  if (held) return res.ok({ hash, decision: 'undecided' });
  return res.fail('NOT_FOUND', 'this node holds nothing about this hash');
}

module.exports = {
  decision,
  deliver,
};
