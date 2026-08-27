const express = require('express');
const fs = require('fs');
const path = require('path');
const zmq = require('zeromq');
const benchCrypto = require('./benchCrypto');
const zmqEncoders = require('./zmqEncoders');

const app = express();
app.use(express.json());

if (process.env.FLUX_TEST_HARNESS !== 'true') {
  console.error('FLUX_TEST_HARNESS=true is required. This stub must only run inside the test harness.');
  process.exit(1);
}

const FLUXD_PORT = Number(process.env.FLUXD_PORT) || 16124;
const BENCHD_PORT = Number(process.env.BENCHD_PORT) || 16224;
const CONTROL_PORT = Number(process.env.CONTROL_PORT) || 18232;
// The publisher's port. FluxOS dials tcp://<config.daemon.host>:<config.daemon.zmqport>,
// which defaults to 16123 — the same default fluxd publishes on.
const ZMQ_PORT = Number(process.env.ZMQ_PORT) || 16123;
// Base for the per-node publishers; node N binds BASE+N. Clear of the RPC ports above
// and of the control port, and matched by framework/fluxd-conf.js.
const ZMQ_NODE_PORT_BASE = Number(process.env.ZMQ_NODE_PORT_BASE) || 17123;

// Reported software versions — single source of truth so every RPC stays consistent
// and a version bump is a one-line change. BENCH_VERSION must satisfy FluxOS's
// config.minimumFluxBenchAllowedVersion (currently 6.2.0) or the node DOS-flags itself.
const DAEMON_VERSION = 6010050;
const DAEMON_PROTOCOL_VERSION = 170019;
const DAEMON_WALLET_VERSION = 60000;
const DAEMON_SUBVERSION = '/Flux:6.1.0/';
const BENCH_VERSION = '6.3.1';
const FLUX_VERSION = '8.0.0';

let currentHeight = Number(process.env.INITIAL_HEIGHT) || 2100000;
let deterministicNodeList = [];
let originalNodeList = [];
let pendingBlocks = [];
// Serial behind the wallet addresses, so every getnewaddress differs from the last.
let walletAddressSerial = 0;

const nodeStatusOverrides = new Map();
const rpcFailures = new Map();
const requestJournal = [];
const MAX_JOURNAL_SIZE = 10000;

const seededAddressDeltas = [];
const seededAddressTxids = [];
const seededTransactions = new Map();

const fixturesDir = process.env.FIXTURES_DIR || path.join(__dirname, '..', 'fixtures');

const NODE_COUNT = Number(process.env.NODE_COUNT) || 16;

// Default-base baseline from the committed fixture. The harness assigns per-run
// addresses and POSTs the rendered list to /set-node-list (which also resets this
// baseline), so the IP convention lives only in runner/framework/subnet-config.js.
try {
  const listPath = path.join(fixturesDir, 'deterministic-list.json');
  if (fs.existsSync(listPath)) {
    const fullList = JSON.parse(fs.readFileSync(listPath, 'utf-8'));
    originalNodeList = fullList.slice(0, NODE_COUNT);
    deterministicNodeList = [...originalNodeList];
  }
} catch (e) {
  console.error('Failed to load deterministic list:', e.message);
}

// -- Block identity --
//
// A block's hash is a pure function of its height and of the fork it belongs to. The
// fork salt is what gives a chain identity: a reorg opens a new era above the fork
// point, so the block that replaces height H hashes differently from the one it
// replaced, while the common ancestor below the fork keeps the hash both chains agree
// on. Without it a rewind produced the same hashes and no client could tell a reorg
// from a repeat.
//
// The hash is 64 hex characters like a real one: leading zeros where proof of work
// puts them, then the era's salt, then the height. A hash read from a log or off the
// wire therefore names the block it belongs to.

const chainEras = [{ firstHeight: 0, salt: 0 }];
let nextForkSalt = 0;
// Tips this chain abandoned, newest first — what getchaintips reports beside the
// active one.
const abandonedTips = [];

function saltForHeight(height) {
  let salt = 0;
  for (const era of chainEras) {
    if (era.firstHeight > height) break;
    ({ salt } = era);
  }
  return salt;
}

function blockHash(height) {
  const value = Math.max(0, Number(height));
  const salt = saltForHeight(value).toString(16).padStart(8, '0');
  return `${'0'.repeat(48)}${salt}${value.toString(16).padStart(8, '0')}`;
}

function isHash256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function heightFromHash(hash) {
  return parseInt(hash.slice(56), 16);
}

function currentTip() {
  return { height: currentHeight, hash: blockHash(currentHeight) };
}

function nodeBySourceIp(sourceIp) {
  const clean = sourceIp.replace('::ffff:', '');
  return deterministicNodeList.find((n) => n.ip.split(':')[0] === clean) || null;
}

function filterNodeList(filter) {
  if (!filter) return deterministicNodeList;
  const needle = String(filter).toLowerCase();
  return deterministicNodeList.filter((node) => [node.txhash, node.ip, node.pubkey, node.payment_address, node.collateral]
    .some((field) => String(field ?? '').toLowerCase().includes(needle)));
}

const rpcHandlers = {
  getblockchaininfo: () => ({
    chain: 'main',
    blocks: currentHeight,
    headers: currentHeight,
    bestblockhash: blockHash(currentHeight),
    difficulty: 1000,
    verificationprogress: 1,
    chainwork: '0000000000000000000000000000000000000000000000000000000000000001',
  }),

  getblockcount: () => currentHeight,

  getinfo: () => ({
    version: DAEMON_VERSION,
    protocolversion: DAEMON_PROTOCOL_VERSION,
    walletversion: DAEMON_WALLET_VERSION,
    balance: 0,
    blocks: currentHeight,
    timeoffset: 0,
    connections: deterministicNodeList.length,
    proxy: '',
    difficulty: 1000,
    testnet: false,
    errors: '',
  }),

  getnetworkinfo: () => ({
    version: DAEMON_VERSION,
    subversion: DAEMON_SUBVERSION,
    protocolversion: DAEMON_PROTOCOL_VERSION,
    localservices: '0000000000000005',
    timeoffset: 0,
    connections: deterministicNodeList.length,
    networks: [],
    relayfee: 0.000001,
    localaddresses: [],
  }),

  getpeerinfo: () => [],

  // The active tip plus every tip this chain has abandoned, so a suite that reorgs
  // sees the same fork from the RPC that it was pushed on chainreorg.
  getchaintips: () => [
    { height: currentHeight, hash: blockHash(currentHeight), branchlen: 0, status: 'active' },
    ...abandonedTips.map((tip) => ({
      height: tip.height,
      hash: tip.hash,
      branchlen: tip.height - tip.forkHeight,
      status: 'valid-fork',
    })),
  ],

  getbestblockhash: () => blockHash(currentHeight),

  getblockhash: (params) => blockHash(params[0]),

  getblock: (params) => {
    const hashOrHeight = params[0];
    const verbosity = params[1] || 1;
    const asked = isHash256(hashOrHeight)
      ? heightFromHash(hashOrHeight)
      : (hashOrHeight === '' ? NaN : Number(hashOrHeight));

    const pending = pendingBlocks.find((b) => Number(b.height) === asked || b.hash === hashOrHeight);
    if (pending) return pending;

    const height = Number.isNaN(asked) ? null : asked;
    if (height === null || height < 0 || height > currentHeight) {
      throw new Error('Block not found');
    }
    const block = {
      hash: blockHash(height),
      confirmations: currentHeight - height + 1,
      size: 1000,
      height,
      version: 4,
      merkleroot: '0000000000000000000000000000000000000000000000000000000000000000',
      tx: [],
      time: Math.floor(Date.now() / 1000),
      nonce: 0,
      difficulty: 1000,
      previousblockhash: height > 0 ? blockHash(height - 1) : undefined,
      nextblockhash: height < currentHeight ? blockHash(height + 1) : undefined,
    };

    if (verbosity === 2) {
      block.tx = [];
    }

    return block;
  },

  getblockheader: (params) => {
    const hash = params[0];
    const pending = pendingBlocks.find((b) => b.hash === hash);
    if (pending) return pending;

    const height = isHash256(hash) ? heightFromHash(hash) : null;
    if (height === null || height > currentHeight) {
      throw new Error('Block not found');
    }
    return {
      hash,
      confirmations: currentHeight - height + 1,
      height,
      version: 4,
      previousblockhash: height > 0 ? blockHash(height - 1) : undefined,
      time: Math.floor(Date.now() / 1000),
    };
  },

  getmempoolinfo: () => ({ size: 0, bytes: 0, usage: 0 }),
  getrawmempool: () => [],

  // The filter is fluxd's: a substring match over the identifying fields, which is how
  // a delta's added nodes are resolved to full records one at a time.
  viewdeterministiczelnodelist: (params) => filterNodeList(params[0]),
  viewdeterministicfluxnodelist: (params) => filterNodeList(params[0]),

  // The atomic snapshot the delta stream anchors on: height, tip hash and the list
  // that belongs to it, answered together so the anchor can never name a block the
  // node set did not match.
  getfluxnodesnapshot: () => ({
    height: currentHeight,
    blockhash: blockHash(currentHeight),
    nodes: deterministicNodeList,
  }),

  getzelnodesnapshot: function f(params) { return this.getfluxnodesnapshot(params); },

  getzelnodestatus: (params, sourceIp) => {
    const node = nodeBySourceIp(sourceIp);
    const clean = sourceIp.replace('::ffff:', '');
    const override = nodeStatusOverrides.get(clean);
    return {
      status: override?.status ?? 'CONFIRMED',
      collateral: node ? node.collateral : 'COutPoint(0000000000000000000000000000000000000000000000000000000000000000, 0)',
      txhash: node ? node.txhash : '0000000000000000000000000000000000000000000000000000000000000000',
      outidx: node ? node.outidx : '0',
      ip: node ? node.ip : '127.0.0.1',
      network: '',
      added_height: node ? node.added_height : currentHeight - 1000,
      confirmed_height: node ? node.confirmed_height : currentHeight - 500,
      last_confirmed_height: node ? node.last_confirmed_height : currentHeight - 10,
      last_paid_height: node ? node.last_paid_height : currentHeight - 100,
      tier: node ? node.tier : 'CUMULUS',
      payment_address: node ? node.payment_address : 'stub-payment-address',
      pubkey: node ? node.pubkey : 'stub-pubkey',
      activesince: node ? String(node.activesince) : String(Math.floor(Date.now() / 1000) - 86400),
      lastpaid: node ? String(node.lastpaid) : String(Math.floor(Date.now() / 1000) - 3600),
      amount: '1000.00',
      rank: node ? node.rank : 1,
    };
  },

  getfluxnodestatus: function f(params, sourceIp) { return this.getzelnodestatus(params, sourceIp); },

  getzelnodecount: () => ({
    total: deterministicNodeList.length,
    stable: deterministicNodeList.length,
    enabled: deterministicNodeList.length,
    'inqueue-total': 0,
    'ipv4-total': deterministicNodeList.length,
    'ipv6-total': 0,
    'onion-total': 0,
  }),

  getfluxnodecount: function f(params) { return this.getzelnodecount(params); },

  getdoslist: () => [],
  getstartlist: () => [],

  listfluxnodes: () => deterministicNodeList,
  listzelnodes: () => deterministicNodeList,

  getrawtransaction: (params) => {
    const txid = params[0];
    const verbose = params[1] || 0;
    if (verbose && seededTransactions.has(txid)) {
      return seededTransactions.get(txid);
    }
    if (verbose) {
      const collateralAmounts = { CUMULUS: 1000, NIMBUS: 12500, STRATUS: 40000 };
      const node = deterministicNodeList.find((n) => n.txhash === txid);
      const outidx = node ? Number(node.outidx) : 0;
      const amount = node ? (collateralAmounts[node.tier] || 1000) : 0;
      const vout = [];
      for (let i = 0; i <= outidx; i++) {
        vout.push({
          value: i === outidx ? amount : 0,
          n: i,
          scriptPubKey: { addresses: [node ? node.payment_address : 'stub-address'] },
        });
      }
      return {
        txid,
        version: 1,
        locktime: 0,
        vin: [],
        vout,
        blockhash: blockHash(currentHeight),
        confirmations: 1,
        time: Math.floor(Date.now() / 1000),
        blocktime: Math.floor(Date.now() / 1000),
      };
    }
    return '0100000000000000000000';
  },

  createconfirmationtransaction: () => ({ hex: 'stub-confirmation-tx-hex' }),

  // Wallet calls that act as well as answer: each one must yield an address the
  // wallet has not handed out before, so a caller given the same address twice has
  // been served a cached answer rather than a second call.
  getnewaddress: () => {
    walletAddressSerial += 1;
    return `t1stubnew${String(walletAddressSerial).padStart(26, '0')}`;
  },
  getrawchangeaddress: () => {
    walletAddressSerial += 1;
    return `t1stubchg${String(walletAddressSerial).padStart(26, '0')}`;
  },

  getaddressbalance: () => ({ balance: 0, received: 0 }),
  getaddressutxos: () => [],
  getaddresstxids: () => (seededAddressTxids.length > 0 ? seededAddressTxids : []),
  getaddressdeltas: () => (seededAddressDeltas.length > 0 ? seededAddressDeltas : []),

  listunspent: () => [],
  validateaddress: (params) => ({
    isvalid: true,
    address: params[0],
    ismine: false,
    iswatchonly: false,
    isscript: false,
  }),

  signmessage: (params) => `stub-signature-for-${params[1]}`,

  getconnectioncount: () => deterministicNodeList.length,
  getdifficulty: () => 1000,
  getmininginfo: () => ({ blocks: currentHeight, difficulty: 1000, networkhashps: 0 }),
  getblocksubsidy: () => ({ miner: 37.5, founders: 0 }),

  getspentinfo: () => null,
  gettxout: () => null,

  help: () => 'Flux daemon stub - all methods stubbed for E2E testing',
  stop: () => 'Flux daemon stopping (stub)',
};

const benchHandlers = {
  getbenchmarks: (params, sourceIp) => {
    const node = nodeBySourceIp(sourceIp);
    const tier = node ? node.tier.toLowerCase() : 'cumulus';
    const specs = {
      cumulus: { cores: 4, ram: 7.5, ssd: 240, hdd: 0, ddwrite: 200, eps: 500, ping: 5, download_speed: 200, upload_speed: 100 },
      nimbus: { cores: 8, ram: 31, ssd: 480, hdd: 0, ddwrite: 300, eps: 1000, ping: 3, download_speed: 500, upload_speed: 250 },
      stratus: { cores: 16, ram: 62, ssd: 960, hdd: 0, ddwrite: 400, eps: 2000, ping: 2, download_speed: 1000, upload_speed: 500 },
    };
    const s = specs[tier] || specs.cumulus;
    return {
      ipaddress: node ? node.ip : '127.0.0.1',
      cores: s.cores,
      ram: s.ram,
      ssd: s.ssd,
      hdd: s.hdd,
      ddwrite: s.ddwrite,
      totalstorage: s.ssd + s.hdd,
      disksinfo: [],
      eps: s.eps,
      ping: s.ping,
      download_speed: s.download_speed,
      upload_speed: s.upload_speed,
      bench_version: BENCH_VERSION,
      flux_version: FLUX_VERSION,
      architecture: 'amd64',
      thunder: false,
      real_cores: s.cores,
      speed: 3000,
    };
  },

  getstatus: () => ({
    status: 'online',
    benchmarking: 'complete',
    flux: true,
  }),

  getpublicip: (params, sourceIp) => {
    const node = nodeBySourceIp(sourceIp);
    return node ? node.ip.split(':')[0] : '127.0.0.1';
  },

  getpublickey: (params, sourceIp) => {
    const node = nodeBySourceIp(sourceIp);
    return node ? node.pubkey : 'stub-pubkey';
  },

  getinfo: () => ({
    version: BENCH_VERSION,
    rpcport: BENCHD_PORT,
  }),

  decryptrsamessage: () => JSON.stringify({
    status: 'ok',
    message: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  }),

  // v9 node-capability verdict — must be 'arcane' (and FLUX_ARCANE_NODE set on the
  // node) or resolveNodeCapability polls forever / latches legacy. Read as
  // response.data.nodetype, so this returns an object, not a JSON string.
  getnodetype: () => ({ nodetype: 'arcane' }),

  // v9 content/transport crypto. The node parses these (string or object); they
  // mirror decryptrsamessage's { status:'ok', <field> } string convention.
  bloblocator: (params) => JSON.stringify({ status: 'ok', locator: benchCrypto.locatorFor(JSON.parse(params[0])) }),
  contentkey: (params) => JSON.stringify({ status: 'ok', key: benchCrypto.contentKeyFor(JSON.parse(params[0])) }),
  signblobupload: (params) => JSON.stringify({ status: 'ok', signature: benchCrypto.signBlobUpload(JSON.parse(params[0])) }),
  attest: (params) => {
    const { message, purpose } = JSON.parse(params[0]);
    // Purpose selects both the key and the domain the signer prepends, exactly
    // as the real backend does. No purpose is the legacy verbatim path.
    let signature;
    if (purpose === 'mesh') signature = benchCrypto.signMeshAttestation(message);
    else if (purpose === 'app') signature = benchCrypto.signAppAttestation(message);
    else signature = benchCrypto.signAttestation(message);
    return JSON.stringify({ status: 'ok', signature });
  },
  appencrypt: (params) => JSON.stringify({ status: 'ok', ...benchCrypto.appEncrypt(JSON.parse(params[0])) }),
  appdecrypt: (params) => JSON.stringify({ status: 'ok', ...benchCrypto.appDecrypt(JSON.parse(params[0])) }),
  transportpublickey: async (params) => {
    const q = new URLSearchParams(params[0]);
    const res = await benchCrypto.transportPublicKey({ appName: q.get('appName'), fluxID: q.get('fluxID') });
    return JSON.stringify({ status: 'ok', ...res });
  },
  transportdecap: async (params) => {
    const res = await benchCrypto.transportDecap(JSON.parse(params[0]));
    return JSON.stringify({ status: 'ok', ...res });
  },

  // Backend TLS. signcertificate takes the request as one JSON string (the POST
  // proxy convention); cacertificate takes a query string (the transportpublickey
  // convention). Both match what benchmarkService sends.
  signcertificate: async (params) => {
    const res = await benchCrypto.signCertificate(JSON.parse(params[0]));
    return JSON.stringify({ status: 'ok', ...res });
  },
  cacertificate: async (params) => {
    const q = new URLSearchParams(params[0]);
    const res = await benchCrypto.caCertificate({ appName: q.get('appName') });
    return JSON.stringify({ status: 'ok', ...res });
  },

  help: () => 'Flux benchmark stub',
  stop: () => 'Flux benchmark stopping (stub)',
};

/**
 * Answers one JSON-RPC call.
 * @param {object} handlers The server's method table.
 * @param {string} server Which server answered — 'fluxd' or 'benchd'. Both write to one
 *   journal and both answer getinfo, help and stop, so a journal entry that did not say
 *   which it was could not tell them apart.
 * @param {object} req Express request.
 * @param {object} res Express response.
 * @returns {Promise<object>} The express response.
 */
async function handleRpc(handlers, server, req, res) {
  const { method, params, id } = req.body;
  const sourceIp = req.ip;
  const cleanIp = sourceIp.replace('::ffff:', '');

  if (!method) {
    return res.status(400).json({ result: null, error: { code: -32600, message: 'Missing method' }, id });
  }

  requestJournal.push({
    method, server, sourceIp: cleanIp, timestamp: Date.now(),
  });
  if (requestJournal.length > MAX_JOURNAL_SIZE) requestJournal.shift();

  if (rpcFailures.has(cleanIp)) {
    return res.json({ result: null, error: { code: -28, message: 'Loading block index...' }, id });
  }

  const lowerMethod = method.toLowerCase();
  const handler = handlers[lowerMethod];

  if (!handler) {
    console.log(`Unhandled RPC method: ${method} from ${sourceIp}`);
    return res.json({ result: null, error: { code: -32601, message: `Method not found: ${method}` }, id });
  }

  try {
    // await so async handlers (HPKE transport) resolve before the reply; a
    // sync handler's plain value awaits to itself.
    const result = await (typeof handler === 'function' ? handler.call(handlers, params || [], sourceIp) : handler);
    return res.json({ result, error: null, id });
  } catch (e) {
    console.error(`RPC error for ${method} from ${sourceIp}:`, e.message);
    return res.json({ result: null, error: { code: -1, message: e.message }, id });
  }
}

// -- Fluxd RPC server --
const fluxd = express();
fluxd.use(express.json());
fluxd.post('/', (req, res) => handleRpc(rpcHandlers, 'fluxd', req, res));
fluxd.listen(FLUXD_PORT, () => console.log(`Fluxd stub listening on port ${FLUXD_PORT}`));

// -- Fluxbenchd RPC server --
const benchd = express();
benchd.use(express.json());
benchd.post('/', (req, res) => handleRpc(benchHandlers, 'benchd', req, res));
benchd.listen(BENCHD_PORT, () => console.log(`Fluxbenchd stub listening on port ${BENCHD_PORT}`));

// -- ZMQ publisher --
//
// One PUB socket carrying the four fluxd topics. A message is exactly three frames —
// topic, payload, sequence — with the sequence a little-endian uint32 counted per
// topic, held in memory, and therefore restarted from zero whenever the publisher is
// (which is a daemon restart, not message loss).
//
// fluxnodestatus is never published on its own initiative: it is one node's own state,
// and PUB is a broadcast to a fleet that shares this single daemon. A suite that wants
// it drives it through /zmq/publish.

const ZMQ_TOPICS = zmqEncoders.TOPICS;

let publisher = null;
let publisherBound = false;
// One socket per node, so a topic whose payload is about the RECEIVER can be addressed
// to it. The shared publisher above still carries the fleet-wide topics, and every
// fleet-wide send is fanned out to these too — a node dialling its own port must still
// see the whole chain, or it would be a node with a private and much quieter blockchain.
const nodePublishers = new Map();
// Own-status is addressed, so its per-topic sequence has to be counted per node:
// a shared counter would advance on a message a node never received and read to it as
// a gap, which is the one thing that makes a client throw its state away and resync.
const nodeSequence = new Map();
const nextSequence = new Map();
const lastSequence = new Map();
const silencedTopics = new Set();
// Sends are chained rather than fired concurrently: a delta that overtook the block it
// belongs to would be refused by the client for not chaining on.
let sendChain = Promise.resolve();
// Sequences are taken synchronously but the write is queued, so a stalled chain
// advances the counter while nothing reaches the wire. Counting completions
// separates "the stub never sent it" from "the subscriber ignored it".
const sendsCompleted = new Map();
const sendsFailed = new Map();

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function sequenceFrame(seq) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(seq, 0);
  return buf;
}

function isSilenced(topic) {
  return silencedTopics.has('all') || silencedTopics.has(topic);
}

function takeSequence(topic, explicit) {
  if (explicit !== undefined && explicit !== null) {
    // An explicit sequence also moves the counter, so the stream continues from what
    // the suite chose instead of jumping back on the next ordinary message.
    nextSequence.set(topic, explicit + 1);
    return explicit;
  }
  const seq = nextSequence.get(topic) ?? 0;
  nextSequence.set(topic, seq + 1);
  return seq;
}

/**
 * Sends one message. Returns synchronously — the write itself is queued behind any
 * earlier one, and PUB drops rather than blocks, so nothing here waits on a subscriber.
 * @param {string} topic Topic frame.
 * @param {Buffer} payload Payload frame.
 * @param {number} [explicitSeq] Sequence to stamp instead of the counter's next.
 * @returns {{sent: boolean, seq?: number, bytes?: number, reason?: string}} Outcome.
 */
function publish(topic, payload, explicitSeq, targetNode) {
  if (!publisherBound) return { sent: false, reason: 'publisher is not bound' };
  if (isSilenced(topic)) return { sent: false, reason: 'topic is silenced' };

  // Addressed to one node: its own socket, and its own sequence for this topic.
  if (targetNode !== undefined && targetNode !== null) {
    const num = Number(targetNode);
    const socket = nodePublishers.get(num);
    if (!socket) return { sent: false, reason: `no per-node publisher for node ${targetNode}` };
    const key = `${num}:${topic}`;
    const nodeSeq = explicitSeq ?? (nodeSequence.get(key) ?? 0);
    nodeSequence.set(key, nodeSeq + 1);
    const addressed = [Buffer.from(topic, 'utf8'), payload, sequenceFrame(nodeSeq)];
    sendChain = sendChain
      .then(() => socket.send(addressed))
      .then(() => {
        sendsCompleted.set(topic, (sendsCompleted.get(topic) ?? 0) + 1);
        console.log(`ZMQ sent ${topic} seq ${nodeSeq} to node ${num} (${payload.length}B)`);
      })
      .catch((e) => {
        sendsFailed.set(topic, (sendsFailed.get(topic) ?? 0) + 1);
        console.error(`ZMQ publish of ${topic} to node ${num} failed: ${e.message}`);
      });
    return { sent: true, seq: nodeSeq, bytes: payload.length, node: num };
  }

  const seq = takeSequence(topic, explicitSeq);
  lastSequence.set(topic, seq);

  const frames = [Buffer.from(topic, 'utf8'), payload, sequenceFrame(seq)];
  sendChain = sendChain
    .then(() => publisher.send(frames))
    // Same frames, same sequence, to every node socket: a node on its own port is
    // reading the same chain as the fleet, not a private one.
    .then(() => Promise.all([...nodePublishers.values()].map((socket) => socket.send(frames))))
    .then(() => {
      sendsCompleted.set(topic, (sendsCompleted.get(topic) ?? 0) + 1);
      console.log(`ZMQ sent ${topic} seq ${seq} (${payload.length}B)`);
    })
    .catch((e) => {
      sendsFailed.set(topic, (sendsFailed.get(topic) ?? 0) + 1);
      console.error(`ZMQ publish of ${topic} failed: ${e.message}`);
    });

  return { sent: true, seq, bytes: payload.length };
}

async function bindNodePublishers() {
  for (let num = 1; num <= NODE_COUNT; num += 1) {
    const port = ZMQ_NODE_PORT_BASE + num;
    const socket = new zmq.Publisher();
    try {
      // eslint-disable-next-line no-await-in-loop
      await socket.bind(`tcp://0.0.0.0:${port}`);
      nodePublishers.set(num, socket);
    } catch (e) {
      console.error(`ZMQ per-node publisher for node ${num} failed to bind on ${port}: ${e.message}`);
    }
  }
  if (nodePublishers.size) {
    console.log(`ZMQ per-node publishers bound for ${nodePublishers.size} node(s) from ${ZMQ_NODE_PORT_BASE + 1}`);
  }
}

async function bindPublisher() {
  publisher = new zmq.Publisher();
  // Rebinding straight after a close can find the port still held for a moment, and a
  // publisher that never comes back would read as a dead daemon for the rest of the run.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await publisher.bind(`tcp://0.0.0.0:${ZMQ_PORT}`);
      publisherBound = true;
      console.log(`ZMQ publisher bound on tcp://0.0.0.0:${ZMQ_PORT}`);
      return;
    } catch (e) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(100);
      if (attempt === 19) throw e;
    }
  }
}

/**
 * Closes and rebinds the socket, resetting every counter — a daemon restart as the
 * client sees one: a disconnect, then sequences beginning again at zero.
 * @returns {Promise<void>}
 */
async function restartPublisher() {
  publisherBound = false;
  await sendChain.catch(() => {});
  if (publisher) {
    publisher.close();
    publisher = null;
  }
  nextSequence.clear();
  lastSequence.clear();
  sendChain = Promise.resolve();
  await bindPublisher();
  await bindNodePublishers();
}

// -- What a block connect publishes --

// The node list as it stood at the last published block. A delta is the difference
// between this and the list now, so a change made between blocks is carried by the
// next connect — which is the only moment fluxd publishes one.
let publishedNodeList = [];

function outpointKey(node) {
  return `${node.txhash}:${Number(node.outidx)}`;
}

function hexOrEmpty(value, what, ip) {
  const hex = String(value ?? '');
  if (/^([0-9a-fA-F]{2})*$/.test(hex)) return hex;
  console.warn(`Node ${ip} has a non-hex ${what} (${hex}); publishing it empty`);
  return '';
}

// A node the wire cannot represent — anything without a real 32-byte collateral txid —
// is left out of the delta rather than failing the whole publish. It stays in the RPC
// list, so a client that notices resyncs from the snapshot.
function isDeltaRepresentable(node) {
  return isHash256(node.txhash) && Number.isInteger(Number(node.outidx));
}

function deltaRecord(node) {
  return {
    txhash: node.txhash,
    outidx: Number(node.outidx),
    collateralPubkey: hexOrEmpty(node.collateralPubkey ?? node.pubkey, 'collateral pubkey', node.ip),
    pubkey: hexOrEmpty(node.pubkey, 'pubkey', node.ip),
    confirmedHeight: Number(node.confirmed_height ?? 0),
    lastPaidHeight: Number(node.last_paid_height ?? 0),
    tier: node.tier ?? 'CUMULUS',
    status: node.status ?? 'CONFIRMED',
    ip: node.ip ?? '',
  };
}

// Only the fields a delta carries: comparing the whole record would report a node as
// updated for a change the wire cannot express.
function comparableFields(node) {
  return JSON.stringify([node.ip, node.tier, node.confirmed_height, node.last_paid_height, node.pubkey]);
}

function snapshotForDiff(list) {
  return list.filter(isDeltaRepresentable).map((node) => ({ node: { ...node }, fields: comparableFields(node) }));
}

function diffNodeLists(before, after) {
  const beforeByKey = new Map(before.map((entry) => [outpointKey(entry.node), entry]));
  const afterByKey = new Map(after.map((entry) => [outpointKey(entry.node), entry]));

  const added = [];
  const updated = [];
  afterByKey.forEach((entry, key) => {
    const previous = beforeByKey.get(key);
    if (!previous) added.push(deltaRecord(entry.node));
    else if (previous.fields !== entry.fields) updated.push(deltaRecord(entry.node));
  });

  const removed = [];
  beforeByKey.forEach((entry, key) => {
    if (!afterByKey.has(key)) removed.push({ txhash: entry.node.txhash, outidx: Number(entry.node.outidx) });
  });

  return { added, removed, updated };
}

/**
 * Publishes what fluxd publishes when a block is connected: the new tip, then the
 * node-list transition it carries.
 *
 * The delta goes out on every connect, empty or not. It is what moves the client's
 * anchor forward with the chain — a delta published only when the list changed would
 * start from a block the client is no longer sitting on and be refused.
 *
 * @param {{from?: {height: number, hash: string}, isReorg?: boolean}} options `from` is
 *   the tip being left, defaulting to the block before this one.
 * @returns {void}
 */
function publishBlockConnect({ from = null, isReorg = false } = {}) {
  const to = currentTip();
  const previous = from ?? { height: Math.max(0, currentHeight - 1), hash: blockHash(currentHeight - 1) };

  publish('hashblockheight', zmqEncoders.encode('hashblockheight', to));

  const before = publishedNodeList;
  const after = snapshotForDiff(deterministicNodeList);
  publishedNodeList = after;

  publish('fluxnodelistdelta', zmqEncoders.encode('fluxnodelistdelta', {
    fromHeight: previous.height,
    toHeight: to.height,
    fromHash: previous.hash,
    toHash: to.hash,
    isReorg,
    ...diffNodeLists(before, after),
  }));
}

/**
 * Connects a block carrying a node-list change.
 *
 * The list only ever changes in a block — that is where fluxd applies it — so a control
 * call that mutates it mints one rather than leaving the change unannounced. Callers
 * that are already connecting a block do not use this.
 *
 * A call that changes nothing — removing an address that is not in the list, setting the
 * tier a node already has — connects nothing either, so a suite holding the chain still
 * keeps it still.
 *
 * @param {() => void} mutate Applies the change to deterministicNodeList.
 * @returns {number} The height the change was connected at, or the unchanged tip.
 */
function connectListChange(mutate) {
  mutate();

  const diff = diffNodeLists(publishedNodeList, snapshotForDiff(deterministicNodeList));
  if (!diff.added.length && !diff.removed.length && !diff.updated.length) return currentHeight;

  currentHeight += 1;
  publishBlockConnect();
  return currentHeight;
}

// -- Block ticker --
const BLOCK_INTERVAL_MS = Number(process.env.BLOCK_INTERVAL_MS) || 5000;
const TICKER_AUTOSTART = process.env.TICKER_AUTOSTART !== 'false';
const pendingAppTxQueue = [];
let tickerHandle = null;

function tickBlock() {
  currentHeight += 1;
  const txs = [];
  while (pendingAppTxQueue.length > 0) {
    const { appHash, valueSat } = pendingAppTxQueue.shift();
    txs.push(buildAppRegistrationTx(appHash, currentHeight, valueSat));
  }
  if (txs.length > 0) {
    pendingBlocks.push({
      hash: blockHash(currentHeight),
      confirmations: 1,
      size: 1000,
      height: currentHeight,
      version: 4,
      merkleroot: '0000000000000000000000000000000000000000000000000000000000000000',
      tx: txs,
      time: Math.floor(Date.now() / 1000),
      nonce: 0,
      difficulty: 1000,
      previousblockhash: blockHash(currentHeight - 1),
    });
    console.log(`Block ${currentHeight}: ${txs.length} app tx(s)`);
  }
  publishBlockConnect();
}

function startTicker() {
  if (tickerHandle) return false;
  tickerHandle = setInterval(tickBlock, BLOCK_INTERVAL_MS);
  console.log(`Block ticker started (${BLOCK_INTERVAL_MS}ms interval)`);
  return true;
}

function stopTicker() {
  if (!tickerHandle) return false;
  clearInterval(tickerHandle);
  tickerHandle = null;
  console.log('Block ticker stopped');
  return true;
}

if (TICKER_AUTOSTART) {
  startTicker();
} else {
  console.log('Block ticker paused (TICKER_AUTOSTART=false). POST /ticker/start to begin.');
}

// The list the first delta will be measured against, so a node that boots into a
// quiet chain is not told everything it already has was just added.
publishedNodeList = snapshotForDiff(deterministicNodeList);

// A publisher that cannot bind is fatal: the nodes' config says this daemon publishes,
// so they would wait on a socket that never opens rather than fall back to polling.
bindNodePublishers().catch((e) => {
  console.error(`ZMQ per-node publishers failed to bind: ${e.message}`);
});
bindPublisher().catch((e) => {
  console.error(`ZMQ publisher failed to bind on ${ZMQ_PORT}: ${e.message}`);
  process.exit(1);
});

// -- Test harness control API --
const control = express();
control.use(express.json());

control.get('/state', (req, res) => {
  res.json({
    currentHeight,
    bestBlockHash: blockHash(currentHeight),
    nodeCount: deterministicNodeList.length,
    pendingBlocks: pendingBlocks.length,
    pendingAppTxQueue: pendingAppTxQueue.length,
    blockIntervalMs: BLOCK_INTERVAL_MS,
    tickerRunning: tickerHandle !== null,
    statusOverrides: nodeStatusOverrides.size,
    rpcFailures: rpcFailures.size,
    forks: abandonedTips.length,
  });
});

control.post('/ticker/start', (req, res) => {
  const started = startTicker();
  res.json({ tickerRunning: true, started });
});

control.post('/ticker/stop', (req, res) => {
  const stopped = stopTicker();
  res.json({ tickerRunning: false, stopped });
});

// What an app tx pays by default: comfortably above any registration or update
// fee, so a test that is not about pricing never has to think about it.
const DEFAULT_APP_TX_VALUE_SAT = 200000000;

function buildAppRegistrationTx(appHash, height, valueSat = DEFAULT_APP_TX_VALUE_SAT) {
  const opReturnHex = Buffer.from(appHash, 'utf-8').toString('hex');
  return {
    txid: `apptx-${appHash.substring(0, 16)}-${height}`,
    version: 1,
    vin: [{ txid: 'prev-tx-stub', vout: 0, address: 'stub-sender-address' }],
    vout: [
      {
        valueSat,
        scriptPubKey: {
          addresses: ['t3NryfAQLGeFs9jEoeqsxmBN2QLRaRKFLUX'],
          asm: '',
        },
      },
      {
        valueSat: 0,
        scriptPubKey: {
          addresses: [],
          asm: `OP_RETURN ${opReturnHex}`,
        },
      },
    ],
  };
}

control.post('/advance-block', (req, res) => {
  const { block, appHash } = req.body;
  currentHeight += 1;
  const txs = [];
  if (appHash) {
    txs.push(buildAppRegistrationTx(appHash, currentHeight));
  }
  while (pendingAppTxQueue.length > 0) {
    const { appHash: queuedHash, valueSat } = pendingAppTxQueue.shift();
    txs.push(buildAppRegistrationTx(queuedHash, currentHeight, valueSat));
  }
  if (block) {
    block.height = block.height || currentHeight;
    block.hash = block.hash || blockHash(currentHeight);
    block.confirmations = 1;
    block.time = block.time || Math.floor(Date.now() / 1000);
    block.tx = [...(block.tx || []), ...txs];
    pendingBlocks.push(block);
  } else if (txs.length > 0) {
    pendingBlocks.push({
      hash: blockHash(currentHeight),
      confirmations: 1,
      size: 1000,
      height: currentHeight,
      version: 4,
      merkleroot: '0000000000000000000000000000000000000000000000000000000000000000',
      tx: txs,
      time: Math.floor(Date.now() / 1000),
      nonce: 0,
      difficulty: 1000,
      previousblockhash: blockHash(currentHeight - 1),
    });
    console.log(`Block ${currentHeight}: ${txs.length} app tx(s) (manual advance)`);
  }
  publishBlockConnect();
  res.json({ currentHeight, bestBlockHash: blockHash(currentHeight) });
});

control.post('/set-height', (req, res) => {
  const from = currentTip();
  currentHeight = req.body.height;
  // A jump, not a reorg: the hashes below the new tip are the ones they always were.
  // A suite that wants a fork to exist uses /reorg.
  publishBlockConnect({ from });
  res.json({ currentHeight, bestBlockHash: blockHash(currentHeight) });
});

control.post('/set-node-list', (req, res) => {
  // Update the restore/reset baseline too, so /node-list/restore and /reset stay
  // consistent with the per-run addresses the harness assigns (not the 198.18 fixture).
  // This is the run's starting list rather than a transition, so it publishes nothing
  // and connects no block — it re-bases what the next delta is measured against.
  deterministicNodeList = req.body.nodes;
  originalNodeList = [...req.body.nodes];
  publishedNodeList = snapshotForDiff(deterministicNodeList);
  res.json({ nodeCount: deterministicNodeList.length });
});

// valueSat is what the tx pays. A pricing test names it to sit either side of a
// fee; everything else omits it and gets the default.
control.post('/queue-app-tx', (req, res) => {
  const { appHash, valueSat } = req.body;
  if (!appHash) return res.status(400).json({ error: 'appHash required' });
  if (valueSat !== undefined && !Number.isInteger(valueSat)) {
    return res.status(400).json({ error: 'valueSat must be an integer number of satoshis' });
  }
  pendingAppTxQueue.push({ appHash, valueSat });
  return res.json({ queued: true, queueLength: pendingAppTxQueue.length, nextBlockHeight: currentHeight + 1 });
});

control.post('/add-block-fixture', (req, res) => {
  pendingBlocks.push(req.body.block);
  res.json({ pendingBlocks: pendingBlocks.length });
});

control.delete('/pending-blocks', (req, res) => {
  pendingBlocks = [];
  res.json({ cleared: true });
});

// -- Per-node status overrides --

control.post('/node-status/:ip', (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'status required' });
  nodeStatusOverrides.set(req.params.ip, { status });
  return res.json({ ip: req.params.ip, status });
});

control.delete('/node-status/:ip', (req, res) => {
  nodeStatusOverrides.delete(req.params.ip);
  res.json({ ip: req.params.ip, cleared: true });
});

control.post('/node-status/all', (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'status required' });
  for (const node of deterministicNodeList) {
    nodeStatusOverrides.set(node.ip.split(':')[0], { status });
  }
  res.json({ status, count: deterministicNodeList.length });
});

control.delete('/node-status/all', (req, res) => {
  nodeStatusOverrides.clear();
  res.json({ cleared: true });
});

control.get('/node-status', (req, res) => {
  res.json(Object.fromEntries(nodeStatusOverrides));
});

// -- Deterministic list manipulation --
//
// Each of these connects a block: the list only ever changes in one, and that block is
// what carries the delta to the nodes.

control.post('/node-list/remove/:ip', (req, res) => {
  const { ip } = req.params;
  const before = deterministicNodeList.length;
  const height = connectListChange(() => {
    deterministicNodeList = deterministicNodeList.filter((n) => n.ip.split(':')[0] !== ip);
  });
  res.json({
    ip, removed: deterministicNodeList.length < before, nodeCount: deterministicNodeList.length, currentHeight: height,
  });
});

control.post('/node-list/restore/:ip', (req, res) => {
  const { ip } = req.params;
  const original = originalNodeList.find((n) => n.ip.split(':')[0] === ip);
  if (!original) return res.status(404).json({ error: `${ip} not in original list` });
  const exists = deterministicNodeList.some((n) => n.ip.split(':')[0] === ip);
  const height = connectListChange(() => {
    if (!exists) deterministicNodeList.push(original);
  });
  return res.json({
    ip, restored: !exists, nodeCount: deterministicNodeList.length, currentHeight: height,
  });
});

control.post('/node-list/reset', (req, res) => {
  const height = connectListChange(() => {
    deterministicNodeList = [...originalNodeList];
  });
  res.json({ nodeCount: deterministicNodeList.length, currentHeight: height });
});

// -- Per-node tier control --

control.post('/node-tier/:ip', (req, res) => {
  const { ip } = req.params;
  const { tier } = req.body;
  if (!tier || !['CUMULUS', 'NIMBUS', 'STRATUS'].includes(tier)) {
    return res.status(400).json({ error: 'tier must be CUMULUS, NIMBUS, or STRATUS' });
  }
  const node = deterministicNodeList.find((n) => n.ip.split(':')[0] === ip);
  if (!node) return res.status(404).json({ error: `node ${ip} not found` });
  const height = connectListChange(() => { node.tier = tier; });
  const amounts = { CUMULUS: 1000, NIMBUS: 12500, STRATUS: 40000 };
  return res.json({
    ip, tier, collateral: amounts[tier], currentHeight: height,
  });
});

// -- RPC failure simulation --

control.post('/rpc-fail/:ip', (req, res) => {
  rpcFailures.set(req.params.ip, true);
  res.json({ ip: req.params.ip, rpcFailing: true });
});

control.delete('/rpc-fail/:ip', (req, res) => {
  rpcFailures.delete(req.params.ip);
  res.json({ ip: req.params.ip, rpcFailing: false });
});

control.post('/rpc-fail/all', (req, res) => {
  for (const node of deterministicNodeList) {
    rpcFailures.set(node.ip.split(':')[0], true);
  }
  res.json({ rpcFailing: true, count: deterministicNodeList.length });
});

control.delete('/rpc-fail/all', (req, res) => {
  rpcFailures.clear();
  res.json({ rpcFailing: false, cleared: true });
});

// -- Seeded RPC data --

control.post('/seed-address-deltas', (req, res) => {
  const { deltas } = req.body;
  if (!Array.isArray(deltas)) return res.status(400).json({ error: 'deltas must be an array' });
  seededAddressDeltas.push(...deltas);
  return res.json({ count: seededAddressDeltas.length });
});

control.post('/seed-address-txids', (req, res) => {
  const { txids } = req.body;
  if (!Array.isArray(txids)) return res.status(400).json({ error: 'txids must be an array' });
  seededAddressTxids.push(...txids);
  return res.json({ count: seededAddressTxids.length });
});

control.post('/seed-transaction', (req, res) => {
  const { txid, tx } = req.body;
  if (!txid || !tx) return res.status(400).json({ error: 'txid and tx required' });
  seededTransactions.set(txid, tx);
  return res.json({ txid, seeded: true, count: seededTransactions.size });
});

control.delete('/seed-data', (req, res) => {
  seededAddressDeltas.length = 0;
  seededAddressTxids.length = 0;
  seededTransactions.clear();
  res.json({ cleared: true });
});

// -- Reset all overrides --

control.post('/reset', (req, res) => {
  nodeStatusOverrides.clear();
  rpcFailures.clear();
  pendingBlocks = [];
  pendingAppTxQueue.length = 0;
  requestJournal.length = 0;
  seededAddressDeltas.length = 0;
  seededAddressTxids.length = 0;
  seededTransactions.clear();
  silencedTopics.clear();
  // Restoring the list is a list change like any other, so it arrives in a block.
  const height = connectListChange(() => {
    deterministicNodeList = [...originalNodeList];
  });
  res.json({ reset: true, nodeCount: deterministicNodeList.length, currentHeight: height });
});

// -- Request journal --

control.get('/journal', (req, res) => {
  const {
    method, sourceIp, server, limit = 100,
  } = req.query;
  let entries = requestJournal;
  if (method) entries = entries.filter((e) => e.method.toLowerCase() === method.toLowerCase());
  if (sourceIp) entries = entries.filter((e) => e.sourceIp === sourceIp);
  if (server) entries = entries.filter((e) => e.server === server);
  res.json({ total: entries.length, entries: entries.slice(-Number(limit)) });
});

control.delete('/journal', (req, res) => {
  requestJournal.length = 0;
  res.json({ cleared: true });
});

// -- Chain reorganisation --

// Rewinds to a fork point and rebuilds above it on a different chain, then tells both
// channels the same story: chainreorg names the old tip, the new tip and the fork, and
// every block RPC above the fork answers with the new chain's hashes from here on.
//
// body: { forkHeight? | depth?, newHeight? }
//   forkHeight  the last block both chains share. Defaults to currentHeight - depth.
//   depth       how far back the fork is, when forkHeight is not given. Default 1.
//   newHeight   the new tip's height. Defaults to the old tip's, i.e. a same-height
//               reorg; a lower value is a backward reorg.
control.post('/reorg', (req, res) => {
  const { forkHeight, depth = 1, newHeight } = req.body || {};

  const oldTip = currentTip();
  const fork = Number.isInteger(forkHeight) ? forkHeight : oldTip.height - depth;

  if (!Number.isInteger(fork) || fork < 0 || fork >= oldTip.height) {
    return res.status(400).json({ error: `fork height must be between 0 and ${oldTip.height - 1}` });
  }

  const tipHeight = Number.isInteger(newHeight) ? newHeight : oldTip.height;
  if (tipHeight <= fork) {
    return res.status(400).json({ error: `new tip height must be above the fork at ${fork}` });
  }

  // The fork block belongs to both chains, so its hash is read before the new era
  // exists — the era starts at the first block that differs.
  const forkPoint = { height: fork, hash: blockHash(fork) };

  // Everything above the fork belonged to the chain just abandoned, so those eras go
  // with it — otherwise a later, deeper reorg would leave a discarded chain's hashes
  // answering for heights the new one now owns.
  while (chainEras.length > 1 && chainEras[chainEras.length - 1].firstHeight > fork) chainEras.pop();
  nextForkSalt += 1;
  chainEras.push({ firstHeight: fork + 1, salt: nextForkSalt });
  abandonedTips.unshift({ height: oldTip.height, hash: oldTip.hash, forkHeight: fork });

  currentHeight = tipHeight;
  const newTip = currentTip();

  publish('chainreorg', zmqEncoders.encode('chainreorg', { oldTip, newTip, fork: forkPoint }));
  // The new tip is connected like any other block, and its delta is flagged as a reorg
  // so the client re-anchors onto the chain that won instead of refusing it.
  publishBlockConnect({ from: oldTip, isReorg: true });

  console.log(`Reorg: ${oldTip.height}/${oldTip.hash.slice(-16)} -> ${newTip.height}/${newTip.hash.slice(-16)}, fork at ${fork}`);

  return res.json({ oldTip, newTip, fork: forkPoint });
});

// -- ZMQ publisher control --

function normaliseTopic(topic, { allowUnknown = false } = {}) {
  if (typeof topic !== 'string' || !topic) throw new Error('topic is required');
  if (!allowUnknown && !ZMQ_TOPICS.includes(topic)) {
    throw new Error(`unknown topic ${topic}, expected one of ${ZMQ_TOPICS.join(', ')}`);
  }
  return topic;
}

// The generic primitive: send one message, on any topic, with any payload.
//
// body: { topic, payload?, encoding?, fields?, seq? }
//   payload   a raw payload as a string, for a hand-crafted or deliberately malformed
//             frame. `encoding` is 'hex' (default) or 'base64'.
//   fields    the topic's fields, for the stub to encode. Mutually exclusive with
//             payload; the topic must be a known one.
//   seq       the sequence to stamp. Omit for the counter's next value; the counter
//             continues from whatever is given.
control.post('/zmq/publish', (req, res) => {
  const {
    topic, payload, encoding = 'hex', fields, seq, node,
  } = req.body || {};

  if ((payload === undefined) === (fields === undefined)) {
    return res.status(400).json({ error: 'exactly one of payload or fields is required' });
  }
  if (node !== undefined && !Number.isInteger(Number(node))) {
    return res.status(400).json({ error: 'node must be a node number' });
  }
  if (seq !== undefined && (!Number.isInteger(seq) || seq < 0 || seq > 0xffffffff)) {
    return res.status(400).json({ error: 'seq must be a uint32' });
  }

  let frame;
  try {
    normaliseTopic(topic, { allowUnknown: payload !== undefined });
    if (payload !== undefined) {
      if (typeof payload !== 'string') throw new Error('payload must be a hex or base64 string');
      if (!['hex', 'base64'].includes(encoding)) throw new Error("encoding must be 'hex' or 'base64'");
      frame = Buffer.from(payload, encoding);
    } else {
      frame = zmqEncoders.encode(topic, fields);
    }
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const result = publish(topic, frame, seq, node);
  return res.json({ topic, ...result });
});

// Burns sequence numbers without sending anything — the gap a dropped message leaves.
control.post('/zmq/skip', (req, res) => {
  const { topic, count = 1 } = req.body || {};
  if (!Number.isInteger(count) || count < 1) {
    return res.status(400).json({ error: 'count must be a positive integer' });
  }
  try {
    normaliseTopic(topic, { allowUnknown: true });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const from = nextSequence.get(topic) ?? 0;
  nextSequence.set(topic, from + count);
  return res.json({ topic, skipped: count, nextSeq: from + count });
});

// Stops publishing without closing the socket: the client stays connected and simply
// hears nothing, which is what a wedged daemon looks like.
control.post('/zmq/silence', (req, res) => {
  const { topic = 'all' } = req.body || {};
  if (topic !== 'all') {
    try {
      normaliseTopic(topic);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }
  silencedTopics.add(topic);
  return res.json({ silenced: [...silencedTopics] });
});

control.delete('/zmq/silence', (req, res) => {
  const { topic } = req.query;
  if (topic) silencedTopics.delete(topic);
  else silencedTopics.clear();
  res.json({ silenced: [...silencedTopics] });
});

// A daemon restart: the socket drops and every counter starts again from zero. The
// client must read that as a restart, not as messages it missed.
control.post('/zmq/restart', async (req, res) => {
  try {
    await restartPublisher();
  } catch (e) {
    return res.status(500).json({ error: `rebind failed: ${e.message}` });
  }
  return res.json({ restarted: true, bound: publisherBound, endpoint: `tcp://0.0.0.0:${ZMQ_PORT}` });
});

control.get('/zmq/state', (req, res) => {
  const nextSeq = {};
  const lastSeq = {};
  const sent = {};
  const failed = {};
  const topics = [...new Set([...ZMQ_TOPICS, ...nextSequence.keys()])];
  topics.forEach((topic) => {
    nextSeq[topic] = nextSequence.get(topic) ?? 0;
    lastSeq[topic] = lastSequence.has(topic) ? lastSequence.get(topic) : null;
    sent[topic] = sendsCompleted.get(topic) ?? 0;
    failed[topic] = sendsFailed.get(topic) ?? 0;
  });
  res.json({
    bound: publisherBound,
    endpoint: `tcp://0.0.0.0:${ZMQ_PORT}`,
    topics,
    nextSeq,
    lastSeq,
    sent,
    failed,
    silenced: [...silencedTopics],
  });
});

control.listen(CONTROL_PORT, () => console.log(`Control API listening on port ${CONTROL_PORT}`));
