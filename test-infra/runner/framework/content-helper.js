// Deploys v9 content-delivery apps through the REAL submission flow (the multipart
// /apps/appregister path the frontend uses), driving the content-crypto-v9 toolkit.
// It seals one HPKE content envelope over the blobs + initial manifest, owner-signs
// every door, and POSTs spec + content + ownerSigs as multipart/form-data.
import { authenticate } from '../auth.js';
import { submitToNode } from './gated-fetch.js';
import { appOwnerKey, userKey } from './keys.js';
import * as benchCrypto from '../../daemon-stub/benchCrypto.js';
import * as tk from './content-crypto-v9.js';
import { harnessNow } from './harness-clock.js';
import { registrationKeys, updateKeys } from './component-keys.js';

// The node's per-app transport pubkey (the real frontend fetches this before sealing).
// The route wraps the benchmark reply as { status:'success', data:{ status:'ok', publicKey } }.
// The component keys of a registration the door accepted, by name: its data is
// the registration's message hash.
function keysOfRegistration(data, submissionSpec) {
  return data.status === 'success' ? { componentKeys: registrationKeys(submissionSpec, data.data) } : {};
}

// The component keys of an update the door accepted, carried from the keys of
// the version it updates (opts.previousKeys) for the app's identity (opts.identity).
function keysOfUpdate(data, submissionSpec, opts) {
  if (data.status !== 'success' || opts.previousKeys === undefined) return {};
  return { componentKeys: updateKeys(submissionSpec, data.data, { previous: opts.previousKeys, identity: opts.identity }) };
}

export async function fetchTransportPubKey(nodeUrl, appName, owner) {
  const res = await fetch(`${nodeUrl}/apps/transportpubkey/${encodeURIComponent(appName)}?fluxid=${encodeURIComponent(owner)}`);
  const body = await res.json();
  if (body.status !== 'success' || !body.data || !body.data.publicKey) {
    throw new Error(`transportpubkey failed: ${JSON.stringify(body)}`);
  }
  return body.data.publicKey;
}

// The identity of the app a node's registry lists under a name: what a content
// update's manifest is signed for, and what every FluxDrive write names.
export async function listedIdentity(nodeUrl, name) {
  const res = await fetch(`${nodeUrl}/apps/globalappsspecifications?appname=${encodeURIComponent(name)}`);
  const body = await res.json();
  const row = body.status === 'success' && Array.isArray(body.data) ? body.data[0] : null;
  if (!row || !row.identity) throw new Error(`no listed app ${name} with an identity: ${JSON.stringify(body)}`);
  return row.identity;
}

// What a node holds for the app listed under a name, as the owner reads it before
// signing: the identity, the listed ownership (owner and the height they took the
// app), the manifest the app stands on and the version the next manifest takes.
export async function manifestStanding(nodeUrl, name) {
  const res = await fetch(`${nodeUrl}/apps/contentmanifests/${encodeURIComponent(name)}`);
  const body = await res.json();
  if (body.status !== 'success' || !body.data) throw new Error(`contentmanifests failed for ${name}: ${JSON.stringify(body)}`);
  return body.data;
}

/**
 * Deploy a v9 content app via the real submission path.
 *
 * @param {string} nodeUrl
 * @param {object} opts - { name, owner?, image?, instances?, ttl?, components?, placement?,
 *   assignment?, contentRef?: Buffer, contentSlots?: [{ name, destination, bytes, onUpdate?, atomic? }],
 *   ownerKey?, timestamp? }
 * @returns {Promise<object>} the /apps/appregister response + { contentHash, appName,
 *   componentKeys } (componentKeys once the door accepts it)
 */
export async function deployContentApp(nodeUrl, opts) {
  const ownerKey = opts.ownerKey || appOwnerKey();
  const owner = opts.owner || ownerKey.zelid;
  const { name } = opts;
  const timestamp = opts.timestamp || harnessNow();
  const contentSlots = opts.contentSlots || [];

  // Spec: contentRef mount (immutable) + contentSlot mounts (mutable).
  const contentRefHash = opts.contentRef ? tk.blobHash(opts.contentRef) : null;
  const submissionSpec = tk.buildV9ContentSpec({
    name,
    owner,
    image: opts.image,
    instances: opts.instances,
    ttl: opts.ttl,
    components: opts.components,
    placement: opts.placement,
    assignment: opts.assignment,
    contentRefHash,
    contentSlots: contentSlots.map((s) => ({
      name: s.name, destination: s.destination, source: s.source, onUpdate: s.onUpdate, atomic: s.atomic, uid: s.uid, gid: s.gid, mode: s.mode,
    })),
  });

  const transportPubB64 = await fetchTransportPubKey(nodeUrl, name, owner);
  const { specField, contentHash } = await tk.buildSignedRegistration({ submissionSpec, ownerKey, transportPubB64, timestamp });

  // Blobs: contentRef + every slot's initial bytes, keyed by plaintext hash.
  const blobs = {};
  if (opts.contentRef) blobs[contentRefHash] = opts.contentRef;
  const slotMap = {};
  for (const s of contentSlots) {
    const h = tk.blobHash(s.bytes);
    blobs[h] = s.bytes;
    slotMap[s.name] = { hash: h };
  }

  // Every FluxDrive text names the identity this registration makes; the locator
  // comes from the same fleet-deterministic derivation the node uses, so the
  // dual-sig matches.
  const identity = tk.registrationIdentity(specField, name);
  const messageHash = tk.registrationMessageHash(specField);
  const locatorFor = (h) => benchCrypto.locatorFor({ identity, contentHash: h });
  const ownerSigs = await tk.buildOwnerSigs({
    hashes: Object.keys(blobs), identity, ownerKey, timestamp, locatorFor,
  });

  // Initial manifest (slot apps only) + its FluxDrive owner signature, over the
  // slot locators it keeps. The write names this registration's message, so
  // FluxDrive holds it until the nodes answer that the registration applied.
  let manifest;
  let manifestPutSig;
  if (contentSlots.length) {
    manifest = await tk.buildOwnerSignedManifest({
      appName: name, identity, version: 1, slots: slotMap, ownerKey, timestamp,
    });
    manifestPutSig = await tk.manifestPutSig({
      identity, ownedFrom: 0, version: 1, timestamp, keptLocators: Object.values(slotMap).map((s) => locatorFor(s.hash)), pendingMessageHash: messageHash, ownerKey,
    });
  }

  const envelope = await tk.buildContentEnvelope({
    blobs, manifest, manifestPutSig, appName: name, transportPubB64, ref: contentHash, timestamp,
  });

  const auth = await authenticate(nodeUrl, ownerKey);
  const form = new FormData();
  form.append('spec', JSON.stringify(specField));
  form.append('ownerSigs', JSON.stringify(ownerSigs));
  form.append('content', new Blob([JSON.stringify(envelope)], { type: 'application/json' }), 'content.json');

  const res = await submitToNode(`${nodeUrl}/apps/appregister`, {
    method: 'POST',
    headers: { zelidauth: auth.zelidauth },
    body: form,
  });
  const data = await res.json();
  return {
    ...data, contentHash, appName: name, ...keysOfRegistration(data, submissionSpec),
  };
}

/**
 * Register an encrypted v9 app that carries NO content (no contentRef, no
 * contentSlots) — e.g. a graceful-shutdown or secrets-only app. The spec is always
 * HPKE-sealed toward the node's transport key, so the app is genuinely encrypted;
 * the content envelope is omitted entirely (the register handler treats content as
 * optional). Reusable for any non-content encrypted v9 app — deployContentApp's
 * sibling for the no-content case.
 *
 * @param {string} nodeUrl
 * @param {object} opts - { name, owner?, image?, instances?, ttl?, components?, placement?, assignment?, ownerKey?, timestamp? }
 *   `components` is the full v9 components map (pass shutdown/preStop/etc. on a component here).
 * @returns {Promise<object>} the /apps/appregister response + { contentHash, appName,
 *   componentKeys } (componentKeys once the door accepts it)
 */
export async function registerEncryptedV9App(nodeUrl, opts) {
  const ownerKey = opts.ownerKey || appOwnerKey();
  const owner = opts.owner || ownerKey.zelid;
  const { name } = opts;
  const timestamp = opts.timestamp || harnessNow();

  const submissionSpec = tk.buildV9ContentSpec({
    name,
    owner,
    image: opts.image,
    instances: opts.instances,
    ttl: opts.ttl,
    components: opts.components,
    placement: opts.placement,
    assignment: opts.assignment,
    // Extra top-level v9 spec fields (e.g. a telemetry block) — spread last
    // by the builder, so they land on the submission verbatim.
    ...(opts.specOverrides || {}),
  });

  const transportPubB64 = await fetchTransportPubKey(nodeUrl, name, owner);
  const { specField, contentHash } = await tk.buildSignedRegistration({
    submissionSpec, ownerKey, transportPubB64, timestamp, contentHash: opts.contentHash,
  });

  const auth = await authenticate(nodeUrl, ownerKey);
  const form = new FormData();
  form.append('spec', JSON.stringify(specField));

  const res = await submitToNode(`${nodeUrl}/apps/appregister`, {
    method: 'POST',
    headers: { zelidauth: auth.zelidauth },
    body: form,
  });
  const data = await res.json();
  return {
    ...data, contentHash, appName: name, ...keysOfRegistration(data, submissionSpec),
  };
}

/**
 * Update an encrypted v9 app's SPEC (POST /apps/appupdate): a signed fluxappupdate
 * carrying the full new submission spec, HPKE-sealed toward the node's per-app
 * transport key — registerEncryptedV9App's update sibling. The response data is the
 * update message hash; confirm it on-chain (queueAppTx + advanceBlocks) the same way
 * as a registration, then the fleet converges on the new spec.
 *
 * @param {string} nodeUrl
 * @param {object} opts - { name, owner?, image?, instances?, ttl?, components?, placement?, assignment?, ownerKey?, timestamp?,
 *   previousKeys?, identity? } - previousKeys (the keys of the version it updates) and
 *   the app's identity give the update's componentKeys
 * @returns {Promise<object>} the /apps/appupdate response + { contentHash, appName,
 *   componentKeys? }
 */
export async function updateEncryptedV9App(nodeUrl, opts) {
  const ownerKey = opts.ownerKey || appOwnerKey();
  const owner = opts.owner || ownerKey.zelid;
  const { name } = opts;
  const timestamp = opts.timestamp || harnessNow();

  const submissionSpec = tk.buildV9ContentSpec({
    name,
    owner,
    image: opts.image,
    instances: opts.instances,
    ttl: opts.ttl,
    components: opts.components,
    placement: opts.placement,
    assignment: opts.assignment,
    // Extra top-level v9 spec fields (e.g. a telemetry block) — spread last
    // by the builder, so they land on the submission verbatim.
    ...(opts.specOverrides || {}),
  });

  const transportPubB64 = await fetchTransportPubKey(nodeUrl, name, owner);
  const { specField, contentHash } = await tk.buildSignedRegistration({
    submissionSpec, ownerKey, transportPubB64, timestamp, type: 'fluxappupdate',
  });

  const auth = await authenticate(nodeUrl, ownerKey);
  const form = new FormData();
  form.append('spec', JSON.stringify(specField));

  const res = await submitToNode(`${nodeUrl}/apps/appupdate`, {
    method: 'POST',
    headers: { zelidauth: auth.zelidauth },
    body: form,
  });
  const data = await res.json();
  return {
    ...data, contentHash, appName: name, ...keysOfUpdate(data, submissionSpec, opts),
  };
}

// A cleartext v9 register or update through its door: the spec is signed and sent
// as it is, never sealed, so it is stored and gossiped in the clear.
async function submitCleartextV9App(nodeUrl, opts, type) {
  const ownerKey = opts.ownerKey || appOwnerKey();
  const owner = opts.owner || ownerKey.zelid;
  const submissionSpec = tk.buildV9ContentSpec({
    name: opts.name,
    owner,
    image: opts.image,
    instances: opts.instances,
    ttl: opts.ttl,
    components: opts.components,
    placement: opts.placement,
    assignment: opts.assignment,
    ...(opts.specOverrides || {}),
  });
  const { specField, contentHash } = await tk.buildSignedCleartextSubmission({
    submissionSpec, ownerKey, timestamp: opts.timestamp || harnessNow(), type,
  });

  const auth = await authenticate(nodeUrl, ownerKey);
  const form = new FormData();
  form.append('spec', JSON.stringify(specField));
  const door = type === 'fluxappupdate' ? 'appupdate' : 'appregister';
  const res = await submitToNode(`${nodeUrl}/apps/${door}`, {
    method: 'POST',
    headers: { zelidauth: auth.zelidauth },
    body: form,
  });
  const data = await res.json();
  const keys = type === 'fluxappupdate' ? keysOfUpdate(data, submissionSpec, opts) : keysOfRegistration(data, submissionSpec);
  return {
    ...data, contentHash, appName: opts.name, ...keys,
  };
}

/**
 * Register a cleartext v9 app (POST /apps/appregister): registerEncryptedV9App's
 * sibling for a spec that is never sealed. It carries no content.
 *
 * @param {string} nodeUrl
 * @param {object} opts - { name, owner?, image?, instances?, ttl?, components?, placement?,
 *   assignment?, specOverrides?, ownerKey?, timestamp? }
 * @returns {Promise<object>} the /apps/appregister response + { contentHash, appName,
 *   componentKeys } (componentKeys once the door accepts it)
 */
export async function registerCleartextV9App(nodeUrl, opts) {
  return submitCleartextV9App(nodeUrl, opts, 'fluxappregister');
}

/**
 * Update a cleartext v9 app's spec (POST /apps/appupdate): the full new spec,
 * signed by `ownerKey` and naming `owner`, which for a sale is the buyer.
 *
 * @param {string} nodeUrl
 * @param {object} opts - as registerCleartextV9App, and previousKeys? and identity? as
 *   updateEncryptedV9App's
 * @returns {Promise<object>} the /apps/appupdate response + { contentHash, appName,
 *   componentKeys? } (componentKeys as updateEncryptedV9App's)
 */
export async function updateCleartextV9App(nodeUrl, opts) {
  return submitCleartextV9App(nodeUrl, opts, 'fluxappupdate');
}

/**
 * Move an app registered before v9 onto v9 the way its owner does: ask a node to
 * convert it (GET /apps/appconvert/:name, as the owner), edit the draft as the owner
 * must (a contact where the legacy spec had none, placement where the conversion
 * dropped a node list), and submit it as the app's v9 update through the cleartext
 * door.
 *
 * @param {string} nodeUrl
 * @param {object} opts - { name, edit?: (draft) => draft, ownerKey?, timestamp?,
 *   previousKeys?, identity? } - previousKeys and identity as updateEncryptedV9App's;
 *   for a v1-v8 predecessor the keys are its component names
 * @returns {Promise<object>} the /apps/appupdate response + { conversion: { spec,
 *   complete, errors, warnings }, contentHash, appName, componentKeys? }
 */
export async function convertToV9(nodeUrl, opts) {
  const ownerKey = opts.ownerKey || appOwnerKey();
  const auth = await authenticate(nodeUrl, ownerKey);
  const res = await fetch(`${nodeUrl}/apps/appconvert/${encodeURIComponent(opts.name)}`, {
    headers: { zelidauth: auth.zelidauth },
  });
  const body = await res.json();
  if (body.status !== 'success' || body.data.encrypted) {
    throw new Error(`appconvert ${opts.name}: ${JSON.stringify(body).slice(0, 500)}`);
  }
  const conversion = body.data;
  const submissionSpec = opts.edit ? opts.edit(structuredClone(conversion.spec)) : conversion.spec;
  const { specField, contentHash } = await tk.buildSignedCleartextSubmission({
    submissionSpec, ownerKey, timestamp: opts.timestamp || harnessNow(), type: 'fluxappupdate',
  });

  const form = new FormData();
  form.append('spec', JSON.stringify(specField));
  const submitted = await submitToNode(`${nodeUrl}/apps/appupdate`, {
    method: 'POST',
    headers: { zelidauth: auth.zelidauth },
    body: form,
  });
  const data = await submitted.json();
  return {
    conversion, ...data, contentHash, appName: opts.name, ...keysOfUpdate(data, submissionSpec, opts),
  };
}

/**
 * Update a v9 content app's SPEC with its content (POST /apps/appupdate, multipart):
 * a signed fluxappupdate carrying the full new submission spec and one sealed content
 * envelope - deployContentApp's update sibling. A spec that declares slots carries the
 * file list covering every one of them: the manifest is signed for the listed app under
 * its listed ownership, at the version the node says comes next, and its FluxDrive
 * writes name the update's message, so FluxDrive holds them until the nodes answer
 * that the update applied. The manifest rides in the update's message.
 *
 * A slot entry is { name, destination, bytes } (new or rotated: bytes attached and
 * owner-signed) or { name, destination, hash } (kept from the standing manifest).
 * A `contentRef` is the app's immutable blob, attached and owner-signed like a
 * rotated slot.
 *
 * @param {string} nodeUrl
 * @param {object} opts - { name, owner?, image?, instances?, ttl?, components?, placement?,
 *   assignment?, contentRef?: Buffer, contentSlots: [{ name, destination, bytes | hash, onUpdate?, atomic? }],
 *   specOverrides?, version?, ownerKey?, timestamp?, previousKeys?, identity? }
 * @returns {Promise<object>} the /apps/appupdate response (its data is the update's
 *   message hash) + { contentHash, appName, manifest, componentKeys? } (componentKeys
 *   as updateEncryptedV9App's)
 */
export async function updateContentApp(nodeUrl, opts) {
  const ownerKey = opts.ownerKey || appOwnerKey();
  const owner = opts.owner || ownerKey.zelid;
  const { name } = opts;
  const timestamp = opts.timestamp || harnessNow();
  const contentSlots = opts.contentSlots || [];
  const contentRefHash = opts.contentRef ? tk.blobHash(opts.contentRef) : null;

  const submissionSpec = tk.buildV9ContentSpec({
    name,
    owner,
    image: opts.image,
    instances: opts.instances,
    ttl: opts.ttl,
    components: opts.components,
    placement: opts.placement,
    assignment: opts.assignment,
    contentRefHash,
    contentSlots: contentSlots.map((s) => ({
      name: s.name, destination: s.destination, source: s.source, onUpdate: s.onUpdate, atomic: s.atomic, uid: s.uid, gid: s.gid, mode: s.mode,
    })),
    ...(opts.specOverrides || {}),
  });

  const transportPubB64 = await fetchTransportPubKey(nodeUrl, name, owner);
  const { specField, contentHash } = await tk.buildSignedRegistration({
    submissionSpec, ownerKey, transportPubB64, timestamp, type: 'fluxappupdate',
  });

  const blobs = {};
  if (opts.contentRef) blobs[contentRefHash] = opts.contentRef;
  const slotMap = {};
  for (const s of contentSlots) {
    const h = s.bytes ? tk.blobHash(s.bytes) : s.hash;
    if (s.bytes) blobs[h] = s.bytes;
    slotMap[s.name] = { hash: h };
  }

  const standing = await manifestStanding(nodeUrl, name);
  const { identity } = standing;
  const version = opts.version ?? standing.nextVersion;
  const messageHash = tk.registrationMessageHash(specField);
  const locatorFor = (h) => benchCrypto.locatorFor({ identity, contentHash: h });
  const ownerSigs = await tk.buildOwnerSigs({
    hashes: Object.keys(blobs), identity, ownerKey, timestamp, locatorFor,
  });

  let manifest;
  let manifestPutSig;
  if (contentSlots.length) {
    manifest = await tk.buildOwnerSignedManifest({
      appName: name, identity, version, ownedFrom: standing.ownership.from, slots: slotMap, ownerKey, timestamp,
    });
    manifestPutSig = await tk.manifestPutSig({
      identity, ownedFrom: standing.ownership.from, version, timestamp, keptLocators: Object.values(slotMap).map((s) => locatorFor(s.hash)), pendingMessageHash: messageHash, ownerKey,
    });
  }

  const envelope = await tk.buildContentEnvelope({
    blobs, manifest, manifestPutSig, appName: name, transportPubB64, ref: contentHash, timestamp,
  });

  const auth = await authenticate(nodeUrl, ownerKey);
  const form = new FormData();
  form.append('spec', JSON.stringify(specField));
  form.append('ownerSigs', JSON.stringify(ownerSigs));
  form.append('content', new Blob([JSON.stringify(envelope)], { type: 'application/json' }), 'content.json');

  const res = await submitToNode(`${nodeUrl}/apps/appupdate`, {
    method: 'POST',
    headers: { zelidauth: auth.zelidauth },
    body: form,
  });
  const data = await res.json();
  return {
    ...data, contentHash, appName: name, manifest, ...keysOfUpdate(data, submissionSpec, opts),
  };
}

/**
 * Ask a node to derive a blob's locator (POST /apps/bloblocator) as the caller:
 * the contentHash travels sealed toward the node's transport key for the caller,
 * and the node derives the locator for the identity the caller owns.
 *
 * @param {string} nodeUrl
 * @param {{ name: string, contentHash: string, ownerKey: object, timestamp?: number }} opts
 * @returns {Promise<object>} the route's answer, its data `{ locator }` on success
 */
export async function requestBlobLocator(nodeUrl, {
  name, contentHash, ownerKey, timestamp = harnessNow(),
}) {
  const transportPubB64 = await fetchTransportPubKey(nodeUrl, name, ownerKey.zelid);
  const sealed = await tk.sealLocatorRequest({
    contentHash, appName: name, timestamp, transportPubB64,
  });
  const auth = await authenticate(nodeUrl, ownerKey);
  const res = await fetch(`${nodeUrl}/apps/bloblocator`, {
    method: 'POST',
    headers: { zelidauth: auth.zelidauth, 'content-type': 'application/json' },
    body: JSON.stringify({ appName: name, timestamp, sealed }),
  });
  return res.json();
}

/**
 * Push a standalone content-slot update (POST /apps/contentupdate): a new manifest
 * version with new slot bytes, sealed as one HPKE content envelope (AAD ref
 * manifest:v<version>) with the owner-signed manifest + the FluxDrive dual-sigs.
 *
 * A slot entry is either { name, bytes } (rotated: bytes attached + owner-signed)
 * or { name, hash } (carried over: declared in the manifest with no bytes and no
 * sig — the node presence-checks the stored copy from the prior version instead).
 *
 * @param {string} nodeUrl
 * @param {object} opts - { name, owner?, version, slots: [{ name, bytes } | { name, hash }], ownerKey?, timestamp?, rollout? }
 * @returns {Promise<object>} the /apps/contentupdate response
 */
export async function pushContentUpdate(nodeUrl, opts) {
  const ownerKey = opts.ownerKey || appOwnerKey();
  const owner = opts.owner || ownerKey.zelid;
  const { name } = opts;
  const timestamp = opts.timestamp || harnessNow();

  const slotMap = {};
  const blobs = {};
  for (const s of opts.slots || []) {
    const h = s.bytes ? tk.blobHash(s.bytes) : s.hash;
    if (s.bytes) blobs[h] = s.bytes;
    slotMap[s.name] = { hash: h };
  }

  const transportPubB64 = await fetchTransportPubKey(nodeUrl, name, owner);
  // Signed under the listed ownership: the manifest carries the height the owner
  // took the app, and the version the node says comes next unless the suite names one.
  const standing = await manifestStanding(nodeUrl, name);
  const { identity } = standing;
  const version = opts.version ?? standing.nextVersion;
  const manifest = await tk.buildOwnerSignedManifest({
    appName: name, identity, version, ownedFrom: standing.ownership.from, slots: slotMap, ownerKey, timestamp, rollout: opts.rollout,
  });
  const locatorFor = (h) => benchCrypto.locatorFor({ identity, contentHash: h });
  const ownerSigs = await tk.buildOwnerSigs({
    hashes: Object.keys(blobs), identity, ownerKey, timestamp, locatorFor,
  });
  // A content update changes no spec, so its FluxDrive write names no message and
  // is applied on arrival.
  const mPutSig = await tk.manifestPutSig({
    identity, ownedFrom: standing.ownership.from, version, timestamp, keptLocators: Object.values(slotMap).map((s) => locatorFor(s.hash)), ownerKey,
  });

  const envelope = await tk.buildContentEnvelope({
    blobs, manifest, manifestPutSig: mPutSig,
    appName: name, transportPubB64, ref: `manifest:v${version}`, timestamp,
  });

  const auth = await authenticate(nodeUrl, ownerKey);
  const form = new FormData();
  form.append('appName', name);
  form.append('version', String(version));
  form.append('timestamp', String(timestamp));
  form.append('ownerSigs', JSON.stringify(ownerSigs));
  form.append('content', new Blob([JSON.stringify(envelope)], { type: 'application/json' }), 'content.json');

  const res = await submitToNode(`${nodeUrl}/apps/contentupdate`, {
    method: 'POST', headers: { zelidauth: auth.zelidauth }, body: form,
  });
  return res.json();
}

/**
 * Inject a content manifest with a FORGED owner signature into the network via a peer
 * stub, modelling a Byzantine peer relaying a manifest it never owner-verified (honest
 * nodes never do this). The stub node-signs the gossip envelope with its own trusted node
 * key, so the relay check passes; the manifest is owner-signed by a NON-owner key, so a
 * receiving node's owner-sig verification fails and it drops the manifest, emitting
 * content:manifestDropped{forged_signature}.
 *
 * @param {object} stub - a stubPeerClient (an env.stubPeerClients value)
 * @param {object} opts - { appName, version, slots: [{ name, bytes }], forgerKey? }
 * @returns {Promise<object>} the stub /broadcast result ({ status, sent })
 */
export async function injectForgedManifestGossip(stub, opts) {
  const forgerKey = opts.forgerKey || userKey(); // a non-owner key, so the owner-sig check fails
  const slotMap = {};
  for (const s of opts.slots || []) slotMap[s.name] = { hash: tk.blobHash(s.bytes) };
  const manifest = await tk.buildOwnerSignedManifest({
    appName: opts.appName, identity: opts.identity, version: opts.version, ownedFrom: opts.ownedFrom ?? 0, slots: slotMap, ownerKey: forgerKey,
  });
  return stub.broadcast({ type: 'fluxappcontentmanifest', appName: opts.appName, manifest });
}

/**
 * Assert every node's content-manifest register holds the given version for an app.
 * @param {Array<object>} dbClients - per-node dbClient instances
 * @param {string} appName
 * @param {number} version
 * @returns {Promise<{ synced: boolean, versions: Array<number|null> }>}
 */
export async function assertManifestSynced(dbClients, appName, version) {
  const rows = await Promise.all(dbClients.map((dbc) => dbc.getContentManifest(appName).catch(() => null)));
  const versions = rows.map((r) => (r ? r.version : null));
  return { synced: versions.every((v) => v === version), versions };
}

/**
 * Assert every node has DELIVERED content up to `version` — the running-container half of
 * convergence, distinct from assertManifestSynced (which only checks the known register
 * version). Reads the row the node marks `applied`, the one delivered to the container;
 * a register ahead of it is exactly the gap the steady-state backstop closes (a node whose
 * register caught up but whose container is still serving the old content).
 */
export async function assertContentApplied(dbClients, appName, version) {
  const rows = await Promise.all(dbClients.map((dbc) => dbc.getAppliedContentManifest(appName).catch(() => null)));
  const appliedVersions = rows.map((r) => (r ? r.version : null));
  return { applied: appliedVersions.every((v) => v === version), appliedVersions };
}
