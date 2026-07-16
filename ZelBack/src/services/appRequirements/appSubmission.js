const fs = require('node:fs');
const { formidable } = require('formidable');
const config = require('config');
const serviceHelper = require('../serviceHelper');
const messageHelper = require('../messageHelper');
const log = require('../../lib/log');
const verificationHelper = require('../verificationHelper');
const daemonServiceMiscRpcs = require('../daemonService/daemonServiceMiscRpcs');
const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');
const registryManager = require('../appDatabase/registryManager');
const messageVerifier = require('../appMessaging/messageVerifier');
const appEventVerifier = require('../appMessaging/appEventVerifier');
const { verifyImageRegistryAndArchitectures } = require('../appSecurity/imageArchitectureValidator');
const { validateSubmissionSpec, getSpec, getSpecBackend, assertUpdateInvariants } = require('../utils/specLibs');
const { deserializeSpec } = require('../utils/specCutover');
const transportHelper = require('../utils/transportHelper');
const appsRepository = require('../appDatabase/appsRepository');
const entitlementsState = require('../entitlementsState');
const marketplaceTemplateCache = require('../marketplace/marketplaceTemplateCache');
const contentBlobService = require('../appLifecycle/contentBlobService');
const contentSlotService = require('../appLifecycle/contentSlotService');
const fluxDriveClient = require('../utils/fluxDriveClient');
const globalState = require('../utils/globalState');
const { peerManager } = require('../utils/peerState');

/**
 * Resolve the effective template submission spec for the tier the deploy claims.
 * A tiered template (useConfig) is a base spec plus per-config overrides; the
 * deployed spec selects its tier via marketplace.configId, and the effective
 * template is deepMerge(base, configs[configId].overrides). The "required iff
 * useConfig" rule is a consensus check enforced here, against the fetched
 * template — the schema can't know whether a template is tiered. Merging happens
 * on the sparse submission form (before canonicalization) so the bytes line up
 * with how the frontend builds the deploy spec. Rejections carry TEMPLATE_MISMATCH.
 *
 * @param {object} template - fetched marketplace template ({ spec, useConfig, configs })
 * @param {string|null} configId - deployed tier id from spec.marketplace.configId
 * @param {Function} deepMerge - flux-spec base+override merge
 * @returns {object} the effective template submission spec
 */
function resolveEffectiveTemplateSpec(template, configId, deepMerge) {
  if (!template.useConfig) {
    if (configId) {
      const err = new Error('Marketplace template is not tiered; configId must be null');
      err.code = 'TEMPLATE_MISMATCH';
      throw err;
    }
    return template.spec;
  }

  if (!configId) {
    const err = new Error('Marketplace template is tiered; a configId is required');
    err.code = 'TEMPLATE_MISMATCH';
    throw err;
  }
  const tier = (template.configs || []).find((c) => c.id === configId);
  if (!tier) {
    const err = new Error(`Marketplace template has no config ${configId}`);
    err.code = 'TEMPLATE_MISMATCH';
    throw err;
  }
  return deepMerge(template.spec, tier.overrides || {});
}

/**
 * v9 marketplace template verification. If the spec claims a marketplace template
 * (marketplace != null), fetch that template version, resolve the effective spec
 * for the deployed tier, and assert the spec matches it — non-configurable fields
 * must be unchanged. Hard-reject on mismatch (incl. a bad/missing configId); the
 * cache throws "unavailable" if the template can't be fetched, so a registration
 * is never silently accepted. No-op when marketplace is null (custom registration).
 *
 * @param {object} spec - validated v9 FluxAppSpecV9 instance (exposes matchesTemplate/toCanonical)
 */
async function assertMatchesMarketplaceTemplate(spec) {
  const { marketplace } = spec;
  if (!marketplace || !marketplace.templateId) return;

  const template = await marketplaceTemplateCache.getTemplate(
    marketplace.templateId, marketplace.templateVersion,
  );

  const { FluxAppSpecV9, deepMerge } = await getSpec();
  const effectiveSpec = resolveEffectiveTemplateSpec(template, marketplace.configId, deepMerge);

  // Build a comparable template-spec instance. The template stores owner:null and
  // no contacts; matchesTemplate ignores name/owner and contacts is user-configurable,
  // so injecting the deployed spec's name/owner/contacts only satisfies construction —
  // it does not affect the comparison.
  const canonical = spec.toCanonical();
  const templateSpec = FluxAppSpecV9.fromSubmission({
    ...effectiveSpec,
    name: canonical.name,
    owner: canonical.owner,
    contacts: canonical.contacts,
  });

  const { matches, mismatches } = spec.matchesTemplate(templateSpec, template.userConfigurable || []);
  if (!matches) {
    const err = new Error(`Spec does not match marketplace template ${marketplace.templateId} v${marketplace.templateVersion}: ${mismatches.join(', ')}`);
    err.code = 'TEMPLATE_MISMATCH';
    throw err;
  }
}

/**
 * Resolve + validate a submission spec, class-first, across all v8/v9
 * cleartext and encrypted forms:
 *   - v9 transport-encrypted → HPKE-open to cleartext, validate, then
 *     backend-encrypt for storage
 *   - v8 enterprise (backend-encrypted blob) → decrypt, validate the
 *     cleartext, keep the original blob as the wire form
 *   - cleartext → validate
 *
 * Returns the validated spec instance, whether the app is encrypted, and the
 * wire blob to broadcast/store — never cleartext for an encrypted app.
 *
 * @param {object} appSpecification - raw submission spec
 * @param {object} meta - { contentHash, timestamp, type, daemonHeight } from the signed envelope
 * @returns {Promise<{ spec: object, isEncrypted: boolean, broadcastBlob: object }>}
 */
async function resolveSubmission(appSpecification, {
  contentHash, timestamp, type, daemonHeight,
}) {
  const wasTransportEncrypted = Boolean(appSpecification && appSpecification.transportEncrypted);

  // STAGE 1 — v9 transport-open (no-op when there is no envelope)
  const submissionBlob = await transportHelper.openTransportEnvelope(appSpecification, {
    contentHash, timestamp, type,
  });

  // STAGE 2 — parse + validate as a submission (strict, class-first)
  const wireSpec = await deserializeSpec(submissionBlob);
  if (!wireSpec) throw new Error('Could not deserialize app specifications');

  let spec;
  if (wireSpec.isEncrypted) {
    // v8 enterprise blob — decrypt, then hold the decrypted instance to submission rules
    const provider = await wireSpec.createProvider();
    spec = await wireSpec.decrypt(provider);
    await validateSubmissionSpec(spec.spec.serialize(), { height: daemonHeight });
  } else {
    spec = await validateSubmissionSpec(submissionBlob, { height: daemonHeight });
  }

  const isEncrypted = wasTransportEncrypted || wireSpec.isEncrypted;

  // The signed contentHash (v9) must match the actual decrypted content, so a
  // tampered envelope can't slip different bytes past the signature.
  if (contentHash) {
    const cleartext = spec.spec || spec;
    if (typeof cleartext.contentHash === 'function' && cleartext.contentHash() !== contentHash) {
      const err = new Error('contentHash does not match submitted spec');
      err.code = 'DECRYPT_FAILED';
      throw err;
    }
  }

  // STAGE 3 — runtime image registry + architecture checks
  await verifyImageRegistryAndArchitectures(spec, { owner: spec.owner, isEncrypted });

  // STAGE 4 — feature entitlements + marketplace-template gate. Total across
  // versions: a v1-v8 spec exposes no gated features and carries no marketplace
  // block, so both calls are a no-op for legacy specs — no version branch needed.
  const cleartextSpec = spec.spec || spec;
  await entitlementsState.assertSpecEntitled(cleartextSpec, spec.owner, daemonHeight, isEncrypted);
  await assertMatchesMarketplaceTemplate(cleartextSpec);

  // STAGE 5 — wire form for broadcast/storage; never cleartext for encrypted apps
  let broadcastBlob;
  if (wasTransportEncrypted) {
    // v9 transport submission — backend-encrypt the validated cleartext for
    // storage. sealForStorage owns version dispatch + provider sourcing in
    // flux-spec, so no spec version is named here.
    const { sealForStorage } = await getSpecBackend();
    const encryptedSpec = await sealForStorage(spec);
    broadcastBlob = encryptedSpec.serialize();
  } else if (wireSpec.isEncrypted) {
    // v8 enterprise — the submitted blob is already the stored (encrypted) form
    broadcastBlob = wireSpec.serialize();
  } else {
    broadcastBlob = spec.serialize();
  }

  return { spec, isEncrypted, broadcastBlob };
}

async function verifyAppRegistrationParameters(req, res) {
  try {
    const processedBody = serviceHelper.ensureObject(req.body);
    // A transport-encrypted preflight nests the spec under appSpecification
    // and carries the signed-envelope metadata alongside; a cleartext
    // preflight is just the spec object.
    const appSpecification = serviceHelper.ensureObject(processedBody.appSpecification || processedBody);
    const { contentHash, timestamp, type } = processedBody;

    const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
    if (!syncStatus.data.synced) {
      throw new Error('Daemon not yet synced.');
    }
    const daemonHeight = syncStatus.data.height;

    const { spec, broadcastBlob } = await resolveSubmission(appSpecification, {
      contentHash, timestamp, type: type || 'fluxappregister', daemonHeight,
    });

    await registryManager.checkApplicationRegistrationNameConflicts(spec);

    const respondPrice = messageHelper.createDataMessage(broadcastBlob);
    res.json(respondPrice);
  } catch (error) {
    log.warn(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

async function validateAppUpdate(appSpecification, meta = {}) {
  const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
  if (!syncStatus.data.synced) {
    throw new Error('Daemon not yet synced.');
  }
  const daemonHeight = syncStatus.data.height;

  const { contentHash, timestamp, type } = meta;
  const { spec, broadcastBlob } = await resolveSubmission(appSpecification, {
    contentHash, timestamp, type: type || 'fluxappupdate', daemonHeight,
  });

  const verificationTimestamp = timestamp || Date.now();
  const { getPreviousSpec } = require('../appDatabase/appSpecHistory');
  const previousSpec = await getPreviousSpec(spec, verificationTimestamp);
  if (!previousSpec) {
    throw new Error(`Flux App ${spec.name} does not exist and cannot be updated`);
  }

  // Registration-locked invariants (e.g. referral) — compare cleartext specs.
  await assertUpdateInvariants(previousSpec, spec);

  const { latestSupportedSpecVersion } = config.fluxapps;
  const { UpdatePolicy } = await getSpec();
  UpdatePolicy.assertVersionTransition(previousSpec, spec, latestSupportedSpecVersion);

  return broadcastBlob;
}

async function verifyAppUpdateApi(req, res) {
  try {
    const processedBody = serviceHelper.ensureObject(req.body);
    const appSpecification = serviceHelper.ensureObject(processedBody.appSpecification || processedBody);
    const { contentHash, timestamp, type } = processedBody;
    const appSpecFormatted = await validateAppUpdate(appSpecification, { contentHash, timestamp, type });
    const respondPrice = messageHelper.createDataMessage(appSpecFormatted);
    res.json(respondPrice);
  } catch (error) {
    log.warn(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

/**
 * Validate and broadcast a parsed registration submission. Shared by the JSON
 * and multipart paths. The multipart path passes contentCtx (the HPKE-sealed
 * content envelope) so its content is opened + uploaded synchronously (durable
 * before gossip) once the spec validates. res.json is sent here on
 * success/unauthorized; validation failures throw to the caller's handler.
 */
async function submitAppRegistration(req, res, processedBody, contentCtx) {
  const authorized = await verificationHelper.verifyPrivilege('user', req);
  if (!authorized) {
    res.json(messageHelper.errUnauthorizedMessage());
    return;
  }

  if (peerManager.outboundCount < config.fluxapps.minOutgoing) {
    throw new Error('Sorry, This Flux does not have enough outgoing peers for safe application registration');
  }
  if (peerManager.inboundCount < config.fluxapps.minIncoming) {
    throw new Error('Sorry, This Flux does not have enough incoming peers for safe application registration');
  }

  let { appSpecification, timestamp, signature } = processedBody;
  const { contentHash, extend } = processedBody;
  let messageType = processedBody.type;
  let typeVersion = processedBody.version;

  if (!appSpecification || !timestamp || !signature || !messageType || !typeVersion) {
    throw new Error('Incomplete message received. Check if appSpecification, type, version, timestamp and signature are provided.');
  }

  if (messageType !== 'zelappregister' && messageType !== 'fluxappregister') {
    throw new Error('Invalid type of message');
  }

  // envelope version 1 = legacy v1-v8, 2 = v9 (AppEventV2 / contentHash signing)
  if (typeVersion !== 1 && typeVersion !== 2) {
    throw new Error('Invalid version of message');
  }

  appSpecification = serviceHelper.ensureObject(appSpecification);
  timestamp = serviceHelper.ensureNumber(timestamp);
  signature = serviceHelper.ensureString(signature);
  messageType = serviceHelper.ensureString(messageType);
  typeVersion = serviceHelper.ensureNumber(typeVersion);

  const timestampNow = Date.now();
  if (timestamp < timestampNow - 1000 * 3600) {
    throw new Error('Message timestamp is over 1 hour old, not valid. Check if your computer clock is synced and restart the registration process.');
  } else if (timestamp > timestampNow + 1000 * 60 * 5) {
    throw new Error('Message timestamp from future, not valid. Check if your computer clock is synced and restart the registration process.');
  }

  const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
  if (!syncStatus.data.synced) {
    throw new Error('Daemon not yet synced.');
  }

  const daemonHeight = syncStatus.data.height;

  const { spec, broadcastBlob } = await resolveSubmission(appSpecification, {
    contentHash, timestamp, type: messageType, daemonHeight,
  });

  await registryManager.checkApplicationRegistrationNameConflicts(spec);

  // Content rides as ONE HPKE-sealed envelope — never plaintext in transit. Open it
  // toward this node's per-app transport key and upload synchronously so it is
  // durably stored before the spec is gossiped.
  if (contentCtx) {
    await uploadSealedContent(spec, contentCtx.content, contentCtx.ownerSigs, {
      ref: contentHash, timestamp,
    });
  }

  const signedEvent = await appEventVerifier.deserializeTempMessage({
    type: messageType,
    version: typeVersion,
    appSpecifications: broadcastBlob,
    contentHash,
    timestamp,
    extend,
    signature,
  });
  await appEventVerifier.authorize({
    appEvent: signedEvent,
    daemonHeight,
    verifyHash: false,
  });

  const messageHASH = await appEventVerifier.computeOutboundHash({
    type: messageType,
    envelopeVersion: typeVersion,
    specBlob: broadcastBlob,
    contentHash,
    timestamp,
    extend,
    signature,
  });

  // v9 only (envelope version 2). v8 enterprise messages are envelope
  // version 1, which old nodes still parse — they must not carry an unknown
  // arcaneAttestation key. v9 messages (version 2) are rejected by old nodes
  // before parsing, so the field only ever rides messages they ignore.
  let arcaneAttestation;
  if (signedEvent.requiresArcaneAttestation()) {
    arcaneAttestation = await appEventVerifier.requestAttestation(contentHash);
  }

  const temporaryAppMessage = {
    type: messageType,
    version: typeVersion,
    appSpecifications: broadcastBlob,
    hash: messageHASH,
    contentHash,
    timestamp,
    extend,
    signature,
    arcaneAttestation,
  };
  await fluxCommunicationMessagesSender.broadcastTemporaryAppMessage(temporaryAppMessage);
  await serviceHelper.delay(1200);
  await messageVerifier.requestAppMessage(messageHASH);
  await serviceHelper.delay(1200);
  let tempMessage = await appsRepository.getTempMessage(messageHASH);
  for (let i = 0; i < 20; i += 1) {
    if (!tempMessage) {
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.delay(500);
      // eslint-disable-next-line no-await-in-loop
      tempMessage = await appsRepository.getTempMessage(messageHASH);
    }
  }
  if (tempMessage && typeof tempMessage === 'object' && !Array.isArray(tempMessage)) {
    const responseHash = messageHelper.createDataMessage(tempMessage.hash);
    res.json(responseHash);
    return;
  }
  throw new Error('Unable to register application on the network. Try again later.');
}

/**
 * Read a multipart/form-data submission: the `spec` field (the signed submission
 * JSON), an optional `content` file part, and an `ownerSigs` field (JSON map of
 * hash -> { sig, timestamp }).
 *
 * The `content` part is ONE HPKE-sealed TransportEnvelope over { blobs, manifest? }
 * — a content app is always encrypted, so its content is sealed toward the node's
 * per-app transport key and is never plaintext in transit or to any relay. It is
 * parsed back into the envelope object here; opening (toward the node's transport
 * key) happens downstream once resolveSubmission has the cleartext name/owner +
 * contentHash. The temp file is read into memory (capped at maxContentBytes) and
 * removed.
 *
 * @returns {Promise<{ spec: string, content: object|null, ownerSigs: Map<string, object> }>}
 */
async function parseMultipartSubmission(req) {
  const form = formidable({
    maxFileSize: await contentBlobService.maxContentBytes(),
    multiples: true,
    keepExtensions: false,
  });
  const [fields, files] = await form.parse(req);
  const first = (value) => (Array.isArray(value) ? value[0] : value);

  const spec = first(fields.spec);
  const ownerSigsObj = serviceHelper.ensureObject(first(fields.ownerSigs) || '{}');
  const ownerSigs = new Map(Object.entries(ownerSigsObj));

  let content = null;
  const contentFile = files.content ? first(files.content) : null;
  if (contentFile) {
    const raw = await fs.promises.readFile(contentFile.filepath);
    content = serviceHelper.ensureObject(raw.toString('utf8'));
    await fs.promises.unlink(contentFile.filepath).catch(() => {});
  }
  return { spec, content, ownerSigs };
}

/**
 * Open a submission's HPKE-sealed content envelope toward this node's per-app
 * transport key and upload its content — content never travels in the clear. The
 * envelope seals { blobs: { hash: base64 }, manifest? }; contentRef blobs (declared
 * in the immutable spec) upload here, and the AAD is bound to the submission via
 * `ref` (the signed contentHash) so a captured envelope can't be replayed onto a
 * different submission. Any non-contentRef blobs belong to content-slot mounts and
 * are returned (with the manifest) for the slot path. Shared by register + update:
 * an update passes the spec it supersedes (priorSpec), whose contentRef hashes are
 * carried over — already stored under identical locators — so the envelope attaches
 * only new or changed files; a register has no prior and attaches everything.
 *
 * @param {object} spec - resolved submission spec (name, owner, contentRef mounts)
 * @param {object} content - the sealed TransportEnvelope JSON
 * @param {Map} ownerSigs - per-blob owner signatures
 * @param {object} bind - { ref, timestamp, priorSpec? } — transport AAD + the
 *   decrypted spec this update supersedes (absent on register)
 * @returns {Promise<{ payload: object, blobs: Map<string, Buffer> }>}
 */
async function uploadSealedContent(spec, content, ownerSigs, { ref, timestamp, priorSpec }) {
  const opened = await transportHelper.openContentEnvelope(content, {
    appName: spec.name, owner: spec.owner, ref, timestamp,
  });
  const payload = serviceHelper.ensureObject(opened.toString('utf8'));
  const blobs = new Map(Object.entries(payload.blobs || {}).map(([h, b64]) => [h, Buffer.from(b64, 'base64')]));

  const refHashes = contentBlobService.specContentHashes(spec);
  const refBlobs = new Map([...blobs].filter(([h]) => refHashes.has(h)));
  await contentBlobService.encryptAndUploadBlobs({
    spec, priorSpec, blobs: refBlobs, ownerSigs,
  }, { uploader: fluxDriveClient });

  // A slot app bundles its INITIAL owner-signed manifest with the submission: upload
  // the slot blobs, store the manifest, and gossip it so the network has the slots'
  // starting content alongside the spec. Without this an app would register declaring
  // slots with no content for the install-hold to find. A slot app always forces an
  // encrypted spec (flux-spec validation), so the gossiped slots payload is sealed.
  if (payload.manifest) {
    const slotHashes = new Set(Object.values(payload.manifest.slots || {}).map((s) => s.hash));
    const slotBlobs = new Map([...blobs].filter(([h]) => slotHashes.has(h)));
    const gossipManifest = await contentSlotService.processManifestSubmission(
      {
        manifest: payload.manifest, spec, owner: spec.owner, encrypted: true, blobs: slotBlobs, ownerSigs,
      },
      { uploader: fluxDriveClient },
    );
    // Broadcast first: broadcastMessageToAll returns the exact signed node broadcast it
    // relayed, so the stored row carries that same envelope (one signature) and is
    // boot-sync-servable to a fresh node.
    const signedBroadcast = await fluxCommunicationMessagesSender.broadcastMessageToAll({
      type: 'fluxappcontentmanifest', appName: spec.name, manifest: gossipManifest,
    });
    await contentSlotService.storeManifest(gossipManifest, { broadcast: signedBroadcast });
    // Populate the FluxDrive backstop at register too — the first installing instance
    // has no peers, so FluxDrive is its only manifest source. Best-effort; the owner
    // PUT-sig rides the sealed payload (frontend-produced at submission).
    await contentSlotService.backstopManifest(gossipManifest, {
      appName: spec.name,
      version: payload.manifest.version,
      timestamp: payload.manifest.timestamp,
      manifestPutSig: payload.manifestPutSig,
    }, {});
    // Reconcile the live slot-locator set with FluxDrive's GC so an update that supersedes
    // slot content reclaims the old blobs (a no-op at register: version 1 supersedes nothing).
    await contentSlotService.reconcileSlots(payload.manifest, {
      appName: spec.name,
      owner: spec.owner,
      version: payload.manifest.version,
      reconcileSig: payload.reconcileSig,
    }, {});
  }

  return { payload, blobs };
}

/**
 * Multipart registration: parse the spec + sealed content envelope, gate content
 * uploads to arcane nodes, then run the shared submission flow with the content.
 */
async function handleMultipartAppRegister(req, res) {
  try {
    const { spec, content, ownerSigs } = await parseMultipartSubmission(req);
    if (content && !globalState.isArcane()) {
      throw new Error('Content uploads require an arcane node');
    }
    const processedBody = serviceHelper.ensureObject(spec);
    const contentCtx = content ? { content, ownerSigs } : null;
    await submitAppRegistration(req, res, processedBody, contentCtx);
  } catch (error) {
    log.warn(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

async function registerAppGlobalyApi(req, res) {
  const contentType = req.headers['content-type'] || '';
  if (contentType.startsWith('multipart/form-data')) {
    return handleMultipartAppRegister(req, res);
  }
  try {
    const processedBody = serviceHelper.ensureObject(req.body);
    await submitAppRegistration(req, res, processedBody, null);
  } catch (error) {
    log.warn(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
  return undefined;
}

function normalizePGPSecret(pgpMessage) {
  if (!pgpMessage) return '';
  return pgpMessage.replace(/\s+/g, '').replace(/\\n/g, '').trim();
}

async function assertSecretsNotConflicting(appName, componentName, secrets, owner, options = {}) {
  const { isRegistration = false } = options;
  const normalized = normalizePGPSecret(secrets);
  if (!normalized) return;

  const liveSecrets = await appsRepository.listLiveV7Secrets();
  let foundSameApp = false;
  let foundDifferentApp = false;

  for (const entry of liveSecrets) {
    if (normalizePGPSecret(entry.secrets) === normalized) {
      if (isRegistration) {
        throw new Error(
          `Provided component '${componentName}' secrets are not valid (duplicate in app: '${entry.appName}')`,
        );
      } else if (entry.appName !== appName) {
        foundDifferentApp = true;
      } else {
        foundSameApp = true;
      }
    }
  }

  if (!isRegistration && foundDifferentApp && !foundSameApp) {
    throw new Error('Provided component(s) secrets are not valid (conflict with another app).');
  }

  const historicalSecrets = await appsRepository.listHistoricalV7Secrets();
  const seen = new Set();
  for (const entry of historicalSecrets) {
    const entryNormalized = normalizePGPSecret(entry.secrets);
    if (seen.has(entryNormalized)) continue;
    seen.add(entryNormalized);

    if (entryNormalized === normalized && entry.owner !== owner) {
      throw new Error(
        `Provided component '${componentName}' secrets are not valid (owner mismatch: '${entry.owner}').`,
      );
    }
  }
}

module.exports = {
  resolveSubmission,
  verifyAppRegistrationParameters,
  validateAppUpdate,
  verifyAppUpdateApi,
  registerAppGlobalyApi,
  parseMultipartSubmission,
  uploadSealedContent,
  assertSecretsNotConflicting,
};
