const appsRepository = require('./appsRepository');
const { resolveSpec } = require('../utils/specCutover');
const { getSpecBackend } = require('../utils/specLibs');

const validTypes = ['zelappregister', 'fluxappregister', 'zelappupdate', 'fluxappupdate'];

/**
 * The previous confirmed state for an app, as of a verification timestamp,
 * hydrated into an InstantiatedSpec — so callers get the resolved (cleartext)
 * spec together with the originating message's hash/height and, for v9, its
 * contentHash (the content identity the renewal authority compares against).
 *
 * Returns null when there is no prior message or its encrypted spec cannot be
 * resolved on this node.
 *
 * @returns {Promise<import('@runonflux/flux-spec-backend').InstantiatedSpec|null>}
 */
async function getPreviousState(spec, verificationTimestamp) {
  const messages = await appsRepository.listAppMessagesByName(spec.name);

  let latest;
  for (const message of messages) {
    if (!validTypes.includes(message.type)) continue;
    if (message.timestamp > verificationTimestamp) continue;

    if (!latest) {
      latest = message;
    } else if (latest.height <= message.height && latest.timestamp < message.timestamp) {
      latest = message;
    }
  }

  if (!latest) return null;

  const appSpecs = latest.appSpecifications;
  if (!appSpecs) {
    throw new Error(`Previous specifications for ${spec.name} update message does not exist`);
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

/**
 * The previous confirmed spec (cleartext) — the .spec projection of
 * getPreviousState, for callers that only need the spec.
 *
 * @returns {Promise<import('@runonflux/flux-spec').FluxAppSpecBase|null>}
 */
async function getPreviousSpec(spec, verificationTimestamp) {
  const state = await getPreviousState(spec, verificationTimestamp);
  return state ? state.spec : null;
}

module.exports = {
  getPreviousState,
  getPreviousSpec,
};
