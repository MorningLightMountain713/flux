'use strict';

/**
 * Container logs read through flux-telemetryd's query socket.
 *
 * A node reads every container's log one way. The first read decides it: the
 * daemon when its query socket exists, docker when it does not (a node that is
 * not Arcane, or an Arcane image older than the socket). Nothing switches
 * after that. On a daemon node a daemon error is the answer the caller gets,
 * never a docker read that would hide it. Both readers return the same lines,
 * the same result shape and the same cursor, so a viewer cannot tell which
 * one a node uses and a cursor survives a node changing reader.
 *
 * systemd holds the listening socket whether the daemon is running,
 * restarting or stopped, and a connect to a stopped daemon starts it. So a
 * response that ends before its trailer - the daemon restarted mid-read, or
 * cut a read at its deadline - is asked for again, once, of the daemon.
 *
 * The wire format is flux-telemetryd's (src/querysock.rs): one JSON request
 * line; a header line; `{"chunk":N}` lines each followed by N bytes of whole
 * lines joined by "\n"; a trailer line - or an error line in place of the
 * header or the trailer.
 */

const fs = require('node:fs');
const net = require('node:net');

const log = require('../lib/log');

const QUERY_SOCKET = '/run/flux-telemetryd/query.sock';

/** systemd holds the socket, so a connect lands at once or not at all. */
const CONNECT_TIMEOUT_MS = 500;

/**
 * Silence from the daemon past this is a failure. It answers within its 2 s
 * queue wait and its 30 s read deadline.
 */
const IDLE_TIMEOUT_MS = 35_000;

/** A response that ended before its trailer; asked for again once. */
const CUT = 'cut';

let socketPath = QUERY_SOCKET;
let reader = null;

/** An error the daemon answered with, or a failure to get its answer. */
class TelemetryLogError extends Error {
  constructor(code, message) {
    super(`flux-telemetryd ${code}: ${message}`);
    this.name = 'TelemetryLogError';
    this.code = code;
  }
}

/**
 * Whether this node reads container logs through the daemon, decided on the
 * first call and fixed after it.
 *
 * @returns {boolean}
 */
function readsThroughDaemon() {
  if (reader === null) {
    reader = fs.existsSync(socketPath) ? 'daemon' : 'docker';
    log.info(`Container logs on this node are read through ${reader === 'daemon' ? 'flux-telemetryd' : 'docker'}`);
  }
  return reader === 'daemon';
}

/**
 * Point the client at another socket and forget the reader choice. Tests only.
 *
 * @param {string} path
 */
function useSocket(path) {
  socketPath = path;
  reader = null;
}

/**
 * One request, one response: the lines in the order the daemon sent them, and
 * the trailer.
 *
 * @param {object} request
 * @returns {Promise<{lines: string[], trailer: object}>}
 */
function exchange(request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const lines = [];
    let pending = Buffer.alloc(0);
    let chunkBytes = null;
    let header = null;
    let connected = false;
    let settled = false;

    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const connectTimer = setTimeout(() => {
      settle(new TelemetryLogError('unreachable', `no connection within ${CONNECT_TIMEOUT_MS} ms`));
    }, CONNECT_TIMEOUT_MS);

    // Whole lines only, so each chunk decodes on its own. Each data event is at
    // most one socket read, so the event loop is released between chunks.
    const consume = () => {
      for (;;) {
        if (chunkBytes !== null) {
          if (pending.length < chunkBytes) return;
          const body = pending.toString('utf8', 0, chunkBytes);
          pending = pending.subarray(chunkBytes);
          chunkBytes = null;
          const split = body.split('\n');
          for (let i = 0; i < split.length; i += 1) lines.push(split[i]);
          continue;
        }
        const newline = pending.indexOf(0x0a);
        if (newline === -1) return;
        const control = JSON.parse(pending.toString('utf8', 0, newline));
        pending = pending.subarray(newline + 1);
        if (control.ok === false) {
          settle(new TelemetryLogError(control.error, control.message));
          return;
        }
        if (header === null) {
          header = control;
        } else if (Number.isInteger(control.chunk)) {
          chunkBytes = control.chunk;
        } else if (control.end === true) {
          settle(null, { lines, trailer: control });
          return;
        } else {
          settle(new TelemetryLogError('bad_response', 'a control line that is not a chunk, a trailer or an error'));
          return;
        }
      }
    };

    socket.on('connect', () => {
      connected = true;
      clearTimeout(connectTimer);
      socket.setTimeout(IDLE_TIMEOUT_MS);
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (data) => {
      pending = pending.length ? Buffer.concat([pending, data]) : data;
      try {
        consume();
      } catch (error) {
        settle(new TelemetryLogError('bad_response', error.message));
      }
    });
    socket.on('timeout', () => {
      settle(new TelemetryLogError('timeout', `nothing from the daemon for ${IDLE_TIMEOUT_MS / 1000} s`));
    });
    socket.on('error', (error) => {
      if (connected) settle(new TelemetryLogError(CUT, error.message));
      else settle(new TelemetryLogError('unreachable', error.message));
    });
    socket.on('close', () => {
      settle(new TelemetryLogError(CUT, 'the response ended before its trailer'));
    });
  });
}

/**
 * The exchange, asked again once if the response was cut.
 *
 * @param {object} request
 * @returns {Promise<{lines: string[], trailer: object}>}
 */
async function query(request) {
  try {
    return await exchange(request);
  } catch (error) {
    if (error.code !== CUT) throw error;
    return exchange(request);
  }
}

/**
 * A cursor position as the daemon takes it. The file identity travels as
 * strings: JSON numbers become doubles, exact only up to 2^53.
 *
 * @param {{ms: number, count: number, ino?: string, firstNs?: string, off?: number}} position
 * @returns {object}
 */
function toWire(position) {
  return {
    ms: Math.floor(position.ms),
    count: position.count,
    ...(position.ino !== undefined && { ino: position.ino }),
    ...(position.firstNs !== undefined && { first_ns: position.firstNs }),
    ...(position.off !== undefined && { off: position.off }),
  };
}

/**
 * @param {object|null} wire the trailer's position
 * @returns {{ms: number, count: number, ino?: string, firstNs?: string, off?: number}|null}
 */
function fromWire(wire) {
  if (!wire) return null;
  return {
    ms: wire.ms,
    count: wire.count,
    ...(wire.ino !== undefined && { ino: wire.ino }),
    ...(wire.first_ns !== undefined && { firstNs: wire.first_ns }),
    ...(wire.off !== undefined && { off: wire.off }),
  };
}

/**
 * The daemon's answer to a log poll, in the shape dockerService's docker
 * reader gives: the same request rules (a `since` filter keeps its line
 * limit; a position reads one page past it; neither takes the newest
 * `lineCount`), and `truncated` decided the same way.
 *
 * @param {string} containerId 64-hex
 * @param {{position: object|null, since: number|null, lineCount: number|'all', maxLines: number}} options
 * @returns {Promise<{lines: string[], position: object|null, rolledOver: boolean, truncated: boolean, skipped: boolean}>}
 */
async function readPolling(containerId, options = {}) {
  const {
    position = null, since = null, lineCount = 'all', maxLines = 5000,
  } = options;

  const request = {
    v: 1, op: 'read', container: containerId, timestamps: true,
  };
  if (since !== null) {
    request.since_ms = Math.max(0, Math.floor(since));
    if (lineCount && lineCount !== 'all') request.tail = lineCount;
  } else if (position) {
    request.position = toWire(position);
    request.max_lines = maxLines;
  } else if (lineCount && lineCount !== 'all') {
    request.tail = lineCount;
  }

  const { lines, trailer } = await query(request);
  return {
    lines,
    position: fromWire(trailer.position),
    rolledOver: trailer.rolled_over,
    truncated: position === null && lineCount !== 'all' && lines.length >= lineCount,
    skipped: trailer.skipped,
  };
}

/**
 * The last `lines` entries of a container's log as the text docker returns
 * without timestamps.
 *
 * Read with timestamps and the stamp taken off each line: the daemon drops a
 * line that is only whitespace, and with its stamp no line is, so a blank
 * entry survives as the empty line docker gives.
 *
 * @param {string} containerId 64-hex
 * @param {number|string} lines a whole number, or 'all'
 * @returns {Promise<string>}
 */
async function readText(containerId, lines) {
  const request = {
    v: 1, op: 'read', container: containerId, timestamps: true,
  };
  if (lines !== 'all') {
    const tail = Number(lines);
    if (!Number.isInteger(tail) || tail < 0) throw new Error(`Log line count ${lines} is not a whole number or 'all'`);
    request.tail = tail;
  }
  const { lines: stamped } = await query(request);
  let text = '';
  for (let i = 0; i < stamped.length; i += 1) {
    text += `${stamped[i].slice(stamped[i].indexOf(' ') + 1)}\n`;
  }
  return text;
}

module.exports = {
  QUERY_SOCKET,
  TelemetryLogError,
  readsThroughDaemon,
  readPolling,
  readText,
  useSocket,
};
