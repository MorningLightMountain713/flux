import { getSubnetConfig } from './subnet-config.js';

const CONTROL = process.env.DAEMON_CONTROL || `http://${getSubnetConfig().daemon}:18232`;

async function post(path, body) {
  const res = await fetch(`${CONTROL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function del(path) {
  const res = await fetch(`${CONTROL}${path}`, { method: 'DELETE' });
  return res.json();
}

async function get(path) {
  const res = await fetch(`${CONTROL}${path}`);
  return res.json();
}

export async function getState() {
  return get('/state');
}

// -- Ticker --

export async function startTicker() {
  return post('/ticker/start');
}

export async function stopTicker() {
  return post('/ticker/stop');
}

// -- Block control --

export async function advanceBlock(appHash) {
  return post('/advance-block', appHash ? { appHash } : {});
}

export async function advanceBlocks(count) {
  for (let i = 0; i < count; i++) {
    // eslint-disable-next-line no-await-in-loop
    await advanceBlock();
  }
}

export async function setHeight(height) {
  return post('/set-height', { height });
}

// valueSat: what the confirming tx pays, in satoshis. Omit it for the stub's
// default, which clears any fee; name it to sit either side of one.
export async function queueAppTx(appHash, valueSat) {
  return post('/queue-app-tx', valueSat === undefined ? { appHash } : { appHash, valueSat });
}

// Advance one block carrying an explicit transaction (e.g. a soft-fork message tx).
export async function injectBlock(tx) {
  return post('/advance-block', { block: { tx: [tx] } });
}

// -- Per-node status --

export async function setNodeStatus(ip, status) {
  return post(`/node-status/${ip}`, { status });
}

export async function clearNodeStatus(ip) {
  return del(`/node-status/${ip}`);
}

export async function setAllNodeStatus(status) {
  return post('/node-status/all', { status });
}

export async function clearAllNodeStatus() {
  return del('/node-status/all');
}

export async function getNodeStatusOverrides() {
  return get('/node-status');
}

// -- Deterministic list --

// Seed the stub's node list with a known set (each entry needs at least an `ip`),
// updating the restore/reset baseline too — mirrors the harness's setup POST. Use
// in nodes:0 suites that exercise the node-list endpoints, which otherwise start
// from an empty list.
export async function setNodeList(nodes) {
  return post('/set-node-list', { nodes });
}

export async function removeFromNodeList(ip) {
  return post(`/node-list/remove/${ip}`);
}

export async function restoreToNodeList(ip) {
  return post(`/node-list/restore/${ip}`);
}

export async function resetNodeList() {
  return post('/node-list/reset');
}

// -- Node tier --

export async function setNodeTier(ip, tier) {
  return post(`/node-tier/${ip}`, { tier });
}

// -- RPC failure --

export async function enableRpcFailure(ip) {
  return post(`/rpc-fail/${ip}`);
}

export async function disableRpcFailure(ip) {
  return del(`/rpc-fail/${ip}`);
}

export async function enableAllRpcFailure() {
  return post('/rpc-fail/all');
}

export async function disableAllRpcFailure() {
  return del('/rpc-fail/all');
}

// -- Request journal --

/**
 * The RPC calls the stub has answered.
 *
 * `server` matters whenever the method is one both servers answer — getinfo, help and
 * stop exist on fluxd and on fluxbenchd, and they share this journal.
 *
 * `limit` caps the entries returned, not the count: `total` is always the full number
 * of matches. Without it the stub returns its own default of 100, so a suite counting
 * more than that must ask for more.
 *
 * @param {{method?: string, sourceIp?: string, server?: 'fluxd'|'benchd', limit?: number}} filter
 * @returns {Promise<{total: number, entries: Array<object>}>}
 */
export async function getJournal({
  method, sourceIp, server, limit,
} = {}) {
  const params = new URLSearchParams();
  if (method) params.set('method', method);
  if (sourceIp) params.set('sourceIp', sourceIp);
  if (server) params.set('server', server);
  if (limit !== undefined) params.set('limit', String(limit));
  return get(`/journal?${params}`);
}

export async function clearJournal() {
  return del('/journal');
}

// -- Seeded RPC data --

export async function seedAddressDeltas(deltas) {
  return post('/seed-address-deltas', { deltas });
}

export async function seedAddressTxids(txids) {
  return post('/seed-address-txids', { txids });
}

export async function seedTransaction(txid, tx) {
  return post('/seed-transaction', { txid, tx });
}

export async function clearSeededData() {
  return del('/seed-data');
}

// -- Reset --

export async function resetAll() {
  return post('/reset');
}

// -- Chain reorganisation --

/**
 * Rewinds to a fork point and rebuilds above it on a different chain.
 *
 * Both channels then tell the same story: chainreorg is pushed with the old tip, the
 * new tip and the fork, a fluxnodelistdelta flagged as a reorg re-anchors the node
 * list, and every block RPC above the fork answers with the new chain's hashes.
 *
 * @param {{forkHeight?: number, depth?: number, newHeight?: number}} options
 *   forkHeight - the last block both chains share; defaults to the tip minus `depth`.
 *   depth      - how far back the fork is when forkHeight is not given. Default 1.
 *   newHeight  - the new tip's height. Defaults to the old tip's — a same-height reorg;
 *                a lower value rewinds the chain.
 * @returns {Promise<{oldTip: object, newTip: object, fork: object}>} What was published.
 */
export async function reorgChain(options = {}) {
  return post('/reorg', options);
}

// -- ZMQ publisher --

/**
 * Publishes one message on the daemon's push socket. The generic primitive: a suite
 * expresses a scenario by what it sends, not by asking the stub for a new endpoint.
 *
 * Give it either `fields` — the topic's fields, which the stub encodes the way fluxd
 * would — or `payload`, a raw payload string for a hand-crafted or deliberately
 * malformed frame. `seq` stamps a chosen sequence and the topic's counter continues
 * from there, which is how a replay or a jump is expressed; omit it for the next in
 * sequence.
 *
 * @param {{topic: string, fields?: object, payload?: string, encoding?: 'hex'|'base64',
 *   seq?: number}} message
 * @returns {Promise<{topic: string, sent: boolean, seq?: number, bytes?: number, reason?: string}>}
 */
export async function publishZmq(message) {
  return post('/zmq/publish', message);
}

/**
 * Burns sequence numbers without sending anything — the gap a dropped message leaves,
 * which the client should notice at the next message and repair by resyncing.
 * @param {string} topic Topic name.
 * @param {number} count How many sequence numbers to skip.
 * @returns {Promise<{topic: string, skipped: number, nextSeq: number}>}
 */
export async function skipZmqSeq(topic, count = 1) {
  return post('/zmq/skip', { topic, count });
}

/**
 * Stops publishing a topic (or everything) while leaving the socket open, so the client
 * stays connected and simply hears nothing.
 * @param {string} topic Topic name, or 'all'.
 * @returns {Promise<{silenced: Array<string>}>}
 */
export async function silenceZmq(topic = 'all') {
  return post('/zmq/silence', { topic });
}

/**
 * Resumes publishing — one topic, or everything when called with no argument.
 * @param {string} [topic] Topic name.
 * @returns {Promise<{silenced: Array<string>}>}
 */
export async function resumeZmq(topic) {
  return del(topic ? `/zmq/silence?topic=${encodeURIComponent(topic)}` : '/zmq/silence');
}

/**
 * Closes and rebinds the publisher: a daemon restart, with every sequence counter back
 * at zero. The client must read that as a restart rather than as messages it missed.
 * @returns {Promise<{restarted: boolean, bound: boolean, endpoint: string}>}
 */
export async function restartZmqPublisher() {
  return post('/zmq/restart');
}

/**
 * The publisher's state: whether it is bound, the topics it knows, the sequence each
 * will send next, the last it sent, and which are silenced.
 * @returns {Promise<object>}
 */
export async function getZmqState() {
  return get('/zmq/state');
}

// -- Benchmark channel (fluxbenchd stub) --

const BENCHD = process.env.BENCHD_URL || `http://${getSubnetConfig().daemon}:16224`;

/**
 * Call the benchmark stub's JSON-RPC directly — the same interface the node uses.
 *
 * Suites reach the signer this way rather than importing daemon-stub/benchCrypto
 * into the runner process. That import only works when the stub's dependencies
 * happen to be installed on the host, and they are not: they live in the stub's
 * image. Going over the wire also means a suite asks the signer the same question
 * FDM asks it, instead of re-deriving the answer alongside it.
 *
 * @param {string} method e.g. 'cacertificate'
 * @param {Array<string>} params the stub's params array (a JSON string, or a query string)
 */
export async function benchRpc(method, params = []) {
  const res = await fetch(BENCHD, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params, id: 1 }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`benchd ${method} failed: ${JSON.stringify(body.error)}`);
  // The stub mirrors fluxbenchd's convention: result is a JSON *string* carrying
  // { status, ... }.
  const parsed = typeof body.result === 'string' ? JSON.parse(body.result) : body.result;
  if (!parsed || parsed.status !== 'ok') throw new Error(`benchd ${method} returned ${JSON.stringify(parsed)}`);
  return parsed;
}

/** An app's backend-TLS CA certificate (PEM), fetched the way FDM fetches it. */
export async function appCaCertificate(appName) {
  const { certificate } = await benchRpc('cacertificate', [`appName=${encodeURIComponent(appName)}`]);
  return certificate;
}
