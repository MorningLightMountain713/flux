const express = require('express');

// FluxDrive blob-API stub for the integration harness. Mirrors the real
// fluxdrive-api endpoints that ZelBack/services/utils/fluxDriveClient.js drives:
// opaque-ciphertext storage by locator, the owner-signed manifest backstop, and
// the GC reconcile. FluxDrive never decrypts — it stores bytes — so this stub
// keeps raw buffers in memory and lets tests assert exactly what a node
// uploaded / reconciled.
//
// Manifests are kept per (appName, identity), as the real service keeps them per
// (appName, owner, identity); the stub verifies no signature, so it has no owner.
// The real service reads which registration holds a name from the network; the
// stub is told it (control /manifest/:appName/promote). Once a name has a holder,
// a manifest for another identity is refused 409 and only the holder's is served.
//
// Permissive by default; strict mode (control /mode) adds the monotonic version
// floors (per identity and source, per manifest row), locator-ownership 409s, and
// confirmed-only manifest serving, so the cold-start / go-live gating paths can be
// exercised.

const PORT = parseInt(process.env.FLUXDRIVE_PORT || '16140', 10);
const CONTROL_PORT = parseInt(process.env.CONTROL_PORT || '16141', 10);

// locator -> { bytes:Buffer, appName, source, timestamp, arcaneSig, ownerSig, tombstoned }
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
// `${identity}:${source}` (or `${appName}:${source}` before the name has a holder)
// -> highest accepted version (strict floor)
const floors = new Map();

// Behavior knobs the control plane drives. slow = per-request delay ms; fail5xx
// makes the data plane return 500 (the "FluxDrive 5xx aborts submission" path);
// failManifestPut fails ONLY the backstop manifest PUT (gossip stays primary,
// the synchronous slot-blob upload still succeeds).
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

// The row the data API serves for a name: the holder's once the name has one,
// else the latest written. Strict serves a confirmed row only.
function servedManifest(appName) {
  const holder = holders.get(appName);
  const rows = manifestRowsOf(appName)
    .filter((row) => holder == null || row.identity === holder)
    .filter((row) => !mode.strict || row.confirmed)
    .sort((a, b) => b.seq - a.seq);
  return rows[0] || null;
}

function setManifest(appName, identity, fields) {
  manifestSeq += 1;
  manifests.set(manifestKey(appName, identity), {
    appName, identity, timestamp: null, arcaneSig: null, ownerSig: null, ...fields, seq: manifestSeq,
  });
}

// Confirm the holder's row and evict every other row of the name (the go-live transition).
function promote(appName, identity) {
  holders.set(appName, identity);
  for (const [key, row] of manifests) {
    if (row.appName !== appName) continue;
    if (row.identity === identity) row.confirmed = true;
    else manifests.delete(key);
  }
}

const floorKeyOf = (appName, source) => `${holders.has(appName) ? holders.get(appName) : appName}:${source}`;

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
// dual-sig + metadata ride in X-Flux-* headers. Strict mode rejects a locator
// already held under a different owner sig (claim-squat guard).
app.post('/api/v1/blob', express.raw({ type: '*/*', limit: '64mb' }), (req, res) => {
  const locator = req.get('X-Flux-Locator');
  if (!locator) {
    res.status(400).json({ error: 'X-Flux-Locator required' });
    return;
  }
  const ownerSig = req.get('X-Flux-Owner-Sig');
  const existing = blobs.get(locator);
  if (mode.strict && existing && existing.ownerSig && ownerSig && existing.ownerSig !== ownerSig) {
    res.status(409).json({ error: 'locator owned by a different owner' });
    return;
  }
  blobs.set(locator, {
    bytes: Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || ''),
    appName: req.get('X-Flux-AppName') || null,
    source: req.get('X-Flux-Source') || 'blob',
    timestamp: req.get('X-Flux-Timestamp') || null,
    arcaneSig: req.get('X-Flux-Arcane-Sig') || null,
    ownerSig: ownerSig || null,
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

// GC reconcile: add the live locator set for an (appName,source) and tombstone
// this app's superseded rows of that source (orphan-with-grace, never a blind
// replace). Strict enforces the monotonic version floor; a stale/duplicate
// version is an idempotent 409 that the client treats as success.
app.post('/api/v1/blob/reconcile', express.json(), (req, res) => {
  const { appName, source, version, arcaneSig, ownerSig, liveLocators } = req.body || {};
  const floorKey = floorKeyOf(appName, source);
  if (mode.strict) {
    const floor = floors.get(floorKey);
    if (floor != null && version <= floor) {
      reconciles.push({ appName, source, version, accepted: false, at: new Date().toISOString() });
      res.status(409).json({ error: 'version at or below floor' });
      return;
    }
    floors.set(floorKey, version);
  }
  const live = new Set(Array.isArray(liveLocators) ? liveLocators : []);
  for (const [loc, entry] of blobs) {
    if (entry.appName === appName && entry.source === source && !live.has(loc)) {
      entry.tombstoned = true;
    }
  }
  reconciles.push({ appName, source, version, arcaneSig, ownerSig, liveLocators: [...live], accepted: true, at: new Date().toISOString() });
  res.status(200).json({ ok: true });
});

// PUT the latest owner-signed manifest backstop. A manifest must name its
// identity, and once the name has a holder it must be the holder's (409
// otherwise, in either mode). Strict enforces the per-row version floor and
// stores a manifest for a name with no holder unconfirmed (the register-window
// self-assert); the holder's manifest is confirmed. Strict GET serves
// confirmed-only.
app.put('/api/v1/manifest/:appName', express.json(), (req, res) => {
  const { appName } = req.params;
  // Fail ONLY the backstop manifest PUT — before the version check, so it's
  // independent of strict mode and leaves the slot-blob upload path intact.
  if (mode.failManifestPut) {
    res.status(503).json({ error: 'manifest put failed (injected)' });
    return;
  }
  const { version, timestamp, arcaneSig, ownerSig, manifest } = req.body || {};
  const identity = manifest && manifest.identity;
  if (typeof identity !== 'string' || identity.length === 0) {
    res.status(400).json({ error: 'Manifest names no identity' });
    return;
  }
  const holder = holders.get(appName);
  if (holder != null && holder !== identity) {
    res.status(409).json({ error: 'Manifest is for another registration of this app name' });
    return;
  }
  const stored = manifests.get(manifestKey(appName, identity));
  if (mode.strict && stored && version <= stored.version) {
    res.status(409).json({ error: 'version at or below stored' });
    return;
  }
  setManifest(appName, identity, {
    version,
    timestamp,
    arcaneSig,
    ownerSig,
    manifest,
    // Strict models the real go-live gate: a manifest for a name with no holder
    // lands unconfirmed until promoted. Permissive serves everything.
    confirmed: !mode.strict || holder === identity,
  });
  res.status(200).json({ ok: true });
});

// Fetch the confirmed manifest backstop (cold-start fallback). Strict serves
// confirmed-only; 404 -> the client returns null and falls back to peers.
app.get('/api/v1/manifest/:appName', (req, res) => {
  const entry = servedManifest(req.params.appName);
  if (!entry) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.status(200).json({ version: entry.version, manifest: entry.manifest });
});

app.listen(PORT, () => console.log(`FluxDrive stub data API on port ${PORT}`));

// --- Test harness control API ---

const control = express();
control.use(express.json({ limit: '64mb' }));

control.get('/health', (req, res) => res.json({ status: 'ok' }));

// Full snapshot for assertions: blob metadata (not bytes), the manifest each
// name serves (`manifests`, by name) and every stored manifest row
// (`manifestRows`), the name holders, the reconcile log, the HEAD presence-probe
// log, the strict floors, and the active mode.
control.get('/state', (req, res) => {
  res.json({
    blobs: [...blobs.entries()].map(([locator, e]) => ({
      locator, appName: e.appName, source: e.source, timestamp: e.timestamp,
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
    mode,
  });
});

control.get('/blob/:locator', (req, res) => {
  const e = blobs.get(req.params.locator);
  if (!e) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({ locator: req.params.locator, appName: e.appName, source: e.source, timestamp: e.timestamp, tombstoned: e.tombstoned, byteLength: e.bytes.length });
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

// Pre-seed a blob by locator (peer-fallback / cold-start scenarios).
control.post('/blob/:locator', (req, res) => {
  const { base64, appName, source } = req.body || {};
  blobs.set(req.params.locator, {
    bytes: Buffer.from(base64 || '', 'base64'),
    appName: appName || null,
    source: source || 'blob',
    timestamp: null, arcaneSig: null, ownerSig: null, tombstoned: false,
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
