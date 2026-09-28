'use strict';

const { EventEmitter } = require('events');
const log = require('../../lib/log');

/**
 * What this node can do right now, and why not when it cannot.
 *
 * A capability states one condition, and its name says what is true while it
 * is up. Two conditions that can fail separately are two capabilities; a reader
 * that needs several waits on the set, and a reader that proceeds without one
 * after a deadline states that deadline itself.
 *
 * Every capability is listed below with its owner and the capabilities it
 * needs. Only the owner changes a capability's state, through the handle
 * `claim` returns; everything else reads.
 *
 * A capability is:
 *   - `down`      its owner has not raised it, or has lowered it;
 *   - `coming-up` its owner is bringing it up, or has raised it while a
 *                 prerequisite is down;
 *   - `up`        its owner has raised it and every prerequisite is up.
 *
 * A prerequisite going down takes every capability that needs it down with it;
 * when the prerequisite comes back, a capability its owner still holds raised
 * comes back up. A prerequisite is declared only where it is what holds a
 * dependent down.
 *
 * A conditional capability exists only on a node that has the thing it
 * describes (`upnpMapped` on a UPnP node): it is absent until its owner claims
 * it, and an absent capability is neither up nor down.
 */

const STATE = Object.freeze({ DOWN: 'down', COMING_UP: 'coming-up', UP: 'up' });

const DEFINITIONS = Object.freeze([
  { name: 'apiListening', owner: 'apiServer', needs: [] },
  { name: 'upnpMapped', owner: 'upnpService', needs: [], conditional: true },
  { name: 'mongoReachable', owner: 'serviceManager', needs: [] },
  { name: 'dockerReachable', owner: 'serviceManager', needs: [] },
  { name: 'localDbPrepared', owner: 'serviceManager', needs: ['mongoReachable'] },
  { name: 'daemonReachable', owner: 'daemonServiceMiscRpcs', needs: [] },
  { name: 'daemonSynced', owner: 'daemonServiceMiscRpcs', needs: ['daemonReachable'] },
  { name: 'confirmationStatusKnown', owner: 'nodeConfirmationService', needs: [] },
  { name: 'nodeConfirmed', owner: 'nodeConfirmationService', needs: [] },
  { name: 'nodeListPopulated', owner: 'networkStateService', needs: [] },
  { name: 'nodeMessageCapable', owner: 'nodeConfirmationService', needs: ['nodeConfirmed', 'nodeListPopulated'] },
  { name: 'peersAboveFloor', owner: 'FluxPeerManager', needs: [] },
  { name: 'policyVerified', owner: 'policyStore', needs: [] },
  { name: 'policyCurrent', owner: 'policyStore', needs: ['policyVerified'] },
  { name: 'chainStateConsistent', owner: 'explorerService', needs: [] },
  { name: 'explorerSynced', owner: 'explorerService', needs: ['chainStateConsistent'] },
  { name: 'appMessagesSynced', owner: 'appSyncOrchestrator', needs: ['mongoReachable'] },
  { name: 'appRegistryConsistent', owner: 'appSyncOrchestrator', needs: ['explorerSynced', 'appMessagesSynced'] },
  { name: 'appStateSynced', owner: 'appSyncOrchestrator', needs: [] },
  { name: 'bootReconcileDecided', owner: 'appStartupManager', needs: ['mongoReachable', 'dockerReachable'] },
  { name: 'bootReconcilePassed', owner: 'reconcilerQueue', needs: [] },
  { name: 'spawnerReady', owner: 'appSyncOrchestrator', needs: [] },
]);

const HISTORY_LIMIT = 2000;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

/** name -> { definition, present, held, starting, state, since, reason, handle, everUp } */
let entries;
let history;

function init() {
  entries = new Map();
  history = [];
  const now = Date.now();
  for (const definition of DEFINITIONS) {
    entries.set(definition.name, {
      definition,
      present: !definition.conditional,
      held: false,
      starting: false,
      state: STATE.DOWN,
      since: now,
      reason: 'not started',
      handle: null,
      everUp: false,
    });
  }
}

init();

function entryOf(name) {
  const entry = entries.get(name);
  if (!entry) throw new Error(`capabilities: no capability named '${name}'`);
  return entry;
}

function firstDownPrerequisite(entry) {
  return entry.definition.needs.find((need) => entryOf(need).state !== STATE.UP) || null;
}

function derivedState(entry) {
  if (!entry.held) return entry.starting ? STATE.COMING_UP : STATE.DOWN;
  return firstDownPrerequisite(entry) ? STATE.COMING_UP : STATE.UP;
}

function dependentsOf(name) {
  return DEFINITIONS.filter((d) => d.needs.includes(name)).map((d) => d.name);
}

/**
 * Settle one capability after its owner or a prerequisite moved, then every
 * capability that needs it.
 */
function settle(name, reason) {
  const entry = entryOf(name);
  const next = derivedState(entry);
  if (next === entry.state) return;

  const from = entry.state;
  const at = Date.now();
  const waitingOn = next === STATE.COMING_UP ? firstDownPrerequisite(entry) : null;
  const record = {
    name, from, to: next, at, reason, tookMs: at - entry.since, waitingOn,
  };
  entry.state = next;
  entry.since = at;
  entry.reason = reason;

  history.push(record);
  if (history.length > HISTORY_LIMIT) history.shift();
  log.info(`capability ${name}: ${from} -> ${next} (${reason})${waitingOn ? `, waiting on ${waitingOn}` : ''}`);

  const firstUp = next === STATE.UP && !entry.everUp;
  if (next === STATE.UP) entry.everUp = true;
  emitter.emit('transition', record);
  if (firstUp) emitter.emit(`${name}:first-up`, record);

  for (const dependent of dependentsOf(name)) {
    settle(dependent, `${name} ${next}`);
  }
}

/**
 * The owner's handle on a capability. The boot sequence restarts from the top
 * after a throw, so the same owner claiming again gets the same handle; a claim
 * by anyone else is a second owner, and throws. Claiming a conditional
 * capability makes it present on this node.
 *
 * @param {string} name
 * @param {string} owner the definition's owner
 * @returns {{starting: (reason: string) => void, raise: (reason: string) => void,
 *   lower: (reason: string) => void}}
 */
function claim(name, owner) {
  const entry = entryOf(name);
  if (owner !== entry.definition.owner) {
    throw new Error(`capabilities: '${name}' is owned by ${entry.definition.owner}, not ${owner}`);
  }
  if (entry.handle) return entry.handle;
  entry.present = true;
  entry.handle = Object.freeze({
    /** The owner is bringing it up; readers still see it not up. */
    starting(reason) {
      entry.starting = true;
      settle(name, reason);
    },
    raise(reason) {
      entry.held = true;
      entry.starting = false;
      settle(name, reason);
    },
    lower(reason) {
      entry.held = false;
      entry.starting = false;
      settle(name, reason);
    },
  });
  return entry.handle;
}

function namesOf(nameOrNames) {
  return Array.isArray(nameOrNames) ? nameOrNames : [nameOrNames];
}

/**
 * Whether a capability, or every capability of a set, is up.
 * @param {string|string[]} nameOrNames
 */
function isUp(nameOrNames) {
  return namesOf(nameOrNames).every((name) => entryOf(name).state === STATE.UP);
}

/** @param {string} name */
function stateOf(name) {
  return entryOf(name).state;
}

/** Whether a conditional capability exists on this node; always true otherwise. */
function isPresent(name) {
  return entryOf(name).present;
}

/**
 * The first capability of a set that is not up, or null when all are.
 * @param {string|string[]} nameOrNames
 */
function firstNotUp(nameOrNames) {
  return namesOf(nameOrNames).find((name) => entryOf(name).state !== STATE.UP) || null;
}

/**
 * Resolves when a capability, or every capability of a set, is up at the same
 * time: at once if they are.
 * @param {string|string[]} nameOrNames
 * @returns {Promise<void>}
 */
function whenUp(nameOrNames) {
  const names = namesOf(nameOrNames);
  names.forEach(entryOf);
  if (isUp(names)) return Promise.resolve();
  return new Promise((resolve) => {
    const listener = (record) => {
      if (names.includes(record.name) && isUp(names)) {
        emitter.off('transition', listener);
        resolve();
      }
    };
    emitter.on('transition', listener);
  });
}

/**
 * Call `fn(record)` on every transition of a capability.
 * @returns {() => void} unsubscribe
 */
function onTransition(name, fn) {
  entryOf(name);
  const listener = (record) => { if (record.name === name) fn(record); };
  emitter.on('transition', listener);
  return () => emitter.off('transition', listener);
}

/**
 * Call `fn()` on every up edge of a capability: each time it comes up.
 * @returns {() => void} unsubscribe
 */
function onUp(name, fn) {
  return onTransition(name, (record) => {
    if (record.to === STATE.UP && record.from !== STATE.UP) fn();
  });
}

/**
 * Call `fn()` on every down edge of a capability: each time it stops being up.
 * A move between `down` and `coming-up` is neither edge: a reader asking
 * whether it may act gets the same answer from both.
 * @returns {() => void} unsubscribe
 */
function onDown(name, fn) {
  return onTransition(name, (record) => {
    if (record.from === STATE.UP && record.to !== STATE.UP) fn();
  });
}

/**
 * Call `fn()` the first time a capability comes up in this process: at once if
 * it already has. For work that runs at a named point in boot and never again.
 */
function onFirstUp(name, fn) {
  const entry = entryOf(name);
  if (entry.everUp) {
    fn();
    return;
  }
  emitter.once(`${name}:first-up`, () => fn());
}

/**
 * Every present capability's state, since when, why, and what it waits on.
 * @returns {Array<{name: string, owner: string, needs: string[], state: string,
 *   since: number, reason: string, waitingOn: string|null}>}
 */
function snapshot() {
  return DEFINITIONS.filter(({ name }) => entryOf(name).present).map(({ name, owner, needs }) => {
    const entry = entryOf(name);
    let waitingOn = null;
    if (entry.state !== STATE.UP) waitingOn = entry.held ? firstDownPrerequisite(entry) : name;
    return {
      name, owner, needs: [...needs], state: entry.state, since: entry.since, reason: entry.reason, waitingOn,
    };
  });
}

/** Every transition this process has made, oldest first. */
function transitions() {
  return history.map((record) => ({ ...record }));
}

/**
 * Raise or lower capabilities as their owners would. Raising one raises its
 * prerequisites too, so it is up; lowering one lowers only it. Unit tests only.
 * @param {string|string[]} nameOrNames
 * @param {boolean} up
 */
function setForTests(nameOrNames, up) {
  const raiseWithNeeds = (name) => {
    const { needs, owner } = entryOf(name).definition;
    needs.forEach(raiseWithNeeds);
    claim(name, owner).raise('test');
  };
  for (const name of namesOf(nameOrNames)) {
    if (up) raiseWithNeeds(name);
    else claim(name, entryOf(name).definition.owner).lower('test');
  }
}

/** Every capability down and unclaimed, with no listeners. Unit tests only. */
function resetForTests() {
  emitter.removeAllListeners();
  init();
}

module.exports = {
  STATE,
  DEFINITIONS,
  claim,
  isUp,
  isPresent,
  stateOf,
  firstNotUp,
  whenUp,
  onTransition,
  onUp,
  onDown,
  onFirstUp,
  snapshot,
  transitions,
  setForTests,
  resetForTests,
};
