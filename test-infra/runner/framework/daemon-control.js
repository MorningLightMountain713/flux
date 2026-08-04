import { getSubnetConfig } from './subnet-config.js';
import { loadSharedConfig } from './coupled-knobs.js';

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

/**
 * Drive the chain until a condition holds, at a stated RATE, up to a stated
 * deadline.
 *
 * Two reasons to drive rather than let the ticker free-run:
 *
 * The ticker produces blocks on the same period the explorer polls on, so the
 * node learns about them in bursts and processes a burst back to back - and only
 * the last block of a burst is still the chain tip. FluxOS runs its app
 * maintenance, the give-up pass included, only for a block that was the tip and
 * only on every Nth block, so whether the pass runs at all comes down to which
 * parity the race settles on. Suite 96 asserted that nothing had happened after
 * a 24-block burst and was right for the wrong reason: the pass had run once
 * across five nodes, so there was nothing for the assertion to have caught.
 *
 * And these waits are WALL-CLOCK. A node's queue ticket is real time, so a
 * budget counted in blocks means nothing: the deadline is therefore in
 * milliseconds. The chain's actual rate is not this function's to set - a block
 * is not processed until the node's next explorer poll, so
 * `explorerPollIntervalMs` is the floor, and that floor is what fixes how long a
 * give-up pass takes in wall-clock, which is what the queue step has to outlast.
 * Changing one without the other is what quietly deletes the ordering those
 * tests exist to check.
 *
 * THE RATE IS THE NODE'S POLL, not something faster. Driving four blocks per
 * poll produces four times the work for the same pass cadence: a height only
 * counts when it lands as the tip, tips arrive one per poll, and the pass comes
 * every `removeFluxAppsPeriod x N` polls whatever rate this drives at. The extra
 * blocks are pure load. At 200ms one suite drove about a thousand blocks per
 * wait, held a runner slot for the full 1800s wall clock and starved the box:
 * two unrelated suites ran 3-4x slower in the same gate and hit that wall
 * themselves.
 *
 * @param {object} node The node client to pace against - the one whose
 *   `block:processed` decides when the next block may be sent. A CLIENT, not an
 *   index: the two suites that grew this independently disagreed about whether
 *   the index was 0- or 1-based, which is not a mistake worth leaving available.
 * BUDGETED IN THE UNIT THE CONDITION IS COUNTED IN. A pass that fires on
 * `blockHeight % N === 0` is waiting for BLOCKS, and a wall-clock budget buys a
 * number of them that depends on how busy the box is: 420s buys about 504
 * blocks against an idle daemon and about 84 when the node is slow to process
 * them, so the pass gets six times fewer chances with nothing in the suite
 * saying so. `blocks` is the same count on any box - it takes longer to spend,
 * which is the point.
 *
 * `timeoutMs` is for a wait whose cadence is a real interval - a departure
 * cycle, an election cycle - because seconds are the unit it is counted in.
 * Exactly one of the two, because a block budget with a wall clock beside it is
 * bounded by whichever runs out first, and under load that is always the clock.
 *
 * A block budget carries no outer clock. A node that has stopped processing is
 * caught by the per-block wait below, which gives every block 60s of its own.
 *
 * @param {Function} condition Async predicate; driving stops when it holds.
 * @param {object} opts Exactly one of `blocks` or `timeoutMs`.
 * @param {number} [opts.blocks] Blocks to drive before giving up.
 * @param {number} [opts.timeoutMs] How long to keep driving before giving up.
 * @param {number} [opts.blockIntervalMs] Minimum wall-clock between blocks.
 * @param {string} [opts.label] What the caller was waiting for, for the error.
 * @returns {Promise<number>} Blocks driven.
 */
export async function driveUntil(node, condition, {
  blocks: blockBudget, timeoutMs, blockIntervalMs, label,
} = {}) {
  const budgetedInBlocks = Number.isFinite(blockBudget);
  if (budgetedInBlocks === Number.isFinite(timeoutMs)) {
    // No default for either. Every caller's budget is derived from something of
    // its own, so a shared default would be one suite's number silently applied
    // to another's wait - and naming both leaves the wait bounded by whichever
    // expires first rather than by the one the caller reasoned about.
    throw new Error('driveUntil: exactly one of `blocks` or `timeoutMs` is required');
  }
  const interval = blockIntervalMs ?? loadSharedConfig().fluxapps.explorerPollIntervalMs;
  const deadline = budgetedInBlocks ? Infinity : Date.now() + timeoutMs;
  let blocks = 0;
  while (budgetedInBlocks ? blocks < blockBudget : Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (await condition()) return blocks;
    const startedAt = Date.now();
    const afterId = node.getLastEventId();
    // eslint-disable-next-line no-await-in-loop
    await advanceBlock();
    // eslint-disable-next-line no-await-in-loop
    await node.waitForEvent('block:processed', () => true, 60000, { afterId });
    blocks += 1;
    const spent = Date.now() - startedAt;
    // eslint-disable-next-line no-await-in-loop
    if (spent < interval) await new Promise((resolve) => { setTimeout(resolve, interval - spent); });
  }
  if (await condition()) return blocks;
  const budgetSpent = budgetedInBlocks
    ? `${blocks} blocks driven of the ${blockBudget} budgeted`
    : `${timeoutMs}ms (${blocks} blocks driven)`;
  throw new Error(`${label ? `${label}: ` : ''}condition not reached in ${budgetSpent}`);
}

export async function setHeight(height) {
  return post('/set-height', { height });
}

// valueSat: what the confirming tx pays, in satoshis. Omit it for the stub's
// default, which clears any fee; name it to sit either side of one.
export async function queueAppTx(appHash, valueSat) {
  return post('/queue-app-tx', valueSat === undefined ? { appHash } : { appHash, valueSat });
}

// -- Where the network believes a node is --

/**
 * Move a node's address as the whole network sees it: what benchmark tells the
 * node about itself (which is where it learns its address changed), what
 * getpublicip answers, its node status, and its entry in the deterministic list.
 *
 * The container is untouched. `node` is where it really is - the address its
 * requests arrive from - and that never moves, so the fleet stays reachable and
 * every other node keeps talking to it exactly as before.
 *
 * A bare address keeps the node's own api port.
 *
 * `scope: 'all'` (default) moves every answer at once - an address change already
 * settled. `scope: 'publicip'` moves only benchmark's public-IP probe, leaving the
 * node listed and reporting itself where it was: the state a node is in the moment
 * its address moves, and the only one in which it can notice.
 *
 * @param {string} node Where the node really is.
 * @param {string} reported The address the network should now carry for it.
 */
export async function setNodeAddress(node, reported, { scope = 'all' } = {}) {
  return post(`/node-address/${String(node).split(':')[0]}`, { reported, scope });
}

/**
 * Hide a node from its peers' view of the network, so they answer "not available"
 * for it without probing anything.
 *
 * A peer asked whether it can reach a node consults its node list first and answers
 * outright when the address is not in it. That is an answer, not a timeout, so it
 * arrives inside the asker's budget every time - which is what makes an unreachable
 * node a deterministic fixture rather than a race.
 *
 * The node keeps seeing itself: it has its own confirmed-list gate to pass before it
 * will run the availability check at all.
 */
export async function hideNodeFromPeers(node) {
  return post(`/node-visibility/${String(node).split(':')[0]}`, { hidden: true });
}

/** Put a node back into its peers' view. */
export async function revealNodeToPeers(node) {
  return post(`/node-visibility/${String(node).split(':')[0]}`, { hidden: false });
}

/** Put a node's address back to where it really is. */
export async function clearNodeAddress(node) {
  return post(`/node-address/${String(node).split(':')[0]}`, {});
}

// -- Per-node status --

export async function setNodeStatus(ip, status) {
  return post(`/node-status/${ip}`, { status });
}

export async function clearNodeStatus(ip) {
  return del(`/node-status/${ip}`);
}

// THE FOUR '/all' CONTROLS CHECK THEIR OWN ANSWER.
//
// Each of them was shadowed by the '/:ip' route registered above it in the stub
// and reached that handler with ip='all', which set or deleted the literal key
// 'all' and replied in the SUCCESS shape. A clear that cleared nothing looked
// exactly like a clear that worked, and the suite using it failed a minute later
// waiting for a node to come back. The stub now registers the literal routes
// first and refuses ip='all'; these read the answer so that refusal cannot be
// absorbed the way the silence was.
function assertControlled(result, what) {
  if (result && result.error) throw new Error(`${what} refused by the daemon stub: ${result.error}`);
  return result;
}

export async function setAllNodeStatus(status) {
  return assertControlled(await post('/node-status/all', { status }), 'setAllNodeStatus');
}

export async function clearAllNodeStatus() {
  return assertControlled(await del('/node-status/all'), 'clearAllNodeStatus');
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

// -- ArcaneOS attestation --

/**
 * Set whether a node's benchmark reports it as attested (ArcaneOS). Nodes are
 * attested by default, so only a suite that cares has to say anything.
 */
export async function setSystemSecure(ip, secure) {
  return post(`/system-secure/${ip}`, { secure });
}

export async function clearSystemSecure() {
  return del('/system-secure');
}

// -- RPC failure --

export async function enableRpcFailure(ip) {
  return post(`/rpc-fail/${ip}`);
}

export async function disableRpcFailure(ip) {
  return del(`/rpc-fail/${ip}`);
}

export async function enableAllRpcFailure() {
  return assertControlled(await post('/rpc-fail/all'), 'enableAllRpcFailure');
}

export async function disableAllRpcFailure() {
  return assertControlled(await del('/rpc-fail/all'), 'disableAllRpcFailure');
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

// Advance one block carrying an explicit transaction (e.g. a soft-fork message tx).
export async function injectBlock(tx) {
  return post('/advance-block', { block: { tx: [tx] } });
}

export async function seedTransaction(txid, tx) {
  return post('/seed-transaction', { txid, tx });
}

export async function clearSeededData() {
  return del('/seed-data');
}

// -- Holding an RPC open --
//
// A held method does not answer until it is released, so an operation that waits
// on that answer stays in flight for exactly as long as the suite wants. Failing
// an RPC ends such an operation; holding it is how a suite tests what must not
// happen WHILE something else is running.

// A hold is a scalpel only on a method with one caller. `getbenchmarks` is
// shared across most of the app lifecycle, so holding it stops far more than
// any one cycle, and what a suite then observes is not the overlap it named.
/**
 * Hold a method for one node: every call of it from that node blocks until released.
 * @param {string} ip Node's fleet IP, without a port.
 * @param {string} method RPC method name, e.g. 'getbenchmarks'.
 */
export async function holdRpc(ip, method) {
  return post(`/rpc-hold/${ip}`, { method });
}

/**
 * Release a node's held methods, answering every call waiting on one.
 * @param {string} ip Node's fleet IP, without a port.
 */
export async function releaseRpc(ip) {
  return del(`/rpc-hold/${ip}`);
}

/**
 * Release every held method on every node.
 */
export async function releaseAllRpc() {
  return del('/rpc-hold/all');
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
