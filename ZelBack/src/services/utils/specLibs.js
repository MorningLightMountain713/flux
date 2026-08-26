'use strict';

const config = require('config');
const { load, CONTRACT_VERSION } = require('@runonflux/flux-spec-cjs');

// The lowest flux-spec surface this FluxOS can run against. Raise it in the same change
// that starts calling a newly added export, and bump the bridge's CONTRACT_VERSION there
// too — that pair is what turns a mismatch into a startup error instead of a runtime
// mystery.
//
// flux-spec is a published package, so the copy installed on a node can be older than the
// code reading it while every dev checkout — on a `file:` dep resolving to the working
// tree — is current. Destructuring an absent export then yields undefined and fails far
// away as "<name> is not a function": verifySignature did exactly that, its TypeError
// caught and handed to callers as "Invalid signature", so the network refused every login
// while the real cause sat in a per-request log line naming a missing function.
//
// Checked at require rather than at first use. A node whose spec library is too old to
// verify a signature cannot do its job, and refusing to start says so far more plainly
// than serving traffic that is rejected for a reason nobody can see.
const REQUIRED_CONTRACT_VERSION = 1;

if (!(CONTRACT_VERSION >= REQUIRED_CONTRACT_VERSION)) {
  throw new Error(
    `flux-spec is too old for this FluxOS: contract ${CONTRACT_VERSION ?? '(none - predates the marker)'}, `
    + `requires ${REQUIRED_CONTRACT_VERSION}. Re-pin and re-vendor flux-spec.`,
  );
}

// The flux-spec ESM packages are consumed through the shared CJS bridge
// (@runonflux/flux-spec-cjs), which imports spec + spec-backend + spec-policy
// once and flattens them into one frozen namespace — rather than re-deriving the
// dynamic-import accessor here (the bridge's docstring names FluxOS as a
// consumer, and FDM already routes through it). getSpec/getSpecBackend/
// getSpecPolicy stay as named accessors so existing call sites are unchanged;
// each returns that same merged namespace, and callers destructure the classes
// they need.
async function getSpec() { return load(); }
async function getSpecBackend() { return load(); }
async function getSpecPolicy() { return load(); }

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
  const { FluxAppSpecBase } = await getSpec();
  const VersionClass = spec && FluxAppSpecBase.getVersionClass(spec.version);
  if (!VersionClass) {
    throw new Error(`Unsupported Flux App specification version: ${spec && spec.version}`);
  }
  if (height !== undefined
    && height < config.fluxapps.appSpecsEnforcementHeights[spec.version]) {
    throw new Error(`Flux apps specifications of version ${spec.version} not yet supported`);
  }
  return VersionClass.fromSubmission(spec);
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
  const { FluxAppSpecBase } = await getSpec();
  const VersionClass = spec && FluxAppSpecBase.getVersionClass(spec.version);
  if (!VersionClass) {
    throw new Error(`Unsupported Flux App specification version: ${spec && spec.version}`);
  }
  if (height !== undefined
    && height < config.fluxapps.appSpecsEnforcementHeights[spec.version]) {
    throw new Error(`Flux apps specifications of version ${spec.version} not yet supported`);
  }
  return VersionClass.deserialize(spec);
}

/**
 * Enforce cross-update invariants (fields locked at first registration, e.g.
 * `referral`). Compares the incoming spec against the app's previous on-chain
 * spec. Both must be cleartext class instances — decrypt encrypted specs at
 * the perimeter (resolveSpec) before calling. Call only when a previous spec
 * exists (first registration is unconstrained).
 *
 * @param {object} priorSpec - previous confirmed spec (cleartext)
 * @param {object} newSpec - incoming update spec (cleartext)
 * @throws {ValidationError} naming the immutable field that changed
 */
async function assertUpdateInvariants(priorSpec, newSpec) {
  const { assertUpdateInvariants: impl } = await getSpecBackend();
  impl(priorSpec, newSpec);
}

module.exports = {
  getSpec,
  getSpecBackend,
  getSpecPolicy,
  validateSubmissionSpec,
  validateGossipSpec,
  assertUpdateInvariants,
};
