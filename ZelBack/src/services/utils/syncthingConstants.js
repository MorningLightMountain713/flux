'use strict';

/**
 * The HTTP methods syncthing's /rest/config endpoints accept, and the only
 * spellings a caller may name. Anything else is refused before a request is
 * made, so a bad method names itself rather than arriving as a generic failure.
 *
 * It lives here rather than on syncthingService because both the service and
 * its callers need it: a caller destructuring it from the service reads
 * undefined wherever that service is stubbed.
 */
const ConfigMethod = Object.freeze({
  GET: 'get',
  PUT: 'put',
  POST: 'post',
  PATCH: 'patch',
  DELETE: 'delete',
});

module.exports = { ConfigMethod };
