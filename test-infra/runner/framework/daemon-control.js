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

export async function queueAppTx(appHash) {
  return post('/queue-app-tx', { appHash });
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

export async function getJournal({ method, sourceIp } = {}) {
  const params = new URLSearchParams();
  if (method) params.set('method', method);
  if (sourceIp) params.set('sourceIp', sourceIp);
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
