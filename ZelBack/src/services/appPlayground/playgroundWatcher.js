'use strict';

const log = require('../../lib/log');
const dockerService = require('../dockerService');
const dockerEventStream = require('../utils/dockerEventStream');
const { getSpecBackend } = require('../utils/specLibs');

/**
 * What one session's containers are doing, kept current from Docker's event
 * stream rather than by asking on a timer.
 *
 * Its own subscription, filtered at the daemon to this session's label, so it
 * receives only its own containers and cannot see - or disturb - the
 * reconciler's. The bridge drops anything carrying the playground label for the
 * same reason from the other side.
 *
 * A session component that dies IS the result its owner is being shown, so
 * nothing here decides anything: it records what happened and wakes whoever is
 * waiting.
 *
 * @param {string} sessionId
 * @returns {object} watcher
 */
function createSessionWatcher(sessionId) {
  const states = new Map();
  const waiters = new Set();
  let subscription = null;
  // Set at start(), read by onEvent: events name containers by their DOCKER
  // name, and the identity label in the same Attributes bag is what maps one
  // back to the component identifier the states are keyed by.
  let labelKeys = null;

  function stateFor(identifier) {
    if (!states.has(identifier)) {
      states.set(identifier, {
        known: false,
        running: false,
        gone: false,
        exitCode: null,
        health: null,
        // Whether the image declares a health check at all. An image without
        // one never emits a health_status event, so its absence has to be read
        // from an inspect, not inferred from silence.
        hasHealthCheck: false,
        // The container's address on the session network, kept because the TCP
        // rung of the probe needs it and this already has the inspect in hand.
        address: null,
      });
    }
    return states.get(identifier);
  }

  function wake() {
    const waking = [...waiters];
    waiters.clear();
    for (const resolve of waking) resolve();
  }

  /**
   * Read the authoritative state of one container. Docker carries a health
   * transition only as a free-form Action suffix ("health_status: unhealthy")
   * with no structured field, so the status is read from an inspect rather than
   * parsed out of the event text - the same rule containerEventBridge follows.
   */
  async function refresh(identifier) {
    const state = stateFor(identifier);
    let info = null;
    try {
      info = await dockerService.dockerContainerInspect(identifier);
    } catch (error) {
      log.warn(`playground: could not inspect ${identifier}: ${error.message}`);
      return;
    }

    if (!info) {
      // Absent is only "destroyed" for a container that has ever been seen —
      // the runner deliberately subscribes (and so snapshots) BEFORE it
      // creates the session's containers, so a never-seen identifier is
      // simply not created yet. Its create/start event or a later refresh
      // fills the state in.
      if (state.known) {
        state.gone = true;
        state.running = false;
      }
      return;
    }
    state.known = true;
    state.gone = false;
    state.running = Boolean(info.State && info.State.Running);
    state.health = (info.State && info.State.Health && info.State.Health.Status) || null;
    state.hasHealthCheck = state.hasHealthCheck || Boolean(info.State && info.State.Health);
    const networks = (info.NetworkSettings && info.NetworkSettings.Networks) || {};
    state.address = Object.values(networks).map((net) => net.IPAddress).find(Boolean) || state.address;
    if (!state.running && info.State && info.State.ExitCode !== undefined) {
      state.exitCode = info.State.ExitCode;
    }
  }

  async function onEvent(event) {
    // The event names its container by DOCKER name; the states here are keyed
    // by the component identifier. The identity label - in the same
    // Actor.Attributes bag as the name - states the identifier outright, and
    // names are never parsed. Every session container is created at the one
    // chokepoint that stamps identity labels, so a missing label is a
    // malformed event, not a legacy container.
    const attributes = (event.Actor && event.Actor.Attributes) || {};
    const identifier = labelKeys ? attributes[labelKeys.IDENTIFIER] : null;
    if (!identifier) {
      log.warn(`playground ${sessionId} - dropped a ${event.Action || event.status || '?'} event for `
        + `${attributes.name || 'an unnamed container'}: no identity label`);
      return;
    }
    const action = event.Action || event.status || '';
    const state = stateFor(identifier);

    if (action === 'die') {
      const parsed = parseInt(event.Actor.Attributes.exitCode, 10);
      state.exitCode = Number.isNaN(parsed) ? null : parsed;
      state.running = false;
      state.known = true;
    } else if (action === 'destroy') {
      state.gone = true;
      state.running = false;
      state.known = true;
    } else if (action === 'start') {
      state.running = true;
      state.gone = false;
      state.known = true;
    } else if (action.startsWith('health_status')) {
      await refresh(identifier);
    } else {
      return;
    }

    wake();
  }

  return {
    /**
     * Subscribe FIRST, then take a snapshot of each container.
     *
     * That order is load-bearing. A container can die between starting and this
     * being called, and inspecting before subscribing leaves a window where the
     * event fires into nothing - the session would then wait out its whole
     * deadline for a verdict that already happened.
     *
     * @param {string[]} identifiers the session's container names
     */
    async start(identifiers) {
      const { LABEL_KEYS } = await getSpecBackend();
      labelKeys = LABEL_KEYS;
      subscription = dockerEventStream.createDockerEventStream({
        label: `playground ${sessionId}`,
        filters: {
          type: ['container'],
          event: ['start', 'die', 'destroy', 'health_status'],
          label: [`${LABEL_KEYS.PLAYGROUND_SESSION}=${sessionId}`],
        },
        onEvent,
        // Events during an outage are gone, so re-read everything rather than
        // assume the silence meant nothing happened.
        onReconnect: () => Promise.all(identifiers.map(refresh)).then(wake),
      });
      await subscription.start();
      await Promise.all(identifiers.map(refresh));
      wake();
    },

    stop() {
      if (subscription) subscription.stop();
      wake();
    },

    /**
     * Release anyone waiting, without anything having changed in docker.
     *
     * For things that happen to a session rather than to its containers - a
     * cancel, an eviction - which no docker event will ever report.
     */
    wake,

    /** @returns {object} the last known state of one container */
    state(identifier) {
      return { ...stateFor(identifier) };
    },

    /** Whether any container of this session is still up. */
    anyRunning(identifiers) {
      return identifiers.some((identifier) => stateFor(identifier).running);
    },

    /**
     * Resolve when something changes, or after `ms` - whichever is first.
     *
     * The timeout is not a poll: it is how a caller bounds its own wait (a
     * deadline, or the cadence of a TCP probe that no event can report). A
     * health-checked container reaching a verdict wakes this immediately.
     *
     * @param {number} ms
     */
    changedOr(ms) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(onChange);
          resolve();
        }, ms);
        function onChange() {
          clearTimeout(timer);
          resolve();
        }
        waiters.add(onChange);
      });
    },

    /** Test seam: re-read one container without waiting for an event. */
    refresh,
  };
}

module.exports = { createSessionWatcher };
