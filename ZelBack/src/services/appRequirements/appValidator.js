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
// const advancedWorkflows = require('../appLifecycle/advancedWorkflows'); // Moved to dynamic require to avoid circular dependency
// eslint-disable-next-line no-unused-vars
const { supportedArchitectures, enterpriseRequiredArchitectures } = require('../utils/appConstants');
const { specificationFormatter, findCommonArchitectures } = require('../utils/appUtilities');
const { checkAndDecryptAppSpecs } = require('../utils/enterpriseHelper');
const { peerManager } = require('../utils/peerState');
const { getSpec, getSpecBackend } = require('../utils/specLibs');

const isArcane = Boolean(process.env.FLUXOS_PATH);


/**
 * Main validation function for application specifications
 * Validates specs including hardware requirements, architecture compatibility, and Docker compliance
 * @param {object} appSpecifications - Application specifications to validate
 * @param {number} height - Block height for validation context
 * @param {boolean} checkDockerAndWhitelist - Whether to check Docker, whitelist, and architecture requirements
 * @returns {Promise<boolean>} True if validation passes
 * @throws {Error} If validation fails (e.g., incompatible architectures, missing requirements)
 */
async function verifyAppSpecifications(appSpecifications, height, checkDockerAndWhitelist = false) {
  // Spec shape, type, and semantic checks all happen inside the spec
  // class's fromSubmission — schema validation (v9), fillDefaults,
  // constructor invariants, validateSemantics (port uniqueness, cycle
  // detection, reserved names, duration ranges, resource caps, ...).
  // We only layer FluxOS-level policy on top: fork-activation height,
  // HW tier caps, Docker registry checks.
  await getSpecBackend(); // register v1-v8 classes into the shared version registry
  const { FluxAppSpecBase } = await getSpec();
  const VersionClass = appSpecifications
    && FluxAppSpecBase.getVersionClass(appSpecifications.version);
  if (!VersionClass) {
    throw new Error(`Unsupported Flux App specification version: ${appSpecifications && appSpecifications.version}`);
  }

  if (height < config.fluxapps.appSpecsEnforcementHeights[appSpecifications.version]) {
    throw new Error(`Flux apps specifications of version ${appSpecifications.version} not yet supported`);
  }

  try {
    VersionClass.fromSubmission(appSpecifications);
  } catch (err) {
    if (err.code === 'VALIDATION_ERROR' && Array.isArray(err.errors) && err.errors.length > 0) {
      const first = err.errors[0];
      const path = first.field ? `${first.field}: ` : '';
      throw new Error(`${path}${first.message}`);
    }
    throw err;
  }

  // Docker registry, blocked repos, architecture compatibility.
  // Deferred to caller opt-in because the registry probes are slow and
  // only meaningful on the user-submission path (not on peer-relay).
  if (checkDockerAndWhitelist) {
    // check blacklist
    await imageManager.checkApplicationImagesCompliance(appSpecifications);

    // Architecture validation - collect architectures during verification
    const componentArchitectures = [];

    if (appSpecifications.version <= 3) {
      // check repository whitelisted and repotag is available for download
      const result = await imageManager.verifyRepository(appSpecifications.repotag);
      componentArchitectures.push({
        name: appSpecifications.name,
        repotag: appSpecifications.repotag,
        architectures: result.supportedArchitectures,
      });
    } else {
      // eslint-disable-next-line no-restricted-syntax
      for (const appComponent of appSpecifications.compose) {
        // For v7 enterprise apps, skip verification because repoauth is PGP-encrypted
        // and only selected nodes have the private keys to decrypt it.
        // For v8+, repoauth is plain text (already decrypted from enterprise blob),
        // so we can and should verify the repository.
        const skipVerification = appSpecifications.version === 7 && appComponent.repoauth;

        // fail open
        if (skipVerification) return true;

        // check repository whitelisted and repotag is available for download
        // eslint-disable-next-line no-await-in-loop
        const result = await imageManager.verifyRepository(appComponent.repotag, {
          repoauth: appComponent.repoauth,
          specVersion: appSpecifications.version,
          appName: appSpecifications.name,
        });

        componentArchitectures.push({
          name: appComponent.name,
          repotag: appComponent.repotag,
          architectures: result.supportedArchitectures,
        });
      }

      // Validate architecture requirements across all components
      const isEnterpriseArcane = appSpecifications.version >= 8 && appSpecifications.enterprise;

      if (isEnterpriseArcane) {
        // Enterprise Arcane apps (v8+) must support required architectures on ALL components (Arcane nodes are amd64-only)
        const componentsWithoutRequiredArchs = componentArchitectures.filter(
          (comp) => !enterpriseRequiredArchitectures.every((arch) => comp.architectures.includes(arch)),
        );

        if (componentsWithoutRequiredArchs.length > 0) {
          const componentNames = componentsWithoutRequiredArchs.map((c) => `${c.name} (${c.repotag})`).join(', ');
          throw new Error(
            `Enterprise application '${appSpecifications.name}' must support ${enterpriseRequiredArchitectures.join(', ')} `
            + `architecture on ALL components. The following components do not support ${enterpriseRequiredArchitectures.join(', ')}: ${componentNames}. `
            + `Arcane nodes are amd64-only.`,
          );
        }
      } else {
        // Non-enterprise apps: must have at least ONE common architecture across all components
        const commonArchitectures = findCommonArchitectures(componentArchitectures);

        if (commonArchitectures.length === 0) {
          const details = componentArchitectures
            .map((c) => `  - ${c.name} (${c.repotag}): ${c.architectures.join(', ') || 'none'}`)
            .join('\n');
          throw new Error(
            `Application '${appSpecifications.name}' components do not share a common architecture. `
            + `All components must support at least one common architecture (${supportedArchitectures.join(' or ')}). `
            + `Component architectures:\n${details}`,
          );
        }
      }
    }
  }

  return true;
}

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

      // Decrypt enterprise specifications if needed
      const appSpecDecrypted = await checkAndDecryptAppSpecs(
        appSpecification,
        {
          daemonHeight,
          owner: appSpecification.owner,
        },
      );

      const appSpecFormatted = specificationFormatter(appSpecDecrypted);

      // parameters are now proper format and assigned. Check for their validity, if they are within limits, have propper ports, repotag exists, string lengths, specs are ok
      await verifyAppSpecifications(appSpecFormatted, daemonHeight, true);

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

  const decryptedSpecs = await checkAndDecryptAppSpecs(appSpecification, { daemonHeight });

  const appSpecFormatted = specificationFormatter(decryptedSpecs);

  await verifyAppSpecifications(appSpecFormatted, daemonHeight, true);

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
  verifyAppSpecifications,
  verifyAppRegistrationParameters,
  validateAppUpdate,
  verifyAppUpdateApi,
};
