const express = require('express');

// FluxDrive blob-API stub for the integration harness. Mirrors the real
// fluxdrive-api endpoints that ZelBack/services/utils/fluxDriveClient.js drives:
// opaque-ciphertext storage by locator, the owner-signed manifest put, and the
// slot reconcile. FluxDrive never decrypts — it stores bytes — so this stub
// keeps raw buffers in memory and lets tests assert exactly what a node
// uploaded / reconciled.
//
// Content is keyed by the app's identity, as the real service keys it: a blob
// row carries the identity the upload names, manifests are kept per (appName,
// identity), reconcile floors per (identity, source). The stub verifies no
// signature, so it has no owner.
//
// The real service reads which registration holds a name from the network's
// spec feed. The stub learns it two ways: a pending write naming a message the
// nodes answer "applied" makes the write's identity the name's holder, and the
// control plane can set it (/manifest/:appName/promote). Once a name has a
// holder, a manifest for another identity is refused 409 and only the holder's
// is served.
//
// A manifest put or a reconcile that names a message hash is held pending, as
// the real service holds it: the stub asks the nodes it is configured with
// (FLUX_NODE_URLS) what became of the message, on arrival and on a timer, takes
// the majority of the answers it gets (a node holding nothing about the hash is
// not an answer), applies the write on "applied", discards it on "refused" or
// "unpayable" and keeps it otherwise. The control plane can decide a pending
// write directly (/pending/:hash/decide) for a suite that models an outcome.
//
// Permissive by default; strict mode (control /mode) adds the monotonic version
// floors (per identity and source, per manifest row), the locator-claim 409 and
// confirmed-only manifest serving, so the cold-start / go-live gating paths can
// be exercised.

const PORT = parseInt(process.env.FLUXDRIVE_PORT || '16140', 10);
const CONTROL_PORT = parseInt(process.env.CONTROL_PORT || '16141', 10);
// The nodes asked about a pending write's message, comma-separated base URLs.
const NODE_URLS = (process.env.FLUX_NODE_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
const PENDING_POLL_MS = parseInt(process.env.PENDING_POLL_MS || '2000', 10);
const ASK_TIMEOUT_MS = 4000;

// locator -> { bytes:Buffer, appName, identity, source, timestamp, arcaneSig, ownerSig, tombstoned }
const blobs = new Map();
// `${appName}\n${identity}` -> { appName, identity, version, timestamp, arcaneSig, ownerSig, manifest, confirmed, seq }
const manifests = new Map();
// appName -> the identity of the registration that holds the name
const holders = new Map();
// manifest write order, so a name with no holder serves its latest-written row
let manifestSeq = 0;
// every reconcile call, in arrival order, for assertions
const reconciles = [];
// every HEAD presence probe on the blob fetch route, in arrival order — the
// carry-over submission contract asserts on these (a carried-over hash is
// presence-checked instead of re-uploaded)
const heads = [];
// `${identity}:${source}` -> highest accepted version (strict floor)
const floors = new Map();
// every pending write, in arrival order:
// { kind:'manifest'|'reconcile', messageHash, appName, identity, version, source?, body, receivedAt, askedAt, answers }
const pending = [];
// every decision taken on a pending write, for assertions
const decisions = [];

// Behavior knobs the control plane drives. slow = per-request delay ms; fail5xx
// makes the data plane return 500 (the "FluxDrive 5xx aborts submission" path);
// failManifestPut fails ONLY the manifest PUT (gossip stays primary, the
// synchronous slot-blob upload still succeeds).
const mode = {
  strict: false, slow: 0, fail5xx: false, failManifestPut: false,
};

function reset() {
  blobs.clear();
  manifests.clear();
  holders.clear();
  manifestSeq = 0;
  reconciles.length = 0;
  heads.length = 0;
  floors.clear();
  pending.length = 0;
  decisions.length = 0;
  mode.strict = false;
  mode.slow = 0;
  mode.fail5xx = false;
  mode.failManifestPut = false;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const manifestKey = (appName, identity) => `${appName}\n${identity}`;

function manifestRowsOf(appName) {
  return [...manifests.values()].filter((row) => row.appName === appName);
}

// The row the data API serves for a name: of the holder's rows once the name has
// one, else of every row, the one ranking highest by the height its signer took
// the app (`ownedFrom`, 0 when the manifest names none) and its version within
// that. Strict serves a confirmed row only.
function servedManifest(appName) {
  const holder = holders.get(appName);
  const rank = (row) => [Number(row.manifest?.ownedFrom ?? 0), Number(row.version ?? 0), row.seq];
  const rows = manifestRowsOf(appName)
    .filter((row) => holder == null || row.identity === holder)
    .filter((row) => !mode.strict || row.confirmed);
  return rows.reduce((best, row) => {
    if (!best) return row;
    const [bo, bv, bs] = rank(best);
    const [o, v, s] = rank(row);
    return o > bo || (o === bo && (v > bv || (v === bv && s > bs))) ? row : best;
  }, null);
}

function setManifest(appName, identity, fields) {
  manifestSeq += 1;
  manifests.set(manifestKey(appName, identity), {
    appName, identity, timestamp: null, arcaneSig: null, ownerSig: null, ...fields, seq: manifestSeq,
  });
}

// Make `identity` the name's holder: confirm its rows and evict every other row
// of the name (the go-live transition).
function promote(appName, identity) {
  holders.set(appName, identity);
  for (const [key, row] of manifests) {
    if (row.appName !== appName) continue;
    if (row.identity === identity) row.confirmed = true;
    else manifests.delete(key);
  }
}

// The identity a name's content belongs to, as the real service reads it from
// the spec feed: the holder once the name has one, else the one identity the
// name's blobs and manifests carry, else null (an unknown app).
function identityOf(appName) {
  if (holders.has(appName)) return holders.get(appName);
  const seen = new Set();
  for (const row of blobs.values()) if (row.appName === appName && row.identity) seen.add(row.identity);
  for (const row of manifests.values()) if (row.appName === appName) seen.add(row.identity);
  return seen.size === 1 ? [...seen][0] : null;
}

const floorKeyOf = (identity, source) => `${identity}:${source}`;

// Apply a reconcile: tombstone the identity's other rows of the source, keep
// the floor, log it.
function applyReconcile({
  appName, identity, source, version, arcaneSig, ownerSig, liveLocators, pendingMessageHash,
}) {
  const floorKey = floorKeyOf(identity, source);
  const floor = floors.get(floorKey);
  if (floor != null && version <= floor) {
    reconciles.push({
      appName, identity, source, version, accepted: false, pendingMessageHash: pendingMessageHash ?? null, at: new Date().toISOString(),
    });
    return false;
  }
  floors.set(floorKey, version);
  const live = new Set(Array.isArray(liveLocators) ? liveLocators : []);
  for (const [loc, entry] of blobs) {
    if (entry.identity === identity && entry.source === source && !live.has(loc)) {
      entry.tombstoned = true;
    }
  }
  reconciles.push({
    appName, identity, source, version, arcaneSig, ownerSig, liveLocators: [...live], accepted: true, pendingMessageHash: pendingMessageHash ?? null, at: new Date().toISOString(),
  });
  return true;
}

// Store a manifest row; strict refuses a version at or below the stored one.
function applyManifestPut({
  appName, identity, version, timestamp, arcaneSig, ownerSig, manifest,
}) {
  const stored = manifests.get(manifestKey(appName, identity));
  if (mode.strict && stored && version <= stored.version) return false;
  const holder = holders.get(appName);
  setManifest(appName, identity, {
    version,
    timestamp,
    arcaneSig,
    ownerSig,
    manifest,
    // Strict models the real go-live gate: a manifest for a name with no holder
    // lands unconfirmed until the name has one. Permissive serves everything.
    confirmed: !mode.strict || holder === identity,
  });
  return true;
}

// --- Pending writes: held until the nodes answer what became of the message ---

const MESSAGE_HASH = /^[0-9a-f]{64}$/;

function recordPending(write) {
  // A retried request replaces the earlier write of the same kind, identity, source and version.
  const i = pending.findIndex((p) => p.kind === write.kind && p.identity === write.identity && (p.source ?? null) === (write.source ?? null) && p.version === write.version);
  const row = {
    ...write, receivedAt: new Date().toISOString(), askedAt: null, answers: [],
  };
  if (i >= 0) pending[i] = row; else pending.push(row);
}

// Settle one pending write on a verdict { decision, identity? }. An applied
// message names the identity it gave the app; a write for another identity is
// discarded. Returns what happened.
function settlePending(write, verdict) {
  const drop = () => pending.splice(pending.indexOf(write), 1);
  let outcome;
  if (!verdict || verdict.decision === 'undecided') {
    outcome = 'kept';
  } else if (verdict.decision !== 'applied') {
    drop();
    outcome = 'discarded';
  } else if (verdict.identity != null && verdict.identity !== write.identity) {
    drop();
    outcome = 'discarded';
  } else {
    drop();
    if (write.kind === 'manifest') {
      // The applied message lists the name under this identity.
      promote(write.appName, write.identity);
      outcome = applyManifestPut({ ...write, manifest: write.body }) ? 'applied' : 'discarded';
    } else {
      outcome = applyReconcile({ ...write, liveLocators: write.body }) ? 'applied' : 'discarded';
    }
  }
  decisions.push({
    messageHash: write.messageHash, kind: write.kind, appName: write.appName, identity: write.identity, version: write.version, decision: verdict ? verdict.decision : 'no majority', outcome, at: new Date().toISOString(),
  });
  return outcome;
}

// The majority of the answers, or null: an applied answer agrees with another
// only when both name the same identity.
function majority(answers) {
  if (!answers.length) return null;
  const tally = new Map();
  for (const a of answers) {
    const key = a.decision === 'applied' ? `applied\n${a.identity ?? ''}` : a.decision;
    const entry = tally.get(key) ?? { decision: a.decision, identity: a.identity ?? null, votes: 0 };
    entry.votes += 1;
    tally.set(key, entry);
  }
  let best = null;
  for (const e of tally.values()) if (!best || e.votes > best.votes) best = e;
  return best.votes * 2 > answers.length ? best : null;
}

// One node's answer about a message from its decision route; null when it holds
// nothing about the hash (404) or cannot be reached.
async function askNode(url, hash) {
  try {
    const res = await fetch(`${url}/v2/apps/messages/${hash}/decision`, { signal: AbortSignal.timeout(ASK_TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = await res.json();
    const data = body && body.data && typeof body.data.decision === 'string' ? body.data : body;
    if (!data || typeof data.decision !== 'string') return null;
    return { decision: data.decision, owner: data.owner ?? null, identity: data.identity ?? null };
  } catch (error) {
    return null;
  }
}

let asking = false;

// Ask the configured nodes about every pending write and settle each on the
// majority of the answers. One pass at a time.
async function askPending() {
  if (asking || !NODE_URLS.length || !pending.length) return;
  asking = true;
  try {
    for (const write of [...pending]) {
      if (!pending.includes(write)) continue;
      const answers = (await Promise.all(NODE_URLS.map((url) => askNode(url, write.messageHash)))).filter(Boolean);
      write.askedAt = new Date().toISOString();
      write.answers = answers;
      if (answers.length) settlePending(write, majority(answers));
    }
  } finally {
    asking = false;
  }
}

if (NODE_URLS.length) setInterval(() => { askPending().catch(() => {}); }, PENDING_POLL_MS).unref();

// --- FluxDrive data API (what the FluxOS node calls via fluxDriveClient) ---

const app = express();

// Apply the fault knobs uniformly to every data-plane request.
app.use(async (req, res, next) => {
  if (mode.slow) await sleep(mode.slow);
  if (mode.fail5xx) {
    res.status(503).json({ error: 'fluxdrive unavailable (injected)' });
    return;
  }
  next();
});

// Dual-signature upload of framed ciphertext. Body is the raw bytes; the
// dual-sig + metadata ride in X-Flux-* headers. The upload names the identity
// the blob belongs to; a locator already held under another identity is
// refused (claim-squat guard).
app.post('/api/v1/blob', express.raw({ type: '*/*', limit: '64mb' }), (req, res) => {
  const locator = req.get('X-Flux-Locator');
  if (!locator) {
    res.status(400).json({ error: 'X-Flux-Locator required' });
    return;
  }
  const identity = req.get('X-Flux-Identity');
  if (!identity) {
    res.status(400).json({ error: 'Upload names no identity' });
    return;
  }
  const existing = blobs.get(locator);
  if (existing && existing.identity && existing.identity !== identity) {
    res.status(409).json({ error: 'Locator already claimed by another app' });
    return;
  }
  blobs.set(locator, {
    bytes: Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || ''),
    appName: req.get('X-Flux-AppName') || null,
    identity,
    source: req.get('X-Flux-Source') || 'blob',
    timestamp: req.get('X-Flux-Timestamp') || null,
    arcaneSig: req.get('X-Flux-Arcane-Sig') || null,
    ownerSig: req.get('X-Flux-Owner-Sig') || null,
    tombstoned: false,
  });
  res.status(200).json({ ok: true, locator });
});

// Fetch ciphertext by locator (the backstop). The client does NOT url-encode the
// locator, so it arrives as a single path segment — the bench-channel locator is
// hex, never containing '/'. 404 -> the client returns null and falls through.
app.get('/api/v1/blob/:locator', (req, res) => {
  const entry = blobs.get(req.params.locator);
  // Express routes HEAD through this GET handler; record the presence probe.
  // The real service answers HEAD from the row alone (no body read) — the
  // response is the same 200/404 either way, Express just drops the body.
  if (req.method === 'HEAD') {
    heads.push({ locator: req.params.locator, found: !!entry, at: new Date().toISOString() });
  }
  if (!entry) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.set('Content-Type', 'application/octet-stream');
  res.send(entry.bytes);
});

// Slot reconcile: the live locator set of an identity and source; the identity's
// other rows of that source are tombstoned (orphan-with-grace, never a blind
// replace), behind the version floor per identity and source. A reconcile
// naming a message is held pending (202) until the nodes decide the message. A
// name whose identity the stub cannot tell is an unknown app (404).
app.post('/api/v1/blob/reconcile', express.json(), (req, res) => {
  const {
    appName, source, version, arcaneSig, ownerSig, liveLocators, pendingMessageHash,
  } = req.body || {};
  if (pendingMessageHash != null && pendingMessageHash !== '' && !MESSAGE_HASH.test(String(pendingMessageHash))) {
    res.status(400).json({ error: 'pendingMessageHash is not a message hash' });
    return;
  }
  const identity = identityOf(appName);
  if (!identity) {
    res.status(404).json({ error: 'Unknown app' });
    return;
  }
  const pendingHash = pendingMessageHash || null;
  if (pendingHash) {
    recordPending({
      kind: 'reconcile', messageHash: pendingHash, appName, identity, source, version, arcaneSig, ownerSig, body: Array.isArray(liveLocators) ? liveLocators : [],
    });
    askPending().catch(() => {});
    res.status(202).json({ status: 'pending', messageHash: pendingHash });
    return;
  }
  if (mode.strict) {
    const floor = floors.get(floorKeyOf(identity, source));
    if (floor != null && version <= floor) {
      reconciles.push({
        appName, identity, source, version, accepted: false, pendingMessageHash: null, at: new Date().toISOString(),
      });
      res.status(409).json({ error: 'version at or below floor' });
      return;
    }
  }
  applyReconcile({
    appName, identity, source, version, arcaneSig, ownerSig, liveLocators, pendingMessageHash: null,
  });
  res.status(200).json({ ok: true });
});

// PUT an owner-signed manifest. A manifest must name its identity, and once the
// name has a holder it must be the holder's (409 otherwise, in either mode). A
// manifest naming a message is held pending (202) until the nodes decide the
// message; one for a name with no holder must name one (400 otherwise), as the
// real service requires of a name its feed does not list. Strict enforces the
// per-row version floor and serves confirmed-only.
app.put('/api/v1/manifest/:appName', express.json(), (req, res) => {
  const { appName } = req.params;
  // Fail ONLY the manifest PUT — before the version check, so it's independent
  // of strict mode and leaves the slot-blob upload path intact.
  if (mode.failManifestPut) {
    res.status(503).json({ error: 'manifest put failed (injected)' });
    return;
  }
  const {
    version, timestamp, arcaneSig, ownerSig, manifest, pendingMessageHash,
  } = req.body || {};
  const identity = manifest && manifest.identity;
  if (typeof identity !== 'string' || identity.length === 0) {
    res.status(400).json({ error: 'Manifest names no identity' });
    return;
  }
  if (pendingMessageHash != null && pendingMessageHash !== '' && !MESSAGE_HASH.test(String(pendingMessageHash))) {
    res.status(400).json({ error: 'pendingMessageHash is not a message hash' });
    return;
  }
  const holder = holders.get(appName);
  if (holder != null && holder !== identity) {
    res.status(409).json({ error: 'Manifest is for another registration of this app name' });
    return;
  }
  const pendingHash = pendingMessageHash || null;
  if (holder == null && !pendingHash) {
    res.status(400).json({ error: 'A manifest for an app the feed does not list names the message that lists it' });
    return;
  }
  if (pendingHash) {
    recordPending({
      kind: 'manifest', messageHash: pendingHash, appName, identity, version, timestamp, arcaneSig, ownerSig, body: manifest,
    });
    askPending().catch(() => {});
    res.status(202).json({ status: 'pending', messageHash: pendingHash });
    return;
  }
  if (!applyManifestPut({
    appName, identity, version, timestamp, arcaneSig, ownerSig, manifest,
  })) {
    res.status(409).json({ error: 'version at or below stored' });
    return;
  }
  res.status(200).json({ ok: true });
});

// Fetch the manifest the name serves (cold-start fallback). Strict serves
// confirmed-only; 404 -> the client returns null and falls back to peers.
app.get('/api/v1/manifest/:appName', (req, res) => {
  const entry = servedManifest(req.params.appName);
  if (!entry) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.status(200).json({ version: entry.version, manifest: entry.manifest });
});

app.listen(PORT, () => console.log(`FluxDrive stub data API on port ${PORT}, asking ${NODE_URLS.length} node(s) about pending writes`));

// --- Test harness control API ---

const control = express();
control.use(express.json({ limit: '64mb' }));

control.get('/health', (req, res) => res.json({ status: 'ok' }));

const pendingView = (p) => ({
  kind: p.kind, messageHash: p.messageHash, appName: p.appName, identity: p.identity, version: p.version, source: p.source ?? null, receivedAt: p.receivedAt, askedAt: p.askedAt, answers: p.answers,
});

// Full snapshot for assertions: blob metadata (not bytes), the manifest each
// name serves (`manifests`, by name) and every stored manifest row
// (`manifestRows`), the name holders, the reconcile log, the HEAD presence-probe
// log, the strict floors, the pending writes and the decisions taken on them,
// and the active mode.
control.get('/state', (req, res) => {
  res.json({
    blobs: [...blobs.entries()].map(([locator, e]) => ({
      locator, appName: e.appName, identity: e.identity, source: e.source, timestamp: e.timestamp,
      arcaneSig: e.arcaneSig, ownerSig: e.ownerSig, tombstoned: e.tombstoned, byteLength: e.bytes.length,
    })),
    manifests: Object.fromEntries([...new Set([...manifests.values()].map((row) => row.appName))]
      .map((appName) => [appName, servedManifest(appName)])
      .filter(([, row]) => row != null)),
    manifestRows: [...manifests.values()],
    holders: Object.fromEntries(holders),
    reconciles,
    heads,
    floors: Object.fromEntries(floors),
    pending: pending.map(pendingView),
    decisions,
    nodeUrls: NODE_URLS,
    mode,
  });
});

control.get('/blob/:locator', (req, res) => {
  const e = blobs.get(req.params.locator);
  if (!e) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({
    locator: req.params.locator, appName: e.appName, identity: e.identity, source: e.source, timestamp: e.timestamp, tombstoned: e.tombstoned, byteLength: e.bytes.length,
  });
});

// The manifest the name serves.
control.get('/manifest/:appName', (req, res) => {
  const e = servedManifest(req.params.appName);
  if (!e) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(e);
});

// The pending writes, optionally those naming one message.
control.get('/pending', (req, res) => {
  const { messageHash } = req.query;
  res.json(pending.filter((p) => !messageHash || p.messageHash === messageHash).map(pendingView));
});

// Decide the pending writes naming a message, as the nodes' majority would:
// { decision: 'applied' | 'refused' | 'unpayable' | 'undecided', identity? }.
control.post('/pending/:hash/decide', (req, res) => {
  const { decision, identity } = req.body || {};
  if (!['applied', 'refused', 'unpayable', 'undecided'].includes(decision)) {
    res.status(400).json({ error: 'decision must be applied, refused, unpayable or undecided' });
    return;
  }
  const outcomes = { applied: 0, discarded: 0, kept: 0 };
  for (const write of pending.filter((p) => p.messageHash === req.params.hash)) {
    outcomes[settlePending(write, { decision, identity: identity ?? null })] += 1;
  }
  res.json({ ok: true, ...outcomes });
});

// Ask the configured nodes now, instead of waiting for the next poll.
control.post('/pending/ask', async (req, res) => {
  await askPending();
  res.json({ ok: true, pending: pending.length, nodeUrls: NODE_URLS });
});

// Pre-seed a blob by locator (peer-fallback / cold-start scenarios).
control.post('/blob/:locator', (req, res) => {
  const {
    base64, appName, identity, source,
  } = req.body || {};
  blobs.set(req.params.locator, {
    bytes: Buffer.from(base64 || '', 'base64'),
    appName: appName || null,
    identity: identity || null,
    source: source || 'blob',
    timestamp: null,
    arcaneSig: null,
    ownerSig: null,
    tombstoned: false,
  });
  res.json({ ok: true });
});

// Pre-seed a manifest (cold-start backstop) under the identity it names.
// confirmed defaults true so a seeded manifest is immediately servable even in
// strict mode.
control.post('/manifest/:appName', (req, res) => {
  const { version, manifest, confirmed } = req.body || {};
  const identity = manifest && manifest.identity;
  if (typeof identity !== 'string' || identity.length === 0) {
    res.status(400).json({ error: 'Manifest names no identity' });
    return;
  }
  setManifest(req.params.appName, identity, { version, manifest, confirmed: confirmed !== false });
  res.json({ ok: true });
});

// Make `identity` the name's holder: confirm its row and evict every other row
// of the name (the go-live transition). A holder with no row yet is recorded,
// and its first manifest lands confirmed.
control.post('/manifest/:appName/promote', (req, res) => {
  const { identity } = req.body || {};
  if (typeof identity !== 'string' || identity.length === 0) {
    res.status(400).json({ error: 'identity required' });
    return;
  }
  promote(req.params.appName, identity);
  res.json({ ok: true });
});

control.post('/mode', (req, res) => {
  const {
    strict, slow, fail5xx, failManifestPut,
  } = req.body || {};
  if (strict !== undefined) mode.strict = !!strict;
  if (slow !== undefined) mode.slow = Number(slow) || 0;
  if (fail5xx !== undefined) mode.fail5xx = !!fail5xx;
  if (failManifestPut !== undefined) mode.failManifestPut = !!failManifestPut;
  res.json({ ok: true, mode });
});

control.post('/reset', (req, res) => {
  reset();
  res.json({ ok: true });
});

control.listen(CONTROL_PORT, () => console.log(`FluxDrive stub control API on port ${CONTROL_PORT}`));
