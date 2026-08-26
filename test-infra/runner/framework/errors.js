'use strict';

/**
 * "The thing you named is not there RIGHT NOW."
 *
 * A wait predicate that reaches for a resource has two ways to fail, and they mean
 * opposite things: the resource is absent because the fleet has not got there yet
 * (keep waiting — that IS the wait's job), or something is broken (stop now, and
 * say what). A plain Error cannot tell them apart, so `waitFor` had to treat every
 * throw as fatal, and every suite that waited across a legitimate absence hand-wrote
 * its own guard. Twenty-five wait predicates across twelve suites were one transient
 * away from aborting mid-convergence, and one of them — 1106's SRV wait, over a
 * container the drift-rebuild engine was recreating — did exactly that in gate 8,
 * eight seconds into a sixty-second window, on a fleet that then converged fine.
 *
 * So the helper that KNOWS the difference declares it, once, instead of each caller
 * guessing. `waitFor` retries this class and only this class; everything else still
 * aborts the wait immediately, with its own message, exactly as before.
 *
 * It remains a real Error everywhere else. Outside a wait — in an assertion, in a
 * setup step — it throws and fails the test like any other, which is what an
 * assertion about a resource that must exist should do.
 *
 * Reserve it for a RUNTIME absence that a later poll could legitimately resolve.
 * NOT for a missing fixture binary, an unvendored pin or a bad argument: those never
 * become present by waiting, and retrying them turns an instant, named failure into
 * a silent timeout.
 */
export class NotPresentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotPresentError';
  }
}
