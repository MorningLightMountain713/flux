'use strict';

const messageHelper = require('./services/messageHelper');
const routesV2 = require('./routesV2');
const routeTable = require('./routeTableV1');
const { registerRoutes } = require('./routeBuilder');

/**
 * A v1 route refused because a capability it reads is down, in the v1 error
 * envelope.
 * @param {import('express').Response} res
 * @param {{message: string}} refusal
 * @returns {*}
 */
function refuse(res, { message }) {
  return res.status(503).json(messageHelper.createErrorMessage(message, 'ServiceUnavailable', 503));
}

module.exports = (app) => {
  // Mounted FIRST, and it terminates its own surface with a 404, so nothing
  // under /v2 can fall through into the frozen v1 routes below and answer in
  // the wrong envelope.
  app.use('/v2', routesV2);
  registerRoutes(app, routeTable, { refuse });
};
