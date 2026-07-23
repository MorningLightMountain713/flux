// v9 content-delivery seal/sign toolkit for the harness, acting as the submitting
// frontend. Every shape is taken from @runonflux/flux-spec (the authoritative
// source) — the v9 spec, the contentHash, the AppEventV2 signing payload, the
// transport envelope, and the content-manifest canonical form — never hand-rolled.
// The owner signatures use the same BTC-message primitive the node verifies with.
import crypto from 'node:crypto';
import {
  CipherSuite, DhkemX25519HkdfSha256, HkdfSha256, Aes256Gcm,
} from '@hpke/core';
import {
  TransportEnvelope, buildTransportAad, buildContentTransportAad, buildSignaturePayloadV2,
  FluxAppSpecV9, canonicalContentManifest, TRANSPORT_ALGORITHM, TRANSPORT_INFO, TRANSPORT_EXPORT_LABEL,
} from '@runonflux/flux-spec';
import { signBtcMessage } from '../auth.js';

const enc = new TextEncoder();
const sha256Hex = (input) => crypto.createHash('sha256').update(input).digest('hex');
export const blobHash = (bytes) => `sha256:${sha256Hex(bytes)}`;

let suiteCache;
function hpke() {
  if (!suiteCache) {
    suiteCache = {
      kem: new DhkemX25519HkdfSha256(),
      suite: new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() }),
    };
  }
  return suiteCache;
}

// HPKE export-mode seal toward a recipient X25519 pubkey + local AES-256-GCM, the
// frontend half of the split-HPKE the node opens (transportdecap + aeadDecrypt).
async function sealExport(plaintext, aadBytes, recipientPubB64) {
  const { suite, kem } = hpke();
  const recipientPublicKey = await kem.deserializePublicKey(Buffer.from(recipientPubB64, 'base64'));
  const sender = await suite.createSenderContext({ recipientPublicKey, info: enc.encode(TRANSPORT_INFO) });
  const key = Buffer.from(await sender.export(enc.encode(TRANSPORT_EXPORT_LABEL), 32));
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aadBytes));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = new TransportEnvelope({
    algorithm: TRANSPORT_ALGORITHM,
    encapsulatedKey: new Uint8Array(sender.enc),
    nonce: new Uint8Array(nonce),
    ciphertext: new Uint8Array(Buffer.concat([ct, cipher.getAuthTag()])),
  });
  return envelope.toJSON();
}

// Build a sparse v9 submission spec. A single component by default, with optional
// content mounts: contentRefHash adds an immutable contentRef file mount, and each
// contentSlots entry adds a mutable contentSlot file mount. Pass `components` to
// override entirely (e.g. the multi-component capstone), `assignment` for the
// replica-name map (identity -> [replicaNames]) and `placement` for the cleartext
// identity sets (identity arrays + geo). A pinned app derives its identity set,
// `mode` and `instances` from the assignment, so all three are omitted unless
// authored; candidate/untargeted placement authors `instances` (defaulted to 3).
// Pass `instances: null` to force omission.
export function buildV9ContentSpec({
  name = 'e2e-content-app',
  owner,
  image = 'nginx:latest',
  instances,
  ttl = 2592000,
  contentRefHash = null,
  contentSlots = [],
  components,
  placement,
  assignment,
  ...overrides
} = {}) {
  if (!owner) throw new Error('buildV9ContentSpec: owner required');
  const pinned = Object.values(assignment || {}).some((map) => map && Object.keys(map).length > 0);
  const instancesValue = instances === undefined && !pinned ? 3 : instances;
  const mounts = { '/data': { source: 'data', destination: '/data' } };
  if (contentRefHash) {
    mounts['/etc/ref.conf'] = {
      source: 'ref.conf', destination: '/etc/ref.conf', type: 'file', contentRef: { hash: contentRefHash },
    };
  }
  for (const slot of contentSlots) {
    mounts[slot.destination] = {
      source: slot.source || slot.name,
      destination: slot.destination,
      type: 'file',
      contentSlot: slot.name,
      ...(slot.onUpdate !== undefined ? { onUpdate: slot.onUpdate } : {}),
      ...(slot.atomic !== undefined ? { atomic: slot.atomic } : {}),
      ...(slot.uid !== undefined ? { uid: slot.uid } : {}),
      ...(slot.gid !== undefined ? { gid: slot.gid } : {}),
      ...(slot.mode !== undefined ? { mode: slot.mode } : {}),
    };
  }
  return {
    version: 9,
    name,
    description: 'E2E content-delivery test app',
    owner,
    ...(instancesValue == null ? {} : { instances: instancesValue }),
    ttl,
    contacts: { email: ['admin@example.com'] },
    ...(placement ? { placement } : {}),
    ...(assignment ? { assignment } : {}),
    components: components || {
      web: {
        name: 'web',
        description: 'content app component',
        image,
        cpu: 0.5,
        memory: 300,
        rootFsGb: 2,
        persistentStorage: { sizeGb: 10, mounts },
        ports: { http: { containerPort: 80, hostPort: 31000 } },
      },
    },
    ...overrides,
  };
}

// The canonical contentHash flux-spec computes — fromSubmission canonicalizes, then
// contentHash() hashes the canonical lexicographic JSON. Never hand-serialized.
export function contentHashOf(submissionSpec) {
  return FluxAppSpecV9.fromSubmission(submissionSpec).contentHash();
}

// Sign the AppEventV2 payload (type + "2" + contentHash + timestamp + extend) with
// the owner key, the exact payload SignedAppEvent.verifySignature reconstructs.
export async function signV9Event({
  type, contentHash, timestamp, extend, ownerPrivkey,
}) {
  const payload = buildSignaturePayloadV2(type, 2, contentHash, timestamp, extend);
  return signBtcMessage(payload, ownerPrivkey);
}

// Build the signed `spec` field of a v9 register: HPKE-seal the sparse spec toward
// the node's transport key (spec leg AAD), wrap with cleartext name/owner, compute
// the contentHash, and owner-sign the event. Registration requires extend=true.
// Pass `contentHash` to skip local canonicalization for a deliberately-INVALID
// submission spec (canonicalizing one throws here, in the test process): the AAD
// and signature stay self-consistent around the given hash, so the node opens the
// envelope and its own validation is what rejects — the actual surface under test.
export async function buildSignedRegistration({
  submissionSpec, ownerKey, transportPubB64, timestamp = Date.now(), type = 'fluxappregister', extend = true, contentHash: givenHash,
}) {
  const contentHash = givenHash || contentHashOf(submissionSpec);
  const aad = buildTransportAad({ contentHash, timestamp, type });
  const transportEncrypted = await sealExport(Buffer.from(JSON.stringify(submissionSpec)), aad, transportPubB64);
  const appSpecification = { name: submissionSpec.name, owner: submissionSpec.owner, transportEncrypted };
  const signature = await signV9Event({
    type, contentHash, timestamp, extend, ownerPrivkey: ownerKey.privkey,
  });
  const specField = {
    type, version: 2, appSpecification, contentHash, timestamp, extend, signature,
  };
  return { specField, contentHash, timestamp };
}

// Per-blob owner signatures: the dual-sig owner half over sha256(locator:appName:timestamp),
// keyed by the blob's plaintext contentHash. `locatorFor(hash)` derives the locator the
// node/FluxDrive key on (fleet-deterministic, from the benchmark channel).
export async function buildOwnerSigs({
  hashes, appName, ownerKey, timestamp, locatorFor,
}) {
  const out = {};
  for (const hash of hashes) {
    const locator = await locatorFor(hash);
    // eslint-disable-next-line no-await-in-loop
    out[hash] = { sig: await signBtcMessage(sha256Hex(`${locator}:${appName}:${timestamp}`), ownerKey.privkey), timestamp };
  }
  return out;
}

// Seal the ONE content envelope a submission carries: { blobs, manifest?, ... } HPKE-sealed
// toward the node's transport key (content leg AAD bound to the spec's contentHash via `ref`).
export async function buildContentEnvelope({
  blobs, manifest, manifestPutSig, reconcileSig, appName, transportPubB64, ref, timestamp,
}) {
  const payload = { blobs: {} };
  for (const [hash, bytes] of Object.entries(blobs || {})) {
    payload.blobs[hash] = Buffer.isBuffer(bytes) ? bytes.toString('base64') : bytes;
  }
  if (manifest) payload.manifest = manifest;
  if (manifestPutSig) payload.manifestPutSig = manifestPutSig;
  if (reconcileSig) payload.reconcileSig = reconcileSig;
  const aad = buildContentTransportAad({ appName, ref, timestamp });
  return sealExport(Buffer.from(JSON.stringify(payload)), aad, transportPubB64);
}

// An owner-signed plaintext ContentManifest (gossip form for a plaintext app; the node
// seals the slots for an encrypted app). The owner signs the canonical form flux-spec
// derives, the same bytes every verifier recomputes.
export async function buildOwnerSignedManifest({
  // rollout is mandatory on a manifest (contentManifest.js requires a strategy);
  // immediate is the simplest valid value, overridden by the rollout-strategy tests
  appName, version, slots, ownerKey, timestamp = Date.now(), rollout = { strategy: 'immediate' },
}) {
  const manifest = {
    appName,
    version,
    slots,
    timestamp,
    rollout,
  };
  const canonical = await canonicalContentManifest(manifest);
  manifest.ownerSignature = await signBtcMessage(canonical, ownerKey.privkey);
  return manifest;
}

// The FluxDrive manifest-PUT dual-sig owner half: sha256(appName:version:timestamp).
export async function manifestPutSig({
  appName, version, timestamp, ownerKey,
}) {
  return signBtcMessage(sha256Hex(`${appName}:${version}:${timestamp}`), ownerKey.privkey);
}

// The FluxDrive reconcile dual-sig owner half: sha256(appName:source:version).
export async function reconcileSig({
  appName, source, version, ownerKey,
}) {
  return signBtcMessage(sha256Hex(`${appName}:${source}:${version}`), ownerKey.privkey);
}
