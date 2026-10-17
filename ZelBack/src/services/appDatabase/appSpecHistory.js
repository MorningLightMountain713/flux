'use strict';

const appHistory = require('../appDecisions/appHistory');
const { resolveSpec } = require('../utils/specCutover');
const { getSpecBackend } = require('../utils/specLibs');

/**
 * An applied message hydrated into an RegisteredSpec with its decision's term
 * start, uuid and identity, so callers get the resolved (cleartext) spec
 * together with the message's hash, height and, for v9, its contentHash (the
 * content identity the renewal authority compares against). Null when the spec
 * cannot be resolved on this node.
 * @param {?{message: object, decision: object}} latest
 * @returns {Promise<import('@runonflux/flux-spec-backend').RegisteredSpec|null>}
 */
async function stateOf(latest) {
  if (!latest) return null;
  const resolved = await resolveSpec(latest.message.appSpecifications);
  if (!resolved) return null;
  const { RegisteredSpec } = await getSpecBackend();
  return RegisteredSpec.fromEvent({
    spec: resolved,
    hash: latest.decision.hash,
    height: latest.decision.height,
    registeredAt: latest.decision.termStart,
    contentHash: latest.message.contentHash ?? null,
    identity: latest.decision.identity,
    uuid: latest.decision.uuid,
  });
}

/**
 * The state of the app holding a name immediately before a block height, as
 * the chain accepted it: its latest applied message below that height.
 *
 * This reconstructs history and is for messages already on chain: a node
 * catching up must judge a mined message against the state at the height it was
 * mined, not against the state now. Anything deciding a LIVE message reads the
 * app's active registry row, and latestAppliedState when the list has none.
 *
 * Returns null when nothing was applied below the height or the spec cannot be
 * resolved on this node.
 *
 * @param {string} name - App name
 * @param {number} height - Block height of the message being judged
 * @returns {Promise<import('@runonflux/flux-spec-backend').RegisteredSpec|null>}
 */
async function getStateBeforeHeight(name, height) {
  return stateOf(await appHistory.latestApplied(name, { before: height }));
}

/**
 * The state the app that last held a name left, as the chain accepted it,
 * whether or not its term has ended: its latest applied message at any height.
 * What a live update of a name the list no longer carries is judged against,
 * so an expired app is renewed on what it held, by the owner who held it; a
 * name another app has since taken answers that app, and a renewal of the
 * earlier one fails its owner check there. Null when nothing was ever applied
 * for the name or the spec cannot be resolved on this node.
 *
 * @param {string} name - App name
 * @returns {Promise<import('@runonflux/flux-spec-backend').RegisteredSpec|null>}
 */
async function latestAppliedState(name) {
  return stateOf(await appHistory.latestApplied(name));
}

module.exports = {
  getStateBeforeHeight,
  latestAppliedState,
};
