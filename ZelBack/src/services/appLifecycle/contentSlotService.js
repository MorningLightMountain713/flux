const fs = require('node:fs/promises');
const { formidable } = require('formidable');
const axios = require('axios');
const log = require('../../lib/log');
const serviceHelper = require('../serviceHelper');
const messageHelper = require('../messageHelper');
const verificationHelper = require('../verificationHelper');
const signatureVerifier = require('../signatureVerifier');
const cryptoProvider = require('../providers/FluxOSCryptoProvider');
const contentBlobService = require('./contentBlobService');
const contentStore = require('./contentStore');
const dockerService = require('../dockerService');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');
const appsRepository = require('../appDatabase/appsRepository');
const networkStateService = require('../networkStateService');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const transportHelper = require('../utils/transportHelper');
const fluxDriveClient = require('../utils/fluxDriveClient');
const globalState = require('../utils/globalState');
const fluxEventBus = require('../utils/fluxEventBus');
const { getSpec } = require('../utils/specLibs');

const { sha256Hex } = contentBlobService;

const MANIFEST_GOSSIP_TYPE = 'fluxappcontentmanifest';

// A manifest received before its app's spec is locally available can't be
// owner-verified yet, so it is held quarantined (confirmed:false) with this TTL and
// promoted once the spec lands. Aligned with the FluxDrive reclaim window so both
// planes expire in lockstep. The partial TTL index that auto-reaps unconfirmed rows
// is declared where the appsglobal indexes are set up (see the quarantine handover).
const QUARANTINE_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * The content-slot names a spec declares across every component's contentSlot
 * mounts. Works on a class instance (componentEntries/getMountsWithContentSlot)
 * or a plain decoded spec, mirroring contentBlobService.specContentHashes.
 *
 * @param {object} spec
 * @returns {Set<string>}
 */
function specSlotNames(spec) {
  const names = new Set();
  const components = typeof spec.componentEntries === 'function'
    ? spec.componentEntries().map(([, comp]) => comp)
    : Object.values(spec.components || {});
  for (const comp of components) {
    const ps = comp && comp.persistentStorage;
    if (!ps || typeof ps.getMountsWithContentSlot !== 'function') continue;
    for (const mount of ps.getMountsWithContentSlot()) {
      if (mount.contentSlot) names.add(mount.contentSlot);
    }
  }
  return names;
}

/**
 * The canonical signing string for a ContentManifest — delegated to flux-spec so
 * the frontend signer and every verifier compute identical bytes. Operates on the
 * PLAINTEXT manifest (slots = { name: { hash } }).
 *
 * @param {object} manifest
 * @returns {Promise<string>}
 */
async function canonicalManifest(manifest) {
  const { canonicalContentManifest } = await getSpec();
  return canonicalContentManifest(manifest);
}

/**
 * Validate a plaintext manifest's structure + sizing (flux-spec), then verify the
 * owner signature over its canonical form and that every declared slot exists in
 * the spec. Throws on any failure — the manifest is the authority for which content
 * is live, so a bad one must never be accepted. Does NOT enforce version
 * monotonicity (the caller compares to the stored version).
 *
 * @param {object} manifest - plaintext manifest
 * @param {object} ctx - { owner, spec }
 * @param {object} deps - { verify? }
 */
async function verifyManifest(manifest, ctx, deps = {}) {
  const { owner } = ctx;
  let { spec } = ctx;
  const { verify = signatureVerifier.verifySignature } = deps;
  const { assertValidContentManifest } = await getSpec();

  // A spec read from the registry is the sealed EncryptedSpec for an encrypted app
  // (all content-slot apps are encrypted), whose declared slots aren't visible while
  // sealed. Decrypt it to its DecryptedCanonicalSpec and operate through that class.
  // The submission path passes an already-cleartext spec (isEncrypted === false),
  // which is left untouched.
  if (spec.isEncrypted) {
    const provider = deps.provider || await spec.createProvider();
    spec = await spec.decrypt(provider);
  }

  assertValidContentManifest(manifest);

  if (manifest.appName !== (spec.name || spec.appName)) {
    throw new Error('contentSlot: manifest appName does not match the spec');
  }

  const signed = await canonicalManifest(manifest);
  if (!verify(signed, owner, manifest.ownerSignature)) {
    throw new Error('contentSlot: invalid owner signature on manifest');
  }

  const declared = specSlotNames(spec);
  for (const name of Object.keys(manifest.slots)) {
    if (!declared.has(name)) {
      throw new Error(`contentSlot: manifest slot "${name}" is not declared in the spec`);
    }
  }
}

/**
 * Seal a manifest's plaintext slots map with the app secret, so the gossiped /
 * stored manifest never exposes the slot hashes of an encrypted app. The owner
 * signed the plaintext manifest, so the cleartext fields (appName/version/rollout/
 * timestamp) and the signature are unchanged — only `slots` is replaced by the
 * sealed envelope. Plaintext apps keep `slots` as-is.
 *
 * @param {object} manifest - plaintext manifest
 * @param {object} ctx - { owner, encrypted }
 * @param {object} deps - { provider? }
 * @returns {Promise<object>} the gossip-form manifest
 */
async function sealManifestSlots(manifest, ctx, deps = {}) {
  if (!ctx.encrypted) return manifest;
  const provider = deps.provider || (await cryptoProvider.create(manifest.appName, ctx.owner));
  const sealed = await provider.encrypt(Buffer.from(JSON.stringify(manifest.slots)));
  return { ...manifest, slots: { sealed } };
}

/**
 * Reverse sealManifestSlots: recover the plaintext slots map from a stored/gossiped
 * manifest. Plaintext apps are returned unchanged.
 *
 * @param {object} manifest - gossip-form manifest
 * @param {object} ctx - { owner, encrypted }
 * @param {object} deps - { provider? }
 * @returns {Promise<object>} the plaintext manifest
 */
async function openManifestSlots(manifest, ctx, deps = {}) {
  if (!ctx.encrypted) return manifest;
  if (!manifest.slots || !manifest.slots.sealed) {
    throw new Error('contentSlot: encrypted manifest is missing its sealed slots payload');
  }
  const provider = deps.provider || (await cryptoProvider.create(manifest.appName, ctx.owner));
  const plaintext = await provider.decrypt(manifest.slots.sealed);
  return { ...manifest, slots: JSON.parse(plaintext.toString('utf8')) };
}

/**
 * Process a manifest submission: verify it against the app's spec/owner, enforce
 * the strict-successor version rule (first manifest is 1, every later one exactly
 * current + 1), upload every slot's content as
 * a content blob (source 'slot', reusing the blob dual-sig upload), then return the
 * gossip-form manifest (slots sealed for an encrypted app) ready to store + gossip.
 * The blob parts are matched to the manifest's slot hashes exactly like content
 * blobs: every supplied blob must be referenced (a stray blob is an anti-abuse
 * reject), and every declared hash must either carry its blob part or be CARRIED
 * OVER — already delivered by the stored prior manifest, so its bytes sit in
 * FluxDrive under the identical locator. A carried-over hash is presence-checked
 * instead of re-uploaded, so rotating one slot attaches one file.
 *
 * @param {object} input - { manifest, spec, owner, encrypted, blobs, ownerSigs }
 * @param {object} deps - { getLatest?, refresh?, uploader, benchmark?, now?, verify?, provider? }
 * @returns {Promise<object>} the gossip-form manifest
 */
async function processManifestSubmission(input, deps) {
  const {
    manifest, spec, owner, encrypted, blobs, ownerSigs,
  } = input;
  const {
    getLatest = getLatestManifest, refresh = refreshLatestManifest, uploader, benchmark, now, verify, provider,
  } = deps;

  await verifyManifest(manifest, { owner, spec }, { verify });

  // Strict successor: the submission door is the only stage that can be strict —
  // gossip / boot-sync / the FluxDrive backstop must tolerate gaps (a receiver's
  // gap just means missed messages), but every submission is owner-interactive, so
  // requiring exactly current + 1 here keeps the network-wide sequence gapless and
  // bounds a leaked owner key to advancing the never-resetting counter one step per
  // signed update instead of burning the version space.
  let prior = await getLatest(manifest.appName);
  let expected = prior ? prior.version + 1 : 1;
  if (manifest.version > expected) {
    // Ahead of this node's view, which may just be stale (gossip lag, restart):
    // catch up once, then re-derive. A version BELOW expected is hopeless either
    // way — the floor only rises — so a stale resubmit costs no network round-trip.
    await refresh(manifest.appName, { owner, encrypted, spec }, { verify, provider });
    prior = await getLatest(manifest.appName);
    expected = prior ? prior.version + 1 : 1;
  }
  if (manifest.version !== expected) {
    throw new Error(`contentSlot: manifest version must be ${expected} (current is ${prior ? prior.version : 'none'}), got ${manifest.version}`);
  }

  // Hashes the stored prior manifest already delivered are carried over: their
  // bytes sit in FluxDrive under the identical locator, so this update attaches
  // only changed slots. The prior body is gossip-form (slots sealed for an
  // encrypted app) — open it to read the hashes.
  let carriedOver = new Set();
  if (prior && prior.data && prior.data.manifest) {
    const opened = await openManifestSlots(prior.data.manifest, { owner, encrypted }, { provider });
    carriedOver = new Set(Object.values(opened.slots).map((s) => s.hash));
  }

  const declaredHashes = new Set(Object.values(manifest.slots).map((s) => s.hash));
  for (const hash of blobs.keys()) {
    if (!declaredHashes.has(hash)) throw new Error(`contentSlot: blob ${hash} is not referenced by the manifest`);
  }

  for (const hash of declaredHashes) {
    if (!blobs.has(hash)) {
      if (!carriedOver.has(hash)) throw new Error(`contentSlot: missing blob part for ${hash}`);
      // eslint-disable-next-line no-await-in-loop
      await contentBlobService.assertBlobStored(
        { appName: manifest.appName, fluxID: owner, contentHash: hash },
        { uploader, benchmark },
      );
      continue;
    }
    const ownerSig = ownerSigs.get(hash);
    if (!ownerSig || !ownerSig.sig || ownerSig.timestamp == null) {
      throw new Error(`contentSlot: missing owner signature for ${hash}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await contentBlobService.encryptAndUploadBlob(
      {
        appName: manifest.appName,
        fluxID: owner,
        contentHash: hash,
        bytes: blobs.get(hash),
        ownerSig: ownerSig.sig,
        timestamp: ownerSig.timestamp,
        source: 'slot',
      },
      { uploader, benchmark, now },
    );
  }

  return sealManifestSlots(manifest, { owner, encrypted }, { provider });
}

/**
 * Persist the latest gossip-form manifest for an app — one doc per app, advanced
 * only by a strictly higher version. The conditional filter plus the unique appName
 * index make this an atomic latest-wins guard (a slower, lower-version writer loses
 * the race on the unique index). Returns true if stored.
 *
 * The row stores the SIGNED payload verbatim (`data`) plus the signature wrapper
 * (`envelope`) — split exactly like apprunning's appStateEvents, never a second copy
 * of the body. `opts.broadcast` is the signed node broadcast the manifest arrived in
 * (gossip / boot-sync) or that we minted to gossip it (originate); its `data` is kept
 * verbatim so a boot-sync re-serve verifies byte-exact, and `envelope` lets the
 * requester node-envelope-verify it (batchVerifyBroadcasts) on top of the manifest's
 * intrinsic owner signature. A catch-up body (no broadcast) gets a bare `data` wrapper
 * and no `envelope`: it serves install/apply locally but can't be re-served over
 * boot-sync (a node that does hold the envelope serves it instead). The manifest body
 * is always at `row.data.manifest`. `appName`/`version` are denormalized index/floor
 * scalars, not a copy of the body.
 *
 * @param {object} manifest - gossip-form manifest
 * @param {object} [opts] - { confirmed?, now?, broadcast? }
 * @returns {Promise<boolean>}
 */
async function storeManifest(manifest, opts = {}) {
  const confirmed = opts.confirmed !== false; // default true (verified store); explicit false = quarantine
  const { appName, version } = manifest;
  const data = opts.broadcast ? opts.broadcast.data : { type: MANIFEST_GOSSIP_TYPE, appName, manifest };
  const row = { appName, version, data };
  if (opts.broadcast) {
    const b = opts.broadcast;
    row.envelope = {
      version: b.version, timestamp: b.timestamp, pubKey: b.pubKey, signature: b.signature,
    };
  }
  // Quarantine TTL is the content domain's policy (aligned with the FluxDrive reclaim
  // window), so it's computed here and the row+expiry handed to the registry, which owns
  // the latest-wins/promote write. A store WITHOUT a broadcast is a catch-up body, so its
  // envelope is cleared (else a kept envelope would sign the OLD data).
  const now = opts.now || Date.now();
  const result = await appsRepository.upsertContentManifest(row, {
    confirmed,
    expireAt: confirmed ? undefined : new Date(now + QUARANTINE_TTL_MS),
    clearEnvelope: !opts.broadcast,
  });
  fluxEventBus.publish('content:manifestStored', { appName, version, confirmed });
  return result;
}

/**
 * The stored gossip-form manifest for an app, or null. Carries the top-level
 * `version` (the monotonic floor) alongside the manifest body.
 *
 * @param {string} appName
 * @returns {Promise<{version: number, manifest: object}|null>}
 */
async function getLatestManifest(appName) {
  return appsRepository.getContentManifest(appName);
}

/**
 * Receive a gossiped content manifest: dedup by version, recover the app's
 * owner + encryption status from its stored spec, decrypt the sealed slots (for an
 * encrypted app), verify the owner signature + declared slots, store latest-wins,
 * and re-broadcast for propagation. If this node runs the app, hand the plaintext
 * manifest to the rollout scheduler. Any failed check drops the manifest (never
 * stored, never applied) — the manifest is the authority for which content is live.
 *
 * Receive a gossiped content manifest (the domain logic). Two signatures gate a
 * manifest, at two layers. The relaying node's envelope signature is
 * cryptographically verified by the gossip layer (verifyFluxBroadcast) before this
 * ever runs, so a forged relay can't reach here. This verifies the app *owner's*
 * signature over the canonical manifest — the load-bearing check, since a
 * legitimate relaying node could still pass on a manifest it didn't author.
 *
 * Expected outcomes — a stale version, a manifest that arrived before its spec, a
 * forged signature, a lost store race, an app not installed here — are control flow
 * and drop quietly (the forged case logs at warn, the only security-relevant one).
 * It throws ONLY on an unexpected infrastructure failure (DB or the crypto channel),
 * which the fire-and-forget boundary surfaces at error level — the two are kept
 * distinct so a real fault is never hidden as a benign drop.
 *
 * @param {object} msgObj - received gossip message: { data: { type, appName, manifest } }
 * @param {object} deps - { getApp?, isInstalledHere?, rebroadcast?, schedule?, verify?, provider? }
 */
async function receiveManifest(msgObj, deps = {}) {
  const {
    getApp = appsRepository.getGlobalAppInfo,
    isInstalledHere = appsRepository.getInstalledApp,
    rebroadcast = fluxCommunicationMessagesSender.broadcastMessageToAll,
    schedule = scheduleContentApplication,
    verify,
    provider,
  } = deps;

  const gossipManifest = msgObj && msgObj.data && msgObj.data.manifest;
  if (!gossipManifest || !gossipManifest.appName || gossipManifest.version == null) return;
  const { appName } = gossipManifest;

  // Dedup: a strictly-older version is stale; a same-version is a duplicate UNLESS
  // the row we hold is still quarantined (then this receipt — now that the spec may
  // be local — can promote it). Versions are immutable + monotonic, never resetting.
  const prior = await getLatestManifest(appName);
  if (prior && gossipManifest.version < prior.version) {
    fluxEventBus.publish('content:manifestDropped', { appName, reason: 'stale_version' });
    return;
  }
  if (prior && gossipManifest.version === prior.version && prior.confirmed !== false) return;

  // Manifest-before-spec: we can't owner-verify without the spec, so QUARANTINE
  // (confirmed:false + TTL) instead of dropping — it is promoted when the spec lands
  // (a later receipt here, the spec-confirm hook, or install catch-up). The TTL reaps
  // it if the spec never arrives.
  const info = await getApp(appName);
  if (!info) {
    if (prior && gossipManifest.version <= prior.version) return; // already hold this version (quarantined)
    // Quarantine (confirmed:false) is observable via content:manifestStored, not a drop.
    await storeManifest(gossipManifest, { confirmed: false, broadcast: msgObj });
    return;
  }
  const { owner, isEncrypted: encrypted, spec } = info;

  let plaintext;
  try {
    plaintext = await openManifestSlots(gossipManifest, { owner, encrypted }, { provider });
    await verifyManifest(plaintext, { owner, spec }, { verify });
  } catch (error) {
    // Corrupt or forged gossip — log and drop. Never throws: this runs fire-and-forget
    // off the gossip dispatcher (the submission path throws to the submitter instead).
    log.warn(`contentSlot: dropping invalid manifest for ${appName} - ${error.message ?? error}`);
    fluxEventBus.publish('content:manifestDropped', { appName, reason: 'forged_signature' });
    return;
  }

  const stored = await storeManifest(gossipManifest, { confirmed: true, broadcast: msgObj });
  if (!stored) {
    fluxEventBus.publish('content:manifestDropped', { appName, reason: 'lost_store_race' });
    return; // lost the race to a same/higher version (or it is already confirmed)
  }
  fluxEventBus.publish('content:manifestReceived', { appName, version: gossipManifest.version });

  await rebroadcast(msgObj.data);

  const installed = await isInstalledHere(appName);
  if (installed && schedule) await schedule(plaintext, spec);
}

/**
 * Fire-and-forget gossip entry point. The dispatcher schedules this with no
 * `.catch`, so it must never reject: it runs receiveManifest and turns an
 * unexpected infrastructure failure into a single error-level log — distinct from
 * the expected, already-handled drops. A blanket catch-all would hide real faults,
 * so the boundary stays this thin and the domain logic keeps the two apart.
 *
 * @param {object} msgObj - received gossip message
 * @param {object} deps - forwarded to receiveManifest
 */
async function handleIncomingManifest(msgObj, deps = {}) {
  try {
    await receiveManifest(msgObj, deps);
  } catch (error) {
    const appName = msgObj && msgObj.data && msgObj.data.manifest && msgObj.data.manifest.appName;
    log.error(`contentSlot: failed handling manifest for ${appName || 'unknown'} - ${error.message ?? error}`);
  }
}

/**
 * Ingest a batch of synced manifest broadcasts (the boot-sync receive path). Each
 * `broadcast` was already node-envelope-verified upstream (batchVerifyBroadcasts);
 * here we apply the SAME owner-sig + spec gate as receiveManifest — minus the
 * rebroadcast and the apply-to-running-app — and reuse storeManifest, so the row
 * shape and the latest-wins/quarantine guards are identical to the gossip path: a
 * verified one is stored confirmed, one whose spec isn't local yet is quarantined
 * (promoted on spec-confirm), and a forged / stale / duplicate one is skipped.
 * Returns { stored } — the count newly stored or quarantined.
 *
 * @param {Array<object>} broadcasts - signed node broadcasts { version, timestamp, pubKey, signature, data: { manifest } }
 * @param {object} deps - { getApp?, getLatest?, store?, verify?, provider? }
 * @returns {Promise<{stored: number}>}
 */
async function storeBatchContentManifests(broadcasts, deps = {}) {
  const {
    getApp = appsRepository.getGlobalAppInfo,
    getLatest = getLatestManifest,
    store = storeManifest,
    verify,
    provider,
  } = deps;

  let stored = 0;
  for (const broadcast of broadcasts || []) {
    const manifest = broadcast && broadcast.data && broadcast.data.manifest;
    if (!manifest || !manifest.appName || manifest.version == null) continue;
    const { appName } = manifest;

    // eslint-disable-next-line no-await-in-loop
    const prior = await getLatest(appName);
    if (prior && manifest.version < prior.version) continue; // stale
    if (prior && manifest.version === prior.version && prior.confirmed !== false) continue; // already confirmed

    // eslint-disable-next-line no-await-in-loop
    const info = await getApp(appName);
    if (!info) {
      // Spec not local yet — quarantine (promoted when the spec confirms), unless we
      // already hold this version quarantined.
      if (prior && manifest.version <= prior.version) continue;
      // eslint-disable-next-line no-await-in-loop
      const okQ = await store(manifest, { confirmed: false, broadcast });
      if (okQ) stored += 1;
      continue;
    }
    const { owner, isEncrypted: encrypted, spec } = info;
    try {
      // eslint-disable-next-line no-await-in-loop
      const plaintext = await openManifestSlots(manifest, { owner, encrypted }, { provider });
      // eslint-disable-next-line no-await-in-loop
      await verifyManifest(plaintext, { owner, spec }, { verify });
    } catch (error) {
      log.warn(`contentSlot: dropping invalid synced manifest for ${appName} - ${error.message ?? error}`);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const okC = await store(manifest, { confirmed: true, broadcast });
    if (okC) stored += 1;
  }
  return { stored };
}

/** Delete a quarantined (confirmed:false) manifest row — used when it fails
 *  verification, so a real manifest at the same version isn't blocked by the floor. */
async function dropQuarantinedManifest(appName) {
  return appsRepository.deleteQuarantinedContentManifest(appName);
}

/**
 * Promote a locally-quarantined manifest once the app's spec becomes available — the
 * app-message-confirm hook. A node that does NOT run the app otherwise never promotes
 * a register-time quarantined manifest (no install, no re-gossip), so the TTL reaps it
 * and the node never caches/serves it for others' catch-up. Here we verify the held
 * manifest against the now-available spec and promote it (confirmed:true); a squatter's
 * / corrupt one is dropped (so a real manifest at the same version isn't floor-blocked).
 * A no-op when there is nothing quarantined or the spec is still absent. Returns true
 * if promoted. Safe to call fire-and-forget on the confirm path.
 *
 * @param {string} appName
 * @param {object} deps
 * @returns {Promise<boolean>}
 */
async function promoteQuarantinedManifest(appName, deps = {}) {
  const {
    getApp = appsRepository.getGlobalAppInfo,
    getLatest = getLatestManifest,
    store = storeManifest,
    drop = dropQuarantinedManifest,
    verify, provider,
  } = deps;
  const stored = await getLatest(appName);
  if (!stored || !stored.data || stored.confirmed !== false) return false; // nothing quarantined
  const info = await getApp(appName);
  if (!info) return false; // spec still not available — stays quarantined (or TTL-reaped)
  const { owner, isEncrypted: encrypted, spec } = info;
  const heldManifest = stored.data.manifest;
  try {
    const plaintext = await openManifestSlots(heldManifest, { owner, encrypted }, { provider });
    await verifyManifest(plaintext, { owner, spec }, { verify });
  } catch (error) {
    await drop(appName);
    return false;
  }
  // Preserve the node-signed broadcast captured at quarantine (rebuilt from the stored
  // envelope + verbatim data) so the promoted row stays boot-sync-servable.
  const broadcast = stored.envelope ? { ...stored.envelope, data: stored.data } : undefined;
  const promoted = await store(heldManifest, { confirmed: true, broadcast });
  if (promoted) fluxEventBus.publish('content:manifestPromoted', { appName });
  return promoted;
}

/** The IPs of nodes currently running an app, for peers-first content resolution. */
async function listAppPeers(appName) {
  const locations = await appsRepository.listLocationsByApp(appName);
  return (locations || []).map((l) => l.ip).filter(Boolean);
}

/**
 * Fetch one peer's latest stored (gossip-form) manifest for an app. Returns the
 * manifest body, or null on any error / no-manifest (the caller falls through to the
 * next peer). The caller re-verifies the owner signature and version, so an
 * unreachable or lying peer can only fail to contribute — never poison.
 *
 * @param {string} peer - peer host:port
 * @param {string} appName
 * @param {object} [deps] - { http }
 * @returns {Promise<object|null>}
 */
async function fetchManifestFromPeer(peer, appName, deps = {}) {
  const http = deps.http || axios;
  try {
    const res = await http.get(`http://${peer}/apps/contentmanifest/${appName}`, { timeout: 10_000 });
    const body = res && res.data;
    if (body && body.status === 'success' && body.data) return body.data;
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Catch-up: pull the latest manifest from up to N nodes running the app and adopt
 * the highest valid version (a lower or forged version can't beat an honest current
 * one — the owner signature is unforgeable). Each candidate is decrypted + fully
 * verified (owner sig over the canonical plaintext + declared slots) before it can
 * win, so a lying peer is rejected, not adopted. Returns { gossip, plaintext } for
 * the winner, or null when no peer yields a valid manifest.
 *
 * @param {string} appName
 * @param {string[]} peers - candidate peers (running the app)
 * @param {object} ctx - { owner, encrypted, spec }
 * @param {object} deps - { maxPeers?, fetch?, verify?, provider? }
 * @returns {Promise<{gossip: object, plaintext: object}|null>}
 */
async function fetchManifestFromPeers(appName, peers, ctx, deps = {}) {
  const { owner, encrypted, spec } = ctx;
  const {
    maxPeers = 3, fetch = fetchManifestFromPeer, verify, provider,
  } = deps;

  let best = null;
  for (const peer of (peers || []).slice(0, maxPeers)) {
    // eslint-disable-next-line no-await-in-loop
    const gossip = await fetch(peer, appName, deps);
    if (!gossip || gossip.appName !== appName || gossip.version == null) continue;
    if (best && gossip.version <= best.gossip.version) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const plaintext = await openManifestSlots(gossip, { owner, encrypted }, { provider });
      // eslint-disable-next-line no-await-in-loop
      await verifyManifest(plaintext, { owner, spec }, { verify });
      best = { gossip, plaintext };
    } catch (error) {
      log.warn(`contentSlot: rejected manifest from ${peer} for ${appName} - ${error.message ?? error}`);
    }
  }
  return best;
}

/**
 * Catch this node's stored manifest row up to the freshest version the network can
 * prove: running peers first (best-of-3, full owner-sig verification), then the
 * FluxDrive backstop (an untrusted store, so its copy passes the same decrypt +
 * owner-sig gate before adoption). Adopted bodies land through the strictly-higher-
 * wins upsert, so a stale or lying source can never regress the row. Failures are
 * swallowed: the caller re-reads the store and enforces against whatever view
 * survives — the refresh is an accuracy aid, never a new failure mode.
 *
 * @param {string} appName
 * @param {object} ctx - { owner, encrypted, spec }
 * @param {object} [deps] - { getLatest?, getPeers?, fetchPeers?, fetchFromDrive?, store?, verify?, provider? }
 * @returns {Promise<void>}
 */
async function refreshLatestManifest(appName, ctx, deps = {}) {
  const { owner, encrypted, spec } = ctx;
  const {
    getLatest = getLatestManifest,
    getPeers = listAppPeers,
    fetchPeers = fetchManifestFromPeers,
    fetchFromDrive = fluxDriveClient.fetchManifest,
    store = storeManifest,
    verify, provider,
  } = deps;
  try {
    const stored = await getLatest(appName);
    const floor = stored ? stored.version : 0;
    const peers = await getPeers(appName);
    const fetched = await fetchPeers(appName, peers, { owner, encrypted, spec }, { verify, provider });
    if (fetched && fetched.gossip.version > floor) {
      await store(fetched.gossip);
      return;
    }
    const fromDrive = await fetchFromDrive(appName);
    if (fromDrive && fromDrive.manifest && Number(fromDrive.version) > floor) {
      const opened = await openManifestSlots(fromDrive.manifest, { owner, encrypted }, { provider });
      await verifyManifest(opened, { owner, spec }, { verify });
      await store(fromDrive.manifest);
    }
  } catch (error) {
    log.warn(`contentSlot: manifest catch-up failed for ${appName} (enforcing against the stored view) - ${error.message ?? error}`);
  }
}

/**
 * GET /apps/contentmanifest/:appname — serve this node's latest stored (gossip-form)
 * manifest so a fresh/catching-up node can provision a slot app it can't yet see via
 * gossip. The slots payload stays sealed (the fetcher, an arcane node running the
 * app, unseals + verifies); a node without a manifest returns 404.
 */
async function getContentManifestApi(req, res) {
  try {
    const appname = req.params.appname || req.params.appName;
    if (!appname) {
      res.json(messageHelper.createErrorMessage('appname is required'));
      return;
    }
    const stored = await getLatestManifest(appname);
    // Serve only a CONFIRMED manifest — never a quarantined (unverified) one, so a
    // catching-up peer can't adopt a manifest this node hasn't verified yet.
    if (!stored || !stored.data || stored.confirmed === false) {
      res.status(404).json(messageHelper.createErrorMessage(`No content manifest for ${appname}`));
      return;
    }
    res.json(messageHelper.createDataMessage(stored.data.manifest));
  } catch (error) {
    log.error(error);
    res.json(messageHelper.createErrorMessage(error.message || error, error.name, error.code));
  }
}

/** Apply an injected file's ownership + mode: the slot mount's resolved perms —
 * the declared per-mount uid/gid/mode, or root-owned 0644 by default (DeploymentSpec
 * resolveMountPerms; mode bits are ownership hygiene — read-only enforcement is the
 * mount's readOnly bind flag). Both are set here so a declared mode is honored rather
 * than dropped by a blanket chmod. The node runs as root, so chown/chmod apply directly. */
async function defaultInjectedPerms(target, mount) {
  const { uid, gid, mode } = (mount && mount.perms) || { uid: 0, gid: 0, mode: '0644' };
  await fs.chown(target, Number(uid), Number(gid));
  await fs.chmod(target, parseInt(mode, 8));
}

/** Run a container reaction (signal/restart) without rolling back written content —
 * the new content is already on disk and is read on the next start regardless. */
async function reactSafely(fn) {
  try {
    await fn();
  } catch (error) {
    log.warn(`contentSlot: reaction failed (content is on disk, applied on next start) - ${error.message ?? error}`);
  }
}

/**
 * Stage every declared slot (resolve peers-first by locator, decrypt + hash-verify
 * into memory) and, only if ALL staged, write each by its delivery mechanism —
 * atomic:true temp+rename inside the managed dir, atomic:false in-place overwrite.
 * Returns the staged {comp, mount, bytes} list so the caller can react (apply) or
 * skip reacting (install-time provisioning, before the container exists). No write
 * happens unless every slot resolved (stage-all-then-apply).
 *
 * @param {object} deployment - DeploymentSpec for the app
 * @param {object} manifest - plaintext manifest (slot -> { hash })
 * @param {object} ctx - { appName, owner, peers }
 * @param {object} deps
 * @returns {Promise<Array<{comp: object, mount: object, bytes: Buffer}>>}
 */
async function stageAndApplySlots(deployment, manifest, ctx, deps = {}) {
  const { appName, owner, peers = [] } = ctx;
  const {
    resolve = contentBlobService.resolveBlob,
    benchmark, fluxDrive, peerFetch = contentBlobService.fetchBlobFromPeer,
    writeFile = fs.writeFile, rename = fs.rename, applyPerms = defaultInjectedPerms,
  } = deps;

  // 1. Stage every slot — resolve + verify to a buffer before touching disk.
  const staged = [];
  for (const [, comp] of deployment.componentEntries()) {
    for (const mount of comp.contentSlotMounts()) {
      const entry = manifest.slots[mount.slot];
      if (!entry || !entry.hash) throw new Error(`contentSlot: manifest has no hash for declared slot "${mount.slot}"`);
      // eslint-disable-next-line no-await-in-loop
      const bytes = await resolve(
        { appName, fluxID: owner, contentHash: entry.hash, peers },
        { benchmark, fluxDrive, peerFetch },
      );
      staged.push({ comp, mount, bytes });
    }
  }

  // 2. Write each staged slot by its delivery mechanism.
  for (const { mount, bytes } of staged) {
    if (mount.atomic) {
      const tmp = `${mount.source}.flux-content-tmp`;
      // eslint-disable-next-line no-await-in-loop
      await writeFile(tmp, bytes);
      // eslint-disable-next-line no-await-in-loop
      await applyPerms(tmp, mount);
      // eslint-disable-next-line no-await-in-loop
      await rename(tmp, mount.source); // atomic swap within the managed dir
    } else {
      // eslint-disable-next-line no-await-in-loop
      await writeFile(mount.source, bytes); // in-place overwrite of the single-file bind
      // eslint-disable-next-line no-await-in-loop
      await applyPerms(mount.source, mount);
    }
  }

  return staged;
}

// Per-app latch: the highest manifest version this process has applied. A version
// is applied at most once per node — the submitter's own POST apply and a peer's
// rebroadcast echo of that same manifest otherwise BOTH apply it (broadcast is
// deliberately before the local store, so the echo can win the dedup race), firing
// the component reaction twice; a late scheduled-rollout timer for a superseded
// version is skipped by the same guard. In-memory is enough: boot recovery
// re-provisions content idempotently before the container starts. The app-removal
// reaper (manifest-plane rework) must clear this alongside the manifest row.
const lastAppliedVersion = new Map();

/**
 * Apply a manifest's content to this node's installed, RUNNING app: stage + write
 * every declared slot (stageAndApplySlots), then fire ONE reaction per affected
 * component — restart subsumes signal subsumes null. A reaction failure never rolls
 * back the write (the new content is on disk and read on the next start regardless).
 * Applies each version at most once per node (see lastAppliedVersion).
 *
 * @param {object} deployment - DeploymentSpec for the installed app
 * @param {object} manifest - plaintext manifest (slot -> { hash })
 * @param {object} ctx - { appName, owner, peers }
 * @param {object} deps
 */
async function applyManifest(deployment, manifest, ctx, deps = {}) {
  const {
    signal = dockerService.appDockerSignal, restart = dockerService.appDockerRestart,
    recordApplied = appsRepository.setContentManifestApplied,
  } = deps;

  // Claim the version up front so a concurrent duplicate skips; roll back on a
  // failed apply so the version stays retryable.
  const prevApplied = lastAppliedVersion.get(ctx.appName);
  if (prevApplied != null && manifest.version <= prevApplied) {
    fluxEventBus.publish('content:slotApplySkipped', { appName: ctx.appName, version: manifest.version, reason: 'already_applied' });
    return;
  }
  lastAppliedVersion.set(ctx.appName, manifest.version);

  let staged;
  try {
    staged = await stageAndApplySlots(deployment, manifest, ctx, deps);
  } catch (error) {
    if (lastAppliedVersion.get(ctx.appName) === manifest.version) {
      if (prevApplied != null) lastAppliedVersion.set(ctx.appName, prevApplied);
      else lastAppliedVersion.delete(ctx.appName);
    }
    throw error;
  }

  // 3. One reaction per affected component — restart subsumes signal subsumes null.
  const reactionsByComp = new Map();
  for (const { comp, mount } of staged) {
    if (!reactionsByComp.has(comp)) reactionsByComp.set(comp, []);
    reactionsByComp.get(comp).push(mount.onUpdate);
  }
  for (const [comp, reactions] of reactionsByComp) {
    let reaction;
    if (reactions.some((r) => r && r.action === 'restart')) {
      // eslint-disable-next-line no-await-in-loop
      await reactSafely(() => restart(comp.identifier));
      reaction = 'restart';
    } else {
      const signals = [...new Set(reactions.filter((r) => r && r.action === 'signal').map((r) => r.signal))];
      for (const sig of signals) {
        // eslint-disable-next-line no-await-in-loop
        await reactSafely(() => signal(comp.identifier, sig));
      }
      // null reactions self-watch (atomic delivery is torn-safe) — no action.
      reaction = signals.length ? 'signal' : 'none';
    }
    fluxEventBus.publish('content:slotApplied', { appName: ctx.appName, version: manifest.version, reaction });
  }

  // Durably record what this node delivered to the running container, AFTER the write +
  // reaction — so a crash mid-apply leaves the version un-advanced and the next check
  // retries once, never a loop. Best-effort: the content is already live regardless.
  try {
    await recordApplied(ctx.appName, manifest.version);
  } catch (error) {
    log.warn(`contentSlot: failed to record applied version ${manifest.version} for ${ctx.appName} - ${error.message ?? error}`);
  }

  // Reap artifact-store entries the app no longer declares: keep the spec's
  // contentRef hashes + this (now-applied) manifest's slot hashes, so
  // superseded slot versions age out. Best-effort — an orphan costs at most a
  // few MB until the next apply or the uninstall reap.
  try {
    const keep = new Set();
    for (const [, comp] of deployment.componentEntries()) {
      for (const { hash } of comp.contentBlobMounts()) keep.add(hash);
    }
    for (const entry of Object.values(manifest.slots || {})) {
      if (entry && entry.hash) keep.add(entry.hash);
    }
    await (deps.store ?? contentStore).retainOnly(ctx.appName, keep);
  } catch (error) {
    log.warn(`contentSlot: artifact-store reap failed for ${ctx.appName} - ${error.message ?? error}`);
  }

}

/** Resolve a node's globally-unique, stable collateral txid from its ip:port via the
 *  in-memory network state (a map lookup, not a network call). null if unknown. */
async function resolveNodeCollateral(socketAddress) {
  const node = await networkStateService.getFluxnodeBySocketAddress(socketAddress);
  return node && node.collateral ? node.collateral : null;
}

/**
 * This node's staggered activation delay (ms within [0, staggerSeconds*1000)). The app's
 * running instances are ordered by their globally-unique, stable collateral txid — the
 * same ordering on every node — so the slots are evenly spread and reproducible (security
 * scan N7: ordinal-based, not hash%window which would birthday-collide). delay = (i/N) *
 * staggerSeconds, i = this node's ordinal in that set, N = spec.instances (clamped up to
 * the observed count so a transient over-count can't push a slot past the window). Call
 * this AT activateAt: a synced node has a converged view of the running set by then, so
 * the ordinal is well-defined (sync readiness is the guard, not a thin-view special-case).
 *
 * @param {string} appName
 * @param {number} instances - spec.instances (the fleet target)
 * @param {number} staggerSeconds
 * @param {object} deps - { getLocations?, resolveCollateral?, getSelfAddress? }
 * @returns {Promise<number>} delay in milliseconds
 */
async function computeStaggerDelayMs(appName, instances, staggerSeconds, deps = {}) {
  const {
    getLocations = appsRepository.listLocationsByApp,
    resolveCollateral = resolveNodeCollateral,
    getSelfAddress = fluxNetworkHelper.getLocalSocketAddress,
  } = deps;

  const selfAddress = await getSelfAddress();
  const selfCollateral = selfAddress ? await resolveCollateral(selfAddress) : null;
  // Can't place ourselves in the ordering — apply at activateAt (degenerate single-node case).
  if (!selfCollateral) return 0;

  const collaterals = new Set([selfCollateral]); // always include self
  const locations = (await getLocations(appName)) || [];
  for (const loc of locations) {
    if (!loc || !loc.ip) continue;
    // eslint-disable-next-line no-await-in-loop
    const collateral = await resolveCollateral(loc.ip);
    if (collateral) collaterals.add(collateral);
  }

  const sorted = [...collaterals].sort();
  const i = sorted.indexOf(selfCollateral);
  const observed = sorted.length;
  const target = Number(instances) > 0 ? Number(instances) : observed;
  const n = Math.max(target, observed); // clamp so a brief over-count can't exceed the window
  return Math.floor((i / n) * staggerSeconds * 1000);
}

/**
 * Apply a verified manifest to this node's installed app, honoring the manifest's rollout
 * strategy. Only for an app that is ALREADY RUNNING (the owner pushed a content update) —
 * first-install / boot content goes onto disk before the container starts via
 * provisionContentSlots, not here.
 *  - immediate  → apply now.
 *  - scheduled  → apply at activateAt (wall-clock-synchronized across the fleet); already
 *                 past ⇒ apply now (a node catching up after the moment).
 *  - staggered  → at activateAt, compute this node's collateral ordinal and apply after
 *                 (i/N)*staggerSeconds, so instances restart one-at-a-time across the window.
 * Re-checks the app is still installed before applying (it can expire mid-window). The wait
 * is an in-memory timer; a rollout interrupted by a restart is re-armed by boot-recovery.
 * flux-spec validates the rollout sizing (activateAt lead, staggerSeconds floor/24h cap),
 * so it is consumed here, not re-checked.
 *
 * @param {object} manifest - plaintext manifest (carries the cleartext rollout field)
 * @param {object} spec - the app's stored spec (owner + instances)
 * @param {object} deps
 */
async function scheduleContentApplication(manifest, spec, deps = {}) {
  const {
    getDeployment = deploymentProvider.getInstalledDeployment,
    getPeers = listAppPeers,
    apply = applyManifest,
    now = Date.now,
    setTimer = setTimeout,
    computeDelay = computeStaggerDelayMs,
    ...applyDeps
  } = deps;
  const { appName } = manifest;
  const rollout = manifest.rollout || { strategy: 'immediate' };

  // Apply now, re-checking the app is still installed here (discard if it expired mid-window).
  const runApply = async () => {
    const deployment = await getDeployment(appName);
    if (!deployment) return;
    const peers = await getPeers(appName);
    await apply(deployment, manifest, { appName, owner: spec.owner, peers }, applyDeps);
  };
  const runApplyDetached = () => runApply().catch((error) => log.warn(`contentSlot: deferred rollout apply for ${appName} failed - ${error.message ?? error}`));

  if (rollout.strategy !== 'scheduled' && rollout.strategy !== 'staggered') {
    await runApply(); // immediate (and the safe default for an unknown strategy)
    return;
  }

  // activateAt is an epoch-ms instant (no conversion); staggerSeconds is a seconds duration → ms.
  const activateAtMs = Number(rollout.activateAt);
  const staggerMs = (Number(rollout.staggerSeconds) || 0) * 1000;
  // Past the whole window (scheduled: past activateAt; staggered: past activateAt+stagger):
  // a node catching up after the moment applies the current content immediately.
  if (now() >= activateAtMs + staggerMs) {
    await runApply();
    return;
  }

  // At activateAt, freeze this node's slot (0 for scheduled) and apply when it arrives.
  const atActivate = async () => {
    let slotMs = 0;
    if (rollout.strategy === 'staggered') {
      slotMs = await computeDelay(appName, spec && spec.instances, Number(rollout.staggerSeconds) || 0, deps);
    }
    const waitMs = Math.max(0, (activateAtMs + slotMs) - now()); // 0 if our slot is already past (catch-up)
    fluxEventBus.publish('content:rolloutScheduled', { appName, version: manifest.version, delayMs: waitMs });
    if (waitMs === 0) runApplyDetached();
    else setTimer(runApplyDetached, waitMs);
  };

  const untilActivate = activateAtMs - now();
  if (untilActivate <= 0) {
    await atActivate(); // already at/after activateAt — compute the slot against the current (converged) view
  } else {
    setTimer(
      () => atActivate().catch((error) => log.warn(`contentSlot: rollout scheduling for ${appName} failed - ${error.message ?? error}`)),
      untilActivate,
    );
  }
}

/** True only when every content-bearing component of the deployment has a running
 *  container. A stopped or absent one means the app isn't up, so applying content would
 *  fire a reaction that wrongly (re)starts it — leave that to the start path, which stages
 *  the current content before the container comes up. */
async function contentComponentsRunning(deployment, deps = {}) {
  const { inspect = dockerService.dockerContainerInspect } = deps;
  for (const [, comp] of deployment.componentEntries()) {
    if (!comp.hasContentSlots()) continue;
    let info;
    try {
      // eslint-disable-next-line no-await-in-loop
      info = await inspect(comp.identifier);
    } catch (error) {
      return false; // container absent
    }
    if (!info || !info.State || !info.State.Running) return false;
  }
  return true;
}

/**
 * Bring a RUNNING container's slot content up to its stored manifest when this node's
 * register advanced past what it last delivered (appliedVersion) — an update learned via a
 * NON-gossip path (boot-sync of a version published during downtime, degrade-recovery, or
 * the steady-state refresh). Live gossip apply is fire-once, so such an update would sit in
 * the store unapplied and the container would serve stale content until it restarts. The
 * decision is register `version` vs `appliedVersion` (Flux-owned scalars), never the
 * mutable on-disk bytes a container may have changed. No-op unless the app is installed
 * here with content slots, its container is running, and it is behind. Honors the manifest
 * rollout (scheduleContentApplication → applyManifest, which advances appliedVersion).
 *
 * @param {string} appName
 * @param {object} deps
 * @returns {Promise<boolean>} whether an apply was scheduled
 */
async function applyStoredIfBehind(appName, deps = {}) {
  const {
    getStored = appsRepository.getContentManifest,
    getDeployment = deploymentProvider.getInstalledDeployment,
    getApp = appsRepository.getGlobalAppInfo,
    componentsRunning = contentComponentsRunning,
    schedule = scheduleContentApplication,
    provider,
  } = deps;

  const stored = await getStored(appName);
  if (!stored || !stored.data || stored.confirmed === false) return false; // nothing verified to apply
  if (stored.version <= (stored.appliedVersion ?? 0)) return false; // already delivered

  const deployment = await getDeployment(appName);
  if (!deployment || !deployment.componentEntries().some(([, comp]) => comp.hasContentSlots())) return false;
  if (!(await componentsRunning(deployment, deps))) return false; // stopped — the start path provisions it

  const info = await getApp(appName);
  if (!info) return false;
  const { owner, isEncrypted: encrypted, spec } = info;
  const plaintext = await openManifestSlots(stored.data.manifest, { owner, encrypted }, { provider });
  await schedule(plaintext, spec, deps);
  return true;
}

/**
 * Sweep this node's installed apps and catch up any running container that is behind its
 * stored manifest (applyStoredIfBehind self-filters the non-content and already-current
 * ones). The steady-state backstop's apply half: the orchestrator calls it after a manifest
 * refresh so a node that silently missed an update (partial partition, post-recovery)
 * converges its live content, not just its register. Best-effort per app.
 *
 * @param {object} deps
 * @returns {Promise<number>} count of apps caught up
 */
async function applyBehindContentApps(deps = {}) {
  const { listInstalled = appsRepository.listInstalledApps, applyBehind = applyStoredIfBehind } = deps;
  let installed;
  try {
    installed = await listInstalled();
  } catch (error) {
    log.warn(`contentSlot: applyBehindContentApps could not list installed apps - ${error.message ?? error}`);
    return 0;
  }
  let caughtUp = 0;
  for (const app of installed || []) {
    if (!app || !app.name) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      if (await applyBehind(app.name, deps)) caughtUp += 1;
    } catch (error) {
      log.warn(`contentSlot: catch-up for ${app.name} failed - ${error.message ?? error}`);
    }
  }
  return caughtUp;
}

/**
 * Boot-time content recovery for an already-installed slot app, run AFTER the node has
 * synced and BEFORE its container (re)starts (the boot gate opens only once the boot
 * reconcile loop returns, so writing content here lands before any container starts).
 * Brings the on-disk slot content to what should be live right now:
 *  - the latest stored manifest's rollout is DUE (immediate / activateAt passed, or no
 *    rollout) → provision that content before start (idempotent in steady state; catches
 *    up a version published while the node was down);
 *  - the rollout's activateAt is still in the FUTURE → leave the on-disk (currently-live)
 *    content untouched, do NOT apply the new version early, and re-arm
 *    scheduleContentApplication so it lands at activateAt on the now-running app.
 * A no-op for an app with no content slots. Best-effort by contract: the caller (boot
 * reconcile) catches failures so the app still starts on its persisted on-disk content.
 *
 * @param {string} appName
 * @param {object} deps
 */
async function reconcileBootContent(appName, deps = {}) {
  const {
    getDeployment = deploymentProvider.getInstalledDeployment,
    getApp = appsRepository.getGlobalAppInfo,
    getLatest = getLatestManifest,
    getPeers = listAppPeers,
    provision = provisionContentSlots,
    schedule = scheduleContentApplication,
    now = Date.now,
    restarting = true,
    provider,
  } = deps;

  const deployment = await getDeployment(appName);
  if (!deployment || !deployment.componentEntries().some(([, comp]) => comp.hasContentSlots())) return;

  // The don't-apply-early decision is on the CLEARTEXT rollout and needs no verification,
  // so read it from the stored manifest regardless of `confirmed` — otherwise a still-
  // quarantined future-dated row would slip through to provision and be applied early.
  const stored = await getLatest(appName);
  const manifest = stored && stored.data ? stored.data.manifest : null;
  const rollout = manifest && manifest.rollout;
  const deferred = rollout
    && (rollout.strategy === 'scheduled' || rollout.strategy === 'staggered')
    && Number(rollout.activateAt) > now(); // activateAt is epoch ms

  if (deferred) {
    // A future-dated rollout: never apply it early — the on-disk content (live before the
    // restart) stays. Re-arm it to land at activateAt (its in-memory timer died with the
    // process), but only if it is confirmed (verified): a quarantined row is left for the
    // normal confirm/gossip path, never applied early. Re-arm runs whether the container
    // was stopped (machine reboot) or survived (FluxOS process restart).
    if (stored.confirmed === false) return;
    const info = await getApp(appName);
    if (!info) return;
    const { owner, isEncrypted: encrypted, spec } = info;
    const plaintext = await openManifestSlots(manifest, { owner, encrypted }, { provider });
    await schedule(plaintext, spec, deps);
    return;
  }

  // Due (or no rollout): a container that is actually (re)starting gets the current content
  // staged before it starts (below). A surviving, still-running container instead catches up
  // in place if the register advanced past what we last delivered while the process was down
  // — a during-downtime update won't re-arrive (gossip is fire-once). No-op when it is
  // already current.
  if (!restarting) {
    await applyStoredIfBehind(appName, deps);
    return;
  }
  const peers = await getPeers(appName);
  await provision(deployment, { appName, peers }, deps);
  fluxEventBus.publish('content:bootReconcile', { appName, version: manifest && manifest.version });
}

/**
 * Provision a slot app's content at INSTALL time, before its container starts: get
 * the latest manifest (this node's store, else catch-up from up to 3 running peers,
 * else the FluxDrive deep backstop for the first-install / no-peer cold start) and
 * stage + write every declared slot — NO reaction (the container isn't running yet; it
 * reads the content on first start). This is the install-hold: it THROWS when no
 * manifest is reachable, so the install defers and retries rather than starting with
 * empty or stale slots (an app is not installable without its content). A no-op for an
 * app that declares no slots. Mirrors provisionContentBlobs; the difference is a slot's
 * hash comes from the manifest, not the signed spec. Publishes
 * content:slotsProvisioned once every slot is staged (hash-verified) and written —
 * the slot-path counterpart of the blob path's content:blobProvisioned.
 *
 * @param {object} deployment - DeploymentSpec for the app being installed
 * @param {object} ctx - { appName, peers? }
 * @param {object} deps
 */
async function provisionContentSlots(deployment, ctx, deps = {}) {
  // An app with no slots touches neither the DB nor the network — check first.
  const declaresSlots = deployment.componentEntries().some(([, comp]) => comp.hasContentSlots());
  if (!declaresSlots) return;

  const {
    getApp = appsRepository.getGlobalAppInfo,
    getLatest = getLatestManifest,
    getPeers = listAppPeers,
    fetchPeers = fetchManifestFromPeers,
    fetchFromDrive = fluxDriveClient.fetchManifest,
    store = storeManifest,
    stageApply = stageAndApplySlots,
    recordApplied = appsRepository.setContentManifestApplied,
    verify, provider,
    ...resolveDeps
  } = deps;
  const { appName } = ctx;

  const info = await getApp(appName);
  if (!info) throw new Error(`contentSlot: cannot provision ${appName} - app info not found`);
  const { owner, isEncrypted: encrypted, spec } = info;

  const peers = ctx.peers || (await getPeers(appName));

  // Prefer this node's already-verified stored manifest; otherwise catch up from a
  // running peer (the gossip may not have reached a fresh node yet). No peer with a
  // valid manifest ⇒ throw, so the install holds rather than serving empty slots.
  let plaintext;
  const stored = await getLatest(appName);
  const storedManifest = stored && stored.data ? stored.data.manifest : null;
  if (storedManifest && stored.confirmed !== false) {
    // Already verified (confirmed) — use directly.
    plaintext = await openManifestSlots(storedManifest, { owner, encrypted }, { provider });
  } else if (storedManifest) {
    // Quarantined locally (it arrived before the spec). We now HAVE the spec, so
    // verify it and promote it in place — no catch-up round-trip. A squatter's /
    // corrupt manifest fails verification and falls through to catch-up below.
    try {
      plaintext = await openManifestSlots(storedManifest, { owner, encrypted }, { provider });
      await verifyManifest(plaintext, { owner, spec }, { verify });
      const broadcast = stored.envelope ? { ...stored.envelope, data: stored.data } : undefined;
      await store(storedManifest, { confirmed: true, broadcast });
    } catch (error) {
      plaintext = null;
    }
  }
  if (!plaintext) {
    const fetched = await fetchPeers(appName, peers, { owner, encrypted, spec }, { verify, provider });
    if (fetched) {
      await store(fetched.gossip);
      plaintext = fetched.plaintext;
    } else {
      // No running peer served it (the first-install / no-peer cold start). Fall back to
      // the FluxDrive deep backstop. FluxDrive is an untrusted single-host store, so the
      // fetched manifest gets the SAME owner-sig + decrypt gate as a peer pull before we
      // adopt it; it lands as a catch-up body (no node broadcast to re-serve over sync).
      // The fetch is inside the try so a backstop error (unreachable / unconfigured /
      // forged copy) is treated as "no manifest" and falls through to the install-hold
      // below, mirroring the peer path (fetchManifestFromPeer also swallows + returns null).
      try {
        const fromDrive = await fetchFromDrive(appName);
        if (fromDrive && fromDrive.manifest) {
          const opened = await openManifestSlots(fromDrive.manifest, { owner, encrypted }, { provider });
          await verifyManifest(opened, { owner, spec }, { verify });
          await store(fromDrive.manifest);
          plaintext = opened;
        }
      } catch (error) {
        log.warn(`contentSlot: FluxDrive backstop did not yield a usable manifest for ${appName} - ${error.message ?? error}`);
      }
    }
    if (!plaintext) {
      throw new Error(`contentSlot: no manifest available to provision ${appName} - holding install until content is present`);
    }
  }

  await stageApply(deployment, plaintext, { appName, owner, peers }, resolveDeps);
  // Record the version we just staged so the steady-state "am I behind?" check
  // (applyStoredIfBehind) does not re-apply this same content to the now-running
  // container WITH a reaction — install content is provisioned before the container
  // starts and must not fire an onUpdate reaction. Best-effort, like applyManifest's
  // own record: a miss only costs one spurious reaction, never lost content.
  try {
    await recordApplied(appName, plaintext.version);
  } catch (error) {
    log.warn(`contentSlot: failed to record provisioned version ${plaintext.version} for ${appName} - ${error.message ?? error}`);
  }
  fluxEventBus.publish('content:slotsProvisioned', { appName, version: plaintext.version });
}

/**
 * Best-effort PUT of the latest owner-signed manifest to the FluxDrive backstop, so a
 * cold-starting node with no running peer can still provision the app (the first
 * instance has no peers — FluxDrive is its source, not a fallback). The node mints the
 * arcane sig over sha256(appName:version:timestamp); the OWNER PUT-sig is produced by
 * the frontend at submission and carried in the sealed content payload (the owner is
 * offline at backup time). A failed PUT is logged, not fatal — gossip + boot-sync are
 * the primary path and the next content-update re-establishes the backstop.
 *
 * @param {object} gossipManifest - the stored gossip-form manifest (sealed slots)
 * @param {object} ctx - { appName, version, timestamp, manifestPutSig }
 * @param {object} deps - { sign?, put?, benchmark? }
 * @returns {Promise<boolean>} true if the PUT succeeded
 */
async function backstopManifest(gossipManifest, ctx, deps = {}) {
  const {
    appName, version, timestamp, manifestPutSig,
  } = ctx;
  const {
    sign = contentBlobService.signUploadMessage, put = fluxDriveClient.putManifest, benchmark,
  } = deps;
  // No operational owner sig (frontend didn't supply it) -> can't authenticate the
  // PUT. Skip; gossip + peers still carry the manifest.
  if (!manifestPutSig) return false;
  try {
    const message = sha256Hex(`${appName}:${version}:${timestamp}`);
    const arcaneSig = await sign(message, { benchmark });
    await put(appName, {
      version, timestamp, arcaneSig, ownerSig: manifestPutSig, manifest: gossipManifest,
    });
    fluxEventBus.publish('content:manifestBackstopped', { appName, version });
    return true;
  } catch (error) {
    log.warn(`contentSlot: manifest backstop PUT failed for ${appName} (gossip + peers remain primary) - ${error.message ?? error}`);
    return false;
  }
}

/**
 * Push the slot app's live locator set to FluxDrive after a content update, so the GC
 * tombstones the now-superseded slot blobs (CONTENT_SLOTS §11; security scan N2/N4/F1).
 * The owner reconcile-sig over sha256(appName:slot:version) rides the sealed content
 * payload (frontend-produced at submission — the owner is online only then); the node
 * mints the arcane sig over the same token. liveLocators are the current manifest's slot
 * locators, derived over the benchmark channel exactly as resolveBlob/serveBlob derive
 * them — the manifest carries every declared slot, so this is the FULL live set, not a
 * delta. FluxDrive ADDS new locators + tombstones this app's other slot locators with
 * grace (never blind-replace), gated by the per-(appName, 'slot') monotonic version floor,
 * so a duplicate or stale push is an idempotent 409. Best-effort: a failed push leaves the
 * superseded blobs pinned until the next update's reconcile (self-healing) or app death
 * (lifecycle GC) — never fatal to the update.
 *
 * The first manifest (version 1, register) supersedes nothing — no prior version exists,
 * and any earlier incarnation's blobs were already reclaimed by lifecycle GC at expiry — so
 * it is skipped (it would also 404, the app not being in the confirmed feed at register).
 *
 * @param {object} plaintextManifest - the plaintext manifest (slots = { name: { hash } })
 * @param {object} ctx - { appName, owner, version, reconcileSig }
 * @param {object} deps - { benchmark?, deriveLocator?, sign?, reconcile? }
 * @returns {Promise<boolean>} true if the push was sent
 */
async function reconcileSlots(plaintextManifest, ctx, deps = {}) {
  const { appName, owner, version, reconcileSig } = ctx;
  const {
    benchmark,
    deriveLocator = contentBlobService.deriveLocator,
    sign = contentBlobService.signUploadMessage,
    reconcile = fluxDriveClient.reconcile,
  } = deps;
  // No owner reconcile-sig (frontend didn't supply one) → can't authenticate the push; and
  // the first version supersedes nothing.
  if (!reconcileSig || Number(version) <= 1) return false;
  try {
    const liveLocators = [];
    for (const slot of Object.values(plaintextManifest.slots || {})) {
      if (!slot || !slot.hash) continue;
      // eslint-disable-next-line no-await-in-loop
      liveLocators.push(await deriveLocator(benchmark, { appName, fluxID: owner, contentHash: slot.hash }));
    }
    // Never push an empty live set — it would tombstone every slot blob. A slot app always
    // declares at least one slot, so this only guards a malformed manifest.
    if (!liveLocators.length) return false;
    const token = sha256Hex(`${appName}:slot:${version}`);
    const arcaneSig = await sign(token, { benchmark });
    await reconcile(appName, {
      source: 'slot', version, arcaneSig, ownerSig: reconcileSig, liveLocators,
    });
    fluxEventBus.publish('content:reconcilePushed', { appName, source: 'slot', version });
    return true;
  } catch (error) {
    log.warn(`contentSlot: slot reconcile push failed for ${appName} (superseded blobs reclaimed on the next update or at app death) - ${error.message ?? error}`);
    return false;
  }
}

/**
 * Process a standalone content-update submission (the already-JSON-parsed
 * POST /apps/contentupdate body). The whole content payload — the manifest (with
 * plaintext slot hashes) and every blob's bytes — arrives in ONE HPKE-sealed
 * envelope toward this node's per-app transport key, so content is never in the
 * clear in transit or to any relay. We transport-open it, bind the cleartext meta to
 * the sealed manifest, then run the shared submission processing (owner-sig +
 * version monotonicity + per-blob upload + at-rest seal) and gossip the result. If
 * this node also runs the app, the new content is scheduled for application.
 *
 * @param {object} body - { appName, version, timestamp, content: <TransportEnvelope JSON>, ownerSigs }
 * @param {object} deps
 * @returns {Promise<object>} the gossip-form manifest that was stored + broadcast
 */
async function submitContentUpdate(body, deps = {}) {
  const {
    getApp = appsRepository.getGlobalAppInfo,
    isInstalledHere = appsRepository.getInstalledApp,
    openEnvelope = transportHelper.openContentEnvelope,
    processSubmission = processManifestSubmission,
    broadcast = fluxCommunicationMessagesSender.broadcastMessageToAll,
    uploader = fluxDriveClient,
    benchmark, now, verify, provider, schedule = scheduleContentApplication,
    backstop = backstopManifest,
    reconcile = reconcileSlots,
  } = deps;

  const {
    appName, version, timestamp, content, ownerSigs: ownerSigsObj,
  } = body || {};
  if (!appName || version == null || timestamp == null || !content) {
    throw new Error('contentSlot: incomplete content-update (need appName, version, timestamp, content)');
  }
  const ver = Number(version);
  const ts = Number(timestamp);

  const info = await getApp(appName);
  if (!info) throw new Error(`contentSlot: unknown app ${appName}`);
  const { owner, isEncrypted: encrypted, spec } = info;

  // Transport-open the sealed payload (content never travels unencrypted). The
  // cleartext meta drove the AAD, so binding it to the recovered manifest below
  // means a tampered meta can't slip past — the AEAD already broke if it was.
  const plaintext = await openEnvelope(content, {
    appName, owner, ref: `manifest:v${ver}`, timestamp: ts,
  });
  const payload = JSON.parse(plaintext.toString('utf8'));
  const {
    manifest, blobs: blobsObj, manifestPutSig, reconcileSig,
  } = payload || {};
  if (!manifest || !blobsObj) throw new Error('contentSlot: sealed content payload missing manifest or blobs');
  if (manifest.appName !== appName || manifest.version !== ver || manifest.timestamp !== ts) {
    throw new Error('contentSlot: content-update meta does not match the sealed manifest');
  }

  const blobs = new Map(Object.entries(blobsObj).map(([h, b64]) => [h, Buffer.from(b64, 'base64')]));
  const ownerSigs = new Map(Object.entries(ownerSigsObj || {}));

  const gossipManifest = await processSubmission(
    { manifest, spec, owner, encrypted, blobs, ownerSigs },
    { uploader, benchmark, now, verify, provider },
  );

  // Broadcast first: broadcastMessageToAll returns the exact signed node broadcast it
  // relayed, so we store that same envelope (one signature) for boot-sync re-serving.
  const signedBroadcast = await broadcast({ type: MANIFEST_GOSSIP_TYPE, appName, manifest: gossipManifest });
  await storeManifest(gossipManifest, { broadcast: signedBroadcast });
  fluxEventBus.publish('content:contentUpdateApplied', { appName, version: ver });

  // Populate the FluxDrive backstop so a cold-start node with no running peer can
  // still provision (best-effort; gossip + boot-sync are primary). The owner PUT-sig
  // rides the sealed payload (frontend-produced at submission); the node mints its arcane sig.
  await backstop(gossipManifest, {
    appName, version: ver, timestamp: ts, manifestPutSig,
  }, { benchmark });

  // Tell FluxDrive's GC the new live slot-locator set so the superseded blobs are
  // reclaimed (CONTENT_SLOTS §11). Best-effort; the owner reconcile-sig rides the sealed
  // payload, the node mints the arcane sig. Derives locators from the plaintext manifest.
  await reconcile(manifest, {
    appName, owner, version: ver, reconcileSig,
  }, { benchmark });

  // The submitter applies locally if it runs the app — gossip doesn't loop back.
  const installed = await isInstalledHere(appName);
  if (installed && schedule) await schedule(manifest, spec);

  return gossipManifest;
}

/**
 * Parse a content-update multipart submission: cleartext `appName`/`version`/
 * `timestamp` fields (the transport AAD inputs), one sealed `content` file part
 * (the HPKE TransportEnvelope over { manifest, blobs } — never plaintext), and an
 * `ownerSigs` JSON field. The envelope is opened downstream in submitContentUpdate.
 */
async function parseContentUpdate(req) {
  const form = formidable({ maxFileSize: await contentBlobService.maxContentBytes(), multiples: true, keepExtensions: false });
  const [fields, files] = await form.parse(req);
  const first = (v) => (Array.isArray(v) ? v[0] : v);

  const ownerSigs = serviceHelper.ensureObject(first(fields.ownerSigs) || '{}');
  let content = null;
  const contentFile = files.content ? first(files.content) : null;
  if (contentFile) {
    const raw = await fs.readFile(contentFile.filepath);
    content = serviceHelper.ensureObject(raw.toString('utf8'));
    await fs.unlink(contentFile.filepath).catch(() => {});
  }
  return {
    appName: first(fields.appName),
    version: Number(first(fields.version)),
    timestamp: Number(first(fields.timestamp)),
    content,
    ownerSigs,
  };
}

/**
 * POST /apps/contentupdate — HTTP adapter for a standalone content update. Gates to
 * a logged-in user + an arcane node (content is sealed toward this node's transport
 * key and must be opened here), parses the sealed submission, and runs the domain
 * flow. The owner signature inside the manifest is the binding authorization.
 */
async function submitContentUpdateApi(req, res) {
  try {
    const authorized = await verificationHelper.verifyPrivilege('user', req);
    if (!authorized) {
      res.json(messageHelper.errUnauthorizedMessage());
      return;
    }
    if (!globalState.isArcane()) {
      throw new Error('Content updates require an arcane node');
    }
    const body = await parseContentUpdate(req);
    const gossipManifest = await submitContentUpdate(body, {});
    res.json(messageHelper.createDataMessage({ appName: body.appName, version: gossipManifest.version }));
  } catch (error) {
    log.warn(error);
    res.json(messageHelper.createErrorMessage(error.message || error, error.name, error.code));
  }
}

module.exports = {
  specSlotNames,
  submitContentUpdate,
  submitContentUpdateApi,
  backstopManifest,
  reconcileSlots,
  canonicalManifest,
  verifyManifest,
  sealManifestSlots,
  openManifestSlots,
  processManifestSubmission,
  storeManifest,
  storeBatchContentManifests,
  getLatestManifest,
  receiveManifest,
  handleIncomingManifest,
  promoteQuarantinedManifest,
  stageAndApplySlots,
  applyManifest,
  scheduleContentApplication,
  computeStaggerDelayMs,
  applyStoredIfBehind,
  applyBehindContentApps,
  contentComponentsRunning,
  reconcileBootContent,
  provisionContentSlots,
  listAppPeers,
  fetchManifestFromPeer,
  fetchManifestFromPeers,
  refreshLatestManifest,
  getContentManifestApi,
};
