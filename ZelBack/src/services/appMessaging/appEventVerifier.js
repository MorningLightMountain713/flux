const config = require('config');
const { getSpec, getSpecBackend } = require('../utils/specLibs');
const signatureVerifier = require('../signatureVerifier');
const { getChainTeamSupportAddressUpdates } = require('../utils/chainUtilities');

async function deserializeMessage(message) {
  const { AppEventLegacy, ConfirmedAppEvent } = await getSpecBackend();
  if (message.version === 2) {
    return ConfirmedAppEvent.deserialize(message);
  }
  return AppEventLegacy.deserialize(message);
}

async function verifyFn(payload, address, signature) {
  return signatureVerifier.verifySignature(payload, address, signature);
}

function isMarketplaceApp(appName) {
  if (!appName) return false;
  const nums = appName.match(/\d+/g);
  if (!nums) return false;
  const epoch2020 = Date.parse('2020-01-01');
  return nums.some((n) => Number(n) > epoch2020);
}

function resolveTeamSupportAddress(daemonHeight) {
  const intervals = getChainTeamSupportAddressUpdates().filter(
    (entry) => entry.height <= daemonHeight,
  );
  if (intervals.length === 0) return null;
  return intervals[intervals.length - 1].address;
}

async function instantiatePreviousSpec(rawSpec) {
  if (!rawSpec || typeof rawSpec.version !== 'number') return null;
  await getSpecBackend();
  const { FluxAppSpecBase } = await getSpec();
  const VersionClass = FluxAppSpecBase.getVersionClass(rawSpec.version);
  if (!VersionClass) return null;
  return VersionClass.deserialize(rawSpec);
}

async function authorize({
  appEvent, previousSpec, daemonHeight, verifyHash = true,
}) {
  if (verifyHash) {
    const hashResult = appEvent.verifyHash();
    if (!hashResult.valid) {
      throw new Error('Invalid Flux App hash received');
    }
  }

  const signers = [appEvent.spec.owner];

  if (appEvent.isUpdate && previousSpec) {
    if (previousSpec.owner && previousSpec.owner !== appEvent.spec.owner) {
      signers.push(previousSpec.owner);
    }
    const teamSupport = resolveTeamSupportAddress(daemonHeight);
    if (teamSupport && isMarketplaceApp(appEvent.spec.name)) {
      signers.push(teamSupport);
    }
  }

  let result = await appEvent.verifySignature(verifyFn, signers);
  if (result.valid) return result;

  if (appEvent.isUpdate && previousSpec) {
    const { UpdatePolicy } = await getSpec();
    if (UpdatePolicy.isTtlOnlyUpdate(previousSpec, appEvent.spec)) {
      const usersToExtend = (config.fluxapps && config.fluxapps.usersToExtend) || [];
      if (usersToExtend.length > 0) {
        result = await appEvent.verifySignature(verifyFn, usersToExtend);
        if (result.valid) return result;
      }
    }
  }

  throw new Error(
    'Received signature does not correspond with Flux App owner or Flux App specifications are not properly formatted',
  );
}

async function computeOutboundHash({
  type, envelopeVersion, specBlob, contentHash, timestamp, signature,
}) {
  const backend = await getSpecBackend();
  if (envelopeVersion === 2) {
    if (!contentHash) {
      throw new Error('computeOutboundHash: envelope v2 requires contentHash');
    }
    return backend.computeMessageHashV2(type, envelopeVersion, contentHash, timestamp, signature);
  }
  if (!specBlob) {
    throw new Error('computeOutboundHash: envelope v1 requires specBlob');
  }
  return backend.computeMessageHash(type, envelopeVersion, specBlob, timestamp, signature);
}

module.exports = {
  deserializeMessage,
  authorize,
  instantiatePreviousSpec,
  computeOutboundHash,
  _internal: {
    isMarketplaceApp,
    resolveTeamSupportAddress,
    verifyFn,
  },
};
