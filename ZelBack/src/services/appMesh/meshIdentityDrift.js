'use strict';

// The seam between the mesh reconciler (which resolves ordinal slots) and the
// app reconciler (which owns container rebuilds): a registry of components
// whose container was created under one mesh identity but whose resolved slot
// now names another — a standby promoted after boot, or a lost double-claim
// arbitration. Identity is fixed for a container's lifetime, so the cure is a
// deliberate remove-and-recreate, and that belongs to the app reconciler's
// heal discipline, not the mesh pass.
//
// Deliberately dependency-free: the mesh reconciler writes after each pass,
// the app reconciler reads per reconcile, and neither pulls the other's tree
// (the mesh tree is already downstream of the reconciler's via the
// provisioner, so a direct require either way would close a cycle).
//
// A drift must survive TWO consecutive mesh passes before it is served: the
// slot resolution is deterministic, but a single pass can observe
// mid-convergence gossip, and the consumer's next step is destructive.

/** identifier → the `wants` identity seen last pass, awaiting confirmation */
let pending = new Map();
/** identifier → { component, is, wants } confirmed across two passes */
let stable = new Map();

/**
 * Record one mesh pass's complete drift observation (every drifted container
 * across every mesh app — a container absent from the map has no drift, so
 * resolved and departed entries drop out naturally). Returns the identifiers
 * that just became stable, for the caller to enqueue.
 *
 * @param {Map<string, {component: string, is: string, wants: string}>} drifts
 * @returns {string[]} newly stable identifiers
 */
function recordPassDrifts(drifts) {
  const nextPending = new Map();
  const nextStable = new Map();
  const newlyStable = [];
  drifts.forEach((drift, identifier) => {
    const seenBefore = pending.get(identifier) === drift.wants
      || stable.get(identifier)?.wants === drift.wants;
    if (seenBefore) {
      if (!stable.has(identifier)) newlyStable.push(identifier);
      nextStable.set(identifier, drift);
    } else {
      nextPending.set(identifier, drift.wants);
    }
  });
  pending = nextPending;
  stable = nextStable;
  return newlyStable;
}

/**
 * The confirmed drift for one component, or null. Consulted by the app
 * reconciler's running branch before it decides a healthy container needs
 * nothing.
 *
 * @param {string} identifier
 * @returns {{component: string, is: string, wants: string}|null}
 */
function driftFor(identifier) {
  return stable.get(identifier) ?? null;
}

/** Test seam: forget everything. */
function reset() {
  pending = new Map();
  stable = new Map();
}

module.exports = {
  recordPassDrifts,
  driftFor,
  reset,
};
