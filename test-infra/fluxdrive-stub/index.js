const express = require('express');

// FluxDrive blob-API stub for the integration harness. Mirrors the real
// fluxdrive-api endpoints that ZelBack/services/utils/fluxDriveClient.js drives:
// opaque-ciphertext storage by locator, the owner-signed manifest backstop, and
// the GC reconcile. FluxDrive never decrypts — it stores bytes — so this stub
// keeps raw buffers in memory and lets tests assert exactly what a node
// uploaded / reconciled. Permissive by default; strict mode (control /mode) adds
// the monotonic per-(appName,source) version floors, locator-ownership 409s, and
// confirmed-only manifest serving the real service enforces, so the cold-start /
// go-live gating paths can be exercised.

const PORT = parseInt(process.env.FLUXDRIVE_PORT || '16140', 10);
const CONTROL_PORT = parseInt(process.env.CONTROL_PORT || '16141', 10);

// locator -> { bytes:Buffer, appName, source, timestamp, arcaneSig, ownerSig, tombstoned }
const blobs = new Map();
// appName -> { version, timestamp, arcaneSig, ownerSig, manifest, confirmed }
const manifests = new Map();
// every reconcile call, in arrival order, for assertions
const reconciles = [];
// every HEAD presence probe on the blob fetch route, in arrival order — the
// carry-over submission contract asserts on these (a carried-over hash is
// presence-checked instead of re-uploaded)
const heads = [];
// `${appName}:${source}` -> highest accepted version (strict floor)
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
  reconciles.length = 0;
  heads.length = 0;
  floors.clear();
  mode.strict = false;
  mode.slow = 0;
  mode.fail5xx = false;
  mode.failManifestPut = false;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const floorKey = `${appName}:${source}`;
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

// PUT the latest owner-signed manifest backstop. Strict enforces the version
// floor and stores unconfirmed (the register-window self-assert); a live update
// is confirmed via the control /promote, and strict GET serves confirmed-only.
app.put('/api/v1/manifest/:appName', express.json(), (req, res) => {
  const { appName } = req.params;
  // Fail ONLY the backstop manifest PUT — before the version check, so it's
  // independent of strict mode and leaves the slot-blob upload path intact.
  if (mode.failManifestPut) {
    res.status(503).json({ error: 'manifest put failed (injected)' });
    return;
  }
  const { version, timestamp, arcaneSig, ownerSig, manifest } = req.body || {};
  const stored = manifests.get(appName);
  if (mode.strict && stored && version <= stored.version) {
    res.status(409).json({ error: 'version at or below stored' });
    return;
  }
  manifests.set(appName, {
    version,
    timestamp,
    arcaneSig,
    ownerSig,
    manifest,
    // Strict models the real go-live gate: a PUT lands unconfirmed until
    // promoted. Permissive serves everything, so confirmed is irrelevant there.
    confirmed: mode.strict ? false : true,
  });
  res.status(200).json({ ok: true });
});

// Fetch the confirmed manifest backstop (cold-start fallback). Strict serves
// confirmed-only; 404 -> the client returns null and falls back to peers.
app.get('/api/v1/manifest/:appName', (req, res) => {
  const entry = manifests.get(req.params.appName);
  if (!entry || (mode.strict && !entry.confirmed)) {
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

// Full snapshot for assertions: blob metadata (not bytes), stored manifests,
// the reconcile log, the HEAD presence-probe log, the strict floors, and the
// active mode.
control.get('/state', (req, res) => {
  res.json({
    blobs: [...blobs.entries()].map(([locator, e]) => ({
      locator, appName: e.appName, source: e.source, timestamp: e.timestamp,
      arcaneSig: e.arcaneSig, ownerSig: e.ownerSig, tombstoned: e.tombstoned, byteLength: e.bytes.length,
    })),
    manifests: Object.fromEntries(manifests),
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

control.get('/manifest/:appName', (req, res) => {
  const e = manifests.get(req.params.appName);
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

// Pre-seed a manifest (cold-start backstop). confirmed defaults true so a seeded
// manifest is immediately servable even in strict mode.
control.post('/manifest/:appName', (req, res) => {
  const { version, manifest, confirmed } = req.body || {};
  manifests.set(req.params.appName, {
    version, timestamp: null, arcaneSig: null, ownerSig: null, manifest,
    confirmed: confirmed !== false,
  });
  res.json({ ok: true });
});

// Promote a stored manifest to confirmed (the go-live transition).
control.post('/manifest/:appName/promote', (req, res) => {
  const e = manifests.get(req.params.appName);
  if (!e) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  e.confirmed = true;
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
