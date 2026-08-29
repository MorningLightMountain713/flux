'use strict';

// The node-down certificate store's seam into the grant plane — the two read
// paths the cancel overlay consumes, behind one registration point so the
// store and the plane stay decoupled. The node-down build calls
// registerProvider() at wiring time; until it does, the default answers are
// fail-closed — no certificate stands, nothing verifies — and the cancel
// overlay is inert rather than permissive.
//
// Verification here is COLD verification at cancellation formation: the
// provider checks the certificate's jury signatures against the membership
// its fingerprint names, inside the store's retention window. Readers past
// that window never re-verify — they adopt the published record (the
// contract's R1 clause) — so these calls are only ever made about standing,
// currently-verifiable objects, and they are synchronous like every other
// verify in this plane.

const CONTRACT = Object.freeze([
  // (outpoint) -> Promise<cert|null>: the standing certificate for a node
  'standingCertificateFor',
  // (outpoint) -> Promise<refutation|null>: the alive announcement that
  // revoked the node's last certificate — what justifies a reinstatement;
  // a certificate that merely lapsed has none and its cancellation stands
  'refutationFor',
  // (cert) -> {valid, subject}: cold verification of one certificate
  'verifyCertificate',
  // (refutation, cert) -> boolean: does the subject's alive announcement
  // supersede the certificate
  'verifyRefutation',
]);

const inert = Object.freeze({
  standingCertificateFor: async () => null,
  refutationFor: async () => null,
  verifyCertificate: () => ({ valid: false, subject: null }),
  verifyRefutation: () => false,
});

let provider = inert;

/**
 * Wire the node-down store in. The full contract or nothing: a partial
 * provider would fail open at whichever call it lacks.
 *
 * @param {object} candidate implements every CONTRACT function
 */
function registerProvider(candidate) {
  CONTRACT.forEach((name) => {
    if (typeof candidate?.[name] !== 'function') {
      throw new Error(`node-down certificate provider is missing ${name}`);
    }
  });
  provider = candidate;
}

/**
 * The standing certificate for a node, or null — consumed at acquisition
 * (the walk skip) and by cancellation formation.
 *
 * @param {string} outpoint collateral outpoint (`txhash:outidx`)
 * @returns {Promise<object|null>}
 */
async function standingCertificateFor(outpoint) {
  return provider.standingCertificateFor(outpoint);
}

/**
 * The refutation that revoked a node's last certificate, or null — what a
 * reinstatement entry publishes as its backing.
 *
 * @param {string} outpoint collateral outpoint (`txhash:outidx`)
 * @returns {Promise<object|null>}
 */
async function refutationFor(outpoint) {
  return provider.refutationFor(outpoint);
}

/**
 * The verifier pair rosterOverlay.verifyCancelChain consumes.
 *
 * @returns {{certificate: Function, refutation: Function}}
 */
function verifiers() {
  return {
    certificate: (cert) => provider.verifyCertificate(cert),
    refutation: (refutation, cert) => provider.verifyRefutation(refutation, cert),
  };
}

/** Test seam: restore the inert default. */
function resetForTests() {
  provider = inert;
}

module.exports = {
  registerProvider,
  standingCertificateFor,
  refutationFor,
  verifiers,
  resetForTests,
};
