/**
 * FluxOS-side bridges for the v9 migration.
 *
 * Two shapes show up in FluxOS:
 *   - Class instances (FluxAppSpec*, EncryptedSpec*) — what flux-spec returns.
 *   - Plain objects — what legacy consumers (docker, syncthing, parts of
 *     advancedWorkflows/appInstaller/etc.) still take. The wire format, DB
 *     docs, and most gossip payloads are also plain objects.
 *
 * These helpers bridge the two during the 3.5 cutover. They are NOT the
 * class-first API — that lives in `@runonflux/flux-spec*` directly. New
 * callers should prefer:
 *
 *   const wireSpec = await deserializeSpec(plainSpec);
 *   if (wireSpec instanceof EncryptedSpecBase) {
 *     const provider = await legacyCryptoProvider.create(wireSpec.name, wireSpec.owner);
 *     const decrypted = await wireSpec.decrypt(provider);     // ← boundary
 *     // use decrypted.spec (cleartext class instance)
 *   }
 *
 * The DecryptedCanonicalSpec wrapper + explicit .spec access is the
 * contract that makes the cleartext crossing visible. Hiding that dance
 * in a helper (the previous `resolve()` / `loadSpec` shape) is not what
 * this file does — the helpers below only cover plain→plain adapters for
 * legacy consumers that work with plain objects on both sides.
 */

const { getSpec, getSpecBackend } = require('./specLibs');
const legacyCryptoProvider = require('../providers/FluxOSLegacyCryptoProvider');

/**
 * Deserialize a plain-object wire-form spec blob into its class instance.
 *
 * Thin async wrapper over flux-spec-backend's `deserializeSpec` dispatch.
 * Returns either a cleartext `FluxAppSpecBase` subclass or an
 * `EncryptedSpecBase` subclass depending on wire shape.
 *
 * @param {object} plainSpec
 * @returns {Promise<import('@runonflux/flux-spec').FluxAppSpecBase | import('@runonflux/flux-spec-backend').EncryptedSpecBase>}
 */
async function deserializeSpec(plainSpec) {
  await getSpec();
  const { deserializeSpec: impl } = await getSpecBackend();
  return impl(plainSpec);
}

/**
 * Normalize a plain-object wire-form spec to its canonical plain-object
 * form via the class. Rejects malformed specs via ValidationError
 * instead of silently coercing. No encryption concern
 * — operates on whatever wire shape was passed in.
 *
 * @param {object} plainSpec
 * @returns {Promise<object>}
 */
async function toCanonicalSpec(plainSpec) {
  const spec = await deserializeSpec(plainSpec);
  return spec.serialize();
}

/**
 * Plain→plain adapter for legacy consumers: decrypt a v8 enterprise wire
 * blob to cleartext plain form. Non-encrypted wire forms pass through.
 *
 * Internals — this crosses the cleartext boundary:
 *   1. deserializeSpec → EncryptedSpecV8
 *   2. .decrypt(provider) → DecryptedCanonicalSpec (the flux-spec safety wrapper)
 *   3. .spec → cleartext FluxAppSpecV8 instance
 *   4. .serialize() → plain cleartext wire form
 *
 * The enterprise blob from the input is reattached so callers that
 * re-broadcast the wire form keep the ciphertext intact.
 *
 * Prefer the class-instance pattern in new code — this helper exists
 * only as a bridge for legacy consumers that still take plain shape.
 *
 * @param {object} plainSpec
 * @returns {Promise<object>}
 */
async function decryptIfEnterprise(plainSpec) {
  if (!plainSpec) return plainSpec;
  const wireSpec = await deserializeSpec(plainSpec);
  const { EncryptedSpecBase } = await getSpecBackend();
  if (!(wireSpec instanceof EncryptedSpecBase)) return plainSpec;

  const provider = await legacyCryptoProvider.create(wireSpec.name, wireSpec.owner);
  const decrypted = await wireSpec.decrypt(provider);
  const cleartext = decrypted.spec.serialize();
  cleartext.enterprise = plainSpec.enterprise;
  return cleartext;
}

/**
 * Plain→class adapter for cleartext consumers: hydrate a plain-object
 * wire form and, if the wire form is encrypted, CROSS THE CLEARTEXT
 * BOUNDARY to yield a cleartext class instance.
 *
 * Internals:
 *   1. deserializeSpec → EncryptedSpec* or cleartext FluxAppSpec*
 *   2. If encrypted: .decrypt(provider) → DecryptedCanonicalSpec, then
 *      .spec → cleartext class (explicit wrapper unwrap).
 *
 * Callers that do NOT need cleartext components (e.g. storing the wire
 * form, checking metadata like name/owner) should use `deserializeSpec`
 * directly and branch with `instanceof EncryptedSpecBase`. This helper
 * is specifically for the case "I need a cleartext class instance to
 * pass to a class-first helper (appPricePerMonth, DeploymentSpec,
 * etc.)".
 *
 * @param {object} plainSpec
 * @returns {Promise<import('@runonflux/flux-spec').FluxAppSpecBase>} cleartext class instance
 */
async function decryptToCleartextClass(plainSpec) {
  const wireSpec = await deserializeSpec(plainSpec);
  const { EncryptedSpecBase } = await getSpecBackend();
  if (!(wireSpec instanceof EncryptedSpecBase)) return wireSpec;
  const provider = await legacyCryptoProvider.create(wireSpec.name, wireSpec.owner);
  const decrypted = await wireSpec.decrypt(provider);
  return decrypted.spec;
}

module.exports = {
  deserializeSpec,
  toCanonicalSpec,
  decryptIfEnterprise,
  decryptToCleartextClass,
};
