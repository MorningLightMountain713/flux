/**
 * Lazy ESM loaders for the @megachips/flux-spec* packages.
 *
 * FluxOS is CommonJS. The spec libraries are ESM-only (Node >=20).
 * Each getter imports its package on first call and caches the module for
 * subsequent calls — a single await per package per process lifetime.
 *
 * Usage:
 *   const { getSpec, getSpecBackend, getSpecPolicy } = require('./specLibs');
 *   const { FluxAppSpecV9 } = await getSpec();
 *
 * Consensus-relevance: the packages are pinned to exact versions in
 * package.json. Any change to the fold semantics is a coordinated release.
 */

let specCache;
let specBackendCache;
let specPolicyCache;

async function getSpec() {
  return (specCache ??= await import('@megachips/flux-spec'));
}

async function getSpecBackend() {
  return (specBackendCache ??= await import('@megachips/flux-spec-backend'));
}

async function getSpecPolicy() {
  return (specPolicyCache ??= await import('@megachips/flux-spec-policy'));
}

module.exports = {
  getSpec,
  getSpecBackend,
  getSpecPolicy,
};
