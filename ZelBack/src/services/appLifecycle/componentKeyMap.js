'use strict';

const log = require('../../lib/log');
const appHistory = require('../appDecisions/appHistory');
const appRecords = require('../appDatabase/appRecords');
const specCutover = require('../utils/specCutover');
const specLibrary = require('../utils/specLibrary');
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
 * The keys of a record stored before keys: each component it runs keyed by
 * its name, which is what its containers, data and folders are named by.
 * @param {object} install - InstalledSpec
 * @returns {Promise<Map<string, string>>}
 */
async function namesAsKeys(install) {
  const running = await opened(await specCutover.resolveInstantiatedSpec(install.record), install.name);
  return new Map(running.componentNames().map((name) => [name, name]));
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
  return componentKeysFor(update, {
    previous: install.componentKeys ?? await namesAsKeys(install),
    appIdentity: install.identity ?? install.name,
    messageHash: registered.hash,
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

/**
 * Writes the keys of every installed record stored before keys: its
 * components' names. A record whose spec this node cannot open now keeps
 * none, and is read as keyed by its names until a later boot writes them.
 * @returns {Promise<{keyed: Array<{name: string, replica: string|null}>, skipped: Array<{name: string, replica: string|null, reason: string}>}>}
 */
async function keyInstalledByName() {
  const { InstalledSpec } = specLibrary.loaded();
  const installed = appRecords.installed();
  const results = { keyed: [], skipped: [] };
  // eslint-disable-next-line no-restricted-syntax
  for (const install of await installed.all()) {
    if (install.componentKeys !== null) continue; // eslint-disable-line no-continue
    const key = { name: install.name, replica: install.replica };
    try {
      // eslint-disable-next-line no-await-in-loop
      const componentKeys = await namesAsKeys(install);
      // eslint-disable-next-line no-await-in-loop
      await installed.put(new InstalledSpec({
        record: install.record, replica: install.replica, owed: install.owed, componentKeys,
      }));
      results.keyed.push(key);
    } catch (error) {
      log.warn(`componentKeyMap - ${install.name}${install.replica ? ` (${install.replica})` : ''} keeps no component keys this boot: ${error.message}`);
      results.skipped.push({ ...key, reason: error.message });
    }
  }
  if (results.keyed.length) log.info(`componentKeyMap - ${results.keyed.length} installed instance(s) keyed by their component names`);
  return results;
}

module.exports = {
  keysForInstall,
  keysForUpdate,
  keyInstalledByName,
};
