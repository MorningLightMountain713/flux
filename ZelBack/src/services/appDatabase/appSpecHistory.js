'use strict';

const appsRepository = require('./appsRepository');
const { resolveSpec } = require('../utils/specCutover');
const { getSpecBackend } = require('../utils/specLibs');

const validTypes = ['zelappregister', 'fluxappregister', 'zelappupdate', 'fluxappupdate'];

/**
 * The confirmed state of the app holding a name immediately before a block
 * height, hydrated into an InstantiatedSpec — so callers get the resolved
 * (cleartext) spec together with the originating message's hash/height and, for
 * v9, its contentHash (the content identity the renewal authority compares
 * against).
 *
 * This reconstructs history and is for messages already on chain: a node
 * catching up must judge a mined message against the state at the height it was
 * mined, not against the state now. Anything deciding a LIVE message reads the
 * app's active registry row instead — the message history is name-scoped, so it
 * spans every app that has ever held the name.
 *
 * The cutoff is the height, which the chain fixes, and never the message's own
 * timestamp, which its sender writes.
 *
 * Returns null when nothing precedes the height or the spec cannot be resolved
 * on this node.
 *
 * @param {string} name - App name
 * @param {number} height - Block height of the message being judged
 * @returns {Promise<import('@runonflux/flux-spec-backend').InstantiatedSpec|null>}
 */
async function getStateBeforeHeight(name, height) {
  const messages = await appsRepository.listAppMessagesByName(name);

  let latest;
  for (const message of messages) {
    if (!validTypes.includes(message.type)) continue;
    if (message.height >= height) continue;

    const newer = !latest
      || message.height > latest.height
      || (message.height === latest.height && message.timestamp > latest.timestamp);
    if (newer) latest = message;
  }

  if (!latest) return null;

  const appSpecs = latest.appSpecifications;
  if (!appSpecs) {
    throw new Error(`Previous specifications for ${name} update message does not exist`);
  }

  const resolved = await resolveSpec(appSpecs);
  if (!resolved) return null;

  const { InstantiatedSpec } = await getSpecBackend();
  return InstantiatedSpec.fromEvent({
    spec: resolved,
    hash: latest.hash,
    height: latest.height,
    contentHash: latest.contentHash ?? null,
  });
}

module.exports = {
  getStateBeforeHeight,
};
