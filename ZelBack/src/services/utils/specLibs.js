const config = require('config');

let specCache;
let specBackendCache;
let specPolicyCache;

async function getSpec() {
  return (specCache ??= await import('@runonflux/flux-spec'));
}

async function getSpecBackend() {
  return (specBackendCache ??= await import('@runonflux/flux-spec-backend'));
}

async function getSpecPolicy() {
  return (specPolicyCache ??= await import('@runonflux/flux-spec-policy'));
}

/**
 * Validate a submission-shape spec blob through the appropriate version
 * class, optionally enforcing FluxOS fork-activation height gates.
 *
 * @param {object} spec - Submission blob
 * @param {object} [options]
 * @param {number} [options.height] - Current daemon height for version gating
 * @returns {Promise<FluxAppSpecBase>} The validated spec class instance
 */
async function validateSubmissionSpec(spec, { height } = {}) {
  await getSpecBackend();
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
    return VersionClass.fromSubmission(spec);
  } catch (err) {
    if (err instanceof ValidationError && Array.isArray(err.errors) && err.errors.length > 0) {
      const first = err.errors[0];
      const path = first.field ? `${first.field}: ` : '';
      throw new Error(`${path}${first.message}`);
    }
    throw err;
  }
}

/**
 * Validate a spec blob from gossip or chain sync through the appropriate
 * version class's deserialize path. Runs structural validation and
 * capacity checks but does not apply submission-time policies (e.g.
 * tiered deprecation).
 *
 * @param {object} spec - Spec blob from gossip message or chain data
 * @param {object} [options]
 * @param {number} [options.height] - Current daemon height for version gating
 * @returns {Promise<FluxAppSpecBase>} The validated spec class instance
 */
async function validateGossipSpec(spec, { height } = {}) {
  await getSpecBackend();
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
    return VersionClass.deserialize(spec);
  } catch (err) {
    if (err instanceof ValidationError && Array.isArray(err.errors) && err.errors.length > 0) {
      const first = err.errors[0];
      const path = first.field ? `${first.field}: ` : '';
      throw new Error(`${path}${first.message}`);
    }
    throw err;
  }
}

module.exports = {
  getSpec,
  getSpecBackend,
  getSpecPolicy,
  validateSubmissionSpec,
  validateGossipSpec,
};
