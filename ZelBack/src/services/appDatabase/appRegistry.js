'use strict';


const log = require('../../lib/log');
const capabilities = require('../utils/capabilities');
const chainState = require('../chainState');
const fluxEventBus = require('../utils/fluxEventBus');
const { getSpecBackend } = require('../utils/specLibs');
const { compareChainOrder } = require('../utils/chainOrder');
const appsRepository = require('./appsRepository');
const appRecords = require('./appRecords');
const registryManager = require('./registryManager');
const contentSlotService = require('../appLifecycle/contentSlotService');
const foundingCommittee = require('../appMesh/foundingCommittee');
const appEventVerifier = require('../appMessaging/appEventVerifier');
const decider = require('../appDecisions/decider');
const messageStore = require('../appMessaging/messageStore');
const { processPendingUpdates } = require('../appMessaging/messageStore');
const { lookupBlockTime } = require('../daemonService/daemonServiceBlockchainRpcs');

/**
 * The app registry (`globalAppsInformation`): for each name, the latest applied
 * decision's spec with its uuid, identity and term start, while that app is
 * alive. This module is its only writer.
 *
 * A name's row is written when the decider decides the name. After a full pass
 * with the scan caught up, every row is reconciled with the decisions, and
 * `appRegistryConsistent` rises once that is done; a rewind lowers it. Until
 * the scan catches up a rewind's blocks have no decisions yet, so a reconcile
 * then would move rows back only for the next pass to move them forward.
 *
 * Liveness is judged at a chain position, never by this node's clock: the
 * scanned block's height for a v1-v8 term and its time for a v9 term, the rule
 * the decider judges a registration of a held name by. An app leaves the list
 * at the block its term ends, before any registration in a later block can take
 * the name, and the `onRemoved` listeners hear of it then.
 *
 * A row change runs its effects (wake the spawner, promote a held content
 * manifest, clear install errors, anchor the founding committee, map its
 * components) only when the row's spec changes: another message, or a row
 * added. uuid, identity or term start alone run none.
 */


const CAPABILITY = 'appRegistryConsistent';
const OWNER = 'appRegistry';

let started = false;

// The block the scan last moved the cursor to, as {height, time}; null until
// the scan reports one, and after a rewind.
let scannedBlock = null;

// Every listed row by lower-cased name, while `appRegistryConsistent` is up: the
// rows this module wrote, which the block's expiry check runs over.
const listed = new Map();

const removedListeners = [];
const ownerChangedListeners = [];

/**
 * The chain position liveness is judged at: the scanned block's height and time.
 * @returns {Promise<{currentHeight: number, tipBlockTime: number}>}
 */
async function chainClock() {
  if (!scannedBlock) {
    const height = await chainState.getScannedHeight();
    const time = await lookupBlockTime(height);
    if (!Number.isFinite(time)) throw new Error(`the time of the scanned block ${height} cannot be read`);
    scannedBlock = { height, time };
  }
  return { currentHeight: scannedBlock.height, tipBlockTime: scannedBlock.time };
}

/**
 * Whether a listed row's term has ended at a chain position. A row whose expiry
 * cannot be computed is kept and reported: removing a registration on a verdict
 * nothing could compute cannot be undone.
 */
function endedAt(row, clock) {
  try {
    return row.isExpired(clock.tipBlockTime, clock.currentHeight);
  } catch (error) {
    log.warn(`appRegistry - cannot determine expiry for ${row.name}, listing it: ${error.message}`);
    return false;
  }
}

/**
 * The rows the given applied decisions stand for, by name: each decision's
 * stored message projected with the decision's uuid, identity and term start,
 * or no row when its term has ended at the scanned block; and, by name, the
 * manifest the message carries, when it carries one.
 * @param {Map<string, object>} applied - latest applied decision by name
 * @returns {Promise<{rows: Map<string, object>, carried: Map<string, object>}>}
 *   RegisteredSpec rows and carried manifests, by name
 */
async function rowsFor(applied) {
  const carried = new Map();
  if (applied.size === 0) return { rows: new Map(), carried };
  const { RegisteredSpec } = await getSpecBackend();
  const clock = await chainClock();
  const messages = await appRecords.messages().confirmedByHashes([...applied.values()].map((d) => d.hash));
  const byHash = new Map(messages.map((record) => [record.hash, record.permanentForm()]));

  const rows = new Map();
  for (const [name, decision] of applied) {
    const message = byHash.get(decision.hash);
    if (!message) continue;
    // eslint-disable-next-line no-await-in-loop
    const { spec } = await appEventVerifier.deserializeMessage(message);
    const row = RegisteredSpec.fromEvent({
      spec,
      hash: decision.hash,
      height: decision.height,
      registeredAt: decision.termStart,
      contentHash: message.contentHash ?? null,
      identity: decision.identity,
      uuid: decision.uuid,
    });
    if (!endedAt(row, clock)) {
      rows.set(name, row);
      if (message.contentManifest) carried.set(name, message.contentManifest);
    }
  }
  return { rows, carried };
}

/**
 * Writes a row whose spec changed, or that is new, and runs its effects. The
 * manifest the row's message carries is kept first: a component the new spec
 * recreates finds the slot it adds filled. Then the app's manifests are judged
 * against the new row: those held before the app was listed are resolved, peers
 * are asked for what this node lacks, and a running instance is brought to the
 * manifest the app now stands on. The install errors nodes reported about the
 * name's other specs are deleted; those about the spec the row now stands on
 * are kept, so a node that learns the app after others failed to install it
 * does not try what they already reported.
 * @param {object} instance - the RegisteredSpec the row stands on
 * @param {?object} carried - the manifest the row's message carries, or null
 */
async function writeWithEffects(instance, carried) {
  await registryManager.storeGlobalSpec(instance);
  if (carried) {
    await contentSlotService.storeCarriedManifest(instance, carried)
      .catch((e) => log.warn(`contentSlot: storing the manifest ${instance.name}'s update carries failed - ${e.message ?? e}`));
  }
  fluxEventBus.publish('app:specStored', { name: instance.name, hash: instance.hash });
  setImmediate(() => contentSlotService.rejudgeManifests(instance, { specChanged: true })
    .catch((e) => log.warn(`contentSlot: judging ${instance.name}'s manifests after its row write failed - ${e.message ?? e}`)));
  await appsRepository.removeAppInstallingErrorRecords(instance.name, { keepHash: instance.hash });
}

/**
 * Deletes what an app keeps beyond its row: its founding record. Its content
 * manifests stay: an expired app renews on them, and the content domain reaps
 * those of an identity another registration of the name has displaced.
 * @param {string} identity
 */
async function forgetApp(identity) {
  await foundingCommittee.forget(identity);
}

/**
 * Removes a name's row, deletes what the app keeps beyond it, and tells the
 * `onRemoved` listeners.
 * @param {{name: string, identity: string}} row - the row leaving
 */
async function removeRow({ name, identity }) {
  await appRecords.registry().remove(name);
  await appsRepository.removeAppInstallingErrorRecords(name);
  await forgetApp(identity);
  listed.delete(name.toLowerCase());
  removedListeners.forEach((fn) => setImmediate(() => {
    Promise.resolve(fn(name)).catch((error) => log.error(`appRegistry - a removal listener failed for ${name}: ${error.message}`));
  }));
}

/**
 * Makes a name's row what its latest applied decision says.
 * @param {string} name - lower-cased
 * @param {?object} instance - the RegisteredSpec it should have, or null for none
 * @param {?object} [carried] - the manifest its message carries, or null
 * @returns {Promise<'added'|'changed'|'restamped'|'removed'|null>}
 */
async function settle(name, instance, carried = null) {
  const live = await appRecords.registry().byName(name);
  if (!instance) {
    if (!live) return null;
    await removeRow(live);
    return 'removed';
  }
  let outcome = null;
  if (!live || live.hash !== instance.hash || live.name !== instance.name) {
    // Another app under the name keeps nothing this one founded; the same app
    // gone back to an earlier spec keeps only what that spec founded.
    if (live && live.identity !== instance.identity) await forgetApp(live.identity);
    else if (live && instance.height < live.height) await foundingCommittee.retract(instance.identity, instance.height);
    await writeWithEffects(instance, carried);
    // A new owner: what this node stands on for each role follows from the
    // new row, the holder hears it, and the records a peer holds are asked for.
    if (live && live.owner !== instance.owner) {
      setImmediate(() => messageStore.rejudgeGenerationRecords(instance.identity)
        .catch((e) => log.warn(`grantgeneration: rejudge after the owner change of ${instance.name} failed - ${e.message ?? e}`)));
      ownerChangedListeners.forEach((fn) => setImmediate(() => {
        Promise.resolve(fn({ name: instance.name, identity: instance.identity }))
          .catch((error) => log.error(`appRegistry - an owner-change listener failed for ${instance.name}: ${error.message}`));
      }));
    }
    outcome = live ? 'changed' : 'added';
  } else if (live.uuid !== instance.uuid || live.identity !== instance.identity || live.registeredAt !== instance.registeredAt) {
    await appRecords.registry().put(instance);
    outcome = 'restamped';
  }
  listed.set(name, instance);
  // Updates that reached this node before their app existed are judged now
  // that the row they are judged against does.
  if (outcome === 'added') await processPendingUpdates(instance.name);
  return outcome;
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
    ...(await appRecords.decisions().appliedFor(name)).filter((decision) => !run.has(decision.hash)),
    ...decisions.filter((decision) => decision.decision === 'applied'),
  ];
  const latest = candidates.reduce((held, decision) => (!held || compareChainOrder(held, decision) < 0 ? decision : held), null);
  const { rows, carried } = await rowsFor(latest ? new Map([[name, latest]]) : new Map());
  await settle(name, rows.get(name) ?? null, carried.get(name) ?? null);
}

/**
 * Reconciles every row with the decisions, holding the chain-state lock, then
 * raises `appRegistryConsistent` when the full pass it follows left no name
 * undecided: a name whose payment has no position yet is neither listed nor
 * refused, so a list missing it would read as one that dropped it. Waits for
 * the scan to catch up: the decider runs a full pass then, and this runs after it.
 * @param {{unpositioned?: number}} [outcome] the full pass's
 */
async function reconcile({ unpositioned = 0 } = {}) {
  if (!capabilities.isUp('explorerSynced')) return;
  const counts = await chainState.exclusive(async () => {
    const { rows, carried } = await rowsFor(await appRecords.decisions().latestApplied());
    const live = await appRecords.registry().names();
    const names = new Set([...rows.keys(), ...live.map((n) => n.toLowerCase())]);
    const tally = {};
    for (const name of names) {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await settle(name, rows.get(name) ?? null, carried.get(name) ?? null);
      if (outcome) tally[outcome] = (tally[outcome] ?? 0) + 1;
    }
    return tally;
  });
  log.info(`appRegistry - list reconciled with the decisions: ${JSON.stringify(counts)}`);
  if (unpositioned) {
    capabilities.claim(CAPABILITY, OWNER).lower(`${unpositioned} name(s) not decided yet: a payment record has no position`);
    return;
  }
  capabilities.claim(CAPABILITY, OWNER).raise('the list is derived from every decision');
}

/**
 * The scan moved to a block, holding the chain-state lock: every listed app
 * whose term ends at it leaves the list.
 * @param {{height: number, time: number}} block
 */
async function blockScanned(block) {
  scannedBlock = block;
  if (!capabilities.isUp(CAPABILITY)) return;
  const clock = { currentHeight: block.height, tipBlockTime: block.time };
  const ended = [...listed.values()].filter((row) => endedAt(row, clock));
  for (const row of ended) {
    log.info(`appRegistry - ${row.name}'s term ended at ${block.height}, leaving the list`);
    // eslint-disable-next-line no-await-in-loop
    await removeRow(row);
  }
}

/**
 * Registers `fn(name)`, called after a name's row leaves the list, outside the
 * chain-state lock.
 * @param {(name: string) => (void|Promise<void>)} fn
 */
function onRemoved(fn) {
  removedListeners.push(fn);
}

/**
 * Registers `fn({ name, identity })`, called after the row of a listed app is
 * written naming another owner, outside the chain-state lock. The row already
 * names the new owner when it runs.
 * @param {(app: {name: string, identity: string}) => (void|Promise<void>)} fn
 */
function onOwnerChanged(fn) {
  ownerChangedListeners.push(fn);
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
  chainState.onBlockScanned(blockScanned);
  chainState.onRewind(() => { scannedBlock = null; });
  capabilities.onDown('chainStateConsistent', () => handle.lower('chain state rewinding'));
}

module.exports = {
  applyDecided,
  blockScanned,
  onRemoved,
  onOwnerChanged,
  reconcile,
  start,
};
