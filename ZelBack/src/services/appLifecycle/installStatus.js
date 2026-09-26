'use strict';

/**
 * Outcome of installApplication. Separates a transient deferral (retry later) from a
 * permanent rejection and a real failure, so callers can back off appropriately.
 *
 * Its own module, with no dependencies, so a caller outside the node process (the
 * integration harness classifying `app:installOutcome`) reads the node's own values.
 */
const InstallStatus = Object.freeze({
  INSTALLED: 'installed', // installed and launched
  SKIPPED: 'skipped', // already installed - nothing to do
  DEFERRED: 'deferred', // could not decide / node busy - retry later
  REJECTED: 'rejected', // admission denied for this spec - won't change on retry
  FAILED: 'failed', // install started then errored - local cleanup already done
});

module.exports = { InstallStatus };
