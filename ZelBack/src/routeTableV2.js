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
const READS_CAPABILITIES = 'reads the capability registry this process holds';

module.exports = [
  // The contents of a paid app message this node is missing, stored through the
  // one store function: it needs the local collections and a chain state that is
  // not mid-rewind.
  {
    method: 'post', path: '/apps/messages', ownsBody: true, guards: ['deliveryBody'], needs: ['localDbPrepared', 'chainStateConsistent'], handler: 'apiV2/messages#deliver',
  },
  // What this node holds about an app message, by hash: it reads the decisions,
  // the pool and the payment records, none of which is whole mid-rewind.
  {
    method: 'get', path: '/apps/messages/:hash/decision', needs: ['localDbPrepared', 'chainStateConsistent'], handler: 'apiV2/messages#decision',
  },
  {
    method: 'get', path: '/operations/:id', none: 'reads the operation registry this process holds', handler: 'apiV2/operations#read',
  },
  // Which activeStandby components this node runs or holds, for a balancer routing
  // them: it reads the hosted instances.
  {
    method: 'get', path: '/apps/activestandby', needs: ['localDbPrepared'], handler: 'apiV2/apps#activeStandby',
  },
  // The fee consensus will charge a v9 message, fixed at its signed time: it reads
  // the price histories, the registry, the decisions and the pool, as the v1
  // price quote does.
  {
    method: 'post', path: '/apps/quotes', needs: ['localDbPrepared', 'appRegistryConsistent', 'explorerSynced', 'chainStateConsistent'], handler: 'apiV2/apps#quote',
  },
  // The prices in force for a message signed at a time, which its quote prices
  // with: it reads the price histories.
  {
    method: 'get', path: '/apps/prices', needs: ['explorerSynced', 'chainStateConsistent'], handler: 'apiV2/apps#prices',
  },
  // A message checked as its submission will check it: it reads the registry,
  // the chain and the prices the v1 verification does.
  {
    method: 'post', path: '/apps/verifications', needs: ['appRegistryConsistent', 'explorerSynced', 'chainStateConsistent'], handler: 'apiV2/apps#verification',
  },
  // A signed message stored and broadcast: the same reads, by a signed-in user.
  {
    method: 'post', path: '/apps/submissions', guards: ['user'], needs: ['appRegistryConsistent', 'explorerSynced', 'chainStateConsistent'], handler: 'apiV2/apps#submission',
  },
  // Who has owned the app holding a name: it reads the decisions, which are not
  // whole mid-rewind.
  {
    method: 'get', path: '/apps/:name/ownerships', needs: ['localDbPrepared', 'chainStateConsistent'], handler: 'apiV2/apps#ownerships',
  },
  // How this process came up, read from the capability registry, which exists
  // before anything else does. For the node's operator and the team.
  {
    method: 'get', path: '/node/boot', guards: ['nodeOperatorOrFluxTeam'], none: READS_CAPABILITIES, handler: 'apiV2/node#boot',
  },
  {
    method: 'get', path: '/node/capabilities', guards: ['nodeOperatorOrFluxTeam'], none: READS_CAPABILITIES, handler: 'apiV2/node#capabilityStates',
  },
  {
    method: 'get', path: '/node/capabilities/blame', guards: ['nodeOperatorOrFluxTeam'], none: READS_CAPABILITIES, handler: 'apiV2/node#blame',
  },
  {
    method: 'get', path: '/node/capabilities/critical-chain', guards: ['nodeOperatorOrFluxTeam'], none: READS_CAPABILITIES, handler: 'apiV2/node#criticalChain',
  },
  // Earlier processes' transitions are in the local database.
  {
    method: 'get', path: '/node/capabilities/history', guards: ['nodeOperatorOrFluxTeam'], needs: ['localDbPrepared'], handler: 'apiV2/node#history',
  },
];
