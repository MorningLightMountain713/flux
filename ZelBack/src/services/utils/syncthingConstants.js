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

/**
 * Syncthing answered, and the answer is that it holds no such thing.
 *
 * A 404 is a FACT about syncthing's configuration, not a failure to read it.
 * Every other outcome - transport, a refused key, a 500, a malformed reply -
 * means the call did not happen and this node learned NOTHING, which is a
 * different claim and must never read as absence.
 *
 * A symbol rather than null or undefined: those are values a syncthing endpoint
 * can itself answer, so a caller that forgot to look would read one as the
 * other. Nothing can be done with this by accident.
 *
 * Here rather than on syncthingService for the same reason as ConfigMethod: a
 * caller destructuring it from the service reads undefined wherever that
 * service is stubbed, and every comparison against it would then be true.
 */
const ABSENT = Symbol('syncthing: no such folder or device');

module.exports = { ConfigMethod, ABSENT };
