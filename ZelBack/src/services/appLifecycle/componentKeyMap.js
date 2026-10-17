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
 * (flux-spec componentKeysFor), and by key, the names each component held
 * before its current one (formerNamesFor). The node that runs the app works
 * them out, by opening the spec, and keeps them on its hosted instance; they
 * hold component names, which an encrypted app keeps sealed, so they never
 * leave the node. Every node that runs the app replays the same applied
 * history and reaches the same keys and former names.
 */

async function opened(spec, name) {
  if (!spec) throw new Error(`component keys for ${name}: its spec cannot be opened on this node`);
  return spec;
}

/**
 * The keys of a record stored before keys: each component it runs keyed by
 * its name, which is what its containers, data and folders are named by.
 * @param {object} install - HostedInstance
 * @returns {Promise<Map<string, string>>}
 */
async function namesAsKeys(install) {
  const running = await opened(await specCutover.resolveRegisteredSpec(install.record), install.name);
  return new Map(running.componentNames().map((name) => [name, name]));
}

/**
 * The keys and former names of an update this node applies to an app it runs:
 * the hosted instance's carried onto the update's spec, which is the only
 * spec opened. A record stored before keys holds none, and each component it
 * runs is keyed by its name.
 * @param {object} install - HostedInstance
 * @param {object} registered - RegisteredSpec of the update
 * @returns {Promise<{componentKeys: Map<string, string>, formerNames: Map<string, string[]>}>}
 */
async function namingForUpdate(install, registered) {
  const { componentKeysFor, formerNamesFor } = await getSpec();
  const update = await opened(await specCutover.resolveRegisteredSpec(registered), registered.name);
  const previous = install.componentKeys ?? await namesAsKeys(install);
  const componentKeys = componentKeysFor(update, {
    previous,
    appIdentity: install.identity ?? install.name,
    messageHash: registered.hash,
  });
  return { componentKeys, formerNames: formerNamesFor(componentKeys, { previous, previousFormerNames: install.formerNames }) };
}

/**
 * The keys and former names of a version of an app: the app's versions applied
 * before it, in chain order, opened with the keys and former names carried
 * from each to the next, and then the version itself. The version need not be
 * recorded as applied yet: the registry stores a version before its decision
 * is written, and a version is the latest of its app when its keys are read.
 * @param {object} registered - RegisteredSpec of the version
 * @returns {Promise<{componentKeys: Map<string, string>, formerNames: Map<string, string[]>}>}
 */
async function namingForVersion(registered) {
  const { componentKeysFor, formerNamesFor } = await getSpec();
  const appIdentity = registered.identity ?? registered.name;
  // The app is the one this version belongs to: a name registered again after
  // expiry is another app, whose messages are not this one's history.
  const before = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const version of await appHistory.appliedMessages(registered.name)) {
    if (version.decision.hash === registered.hash) break;
    if (version.decision.uuid === registered.uuid) before.push(version);
  }
  const versions = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const { message, decision } of before) {
    // eslint-disable-next-line no-await-in-loop
    versions.push([await opened(await specCutover.resolveSpec(message.appSpecifications), registered.name), decision.hash]);
  }
  versions.push([await opened(await specCutover.resolveRegisteredSpec(registered), registered.name), registered.hash]);

  let componentKeys = null;
  let formerNames = null;
  // eslint-disable-next-line no-restricted-syntax
  for (const [spec, messageHash] of versions) {
    const keys = componentKeysFor(spec, { previous: componentKeys, appIdentity, messageHash });
    formerNames = formerNamesFor(keys, { previous: componentKeys, previousFormerNames: formerNames });
    componentKeys = keys;
  }
  return { componentKeys, formerNames };
}

/**
 * Writes the keys of every hosted instance stored before keys: its
 * components' names. A record whose spec this node cannot open now keeps
 * none, and is read as keyed by its names until a later boot writes them.
 * @returns {Promise<{keyed: Array<{name: string, replica: string|null}>, skipped: Array<{name: string, replica: string|null, reason: string}>}>}
 */
async function keyInstalledByName() {
  const { HostedInstance } = specLibrary.loaded();
  const installed = appRecords.hostedInstances();
  const results = { keyed: [], skipped: [] };
  // eslint-disable-next-line no-restricted-syntax
  for (const install of await installed.all()) {
    if (install.componentKeys !== null) continue; // eslint-disable-line no-continue
    const key = { name: install.name, replica: install.replica };
    try {
      // eslint-disable-next-line no-await-in-loop
      const componentKeys = await namesAsKeys(install);
      // eslint-disable-next-line no-await-in-loop
      await installed.put(new HostedInstance({
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
  namingForVersion,
  namingForUpdate,
  keyInstalledByName,
};
