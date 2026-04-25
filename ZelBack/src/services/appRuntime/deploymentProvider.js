/**
 * Domain service: storage → operational view.
 *
 * Reads InstantiatedSpec from the repository, decrypts enterprise specs
 * transparently, and returns DeploymentSpec — the Docker-ready projection.
 * Cleartext FluxAppSpecBase is transient; it never leaves this module.
 */

const appsRepository = require('../appDatabase/appsRepository');
const legacyCryptoProvider = require('../providers/FluxOSLegacyCryptoProvider');
const fluxCaching = require('../utils/cacheManager');
const { appsFolder } = require('../utils/appConstants');
const { getSpecBackend } = require('../utils/specLibs');
const log = require('../../lib/log');

async function toCleartextSpec(instantiated) {
  if (!instantiated.isEncrypted()) return instantiated.spec;

  const cache = fluxCaching.default.enterpriseAppDecryptionCache;
  const cacheKey = instantiated.hash;
  const cached = cache.get(cacheKey);
  if (cached) {
    log.info(`Using cached decrypted app for ${instantiated.name} (${cacheKey})`);
    return cached;
  }

  const provider = await legacyCryptoProvider.create(instantiated.name, instantiated.owner);
  const canonical = await instantiated.spec.decrypt(provider);
  cache.set(cacheKey, canonical.spec);
  log.info(`Cached decrypted app for ${instantiated.name} (${cacheKey})`);
  return canonical.spec;
}

async function toDeployment(instantiated) {
  const spec = await toCleartextSpec(instantiated);
  const { DeploymentSpec } = await getSpecBackend();
  return DeploymentSpec.fromSpec(spec, appsFolder);
}

async function listInstalledDeployments() {
  const installed = await appsRepository.listInstalledApps();
  const deployments = [];
  for (const inst of installed) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const deployment = await toDeployment(inst);
      deployments.push(deployment);
    } catch (err) {
      log.error(`deploymentProvider: failed to build deployment for ${inst.name}: ${err.message}`);
    }
  }
  return deployments;
}

async function getInstalledDeployment(name) {
  const inst = await appsRepository.getInstalledApp(name);
  if (!inst) return null;
  try {
    return await toDeployment(inst);
  } catch (err) {
    log.error(`deploymentProvider: failed to build deployment for ${name}: ${err.message}`);
    return null;
  }
}

module.exports = {
  listInstalledDeployments,
  getInstalledDeployment,
  buildDeployment: toDeployment,
};
