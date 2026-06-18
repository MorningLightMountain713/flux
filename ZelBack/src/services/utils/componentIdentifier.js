// Derive the app/component name encoded in a bare container identifier — the
// inverse of flux-spec's forward containerIdentifier (`{component}_{app}` for
// v4+, the bare `{app}` for v1-3 flat). Correct for every spec version because
// app names never contain '_' (legacy ^[a-zA-Z0-9]+$, v9 the app-name rule), so
// the LAST '_' is always the component/app separator — even when a (legacy)
// component name itself contains '_'. Sync and dependency-free so the
// reconciler's hot/sync paths and the operation registry share one rule
// (flux-spec-backend is ESM-only and can't be required synchronously). Where a
// built DeploymentSpec is in hand, prefer its componentForIdentifier (exact map).
// Inputs are the bare identifier — strip the flux/zel prefix first.

/**
 * The main app name encoded in a bare container identifier.
 * @param {string} identifier - `{component}_{app}` (v4+) or `{app}` (v1-3 flat)
 * @returns {string}
 */
function appNameFromIdentifier(identifier) {
  const i = identifier.lastIndexOf('_');
  return i === -1 ? identifier : identifier.slice(i + 1);
}

/**
 * The component name encoded in a bare container identifier — equals the app
 * name for v1-3 flat, where the component is the app.
 * @param {string} identifier
 * @returns {string}
 */
function componentNameFromIdentifier(identifier) {
  const i = identifier.lastIndexOf('_');
  return i === -1 ? identifier : identifier.slice(0, i);
}

module.exports = { appNameFromIdentifier, componentNameFromIdentifier };
