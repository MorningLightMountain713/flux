'use strict';

/**
 * A stand-in for flux-telemetryd's query socket, speaking its wire format
 * (flux-telemetryd src/querysock.rs), for tests of the log client and of
 * the readers built on it.
 */

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const HEADER = { v: 1, ok: true, files: [] };

/**
 * A stand-in for flux-telemetryd's query socket. Each connection's request is
 * recorded and handed to `respond(request, socket, n)`, n counting from 1.
 */
async function fakeDaemon(respond) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-log-'));
  const socketPath = path.join(dir, 'query.sock');
  const requests = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffered = '';
    let answered = false;
    socket.on('data', (data) => {
      buffered += data;
      const newline = buffered.indexOf('\n');
      if (answered || newline === -1) return;
      answered = true;
      const request = JSON.parse(buffered.slice(0, newline));
      requests.push(request);
      respond(request, socket, requests.length);
    });
  });
  await new Promise((resolve) => { server.listen(socketPath, resolve); });
  return {
    socketPath,
    requests,
    async close() {
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolve) => { server.close(resolve); });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function control(socket, line) {
  socket.write(`${JSON.stringify(line)}\n`);
}

function chunk(socket, lines) {
  const body = Buffer.from(lines.join('\n'));
  socket.write(`{"chunk":${body.length}}\n`);
  socket.write(body);
}

function trailer(lines, extra = {}) {
  return {
    end: true, lines: lines.length, position: null, rolled_over: false, skipped: false, ...extra,
  };
}

/** A whole answer: header, the lines in one chunk, trailer. */
function answer(socket, lines, extra) {
  control(socket, HEADER);
  if (lines.length) chunk(socket, lines);
  socket.end(`${JSON.stringify(trailer(lines, extra))}\n`);
}

module.exports = {
  HEADER, fakeDaemon, control, chunk, trailer, answer,
};
