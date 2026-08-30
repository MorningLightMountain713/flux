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
// 3: envelopeHash + the attest payload's envelope-hash argument — the
// attestation path calls both, and a contract-2 copy fails at first
// encrypted-v9 registration instead of at startup.
const REQUIRED_CONTRACT_VERSION = 3;

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
 * `DecryptedCanonicalSpec.validateContents()` — which deliberately produces no
 * blob, so it cannot be routed through validateSubmissionSpec — and the height
 * gate still has to apply to it.
 *
 * @param {number} version
 * @param {number} [height] - current daemon height; undefined skips the gate
 * @throws {Error} if the version is unknown or not yet activated
 */
function assertVersionActivated(version, height) {
  if (height === undefined) return;
  const activationHeight = config.fluxapps.appSpecsEnforcementHeights[version];
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
 * @param {number} [options.height] - Current daemon height for version gating
 * @param {string} [options.purpose] - Which question is being asked
 *   (a flux-spec ValidationPurpose value; default registration, the strict
 *   one). The spec library refuses unknown purposes at the door.
 * @returns {Promise<FluxAppSpecBase>} The validated spec class instance
 */
async function validateSubmissionSpec(spec, { height, purpose } = {}) {
  await getSpecBackend();
  const { FluxAppSpecBase } = await getSpec();
  const VersionClass = spec && FluxAppSpecBase.getVersionClass(spec.version);
  if (!VersionClass) {
    throw new Error(`Unsupported Flux App specification version: ${spec && spec.version}`);
  }
  assertVersionActivated(spec.version, height);
  return VersionClass.fromSubmission(spec, purpose === undefined ? {} : { purpose });
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
  assertVersionActivated,
  getSpecBackend,
  getSpecPolicy,
  validateSubmissionSpec,
  assertUpdateInvariants,
};
