'use strict';

const capabilities = require('../utils/capabilities');

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
    startedAt: Math.round(now - process.uptime() * 1000),
    now,
    capabilities: capabilities.snapshot(),
    transitions: capabilities.transitions(),
  });
}

module.exports = {
  boot,
};
