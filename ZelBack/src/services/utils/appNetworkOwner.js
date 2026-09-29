'use strict';

const APP_NETWORK_PREFIX = 'fluxDockerNetwork_';

/**
 * Resolve which app a docker network belongs to.
 *
 * Labels are the ownership authority, but they only exist on networks created
 * since the label shipped: an estate upgraded onto this code carries none until
 * each network is recreated. The name convention identifies those. A network we
 * can identify by NEITHER is not ours to reason about, so this returns null and
 * the caller leaves it alone — absence of a label is not evidence of absence of
 * an owner, and on a removal path that distinction is the whole safety story.
 *
 * @param {object} network - docker network list entry (Name, Labels)
 * @param {object} labelKeys - the label schema, resolved by the caller
 * @returns {string|null} owning app name, or null when unidentifiable
 */
function appNetworkOwner(network, labelKeys) {
  const labelled = network.Labels && network.Labels[labelKeys.APP_NETWORK];
  if (labelled) return labelled;
  const name = network.Name || '';
  if (name.startsWith(APP_NETWORK_PREFIX)) {
    return name.slice(APP_NETWORK_PREFIX.length) || null;
  }
  return null;
}

module.exports = {
  appNetworkOwner,
};
