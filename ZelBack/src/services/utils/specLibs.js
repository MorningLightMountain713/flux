'use strict';

const { load, CONTRACT_VERSION } = require('@runonflux/flux-spec-cjs');
const { nodeChain, specActivationHeights } = require('./nodeChain');

// The lowest flux-spec surface this FluxOS can run against. Raise it in the same change
// that starts calling an export added by a later flux-spec release.
//
// The copy installed on a node can be older than the code reading it, while every dev
// checkout — on a `file:` dep resolving to the working tree — is current. Destructuring
// an absent export then yields undefined and fails far away as "<name> is not a
// function"; in the signature verifier that reads to every caller as "Invalid
// signature".
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
 * Refuse a spec version the chain has not activated yet.
 *
 * Enforcement heights are chain policy, so they stay here rather than in
 * flux-spec. Split out because a DECRYPTED spec is validated through
 * `OpenedSpec.validateContents()` — which deliberately produces no
 * blob, so it cannot be routed through validateSubmissionSpec — and the height
 * gate still has to apply to it.
 *
 * @param {number} version
 * @param {number} [height] - current daemon height; undefined skips the gate
 * @throws {Error} if the version is unknown or not yet activated
 */
function assertVersionActivated(version, height) {
  if (height === undefined) return;
  const activationHeight = specActivationHeights()[version];
  if (activationHeight === undefined) {
    throw new Error(`Unsupported Flux App specification version: ${version}`);
  }
  if (height < activationHeight) {
    throw new Error(`Flux apps specifications of version ${version} not yet supported`);
  }
}

/**
 * Validate a submission-shape spec blob through the appropriate version
 * class, optionally enforcing FluxOS fork-activation height gates.
 *
 * @param {object} spec - Submission blob
 * @param {object} [options]
 * @param {number} [options.height] - the height the submission is judged at:
 *   the version-activation gate here, and the rules a legacy version gates by
 *   height in the class
 * @param {string} [options.purpose] - Which question is being asked
 *   (a flux-spec ValidationPurpose value; default registration, the strict
 *   one). The spec library refuses unknown purposes at the door.
 * @returns {Promise<FluxAppSpecBase>} The validated spec class instance; fields
 *   that must never travel in the clear are refused under REGISTRATION (a
 *   private spec is validated by validatePrivateSubmission)
 */
async function validateSubmissionSpec(spec, { height, purpose } = {}) {
  await getSpecBackend();
  const { FluxAppSpecBase } = await getSpec();
  const VersionClass = spec && FluxAppSpecBase.getVersionClass(spec.version);
  if (!VersionClass) {
    throw new Error(`Unsupported Flux App specification version: ${spec && spec.version}`);
  }
  assertVersionActivated(spec.version, height);
  const context = {};
  if (purpose !== undefined) context.purpose = purpose;
  if (height !== undefined) context.height = height;
  return VersionClass.fromSubmission(spec, { ...context, chain: nodeChain() });
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

/**
 * Validate a private submission — the cleartext a transport envelope opened
 * to — as flux-spec's private door does, enforcing the FluxOS fork-activation
 * height gate. What comes back is an OpenedSpec: readable, with no wire form,
 * so the contents reach bytes only sealed (sealForStorage).
 *
 * @param {object} spec - the opened submission blob
 * @param {{height?: number}} [options] - the height the submission is judged at
 * @returns {Promise<object>} an OpenedSpec
 */
async function validatePrivateSubmission(spec, { height } = {}) {
  const { OpenedSpec } = await getSpecBackend();
  assertVersionActivated(spec && spec.version, height);
  const context = { chain: nodeChain() };
  if (height !== undefined) context.height = height;
  return OpenedSpec.fromSubmission(spec, context);
}

module.exports = {
  getSpec,
  assertVersionActivated,
  getSpecBackend,
  getSpecPolicy,
  validateSubmissionSpec,
  validatePrivateSubmission,
  assertUpdateInvariants,
};
