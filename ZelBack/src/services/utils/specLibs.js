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

const config = require('config');

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

/**
 * Validate a submission-shape spec blob through the appropriate spec
 * class, optionally enforcing the FluxOS fork-activation height gate
 * for the spec's version.
 *
 * Responsibilities:
 *   1. Resolve the right version class from the shared registry
 *      (v1-v8 live in spec-backend, v9 in spec).
 *   2. Apply FluxOS's per-version fork-activation height policy —
 *      new spec versions are rejected before their enforcement height.
 *   3. Delegate all shape / type / semantic checks to the class's
 *      `fromSubmission`. ValidationError instances are flattened into
 *      a single-line `Error` for the caller.
 *
 * Platform-level checks (Docker registry, architecture compat, blocked
 * repos) are a separate concern — call
 * `imageArchitectureValidator.verifyImageRegistryAndArchitectures` in
 * the submission path when those are needed.
 *
 * @param {object} spec - Submission blob (FluxOS-normalized shape)
 * @param {object} [options]
 * @param {number} [options.height] - Current daemon height. When
 *   provided, rejects spec versions below their enforcement height.
 * @returns {Promise<true>}
 * @throws {Error} with a human-readable single-line message on any
 *   failure. For validation failures the message is derived from the
 *   class's first structured error; for version mismatch / height-gate
 *   failures the message names the violated policy.
 */
async function validateSubmissionSpec(spec, { height } = {}) {
  await getSpecBackend(); // register v1-v8 classes into the shared version registry
  const { FluxAppSpecBase, ValidationError } = await getSpec();
  const VersionClass = spec && FluxAppSpecBase.getVersionClass(spec.version);
  if (!VersionClass) {
    throw new Error(`Unsupported Flux App specification version: ${spec && spec.version}`);
  }
  if (height !== undefined
    && height < config.fluxapps.appSpecsEnforcementHeights[spec.version]) {
    throw new Error(`Flux apps specifications of version ${spec.version} not yet supported`);
  }
  try {
    VersionClass.fromSubmission(spec);
  } catch (err) {
    if (err instanceof ValidationError && Array.isArray(err.errors) && err.errors.length > 0) {
      const first = err.errors[0];
      const path = first.field ? `${first.field}: ` : '';
      throw new Error(`${path}${first.message}`);
    }
    throw err;
  }
  return true;
}

module.exports = {
  getSpec,
  getSpecBackend,
  getSpecPolicy,
  validateSubmissionSpec,
};
