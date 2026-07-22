const log = require('../../lib/log');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const fluxBroadcastHelper = require('../utils/fluxBroadcastHelper');
const { getSpecBackend } = require('../utils/specLibs');
const appsRepository = require('../appDatabase/appsRepository');
const fluxEventBus = require('../utils/fluxEventBus');
const ingressEncryptionKey = require('../utils/ingressEncryptionKey');

// Wire message type for the standalone ingress-attestation gossip.
const INGRESS_ATTESTATION_TYPE = 'fluxappingress';

// Attestations whose message never confirms on-chain self-reap after this
// window; confirmation clears the TTL so real registrations' attribution
// persists as long as their permanent message.
const ORPHAN_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * IPv4-mapped IPv6 (::ffff:1.2.3.4) → 1.2.3.4; a genuine IPv6 address is left
 * intact. Uses the raw socket peer, never x-forwarded-for — no trust proxy is
 * configured, so the header is client-controlled and unsafe for attribution.
 */
function normalizeIp(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  return raw.replace(/^::ffff:/, '');
}

function truncate(value, max) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
}

function captureIngress(req, caps) {
  return {
    observed: {
      ip: normalizeIp(req.socket && req.socket.remoteAddress),
      port: (req.socket && req.socket.remotePort) ?? null,
    },
    asserted: {
      userAgent: truncate(req.headers && req.headers['user-agent'], caps.USER_AGENT_MAX),
      forwardedFor: truncate(req.headers && req.headers['x-forwarded-for'], caps.FORWARDED_FOR_MAX),
    },
  };
}

/**
 * Build and sign this node's attestation for a submission. Returns null if the
 * source address cannot be determined (nothing meaningful to attest).
 *
 * The observed source and asserted headers are sealed to the fluxteam key before
 * signing, so the record carries only ciphertext; the node signs over that
 * envelope, binding the attestation to the exact sealed bytes.
 */
async function build(hash, req) {
  const {
    buildIngressAttestMessage, seal, USER_AGENT_MAX, FORWARDED_FOR_MAX,
  } = await getSpecBackend();

  const { observed, asserted } = captureIngress(req, { USER_AGENT_MAX, FORWARDED_FOR_MAX });
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
 * Store an attestation with the right durability.
 *
 * A `confirmed` record persists with no TTL and so enters the reconcile digest
 * immediately. Otherwise the durability is derived from local message state — a
 * confirmed message's attestation persists, an unconfirmed one gets the orphan TTL and
 * self-reaps if the message never confirms (cleared later by confirmIngressAttestations).
 *
 * The `confirmed` flag is set for a sync backfill: the responder only ever serves records
 * for on-chain-confirmed messages, so the message IS confirmed globally even if this node
 * has not processed it yet. Storing such a record as an orphan would keep it out of this
 * node's confirmed digest, so its digest would never match the peer that served it and it
 * would be re-fetched every refresh round until the message confirmed locally. Filing it
 * confirmed lets the digest converge on the first backfill.
 *
 * @returns {Promise<{ inserted: boolean }>}
 */
async function persist(record, { confirmed = false } = {}) {
  let expireAt = null;
  if (!confirmed) {
    const permanent = await appsRepository.getPermanentMessage(record.hash);
    expireAt = permanent ? null : Date.now() + ORPHAN_TTL_MS;
  }
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
 * @param {object} req - the ingress HTTP request
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
 * Validate, verify, and store an attestation received from a peer.
 * @param {object} data - the inbound message payload
 * @param {object} [opts]
 * @param {boolean} [opts.confirmed=false] - true for a sync backfill (the responder only
 *   serves confirmed records), so it is filed confirmed rather than re-derived from local
 *   message state. Live gossip leaves it false.
 * @returns {Promise<{ rebroadcast: boolean, record: object }|Error>} rebroadcast
 *   is true only on first store, so the flood terminates.
 */
async function receive(data, { confirmed = false } = {}) {
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
  const { inserted } = await persist(record, { confirmed });
  return { rebroadcast: inserted, record };
}

module.exports = {
  emit,
  receive,
  INGRESS_ATTESTATION_TYPE,
};
