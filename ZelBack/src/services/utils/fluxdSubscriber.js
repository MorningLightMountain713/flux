const zmq = require('zeromq');

const log = require('../../lib/log');
const decoders = require('./fluxdZmqDecoders');

const DEFAULT_ENDPOINT = 'tcp://127.0.0.1:16123';

// Reconnect and heartbeat are library-level; libzmq re-establishes a dropped
// connection on its own and tells us nothing, so the socket's own event stream is
// the only way to know it happened. Defaults only — the caller passes the
// configured values, and the harness compresses them to assert the teardown.
const DEFAULT_SOCKET_OPTIONS = {
  reconnectInterval: 500,
  reconnectMaxInterval: 15_000,
  heartbeatInterval: 5_000,
  heartbeatTimeout: 20_000,
  connectTimeout: 3_000,
};

// One block's worth of deltas is a single message, so this holds hours of them and
// is generous rather than shallow. The number that decides whether messages are lost
// is fluxd's, not ours: it sets no send-side high water mark, so libzmq's default of
// 1000 applies, shared across every topic bound to the one endpoint, and a PUB socket
// with no XPUB_NODROP discards silently when that fills. Gap detection and resync are
// therefore the only recovery for a dropped delta, which is why they carry the weight
// they do here.
const DEFAULT_RECEIVE_HIGH_WATER_MARK = 400;

/**
 * One subscription to fluxd's ZMQ publisher.
 *
 * Three things about this transport shape the code. The socket reconnects silently,
 * so absence of messages carries no information and liveness has to be decided
 * elsewhere — this exposes the elapsed time and leaves the verdict to a caller that
 * can afford an RPC. Sequence numbers are per topic and live in the daemon's memory,
 * so they restart from zero whenever fluxd does and a reset must not be read as loss.
 * And the publisher drops rather than blocks, so a gap is a normal event to be
 * recovered from, not an error.
 *
 * @param {object} options
 * @param {string} [options.endpoint] publisher address
 * @param {Array<string>} options.topics topic names to subscribe
 * @param {function} options.onMessage called with (topic, decoded, seq)
 * @param {function} [options.onGap] called with (topic, missed) when sequence skips
 * @param {function} [options.onConnect] called on every connect, including reconnects
 * @param {function} [options.onDisconnect] called when the socket reports a drop
 * @param {number} [options.receiveHighWaterMark]
 * @returns {object} start, stop, connected, elapsedSinceMessageMs, subscribedTopics
 */
function createFluxdSubscriber(options) {
  const {
    endpoint = DEFAULT_ENDPOINT,
    topics,
    onMessage,
    onGap = null,
    onConnect = null,
    onDisconnect = null,
    receiveHighWaterMark = DEFAULT_RECEIVE_HIGH_WATER_MARK,
    reconnectIntervalMs,
    reconnectMaxIntervalMs,
    heartbeatIntervalMs,
    heartbeatTimeoutMs,
    connectTimeoutMs,
  } = options;

  if (!Array.isArray(topics) || !topics.length) {
    throw new Error('At least one topic is mandatory');
  }

  if (typeof onMessage !== 'function') {
    throw new Error('An onMessage handler is mandatory');
  }

  const socketOptions = {
    ...DEFAULT_SOCKET_OPTIONS,
    ...(reconnectIntervalMs === undefined ? {} : { reconnectInterval: reconnectIntervalMs }),
    ...(reconnectMaxIntervalMs === undefined ? {} : { reconnectMaxInterval: reconnectMaxIntervalMs }),
    ...(heartbeatIntervalMs === undefined ? {} : { heartbeatInterval: heartbeatIntervalMs }),
    ...(heartbeatTimeoutMs === undefined ? {} : { heartbeatTimeout: heartbeatTimeoutMs }),
    ...(connectTimeoutMs === undefined ? {} : { connectTimeout: connectTimeoutMs }),
  };

  let socket = null;
  let stopped = false;
  let isConnected = false;
  let lastMessageAt = null;
  const lastSequence = new Map();

  // A handler must never take the loop down with it. Called synchronously so a
  // consumer that does not await still sees the message before control returns.
  function guarded(what, fn) {
    try {
      const result = fn();
      if (result && typeof result.catch === 'function') {
        result.catch((err) => log.error(`fluxdSubscriber - ${what} error: ${err.message}`));
      }
    } catch (err) {
      log.error(`fluxdSubscriber - ${what} error: ${err.message}`);
    }
  }

  /**
   * Compares this message's sequence with the last seen for its topic.
   * @param {string} topic Topic name.
   * @param {number} seq Sequence from the message's third frame.
   * @returns {number} Count of missed messages, zero when contiguous or restarted.
   */
  function missedSince(topic, seq) {
    const previous = lastSequence.get(topic);
    lastSequence.set(topic, seq);

    if (previous === undefined) return 0;

    // fluxd holds the counter in memory, so a restart rewinds it. That is a
    // daemon restart, not lost messages — and the caller has already been told
    // to rebuild by the reconnect.
    if (seq <= previous) {
      log.info(`fluxdSubscriber - ${topic} sequence restarted at ${seq}, daemon was restarted`);
      return 0;
    }

    return seq - previous - 1;
  }

  async function consumeMessages() {
    try {
      // eslint-disable-next-line no-restricted-syntax
      for await (const frames of socket) {
        if (stopped) break;

        if (frames.length < 3) {
          log.warn(`fluxdSubscriber - discarding message with ${frames.length} frames`);
          // eslint-disable-next-line no-continue
          continue;
        }

        const [topicFrame, payload, sequenceFrame] = frames;
        const topic = topicFrame.toString();
        const seq = sequenceFrame.readUInt32LE(0);

        lastMessageAt = process.hrtime.bigint();

        const missed = missedSince(topic, seq);
        if (missed && onGap) {
          log.warn(`fluxdSubscriber - ${topic} missed ${missed} message(s) before seq ${seq}`);
          guarded(`${topic} gap handler`, () => onGap(topic, missed));
        }

        let decoded = null;
        try {
          decoded = decoders.decode(topic, payload);
        } catch (err) {
          log.error(`fluxdSubscriber - ${topic} decode failed at seq ${seq}: ${err.message}`);
          // eslint-disable-next-line no-continue
          continue;
        }

        guarded(`${topic} handler`, () => onMessage(topic, decoded, seq));
      }
    } catch (err) {
      if (!stopped) log.error(`fluxdSubscriber - message loop ended: ${err.message}`);
    }
  }

  async function consumeSocketEvents() {
    try {
      // eslint-disable-next-line no-restricted-syntax
      for await (const event of socket.events) {
        if (stopped) break;

        if (event.type === 'connect') {
          const reconnected = isConnected === false && lastMessageAt !== null;
          isConnected = true;
          log.info(`fluxdSubscriber - connected to ${endpoint}`);
          if (onConnect) guarded('connect handler', () => onConnect({ reconnected }));
        } else if (event.type === 'disconnect' || event.type === 'end') {
          isConnected = false;
          log.warn(`fluxdSubscriber - ${event.type} from ${endpoint}`);
          if (onDisconnect) guarded('disconnect handler', () => onDisconnect());
        }
      }
    } catch (err) {
      if (!stopped) log.error(`fluxdSubscriber - event loop ended: ${err.message}`);
    }
  }

  /**
   * Opens the socket and begins consuming. Returns once both loops are running;
   * the loops themselves run until stop().
   * @returns {void}
   */
  function start() {
    if (socket || stopped) return;

    socket = new zmq.Subscriber({ ...socketOptions, receiveHighWaterMark });
    socket.connect(endpoint);
    topics.forEach((topic) => socket.subscribe(topic));

    log.info(`fluxdSubscriber - subscribing to ${topics.join(', ')} on ${endpoint}`);

    consumeMessages();
    consumeSocketEvents();
  }

  /**
   * Closes the socket, which ends both loops.
   * @returns {void}
   */
  function stop() {
    stopped = true;
    isConnected = false;

    if (socket) {
      socket.close();
      socket = null;
    }

    lastSequence.clear();
  }

  /**
   * Whether the socket last reported itself connected. Not a liveness signal — a
   * connected socket to a wedged daemon looks identical to a healthy one.
   * @returns {boolean} Connection state.
   */
  function connected() {
    return isConnected;
  }

  /**
   * Milliseconds since the last message on any topic, from the monotonic clock so a
   * wall-clock correction cannot make a healthy daemon look dead.
   * @returns {number|null} Elapsed milliseconds, or null before the first message.
   */
  function elapsedSinceMessageMs() {
    if (lastMessageAt === null) return null;
    return Number(process.hrtime.bigint() - lastMessageAt) / 1_000_000;
  }

  return {
    connected,
    elapsedSinceMessageMs,
    start,
    stop,
    subscribedTopics: () => [...topics],
  };
}

module.exports = {
  createFluxdSubscriber,
  DEFAULT_ENDPOINT,
  DEFAULT_RECEIVE_HIGH_WATER_MARK,
};
