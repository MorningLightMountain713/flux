const config = require('config');
const serviceHelper = require('../serviceHelper');
const messageHelper = require('../messageHelper');
const log = require('../../lib/log');
const generalService = require('../generalService');
const verificationHelper = require('../verificationHelper');
const daemonServiceMiscRpcs = require('../daemonService/daemonServiceMiscRpcs');
const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');
const messageVerifier = require('../appMessaging/messageVerifier');
const imageManager = require('../appSecurity/imageManager');
const { verifyImageRegistryAndArchitectures } = require('../appSecurity/imageArchitectureValidator');
const appsRepository = require('../appDatabase/appsRepository');
const { peerManager } = require('../utils/peerState');
const { validateSubmissionSpec, getSpec } = require('../utils/specLibs');
const { toCanonicalSpec } = require('../utils/specCutover');

/**
 * Verify app registration parameters via API
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @returns {Promise<void>} Validation result
 */
async function verifyAppRegistrationParameters(req, res) {
  let body = '';
  req.on('data', (data) => {
    body += data;
  });
  req.on('end', async () => {
    try {
      const appSpecification = serviceHelper.ensureObject(body);

      const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
      if (!syncStatus.data.synced) {
        throw new Error('Daemon not yet synced.');
      }
      const daemonHeight = syncStatus.data.height;

      let spec = await validateSubmissionSpec(appSpecification, { height: daemonHeight });
      const isEnterprise = spec.isEncrypted;
      if (isEnterprise) {
        const provider = await spec.createProvider();
        spec = await spec.decrypt(provider);
      }

      await verifyImageRegistryAndArchitectures(spec, { owner: spec.owner });

      for (const { componentName, secrets } of spec.getComponentSecrets()) {
        // eslint-disable-next-line no-await-in-loop
        await assertSecretsNotConflicting(spec.name, componentName, secrets, spec.owner, { isRegistration: true });
      }

      await appsRepository.assertNoNameConflicts(spec.name);

      const responseSpec = isEnterprise ? await toCanonicalSpec(appSpecification) : spec.serialize();
      res.json(messageHelper.createDataMessage(responseSpec));
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

/**
 * Verify app update parameters via API
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @returns {Promise<void>} Validation result
 */
/**
 * Validate app update specifications against current state.
 * Business logic only — no HTTP concerns.
 * @param {object} appSpecification - The app specification to validate
 * @returns {Promise<object>} Formatted and validated app specifications
 */
async function validateAppUpdate(appSpecification) {
  const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
  if (!syncStatus.data.synced) {
    throw new Error('Daemon not yet synced.');
  }
  const daemonHeight = syncStatus.data.height;

  let spec = await validateSubmissionSpec(appSpecification, { height: daemonHeight });
  if (spec.isEncrypted) {
    const provider = await spec.createProvider();
    spec = await spec.decrypt(provider);
  }

  await verifyImageRegistryAndArchitectures(spec, { owner: spec.owner });

  for (const { componentName, secrets } of spec.getComponentSecrets()) {
    // eslint-disable-next-line no-await-in-loop
    await assertSecretsNotConflicting(spec.name, componentName, secrets, spec.owner);
  }

  const timestamp = Date.now();
  // eslint-disable-next-line global-require
  const { getPreviousAppSpecifications } = require('../appDatabase/appSpecHistory');
  const previousAppSpecs = await getPreviousAppSpecifications(spec, timestamp);
  if (!previousAppSpecs) {
    throw new Error(`Flux App ${spec.name} does not exist and cannot be updated`);
  }

  const { latestSupportedSpecVersion } = config.fluxapps;
  if (previousAppSpecs.version !== spec.version && spec.version !== latestSupportedSpecVersion) {
    throw new Error(
      `Application update rejected: Version changes are only allowed when updating to version ${latestSupportedSpecVersion} (current latest supported version). `
      + `Current version: ${previousAppSpecs.version}, Attempted version: ${spec.version}. `
      + `To update this application, please use version ${latestSupportedSpecVersion} specifications.`,
    );
  }

  const { UpdatePolicy } = await getSpec();
  UpdatePolicy.assertCompatible(previousAppSpecs, spec);

  return spec;
}

/**
 * API endpoint to verify app update parameters
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
async function verifyAppUpdateApi(req, res) {
  let body = '';
  req.on('data', (data) => {
    body += data;
  });
  req.on('end', async () => {
    try {
      const appSpecification = serviceHelper.ensureObject(serviceHelper.ensureObject(body));
      const spec = await validateAppUpdate(appSpecification);
      const isEnterprise = Boolean(appSpecification.version >= 8 && appSpecification.enterprise);
      const responseSpec = isEnterprise ? await toCanonicalSpec(appSpecification) : spec.serialize();
      res.json(messageHelper.createDataMessage(responseSpec));
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
  verifyAppRegistrationParameters,
  validateAppUpdate,
  verifyAppUpdateApi,
  assertSecretsNotConflicting,
};
