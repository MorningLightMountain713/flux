'use strict';

const messageHelper = require('../messageHelper');
const serviceHelper = require('../serviceHelper');
const verificationHelper = require('../verificationHelper');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const appsRepository = require('../appDatabase/appsRepository');
const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');
const messageStore = require('../appMessaging/messageStore');
const ownerGenerationRecord = require('./ownerGenerationRecord');
const log = require('../../lib/log');

// The owner's way in: how a signed generation record actually reaches the
// fleet. The dashboard flow is read, sign, submit — the read surface tells
// the owner the standing generation, the owner's tooling signs exactly the
// next one, and the submission broadcasts it and stores it here first.
//
// Two authorities check every submission, and they answer different
// questions. The zelidauth session authorizes the SUBMISSION — this node
// does not relay unauthenticated writes. The record's own inner signature is
// what the FLEET verifies, hop by hop, against each node's own copy of the
// spec — the session never travels, the record does.
//
// The door is contiguous, the plane is not: this endpoint accepts exactly
// stored+1 and teaches the standing generation on refusal, which makes the
// read-then-sign loop mandatory rather than polite, closes the stale-read
// race in one extra round trip, and stops a buggy owner tool signing
// generation 10^15 and burning the app's headroom. Between nodes the record
// stays monotonic newest-wins — the store keeps only the newest record per
// app and role, so intermediates are unfetchable, and a show-me-N-minus-1
// rule between nodes would wedge any node with a sync gap into permanent
// refusal. The door is a courtesy to the honest path, not a safety
// property: safety is the owner signature plus the monotonic comparator.

const APP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const ROLE_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;

/**
 * POST an owner-signed generation record: verify, gate at stored+1,
 * broadcast, store locally.
 */
async function submit(req, res) {
  try {
    const body = serviceHelper.ensureObject(req.body) ?? {};
    const record = {
      appName: body.appName,
      role: body.role,
      generation: body.generation,
      height: body.height,
      at: body.at,
      signature: body.signature,
    };
    if (!ownerGenerationRecord.wellFormed(record)
      || typeof record.signature !== 'string' || !record.signature) {
      return res.status(400).json(messageHelper.createErrorMessage('malformed generation record'));
    }

    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, record.appName);
    if (authorized !== true) {
      return res.status(401).json(messageHelper.errUnauthorizedMessage());
    }

    const owner = await appsRepository.getGlobalAppOwner(record.appName);
    if (!owner || !ownerGenerationRecord.verify(record, owner)) {
      return res.status(403).json(messageHelper.createErrorMessage('record is not signed by the app owner'));
    }

    const stored = await messageStore.getGrantGenerationRecord(record.appName, record.role);
    const current = stored?.data?.generation ?? 0;
    if (record.generation !== current + 1) {
      return res.status(409).json(messageHelper.createErrorMessage(
        `record names generation ${record.generation}; the standing generation is ${current}, so the next is ${current + 1}`,
      ));
    }

    // The broadcast names this node's own address: peer verification
    // resolves the announcer BY IP against the deterministic list and
    // checks the envelope key against that node's registered key - a
    // record without it is dropped by every receiver.
    const ip = await fluxNetworkHelper.getLocalSocketAddress();
    if (!ip) {
      return res.status(503).json(messageHelper.createErrorMessage('node address unavailable'));
    }

    const message = {
      type: 'fluxgrantgeneration',
      version: 1,
      ip,
      appName: record.appName,
      role: record.role,
      generation: record.generation,
      height: record.height,
      at: record.at,
      signature: record.signature,
      broadcastedAt: Date.now(),
    };
    const signed = await fluxCommunicationMessagesSender.broadcastMessageToAll(message);
    const envelope = signed
      ? {
        version: signed.version, timestamp: signed.timestamp, pubKey: signed.pubKey, signature: signed.signature,
      }
      : null;
    await messageStore.storeAppStateEvent(
      messageStore.APP_STATE_EVENT_TYPES.GRANTGENERATION,
      { message, envelope },
    );

    return res.json(messageHelper.createDataMessage({
      appName: record.appName,
      role: record.role,
      generation: record.generation,
    }));
  } catch (error) {
    log.error(`quorumGrant ownerGenerationController submit: ${error.message}`);
    return res.status(500).json(messageHelper.createErrorMessage(error.message));
  }
}

/**
 * The standing generation for one app role — what the owner reads before
 * signing, and what a refusal teaches. Public fact from the event plane
 * (the record broadcast to every node), so the read is unauthenticated
 * like every other public record read.
 */
async function current(req, res) {
  try {
    const appName = req.params.appname ?? req.query.appname;
    const role = req.params.role ?? req.query.role;
    if (typeof appName !== 'string' || !APP_PATTERN.test(appName)) {
      return res.status(400).json(messageHelper.createErrorMessage('malformed app name'));
    }
    if (typeof role !== 'string' || !ROLE_PATTERN.test(role)) {
      return res.status(400).json(messageHelper.createErrorMessage('malformed role'));
    }

    const stored = await messageStore.getGrantGenerationRecord(appName, role);
    return res.json(messageHelper.createDataMessage({
      appName,
      role,
      generation: stored?.data?.generation ?? 0,
      record: stored?.data ?? null,
    }));
  } catch (error) {
    log.error(`quorumGrant ownerGenerationController current: ${error.message}`);
    return res.status(500).json(messageHelper.createErrorMessage(error.message));
  }
}

module.exports = {
  submit,
  current,
};
