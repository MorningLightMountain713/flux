'use strict';

// Which layer answers, and with what.
//
// A request that REACHED a handler is answered in the body, at HTTP 200, in the
// shapes below - including when the answer is a failure. A refusal that happens
// BEFORE a handler runs is answered with a wire status: the middlewares
// (requireHttps 403, routeGuards 503/400), a body over express.json's default
// 100kb limit (express 413), a resource that does not exist to be addressed
// (fluxEventBus 404). A handler that reads its own body bounds it itself and
// answers the same way - express.json is the only parser mounted, so nothing
// else looks at a body whose content type it does not claim.
//
// This is the rule to write NEW code to, not a description of what is already
// here. The codebase is not uniform: there are ~50 res.status( sites and a good
// share of them are inside handlers that ran, so they answer a service failure
// with a wire status. operationsController is both at once - it writes
// `res.status(200).json(createErrorMessage(...))` explicitly, refusing to let
// the two blur, and a few lines later answers 400/404/500 from inside a handler.
//
// The earlier version of this note put a count here - "roughly 315 in band
// against 27 that set a status, and the 27 are all of the second kind" - which
// was wrong, and wrong in the way its own last line warns about.
//
// The in-band shape exists so a transport failure cannot impersonate a service
// answer. An error carried at a
// non-200 status would put the two on the same channel again, which is what the
// separation is for. `code` inside an error message is therefore a FluxOS code
// and not a wire status - a deprecated endpoint answers 200 with code 410, and a
// caller reading response.ok sees success and has to read the body, which is
// exactly what every FluxOS client already does.
//
// Written down here because it was not written down anywhere, and counting the
// call sites without reading what they were gives the wrong answer.

/**
 * Creates a message object.
 *
 * @param {object} data
 *
 * @returns {object} message
 */
function createDataMessage(data) {
  const successMessage = {
    status: 'success',
    data,
  };
  return successMessage;
}

/**
 * Creates a message object indicating success.
 *
 * @param {string} message
 * @param {string} [name]
 * @param {string} [code]
 *
 * @returns {object} success message
 */
function createSuccessMessage(message, name, code) {
  const successMessage = {
    status: 'success',
    data: {
      code,
      name,
      message,
    },
  };
  return successMessage;
}

/**
 * Creates a message indicating a warning.
 *
 * @param {string} message
 * @param {string} [name]
 * @param {string} [code]
 *
 * @returns {object} warning message
 */
function createWarningMessage(message, name, code) {
  const warningMessage = {
    status: 'warning',
    data: {
      code,
      name,
      message,
    },
  };
  return warningMessage;
}

/**
 * Creates a message indicating an error.
 *
 * @param {string} message
 * @param {string} [name]
 * @param {string} [code]
 *
 * @returns {object} error message
 */
function createErrorMessage(message, name, code) {
  const errMessage = {
    status: 'error',
    data: {
      code,
      name,
      message: message || 'Unknown error',
    },
  };
  return errMessage;
}

/**
 * Returns unauthorized error message.
 *
 * @returns {object} unauthorized error message
 */
function errUnauthorizedMessage() {
  const errMessage = {
    status: 'error',
    data: {
      code: 401,
      name: 'Unauthorized',
      message: 'Unauthorized. Access denied.',
    },
  };
  return errMessage;
}

module.exports = {
  createDataMessage,
  createErrorMessage,
  createSuccessMessage,
  createWarningMessage,
  errUnauthorizedMessage,
};
