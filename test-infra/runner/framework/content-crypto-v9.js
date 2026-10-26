// v9 content-delivery seal/sign toolkit for the harness, acting as the submitting
// frontend. Every shape is taken from @runonflux/flux-spec (the authoritative
// source) — the v9 spec, the contentHash, the AppEventV2 signing payload, the
// transport seal, and the content-manifest canonical form — never hand-rolled.
// The owner signatures use the same BTC-message primitive the node verifies with.
import crypto from 'node:crypto';
import {
  buildTransportAad, buildContentTransportAad, buildSignaturePayloadV2, CONTENT_LOCATOR_AAD_REF,
  FluxAppSpecV9, OpenedSpec, canonicalContentManifest, TRANSPORT_INFO,
  appUuid, appIdentityFromUuid, blobUploadDigest, manifestPutDigest, blobKeepDigest,
} from '@runonflux/flux-spec';
import { computeMessageHashV2 } from '@runonflux/flux-spec-backend';
import { HpkeTransportProvider } from '@runonflux/flux-spec-crypto';
import { signBtcMessage } from '../auth.js';
import { harnessNow } from './harness-clock.js';

const sha256Hex = (input) => crypto.createHash('sha256').update(input).digest('hex');
export const blobHash = (bytes) => `sha256:${sha256Hex(bytes)}`;

// Seal toward the network's transport key, as any client does: flux-spec's
// HpkeTransportProvider, to a key whose attestation was checked
// (content-helper.fetchTransportKey). The wire form of the envelope.
async function sealToTransportKey(plaintext, aadBytes, transportKey) {
  const provider = await HpkeTransportProvider.create();
  const envelope = await provider.seal({
    plaintext: new Uint8Array(plaintext), aad: aadBytes, recipient: transportKey, info: TRANSPORT_INFO,
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
// Declared as a spec that will be broadcast sealed: fields that must never travel
// in the clear (a contentSlot) are refused on a cleartext registration.
export function contentHashOf(submissionSpec) {
  return OpenedSpec.fromSubmission(submissionSpec).contentHash();
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
  submissionSpec, ownerKey, transportKey, timestamp = harnessNow(), type = 'fluxappregister', extend = true, contentHash: givenHash,
}) {
  const contentHash = givenHash || contentHashOf(submissionSpec);
  const aad = buildTransportAad({ contentHash, timestamp, type });
  const transportEncrypted = await sealToTransportKey(Buffer.from(JSON.stringify(submissionSpec)), aad, transportKey);
  const appSpecification = { name: submissionSpec.name, owner: submissionSpec.owner, transportEncrypted };
  const signature = await signV9Event({
    type, contentHash, timestamp, extend, ownerPrivkey: ownerKey.privkey,
  });
  const specField = {
    type, version: 2, appSpecification, contentHash, timestamp, extend, signature,
  };
  return { specField, contentHash, timestamp };
}

// Build the signed `spec` field of a cleartext v9 register or update: the spec
// travels as it is, its contentHash is over the spec as a cleartext one, and the
// owner signs the event as for a sealed one.
export async function buildSignedCleartextSubmission({
  submissionSpec, ownerKey, timestamp = harnessNow(), type = 'fluxappregister', extend = true,
}) {
  const contentHash = FluxAppSpecV9.fromSubmission(submissionSpec, { encrypted: false }).contentHash();
  const signature = await signV9Event({
    type, contentHash, timestamp, extend, ownerPrivkey: ownerKey.privkey,
  });
  const specField = {
    type, version: 2, appSpecification: submissionSpec, contentHash, timestamp, extend, signature,
  };
  return { specField, contentHash, timestamp };
}

// A v9 registration message in the clear, as a node that skipped the submission
// rules would gossip it: the spec travels as it is, its contentHash computed as
// for a sealed spec, since the library refuses to canonicalize content in the
// clear. What every other node is handed to judge.
export async function buildCleartextV9Message({
  submissionSpec, ownerKey, timestamp = harnessNow(), type = 'fluxappregister', extend = true,
}) {
  const contentHash = contentHashOf(submissionSpec);
  const signature = await signV9Event({
    type, contentHash, timestamp, extend, ownerPrivkey: ownerKey.privkey,
  });
  const hash = computeMessageHashV2(type, 2, contentHash, timestamp, extend, signature);
  return {
    type, version: 2, appSpecifications: submissionSpec, hash, contentHash, timestamp, extend, signature,
  };
}

// The hash of a signed registration or update message, as every node computes it
// and as a FluxDrive write carried by the message names it.
export function registrationMessageHash(specField) {
  return computeMessageHashV2(
    specField.type, specField.version, specField.contentHash, specField.timestamp, specField.extend, specField.signature,
  );
}

// The identity of the app a signed registration makes: the library's uuid of the
// name and the registration message's hash — what the owner signs its first
// content manifest for, before the registration is paid.
export function registrationIdentity(specField, name) {
  return appIdentityFromUuid(appUuid(name, registrationMessageHash(specField)));
}

// Per-blob owner signatures: the dual-sig owner half over the library's blob
// upload text (`locator:identity:timestamp`), keyed by the blob's plaintext
// contentHash. `locatorFor(hash)` derives the locator the node/FluxDrive key on
// (fleet-deterministic, from the benchmark channel).
export async function buildOwnerSigs({
  hashes, identity, ownerKey, timestamp, locatorFor,
}) {
  const out = {};
  for (const hash of hashes) {
    const locator = await locatorFor(hash);
    // eslint-disable-next-line no-await-in-loop
    out[hash] = { sig: await signBtcMessage(blobUploadDigest({ locator, identity, timestamp }), ownerKey.privkey), timestamp };
  }
  return out;
}

// Seal the ONE content envelope a submission carries: { blobs, manifest?, ... } HPKE-sealed
// toward the node's transport key (content leg AAD bound to the spec's contentHash via `ref`).
export async function buildContentEnvelope({
  blobs, manifest, manifestPutSig, keepList, appName, transportKey, ref, timestamp,
}) {
  const payload = { blobs: {} };
  for (const [hash, bytes] of Object.entries(blobs || {})) {
    payload.blobs[hash] = Buffer.isBuffer(bytes) ? bytes.toString('base64') : bytes;
  }
  if (manifest) payload.manifest = manifest;
  if (manifestPutSig) payload.manifestPutSig = manifestPutSig;
  if (keepList) payload.keepList = keepList;
  const aad = buildContentTransportAad({ appName, ref, timestamp });
  return sealToTransportKey(Buffer.from(JSON.stringify(payload)), aad, transportKey);
}

// Seal a locator request: the blob's contentHash, toward the node's transport key
// for the caller, under the locator's AAD reference, so only that node opens it.
export async function sealLocatorRequest({
  contentHash, appName, timestamp, transportKey,
}) {
  const aad = buildContentTransportAad({ appName, ref: CONTENT_LOCATOR_AAD_REF, timestamp });
  return sealToTransportKey(Buffer.from(JSON.stringify({ contentHash })), aad, transportKey);
}

// An owner-signed plaintext ContentManifest (gossip form for a plaintext app; the node
// seals the slots for an encrypted app). The owner signs the canonical form flux-spec
// derives, the same bytes every verifier recomputes. `ownedFrom` is the height the
// signer took the app, 0 for a registration's manifest, signed before its height exists.
export async function buildOwnerSignedManifest({
  // rollout is mandatory on a manifest (contentManifest.js requires a strategy);
  // immediate is the simplest valid value, overridden by the rollout-strategy tests
  appName, identity, version, ownedFrom = 0, slots, ownerKey, timestamp = harnessNow(), rollout = { strategy: 'immediate' },
}) {
  const manifest = {
    appName,
    identity,
    version,
    ownedFrom,
    slots,
    timestamp,
    rollout,
  };
  const canonical = await canonicalContentManifest(manifest);
  manifest.ownerSignature = await signBtcMessage(canonical, ownerKey.privkey);
  return manifest;
}

// The FluxDrive manifest-PUT dual-sig owner half, over the library's text
// (`identity:ownedFrom:version:timestamp:keptLocatorsHash:pendingMessageHash`): the
// slot locators the manifest keeps are bound by their hash, so the node can send
// no other list. A manifest that rides a spec message names that message's hash;
// a content update with no spec change names none.
export async function manifestPutSig({
  identity, ownedFrom, version, timestamp, keptLocators, pendingMessageHash = null, ownerKey,
}) {
  return signBtcMessage(manifestPutDigest({
    identity, ownedFrom, version, timestamp, keptLocators, pendingMessageHash,
  }), ownerKey.privkey);
}

// The owner half of a spec update's keep list, over the library's text
// (`identity:ownedFrom:timestamp:keptLocatorsHash:pendingMessageHash`): the
// content-ref locators the update leaves the app, none when it drops every file.
export async function keepListSig({
  identity, ownedFrom, timestamp, keptLocators, pendingMessageHash, ownerKey,
}) {
  return signBtcMessage(blobKeepDigest({
    identity, ownedFrom, timestamp, keptLocators, pendingMessageHash,
  }), ownerKey.privkey);
}
