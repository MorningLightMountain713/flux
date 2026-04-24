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
const log = require('../../lib/log');

/**
 * Deserialize a plain-object wire-form spec blob into its class instance.
 *
 * Returns either a cleartext `FluxAppSpecBase` subclass, an
 * `EncryptedSpecBase` subclass, or `null` if the blob cannot be parsed
 * (unknown version, malformed fields, etc.). Logs a warning on failure
 * so callers don't need per-site `.catch(() => null)` boilerplate.
 *
 * @param {object} plainSpec
 * @returns {Promise<import('@runonflux/flux-spec').FluxAppSpecBase | import('@runonflux/flux-spec-backend').EncryptedSpecBase | null>}
 */
async function deserializeSpec(plainSpec) {
  try {
    await getSpec();
    const { deserializeSpec: impl } = await getSpecBackend();
    return impl(plainSpec);
  } catch (error) {
    const name = plainSpec?.name || 'unknown';
    const version = plainSpec?.version ?? '?';
    log.warn(`deserializeSpec: could not parse spec ${name} (v${version}): ${error.message}`);
    return null;
  }
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
 * directly and branch on `.isEncrypted`. This helper is for the case
 * "I need a cleartext class instance to pass to a class-first helper
 * (appPricePerMonth, DeploymentSpec, etc.)".
 *
 * @param {object} plainSpec
 * @returns {Promise<import('@runonflux/flux-spec').FluxAppSpecBase>} cleartext class instance
 */
async function decryptToCleartextClass(plainSpec) {
  const wireSpec = await deserializeSpec(plainSpec);
  if (!wireSpec || !wireSpec.isEncrypted) return wireSpec;
  try {
    const provider = await legacyCryptoProvider.create(wireSpec.name, wireSpec.owner);
    const decrypted = await wireSpec.decrypt(provider);
    return decrypted.spec;
  } catch (error) {
    const name = wireSpec.name || 'unknown';
    log.warn(`decryptToCleartextClass: could not decrypt ${name}: ${error.message}`);
    return null;
  }
}

module.exports = {
  deserializeSpec,
  toCanonicalSpec,
  decryptToCleartextClass,
};
