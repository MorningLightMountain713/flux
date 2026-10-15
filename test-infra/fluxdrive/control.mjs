// The GC runner of the real FluxDrive in the harness: FluxDrive's own GC and
// pending-write passes, one at a time, each at the time the request names, in
// place of the service's timers.
//
//   GET  /health   200 once the database is connected and indexed
//   POST /sweep    { now } -> one GC pass at `now` (ms since epoch); its metrics
//   POST /pending  { now } -> one pass over the pending writes at `now`; its counts
import '/app/config/loadEnvironment.js';

import http from 'node:http';
import { mongoConnect, db } from '/app/lib/mongodb.js';
import { ensureIndexes } from '/app/lib/indexes.js';
import { sweepOnce, pendingOnce } from '/app/gc/index.js';

const PORT = Number.parseInt(process.env.CONTROL_PORT ?? '16142', 10);
const CONNECT_RETRY_MS = 1000;

let ready = false;

const passes = {
  '/sweep': sweepOnce,
  '/pending': pendingOnce,
};

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

async function handle(req, res) {
  if (req.method === 'GET' && req.url === '/health') {
    send(res, ready ? 200 : 503, { ready });
    return;
  }
  const pass = req.method === 'POST' ? passes[req.url] : undefined;
  if (!pass) {
    send(res, 404, { error: `no route ${req.method} ${req.url}` });
    return;
  }
  if (!ready) {
    send(res, 503, { error: 'the database is not connected yet' });
    return;
  }
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    send(res, 400, { error: `body is not JSON: ${error.message}` });
    return;
  }
  if (!Number.isSafeInteger(body.now) || body.now <= 0) {
    send(res, 400, { error: 'now must be a positive integer of milliseconds since the epoch' });
    return;
  }
  try {
    send(res, 200, await pass({ now: body.now }));
  } catch (error) {
    send(res, 500, { error: error.message ?? String(error) });
  }
}

function onRequest(req, res) {
  handle(req, res).catch((error) => send(res, 500, { error: error.message ?? String(error) }));
}

async function connect() {
  for (;;) {
    try {
      await mongoConnect();
      await ensureIndexes(db);
      ready = true;
      console.log('fluxdrive gc control: database ready');
      return;
    } catch (error) {
      console.log(`fluxdrive gc control: database not ready (${error.message ?? error})`);
      await new Promise((resolve) => { setTimeout(resolve, CONNECT_RETRY_MS); });
    }
  }
}

http.createServer(onRequest).listen(PORT, () => {
  console.log(`fluxdrive gc control listening on ${PORT}`);
});
connect();
