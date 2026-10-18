'use strict';

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
const appRecords = require('../appDatabase/appRecords');
const appHistory = require('../appDecisions/appHistory');
const componentKeyMap = require('./componentKeyMap');
const appSpecHistory = require('../appDatabase/appSpecHistory');
const chainState = require('../chainState');
const temporaryPoolSweep = require('../appMessaging/temporaryPoolSweep');
const {
  standingManifest, highestVersionInOwnership, listedOwnership,
} = require('./manifestStanding');
const networkStateService = require('../networkStateService');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const transportHelper = require('../utils/transportHelper');
const fluxDriveClient = require('../utils/fluxDriveClient');
const volumeService = require('../utils/volumeService');
const globalState = require('../utils/globalState');
const fluxEventBus = require('../utils/fluxEventBus');
const { getSpec } = require('../utils/specLibs');
const { Privilege, authOf } = require('../utils/privileges');
const messageStore = require('../appMessaging/messageStore');

const MANIFEST_GOSSIP_TYPE = 'fluxappcontentmanifest';

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
 * @param {object} ctx - { owner, spec, identity } - the app the registry lists
 *   under the manifest's name, and that app's identity
 * @param {object} deps - { verify? }
 */
/**
 * What a sealed slots payload is authenticated against — the manifest apart from
 * the payload itself. flux-spec owns the byte string so the seal and the open
 * cannot derive it differently; see contentManifestSealAad for what it binds and
 * what it does not replace.
 *
 * @param {object} manifest - either form
 * @returns {Promise<Buffer>}
 */
async function sealAad(manifest) {
  const { contentManifestSealAad } = await getSpec();
  return Buffer.from(contentManifestSealAad(manifest), 'utf8');
}

async function verifyManifest(manifest, ctx, deps = {}) {
  const { owner } = ctx;
  let { spec } = ctx;
  const { verify = signatureVerifier.verifySignature } = deps;
  const { assertValidContentManifest, contentManifestHash, ownerSignedIsValid } = await getSpec();

  // A spec read from the registry is the sealed SealedSpec for an encrypted app
  // (all content-slot apps are encrypted), whose declared slots aren't visible while
  // sealed. Decrypt it to its OpenedSpec and operate through that class.
  // The submission path passes an already-cleartext spec, which is left untouched.
  //
  // `sealed`, not `isEncrypted`. They are different questions and only one of
  // them is the one being asked here. `sealed` is "can you be read right now";
  // `isEncrypted` is "is this an encrypted app", which stays TRUE on the
  // decrypted view. Since this takes its spec from the caller, an already
  // decrypted one can arrive — and it has no createProvider, so the old test
  // would have thrown `spec.createProvider is not a function` rather than
  // recognising a spec it can already read.
  //
  // The provider is the SPEC's own. It is not accepted from the caller, unlike
  // the sibling functions here that take `deps.provider` — theirs is the app
  // secret provider, a different key for a different envelope, and one name for
  // both on one module is how the wrong one gets passed in good faith. Nothing
  // ever supplied it here.
  if (spec.sealed) {
    spec = await spec.decrypt(await spec.createProvider());
  }

  assertValidContentManifest(manifest);

  if (manifest.appName !== (spec.name || spec.appName)) {
    throw new Error('contentSlot: manifest appName does not match the spec');
  }
  // A name can be registered again once its app expires; the owner signs which
  // registration the manifest is for.
  if (manifest.identity !== ctx.identity) {
    throw new Error('contentSlot: manifest is for another registration of this app name');
  }

  // A manifest is valid when the listed owner signed it in the listed
  // ownership, or the listed spec names it: a transfer names the manifest the
  // outgoing owner signed, and it stands under the incoming owner until they
  // sign one. The slots it lists
  // are no part of its validity: one the spec does not declare maps to no
  // mount, and no blob is fetched for it.
  const signed = await canonicalManifest(manifest);
  const listedOwnerSigned = Boolean(await verify(signed, owner, manifest.ownerSignature));
  const namedHash = (spec.content && spec.content.manifest) || null;
  const valid = ownerSignedIsValid(
    { identity: manifest.identity, hash: contentManifestHash(manifest), ownedFrom: manifest.ownedFrom },
    {
      appIdentity: ctx.identity, listedOwnerSigned, ownedFrom: ctx.ownedFrom, namedHash,
    },
  );
  if (!valid) {
    throw new Error(namedHash
      ? 'contentSlot: manifest is neither signed by the listed owner nor the one the spec names'
      : 'contentSlot: invalid owner signature on manifest');
  }
}

/**
 * Seal a manifest's plaintext slots map under the app's content key, so the
 * gossiped / stored manifest never exposes the slot hashes of an encrypted app.
 * The key is the identity's alone: the manifest stays readable by the app's
 * nodes across an ownership transfer. The owner signed the plaintext manifest,
 * so the cleartext fields (appName/identity/version/rollout/timestamp) and the
 * signature are unchanged — only `slots` is replaced by the sealed envelope.
 * Plaintext apps keep `slots` as-is.
 *
 * @param {object} manifest - plaintext manifest
 * @param {object} ctx - { encrypted }
 * @param {object} deps - { provider? }
 * @returns {Promise<object>} the gossip-form manifest
 */
async function sealManifestSlots(manifest, ctx, deps = {}) {
  if (!ctx.encrypted) return manifest;
  const provider = deps.provider || (await cryptoProvider.forIdentity(manifest.identity));
  const sealed = await provider.encrypt(
    Buffer.from(JSON.stringify(manifest.slots)),
    await sealAad(manifest),
  );
  return { ...manifest, slots: { sealed } };
}

/**
 * Reverse sealManifestSlots: recover the plaintext slots map from a stored/gossiped
 * manifest. Plaintext apps are returned unchanged.
 *
 * @param {object} manifest - gossip-form manifest
 * @param {object} ctx - { encrypted }
 * @param {object} deps - { provider? }
 * @returns {Promise<object>} the plaintext manifest
 */
async function openManifestSlots(manifest, ctx, deps = {}) {
  if (!ctx.encrypted) return manifest;
  if (!manifest.slots || !manifest.slots.sealed) {
    throw new Error('contentSlot: encrypted manifest is missing its sealed slots payload');
  }
  const provider = deps.provider || (await cryptoProvider.forIdentity(manifest.identity));
  const plaintext = await provider.decrypt(manifest.slots.sealed, await sealAad(manifest));
  return { ...manifest, slots: JSON.parse(plaintext.toString('utf8')) };
}

/**
 * Process a manifest submission: verify it against the app's spec/owner, enforce
 * the version rule — versions count per ownership: the first manifest an owner
 * signs after taking the app is 1, every later one exactly one above the highest
 * signed under that ownership, among those stored and those waiting in the pool
 * with the app's unpaid updates, so two slot-adding updates waiting at once take
 * consecutive numbers — upload every slot's content as a content blob (source
 * 'slot', reusing the blob dual-sig upload), then return the gossip-form manifest
 * (slots sealed for an encrypted app) ready to take, gossip or carry. The
 * ownership height inside the signed text must be the one the chain gives the
 * listed owner, 0 for a registration's manifest, which is signed before its
 * height exists.
 * The blob parts are matched to the manifest's slot hashes exactly like content
 * blobs: every supplied blob must be referenced (a stray blob is an anti-abuse
 * reject), and every declared hash must either carry its blob part or be CARRIED
 * OVER — already delivered by the standing manifest, so its bytes sit in
 * FluxDrive under the identical locator. A carried-over hash is presence-checked
 * instead of re-uploaded, so rotating one slot attaches one file.
 *
 * @param {object} input - { manifest, spec, owner, encrypted, identity, ownedFrom, original, blobs, ownerSigs }
 *   ownedFrom - the height the signing owner took the app, 0 for a registration
 *   original - whether that ownership is the app's first, under which the
 *     registration's list (signed at height 0) counts in the version sequence
 * @param {object} deps - { getRows?, pendingRanks?, standing?, refresh?, uploader, benchmark?, now?, verify?, provider? }
 * @returns {Promise<object>} the gossip-form manifest
 */
async function processManifestSubmission(input, deps) {
  const {
    manifest, spec, owner, encrypted, identity, ownedFrom, original = false, blobs, ownerSigs,
  } = input;
  const {
    getRows = (id) => appRecords.manifests().byIdentity(id), pendingRanks = appsRepository.carriedManifestRanks,
    standing = standingManifest, refresh = refreshManifests, uploader, benchmark, now, verify, provider,
  } = deps;

  if (!Number.isSafeInteger(ownedFrom) || ownedFrom < 0) throw new Error('contentSlot: the submission names no ownership height');
  if (manifest.ownedFrom !== ownedFrom) {
    throw new Error(`contentSlot: manifest ownedFrom must be ${ownedFrom}, the height the owner took the app (0 for a registration), got ${manifest.ownedFrom}`);
  }
  await verifyManifest(manifest, {
    owner, spec, identity, ownedFrom,
  }, { verify });

  // The submission door is the only stage that can be strict — every other path
  // keeps what it is given and ranks it — and every submission is
  // owner-interactive, so requiring exactly the next number here keeps the
  // sequence within an ownership gapless and bounds a leaked owner key to
  // advancing the counter one step per signed update. A manifest waiting in the
  // pool with an unpaid update counts: the update may yet apply.
  const ownership = { owner, from: ownedFrom, original };
  const expectedVersion = async () => (await highestVersionInOwnership(identity, ownership, { getRows, pendingRanks })) + 1;
  let expected = await expectedVersion();
  if (manifest.version > expected) {
    // Ahead of this node's view, which may just be stale (gossip lag, restart):
    // catch up once, then re-derive. A version BELOW expected is hopeless either
    // way — the floor only rises — so a stale resubmit costs no network round-trip.
    await refresh(manifest.appName, identity, { verify, provider });
    expected = await expectedVersion();
  }
  if (manifest.version !== expected) {
    throw new Error(`contentSlot: manifest version must be ${expected} within this ownership, got ${manifest.version}`);
  }

  // Hashes the standing manifest already delivered are carried over: their bytes
  // sit in FluxDrive under the identical locator, so this update attaches only
  // changed slots. The standing body is gossip-form (slots sealed for an
  // encrypted app) — open it to read the hashes.
  let carriedOver = new Set();
  const { row: standingRow } = await standing(identity, deps);
  if (standingRow) {
    const opened = await openManifestSlots(standingRow.manifest, { encrypted }, { provider });
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
        { identity, contentHash: hash },
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
        identity,
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

// ── The manifests a node holds ─────────────────────────────────────────
// A node keeps every manifest it takes for an app, one row per manifest keyed
// by the app identity and the manifest's hash, and stands on the highest-ranked
// one the listed row validates: signed by the listed owner, or named by the
// listed spec's `content` block. Rank is the height at which the signer took
// the app, then the version within that ownership, so what a later owner signs
// outranks anything an earlier owner signed. A manifest arriving before the
// app's row cannot be judged and is held, with an expiry, until a row write
// judges it; one the row stops validating stays, and stands again should the
// row return to its signer. Nothing is chosen at arrival.

// A manifest held before its app's row is listed is judged at the row write;
// the TTL index reaps one whose row never comes.
const HELD_TTL_MS = 2 * 60 * 60 * 1000;

/** Whether a manifest's slots travel sealed: an encrypted app's. */
async function isSealedForm(gossipManifest) {
  const { sealedSlots } = await getSpec();
  return sealedSlots(gossipManifest.slots);
}

/**
 * The owner of the app whose signature verifies over a manifest. The owners
 * come from this node's own applied history, never from the manifest, and the
 * ownership height inside the signed text must be one at which that owner took
 * the app, or 0 from the first owner, who signs a registration's manifest before
 * its height exists.
 *
 * @param {object} plaintext - the opened manifest
 * @param {object} app - the listed app (RegisteredSpec)
 * @param {object} [deps] - { ownerships?, verify? }
 * @returns {Promise<{signer: ?string, reason: ?string}>}
 */
async function signerOf(plaintext, app, deps = {}) {
  const { ownerships = appHistory.ownerships, verify = signatureVerifier.verifySignature } = deps;
  const owners = await ownerships(app.name);
  if (!owners.length) return { signer: null, reason: 'no_history' };
  const signed = await canonicalManifest(plaintext);
  for (const { owner } of owners) {
    // eslint-disable-next-line no-await-in-loop
    if (await verify(signed, owner, plaintext.ownerSignature)) {
      const took = owners.some((o) => o.owner === owner && o.from === plaintext.ownedFrom)
        || (plaintext.ownedFrom === 0 && owners[0].owner === owner);
      return took ? { signer: owner, reason: null } : { signer: null, reason: 'wrong_ownership_height' };
    }
  }
  return { signer: null, reason: 'forged_signature' };
}

/**
 * Takes a manifest from any path — gossip, boot sync, a peer's answer, FluxDrive,
 * the message an applied update carried, this node's own submission — and keeps
 * it. The slots are opened under the app's content key and the body is checked
 * against the library; its hash keys the row. When the app the identity names is
 * listed, the signer is found among the owners of the app's applied history
 * (signerOf); a manifest no owner signed is dropped. When the app is not yet
 * listed the row is held unresolved until the row write judges it. Which
 * manifest the app stands on is derived at read, never chosen here.
 *
 * @param {object} gossipManifest - the manifest as it travels (slots sealed for an encrypted app)
 * @param {object} [opts] - { broadcast?: the signed node broadcast it arrived in, now? }
 * @param {object} [deps] - { getApp?, getRow?, put?, ownerships?, verify?, provider? }
 * @returns {Promise<{outcome: 'stored'|'held'|'duplicate'|'dropped', reason?: string, hash?: string, plaintext?: object, app?: ?object, signer?: string}>}
 */
async function takeManifest(gossipManifest, opts = {}, deps = {}) {
  const {
    getApp = (identity) => appRecords.registry().byIdentity(identity),
    getRow = (id, h) => appRecords.manifests().byHash(id, h),
    put = (record, opts) => appRecords.manifests().put(record, opts),
    ownerships, verify, provider,
  } = deps;
  const { broadcast = null, now = Date.now() } = opts;
  const appName = gossipManifest && gossipManifest.appName;
  const dropped = (reason) => {
    fluxEventBus.publish('content:manifestDropped', { appName, reason });
    return { outcome: 'dropped', reason };
  };
  if (!gossipManifest || !appName || !gossipManifest.identity || gossipManifest.version == null || gossipManifest.ownedFrom == null) {
    return dropped('malformed');
  }
  const { identity } = gossipManifest;

  const { assertValidContentManifest, contentManifestHash } = await getSpec();
  let plaintext;
  try {
    plaintext = await openManifestSlots(gossipManifest, { encrypted: await isSealedForm(gossipManifest) }, { provider });
    assertValidContentManifest(plaintext);
  } catch (error) {
    log.warn(`contentSlot: dropping an unreadable manifest for ${appName} - ${error.message ?? error}`);
    return dropped('invalid');
  }
  const hash = contentManifestHash(plaintext);
  const data = broadcast ? broadcast.data : { type: MANIFEST_GOSSIP_TYPE, appName, manifest: gossipManifest };
  const envelope = broadcast ? {
    version: broadcast.version, timestamp: broadcast.timestamp, pubKey: broadcast.pubKey, signature: broadcast.signature,
  } : undefined;
  const row = {
    identity, hash, version: plaintext.version, ownedFrom: plaintext.ownedFrom, data, envelope,
  };

  const app = await getApp(identity);
  if (!app) {
    const { inserted } = await put({ ...row, signer: null, expireAt: new Date(now + HELD_TTL_MS) }, { now });
    fluxEventBus.publish('content:manifestStored', {
      appName, identity, version: plaintext.version, hash, resolved: false,
    });
    return {
      outcome: inserted ? 'held' : 'duplicate', hash, plaintext, app: null,
    };
  }
  if (app.name !== appName) return dropped('another_name');
  const { signer, reason } = await signerOf(plaintext, app, { ownerships, verify });
  if (!signer) {
    log.warn(`contentSlot: dropping a manifest for ${appName} - ${reason}`);
    return dropped(reason);
  }
  const existing = await getRow(identity, hash);
  await put({ ...row, signer }, { now });
  fluxEventBus.publish('content:manifestStored', {
    appName, identity, version: plaintext.version, hash, resolved: true,
  });
  return {
    outcome: existing && existing.isResolved ? 'duplicate' : 'stored', hash, plaintext, app, signer,
  };
}

/**
 * The standing manifest opened: its row and its plaintext, or null when none
 * stands.
 * @param {string} identity
 * @param {object} [deps] - standingManifest's, plus { provider? }
 * @returns {Promise<?{app: object, row: object, plaintext: object}>}
 */
async function openStandingManifest(identity, deps = {}) {
  const { app, row } = await standingManifest(identity, deps);
  if (!row) return null;
  const gossip = row.manifest;
  const plaintext = await openManifestSlots(gossip, { encrypted: await isSealedForm(gossip) }, { provider: deps.provider });
  return { app, row, plaintext };
}

/**
 * Judges the rows held before the app was listed, now that it is: each is
 * resolved to the owner who signed it or dropped.
 * @param {string} identity
 * @param {object} [deps]
 * @returns {Promise<number>} rows resolved
 */
async function resolveHeldManifests(identity, deps = {}) {
  const {
    getApp = (identity) => appRecords.registry().byIdentity(identity),
    getRows = (id) => appRecords.manifests().byIdentity(id),
    resolve = (id, h, signer) => appRecords.manifests().resolve(id, h, signer),
    drop = (id, h) => appRecords.manifests().remove(id, h),
    ownerships, verify, provider,
  } = deps;
  const app = await getApp(identity);
  if (!app) return 0;
  let resolved = 0;
  for (const row of (await getRows(identity)).filter((held) => !held.isResolved)) {
    const gossip = row.manifest;
    let signer = null;
    let reason = 'invalid';
    try {
      // eslint-disable-next-line no-await-in-loop
      const plaintext = await openManifestSlots(gossip, { encrypted: await isSealedForm(gossip) }, { provider });
      // eslint-disable-next-line no-await-in-loop
      ({ signer, reason } = await signerOf(plaintext, app, { ownerships, verify }));
    } catch (error) {
      signer = null;
    }
    if (signer) {
      // eslint-disable-next-line no-await-in-loop
      await resolve(identity, row.hash, signer);
      resolved += 1;
      fluxEventBus.publish('content:manifestPromoted', { appName: app.name, identity, version: row.version });
    } else {
      // eslint-disable-next-line no-await-in-loop
      await drop(identity, row.hash);
      fluxEventBus.publish('content:manifestDropped', { appName: app.name, reason });
    }
  }
  return resolved;
}

/** The IPs of nodes currently running an app, for peers-first content resolution. */
async function listAppPeers(appName) {
  const locations = await appsRepository.appLocationFromEvents({ appname: appName });
  const peers = (locations || []).map((l) => l.ip).filter(Boolean);
  // Shuffled, so nodes asking at once do not all ask the same peer first.
  for (let i = peers.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [peers[i], peers[j]] = [peers[j], peers[i]];
  }
  return peers;
}

/**
 * Every manifest one peer holds for an app, as it travels, or an empty list on
 * any error. The caller judges each one, so an unreachable or lying peer can only
 * fail to contribute, never poison.
 *
 * @param {string} peer - peer host:port
 * @param {string} appName
 * @param {object} [deps] - { http }
 * @returns {Promise<object[]>}
 */
async function fetchManifestsFromPeer(peer, appName, deps = {}) {
  const http = deps.http || axios;
  try {
    const res = await http.get(`http://${peer}/apps/contentmanifests/${encodeURIComponent(appName)}`, { timeout: 10_000 });
    const body = res && res.data;
    const manifests = body && body.status === 'success' && body.data && body.data.manifests;
    return Array.isArray(manifests) ? manifests : [];
  } catch (error) {
    return [];
  }
}

const MANIFEST_ASK_PEERS = 3;

/**
 * Asks nodes running the app for every manifest they hold, and FluxDrive for
 * every version it keeps, and keeps each one this node can judge — so a node
 * that lacks the manifest a new row names takes it, and a fresh node takes what
 * the network holds. Best-effort: a peer that fails contributes nothing.
 *
 * @param {string} appName
 * @param {string} identity
 * @param {object} [deps] - { getPeers?, fetchPeer?, fetchFromDrive?, take?, maxPeers?, verify?, provider? }
 * @returns {Promise<number>} manifests newly stored
 */
async function refreshManifests(appName, identity, deps = {}) {
  const {
    getPeers = listAppPeers,
    fetchPeer = fetchManifestsFromPeer,
    fetchFromDrive = fluxDriveClient.fetchManifest,
    take = takeManifest,
    maxPeers = MANIFEST_ASK_PEERS,
  } = deps;
  let stored = 0;
  const judge = async (gossip) => {
    if (!gossip || gossip.identity !== identity) return;
    const taken = await take(gossip, {}, deps);
    if (taken.outcome === 'stored') stored += 1;
  };
  try {
    const peers = await getPeers(appName);
    for (const peer of (peers || []).slice(0, maxPeers)) {
      // eslint-disable-next-line no-await-in-loop
      for (const gossip of await fetchPeer(peer, appName, deps)) {
        // eslint-disable-next-line no-await-in-loop
        await judge(gossip);
      }
    }
    const fromDrive = await fetchFromDrive(appName).catch(() => null);
    for (const kept of (fromDrive && Array.isArray(fromDrive.versions)) ? fromDrive.versions : []) {
      // eslint-disable-next-line no-await-in-loop
      await judge(kept.manifest);
    }
  } catch (error) {
    log.warn(`contentSlot: asking for ${appName}'s manifests failed - ${error.message ?? error}`);
  }
  return stored;
}

/**
 * Reaps the manifests of an identity another registration of its name has
 * displaced. A name's manifests belong to the app its latest applied
 * registration made; an earlier app of the name cannot come back once another
 * holds it, so its rows are dead. They are reaped only once the displacing
 * registration is deeper than the longest reorganisation the chain accepts, so
 * a registration a reorg takes back finds them still here. An identity whose
 * name has no applied registration is kept: a history being rebuilt is empty,
 * not evidence. Rows held unresolved are the TTL index's.
 *
 * @param {object} [deps] - { listHeld?, latestRegistration?, scannedHeight?, remove? }
 * @returns {Promise<{reaped: number, orphans: string[]}>}
 */
async function reapDisplacedManifests(deps = {}) {
  const {
    listHeld = () => appRecords.manifests().resolvedIdentities(),
    latestRegistration = (name) => appHistory.latestApplied(name, { type: 'registration' }),
    scannedHeight = chainState.getScannedHeight,
    remove = (id) => appRecords.manifests().removeAll(id),
  } = deps;
  const held = await listHeld();
  if (!held.length) return { reaped: 0, orphans: [] };
  const tip = await scannedHeight();
  const orphans = [];
  for (const { identity, appName } of held) {
    // eslint-disable-next-line no-await-in-loop
    const registration = await latestRegistration(appName);
    if (!registration || registration.decision.identity === identity) continue;
    if (tip - registration.decision.height < temporaryPoolSweep.MAX_REORG_LENGTH) continue;
    orphans.push(identity);
  }
  let reaped = 0;
  for (const identity of orphans) {
    // eslint-disable-next-line no-await-in-loop
    reaped += await remove(identity);
  }
  if (reaped) fluxEventBus.publish('content:manifestReaped', { count: reaped, identities: orphans });
  return { reaped, orphans };
}

/**
 * The row of an app was written: what this node stands on follows from what it
 * holds and the new row. Rows held before the app was listed are judged now;
 * when the spec changed, peers and FluxDrive are asked for the manifests they
 * hold, so a node that lacks the one the new spec names takes it. A node that
 * runs the app at the listed spec brings a running instance whose content is
 * not the standing manifest's to it. A node that runs it at an earlier spec
 * touches nothing running: it brings the files the listed spec declares into
 * its store, and they reach its containers when it adopts the update.
 *
 * @param {object} instance - the RegisteredSpec the row stands on
 * @param {object} [opts] - { specChanged?: boolean }
 * @param {object} [deps] - { resolveHeld?, refresh?, applyBehind?, standing?, prefetch? }
 */
async function rejudgeManifests(instance, opts = {}, deps = {}) {
  const {
    resolveHeld = resolveHeldManifests, refresh = refreshManifests, applyBehind = applyStoredIfBehind, standing = standingManifest,
    prefetch = prefetchListedContent,
  } = deps;
  const { identity, name: appName } = instance;
  await resolveHeld(identity, deps);
  if (opts.specChanged) await refresh(appName, identity, deps);
  const { row } = await standing(identity, deps);
  fluxEventBus.publish('content:manifestsRejudged', { appName, identity, standing: row ? row.version : null });
  await prefetch(instance, deps);
  await applyBehind(appName, deps);
}

/**
 * Receive a gossiped content manifest: take it (takeManifest judges and keeps
 * it), rebroadcast one newly stored for propagation, and, if this node runs the
 * app, hand it to the rollout scheduler, which applies it only if it is the one
 * the app stands on. A manifest held for an app not yet listed, a duplicate and
 * a dropped one travel no further.
 *
 * The relaying node's envelope signature is verified by the gossip layer before
 * this runs. Expected outcomes drop quietly (a forged signature logs at warn);
 * this throws only on an unexpected infrastructure failure, which the
 * fire-and-forget boundary surfaces at error level.
 *
 * @param {object} msgObj - received gossip message: { data: { type, appName, manifest } }
 * @param {object} deps - { isInstalledHere?, rebroadcast?, schedule?, take?, verify?, provider? }
 */
async function receiveManifest(msgObj, deps = {}) {
  const {
    isInstalledHere = (name) => appRecords.hostedInstances().byName(name),
    rebroadcast = fluxCommunicationMessagesSender.broadcastMessageToAll,
    schedule = scheduleContentApplication,
    take = takeManifest,
  } = deps;

  const gossipManifest = msgObj && msgObj.data && msgObj.data.manifest;
  if (!gossipManifest || !gossipManifest.appName) return;
  const { appName } = gossipManifest;

  const taken = await take(gossipManifest, { broadcast: msgObj }, deps);
  if (taken.outcome !== 'stored') return;
  fluxEventBus.publish('content:manifestReceived', { appName, version: taken.plaintext.version });

  await rebroadcast(msgObj.data);

  const installed = await isInstalledHere(appName);
  if (installed && schedule) await schedule(taken.plaintext, taken.app.spec, deps);
}

/**
 * Fire-and-forget gossip entry point. The dispatcher schedules this with no
 * `.catch`, so it must never reject: it runs receiveManifest and turns an
 * unexpected infrastructure failure into a single error-level log — distinct from
 * the expected, already-handled drops.
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
 * `broadcast` was node-envelope-verified upstream (batchVerifyBroadcasts); each is
 * taken as a gossiped one is, minus the rebroadcast and the apply. Returns
 * { stored } — the count newly stored or held.
 *
 * @param {Array<object>} broadcasts - signed node broadcasts { version, timestamp, pubKey, signature, data: { manifest } }
 * @param {object} deps - { take?, verify?, provider? }
 * @returns {Promise<{stored: number}>}
 */
async function storeBatchContentManifests(broadcasts, deps = {}) {
  const { take = takeManifest } = deps;
  let stored = 0;
  for (const broadcast of broadcasts || []) {
    const manifest = broadcast && broadcast.data && broadcast.data.manifest;
    if (!manifest || !manifest.appName) continue;
    // eslint-disable-next-line no-await-in-loop
    const taken = await take(manifest, { broadcast }, deps);
    if (taken.outcome === 'stored' || taken.outcome === 'held') stored += 1;
  }
  return { stored };
}

/**
 * Keeps the manifest an applied spec update carries, judged for the row the
 * update wrote: its signer is an owner of the app's history, and whether it
 * stands follows from the new row — the owner it names, or the manifest its
 * `content` block names. Runs when the row is written, before anything that
 * recreates a component for the new spec, so the slot it adds is filled first.
 *
 * @param {object} instance - the RegisteredSpec the row stands on
 * @param {object} gossipManifest - the manifest as carried: slots sealed for an encrypted app
 * @param {object} [deps] - { take?, verify?, provider? }
 * @returns {Promise<boolean>} kept
 */
async function storeCarriedManifest(instance, gossipManifest, deps = {}) {
  const { take = takeManifest } = deps;
  const { name: appName, identity } = instance;
  const taken = await take(gossipManifest, {}, deps);
  if (taken.outcome === 'dropped') {
    log.warn(`contentSlot: the manifest ${appName}'s applied update carries is not the app's - ${taken.reason}`);
    fluxEventBus.publish('content:manifestDropped', { appName, reason: 'carried_invalid' });
    return false;
  }
  fluxEventBus.publish('content:manifestApplied', { appName, identity, version: gossipManifest.version });
  return true;
}

/**
 * GET /apps/contentmanifest/:appname — the manifest the app the registry lists
 * under the name stands on, as it travels (slots sealed for an encrypted app).
 * 404 when none stands.
 */
async function getContentManifestApi(req, res) {
  try {
    const appname = req.params.appname || req.params.appName;
    if (!appname) {
      res.json(messageHelper.createErrorMessage('appname is required'));
      return;
    }
    const app = await appRecords.registry().byName(appname);
    const { row } = app ? await standingManifest(app.identity) : { row: null };
    if (!row) {
      res.status(404).json(messageHelper.createErrorMessage(`No content manifest for ${appname}`));
      return;
    }
    res.json(messageHelper.createDataMessage(row.manifest));
  } catch (error) {
    log.error(error);
    res.json(messageHelper.createErrorMessage(error.message || error, error.name, error.code));
  }
}

/**
 * GET /apps/contentmanifests/:appname — what this node holds for the app the
 * registry lists under the name, or, when it lists none, the app that last
 * held it: every resolved manifest, the one it stands on (none for an app not
 * listed), the ownership and the version the owner's next manifest takes. A
 * node asked at its row write keeps what it lacks and judges it against its
 * own row; an owner reads the ownership height and the version to sign, the
 * owner of an expired app included.
 */
async function getContentManifestsApi(req, res) {
  try {
    const appname = req.params.appname || req.params.appName;
    if (!appname) {
      res.json(messageHelper.createErrorMessage('appname is required'));
      return;
    }
    const app = (await appRecords.registry().byName(appname)) ?? (await appSpecHistory.latestAppliedState(appname));
    if (!app) {
      res.status(404).json(messageHelper.createErrorMessage(`No app ${appname} is listed or was applied`));
      return;
    }
    const listed = listedOwnership(await appHistory.ownerships(app.name));
    const { row, rows } = await standingManifest(app.identity);
    const nextVersion = listed
      ? (await highestVersionInOwnership(app.identity, listed)) + 1
      : 1;
    res.json(messageHelper.createDataMessage({
      appName: app.name,
      identity: app.identity,
      ownership: listed,
      standing: row ? { hash: row.hash, version: row.version, ownedFrom: row.ownedFrom } : null,
      nextVersion,
      manifests: rows.filter((held) => held.isResolved).map((held) => held.manifest),
    }));
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
 * Writes one slot's bytes onto its mount source by its delivery mechanism:
 * atomic:true temp+rename inside the managed dir, atomic:false in-place
 * overwrite of the single-file bind.
 *
 * @param {object} mount - a contentSlotMounts() entry
 * @param {Buffer} bytes
 * @param {object} deps - { writeFile?, rename?, applyPerms? }
 */
async function writeSlot(mount, bytes, deps = {}) {
  const { writeFile = fs.writeFile, rename = fs.rename, applyPerms = defaultInjectedPerms } = deps;
  if (mount.atomic) {
    const tmp = `${mount.source}.flux-content-tmp`;
    await writeFile(tmp, bytes);
    await applyPerms(tmp, mount);
    await rename(tmp, mount.source); // atomic swap within the managed dir
  } else {
    await writeFile(mount.source, bytes); // in-place overwrite of the single-file bind
    await applyPerms(mount.source, mount);
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
 * @param {object} deployment - DeploymentSpec for the app, whose identity keys every blob
 * @param {object} manifest - plaintext manifest (slot -> { hash })
 * @param {object} ctx - { appName, peers }
 * @param {object} deps - with `takes`, which components' slots are written: every one by default
 * @returns {Promise<Array<{comp: object, mount: object, bytes: Buffer}>>}
 */
async function stageAndApplySlots(deployment, manifest, ctx, deps = {}) {
  const { appName, peers = [] } = ctx;
  const {
    resolve = contentBlobService.resolveBlob,
    benchmark, fluxDrive, peerFetch = contentBlobService.fetchBlobFromPeer,
    writeFile, rename, applyPerms,
    takes = () => true,
  } = deps;

  // 1. Stage every slot — resolve + verify to a buffer before touching disk.
  const staged = [];
  for (const [, comp] of deployment.componentEntries()) {
    if (!takes(comp)) continue;
    for (const mount of comp.contentSlotMounts()) {
      const entry = manifest.slots[mount.slot];
      if (!entry || !entry.hash) throw new Error(`contentSlot: manifest has no hash for declared slot "${mount.slot}"`);
      // eslint-disable-next-line no-await-in-loop
      const bytes = await resolve(
        {
          appName, identity: deployment.identity, contentHash: entry.hash, peers,
        },
        { benchmark, fluxDrive, peerFetch },
      );
      staged.push({ comp, mount, bytes });
    }
  }

  // 2. Write each staged slot by its delivery mechanism.
  for (const { mount, bytes } of staged) {
    // eslint-disable-next-line no-await-in-loop
    await writeSlot(mount, bytes, { writeFile, rename, applyPerms });
  }

  return staged;
}

/**
 * Fires one reaction per component for slot content just written under its
 * running container: restart subsumes signal subsumes none. A reaction that
 * fails rolls nothing back.
 *
 * @param {Array<{comp: object, mount: object}>} staged - the slots written, of running components
 * @param {object} manifest - the manifest they were written from
 * @param {object} ctx - { appName }
 * @param {object} deps - { signal?, restart? }
 */
async function reactToWritten(staged, manifest, ctx, deps = {}) {
  const { signal = dockerService.appDockerSignal, restart = dockerService.appDockerRestart } = deps;
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
}

// Per-app latch, by the installed app's identity: the highest manifest version
// this process has applied. A version
// is applied at most once per node — the submitter's own POST apply and a peer's
// rebroadcast echo of that same manifest otherwise BOTH apply it (broadcast is
// deliberately before the local store, so the echo can win the dedup race), firing
// the component reaction twice. In-memory is enough: boot recovery re-provisions
// content idempotently before the container starts. Keyed by the manifest's
// hash, never its version: after a transfer the manifest to apply may rank below
// the one applied last, and it is still the one the app stands on.
const lastAppliedHash = new Map();

/**
 * Apply a manifest's content to this node's installed, RUNNING app: stage + write
 * every declared slot (stageAndApplySlots), then fire ONE reaction per affected
 * component — restart subsumes signal subsumes null. A reaction failure never rolls
 * back the write (the new content is on disk and read on the next start regardless).
 * Applies each manifest at most once per node (see lastAppliedHash). The caller
 * has judged that the manifest is the one the app stands on.
 *
 * @param {object} deployment - DeploymentSpec for the installed app
 * @param {object} manifest - plaintext manifest (slot -> { hash })
 * @param {object} ctx - { appName, peers }
 * @param {object} deps
 */
async function applyManifest(deployment, manifest, ctx, deps = {}) {
  const { recordApplied = (id, h) => appRecords.manifests().markApplied(id, h) } = deps;
  const { contentManifestHash } = await getSpec();
  const hash = contentManifestHash(manifest);

  // Claim the manifest up front so a concurrent duplicate skips; roll back on a
  // failed apply so it stays retryable.
  const { identity } = deployment;
  const prevApplied = lastAppliedHash.get(identity);
  if (prevApplied === hash) {
    fluxEventBus.publish('content:slotApplySkipped', { appName: ctx.appName, version: manifest.version, reason: 'already_applied' });
    return;
  }
  lastAppliedHash.set(identity, hash);

  let staged;
  try {
    staged = await stageAndApplySlots(deployment, manifest, ctx, deps);
  } catch (error) {
    if (lastAppliedHash.get(identity) === hash) {
      if (prevApplied != null) lastAppliedHash.set(identity, prevApplied);
      else lastAppliedHash.delete(identity);
    }
    throw error;
  }

  await reactToWritten(staged, manifest, ctx, deps);

  // Durably record what this node delivered to the running container, AFTER the write +
  // reaction — so a crash mid-apply leaves the mark where it was and the next check
  // retries once, never a loop. Best-effort: the content is already live regardless.
  try {
    await recordApplied(identity, hash);
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
    await (deps.store ?? contentStore).retainOnly(identity, keep);
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
    getLocations = (appName2) => appsRepository.appLocationFromEvents({ appname: appName2 }),
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
    standing = standingManifest,
    componentsRunning = contentComponentsRunning,
    now = Date.now,
    setTimer = setTimeout,
    computeDelay = computeStaggerDelayMs,
    ...applyDeps
  } = deps;
  const { appName } = manifest;
  const rollout = manifest.rollout || { strategy: 'immediate' };

  // Apply now, re-checking the app is still installed here (discard if it expired mid-window),
  // that this manifest is still the one the app stands on (a newer one, or a row write that
  // stopped validating this one, supersedes a timer armed for it), that this node runs the
  // app at the spec the registry lists (the adoption of an update delivers the content of
  // one it has yet to adopt), and that it is actually up.
  // A hosted instance says only that this node owns the app — during an install it exists
  // while the component's volume is still being made, so writing the slot then lands on a
  // path that isn't mounted yet. Whatever we skip here is delivered by the two paths that own
  // content for a not-running app: the installer stages it once the volume exists and before
  // the container starts, and the steady-state catch-up sweep (applyBehindContentApps)
  // re-applies anything the standing manifest is ahead of.
  const { contentManifestHash } = await getSpec();
  const hash = contentManifestHash(manifest);
  const runApply = async () => {
    const deployment = await getDeployment(appName);
    if (!deployment) return;
    const { app, row } = await standing(deployment.identity, deps);
    if (!row || row.hash !== hash) {
      fluxEventBus.publish('content:slotApplySkipped', { appName, version: manifest.version, reason: 'not_standing' });
      return;
    }
    if (!(await runsListedSpec(appName, app, deps))) {
      fluxEventBus.publish('content:slotApplySkipped', { appName, version: manifest.version, reason: 'spec_not_adopted' });
      return;
    }
    if (!(await componentsRunning(deployment, applyDeps))) return;
    const peers = await getPeers(appName);
    await apply(deployment, manifest, { appName, peers }, applyDeps);
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

/**
 * Whether a component's container is running. One that is absent is not.
 * @param {object} comp - DeploymentComponent
 * @param {object} deps - { inspect? }
 * @returns {Promise<boolean>}
 */
async function componentRunning(comp, deps = {}) {
  const { inspect = dockerService.dockerContainerInspect } = deps;
  try {
    const info = await inspect(comp.identifier);
    return Boolean(info && info.State && info.State.Running);
  } catch (error) {
    return false;
  }
}

/** True only when every content-bearing component of the deployment has a running
 *  container. A stopped or absent one means the app isn't up, so applying content would
 *  fire a reaction that wrongly (re)starts it — leave that to the start path, which stages
 *  the current content before the container comes up. */
async function contentComponentsRunning(deployment, deps = {}) {
  for (const [, comp] of deployment.componentEntries()) {
    if (!comp.hasContentSlots()) continue;
    // eslint-disable-next-line no-await-in-loop
    if (!(await componentRunning(comp, deps))) return false;
  }
  return true;
}

/**
 * Whether this node runs an app at the spec the registry lists. Between the row
 * write of an update and this node's adoption of it, the node's containers are
 * those of the earlier spec while the manifest the app stands on is the listed
 * spec's: a slot the update adds has no mount in them.
 *
 * @param {string} appName
 * @param {object} app - the registry row the app stands on
 * @param {object} deps - { installedHash? }
 * @returns {Promise<boolean>}
 */
async function runsListedSpec(appName, app, deps = {}) {
  const { installedHash = async (name) => (await appRecords.hostedInstances().byName(name))?.hash ?? null } = deps;
  return (await installedHash(appName)) === app.hash;
}

/**
 * Bring a RUNNING container's slot content to the manifest the app stands on when
 * that is not the one this node last delivered — a manifest learned by a path
 * other than gossip (boot sync of one published during downtime, a peer's answer
 * at a row write, the steady-state refresh), or a row write that moved what the
 * app stands on. Live gossip apply is fire-once, so such a change would otherwise
 * sit in the store unapplied and the container would serve other content until
 * it restarts. The decision is the standing row against the row marked applied,
 * never the mutable on-disk bytes a container may have changed. No-op unless the
 * app is installed here with content slots at the spec the registry lists, its
 * container is running, and the standing manifest is not the applied one. Honors the manifest rollout
 * (scheduleContentApplication → applyManifest, which marks the row applied).
 *
 * @param {string} appName
 * @param {object} deps
 * @returns {Promise<boolean>} whether an apply was scheduled
 */
async function applyStoredIfBehind(appName, deps = {}) {
  const {
    standing = standingManifest,
    getDeployment = deploymentProvider.getInstalledDeployment,
    componentsRunning = contentComponentsRunning,
    schedule = scheduleContentApplication,
    provider,
  } = deps;

  const deployment = await getDeployment(appName);
  if (!deployment || !deployment.componentEntries().some(([, comp]) => comp.hasContentSlots())) return false;

  // The app is read by the installed identity: an install the registry lists under
  // another registration of the name has no row and gets nothing.
  const { app, row } = await standing(deployment.identity, deps);
  if (!app || !row) return false;
  if (row.applied) return false; // already delivered
  if (!(await runsListedSpec(appName, app, deps))) return false; // the adoption of the listed spec delivers it
  if (!(await componentsRunning(deployment, deps))) return false; // stopped — the start path provisions it

  const plaintext = await openManifestSlots(row.manifest, { encrypted: app.isEncrypted }, { provider });
  await schedule(plaintext, app.spec, deps);
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
  const { listInstalled = () => appRecords.hostedInstances().apps().then((records) => records.map((record) => record.record)), applyBehind = applyStoredIfBehind } = deps;
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
    standing = standingManifest,
    getPeers = listAppPeers,
    provision = provisionContentSlots,
    ensureMounted = volumeService.ensureAppVolumeMounted,
    schedule = scheduleContentApplication,
    now = Date.now,
    restarting = true,
    provider,
  } = deps;

  const deployment = await getDeployment(appName);
  if (!deployment || !deployment.componentEntries().some(([, comp]) => comp.hasContentSlots())) return;

  // The don't-apply-early decision is on the CLEARTEXT rollout of the manifest the
  // app stands on; a row held for an app not yet listed stands on nothing.
  const { app, row } = await standing(deployment.identity, deps);
  const manifest = row ? row.manifest : null;
  const rollout = manifest && manifest.rollout;
  const deferred = rollout
    && (rollout.strategy === 'scheduled' || rollout.strategy === 'staggered')
    && Number(rollout.activateAt) > now(); // activateAt is epoch ms

  if (deferred) {
    // A future-dated rollout: never apply it early — the on-disk content (live before the
    // restart) stays. Re-arm it to land at activateAt (its in-memory timer died with the
    // process). Re-arm runs whether the container was stopped (machine reboot) or
    // survived (FluxOS process restart).
    const plaintext = await openManifestSlots(manifest, { encrypted: app.isEncrypted }, { provider });
    await schedule(plaintext, app.spec, deps);
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
  // This runs before the boot mounts sweep, and slot writes only land through
  // a MOUNTED volume — the immutable mountpoint underneath (the unmounted-write
  // guard) EPERMs everything else. Idempotent: an already-mounted volume is a
  // no-op. A volume that cannot mount is a loud refusal, not an empty-slot
  // provision — the caller's best-effort catch logs it and the app starts on
  // its persisted on-disk content.
  for (const [, comp] of deployment.componentEntries()) {
    if (!comp.hasContentSlots()) continue;
    // eslint-disable-next-line no-await-in-loop
    const mount = await ensureMounted(comp.identifier);
    if (!mount || mount.mounted !== true) {
      throw new Error(`contentSlot: ${comp.identifier} volume not mountable before boot provision (${mount && mount.reason ? mount.reason : 'unknown'})`);
    }
  }
  const peers = await getPeers(appName);
  await provision(deployment, { appName, peers }, deps);
  fluxEventBus.publish('content:bootReconcile', { appName, version: manifest && manifest.version });
}

/** The slot names a set of components declare. */
const declaredSlots = (components) => components.flatMap((comp) => comp.contentSlotMounts().map((mount) => mount.slot));

/**
 * The manifest an app stands on, covering every slot named: one short of a
 * named slot counts as none. With nothing standing, or one short, the nodes
 * running the app and FluxDrive are asked and it is judged again. Throws when
 * there is still none, so a caller about to create or replace a container
 * holds instead of starting one on empty or stale slots.
 *
 * @param {object} content - { identity: the app's, slots: the slot names to cover }
 * @param {object} ctx - { appName, peers? }
 * @param {object} deps - { getApp?, standing?, getPeers?, refresh?, provider? }
 * @returns {Promise<{row: object, plaintext: object, peers: string[]}>}
 */
async function coveringManifest(content, ctx, deps = {}) {
  const {
    getApp = (name) => appRecords.registry().byName(name),
    standing = standingManifest,
    getPeers = listAppPeers,
    refresh = refreshManifests,
    provider,
  } = deps;
  const { appName } = ctx;

  const info = await getApp(appName);
  if (!info) throw new Error(`contentSlot: cannot provision ${appName} - app info not found`);
  if (info.identity !== content.identity) {
    throw new Error(`contentSlot: cannot provision ${appName} - the registry lists another registration of the name`);
  }
  const { isEncrypted: encrypted, identity } = info;

  const peers = ctx.peers || (await getPeers(appName));

  const covers = (plaintext) => content.slots.every((slot) => plaintext.slots && plaintext.slots[slot] && plaintext.slots[slot].hash);
  const standingPlaintext = async () => {
    const { row } = await standing(identity, deps);
    if (!row) return null;
    const plaintext = await openManifestSlots(row.manifest, { encrypted }, { provider });
    return covers(plaintext) ? { row, plaintext } : null;
  };
  let current = await standingPlaintext();
  if (!current) {
    await refresh(appName, identity, { ...deps, peers });
    current = await standingPlaintext();
  }
  if (!current) {
    throw new Error(`contentSlot: no manifest covering every declared slot is available for ${appName} - holding until content is present`);
  }
  return { ...current, peers };
}

/**
 * Brings every content file a deployment declares into this node's store,
 * hash-verified, and writes nothing to any mount: the blobs its spec names and
 * the slots of the manifest the app stands on, each from the store, else a node
 * running the app, else FluxDrive. Throws when one cannot be had, so a caller
 * about to replace a running container leaves it running.
 *
 * @param {object} deployment - DeploymentSpec, whose identity keys every blob
 * @param {object} ctx - { appName, peers? }
 * @param {object} deps - coveringManifest's, plus { resolve?, benchmark?, fluxDrive?, peerFetch? }
 * @returns {Promise<number>} how many files the deployment declares
 */
async function stageContent(deployment, ctx, deps = {}) {
  const {
    resolve = contentBlobService.resolveBlob, getPeers = listAppPeers,
    benchmark, fluxDrive, peerFetch = contentBlobService.fetchBlobFromPeer,
  } = deps;
  const { appName } = ctx;
  const comps = deployment.componentEntries().map(([, comp]) => comp);
  const hashes = new Set(comps.flatMap((comp) => comp.contentBlobMounts().map((mount) => mount.hash)));
  const declaresSlots = comps.some((comp) => comp.hasContentSlots());
  if (hashes.size === 0 && !declaresSlots) return 0;

  const peers = ctx.peers || (await getPeers(appName));
  if (declaresSlots) {
    const { plaintext } = await coveringManifest({ identity: deployment.identity, slots: declaredSlots(comps) }, { appName, peers }, deps);
    for (const comp of comps) {
      for (const mount of comp.contentSlotMounts()) hashes.add(plaintext.slots[mount.slot].hash);
    }
  }
  for (const contentHash of hashes) {
    // eslint-disable-next-line no-await-in-loop
    await resolve(
      {
        appName, identity: deployment.identity, contentHash, peers,
      },
      { benchmark, fluxDrive, peerFetch },
    );
  }
  fluxEventBus.publish('content:staged', { appName, files: hashes.size });
  return hashes.size;
}

/**
 * The row of an app this node runs at an earlier spec was written: the files
 * the listed spec declares are brought into this node's store, so that its
 * adoption of the update finds them there. Nothing running is touched.
 * Best-effort: the adoption stages the same files itself and holds while one is
 * missing.
 *
 * @param {object} instance - the RegisteredSpec the row stands on
 * @param {object} deps - { getInstalled?, namingForUpdate?, planDeployments?, registrationVersionOf?, stage? }
 * @returns {Promise<boolean>} whether the listed spec's content is in the store
 */
async function prefetchListedContent(instance, deps = {}) {
  const {
    getInstalled = (name) => appRecords.hostedInstances().byName(name),
    namingForUpdate = componentKeyMap.namingForUpdate,
    planDeployments = deploymentProvider.planDeployments,
    registrationVersionOf = appHistory.registrationVersionOf,
    stage = stageContent,
  } = deps;
  const { name: appName } = instance;
  const installed = await getInstalled(appName);
  if (!installed || installed.hash === instance.hash) return false;
  const identity = installed.identity ?? null;
  const { uuid } = installed;
  try {
    // The listed spec's view of each identity this node runs, named as the
    // adoption names it: by the identity the app was installed with, and the
    // component keys the update carries from the hosted instance.
    const deployments = await planDeployments(instance, {
      identity,
      registrationVersion: await registrationVersionOf(appName, uuid) ?? undefined,
      componentKeys: (await namingForUpdate(installed, instance)).componentKeys,
    });
    // eslint-disable-next-line no-restricted-syntax
    for (const deployment of deployments) {
      // eslint-disable-next-line no-await-in-loop
      await stage(deployment, { appName }, deps);
    }
    return true;
  } catch (error) {
    log.warn(`contentSlot: the content ${appName}'s update declares is not in the store yet - ${error.message ?? error}`);
    return false;
  }
}

/**
 * Write a slot app's content onto its mount sources: the manifest the app
 * stands on (coveringManifest), every declared slot staged and written. It
 * THROWS when no covering manifest is reachable, so an install or an adoption
 * holds and retries rather than starting a container on empty or stale slots
 * (an app is not installable without its content). A no-op for an app that
 * declares no slots.
 *
 * A component this pass created (ctx.created, by name) took its content at its
 * create step and is not written again. Any other component whose container is
 * not running takes the content with no reaction: it reads it when it starts.
 * A component whose container is running takes it only when the manifest is
 * not the one this node last delivered, and then gets the reaction its slots
 * declare: the component an update leaves as it is, under a manifest the
 * update changed.
 *
 * Publishes content:slotsProvisioned once every slot is staged (hash-verified)
 * and written — the slot-path counterpart of the blob path's
 * content:blobProvisioned.
 *
 * @param {object} deployment - DeploymentSpec for the app
 * @param {object} ctx - { appName, peers?, created? }
 * @param {object} deps
 */
async function provisionContentSlots(deployment, ctx, deps = {}) {
  // An app with no slots touches neither the DB nor the network — check first.
  const comps = deployment.componentEntries().map(([, comp]) => comp);
  const declaresSlots = comps.some((comp) => comp.hasContentSlots());
  if (!declaresSlots) return;

  const {
    stageApply = stageAndApplySlots,
    recordApplied = (id, h) => appRecords.manifests().markApplied(id, h),
    ...resolveDeps
  } = deps;
  const { appName, created = [] } = ctx;

  const { row, plaintext, peers } = await coveringManifest({ identity: deployment.identity, slots: declaredSlots(comps) }, ctx, deps);

  const running = new Set();
  // eslint-disable-next-line no-restricted-syntax
  for (const comp of comps) {
    // eslint-disable-next-line no-await-in-loop
    if (comp.hasContentSlots() && await componentRunning(comp, resolveDeps)) running.add(comp);
  }
  const fresh = new Set(created);
  const delivered = row.applied === true;
  const takes = (comp) => !fresh.has(comp.name) && !(delivered && running.has(comp));

  const staged = (await stageApply(deployment, plaintext, { appName, peers }, { ...resolveDeps, takes })) ?? [];
  await reactToWritten(staged.filter(({ comp }) => running.has(comp)), plaintext, { appName }, resolveDeps);
  // Mark the manifest just written as the one delivered, so the steady-state "am I
  // behind?" check (applyStoredIfBehind) does not apply this same content again to
  // the containers once they run. Best-effort, like applyManifest's own mark: a
  // miss only costs one spurious reaction, never lost content.
  try {
    await recordApplied(deployment.identity, row.hash);
  } catch (error) {
    log.warn(`contentSlot: failed to record provisioned version ${plaintext.version} for ${appName} - ${error.message ?? error}`);
  }
  fluxEventBus.publish('content:slotsProvisioned', { appName, version: plaintext.version });
}

// Injected content is written root-owned 0644, the platform default for declared
// content (mirrors DeploymentSpec resolveMountPerms). Mode bits are ownership
// hygiene, not enforcement: a root container writes through any mode, and real
// read-only intent is the mount's readOnly bind flag.
async function writeInjectedContent(source, bytes, deps = {}) {
  const { writeFile = fs.writeFile, chmod = fs.chmod } = deps;
  await writeFile(source, bytes);
  await chmod(source, 0o644);
}

/**
 * Every file one component's container reads at its first start, resolved
 * into memory and hash-verified: the blobs its spec names and its slots from
 * the manifest the app stands on, each from this node's store, else a node
 * running the app, else FluxDrive. Throws when one cannot be had.
 *
 * @param {object} component - DeploymentComponent, whose identity is the app's
 * @param {object} ctx - { appName, peers? }
 * @param {object} deps - coveringManifest's, plus { resolve?, benchmark?, fluxDrive?, peerFetch? }
 * @returns {Promise<Array<{ kind: 'blob'|'slot', mount: object, hash: string, bytes: Buffer }>>}
 */
async function resolveComponentContent(component, ctx, deps = {}) {
  const {
    resolve = contentBlobService.resolveBlob, getPeers = listAppPeers,
    benchmark, fluxDrive, peerFetch = contentBlobService.fetchBlobFromPeer,
  } = deps;
  const { appName } = ctx;
  const blobs = component.contentBlobMounts();
  const slots = component.contentSlotMounts();
  if (blobs.length === 0 && slots.length === 0) return [];

  const peers = ctx.peers || (await getPeers(appName));
  const files = blobs.map((mount) => ({ kind: 'blob', mount, hash: mount.hash }));
  if (slots.length > 0) {
    const { plaintext } = await coveringManifest(
      { identity: component.identity, slots: slots.map((mount) => mount.slot) },
      { appName, peers },
      deps,
    );
    for (const mount of slots) files.push({ kind: 'slot', mount, hash: plaintext.slots[mount.slot].hash });
  }
  for (const file of files) {
    try {
      // eslint-disable-next-line no-await-in-loop
      file.bytes = await resolve(
        {
          appName, identity: component.identity, contentHash: file.hash, peers,
        },
        { benchmark, fluxDrive, peerFetch },
      );
    } catch (error) {
      fluxEventBus.publish('content:blobProvisionFailed', { appName, hash: file.hash });
      throw error;
    }
  }
  return files;
}

/**
 * Brings every file one component's container reads at its first start into
 * this node's store, hash-verified, and writes nothing to any mount. Throws
 * when one cannot be had, so a caller about to replace the container leaves
 * it running.
 *
 * @param {object} component - DeploymentComponent
 * @param {object} ctx - { appName, peers? }
 * @param {object} deps - resolveComponentContent's
 * @returns {Promise<number>} how many files the component declares
 */
async function stageComponentContent(component, ctx, deps = {}) {
  const files = await resolveComponentContent(component, ctx, deps);
  fluxEventBus.publish('content:staged', { appName: ctx.appName, identifier: component.identifier, files: files.length });
  return files.length;
}

/**
 * Writes one component's content onto its mount sources before its container
 * is created: the blobs its spec names, then its slots from the manifest the
 * app stands on, every one resolved and hash-verified before the first write.
 * No reaction: the container does not exist. Throws when a file cannot be had,
 * with nothing written, so no container is created on an empty or stale source
 * and the caller retries. A no-op for a component that declares no content.
 *
 * @param {object} component - DeploymentComponent
 * @param {object} ctx - { appName, peers? }
 * @param {object} deps - resolveComponentContent's, plus { writeFile?, chmod?, rename?, applyPerms? }
 */
async function provisionComponentContent(component, ctx, deps = {}) {
  const {
    writeFile, chmod, rename, applyPerms,
  } = deps;
  const files = await resolveComponentContent(component, ctx, deps);
  if (files.length === 0) return;
  const { appName } = ctx;
  for (const {
    kind, mount, hash, bytes,
  } of files) {
    if (kind === 'blob') {
      // eslint-disable-next-line no-await-in-loop
      await writeInjectedContent(mount.source, bytes, { writeFile, chmod });
      fluxEventBus.publish('content:blobProvisioned', { appName, hash });
    } else {
      // eslint-disable-next-line no-await-in-loop
      await writeSlot(mount, bytes, { writeFile, rename, applyPerms });
    }
  }
  fluxEventBus.publish('content:componentProvisioned', { appName, identifier: component.identifier, files: files.length });
}

/**
 * The locators of the slot blobs a plaintext manifest keeps, derived over the
 * benchmark channel exactly as resolveBlob/serveBlob derive them. The manifest
 * carries every declared slot, so this is the full kept set, not a delta.
 *
 * @param {object} manifest - the plaintext manifest (slots = { name: { hash } })
 * @param {string} identity - the app's identity
 * @param {object} deps - { benchmark?, deriveLocator? }
 * @returns {Promise<string[]>}
 */
async function keptSlotLocators(manifest, identity, deps = {}) {
  const { benchmark, deriveLocator = contentBlobService.deriveLocator } = deps;
  const locators = [];
  for (const slot of Object.values(manifest.slots || {})) {
    if (!slot || !slot.hash) continue;
    // eslint-disable-next-line no-await-in-loop
    locators.push(await deriveLocator(benchmark, { identity, contentHash: slot.hash }));
  }
  return locators;
}

/**
 * Best-effort PUT of an owner-signed manifest to the FluxDrive backstop, with the
 * slot locators it keeps, so a cold-starting node with no running peer can still
 * provision the app (the first instance has no peers — FluxDrive is its source,
 * not a fallback), and so FluxDrive reclaims the slot blobs it supersedes: stored
 * as the identity's newest confirmed version, it marks the identity's other slot
 * blobs for deletion. The node takes the arcane sig over the benchmark channel,
 * which builds the signed text itself from the identity, the ownership, the
 * version, the timestamp, the kept list and the message hash the put names; the
 * OWNER PUT-sig is produced by the frontend at submission over the same text and
 * carried in the sealed content payload (the owner is offline at backup time). A
 * manifest that rides a spec message names that message's hash, and FluxDrive
 * holds it until the nodes answer that the message applied; a content update
 * with no spec change names none and is stored at once. A failed PUT is logged,
 * not fatal — gossip + boot-sync are the primary path and the next content update
 * re-establishes the backstop.
 *
 * @param {object} manifest - the plaintext manifest (slots = { name: { hash } }, ownedFrom)
 * @param {object} gossipManifest - the stored gossip-form manifest (sealed slots)
 * @param {object} ctx - { appName, identity, version, timestamp, manifestPutSig, pendingMessageHash? }
 * @param {object} deps - { sign?, put?, deriveLocator?, benchmark? }
 * @returns {Promise<boolean>} true if the PUT succeeded
 */
async function backstopManifest(manifest, gossipManifest, ctx, deps = {}) {
  const {
    appName, identity, version, timestamp, manifestPutSig, pendingMessageHash = null,
  } = ctx;
  const {
    sign = contentBlobService.signManifestPut, put = fluxDriveClient.putManifest, deriveLocator, benchmark,
  } = deps;
  // Every submission refuses a manifest without the owner's signature over its
  // put; a caller holding none has nothing FluxDrive would accept.
  if (!manifestPutSig) return false;
  try {
    const keptLocators = await keptSlotLocators(manifest, identity, { benchmark, deriveLocator });
    // FluxDrive refuses an empty kept list, which would mark every slot blob. A
    // slot app always declares a slot, so this only guards a malformed manifest.
    if (!keptLocators.length) return false;
    const arcaneSig = await sign({
      identity, ownedFrom: Number(manifest.ownedFrom), version, timestamp, keptLocators, pendingMessageHash,
    }, { benchmark });
    await put(appName, {
      version, timestamp, arcaneSig, ownerSig: manifestPutSig, manifest: gossipManifest, keptLocators, pendingMessageHash,
    });
    fluxEventBus.publish('content:manifestBackstopped', { appName, version, kept: keptLocators.length });
    return true;
  } catch (error) {
    log.warn(`contentSlot: manifest backstop PUT failed for ${appName} (gossip + peers remain primary) - ${error.message ?? error}`);
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
    getApp = (name) => appRecords.registry().byName(name),
    ownerships = appHistory.ownerships,
    waitingTransfer = messageStore.waitingTransfer,
    isInstalledHere = (name) => appRecords.hostedInstances().byName(name),
    openEnvelope = transportHelper.openContentEnvelope,
    processSubmission = processManifestSubmission,
    broadcast = fluxCommunicationMessagesSender.broadcastMessageToAll,
    take = takeManifest,
    uploader = fluxDriveClient,
    benchmark, now, verify, provider, schedule = scheduleContentApplication,
    backstop = backstopManifest,
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
  const {
    owner, isEncrypted: encrypted, spec, identity,
  } = info;

  // R4: while a transfer of the app waits for payment on this node, its
  // content is not changed; the transfer names the manifest it stands on.
  if (await waitingTransfer(appName, owner)) {
    throw new Error(`contentSlot: a transfer of the app waits for payment on this node; a content update for ${appName} is refused until it is paid or its payment window closes (R4)`);
  }

  // Transport-open the sealed payload (content never travels unencrypted). The
  // cleartext meta drove the AAD, so binding it to the recovered manifest below
  // means a tampered meta can't slip past — the AEAD already broke if it was.
  const plaintext = await openEnvelope(content, {
    appName, owner, ref: `manifest:v${ver}`, timestamp: ts,
  });
  const payload = JSON.parse(plaintext.toString('utf8'));
  const {
    manifest, blobs: blobsObj, manifestPutSig,
  } = payload || {};
  if (!manifest || !blobsObj) throw new Error('contentSlot: sealed content payload missing manifest or blobs');
  if (manifest.appName !== appName || manifest.version !== ver || manifest.timestamp !== ts) {
    throw new Error('contentSlot: content-update meta does not match the sealed manifest');
  }
  if (!manifestPutSig) throw new Error('contentSlot: a content update carries the owner\'s FluxDrive signature over its manifest (manifestPutSig)');

  const blobs = new Map(Object.entries(blobsObj).map(([h, b64]) => [h, Buffer.from(b64, 'base64')]));
  const ownerSigs = new Map(Object.entries(ownerSigsObj || {}));

  // The manifest is signed under the listed ownership: the height the chain says
  // the listed owner took the app.
  const listed = listedOwnership(await ownerships(appName));
  if (!listed || listed.owner !== owner) throw new Error(`contentSlot: ${appName} has no applied ownership for ${owner}`);

  const gossipManifest = await processSubmission(
    {
      manifest, spec, owner, encrypted, identity, ownedFrom: listed.from, original: listed.original, blobs, ownerSigs,
    },
    { uploader, benchmark, now, verify, provider },
  );

  // Broadcast first: broadcastMessageToAll returns the exact signed node broadcast it
  // relayed, so we keep that same envelope (one signature) for boot-sync re-serving.
  const signedBroadcast = await broadcast({ type: MANIFEST_GOSSIP_TYPE, appName, manifest: gossipManifest });
  await take(gossipManifest, { broadcast: signedBroadcast }, { verify, provider });
  fluxEventBus.publish('content:contentUpdateApplied', { appName, version: ver });

  // Populate the FluxDrive backstop so a cold-start node with no running peer can
  // still provision, with the slot locators the manifest keeps so FluxDrive
  // reclaims the ones it supersedes (best-effort; gossip + boot-sync are primary).
  // The owner PUT-sig rides the sealed payload (frontend-produced at submission);
  // the node mints its arcane sig.
  await backstop(manifest, gossipManifest, {
    appName, identity, version: ver, timestamp: ts, manifestPutSig,
  }, { benchmark });

  // The submitter applies locally if it runs the app — gossip doesn't loop back. Detached,
  // the way every peer applies it: by here the submission has done all it promised (stored,
  // broadcast, backstopped), so a local rollout problem is a warn line here as it
  // is on any other node, not the answer to a submission that succeeded.
  const installed = await isInstalledHere(appName);
  if (installed && schedule) {
    schedule(manifest, spec).catch((error) => log.warn(`contentSlot: local apply of ${appName} v${ver} failed - ${error.message ?? error}`));
  }

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
    const authorized = await verificationHelper.verifyPrivilege(Privilege.USER, authOf(req));
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
  storeCarriedManifest,
  specSlotNames,
  submitContentUpdate,
  submitContentUpdateApi,
  backstopManifest,
  keptSlotLocators,
  canonicalManifest,
  verifyManifest,
  sealManifestSlots,
  openManifestSlots,
  processManifestSubmission,
  takeManifest,
  signerOf,
  standingManifest,
  openStandingManifest,
  highestVersionInOwnership,
  resolveHeldManifests,
  rejudgeManifests,
  reapDisplacedManifests,
  storeBatchContentManifests,
  receiveManifest,
  handleIncomingManifest,
  stageAndApplySlots,
  applyManifest,
  scheduleContentApplication,
  computeStaggerDelayMs,
  applyStoredIfBehind,
  applyBehindContentApps,
  contentComponentsRunning,
  reconcileBootContent,
  provisionContentSlots,
  provisionComponentContent,
  stageComponentContent,
  stageContent,
  prefetchListedContent,
  listAppPeers,
  fetchManifestsFromPeer,
  refreshManifests,
  getContentManifestApi,
  getContentManifestsApi,
};
