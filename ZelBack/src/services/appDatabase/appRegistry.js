'use strict';

const config = require('config');

const log = require('../../lib/log');
const dbHelper = require('../dbHelper');
const capabilities = require('../utils/capabilities');
const chainState = require('../chainState');
const fluxEventBus = require('../utils/fluxEventBus');
const { getSpecBackend } = require('../utils/specLibs');
const { compareChainOrder } = require('../utils/chainOrder');
const appsRepository = require('./appsRepository');
const registryManager = require('./registryManager');
const contentSlotService = require('../appLifecycle/contentSlotService');
const appEventVerifier = require('../appMessaging/appEventVerifier');
const decider = require('../appDecisions/decider');
const decisionStore = require('../appDecisions/decisionStore');
const { processPendingUpdates } = require('../appMessaging/messageStore');

/**
 * The app registry (`globalAppsInformation`): for each name, the latest applied
 * decision's spec with its uuid, identity and term start, while that app is
 * alive. This module is its only writer.
 *
 * A name's row is written when the decider decides the name. After a full pass
 * with the scan caught up, every row is reconciled with the decisions, and
 * `appRegistryConsistent` rises once that is done; a rewind lowers it. Until
 * the scan catches up a rewind's blocks have no decisions yet, so a reconcile
 * then would move rows back only for the next pass to move them forward. An
 * app whose term runs out leaves the list at the next sweep.
 *
 * A row change runs its effects (wake the spawner, promote a held content
 * manifest, clear install errors, anchor the founding committee, map its
 * components) only when the row's spec changes: another message, or a row
 * added. uuid, identity or term start alone run none.
 */

const globalAppsMessages = config.get('database.appsglobal.collections.appsMessages');
const globalAppsInformation = config.get('database.appsglobal.collections.appsInformation');

const CAPABILITY = 'appRegistryConsistent';
const OWNER = 'appRegistry';

let started = false;

function globalDb() {
  return dbHelper.databaseConnection().db(config.get('database.appsglobal.database'));
}

function nameRegex(name) {
  return new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
}

/** Now, as liveness is judged: the scan cursor and the wall clock. */
async function currentClock() {
  return {
    currentHeight: await chainState.getScannedHeight(),
    tipBlockTime: Math.floor(Date.now() / 1000),
  };
}

/**
 * The rows the given applied decisions stand for, by name: each decision's
 * stored message projected with the decision's uuid, identity and term start,
 * or no row when that app is not alive now.
 * @param {Map<string, object>} applied - latest applied decision by name
 * @returns {Promise<Map<string, object>>} serialized rows by name
 */
async function rowsFor(applied) {
  if (applied.size === 0) return new Map();
  const { InstantiatedSpec } = await getSpecBackend();
  const clock = await currentClock();
  const messages = await dbHelper.findInDatabase(
    globalDb(), globalAppsMessages, { hash: { $in: [...applied.values()].map((d) => d.hash) } }, { projection: { _id: 0 } },
  );
  const byHash = new Map(messages.map((message) => [message.hash, message]));

  const rows = new Map();
  for (const [name, decision] of applied) {
    const message = byHash.get(decision.hash);
    if (!message) continue;
    // eslint-disable-next-line no-await-in-loop
    const { spec } = await appEventVerifier.deserializeMessage(message);
    const row = InstantiatedSpec.fromEvent({
      spec,
      hash: decision.hash,
      height: decision.height,
      registeredAt: decision.termStart,
      contentHash: message.contentHash ?? null,
      identity: decision.identity,
      uuid: decision.uuid,
    });
    try {
      if (row.isExpired(clock.tipBlockTime, clock.currentHeight)) continue;
    } catch (error) {
      log.warn(`appRegistry - cannot determine expiry for ${name}, listing it: ${error.message}`);
    }
    rows.set(name, row.serialize());
  }
  return rows;
}

async function liveRow(name) {
  return dbHelper.findOneInDatabase(globalDb(), globalAppsInformation, { name: nameRegex(name) }, { projection: { _id: 0 } });
}

/** Writes a row whose spec changed, or that is new, and runs its effects. */
async function writeWithEffects(row) {
  await registryManager.storeGlobalSpec(row);
  fluxEventBus.publish('app:specStored', { name: row.name, hash: row.hash });
  setImmediate(() => contentSlotService.promoteQuarantinedManifest(row.name)
    .catch((e) => log.warn(`contentSlot: promote-on-confirm for ${row.name} failed - ${e.message ?? e}`)));
  await appsRepository.removeAppInstallingErrorRecords(row.name);
}

/** Removes a name's row. */
async function removeRow(name) {
  await appsRepository.removeGlobalAppInfo(name);
  await appsRepository.removeAppInstallingErrorRecords(name);
}

/**
 * Makes a name's row what its latest applied decision says.
 * @param {string} name - lower-cased
 * @param {?object} row - the row it should have, or null for none
 * @returns {Promise<'added'|'changed'|'restamped'|'removed'|null>}
 */
async function settle(name, row) {
  const live = await liveRow(name);
  if (!row) {
    if (!live) return null;
    await removeRow(name);
    return 'removed';
  }
  if (!live || live.hash !== row.hash || live.name !== row.name) {
    await writeWithEffects(row);
    if (live) return 'changed';
    // Updates that reached this node before their app existed are judged now
    // that the row they are judged against does.
    await processPendingUpdates(row.name);
    return 'added';
  }
  if (live.uuid !== row.uuid || live.identity !== row.identity || live.registeredAt !== row.registeredAt) {
    await appsRepository.replaceGlobalAppRow(row);
    return 'restamped';
  }
  return null;
}

/**
 * The decider's hook for a decided name, run before the triggering message's
 * own decision is written: the row stands on the latest applied decision among
 * the stored ones and the ones this run made.
 * @param {string} name
 * @param {object[]} decisions - this run's decisions for the name
 */
async function applyDecided(name, decisions) {
  const run = new Set(decisions.map((decision) => decision.hash));
  const candidates = [
    ...(await decisionStore.appliedFor(name)).filter((decision) => !run.has(decision.hash)),
    ...decisions.filter((decision) => decision.decision === 'applied'),
  ];
  const latest = candidates.reduce((held, decision) => (!held || compareChainOrder(held, decision) < 0 ? decision : held), null);
  const rows = await rowsFor(latest ? new Map([[name, latest]]) : new Map());
  await settle(name, rows.get(name) ?? null);
}

/**
 * Reconciles every row with the decisions, holding the chain-state lock, then
 * raises `appRegistryConsistent`. Waits for the scan to catch up: the decider
 * runs a full pass then, and this runs after it.
 */
async function reconcile() {
  if (!capabilities.isUp('explorerSynced')) return;
  const counts = await chainState.exclusive(async () => {
    const rows = await rowsFor(await decisionStore.latestApplied());
    const live = await dbHelper.findInDatabase(globalDb(), globalAppsInformation, {}, { projection: { _id: 0, name: 1 } });
    const names = new Set([...rows.keys(), ...live.map((row) => row.name.toLowerCase())]);
    const tally = {};
    for (const name of names) {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await settle(name, rows.get(name) ?? null);
      if (outcome) tally[outcome] = (tally[outcome] ?? 0) + 1;
    }
    return tally;
  });
  log.info(`appRegistry - list reconciled with the decisions: ${JSON.stringify(counts)}`);
  capabilities.claim(CAPABILITY, OWNER).raise('the list is derived from every decision');
}

/**
 * Removes every row whose app is no longer alive, holding the chain-state lock.
 * A row whose expiry cannot be computed is kept and reported: removing a
 * registration on a verdict nothing could compute cannot be undone.
 * @returns {Promise<{expired: string[], unjudgeable: string[]}>}
 */
async function sweepExpired() {
  const { InstantiatedSpec } = await getSpecBackend();
  return chainState.exclusive(async () => {
    const clock = await currentClock();
    const live = await dbHelper.findInDatabase(globalDb(), globalAppsInformation, {}, { projection: { _id: 0 } });
    const expired = [];
    const unjudgeable = [];
    for (const doc of live) {
      try {
        if (InstantiatedSpec.deserialize(doc).isExpired(clock.tipBlockTime, clock.currentHeight)) expired.push(doc.name);
      } catch (error) {
        unjudgeable.push(doc.name);
        log.warn(`appRegistry - cannot determine expiry for ${doc.name}, keeping it: ${error.message}`);
      }
    }
    for (const name of expired) {
      log.info(`appRegistry - ${name} expired, leaving the list`);
      // eslint-disable-next-line no-await-in-loop
      await removeRow(name);
    }
    return { expired, unjudgeable };
  });
}

/**
 * Starts owning the registry: rows follow the decider, a full pass reconciles
 * them all, and a rewind lowers `appRegistryConsistent` until the next one.
 */
function start() {
  if (started) return;
  started = true;
  const handle = capabilities.claim(CAPABILITY, OWNER);
  handle.starting('deriving the list from the decisions');
  decider.onDecided(applyDecided);
  decider.onFullPass(reconcile);
  capabilities.onDown('chainStateConsistent', () => handle.lower('chain state rewinding'));
}

module.exports = {
  applyDecided,
  reconcile,
  start,
  sweepExpired,
};
