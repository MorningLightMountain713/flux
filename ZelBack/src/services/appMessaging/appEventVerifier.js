'use strict';

const config = require('config');
const { getSpec, getSpecBackend } = require('../utils/specLibs');
const signatureVerifier = require('../signatureVerifier');
const benchmarkService = require('../benchmarkService');
const { ARCANE_APP_ATTESTATION_PUBKEY, verifyAttestationSignature } = require('../utils/arcaneAttestation');
const { getChainTeamSupportAddressUpdates } = require('../utils/chainUtilities');
const { ownerChangeRaceSigner } = require('./ownerChangeRaces');

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

/**
 * Authorize an app event against the party entitled to make it.
 *
 * A registration is self-signed: the spec names its owner and that owner signs
 * it, because nothing precedes it. An update is signed by the owner the app
 * ALREADY has — carried on previousState, which the caller resolves from the
 * app's active registry row. The owner named in an incoming update is a claim
 * about where ownership is going, never the authority for the change: honouring
 * it would let anyone take over any app by naming themselves and signing.
 * A transfer is therefore the outgoing owner signing a spec that names the
 * incoming one.
 *
 * One mined message predates update re-verification and cannot satisfy that
 * rule; it is named, with its signer, in ownerChangeRaces.
 *
 * @param {{appEvent: object, previousState: object|null, daemonHeight: number,
 *   verifyHash?: boolean, extraSigners?: string[]}} params
 */
async function authorize({
  appEvent, previousState, daemonHeight, verifyHash = true, extraSigners = [],
}) {
  if (verifyHash) {
    const hashResult = appEvent.verifyHash();
    if (!hashResult.valid) {
      throw new Error('Invalid Flux App hash received');
    }
  }

  const signers = [...extraSigners];

  if (appEvent.isUpdate) {
    if (!previousState || !previousState.owner) {
      throw new Error(
        `Flux App ${appEvent.spec.name} update cannot be authorized: no registration to update`,
      );
    }
    signers.push(previousState.owner);
    const raceSigner = ownerChangeRaceSigner(appEvent.hash);
    if (raceSigner) {
      signers.push(raceSigner);
    }
    const teamSupport = resolveTeamSupportAddress(daemonHeight);
    if (teamSupport && isMarketplaceApp(appEvent.spec.name)) {
      signers.push(teamSupport);
    }
  } else {
    signers.push(appEvent.spec.owner);
  }

  let result = await appEvent.verifySignature(verifyFn, signers);
  if (result.valid) return result;

  if (appEvent.isUpdate) {
    // usersToExtend (subscription-renewal) signers may authorize a renewal whose
    // content is unchanged. The event encapsulates the per-version assessment
    // (v9: extend flag + contentHash; v1-8: spec compare, decrypting enterprise
    // specs where the node can) — see flux-spec assessRenewal / extensionSignerPermitted.
    const { UpdatePolicy } = await getSpec();
    const verdict = await appEvent.assessRenewal(previousState);
    if (UpdatePolicy.extensionSignerPermitted(verdict)) {
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
 * Request an arcane attestation from the local secure backend for an encrypted spec.
 *
 * Signs over the spec's contentHash AND a hash of the sealed wire form, proving
 * a genuine secure backend both validated this content and produced these bytes.
 * The second half is what a non-Arcane node can actually check: it cannot
 * decrypt, so contentHash alone tells it nothing about the envelope in its hand.
 *
 * Sent as a payload with no domain — the backend prefixes it under the `app`
 * purpose and signs with that purpose's own key, so the caller cannot mint bytes
 * shaped like another protocol's message.
 *
 * Only the originating Arcane node calls this; relayers carry the attestation
 * as-is. Throws on backend failure — this is our own broadcast, so the
 * submission should fail loudly rather than broadcast an unattested encrypted
 * spec.
 *
 * @param {string} contentHash
 * @param {object} specBlob - the sealed wire form being broadcast
 * @returns {Promise<string>} base64 Ed25519 signature
 */
async function requestAttestation(contentHash, specBlob) {
  const backend = await getSpecBackend();
  const message = backend.buildArcaneAttestPayload(
    contentHash,
    backend.envelopeHash(specBlob),
  );
  const response = await benchmarkService.attest({
    message,
    purpose: backend.ARCANE_ATTEST_PURPOSE,
  });
  // A successful benchmark reply rides as a JSON string in data (the same shape
  // contentBlobService unwraps); parse it before reading the signature.
  const ok = response && response.status === 'success';
  const data = ok && typeof response.data === 'string' ? JSON.parse(response.data) : response && response.data;
  if (!ok || !data || !data.signature) {
    const detail = (data && data.message) || (response && response.data) || 'unknown error';
    throw new Error(`Failed to obtain arcane attestation: ${detail}`);
  }
  return data.signature;
}

/**
 * Verify an event's arcane attestation against the network attestation key.
 *
 * Local-only (hardcoded public key + node:crypto), so any node — Arcane or not —
 * can verify without a secure backend.
 *
 * @param {object} appEvent - SignedAppEvent or ConfirmedAppEvent
 * @returns {boolean}
 */
function verifyAttestation(appEvent) {
  return appEvent.verifyArcaneAttestation(verifyAttestationSignature, ARCANE_APP_ATTESTATION_PUBKEY);
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
