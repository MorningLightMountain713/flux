'use strict';

const fs = require('node:fs');
const { formidable } = require('formidable');
const config = require('config');
const serviceHelper = require('../serviceHelper');
const messageHelper = require('../messageHelper');
const log = require('../../lib/log');
const verificationHelper = require('../verificationHelper');
const daemonStatus = require('../daemonService/daemonStatus');
const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');
const ingressAttestationService = require('../appMessaging/ingressAttestationService');
const ingressCapture = require('../utils/ingressCapture');
const registryManager = require('../appDatabase/registryManager');
const placementFeasibility = require('../appPlacement/placementFeasibility');
const messageVerifier = require('../appMessaging/messageVerifier');
const appEventVerifier = require('../appMessaging/appEventVerifier');
const { verifyImageRegistryAndArchitectures } = require('../appSecurity/imageArchitectureValidator');
const {
  validateSubmissionSpec, getSpec, getSpecBackend, assertUpdateInvariants, assertVersionActivated,
} = require('../utils/specLibs');
const { ensureProvidersRegistered, resolveRegisteredSpec } = require('../utils/specCutover');
const transportHelper = require('../utils/transportHelper');
const appsRepository = require('../appDatabase/appsRepository');
const appRecords = require('../appDatabase/appRecords');
const appHistory = require('../appDecisions/appHistory');
const manifestStanding = require('../appLifecycle/manifestStanding');
const appSpecHistory = require('../appDatabase/appSpecHistory');
const entitlementsState = require('../entitlementsState');
const marketplaceTemplateCache = require('../marketplace/marketplaceTemplateCache');
const contentBlobService = require('../appLifecycle/contentBlobService');
const { isFluxStorageUrl, storageLinkOf } = require('../utils/fluxStorage');
const enterpriseNetwork = require('../utils/enterpriseNetwork');
const signatureVerifier = require('../signatureVerifier');
const contentSlotService = require('../appLifecycle/contentSlotService');
const messageStore = require('../appMessaging/messageStore');
const fluxDriveClient = require('../utils/fluxDriveClient');
const globalState = require('../utils/globalState');
const { assertSubmittableTimestamp } = require('../appMessaging/submittableTimestamp');
const capabilities = require('../utils/capabilities');
const { peerManager } = require('../utils/peerState');
const { Privilege, authOf } = require('../utils/privileges');
const { nodeChain } = require('../utils/nodeChain');

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

  const { matches, mismatches, unresolved } = spec.matchesTemplate(templateSpec, template.userConfigurable || []);
  if (!matches) {
    const reasons = unresolved.length > 0
      ? [...mismatches, `userConfigurable names nothing in the template: ${unresolved.join(', ')}`]
      : mismatches;
    const err = new Error(`Spec does not match marketplace template ${marketplace.templateId} v${marketplace.templateVersion}: ${reasons.join(', ')}`);
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
/**
 * The specification the chain last applied for this app's name, or null. Read from
 * the applied history rather than the live registry, so an app that has expired can
 * still be renewed on what it held.
 * @param {object} spec - the submitted specification
 * @returns {Promise<object|null>}
 */
async function previousSettledSpec(spec) {
  const latest = await appHistory.latestApplied(spec.name);
  if (!latest) return null;
  const { message } = latest;
  const { deserializeSpec } = await getSpecBackend();
  return deserializeSpec(message.appSpecifications, { chain: nodeChain(), height: message.height });
}

/** Whether two placements name the same nodes, in any order. */
function sameTargets(left, right) {
  const key = (placement) => JSON.stringify([
    [...placement.targetIps].sort(), [...placement.targetOutpoints].sort(), [...placement.targetOperators].sort(),
  ]);
  return key(left) === key(right);
}

/**
 * Refuses a live submission that acquires an enterprise placement privilege its owner
 * does not hold: datacenter, on v8 and later, and a v8 node pin.
 *
 * AN EXISTING GRANT IS CARRIED FORWARD, NOT ACQUIRED. An owner off the enterprise list
 * may submit the datacenter its app already holds, or the identical pin, so renewing
 * or updating the app never costs it the placement it was granted; acquiring one,
 * redirecting a pin or widening it still needs the owner to be on the list. Where new
 * instances may be placed is still the install-time check's to decide
 * (hwRequirements.checkDataCenter), so an app carried forward keeps what it runs and
 * gains no datacenter instances while its owner is off the list.
 *
 * Live submissions only: a replay is a message already on chain, and a node judging it
 * by today's list would disagree with its peers about the past. A v9 pin is v9's
 * placement model, not this privilege. A previous specification that cannot be read
 * grants nothing - the rule grants a privilege, so it fails closed.
 *
 * @param {object} spec - the resolved specification
 * @param {object} [deps] - enterprise (isEnterpriseAppOwner) and previousSpec, injected in tests
 */
async function assertPlacementPrivileges(spec, {
  enterprise = enterpriseNetwork,
  previousSpec = previousSettledSpec,
} = {}) {
  const wantsDatacenter = spec.version >= 8 && spec.placement.dataCenter === true;
  const wantsPin = spec.version === 8 && spec.placement.hasTargets();
  if (!wantsDatacenter && !wantsPin) return;

  const eligible = enterprise.isEnterpriseAppOwner(spec.owner);
  if (eligible === null) {
    throw new Error('Cannot verify placement eligibility: network policy not yet obtained.');
  }
  if (eligible) return;

  const settled = await previousSpec(spec).catch((error) => {
    log.warn(`assertPlacementPrivileges - the previous specification of ${spec.name} could not be read: ${error.message}`);
    return null;
  });
  // A grant belongs to the owner it was made to: a name registered again by someone
  // else inherits nothing.
  const previous = settled && signatureVerifier.sameSigningIdentity(settled.owner, spec.owner) ? settled : null;
  if (wantsDatacenter && !(previous && previous.placement.dataCenter === true)) {
    throw new Error('Datacenter requirement is only available for enterprise app owners.');
  }
  if (wantsPin && !(previous && previous.version === 8 && sameTargets(previous.placement, spec.placement))) {
    throw new Error('Selecting nodes is only available for enterprise app owners; an existing selection may be carried forward unchanged.');
  }
}

/**
 * Refuses a live submission whose storage links do not address Flux storage over
 * https. What a node fetches is decided at the fetch (fluxStorageRefs), for every app
 * whatever height it was registered at; this tells the author of a new one before it
 * reaches the chain. A v1-v8 component carries its links as env.F_S_ENV and as an
 * `F_S_CMD=` argument.
 * @param {object} spec - the resolved specification
 */
function assertStorageLinksAddressFluxStorage(spec) {
  // eslint-disable-next-line no-restricted-syntax
  for (const [name, comp] of spec.componentEntries()) {
    const links = [
      comp.env && typeof comp.env.F_S_ENV === 'string' ? comp.env.F_S_ENV : null,
      ...(Array.isArray(comp.cmd) ? comp.cmd.map((arg) => storageLinkOf(arg)) : []),
    ].filter((link) => link !== null);
    if (links.some((link) => !isFluxStorageUrl(link))) {
      throw new Error(`Storage link for component ${name} of Flux App ${spec.name} must address Flux storage over https`);
    }
  }
}

async function resolveSubmission(appSpecification, {
  contentHash, timestamp, type, daemonHeight,
}) {
  const wasTransportEncrypted = Boolean(appSpecification && appSpecification.transportEncrypted);

  // v9 transport-open (no-op when there is no envelope)
  const submissionBlob = await transportHelper.openTransportEnvelope(appSpecification, {
    contentHash, timestamp, type,
  });

  // Parse strictly, class-first. The tolerant specCutover wrapper (null on
  // any parse error) is for reading stored docs where a bad row must not
  // crash a loop; a submission error must reach the submitter with the
  // validator's field-precise message, so the validation error propagates.
  await ensureProvidersRegistered();
  const { deserializeSpec: parseSubmission, SealedSpecV8 } = await getSpecBackend();
  const wireSpec = await parseSubmission(submissionBlob, { chain: nodeChain() });
  if (!wireSpec) throw new Error('Could not deserialize app specifications');

  // The ENVELOPE of a v8 enterprise submission, which nothing else checks.
  // `deserializeSpec` dispatches every read — stored row, gossiped message,
  // chain replay — through SealedSpecV8.deserialize, which takes the
  // ciphertext and the named metadata and drops the rest. So a submission could
  // carry a populated `compose` beside its blob and be accepted: signed onto the
  // chain, then ignored by every node that read it back. Not a way to run
  // unvalidated code, but a signed document saying something the network does
  // not do, which anything reading chain data sees.
  //
  // `fromSubmission` is where those sentinels are written down and it had no
  // caller anywhere. Here, and only here: this function is reached from the four
  // register/update paths and from nothing that reads. The dispatcher stays
  // exactly as loose as it is, because every v8 enterprise spec already on chain
  // is re-validated through it on every sync and a stricter door there forks the
  // node off the network.
  //
  // Measured before wiring it in: all 3599 v8 enterprise documents in the
  // permanent-message corpus pass `fromSubmission`, so this rejects nothing that
  // has ever been registered. The return value is discarded — `wireSpec` is
  // already built and is what flows on; this call is the assertion.
  if (SealedSpecV8.matchesWire(submissionBlob)) {
    SealedSpecV8.fromSubmission(submissionBlob, { chain: nodeChain() });
  }

  // Computed BEFORE validation, because validation needs it. `wasTransportEncrypted`
  // is what makes this node seal the spec for broadcast below, and `isEncrypted` is
  // a v8 blob that arrived sealed; either way the credentials never travel in the
  // clear. Neither, and the broadcast blob is the cleartext spec — which is exactly
  // when `imageAuth` and `secretEnvironment` must be refused.
  const isEncrypted = wasTransportEncrypted || wireSpec.isEncrypted;

  let spec;
  if (wireSpec.isEncrypted) {
    // v8 enterprise blob — decrypt, then hold the decrypted instance to submission rules
    const provider = await wireSpec.createProvider();
    spec = await wireSpec.decrypt(provider);
    // Through the wrapper: a decrypted spec has no wire form, so submission
    // rules are applied without ever producing a plaintext blob. v8's decrypt
    // uses the looser deserialize path, so this is the check that holds an
    // enterprise blob's contents to submission rules.
    assertVersionActivated(spec.version, daemonHeight);
    spec.validateContents({ purpose: 'submission', height: daemonHeight });
  } else {
    spec = await validateSubmissionSpec(submissionBlob, {
      height: daemonHeight, encrypted: isEncrypted,
    });
  }

  // The signed contentHash (v9) must match the actual decrypted content, so a
  // tampered envelope can't slip different bytes past the signature.
  //
  // Every spec answers contentHash() now — a sealed container returns null,
  // because the hash is over the cleartext it is hiding. This used to ask
  // `typeof cleartext.contentHash === 'function'` and SKIP the comparison when
  // the method was absent, so anything that could not produce a hash passed the
  // check instead of failing it. A guard against a tampered envelope has to
  // fail closed.
  if (contentHash) {
    if (spec.contentHash() !== contentHash) {
      const err = new Error('contentHash does not match submitted spec');
      err.code = 'DECRYPT_FAILED';
      throw err;
    }
  }

  assertStorageLinksAddressFluxStorage(spec);

  // A registration continues no component, so a `renamedFrom` on one names
  // nothing, and every node would refuse to install it. An update's are judged
  // against the version it updates (assertUpdateInvariants).
  if (type === 'fluxappregister') {
    const { componentContinuations } = await getSpec();
    componentContinuations(spec, null);
  }

  // POLICY IS A PRECONDITION OF ANSWERING. The blocked-repository list is part of the
  // signed bundle, so without a confirmed one this node cannot establish that an image
  // is not banned. A node in that state is not refusing this app; it is not yet in a
  // position to judge any app, which is a fact about the node and is what the caller
  // needs told so it can retry or ask a node that is ready. Every submission reaching
  // here is live - a replay is judged where it is stored - and the spawner and the
  // installer hold to the same gate.
  if (!capabilities.isUp('policyCurrent')) {
    throw new Error('Cannot verify application images: network policy not yet obtained.');
  }
  await assertPlacementPrivileges(spec);
  await verifyImageRegistryAndArchitectures(spec, { owner: spec.owner, isEncrypted });

  // Feature entitlements + marketplace-template gate. Total across versions:
  // a v1-v8 spec exposes no gated features and carries no marketplace block,
  // so both calls are a no-op for legacy specs — no version branch needed.
  //
  // `spec` directly, not `spec.spec || spec`. A decrypted spec is a
  // OpenedSpec that delegates toCanonical/matchesTemplate/marketplace,
  // so the wrapper answers everything both gates ask. Unwrapping discarded the
  // type guarantee the wrapper exists to hold, and made every caller responsible
  // for knowing which half of the `||` applied.
  await entitlementsState.assertSpecEntitled(spec, spec.owner, daemonHeight, isEncrypted);
  await assertMatchesMarketplaceTemplate(spec);

  // Wire form for broadcast/storage; never cleartext for encrypted apps
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

    const syncStatus = daemonStatus.daemonSyncState();
    if (!syncStatus.synced) {
      throw new Error('Daemon not yet synced.');
    }
    const daemonHeight = syncStatus.height;

    const { spec, broadcastBlob } = await resolveSubmission(appSpecification, {
      contentHash, timestamp, type: type || 'fluxappregister', daemonHeight,
    });

    await registryManager.checkApplicationRegistrationNameConflicts(spec);

    // Placement feasibility at the front door, while the spec is in hand: a spec
    // the network provably cannot place is refused before it is paid for, and a
    // diversity-constrained one is accepted with a warning. A failure to COMPUTE
    // never refuses - without the computation there is no proof.
    await placementFeasibility.checkPlacementFeasibility(spec, 'verifyAppRegistrationParameters');

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
  const syncStatus = daemonStatus.daemonSyncState();
  if (!syncStatus.synced) {
    throw new Error('Daemon not yet synced.');
  }
  const daemonHeight = syncStatus.height;

  const { contentHash, timestamp, type } = meta;
  const { spec, broadcastBlob } = await resolveSubmission(appSpecification, {
    contentHash, timestamp, type: type || 'fluxappupdate', daemonHeight,
  });

  // The app as it stands now: its active registry row, the same authority the
  // submission path itself uses, so a preflight cannot pass an update that the
  // submission then rejects; or, when the list carries none, the app that last
  // held the name, so an expired app is renewed on what it held. An enterprise
  // app's stored spec is sealed and the invariants compare cleartext, so
  // resolve it first.
  const appInfo = (await appRecords.registry().byName(spec.name)) ?? (await appSpecHistory.latestAppliedState(spec.name));
  if (!appInfo) {
    throw new Error(`Flux App ${spec.name} does not exist and cannot be updated`);
  }
  const previousSpec = await resolveRegisteredSpec(appInfo);
  if (!previousSpec) {
    throw new Error(`Flux App ${spec.name} specifications cannot be read on this node`);
  }

  // Registration-locked invariants (e.g. referral) — compare cleartext specs.
  await assertUpdateInvariants(previousSpec, spec);

  const latestSupportedSpecVersion = config.get('fluxapps.latestSupportedSpecVersion');
  const { UpdatePolicy } = await getSpec();
  UpdatePolicy.assertVersionTransition(previousSpec, spec, latestSupportedSpecVersion);

  // The same gate the submission applies, so a preflight cannot pass an update
  // the submission then refuses. Passing the previous spec keeps a renewal or a
  // cancellation - anything that changes nothing placement-relevant - ungated.
  await placementFeasibility.checkPlacementFeasibility(spec, 'validateAppUpdate', previousSpec);

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
  const authorized = await verificationHelper.verifyPrivilege(Privilege.USER, authOf(req));
  if (!authorized) {
    res.json(messageHelper.errUnauthorizedMessage());
    return;
  }

  // Direction-agnostic on purpose: duty pairs are reciprocal, one connection
  // per pair, and which end wears the outbound label is decided by a dial
  // race — a well-connected node can hold every pair inbound-labelled.
  // What safety needs is that enough distinct peers hold a connection to
  // this node; counting by direction undercounts exactly the healthy case.
  if (peerManager.getNumberOfPeers() < config.get('fluxapps.minOutgoing') + config.get('fluxapps.minIncoming')) {
    throw new Error('Sorry, This Flux does not hold enough peer connections for safe application registration');
  }

  let { appSpecification, timestamp, signature } = processedBody;
  const { contentHash, extend } = processedBody;
  let messageType = processedBody.type;
  let typeVersion = processedBody.version;

  if (!appSpecification || !timestamp || !signature || !messageType || !typeVersion) {
    throw new Error('Incomplete message received. Check if appSpecification, type, version, timestamp and signature are provided.');
  }

  if (messageType !== 'fluxappregister') {
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

  assertSubmittableTimestamp(timestamp);

  const syncStatus = daemonStatus.daemonSyncState();
  if (!syncStatus.synced) {
    throw new Error('Daemon not yet synced.');
  }

  const daemonHeight = syncStatus.height;

  const { spec, broadcastBlob } = await resolveSubmission(appSpecification, {
    contentHash, timestamp, type: messageType, daemonHeight,
  });

  await registryManager.checkApplicationRegistrationNameConflicts(spec);

  // The preflight applies this too, but the preflight is advisory - a client can
  // skip it. This is the path that stores and gossips the spec, so the refusal
  // has to stand here as well.
  await placementFeasibility.checkPlacementFeasibility(spec, 'registerAppGlobalyApi');

  const messageHASH = await appEventVerifier.computeOutboundHash({
    type: messageType,
    envelopeVersion: typeVersion,
    specBlob: broadcastBlob,
    contentHash,
    timestamp,
    extend,
    signature,
  });

  // Content rides as ONE HPKE-sealed envelope — never plaintext in transit. Open it
  // toward this node's per-app transport key and upload synchronously so it is
  // durably stored before the spec is gossiped. The identity is the one this
  // registration's hash makes, and FluxDrive holds the manifest until the nodes
  // answer that the registration applied.
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

  // Content is uploaded only for a registration signed by its owner.
  if (contentCtx) {
    const { appUuid, registrationIdentity } = await getSpec();
    await uploadSealedContent(spec, contentCtx.content, contentCtx.ownerSigs, {
      ref: contentHash,
      timestamp,
      identity: registrationIdentity(appUuid(spec.name, messageHASH)),
      owner: spec.owner,
      messageHash: messageHASH,
    });
  }

  // v9 only (envelope version 2). v8 enterprise messages are envelope
  // version 1, which old nodes still parse — they must not carry an unknown
  // arcaneAttestation key. v9 messages (version 2) are rejected by old nodes
  // before parsing, so the field only ever rides messages they ignore.
  let arcaneAttestation;
  if (signedEvent.requiresArcaneAttestation()) {
    arcaneAttestation = await appEventVerifier.requestAttestation(contentHash, broadcastBlob);
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
  // Record and gossip where this registration entered the network (best-effort).
  await ingressAttestationService.emit(messageHASH, await ingressCapture.captureIngress(req));
  await serviceHelper.delay(1200);
  await messageVerifier.requestAppMessage(messageHASH);
  await serviceHelper.delay(1200);
  // Held in the pool, or confirmed when the chain recorded the payment first.
  const heldMessage = async () => await appsRepository.getTempMessage(messageHASH)
    || appsRepository.getPermanentMessage(messageHASH);
  let tempMessage = await heldMessage();
  for (let i = 0; i < 20; i += 1) {
    if (!tempMessage) {
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.delay(500);
      // eslint-disable-next-line no-await-in-loop
      tempMessage = await heldMessage();
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
 * envelope seals { blobs: { hash: base64 }, manifest?, manifestPutSig?, keepList? };
 * contentRef blobs (declared in the immutable spec) upload here, and the AAD is
 * bound to the submission via
 * `ref` (the signed contentHash) so a captured envelope can't be replayed onto a
 * different submission. Any non-contentRef blobs belong to content-slot mounts and
 * are returned (with the manifest) for the slot path. Shared by register + update:
 * an update passes the spec it supersedes (priorSpec), whose contentRef hashes are
 * carried over — already stored under identical locators — so the envelope attaches
 * only new or changed files; a register has no prior and attaches everything.
 *
 * A manifest the envelope carries is verified against the spec submitted, for
 * the app's identity, and its slot blobs are uploaded. Its FluxDrive put, with the
 * slot locators it keeps, names the submission's message hash, so FluxDrive holds
 * it until the nodes answer that the message applied: a registration lists the
 * name, an update changes the spec the manifest is judged against. A
 * registration's manifest is stored as the app's and gossiped; an update's is
 * returned to ride in the update's message, held with it on every node and
 * stored when the update applies.
 *
 * An update that changes the content-ref files the app names sends FluxDrive the
 * owner-signed keep list the envelope carries, naming the submission's message
 * hash, so the files it drops are deleted once the update applies.
 *
 * @param {object} spec - resolved submission spec (name, owner, contentRef mounts)
 * @param {object} content - the sealed TransportEnvelope JSON
 * @param {Map} ownerSigs - per-blob owner signatures
 * @param {object} bind - { ref, timestamp, identity, owner, messageHash, priorSpec? } —
 *   transport AAD, the app's identity (a registration's from its message hash,
 *   an update's from the listed row), the owner who signs (the listed owner for
 *   an update: a transfer's carried manifest is the seller's), the submission's
 *   message hash, and the decrypted spec this update supersedes (absent on
 *   register)
 * @returns {Promise<{ payload: object, blobs: Map<string, Buffer>, carriedManifest: ?object }>}
 */
async function uploadSealedContent(spec, content, ownerSigs, {
  ref, timestamp, identity, owner, messageHash, priorSpec,
}) {
  if (typeof identity !== 'string' || !identity) throw new Error('uploadSealedContent: content is keyed by the identity of the app it is for');
  if (typeof messageHash !== 'string' || !messageHash) throw new Error('uploadSealedContent: a FluxDrive write names the hash of the message that carries it');
  const opened = await transportHelper.openContentEnvelope(content, {
    appName: spec.name, owner: spec.owner, ref, timestamp,
  });
  const payload = serviceHelper.ensureObject(opened.toString('utf8'));
  // Refused before anything reaches FluxDrive: a manifest without the owner's
  // FluxDrive signature over it, and an update that changes the content-ref files
  // without the owner's keep list.
  if (payload.manifest && !payload.manifestPutSig) {
    throw new Error('uploadSealedContent: a manifest carries the owner\'s FluxDrive signature over it (manifestPutSig)');
  }
  if (priorSpec) contentBlobService.assertKeepListCarried(spec, priorSpec, payload.keepList);
  const blobs = new Map(Object.entries(payload.blobs || {}).map(([h, b64]) => [h, Buffer.from(b64, 'base64')]));

  const refHashes = contentBlobService.specContentHashes(spec);
  const refBlobs = new Map([...blobs].filter(([h]) => refHashes.has(h)));
  await contentBlobService.encryptAndUploadBlobs({
    spec, identity, priorSpec, blobs: refBlobs, ownerSigs,
  }, { uploader: fluxDriveClient });

  // An update's FluxDrive writes are signed under the listed ownership: the
  // height the chain says the owner took the app. A registration's are signed
  // under 0, its height not existing yet.
  let ownedFrom = 0;
  let original = false;
  if (priorSpec && (payload.manifest || payload.keepList)) {
    const listed = manifestStanding.listedOwnership(await appHistory.ownerships(spec.name));
    if (!listed || listed.owner !== owner) throw new Error(`uploadSealedContent: ${spec.name} has no applied ownership for ${owner}`);
    ({ from: ownedFrom, original } = listed);
  }

  // An update that changes the content-ref files the app names hands FluxDrive
  // its keep list, naming this submission's message, so the files it drops are
  // deleted once the update applies.
  if (priorSpec) {
    await contentBlobService.sendKeepList({
      appName: spec.name, spec, priorSpec, identity, ownedFrom, keepList: payload.keepList, pendingMessageHash: messageHash,
    }, { uploader: fluxDriveClient });
  }

  // A slot app bundles its owner-signed manifest with the submission: upload the
  // slot blobs and hand the manifest, with the slot locators it keeps, to FluxDrive
  // naming this submission's message. A slot app always forces an encrypted spec (flux-spec
  // validation), so the slots payload is sealed.
  if (payload.manifest) {
    const slotHashes = new Set(Object.values(payload.manifest.slots || {}).map((s) => s.hash));
    const slotBlobs = new Map([...blobs].filter(([h]) => slotHashes.has(h)));
    const gossipManifest = await contentSlotService.processManifestSubmission(
      {
        manifest: payload.manifest, spec, owner, encrypted: true, identity, ownedFrom, original, blobs: slotBlobs, ownerSigs,
      },
      { uploader: fluxDriveClient },
    );
    // Best-effort, as every FluxDrive write is; the owner's signatures ride the
    // sealed payload (frontend-produced at submission). The first installing
    // instance has no peers, so FluxDrive is its only manifest source.
    await contentSlotService.backstopManifest(payload.manifest, gossipManifest, {
      appName: spec.name,
      identity,
      version: payload.manifest.version,
      timestamp: payload.manifest.timestamp,
      manifestPutSig: payload.manifestPutSig,
      pendingMessageHash: messageHash,
    }, {});
    if (priorSpec) return { payload, blobs, carriedManifest: gossipManifest };
    // A registration's manifest is gossiped so the network holds the slots'
    // starting content alongside the spec; every node, this one included, holds
    // it until the registration applies and judges it then. Broadcast first:
    // broadcastMessageToAll returns the exact signed node broadcast it relayed,
    // so the held row carries that same envelope (one signature) and is
    // boot-sync-servable to a fresh node.
    const signedBroadcast = await fluxCommunicationMessagesSender.broadcastMessageToAll({
      type: 'fluxappcontentmanifest', appName: spec.name, manifest: gossipManifest,
    });
    await contentSlotService.takeManifest(gossipManifest, { broadcast: signedBroadcast });
  }

  return { payload, blobs, carriedManifest: null };
}

/**
 * Multipart registration: parse the spec + sealed content envelope, gate content
 * uploads to arcane nodes, then run the shared submission flow with the content.
 */
async function handleMultipartAppRegister(req, res) {
  try {
    const authorized = await verificationHelper.verifyPrivilege(Privilege.USER, authOf(req));
    if (!authorized) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
      return;
    }
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

/**
 * Refuse a v7 component's secrets at the door by the rule the decider applies
 * (flux-spec `v7SecretsRefusal`): the same secrets never serve two apps, an
 * update keeps the secrets its own app carries now whoever it names as owner,
 * and secrets another owner used before are refused otherwise.
 */
async function assertSecretsNotConflicting(appName, componentName, secrets, owner, options = {}) {
  const { isRegistration = false } = options;
  const { v7SecretsRefusal } = await getSpec();
  const refusal = v7SecretsRefusal(
    {
      secrets, appName, owner, componentName, isRegistration,
    },
    { live: await appsRepository.listLiveV7Secrets(), earlier: await appsRepository.listHistoricalV7Secrets() },
  );
  if (refusal) throw new Error(`Provided component '${componentName}' secrets are not valid: ${refusal.message}`);
}

/** The slot names a spec's components declare. */
function declaredSlots(spec) {
  return Object.values(spec.components || {}).flatMap((component) => (
    component.persistentStorage?.getMountsWithContentSlot?.() ?? []
  ).map((mount) => mount.contentSlot));
}

/** The names of the slots an opened manifest holds. */
function slotNames(plaintext) {
  return Object.entries(plaintext?.slots || {}).filter(([, slot]) => slot && slot.hash).map(([name]) => name);
}

/**
 * The facts of the manifest an update stands on: the one it carries, else the
 * one standing for the app, asked of peers and FluxDrive when none stands.
 * Standing is judged against `app`, the app the update is judged against: the
 * listed one, or the state an expired app last held, whose manifest rows the
 * node keeps. Null when the spec declares no slot, or when there is still none.
 */
async function manifestFacts(spec, app, carriedManifest) {
  if (declaredSlots(spec).length === 0) return null;
  const { contentManifestHash } = await getSpec();
  if (carriedManifest) {
    const plaintext = await contentSlotService.openManifestSlots(carriedManifest, { encrypted: true });
    return {
      hash: contentManifestHash(plaintext),
      slots: slotNames(plaintext),
      ownedFrom: carriedManifest.ownedFrom,
      // the listed owner signs an update and the manifest it carries
      specOwnerSigned: app.owner === spec.owner,
    };
  }
  const judgedAgainst = { getApp: async () => app };
  let { row } = await manifestStanding.standingManifest(app.identity, judgedAgainst);
  if (!row) {
    await contentSlotService.refreshManifests(app.name, app.identity);
    ({ row } = await manifestStanding.standingManifest(app.identity, judgedAgainst));
  }
  if (!row) return null;
  const plaintext = await contentSlotService.openManifestSlots(row.manifest, { encrypted: true });
  return {
    hash: row.hash, slots: slotNames(plaintext), ownedFrom: row.ownedFrom, specOwnerSigned: row.signer === spec.owner,
  };
}

/**
 * Refuse an update that does not name what it stands on: the manifest of an
 * app declaring content slots, and each standing generation record, named in
 * the spec's `content` and `grants` blocks exactly when the owner the spec
 * names did not sign it in that owner's ownership (flux-spec
 * standingNamesRefusal). A sale names everything that stands.
 *
 * @param {object} spec - the cleartext update
 * @param {{name: string, identity: string, owner: string}} app - the app the update is judged
 *   against: the listed one, or the state an expired app last held
 * @param {{carriedManifest?: ?object}} [options] - the manifest the update carries, in its gossip form
 */
async function assertNamesWhatStands(spec, app, { carriedManifest = null } = {}) {
  const { standingNamesRefusal } = await getSpec();
  const listed = manifestStanding.listedOwnership(await appHistory.ownerships(app.name));
  const records = {};
  for (const role of ['master', 'founder']) {
    // eslint-disable-next-line no-await-in-loop -- two roles, read in turn
    const { record } = await messageStore.standingGeneration(app.identity, role);
    if (record) records[role] = { hash: record.hash, ownedFrom: record.data?.ownedFrom, specOwnerSigned: record.signer === spec.owner };
  }
  const manifest = await manifestFacts(spec, app, carriedManifest);
  const refusal = standingNamesRefusal(spec, { listed, manifest, records });
  if (refusal) throw new Error(`Flux App ${spec.name} update refused: ${refusal.message}`);
}

module.exports = {
  resolveSubmission,
  assertPlacementPrivileges,
  verifyAppRegistrationParameters,
  validateAppUpdate,
  verifyAppUpdateApi,
  registerAppGlobalyApi,
  parseMultipartSubmission,
  uploadSealedContent,
  assertSecretsNotConflicting,
  assertNamesWhatStands,
};
