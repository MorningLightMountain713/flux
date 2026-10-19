'use strict';

const log = require('../../lib/log');
const capabilities = require('./capabilities');
const { INTENT, CLAIMABLE } = require('./messageIntent');

/**
 * Where a message goes: which handler takes it, which pipeline carries it, what it
 * is allowed to be, and which capabilities its handler reads.
 *
 * One declaration per type. Every part of the transport that has to know about a type
 * reads it from here, so none of them keeps a list of its own and a type cannot be
 * reachable by one and invisible to another.
 *
 * Both are required. A type whose intent is not stated is a type whose dedup behaviour
 * nobody decided, and the one way that goes wrong - a relayed type taking its intent
 * from the signed payload - puts an undeduplicated message into the whole network. The
 * signature is the guard, so adding a type means answering the question.
 */
const ROUTE = Object.freeze({
  // Deduplicated and verified, then handed over.
  GOSSIP: 'gossip',
  // Straight to the per-peer queue: position carries meaning, so nothing that can
  // reorder may sit in front of it.
  ORDERED: 'ordered',
});

// Why a type reads no capability.
const NONE = Object.freeze({
  PROCESS: "handled from this process's own state",
});

const KNOWN_CAPABILITIES = new Set(capabilities.DEFINITIONS.map(({ name }) => name));

const routes = new Map();

/**
 * Declare who takes a message type, how it travels, what it may be, and what it reads.
 *
 * A type declares the capabilities its handler reads (`needs`) or why it reads none
 * (`none`). While any of its needs is down a message of the type is skipped, not
 * handled.
 * @param {string|string[]} types Wire type, or several sharing one handler.
 * @param {Function} handler Takes (msgObj, peerSocket).
 * @param {string} route One of ROUTE.
 * @param {string} intent One of INTENT, including VARIES for a type sent both ways.
 * @param {{needs: string[]}|{none: string}} reads
 */
function register(types, handler, route, intent, reads) {
  if (route !== ROUTE.GOSSIP && route !== ROUTE.ORDERED) {
    throw new Error(`messageRoutes: ${types} declares no route`);
  }
  if (intent !== INTENT.VARIES && !CLAIMABLE.has(intent)) {
    throw new Error(`messageRoutes: ${types} declares no intent`);
  }
  const needs = reads?.needs;
  const none = reads?.none;
  if (Array.isArray(needs) === Boolean(none)) {
    throw new Error(`messageRoutes: ${types} declares neither the capabilities it reads nor why it reads none`);
  }
  const unknown = (needs ?? []).find((name) => !KNOWN_CAPABILITIES.has(name));
  if (unknown) throw new Error(`messageRoutes: ${types} needs unknown capability ${unknown}`);
  const list = Array.isArray(types) ? types : [types];
  list.forEach((type) => routes.set(type, {
    handler, route, intent, needs: Object.freeze([...(needs ?? [])]),
  }));
}

/**
 * What a type is allowed to be, which is what decides whether the message itself
 * gets a say. An unknown type is an announcement: it has no handler, so it is
 * dropped either way, and deduplicating it first costs the sender rather than us.
 * @param {string} type
 * @returns {string} One of INTENT.
 */
function declaredIntent(type) {
  const entry = routes.get(type);
  return entry ? entry.intent : INTENT.ANNOUNCE;
}

/**
 * The handler for a type, or null when nothing claims it.
 * @param {string} type
 * @returns {Function|null}
 */
function handlerFor(type) {
  const entry = routes.get(type);
  return entry ? entry.handler : null;
}

/**
 * Whether a type must keep its arrival order.
 * @param {string} type
 * @returns {boolean}
 */
function isOrdered(type) {
  const entry = routes.get(type);
  return Boolean(entry) && entry.route === ROUTE.ORDERED;
}

/**
 * The first capability a type needs that is not up, or null when it may be handled.
 * @param {string} type
 * @returns {string|null}
 */
function unmetNeed(type) {
  const entry = routes.get(type);
  return entry ? capabilities.firstNotUp(entry.needs) : null;
}

/**
 * The capabilities a type reads.
 * @param {string} type
 * @returns {string[]}
 */
function needsOf(type) {
  const entry = routes.get(type);
  return entry ? [...entry.needs] : [];
}

// capability -> the types skipped while it has been down, with how many of each.
const skipped = new Map();

/**
 * Says the capability is up again, with what was skipped while it was not.
 * @param {string} capability
 */
function closeSkipEpisode(capability) {
  const episode = skipped.get(capability);
  if (!episode) return;
  skipped.delete(capability);
  episode.off();
  const counts = [...episode.counts].map(([type, count]) => `${count} ${type}`).join(', ');
  log.info(`messageRoutes: ${capability} is up; skipped while it was not: ${counts}`);
}

/**
 * Records a message skipped because `capability` is down. A type is logged the first
 * time it is skipped while the capability is down, and the counts once it is up again.
 * @param {string} type
 * @param {string} capability
 */
function noteSkipped(type, capability) {
  let episode = skipped.get(capability);
  if (!episode) {
    episode = { counts: new Map(), off: capabilities.onUp(capability, () => closeSkipEpisode(capability)) };
    skipped.set(capability, episode);
  }
  const count = episode.counts.get(type) ?? 0;
  if (count === 0) log.warn(`messageRoutes: skipping ${type} while ${capability} is not up`);
  episode.counts.set(type, count + 1);
}

/** Every declared type, for the guards that assert the table is populated. */
function registeredTypes() {
  return [...routes.keys()];
}

module.exports = {
  NONE,
  ROUTE,
  register,
  declaredIntent,
  handlerFor,
  isOrdered,
  needsOf,
  noteSkipped,
  registeredTypes,
  unmetNeed,
};
