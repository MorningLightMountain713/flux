'use strict';

/**
 * The /v2 route table, registered by routeBuilder on the v2 router.
 *
 * The same shape as v1's: a route names its handler as `<module under
 * services/>#<function>`, the capabilities it reads (`needs`) or why it reads
 * none (`none`), and its guards. A route that parses its own body says so
 * (`ownsBody`) and is registered ahead of the surface's body parser, so that
 * parser never reads its body first.
 *
 * Every path is in the subset express 4 and 5 both accept (routesV2.js).
 */
module.exports = [
  // The contents of a paid app message this node is missing, stored through the
  // one store function: it needs the local collections and a chain state that is
  // not mid-rewind.
  {
    method: 'post', path: '/apps/messages', ownsBody: true, guards: ['deliveryBody'], needs: ['localDbPrepared', 'chainStateConsistent'], handler: 'apiV2/messages#deliver',
  },
  {
    method: 'get', path: '/operations/:id', none: 'reads the operation registry this process holds', handler: 'apiV2/operations#read',
  },
];
