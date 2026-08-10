'use strict';

const log = require('../../lib/log');
const policyStore = require('../policy/policyStore');

// Maps each enterprise node pubkey to the app-owner addresses allowed to install on it
// (many-to-many: an owner may appear under several nodes). The map itself is one of the
// network policy documents — policyStore owns fetching, validating, caching and holding
// last-known-good; this module is the shape-aware view over it.
const DOCUMENT = 'enterpriseNodes';

// Memoized union of all owners. Rebuilt only when the underlying map changes, keyed by
// reference: policyStore always replaces the payload wholesale, never mutates it in
// place, so reference identity is a sound invalidation signal.
let ownersUnionCache = null;
let ownersUnionCacheKey = null;

/**
 * The node-pubkey -> [ownerAddress] map.
 *
 * An empty map when policyStore has nothing is deliberate. Every caller asks an
 * allow-list question ("may this owner install here?"), and the answer under an
 * unreadable document has to be no — a node cannot admit an enterprise owner it
 * cannot confirm. That only happens with no cache and no readable seed.
 * @returns {object}
 */
function getEnterpriseNodeOwnerMap() {
  return policyStore.get(DOCUMENT) ?? {};
}

/**
 * Whether the owner map has been loaded at all — from the cache, the seed, or a fetch.
 *
 * False only before policyStore has started, which on a restart is a real window: the API
 * listens well before the boot sequence reaches startSync. The allow-list callers above are
 * ordered after it and are right to fail closed regardless, but a caller that can tell the
 * difference should: serving an empty union as though it were the answer is indistinguishable
 * from a network that has no enterprise nodes.
 * @returns {boolean}
 */
function isOwnerMapLoaded() {
  return policyStore.get(DOCUMENT) !== null;
}

/** Every enterprise node pubkey (the map keys). */
function getEnterpriseNodesPublicKeys() {
  return Object.keys(getEnterpriseNodeOwnerMap());
}

/** Owner addresses allowed to install on a specific node pubkey. */
function getAllowedOwnersForNode(pubKey) {
  const owners = getEnterpriseNodeOwnerMap()[pubKey];
  return Array.isArray(owners) ? owners : [];
}

/**
 * The global set of enterprise app owners: the deduped union of every node's allowed
 * owners. Used for node-agnostic checks (datacenter validation, CPU burst eligibility,
 * excluding enterprise apps from public nodes).
 */
function getEnterpriseAppOwners() {
  const nodeOwnerMap = getEnterpriseNodeOwnerMap();
  if (ownersUnionCacheKey === nodeOwnerMap) return ownersUnionCache;
  const all = Object.values(nodeOwnerMap).filter(Array.isArray).flat();
  ownersUnionCache = [...new Set(all)];
  ownersUnionCacheKey = nodeOwnerMap;
  return ownersUnionCache;
}

/**
 * Register a handler fired after each refresh that changes the owner map, so consumers
 * can react to a membership change (e.g. reclaiming resources owned by a now-de-authorized
 * owner) without policyStore knowing anything about them.
 * @param {function} [onOwnerMapRefreshed]
 */
function onOwnerMapChange(onOwnerMapRefreshed) {
  if (!onOwnerMapRefreshed) return;
  policyStore.onChange(DOCUMENT, onOwnerMapRefreshed);
  log.info('enterpriseConfig - subscribed to enterprise owner map refreshes');
}

module.exports = {
  getAllowedOwnersForNode,
  getEnterpriseAppOwners,
  getEnterpriseNodeOwnerMap,
  getEnterpriseNodesPublicKeys,
  isOwnerMapLoaded,
  onOwnerMapChange,
};
