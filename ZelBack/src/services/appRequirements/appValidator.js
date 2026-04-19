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
const imageManager = require('../appSecurity/imageManager');
const { verifyImageRegistryAndArchitectures } = require('../appSecurity/imageArchitectureValidator');
const { peerManager } = require('../utils/peerState');
const { validateSubmissionSpec } = require('../utils/specLibs');
const { decryptIfEnterprise, toCanonicalSpec } = require('../utils/specCutover');

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

      const isEnterprise = Boolean(
        appSpecification.version >= 8 && appSpecification.enterprise,
      );

      const appSpecDecrypted = await decryptIfEnterprise(appSpecification);
      const appSpecFormatted = await toCanonicalSpec(appSpecDecrypted);

      await validateSubmissionSpec(appSpecFormatted, { height: daemonHeight });
      await verifyImageRegistryAndArchitectures(appSpecFormatted);

      if (appSpecFormatted.version === 7 && appSpecFormatted.nodes.length > 0) {
        // eslint-disable-next-line no-restricted-syntax
        for (const appComponent of appSpecFormatted.compose) {
          if (appComponent.secrets) {
            // eslint-disable-next-line no-await-in-loop
            await imageManager.checkAppSecrets(appSpecFormatted.name, appComponent, appSpecFormatted.owner, true);
          }
        }
      }

      // check if name is not yet registered
      await registryManager.checkApplicationRegistrationNameConflicts(appSpecFormatted);

      if (isEnterprise) {
        appSpecFormatted.contacts = [];
        appSpecFormatted.compose = [];
      }

      // app is valid and can be registered
      // respond with formatted specifications
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

  const isEnterprise = Boolean(
    appSpecification.version >= 8 && appSpecification.enterprise,
  );

  const decryptedSpecs = await decryptIfEnterprise(appSpecification);
  const appSpecFormatted = await toCanonicalSpec(decryptedSpecs);

  await validateSubmissionSpec(appSpecFormatted, { height: daemonHeight });
  await verifyImageRegistryAndArchitectures(appSpecFormatted);

  if (appSpecFormatted.version === 7 && appSpecFormatted.nodes.length > 0) {
    // eslint-disable-next-line no-restricted-syntax
    for (const appComponent of appSpecFormatted.compose) {
      if (appComponent.secrets) {
        // eslint-disable-next-line no-await-in-loop
        await imageManager.checkAppSecrets(appSpecFormatted.name, appComponent, appSpecFormatted.owner, false);
      }
    }
  }

  // Validate update compatibility with previous version
  const timestamp = Date.now();
  // Dynamic require to avoid circular dependency
  // eslint-disable-next-line global-require
  const advancedWorkflows = require('../appLifecycle/advancedWorkflows');
  const previousAppSpecs = await advancedWorkflows.getPreviousAppSpecifications(appSpecFormatted, timestamp);
  if (!previousAppSpecs) {
    throw new Error(`Flux App ${appSpecFormatted.name} does not exist and cannot be updated`);
  }

  // Enforce version upgrade policy: new updates must target the latest supported spec version
  const { latestSupportedSpecVersion } = config.fluxapps;
  if (previousAppSpecs.version !== appSpecFormatted.version && appSpecFormatted.version !== latestSupportedSpecVersion) {
    throw new Error(
      `Application update rejected: Version changes are only allowed when updating to version ${latestSupportedSpecVersion} (current latest supported version). `
      + `Current version: ${previousAppSpecs.version}, Attempted version: ${appSpecFormatted.version}. `
      + `To update this application, please use version ${latestSupportedSpecVersion} specifications.`,
    );
  }

  await advancedWorkflows.validateApplicationUpdateCompatibility(appSpecFormatted, previousAppSpecs);

  if (isEnterprise) {
    appSpecFormatted.contacts = [];
    appSpecFormatted.compose = [];
  }

  return appSpecFormatted;
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
      const appSpecFormatted = await validateAppUpdate(appSpecification);
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


module.exports = {
  verifyAppRegistrationParameters,
  validateAppUpdate,
  verifyAppUpdateApi,
};
