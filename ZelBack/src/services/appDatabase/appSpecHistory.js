'use strict';

const appHistory = require('../appDecisions/appHistory');
const { resolveSpec } = require('../utils/specCutover');
const { getSpecBackend } = require('../utils/specLibs');

/**
 * The state of the app holding a name immediately before a block height, as
 * the chain accepted it: its latest applied message below that height,
 * hydrated into an InstantiatedSpec with the decision's term start, uuid and
 * identity, so callers get the resolved (cleartext) spec together with the
 * message's hash, height and, for v9, its contentHash (the content identity the
 * renewal authority compares against).
 *
 * This reconstructs history and is for messages already on chain: a node
 * catching up must judge a mined message against the state at the height it was
 * mined, not against the state now. Anything deciding a LIVE message reads the
 * app's active registry row instead.
 *
 * Returns null when nothing was applied below the height or the spec cannot be
 * resolved on this node.
 *
 * @param {string} name - App name
 * @param {number} height - Block height of the message being judged
 * @returns {Promise<import('@runonflux/flux-spec-backend').InstantiatedSpec|null>}
 */
async function getStateBeforeHeight(name, height) {
  const latest = await appHistory.latestApplied(name, { before: height });
  if (!latest) return null;

  const resolved = await resolveSpec(latest.message.appSpecifications);
  if (!resolved) return null;

  const { InstantiatedSpec } = await getSpecBackend();
  return InstantiatedSpec.fromEvent({
    spec: resolved,
    hash: latest.decision.hash,
    height: latest.decision.height,
    registeredAt: latest.decision.termStart,
    contentHash: latest.message.contentHash ?? null,
    identity: latest.decision.identity,
    uuid: latest.decision.uuid,
  });
}

module.exports = {
  getStateBeforeHeight,
};
