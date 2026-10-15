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
 * A version of an app's components through its history: the app's versions
 * applied before it, in chain order, opened with the keys carried from each to
 * the next, and then the version itself. The version need not be recorded as
 * applied yet: the registry stores a version before its decision is written,
 * and a version is the latest of its app when its keys are read.
 * @param {object} registered - InstantiatedSpec of the version
 * @returns {Promise<{keys: Map<string, string>, namesByKey: Map<string, string[]>}>}
 *   the version's keys by component name, and every name each key has held, in
 *   the order it first held them
 */
async function componentHistory(registered) {
  const { componentKeysFor } = await getSpec();
  const appIdentity = registered.identity ?? registered.name;
  // The app is the one this version belongs to: a name registered again after
  // expiry is another app, whose messages are not this one's history.
  const before = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const version of await appHistory.appliedMessages(registered.name)) {
    if (version.decision.hash === registered.hash) break;
    if (version.decision.uuid === registered.uuid) before.push(version);
  }
  const namesByKey = new Map();
  const record = (keys) => keys.forEach((key, name) => {
    const names = namesByKey.get(key) ?? [];
    if (!names.includes(name)) names.push(name);
    namesByKey.set(key, names);
  });
  let keys = null;
  // eslint-disable-next-line no-restricted-syntax
  for (const { message, decision } of before) {
    // eslint-disable-next-line no-await-in-loop
    const spec = await opened(await specCutover.resolveSpec(message.appSpecifications), registered.name);
    keys = componentKeysFor(spec, { previous: keys, appIdentity, messageHash: decision.hash });
    record(keys);
  }
  const own = await opened(await specCutover.resolveInstantiatedSpec(registered), registered.name);
  keys = componentKeysFor(own, { previous: keys, appIdentity, messageHash: registered.hash });
  record(keys);
  return { keys, namesByKey };
}

/**
 * The keys of a version of an app (componentHistory).
 * @param {object} registered - InstantiatedSpec of the version
 * @returns {Promise<Map<string, string>>}
 */
async function keysForVersion(registered) {
  return (await componentHistory(registered)).keys;
}

/**
 * The names each component of a version of an app held before its current
 * one, in the order it held them: what a cluster that stored a member by an
 * earlier name still asks for. A name a removed component held is not a
 * former name of a component added later under it.
 * @param {object} registered - InstantiatedSpec of the version
 * @returns {Promise<Map<string, string[]>>} by current component name
 */
async function formerNamesForVersion(registered) {
  const { keys, namesByKey } = await componentHistory(registered);
  return new Map([...keys].map(([name, key]) => [name, namesByKey.get(key).filter((held) => held !== name)]));
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
  keysForVersion,
  formerNamesForVersion,
  keysForUpdate,
  keyInstalledByName,
};
