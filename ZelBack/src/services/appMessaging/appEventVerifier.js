'use strict';

const config = require('config');
const { getSpecBackend } = require('../utils/specLibs');
const signatureVerifier = require('../signatureVerifier');
const benchmarkService = require('../benchmarkService');
const { verifyEd25519OpenSsl } = require('../utils/arcaneAttestation');
const { getChainTeamSupportAddressUpdates } = require('../utils/chainUtilities');
const { isMarketplaceApp } = require('../utils/marketplaceApps');
const { ownerChangeRaceSigner } = require('./ownerChangeRaces');
const { nodeChain } = require('../utils/nodeChain');

async function deserializeMessage(message) {
  const { ConfirmedAppEventLegacy, ConfirmedAppEvent } = await getSpecBackend();
  if (message.version === 2) {
    return ConfirmedAppEvent.deserialize(message);
  }
  return ConfirmedAppEventLegacy.deserialize(message, { chain: nodeChain() });
}

async function deserializeTempMessage(message) {
  const { SignedAppEventLegacy, SignedAppEvent } = await getSpecBackend();
  if (message.version === 2) {
    return SignedAppEvent.deserialize(message);
  }
  return SignedAppEventLegacy.deserialize(message, { chain: nodeChain() });
}

async function verifyFn(payload, address, signature) {
  return signatureVerifier.verifySignature(payload, address, signature);
}

/**
 * The verifier for one door.
 *
 * Canonical signature form is an ingress rule: a live message is held to it,
 * a message the chain already carries is not. Replaying is how a node catches
 * up, and seven messages on chain carry a signature spelling the rule refuses,
 * so a replay held to it would leave those permanently unsyncable. Only the
 * encoding rules are dropped — the signature still has to be the signer's.
 *
 * @param {boolean} allowLegacyEncoding
 * @returns {(payload: object, address: string, signature: string) => Promise<boolean>}
 */
function verifierFor(allowLegacyEncoding) {
  if (!allowLegacyEncoding) return verifyFn;
  return async (payload, address, signature) => signatureVerifier.verifySignature(
    payload, address, signature, { allowLegacyEncoding: true },
  );
}

/**
 * The support team addresses entitled to sign at a given height.
 *
 * A fork REPLACES its predecessor rather than adding to it, so only the latest
 * one active at this height names signers.
 *
 * A fork used to name one address and now names a list, and both shapes have to
 * be read: the forks already in force were written under the old one, and an
 * event is judged against the fork in force at its own block. Rewriting those
 * entries to the new shape would change which signatures the past accepts, so
 * they stay as they are and this reads either.
 *
 * @param {number} daemonHeight
 * @returns {string[]} Empty when no fork is active yet.
 */
function resolveTeamSupportAddresses(daemonHeight) {
  const intervals = getChainTeamSupportAddressUpdates().filter(
    (entry) => entry.height <= daemonHeight,
  );
  if (intervals.length === 0) return [];
  const fork = intervals[intervals.length - 1];
  if (Array.isArray(fork.addresses)) return fork.addresses.filter(Boolean);
  return fork.address ? [fork.address] : [];
}

/**
 * The addresses that may sign an expire-only update on an owner's behalf at a
 * height: the latest `usersToExtend` entry in force there, which replaces the
 * ones before it.
 *
 * @param {number} height
 * @returns {string[]}
 */
function renewalSignersAt(height) {
  const inForce = config.get('fluxapps.usersToExtend').filter((entry) => entry.height <= height);
  if (inForce.length === 0) return [];
  return inForce.reduce((latest, entry) => (entry.height >= latest.height ? entry : latest)).addresses;
}

/**
 * The addresses besides the app's owner that may sign an update at a height:
 * the signer a mined owner-change race names for this message, and the support
 * team for a marketplace app.
 *
 * @param {object} appEvent
 * @param {number} height
 * @returns {string[]}
 */
function updateSignersAt(appEvent, height) {
  const signers = [];
  const raceSigner = ownerChangeRaceSigner(appEvent.hash);
  if (raceSigner) signers.push(raceSigner);
  const teamSupport = resolveTeamSupportAddresses(height);
  if (teamSupport.length > 0 && isMarketplaceApp(appEvent.spec.name)) signers.push(...teamSupport);
  return signers;
}

/**
 * Authorize an app event against the party entitled to make it.
 *
 * Who that is — the owner a registration names, the owner an update's app
 * already has — is flux-spec's authorizeAppEvent. This supplies what only chain
 * state answers: the app as it stands (previousState, which the caller resolves
 * from the app's active registry row), the support team addresses for a
 * marketplace app, the one mined message named in ownerChangeRaces, and the
 * usersToExtend addresses that may sign a renewal.
 *
 * @param {{appEvent: object, previousState: object|null, daemonHeight: number,
 *   verifyHash?: boolean, extraSigners?: string[],
 *   allowLegacyEncoding?: boolean}} params - allowLegacyEncoding marks a
 *   replay: the message is already on chain, so it is judged by whether the
 *   signer is right, not by how the signature is spelled.
 */
async function authorize({
  appEvent, previousState, daemonHeight, verifyHash = true, extraSigners = [],
  allowLegacyEncoding = false,
}) {
  if (verifyHash) {
    const hashResult = appEvent.verifyHash();
    if (!hashResult.valid) {
      throw new Error('Invalid Flux App hash received');
    }
  }

  const { authorizeAppEvent } = await getSpecBackend();
  const result = await authorizeAppEvent(appEvent, {
    verifyFn: verifierFor(allowLegacyEncoding),
    previousState,
    extraSigners,
    updateSigners: appEvent.isUpdate ? updateSignersAt(appEvent, daemonHeight) : [],
    renewalSigners: appEvent.isUpdate ? renewalSignersAt(daemonHeight) : [],
  });
  if (result.valid) return { valid: true, signer: result.signer };

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
 * Verify an event's arcane attestation against this chain's `app` attestation key.
 *
 * Local-only (the key flux-spec holds for the chain, verified through OpenSSL),
 * so any node — Arcane or not — can verify without a secure backend.
 *
 * Async because the library's verifyArcaneAttestation is, and the caller MUST
 * await it. The result is a Promise and a Promise is truthy, so an unawaited
 * `if (!verifyAttestation(event))` is a gate that never fires — on the check
 * that decides whether an encrypted message is stored and relayed at all.
 * verifyEd25519OpenSsl itself is synchronous; awaiting a boolean is that
 * boolean.
 *
 * @param {object} appEvent - SignedAppEvent or ConfirmedAppEvent
 * @returns {Promise<boolean>}
 */
async function verifyAttestation(appEvent) {
  return appEvent.verifyArcaneAttestation(nodeChain(), { verify: verifyEd25519OpenSsl });
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
  renewalSignersAt,
  updateSignersAt,
  _internal: {
    resolveTeamSupportAddresses,
    verifyFn,
    verifierFor,
  },
};
