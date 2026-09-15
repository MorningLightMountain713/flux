'use strict';

/**
 * What this build understands, advertised at the handshake.
 *
 * A capability is how two nodes on different releases agree which form of
 * something to use, so a peer is sent - and held to - what it advertised,
 * never what its version implies. Adding a name here is what makes a new
 * behaviour reachable; removing one retires the old form for everybody.
 *
 * Declared apart from the socket so the harness can enumerate it: suite 121
 * drives its matrix off this list, and a capability added without a case is a
 * failing suite rather than a gap nobody notices.
 */
const FLUX_CAPABILITIES = Object.freeze([
  'transmissionTimestamps',
  'peerExchange',
  'binaryMessages',
  'appStateSync',
  // This build answers a state-sync request it cannot usefully serve with a
  // refusal, instead of an empty batch that reads as a completed survey. A peer
  // that does not claim it cannot tell us it knows nothing, so it is still held
  // to the uptime proxy - see getEligibleSyncPeers.
  'appStateSyncRefusal',
  'appInstallingClaims',
  'limitCounterRecords',
  'masterlease',
  // This build signs a sync request over a domain-separated payload, where the
  // field boundaries are in the encoding rather than in the values. A peer that
  // does not claim it is sent, and held to, the run-together form.
  'syncSigV2',
  // This build speaks the policy bundle protocol - it answers fluxpolicyrequest and
  // understands an adoption announcement. A peer that does not claim it is not a quiet
  // participant, it is not a participant: asking it spends a window waiting for a reply
  // that cannot come, and announcing to it logs an unrecognised type on its side.
  'policyBundle',
]);

module.exports = { FLUX_CAPABILITIES };
