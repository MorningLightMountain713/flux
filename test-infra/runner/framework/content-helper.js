// Deploys v9 content-delivery apps through the REAL submission flow (the multipart
// /apps/appregister path the frontend uses), driving the content-crypto-v9 toolkit.
// It seals one HPKE content envelope over the blobs + initial manifest, owner-signs
// every door, and POSTs spec + content + ownerSigs as multipart/form-data.
import { authenticate } from '../auth.js';
import { appOwnerKey } from './keys.js';
import benchCrypto from '../../daemon-stub/benchCrypto.js';
import * as tk from './content-crypto-v9.js';

// The node's per-app transport pubkey (the real frontend fetches this before sealing).
// The route wraps the benchmark reply as { status:'success', data:{ status:'ok', publicKey } }.
export async function fetchTransportPubKey(nodeUrl, appName, owner) {
  const res = await fetch(`${nodeUrl}/apps/transportpubkey/${encodeURIComponent(appName)}?fluxid=${encodeURIComponent(owner)}`);
  const body = await res.json();
  if (body.status !== 'success' || !body.data || !body.data.publicKey) {
    throw new Error(`transportpubkey failed: ${JSON.stringify(body)}`);
  }
  return body.data.publicKey;
}

/**
 * Deploy a v9 content app via the real submission path.
 *
 * @param {string} nodeUrl
 * @param {object} opts - { name, owner?, image?, instances?, ttl?, components?,
 *   contentRef?: Buffer, contentSlots?: [{ name, destination, bytes, onUpdate?, atomic? }],
 *   ownerKey?, timestamp? }
 * @returns {Promise<object>} the /apps/appregister response + { contentHash, appName }
 */
export async function deployContentApp(nodeUrl, opts) {
  const ownerKey = opts.ownerKey || appOwnerKey();
  const owner = opts.owner || ownerKey.zelid;
  const name = opts.name;
  const timestamp = opts.timestamp || Date.now();
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
    contentRefHash,
    contentSlots: contentSlots.map((s) => ({
      name: s.name, destination: s.destination, source: s.source, onUpdate: s.onUpdate, atomic: s.atomic,
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

  // Owner sigs over sha256(locator:appName:timestamp) — locator from the same
  // fleet-deterministic derivation the node uses, so the dual-sig matches.
  const locatorFor = (h) => benchCrypto.locatorFor({ appName: name, fluxID: owner, contentHash: h });
  const ownerSigs = await tk.buildOwnerSigs({ hashes: Object.keys(blobs), appName: name, ownerKey, timestamp, locatorFor });

  // Initial manifest (slot apps only) + its FluxDrive dual-sigs.
  let manifest;
  let manifestPutSig;
  let reconcileSig;
  if (contentSlots.length) {
    manifest = await tk.buildOwnerSignedManifest({ appName: name, version: 1, slots: slotMap, ownerKey, timestamp });
    manifestPutSig = await tk.manifestPutSig({ appName: name, version: 1, timestamp, ownerKey });
    reconcileSig = await tk.reconcileSig({ appName: name, source: 'slot', version: 1, ownerKey });
  }

  const envelope = await tk.buildContentEnvelope({
    blobs, manifest, manifestPutSig, reconcileSig, appName: name, transportPubB64, ref: contentHash, timestamp,
  });

  const auth = await authenticate(nodeUrl, ownerKey);
  const form = new FormData();
  form.append('spec', JSON.stringify(specField));
  form.append('ownerSigs', JSON.stringify(ownerSigs));
  form.append('content', new Blob([JSON.stringify(envelope)], { type: 'application/json' }), 'content.json');

  const res = await fetch(`${nodeUrl}/apps/appregister`, {
    method: 'POST',
    headers: { zelidauth: auth.zelidauth },
    body: form,
  });
  const data = await res.json();
  return { ...data, contentHash, appName: name };
}

/**
 * Push a standalone content-slot update (POST /apps/contentupdate): a new manifest
 * version with new slot bytes, sealed as one HPKE content envelope (AAD ref
 * manifest:v<version>) with the owner-signed manifest + the FluxDrive dual-sigs.
 *
 * @param {string} nodeUrl
 * @param {object} opts - { name, owner?, version, slots: [{ name, bytes }], ownerKey?, timestamp?, rollout? }
 * @returns {Promise<object>} the /apps/contentupdate response
 */
export async function pushContentUpdate(nodeUrl, opts) {
  const ownerKey = opts.ownerKey || appOwnerKey();
  const owner = opts.owner || ownerKey.zelid;
  const name = opts.name;
  const { version } = opts;
  const timestamp = opts.timestamp || Date.now();

  const slotMap = {};
  const blobs = {};
  for (const s of opts.slots || []) {
    const h = tk.blobHash(s.bytes);
    blobs[h] = s.bytes;
    slotMap[s.name] = { hash: h };
  }

  const transportPubB64 = await fetchTransportPubKey(nodeUrl, name, owner);
  const manifest = await tk.buildOwnerSignedManifest({
    appName: name, version, slots: slotMap, ownerKey, timestamp, rollout: opts.rollout,
  });
  const locatorFor = (h) => benchCrypto.locatorFor({ appName: name, fluxID: owner, contentHash: h });
  const ownerSigs = await tk.buildOwnerSigs({
    hashes: Object.keys(blobs), appName: name, ownerKey, timestamp, locatorFor,
  });
  const mPutSig = await tk.manifestPutSig({ appName: name, version, timestamp, ownerKey });
  const rSig = await tk.reconcileSig({ appName: name, source: 'slot', version, ownerKey });

  const envelope = await tk.buildContentEnvelope({
    blobs, manifest, manifestPutSig: mPutSig, reconcileSig: rSig,
    appName: name, transportPubB64, ref: `manifest:v${version}`, timestamp,
  });

  const auth = await authenticate(nodeUrl, ownerKey);
  const form = new FormData();
  form.append('appName', name);
  form.append('version', String(version));
  form.append('timestamp', String(timestamp));
  form.append('ownerSigs', JSON.stringify(ownerSigs));
  form.append('content', new Blob([JSON.stringify(envelope)], { type: 'application/json' }), 'content.json');

  const res = await fetch(`${nodeUrl}/apps/contentupdate`, {
    method: 'POST', headers: { zelidauth: auth.zelidauth }, body: form,
  });
  return res.json();
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
