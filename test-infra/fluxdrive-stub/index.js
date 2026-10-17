const express = require('express');

// FluxDrive blob-API stub for the integration harness. Mirrors the real
// fluxdrive-api endpoints that ZelBack/services/utils/fluxDriveClient.js drives:
// opaque-ciphertext storage by locator and the owner-signed manifest put, which
// carries the slot locators the manifest keeps. FluxDrive never decrypts — it
// stores bytes — so this stub keeps raw buffers in memory and lets tests assert
// exactly what a node uploaded and which slot blobs a manifest marked.
//
// Content is keyed by the app's identity, as the real service keys it: a blob
// row carries the identity the upload names, manifests are kept per (appName,
// identity, ownership, version). The stub verifies no signature, so it has no
// owner, and none of its writes is provisional.
//
// The real service reads which registration holds a name from the network's
// spec feed. The stub learns it two ways: a pending write naming a message the
// nodes answer "applied" makes the write's identity the name's holder, and the
// control plane can set it (/manifest/:appName/promote). Once a name has a
// holder, only the holder's manifests are served.
//
// A manifest stored as its identity's newest version marks the identity's other
// slot blobs (`tombstoned`) and clears the mark of any it keeps again, as the
// real service does when it stores one confirmed.
//
// A manifest put that names a message hash is held pending, as the real service
// holds it: the stub asks the nodes it is configured with (FLUX_NODE_URLS) what
// became of the message, on arrival and on a timer, takes the majority of the
// answers it gets (a node holding nothing about the hash is not an answer),
// applies the write on "applied", discards it on "refused" or "unpayable" and
// keeps it otherwise. The control plane can decide a pending write directly
// (/pending/:hash/decide) for a suite that models an outcome.
//
// Permissive by default; strict mode (control /mode) adds the version floor per
// ownership, the locator-claim 409 and confirmed-only manifest serving, so the
// cold-start / go-live gating paths can be exercised.

const PORT = parseInt(process.env.FLUXDRIVE_PORT || '16140', 10);
const CONTROL_PORT = parseInt(process.env.CONTROL_PORT || '16141', 10);
// The nodes asked about a pending write's message, comma-separated base URLs.
const NODE_URLS = (process.env.FLUX_NODE_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
const PENDING_POLL_MS = parseInt(process.env.PENDING_POLL_MS || '2000', 10);
const ASK_TIMEOUT_MS = 4000;

// locator -> { bytes:Buffer, appName, identity, source, timestamp, arcaneSig, ownerSig, tombstoned }
const blobs = new Map();
// `${appName}\n${identity}\n${ownedFrom}\n${version}` -> { appName, identity, version, timestamp, arcaneSig, ownerSig, manifest, confirmed, seq }
// — one row per version of an identity, as the real service keeps them (D4)
const manifests = new Map();
// appName -> the identity of the registration that holds the name
const holders = new Map();
// manifest write order, the tie-break among equally ranked rows
let manifestSeq = 0;
// every kept list a stored manifest carried, in arrival order, for assertions:
// { appName, identity, ownedFrom, version, keptLocators, applied, pendingMessageHash }
const keptLists = [];
// every HEAD presence probe on the blob fetch route, in arrival order — the
// carry-over submission contract asserts on these (a carried-over hash is
// presence-checked instead of re-uploaded)
const heads = [];
// every pending write, in arrival order:
// { kind:'manifest', messageHash, appName, identity, version, body, keptLocators, receivedAt, askedAt, answers }
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
  keptLists.length = 0;
  heads.length = 0;
  pending.length = 0;
  decisions.length = 0;
  mode.strict = false;
  mode.slow = 0;
  mode.fail5xx = false;
  mode.failManifestPut = false;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ownedFromOf = (manifest) => Number(manifest?.ownedFrom ?? 0);
const manifestKey = (appName, identity, ownedFrom, version) => `${appName}\n${identity}\n${ownedFrom}\n${version}`;

function manifestRowsOf(appName) {
  return [...manifests.values()].filter((row) => row.appName === appName);
}

// The versions the data API serves for a name, newest first: of the holder's
// rows once the name has one, else of every row, ranked by the height each
// signer took the app (`ownedFrom`, 0 when the manifest names none) and the
// version within that. Strict serves confirmed rows only.
function servedManifests(appName) {
  const holder = holders.get(appName);
  const rank = (row) => [ownedFromOf(row.manifest), Number(row.version ?? 0), row.seq];
  const after = (a, b) => {
    const [ao, av, as] = rank(a);
    const [bo, bv, bs] = rank(b);
    return ao > bo || (ao === bo && (av > bv || (av === bv && as > bs)));
  };
  return manifestRowsOf(appName)
    .filter((row) => holder == null || row.identity === holder)
    .filter((row) => !mode.strict || row.confirmed)
    .sort((a, b) => (after(a, b) ? -1 : after(b, a) ? 1 : 0));
}

// The newest served version, for the control plane's view by name.
function servedManifest(appName) {
  return servedManifests(appName)[0] ?? null;
}

// The highest version stored for one ownership of an identity, or null.
function manifestFloor(identity, ownedFrom) {
  const versions = [...manifests.values()]
    .filter((row) => row.identity === identity && ownedFromOf(row.manifest) === ownedFrom)
    .map((row) => Number(row.version));
  return versions.length ? Math.max(...versions) : null;
}

function setManifest(appName, identity, fields) {
  manifestSeq += 1;
  manifests.set(manifestKey(appName, identity, ownedFromOf(fields.manifest), Number(fields.version)), {
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

// Mark the identity's slot blobs a manifest does not keep, and clear the mark
// of those it keeps again.
function applyKeptLocators(identity, keptLocators) {
  const kept = new Set(keptLocators);
  for (const [loc, entry] of blobs) {
    if (entry.identity === identity && entry.source === 'slot') entry.tombstoned = !kept.has(loc);
  }
}

// Whether a row is its identity's newest version, by the height its signer took
// the app and then its version.
function isNewest(identity, ownedFrom, version) {
  return ![...manifests.values()].some((row) => row.identity === identity
    && (ownedFromOf(row.manifest) > ownedFrom || (ownedFromOf(row.manifest) === ownedFrom && Number(row.version) > version)));
}

// Store a manifest version as its own row; strict refuses a version at or
// below the ownership's floor. An upload removes no version. Stored as its
// identity's newest version, it marks the slot blobs it does not keep.
function applyManifestPut({
  appName, identity, version, timestamp, arcaneSig, ownerSig, manifest, keptLocators, pendingMessageHash = null,
}) {
  const ownedFrom = ownedFromOf(manifest);
  const floor = manifestFloor(identity, ownedFrom);
  if (mode.strict && floor != null && Number(version) <= floor) return false;
  const newest = isNewest(identity, ownedFrom, Number(version));
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
  if (newest) applyKeptLocators(identity, keptLocators);
  keptLists.push({
    appName, identity, ownedFrom, version, keptLocators, applied: newest, pendingMessageHash, at: new Date().toISOString(),
  });
  return true;
}

// --- Pending writes: held until the nodes answer what became of the message ---

const MESSAGE_HASH = /^[0-9a-f]{64}$/;

function recordPending(write) {
  // A retried request replaces the earlier write of the same identity, ownership and version.
  const i = pending.findIndex((p) => p.identity === write.identity && ownedFromOf(p.body) === ownedFromOf(write.body) && p.version === write.version);
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
    // The applied message lists the name under this identity.
    promote(write.appName, write.identity);
    outcome = applyManifestPut({ ...write, manifest: write.body, pendingMessageHash: write.messageHash }) ? 'applied' : 'discarded';
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

// PUT an owner-signed manifest with the slot locators it keeps. A manifest must
// name its identity and keep at least one locator (400 otherwise). A manifest
// naming a message is held pending (202) until the nodes decide the message;
// one naming none is stored at once. Strict enforces the version floor per
// ownership and serves confirmed-only.
app.put('/api/v1/manifest/:appName', express.json(), (req, res) => {
  const { appName } = req.params;
  // Fail ONLY the manifest PUT — before the version check, so it's independent
  // of strict mode and leaves the slot-blob upload path intact.
  if (mode.failManifestPut) {
    res.status(503).json({ error: 'manifest put failed (injected)' });
    return;
  }
  const {
    version, timestamp, arcaneSig, ownerSig, manifest, keptLocators, pendingMessageHash,
  } = req.body || {};
  const identity = manifest && manifest.identity;
  if (typeof identity !== 'string' || identity.length === 0) {
    res.status(400).json({ error: 'Manifest names no identity' });
    return;
  }
  if (!Array.isArray(keptLocators) || keptLocators.length === 0) {
    res.status(400).json({ error: 'A manifest keeps at least one locator' });
    return;
  }
  if (pendingMessageHash != null && pendingMessageHash !== '' && !MESSAGE_HASH.test(String(pendingMessageHash))) {
    res.status(400).json({ error: 'pendingMessageHash is not a message hash' });
    return;
  }
  const pendingHash = pendingMessageHash || null;
  if (pendingHash) {
    recordPending({
      kind: 'manifest', messageHash: pendingHash, appName, identity, version, timestamp, arcaneSig, ownerSig, body: manifest, keptLocators,
    });
    askPending().catch(() => {});
    res.status(202).json({ status: 'pending', messageHash: pendingHash });
    return;
  }
  if (!applyManifestPut({
    appName, identity, version, timestamp, arcaneSig, ownerSig, manifest, keptLocators,
  })) {
    res.status(409).json({ error: 'version at or below stored' });
    return;
  }
  res.status(200).json({ ok: true });
});

// Fetch every kept version the name serves, newest first (cold-start fallback).
// Strict serves confirmed-only; 404 -> the client returns null and falls back to
// peers. The stub records no owner, so each version's is null.
app.get('/api/v1/manifest/:appName', (req, res) => {
  const rows = servedManifests(req.params.appName);
  if (rows.length === 0) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.status(200).json({
    versions: rows.map((row) => ({
      version: row.version, ownedFrom: ownedFromOf(row.manifest), owner: null, manifest: row.manifest,
    })),
  });
});

app.listen(PORT, () => console.log(`FluxDrive stub data API on port ${PORT}, asking ${NODE_URLS.length} node(s) about pending writes`));

// --- Test harness control API ---

const control = express();
control.use(express.json({ limit: '64mb' }));

control.get('/health', (req, res) => res.json({ status: 'ok' }));

const pendingView = (p) => ({
  kind: p.kind, messageHash: p.messageHash, appName: p.appName, identity: p.identity, version: p.version, keptLocators: p.keptLocators, receivedAt: p.receivedAt, askedAt: p.askedAt, answers: p.answers,
});

// Full snapshot for assertions: blob metadata (not bytes), the manifest each
// name serves (`manifests`, by name) and every stored manifest row
// (`manifestRows`), the name holders, the kept lists manifests carried, the HEAD
// presence-probe log, the pending writes and the decisions taken on them, and
// the active mode.
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
    keptLists,
    heads,
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
