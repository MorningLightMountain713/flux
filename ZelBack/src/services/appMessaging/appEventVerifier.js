const config = require('config');
const { getSpec, getSpecBackend } = require('../utils/specLibs');
const signatureVerifier = require('../signatureVerifier');
const benchmarkService = require('../benchmarkService');
const { ARCANE_ATTESTATION_PUBKEY, verifyAttestationSignature } = require('../utils/arcaneAttestation');
const { getChainTeamSupportAddressUpdates } = require('../utils/chainUtilities');

async function deserializeMessage(message) {
  const { AppEventLegacy, ConfirmedAppEvent } = await getSpecBackend();
  if (message.version === 2) {
    return ConfirmedAppEvent.deserialize(message);
  }
  return AppEventLegacy.deserialize(message);
}

async function deserializeTempMessage(message) {
  const { AppEventLegacy, SignedAppEvent } = await getSpecBackend();
  if (message.version === 2) {
    return SignedAppEvent.deserialize(message);
  }
  return AppEventLegacy.deserialize(message);
}

async function verifyFn(payload, address, signature) {
  return signatureVerifier.verifySignature(payload, address, signature);
}

function isMarketplaceApp(appName) {
  if (!appName) return false;
  const nums = appName.match(/\d+/g);
  if (!nums) return false;
  const epoch2020 = Date.parse('2020-01-01');
  return nums.some((n) => Number(n) > epoch2020);
}

function resolveTeamSupportAddress(daemonHeight) {
  const intervals = getChainTeamSupportAddressUpdates().filter(
    (entry) => entry.height <= daemonHeight,
  );
  if (intervals.length === 0) return null;
  return intervals[intervals.length - 1].address;
}

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
 * Request an arcane attestation from the local SAS for an encrypted spec.
 *
 * Signs the domain-separated attestation message over the spec's contentHash,
 * proving a genuine SAS instance processed this content. Only the originating
 * Arcane node calls this; relayers carry the attestation as-is. Throws on SAS
 * failure — this is our own broadcast, so the submission should fail loudly
 * rather than broadcast an unattested encrypted spec.
 *
 * @param {string} contentHash
 * @returns {Promise<string>} base64 Ed25519 signature
 */
async function requestAttestation(contentHash) {
  const backend = await getSpecBackend();
  const message = backend.buildArcaneAttestMessage(contentHash);
  const response = await benchmarkService.attest({ message });
  if (response.status !== 'success' || !response.data || !response.data.signature) {
    const detail = (response.data && response.data.message) || response.data || 'unknown error';
    throw new Error(`Failed to obtain arcane attestation: ${detail}`);
  }
  return response.data.signature;
}

/**
 * Verify an event's arcane attestation against the network attestation key.
 *
 * Local-only (hardcoded public key + node:crypto), so any node — Arcane or not —
 * can verify without a SAS.
 *
 * @param {object} appEvent - SignedAppEvent or ConfirmedAppEvent
 * @returns {boolean}
 */
function verifyAttestation(appEvent) {
  return appEvent.verifyArcaneAttestation(verifyAttestationSignature, ARCANE_ATTESTATION_PUBKEY);
}

async function computeOutboundHash({
  type, envelopeVersion, specBlob, contentHash, timestamp, extend, signature,
}) {
  const backend = await getSpecBackend();
  if (envelopeVersion === 2) {
    if (!contentHash) {
      throw new Error('computeOutboundHash: envelope v2 requires contentHash');
    }
    return backend.computeMessageHashV2(type, envelopeVersion, contentHash, timestamp, extend, signature);
  }
  if (!specBlob) {
    throw new Error('computeOutboundHash: envelope v1 requires specBlob');
  }
  return backend.computeMessageHash(type, envelopeVersion, specBlob, timestamp, signature);
}

module.exports = {
  deserializeMessage,
  deserializeTempMessage,
  authorize,
  requestAttestation,
  verifyAttestation,
  computeOutboundHash,
  _internal: {
    isMarketplaceApp,
    resolveTeamSupportAddress,
    verifyFn,
  },
};
