'use strict';

const appHistory = require('../appDecisions/appHistory');
const specCutover = require('../utils/specCutover');
const { getSpec } = require('../utils/specLibs');

/**
 * The component keys of a version of an app this node runs: by component name,
 * what each component's container, data and folder are named by
 * (flux-spec componentKeysFor). The node that runs the app works them out, by
 * opening the spec, and keeps them on its installed record; they hold
 * component names, which an encrypted app keeps sealed, so they never leave
 * the node. Every node that runs the app replays the same applied history and
 * reaches the same keys.
 */

async function opened(spec, name) {
  if (!spec) throw new Error(`component keys for ${name}: its spec cannot be opened on this node`);
  return spec;
}

/**
 * The keys of an update this node applies to an app it runs: the installed
 * record's keys carried onto the update's spec. A record stored before keys
 * holds none, and each component it runs is keyed by its name.
 * @param {object} install - InstalledSpec
 * @param {object} registered - InstantiatedSpec of the update
 * @returns {Promise<Map<string, string>>}
 */
async function keysForUpdate(install, registered) {
  const { componentKeysFor } = await getSpec();
  const update = await opened(await specCutover.resolveInstantiatedSpec(registered), registered.name);
  let previous = install.componentKeys;
  if (previous === null) {
    const running = await opened(await specCutover.resolveInstantiatedSpec(install.record), install.name);
    previous = new Map(running.componentNames().map((name) => [name, name]));
  }
  return componentKeysFor(update, {
    previous, appIdentity: install.identity ?? install.name, messageHash: registered.hash,
  });
}

/**
 * The keys of a version of an app this node installs: the app's applied
 * messages, from its registration to this version, opened in chain order with
 * the keys carried from each to the next.
 * @param {object} registered - InstantiatedSpec of the version installed
 * @returns {Promise<Map<string, string>>}
 */
async function keysForInstall(registered) {
  const { componentKeysFor } = await getSpec();
  const history = await appHistory.appliedMessages(registered.name);
  const own = history.find(({ decision }) => decision.hash === registered.hash);
  if (!own) throw new Error(`component keys for ${registered.name}: ${registered.hash} is not an applied message of the app`);
  // The app is the one this version belongs to: a name registered again after
  // expiry is another app, whose messages are not this one's history.
  const versions = history.filter(({ decision }) => decision.uuid === own.decision.uuid);
  let keys = null;
  for (const { message, decision } of versions) {
    // eslint-disable-next-line no-await-in-loop
    const spec = await opened(await specCutover.resolveSpec(message.appSpecifications), registered.name);
    keys = componentKeysFor(spec, {
      previous: keys, appIdentity: registered.identity ?? registered.name, messageHash: decision.hash,
    });
    if (decision.hash === registered.hash) break;
  }
  return keys;
}

module.exports = {
  keysForInstall,
  keysForUpdate,
};
