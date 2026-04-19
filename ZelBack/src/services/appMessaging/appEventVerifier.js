/**
 * FluxOS authority policy for app-event signature verification.
 *
 * The @runonflux/flux-spec-backend `AppEventV1.verifySignature(verifyFn, signers)`
 * iterates serializations × signers and returns the first match. It does
 * not know who is authorized to sign — that policy lives here, in FluxOS.
 *
 * Authority rules (preserves pre-v9 semantics):
 *   - Registration: spec owner signs.
 *   - Update: spec owner signs. Previous owner signs (ownership transfer).
 *     Team-support address signs (marketplace apps only — app name must
 *     encode a post-2020 epoch timestamp — AND only after the team-support
 *     address is effective at the current daemon height).
 *   - Expire-only update (TTL change, nothing else): any usersToExtend
 *     config address may sign.
 *
 * This module also hosts `deserializeMessage()` which dispatches on the
 * envelope `version` field to the right AppEvent subclass.
 */

const config = require('config');
const { getSpec, getSpecBackend } = require('../utils/specLibs');
const signatureVerifier = require('../signatureVerifier');
const { getChainTeamSupportAddressUpdates } = require('../utils/chainUtilities');

/**
 * Deserialize an incoming wire message into the right AppEvent subclass.
 *
 * Envelope version 1 → AppEventV1 (wraps v1-v8 specs).
 * Envelope version 2 → AppEventV2 (wraps v9+ specs).
 *
 * The deserialize call validates the spec body via its version class's
 * `deserialize()` — throws if the body is malformed or references a
 * spec version with no registered class.
 *
 * @param {object} message - wire message
 * @returns {Promise<object>} AppEventV1 or AppEventV2 instance
 * @throws {Error} if the envelope or spec body is invalid
 */
async function deserializeMessage(message) {
  const { AppEventV1, AppEventV2 } = await getSpecBackend();
  if (message.version === 2) {
    return AppEventV2.deserialize(message);
  }
  return AppEventV1.deserialize(message);
}

/**
 * Async wrapper over signatureVerifier.verifySignature to satisfy the
 * AppEvent.verifySignature `verifyFn` contract — (message, address, signature) → Promise<boolean>.
 */
async function verifyFn(payload, address, signature) {
  return signatureVerifier.verifySignature(payload, address, signature);
}

/**
 * Detect "marketplace app" by the convention that marketplace-registered
 * apps encode a post-2020 Unix epoch timestamp in their name (matches the
 * rule in the pre-v9 verifyAppMessageUpdateSignature at messageVerifier.js).
 *
 * @param {string} appName
 * @returns {boolean}
 */
function isMarketplaceApp(appName) {
  if (!appName) return false;
  const nums = appName.match(/\d+/g);
  if (!nums) return false;
  const epoch2020 = Date.parse('2020-01-01');
  return nums.some((n) => Number(n) > epoch2020);
}

/**
 * Resolve the currently-effective team-support address at a given daemon
 * height. The team-support address moves through forks via
 * config.fluxapps.teamSupportAddress entries — see
 * chainUtilities.getChainTeamSupportAddressUpdates.
 *
 * @param {number} daemonHeight
 * @returns {string|null}
 */
function resolveTeamSupportAddress(daemonHeight) {
  const intervals = getChainTeamSupportAddressUpdates().filter(
    (entry) => entry.height <= daemonHeight,
  );
  if (intervals.length === 0) return null;
  return intervals[intervals.length - 1].address;
}

/**
 * Deserialize a raw previous-spec DB document into a spec class instance,
 * needed for UpdatePolicy.isTtlOnlyUpdate which requires base-interface getters.
 *
 * @param {object} rawSpec - previousAppSpecs from advancedWorkflows.getPreviousAppSpecifications
 * @returns {Promise<object|null>} spec class instance, or null if input is null/malformed
 */
async function instantiatePreviousSpec(rawSpec) {
  if (!rawSpec || typeof rawSpec.version !== 'number') return null;
  // Force v1-v8 class registration by loading spec-backend. v9 is
  // registered by loading spec. FluxAppSpecBase.getVersionClass resolves
  // from a single shared registry populated by both package loads.
  await getSpecBackend();
  const { FluxAppSpecBase } = await getSpec();
  const VersionClass = FluxAppSpecBase.getVersionClass(rawSpec.version);
  if (!VersionClass) return null;
  return VersionClass.deserialize(rawSpec);
}

/**
 * Verify hash and signature on an incoming AppEvent against FluxOS's
 * authority policy. Throws on invalid hash or unauthorized signer.
 *
 * Signature verification runs in two passes:
 *   Pass 1: [owner, previousOwner (if different), teamSupport (if marketplace + height-gated)]
 *   Pass 2 (only if 1 fails AND update is TTL-only): [usersToExtend...]
 *
 * @param {object} params
 * @param {object} params.appEvent - AppEventV1 or AppEventV2 instance
 * @param {object|null} [params.previousSpec] - previous-spec class instance (for updates)
 * @param {number} params.daemonHeight
 * @returns {Promise<{valid: true, signer: string}>}
 * @throws {Error} on hash or signature failure
 */
async function authorize({
  appEvent, previousSpec, daemonHeight, verifyHash = true,
}) {
  if (verifyHash) {
    const hashResult = appEvent.verifyHash();
    if (!hashResult.valid) {
      throw new Error('Invalid Flux App hash received');
    }
  }

  const signers = [appEvent.spec.owner];

  if (appEvent.isUpdate && previousSpec) {
    if (previousSpec.owner && previousSpec.owner !== appEvent.spec.owner) {
      signers.push(previousSpec.owner);
    }
    const teamSupport = resolveTeamSupportAddress(daemonHeight);
    if (teamSupport && isMarketplaceApp(appEvent.spec.name)) {
      signers.push(teamSupport);
    }
  }

  let result = await appEvent.verifySignature(verifyFn, signers);
  if (result.valid) return result;

  // Expire-only fallback: usersToExtend addresses are authorized to sign
  // when the update changes nothing except TTL/expire.
  if (appEvent.isUpdate && previousSpec) {
    const { UpdatePolicy } = await getSpec();
    if (UpdatePolicy.isTtlOnlyUpdate(previousSpec, appEvent.spec)) {
      const usersToExtend = (config.fluxapps && config.fluxapps.usersToExtend) || [];
      if (usersToExtend.length > 0) {
        result = await appEvent.verifySignature(verifyFn, usersToExtend);
        if (result.valid) return result;
      }
    }
  }

  throw new Error(
    'Received signature does not correspond with Flux App owner or Flux App specifications are not properly formatted',
  );
}

/**
 * Compute the wire-format message hash for a freshly-signed submission.
 *
 * Envelope v1 (v1-v8 specs): SHA-256(type + envVer + JSON.stringify(specBlob) + ts + sig)
 * Envelope v2 (v9 specs):   SHA-256(type + envVer + contentHash + ts + sig)
 *
 * The receiving-side AppEvent.verifyHash() recomputes this value and
 * compares byte-for-byte, so the caller must pass the same `specBlob`
 * shape that will ride on the wire (for enterprise apps today, that's
 * the stripped form with empty compose/contacts — see registryManager's
 * enterprise branch).
 *
 * @param {object} params
 * @param {string} params.type - "fluxappregister" | "fluxappupdate" (or legacy zel*)
 * @param {number} params.envelopeVersion - 1 for v1-v8, 2 for v9
 * @param {object} [params.specBlob] - required for envelope v1
 * @param {string} [params.contentHash] - required for envelope v2
 * @param {number} params.timestamp
 * @param {string} params.signature
 * @returns {Promise<string>} hex-encoded SHA-256 digest
 */
async function computeOutboundHash({
  type, envelopeVersion, specBlob, contentHash, timestamp, signature,
}) {
  const backend = await getSpecBackend();
  if (envelopeVersion === 2) {
    if (!contentHash) {
      throw new Error('computeOutboundHash: envelope v2 requires contentHash');
    }
    return backend.computeMessageHashV2(type, envelopeVersion, contentHash, timestamp, signature);
  }
  if (!specBlob) {
    throw new Error('computeOutboundHash: envelope v1 requires specBlob');
  }
  return backend.computeMessageHash(type, envelopeVersion, specBlob, timestamp, signature);
}

module.exports = {
  deserializeMessage,
  authorize,
  instantiatePreviousSpec,
  computeOutboundHash,
  _internal: {
    isMarketplaceApp,
    resolveTeamSupportAddress,
    verifyFn,
  },
};
