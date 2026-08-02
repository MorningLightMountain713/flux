const log = require('../../lib/log');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const fluxBroadcastHelper = require('../utils/fluxBroadcastHelper');
const { getSpecBackend } = require('../utils/specLibs');
const appsRepository = require('../appDatabase/appsRepository');
const fluxEventBus = require('../utils/fluxEventBus');
const ingressEncryptionKey = require('../utils/ingressEncryptionKey');
const ingressCapture = require('../utils/ingressCapture');

// Wire message type for the standalone ingress-attestation gossip.
const INGRESS_ATTESTATION_TYPE = 'fluxappingress';

// An attestation naming a message this node does not hold cannot be judged yet, so it is
// held quarantined under this TTL and self-reaps unless the message confirms first.
// Matches the content-manifest quarantine window, so both planes expire in lockstep.
const QUARANTINE_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Build and sign this node's attestation for a submission. Returns null if the
 * source address cannot be determined (nothing meaningful to attest).
 *
 * The observed source and asserted headers are sealed to the fluxteam key before
 * signing, so the record carries only ciphertext; the node signs over that
 * envelope, binding the attestation to the exact sealed bytes.
 */
async function build(hash, req) {
  const { buildIngressAttestMessage, seal } = await getSpecBackend();

  const { observed, asserted } = await ingressCapture.captureIngress(req);
  if (!observed.ip) return null;

  const { kid, publicKey } = ingressEncryptionKey.current();
  const sealed = seal(JSON.stringify({ observed, asserted }), publicKey, { kid });

  const observedAt = Date.now();
  const node = await fluxNetworkHelper.getFluxNodePublicKey();
  const payload = buildIngressAttestMessage({
    hash, observedAt, node, sealed,
  });
  const signature = await fluxBroadcastHelper.getFluxMessageSignature(payload);

  return {
    hash, observedAt, node, sealed, signature,
  };
}

/**
 * Store an attestation with the right durability, by one rule for every source: an
 * attestation for a message this node holds persists, one for a message it does not is
 * quarantined under a TTL and self-reaps unless the message confirms first — at which
 * point confirmIngressAttestations promotes it.
 *
 * A sync backfill used to file records as confirmed outright, on the grounds that the
 * responder only serves confirmed messages, because quarantining them kept them out of
 * this node's reconcile digest and the peer that served them would re-offer them every
 * round. That is fixed at the digest instead: it now counts everything held, quarantined
 * included, so quarantining converges and a peer's word is no longer load-bearing.
 *
 * @returns {Promise<{ inserted: boolean }>}
 */
async function persist(record) {
  const permanent = await appsRepository.getPermanentMessage(record.hash);
  const expireAt = permanent ? null : Date.now() + QUARANTINE_TTL_MS;
  const result = await appsRepository.storeIngressAttestation(record, expireAt);
  // Test-only observability (no-op in prod): a newly stored attestation — whether from
  // this node's own ingress, live gossip, or a sync backfill — is the single point every
  // path funnels through, so the e2e harness can event-drive on attestation propagation.
  // The source is sealed, so the event carries the sealing key id, not the address.
  if (result.inserted) {
    fluxEventBus.publish('network:ingressattestation', {
      hash: record.hash,
      node: record.node,
      kid: record.sealed && record.sealed.kid,
    });
  }
  return result;
}

/**
 * Record and gossip where a register/update entered the network. Best-effort:
 * attribution must never fail the submission, so all errors are swallowed.
 * @param {string} hash - the app-message hash
 * @param {import('express').Request} req - the ingress HTTP request
 */
async function emit(hash, req) {
  try {
    if (!hash || !req) return;
    const record = await build(hash, req);
    if (!record) return;

    await persist(record);

    // Lazy require: fluxCommunicationMessagesSender forms a load-time cycle.
    // eslint-disable-next-line global-require
    const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');
    await fluxCommunicationMessagesSender.broadcastIngressAttestation(record);
  } catch (err) {
    log.error(`ingressAttestation emit failed for ${hash}: ${err.message}`);
  }
}

/**
 * Validate, verify, and store an attestation received from a peer. Live gossip and sync
 * backfill take the same path — durability is always derived from local message state,
 * never from where the record came from.
 * @param {object} data - the inbound message payload
 * @returns {Promise<{ rebroadcast: boolean, record: object }|Error>} rebroadcast
 *   is true only on first store, so the flood terminates.
 */
async function receive(data) {
  const { IngressAttestation, verifySignature } = await getSpecBackend();

  let attestation;
  try {
    attestation = IngressAttestation.deserialize(data);
  } catch (err) {
    return new Error(`malformed ingress attestation: ${err.message}`);
  }

  const valid = await attestation.verify(verifySignature);
  if (!valid) {
    return new Error(`ingress attestation for ${attestation.hash} failed signature verification`);
  }

  const record = attestation.serialize();
  const { inserted } = await persist(record);
  return { rebroadcast: inserted, record };
}

module.exports = {
  emit,
  receive,
  INGRESS_ATTESTATION_TYPE,
};
