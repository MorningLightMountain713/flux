'use strict';

const messageHelper = require('../services/messageHelper');

/**
 * Express middleware rejecting a route when the connection is not TLS.
 *
 * @param {import('express').Request} req - Request object
 * @param {import('express').Response} res - Response object
 * @param {Function} next - Next middleware
 * @returns {void}
 */
function requireHttps(req, res, next) {
  if (!req.secure) {
    const errMessage = messageHelper.createErrorMessage(
      'HTTPS required for ArcaneOS authentication endpoints',
      'ForbiddenProtocol',
      403,
    );
    return res.status(403).json(errMessage);
  }
  return next();
}

module.exports = requireHttps;
