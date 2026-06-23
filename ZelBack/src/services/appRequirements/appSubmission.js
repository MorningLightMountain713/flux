const config = require('config');
const serviceHelper = require('../serviceHelper');
const messageHelper = require('../messageHelper');
const log = require('../../lib/log');
const generalService = require('../generalService');
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
const cryptoProvider = require('../providers/FluxOSCryptoProvider');
const appsRepository = require('../appDatabase/appsRepository');
const entitlementsState = require('../entitlementsState');
const marketplaceTemplateCache = require('../marketplace/marketplaceTemplateCache');
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

  // STAGE 4 — feature entitlements gate (v9 only): reject gated features the
  // owner's on-chain policy groups do not grant at this height.
  const cleartextSpec = spec.spec || spec;
  if (cleartextSpec.version === 9 && typeof cleartextSpec.toCanonical === 'function') {
    await entitlementsState.assertSpecEntitled(cleartextSpec, spec.owner, daemonHeight, isEncrypted);
    await assertMatchesMarketplaceTemplate(cleartextSpec);
  }

  // STAGE 5 — wire form for broadcast/storage; never cleartext for encrypted apps
  let broadcastBlob;
  if (wasTransportEncrypted) {
    // v9 transport submission — backend-encrypt the validated cleartext for storage
    const { EncryptedSpecV9 } = await getSpecBackend();
    const backendProvider = await cryptoProvider.create(spec.name, spec.owner);
    const encryptedSpec = await EncryptedSpecV9.fromSpec(spec, backendProvider);
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
  let body = '';
  req.on('data', (data) => {
    body += data;
  });
  req.on('end', async () => {
    try {
      const processedBody = serviceHelper.ensureObject(body);
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
  });
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
  if (previousSpec.version !== spec.version && spec.version !== latestSupportedSpecVersion) {
    throw new Error(
      `Application update rejected: Version changes are only allowed when updating to version ${latestSupportedSpecVersion} (current latest supported version). `
      + `Current version: ${previousSpec.version}, Attempted version: ${spec.version}. `
      + `To update this application, please use version ${latestSupportedSpecVersion} specifications.`,
    );
  }

  return broadcastBlob;
}

async function verifyAppUpdateApi(req, res) {
  let body = '';
  req.on('data', (data) => {
    body += data;
  });
  req.on('end', async () => {
    try {
      const processedBody = serviceHelper.ensureObject(serviceHelper.ensureObject(body));
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
  });
}

async function registerAppGlobalyApi(req, res) {
  let body = '';
  req.on('data', (data) => {
    body += data;
  });
  req.on('end', async () => {
    try {
      const authorized = await verificationHelper.verifyPrivilege('user', req);
      if (!authorized) {
        const errMessage = messageHelper.errUnauthorizedMessage();
        res.json(errMessage);
        return;
      }

      if (peerManager.outboundCount < config.fluxapps.minOutgoing) {
        throw new Error('Sorry, This Flux does not have enough outgoing peers for safe application registration');
      }
      if (peerManager.inboundCount < config.fluxapps.minIncoming) {
        throw new Error('Sorry, This Flux does not have enough incoming peers for safe application registration');
      }

      const processedBody = serviceHelper.ensureObject(body);
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
      if (typeVersion === 2 && signedEvent.isEncrypted) {
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
    } catch (error) {
      log.warn(error);
      const errorResponse = messageHelper.createErrorMessage(
        error.message || error,
        error.name,
        error.code,
      );
      res.json(errorResponse);
    }
  });
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
  assertSecretsNotConflicting,
};
