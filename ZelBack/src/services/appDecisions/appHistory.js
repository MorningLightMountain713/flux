'use strict';

const appRecords = require('../appDatabase/appRecords');
const { compareChainOrder } = require('../utils/chainOrder');
const { lookupBlockTime } = require('../daemonService/daemonServiceBlockchainRpcs');
const { getSpecBackend } = require('../utils/specLibs');

/**
 * An app's history as the chain accepted it: the messages the decider applied
 * for a name, in chain order, each with its decision.
 *
 * Stored messages include every refused one, so a reader that treats stored
 * messages as an app's history reads refusals as if they had happened. Every
 * such reader asks here instead; only storing, the decider, the registry owner
 * and the routes that serve stored messages as they are read them directly.
 */


/**
 * Every applied message for a name, in chain order.
 * @param {string} name - in any letter case
 * @returns {Promise<Array<{message: object, decision: object}>>}
 */
async function appliedMessages(name) {
  const decisions = (await appRecords.decisions().appliedFor(String(name).toLowerCase())).sort(compareChainOrder);
  if (decisions.length === 0) return [];
  const messages = await appRecords.messages().confirmedByHashes(decisions.map((d) => d.hash));
  const byHash = new Map(messages.map((record) => [record.hash, record.permanentForm()]));
  return decisions
    .filter((decision) => byHash.has(decision.hash))
    .map((decision) => ({ message: byHash.get(decision.hash), decision }));
}

/**
 * The applied messages of the app that holds a name, in chain order: the latest
 * applied message's app (its uuid). A name registered again after expiry is
 * another app, so an earlier app's messages are left out.
 * @param {string} name - in any letter case
 * @returns {Promise<Array<{message: object, decision: object}>>}
 */
async function currentAppMessages(name) {
  const applied = await appliedMessages(name);
  if (applied.length === 0) return [];
  const { uuid } = applied[applied.length - 1].decision;
  return applied.filter(({ decision }) => decision.uuid === uuid);
}

/**
 * The version of the message that registered an app: the spec version of the
 * first applied message of the app with a uuid, or of the app that holds the
 * name when none is given. It fixes the syncthing folder ids and the kept
 * alias the node names the app's components with. Null when no applied
 * message registers the app.
 * @param {string} name - in any letter case
 * @param {string|null} [uuid] - the app's, when the caller holds one
 * @returns {Promise<number|null>}
 */
async function registrationVersionOf(name, uuid = null) {
  const applied = await appliedMessages(name);
  if (applied.length === 0) return null;
  const app = uuid ?? applied[applied.length - 1].decision.uuid;
  const registration = applied.find(({ decision }) => decision.uuid === app);
  const version = registration?.message?.appSpecifications?.version;
  return Number.isInteger(version) ? version : null;
}

/**
 * The latest applied message for a name.
 * @param {string} name - in any letter case
 * @param {{type?: 'registration'|'update', before?: number}} [filter] - only
 *   that type; only below that height
 * @returns {Promise<?{message: object, decision: object}>}
 */
async function latestApplied(name, { type, before } = {}) {
  const applied = (await appliedMessages(name))
    .filter(({ decision }) => (type === undefined || decision.type === type)
      && (before === undefined || decision.height < before));
  return applied.length ? applied[applied.length - 1] : null;
}

/**
 * What an update to the app holding a name reads of the message it replaces —
 * the latest applied one — as flux-spec's decision rule reads it
 * (replacedMessage): its hash, where the term it holds started
 * (`prevRegisteredAt`), the moment that term was bought at (`prevAt`), and the
 * time in ms an update must be signed after (`signAfter`). Null when nothing
 * applied.
 * @param {string} name - in any letter case
 * @returns {Promise<?{hash: string, prevAt: {time: number, height: number},
 *   prevRegisteredAt: number, signAfter: number}>}
 */
async function replacedBy(name) {
  const latest = await latestApplied(name);
  if (!latest) return null;
  const { decision, message } = latest;
  const blockTime = decision.blockTime ?? await lookupBlockTime(decision.height);
  if (!Number.isFinite(blockTime)) throw new Error(`no block time for height ${decision.height}`);
  const { replacedMessage } = await getSpecBackend();
  return {
    hash: decision.hash,
    ...replacedMessage({
      timestamp: message.timestamp,
      height: decision.height,
      version: message.appSpecifications.version,
      termStart: decision.termStart,
      blockTime,
    }),
  };
}

/**
 * The applied updates of the app that holds a name, stamped with their
 * confirming blocks' times: what a free-update limit counts.
 * @param {string} name - in any letter case
 * @returns {Promise<Array<{type: string, timestamp: number}>>} timestamps in ms
 */
async function appliedUpdateEvents(name) {
  const events = [];
  for (const { decision } of await currentAppMessages(name)) {
    if (decision.type !== 'update') continue;
    // eslint-disable-next-line no-await-in-loop
    const blockTime = decision.blockTime ?? await lookupBlockTime(decision.height);
    if (Number.isFinite(blockTime)) events.push({ type: 'fluxappupdate', timestamp: blockTime * 1000 });
  }
  return events;
}

/**
 * Who has owned the app that holds a name, in order: each owner with the height
 * at which they took it, the registration's height for the first, and the
 * grants block the message that began their ownership named (null when it
 * named none). The last entry is the listed owner. Empty when nothing applied.
 * @param {string} name - in any letter case
 * @returns {Promise<Array<{owner: string, from: number, grants: ?object}>>}
 */
async function ownerships(name) {
  const owners = [];
  for (const { message, decision } of await currentAppMessages(name)) {
    const owner = message?.appSpecifications?.owner;
    if (typeof owner !== 'string' || !owner) continue;
    if (owners.length === 0 || owners[owners.length - 1].owner !== owner) {
      owners.push({ owner, from: decision.height, grants: message.appSpecifications.grants ?? null });
    }
  }
  return owners;
}

/**
 * The app that holds a name and who has owned it: its identity and its
 * ownerships as `ownerships` gives them. What a reader outside the node, which
 * holds an owner's write keyed by identity and the height its owner took the
 * app, checks that owner against: a past ownership is chain history and does not
 * change. Null when nothing applied.
 * @param {string} name - in any letter case
 * @returns {Promise<{identity: string, ownerships: Array<{owner: string, from: number}>}|null>}
 */
async function ownershipRecord(name) {
  const messages = await currentAppMessages(name);
  if (messages.length === 0) return null;
  const { identity } = messages[messages.length - 1].decision;
  return { identity, ownerships: (await ownerships(name)).map(({ owner, from }) => ({ owner, from })) };
}

module.exports = {
  appliedMessages,
  appliedUpdateEvents,
  ownerships,
  ownershipRecord,
  currentAppMessages,
  registrationVersionOf,
  latestApplied,
  replacedBy,
};
