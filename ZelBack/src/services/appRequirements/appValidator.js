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
const { validateSubmissionSpec, getSpec } = require('../utils/specLibs');
const { decryptToCleartextClass, deserializeSpec, toCanonicalSpec } = require('../utils/specCutover');

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

      const cleartextSpec = await decryptToCleartextClass(appSpecification);
      if (!cleartextSpec) throw new Error('Could not deserialize app specifications');
      const appSpecFormatted = cleartextSpec.serialize();

      await validateSubmissionSpec(appSpecFormatted, { height: daemonHeight });
      await verifyImageRegistryAndArchitectures(appSpecFormatted);

      if (cleartextSpec.version === 7 && cleartextSpec.nodes && cleartextSpec.nodes.length > 0) {
        for (const appComponent of appSpecFormatted.compose || []) {
          if (appComponent.secrets) {
            // eslint-disable-next-line no-await-in-loop
            await imageManager.checkAppSecrets(cleartextSpec.name, appComponent, cleartextSpec.owner, true);
          }
        }
      }

      await registryManager.checkApplicationRegistrationNameConflicts(appSpecFormatted);

      const responseSpec = isEnterprise ? await toCanonicalSpec(appSpecification) : appSpecFormatted;
      const respondPrice = messageHelper.createDataMessage(responseSpec);
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

  const updateSpec = await decryptToCleartextClass(appSpecification);
  if (!updateSpec) throw new Error('Could not deserialize app specifications');
  const appSpecFormatted = updateSpec.serialize();

  await validateSubmissionSpec(appSpecFormatted, { height: daemonHeight });
  await verifyImageRegistryAndArchitectures(appSpecFormatted);

  if (updateSpec.version === 7 && updateSpec.nodes && updateSpec.nodes.length > 0) {
    for (const appComponent of appSpecFormatted.compose || []) {
      if (appComponent.secrets) {
        // eslint-disable-next-line no-await-in-loop
        await imageManager.checkAppSecrets(updateSpec.name, appComponent, updateSpec.owner, false);
      }
    }
  }

  const timestamp = Date.now();
  // eslint-disable-next-line global-require
  const { getPreviousAppSpecifications } = require('../appDatabase/appSpecHistory');
  const previousAppSpecs = await getPreviousAppSpecifications(appSpecFormatted, timestamp);
  if (!previousAppSpecs) {
    throw new Error(`Flux App ${updateSpec.name} does not exist and cannot be updated`);
  }

  const { latestSupportedSpecVersion } = config.fluxapps;
  if (previousAppSpecs.version !== updateSpec.version && updateSpec.version !== latestSupportedSpecVersion) {
    throw new Error(
      `Application update rejected: Version changes are only allowed when updating to version ${latestSupportedSpecVersion} (current latest supported version). `
      + `Current version: ${previousAppSpecs.version}, Attempted version: ${updateSpec.version}. `
      + `To update this application, please use version ${latestSupportedSpecVersion} specifications.`,
    );
  }

  const { UpdatePolicy } = await getSpec();
  UpdatePolicy.assertCompatible(previousAppSpecs, updateSpec);

  if (isEnterprise) {
    const wireForm = await toCanonicalSpec(appSpecification);
    return wireForm;
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
