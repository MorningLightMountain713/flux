'use strict';

const log = require('../../lib/log');
const dockerService = require('../dockerService');

// A lost stream is retried from a short delay, doubling while docker stays
// away: a daemon restart is back in a second or two, a daemon that is gone
// is not polled every second for it.
const RESUBSCRIBE_FIRST_DELAY_MS = 1000;
const RESUBSCRIBE_MAX_DELAY_MS = 10_000;

/**
 * One Docker event subscription, with the plumbing every consumer of it needs.
 *
 * Docker's event endpoint is a raw byte stream of newline-delimited JSON, and a
 * consumer that reads it naively gets three things wrong. Chunks do not align to
 * lines, so an event straddling a chunk boundary is lost or mis-parsed. A dying
 * stream emits some combination of 'error', 'end' and a raw 'close', so
 * resubscribing on each one silently doubles the stream and every event is then
 * handled twice. And a late signal from an already-replaced stream retires its
 * healthy successor.
 *
 * This is a factory rather than a module singleton so a process can hold several
 * subscriptions with different filters — the playground watches only its own
 * labelled containers, and must not receive, or be able to disturb, the
 * reconciler's.
 *
 * @param {object} options
 * @param {string} options.label prefix for this subscription's log lines
 * @param {object} options.filters docker event filters, passed through verbatim
 * @param {function} options.onEvent called with each parsed event; may be async,
 *   and a rejection is logged rather than left unhandled
 * @param {function} [options.onReconnect] called after a RE-connection only, never
 *   the first: events during the outage are gone, so a consumer that cares needs
 *   to resynchronise from actual state
 * @param {function} [options.onConnected] called on every edge to connected, the
 *   first connection included: docker is answering
 * @param {function} [options.onDisconnected] called with the reason on every edge
 *   to disconnected, a failed first subscription included: docker is not answering
 * @param {number} [options.resubscribeDelayMs] the first retry's delay after a
 *   loss; each failed retry doubles it up to resubscribeMaxDelayMs, and a
 *   connection resets it
 * @param {number} [options.resubscribeMaxDelayMs]
 * @returns {{start: function, stop: function, connected: function}}
 */
function createDockerEventStream(options) {
  const {
    label,
    filters,
    onEvent,
    onReconnect = null,
    onConnected = null,
    onDisconnected = null,
    resubscribeDelayMs = RESUBSCRIBE_FIRST_DELAY_MS,
    resubscribeMaxDelayMs = RESUBSCRIBE_MAX_DELAY_MS,
  } = options;

  let stream = null;
  let stopped = false;
  let subscribing = false;
  let resubscribeTimer = null;
  let nextDelayMs = resubscribeDelayMs;
  let lineBuf = '';
  let hasConnected = false;
  // The last state reported to onConnected/onDisconnected: edges only, so one
  // outage's several signals and failed retries report one disconnection.
  let reportedConnected = null;

  // Call synchronously — a consumer that handles an event without awaiting must
  // see it before control returns — and guard both a synchronous throw and a
  // rejected promise, so one bad event can never take the stream down.
  function guarded(what, fn) {
    try {
      const result = fn();
      if (result && typeof result.catch === 'function') {
        result.catch((err) => log.error(`${label} - ${what} error: ${err.message}`));
      }
    } catch (err) {
      log.error(`${label} - ${what} error: ${err.message}`);
    }
  }

  function report(connected, reason) {
    if (reportedConnected === connected) return;
    reportedConnected = connected;
    if (connected && onConnected) guarded('connected handler', onConnected);
    if (!connected && onDisconnected) guarded('disconnected handler', () => onDisconnected(reason));
  }

  // Every way a stream can die ('error', 'end', a raw 'close', or a failed
  // subscribe) funnels here, and the timer guard collapses them: one outage
  // produces exactly one new stream.
  function scheduleResubscribe(reason) {
    if (stopped || resubscribeTimer || stream) return;
    report(false, reason);
    log.warn(`${label} - event stream ${reason}; resubscribing in ${nextDelayMs / 1000}s`);
    resubscribeTimer = setTimeout(() => {
      resubscribeTimer = null;
      // eslint-disable-next-line no-use-before-define
      subscribe();
    }, nextDelayMs);
    nextDelayMs = Math.min(nextDelayMs * 2, resubscribeMaxDelayMs);
  }

  async function subscribe() {
    if (stream || subscribing || stopped) return;
    subscribing = true;
    lineBuf = '';

    try {
      const opened = await dockerService.dockerGetEvents({ filters });
      // A stop landing during the await must not leave a live stream behind with
      // nothing holding it.
      if (stopped) {
        opened.destroy();
        return;
      }
      stream = opened;

      // Scoped to THIS stream: a late signal from an already replaced one must
      // not retire its healthy successor.
      const onGone = (reason) => {
        if (stream === opened) stream = null;
        scheduleResubscribe(reason);
      };

      opened.on('data', (buf) => {
        if (stopped || stream !== opened) return;
        lineBuf += buf.toString();
        const lines = lineBuf.split('\n');
        // The trailing fragment is whatever came after the last newline: an
        // incomplete event, held until the rest of it arrives.
        lineBuf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch (parseErr) {
            log.error(`${label} - failed to parse docker event: ${parseErr.message}`);
            continue;
          }
          guarded('event handler', () => onEvent(event));
        }
      });

      opened.on('error', (err) => {
        log.error(`${label} - event stream error: ${err.message}`);
        onGone('errored');
      });
      opened.on('end', () => onGone('ended'));
      // a raw socket teardown can emit 'close' without 'error' or 'end'
      opened.on('close', () => onGone('closed'));

      log.info(`${label} - listening for docker events`);
      nextDelayMs = resubscribeDelayMs;

      report(true, 'connected');
      if (hasConnected && onReconnect) guarded('reconnect handler', onReconnect);
      hasConnected = true;
    } catch (err) {
      log.error(`${label} - failed to subscribe to docker events: ${err.message}`);
      scheduleResubscribe('subscribe failed');
    } finally {
      subscribing = false;
    }
  }

  return {
    async start() {
      stopped = false;
      hasConnected = false;
      reportedConnected = null;
      nextDelayMs = resubscribeDelayMs;
      await subscribe();
    },
    stop() {
      stopped = true;
      if (resubscribeTimer) {
        clearTimeout(resubscribeTimer);
        resubscribeTimer = null;
      }
      if (stream) {
        stream.destroy();
        stream = null;
      }
    },
    connected() {
      return Boolean(stream);
    },
  };
}

module.exports = { createDockerEventStream, RESUBSCRIBE_FIRST_DELAY_MS, RESUBSCRIBE_MAX_DELAY_MS };
