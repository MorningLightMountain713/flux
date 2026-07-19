const specLibs = require('./specLibs');

// Thin sync bridge to flux-spec's identifier<->name rule. The rule itself lives
// in DeploymentSpec (next to the forward containerIdentifier and the exact-map
// componentForIdentifier) -- this only exists because flux-spec-backend is
// ESM-only and these callers (e.g. the reconciler's sync hasOperationLease
// guard) cannot await an import. The reconciler preloads flux-spec-backend at
// boot, so getSpecBackendSync is warm before any reconcile. Transitional: retires
// when the labels track replaces name-parsing with label reads.

/**
 * @param {string} identifier - bare `{component}_{app}` (v4+) or `{app}` (v1-3)
 * @returns {string} the main app name
 */
function appNameFromIdentifier(identifier) {
  return specLibs.getSpecBackendSync().DeploymentSpec.appNameFromIdentifier(identifier);
}

/**
 * @param {string} identifier
 * @returns {string} the component name (equals the app name for v1-3 flat)
 */
function componentNameFromIdentifier(identifier) {
  return specLibs.getSpecBackendSync().DeploymentSpec.componentNameFromIdentifier(identifier);
}

/**
 * @param {string} identifier
 * @returns {string|null} the replica name of a qualified
 *   `{component}_{app}_{replica}` identifier, null for an unqualified one
 */
function replicaFromIdentifier(identifier) {
  return specLibs.getSpecBackendSync().DeploymentSpec.replicaFromIdentifier(identifier);
}

/**
 * Encode a container identifier from its parts. Prefer a deployment
 * component's own `identifier` wherever one is in scope; reach for this only
 * when the caller genuinely holds names. Assembling `${component}_${app}` by
 * hand drops the replica segment, addressing either nothing or a co-located
 * sibling.
 * @param {string} componentName
 * @param {string} appName
 * @param {string|null} [replica] bound replica name; null for loose placement
 * @returns {string}
 */
function containerIdentifierFor(componentName, appName, replica = null) {
  return specLibs.getSpecBackendSync()
    .DeploymentSpec.containerIdentifierFor(componentName, appName, replica);
}

module.exports = {
  appNameFromIdentifier,
  componentNameFromIdentifier,
  replicaFromIdentifier,
  containerIdentifierFor,
};
