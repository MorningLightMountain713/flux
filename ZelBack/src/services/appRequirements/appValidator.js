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
const imageManager = require('../appSecurity/imageManager');
const { supportedArchitectures, enterpriseRequiredArchitectures } = require('../utils/appConstants');
const { specificationFormatter, findCommonArchitectures } = require('../utils/appUtilities');
const { checkAndDecryptAppSpecs } = require('../utils/enterpriseHelper');
const { validateSubmissionSpec } = require('../utils/specLibs');
const appsRepository = require('../appDatabase/appsRepository');
const portManager = require('../appNetwork/portManager');
const { peerManager } = require('../utils/peerState');

const isArcane = Boolean(process.env.FLUXOS_PATH);

async function verifyAppSpecifications(appSpecifications, height, checkDockerAndWhitelist = false) {
  await validateSubmissionSpec(appSpecifications, { height });

  portManager.ensureAppUniquePorts(appSpecifications);

  if (checkDockerAndWhitelist) {
    await imageManager.checkApplicationImagesCompliance(appSpecifications);

    const componentArchitectures = [];

    if (appSpecifications.version <= 3) {
      const result = await imageManager.verifyRepository(appSpecifications.repotag);
      componentArchitectures.push({
        name: appSpecifications.name,
        repotag: appSpecifications.repotag,
        architectures: result.supportedArchitectures,
      });
    } else {
      for (const appComponent of appSpecifications.compose) {
        const skipVerification = appSpecifications.version === 7 && appComponent.repoauth;
        if (skipVerification) return true;

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

      const isEnterpriseArcane = appSpecifications.version >= 8 && appSpecifications.enterprise;

      if (isEnterpriseArcane) {
        const missing = componentArchitectures.filter(
          (comp) => !enterpriseRequiredArchitectures.every((arch) => comp.architectures.includes(arch)),
        );
        if (missing.length > 0) {
          const names = missing.map((c) => `${c.name} (${c.repotag})`).join(', ');
          throw new Error(
            `Enterprise application '${appSpecifications.name}' must support ${enterpriseRequiredArchitectures.join(', ')} `
            + `architecture on ALL components. The following components do not support ${enterpriseRequiredArchitectures.join(', ')}: ${names}. `
            + `Arcane nodes are amd64-only.`,
          );
        }
      } else if (componentArchitectures.length > 1) {
        const common = findCommonArchitectures(componentArchitectures);
        if (common.length === 0) {
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

      const appSpecDecrypted = await checkAndDecryptAppSpecs(
        appSpecification,
        {
          daemonHeight,
          owner: appSpecification.owner,
        },
      );

      const appSpecFormatted = specificationFormatter(appSpecDecrypted);

      await verifyAppSpecifications(appSpecFormatted, daemonHeight, true);

      if (appSpecFormatted.version === 7 && appSpecFormatted.nodes.length > 0) {
        for (const appComponent of appSpecFormatted.compose) {
          if (appComponent.secrets) {
            // eslint-disable-next-line no-await-in-loop
            await imageManager.checkAppSecrets(appSpecFormatted.name, appComponent, appSpecFormatted.owner, true);
          }
        }
      }

      await registryManager.checkApplicationRegistrationNameConflicts(appSpecFormatted);

      if (isEnterprise) {
        appSpecFormatted.contacts = [];
        appSpecFormatted.compose = [];
      }

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
    for (const appComponent of appSpecFormatted.compose) {
      if (appComponent.secrets) {
        // eslint-disable-next-line no-await-in-loop
        await imageManager.checkAppSecrets(appSpecFormatted.name, appComponent, appSpecFormatted.owner, false);
      }
    }
  }

  const timestamp = Date.now();
  // eslint-disable-next-line global-require
  const advancedWorkflows = require('../appLifecycle/advancedWorkflows');
  const previousAppSpecs = await advancedWorkflows.getPreviousAppSpecifications(appSpecFormatted, timestamp);
  if (!previousAppSpecs) {
    throw new Error(`Flux App ${appSpecFormatted.name} does not exist and cannot be updated`);
  }

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
      let messageType = processedBody.type;
      let typeVersion = processedBody.version;

      if (!appSpecification || !timestamp || !signature || !messageType || !typeVersion) {
        throw new Error('Incomplete message received. Check if appSpecification, type, version, timestamp and signature are provided.');
      }

      if (messageType !== 'zelappregister' && messageType !== 'fluxappregister') {
        throw new Error('Invalid type of message');
      }

      if (typeVersion !== 1) {
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

      const appSpecDecrypted = await checkAndDecryptAppSpecs(
        appSpecification,
        {
          daemonHeight,
          owner: appSpecification.owner,
        },
      );

      const appSpecFormatted = specificationFormatter(appSpecDecrypted);

      await verifyAppSpecifications(appSpecFormatted, daemonHeight, true);

      if (appSpecFormatted.version === 7 && appSpecFormatted.nodes.length > 0) {
        for (const appComponent of appSpecFormatted.compose) {
          if (appComponent.secrets) {
            // eslint-disable-next-line no-await-in-loop
            await imageManager.checkAppSecrets(appSpecFormatted.name, appComponent, appSpecFormatted.owner, true);
          }
        }
      }

      await registryManager.checkApplicationRegistrationNameConflicts(appSpecFormatted);

      const isEnterprise = Boolean(
        appSpecification.version >= 8 && appSpecification.enterprise,
      );

      const broadcastSpecBlob = isEnterprise
        ? specificationFormatter(appSpecification)
        : appSpecFormatted;

      const signedEvent = await appEventVerifier.deserializeMessage({
        type: messageType,
        version: typeVersion,
        appSpecifications: broadcastSpecBlob,
        timestamp,
        signature,
      });
      await appEventVerifier.authorize({
        appEvent: signedEvent,
        daemonHeight,
        verifyHash: false,
      });

      if (isEnterprise) {
        appSpecFormatted.contacts = [];
        appSpecFormatted.compose = [];
      }

      const messageHASH = await appEventVerifier.computeOutboundHash({
        type: messageType,
        envelopeVersion: typeVersion,
        specBlob: broadcastSpecBlob,
        timestamp,
        signature,
      });

      const temporaryAppMessage = {
        type: messageType,
        version: typeVersion,
        appSpecifications: appSpecFormatted,
        hash: messageHASH,
        timestamp,
        signature,
        arcaneSender: isArcane,
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
  verifyAppSpecifications,
  verifyAppRegistrationParameters,
  validateAppUpdate,
  verifyAppUpdateApi,
  registerAppGlobalyApi,
  assertSecretsNotConflicting,
};
