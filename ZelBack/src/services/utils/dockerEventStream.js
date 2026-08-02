const log = require('../../lib/log');
const dockerService = require('../dockerService');

const DEFAULT_RESUBSCRIBE_DELAY_MS = 10000;

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
 * @param {number} [options.resubscribeDelayMs]
 * @returns {{start: function, stop: function, connected: function}}
 */
function createDockerEventStream(options) {
  const {
    label,
    filters,
    onEvent,
    onReconnect = null,
    resubscribeDelayMs = DEFAULT_RESUBSCRIBE_DELAY_MS,
  } = options;

  let stream = null;
  let stopped = false;
  let subscribing = false;
  let resubscribeTimer = null;
  let lineBuf = '';
  let hasConnected = false;

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

  // Every way a stream can die ('error', 'end', a raw 'close', or a failed
  // subscribe) funnels here, and the timer guard collapses them: one outage
  // produces exactly one new stream.
  function scheduleResubscribe(reason) {
    if (stopped || resubscribeTimer || stream) return;
    log.warn(`${label} - event stream ${reason}; resubscribing in ${resubscribeDelayMs / 1000}s`);
    resubscribeTimer = setTimeout(() => {
      resubscribeTimer = null;
      // eslint-disable-next-line no-use-before-define
      subscribe();
    }, resubscribeDelayMs);
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

module.exports = { createDockerEventStream, DEFAULT_RESUBSCRIBE_DELAY_MS };
