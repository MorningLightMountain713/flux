'use strict';

const capabilities = require('../utils/capabilities');
const capabilityReadout = require('../utils/capabilityReadout');
const capabilityHistory = require('../capabilityHistory');

const { STARTED_AT } = capabilityHistory;

/**
 * GET /v2/node/boot - how this process came up: every capability's state now,
 * and every transition it has made since the process started, each with when
 * it happened, why, how long the state before it lasted and which prerequisite
 * it was waiting on. `startedAt` is the process start, so a transition's
 * `at - tookMs` is where its bar begins on a timeline from there.
 * @param {import('express').Request} req
 * @param {import('express').Response} res carrying the v2 envelope
 * @returns {*}
 */
function boot(req, res) {
  const now = Date.now();
  return res.ok({
    startedAt: STARTED_AT,
    now,
    capabilities: capabilities.snapshot(),
    transitions: capabilities.transitions(),
  });
}

/**
 * GET /v2/node/capabilities - every present capability's state now.
 * @param {import('express').Request} req
 * @param {import('express').Response} res carrying the v2 envelope
 * @returns {*}
 */
function capabilityStates(req, res) {
  return res.ok(capabilities.snapshot());
}

/**
 * GET /v2/node/capabilities/blame - every capability by how long after the
 * process start it first came up, slowest first.
 * @param {import('express').Request} req
 * @param {import('express').Response} res carrying the v2 envelope
 * @returns {*}
 */
function blame(req, res) {
  return res.ok(capabilityReadout.blame(capabilities.snapshot(), STARTED_AT));
}

/**
 * GET /v2/node/capabilities/critical-chain - the prerequisites that decided
 * when the last capability came up.
 * @param {import('express').Request} req
 * @param {import('express').Response} res carrying the v2 envelope
 * @returns {*}
 */
function criticalChain(req, res) {
  return res.ok(capabilityReadout.criticalChain(capabilities.snapshot(), STARTED_AT));
}

/**
 * GET /v2/node/capabilities/history - the capability transitions of this
 * process and the ones before it, newest process first.
 * @param {import('express').Request} req
 * @param {import('express').Response} res carrying the v2 envelope
 * @returns {Promise<*>}
 */
async function history(req, res) {
  return res.ok(await capabilityHistory.history());
}

module.exports = {
  blame,
  boot,
  capabilityStates,
  criticalChain,
  history,
};
