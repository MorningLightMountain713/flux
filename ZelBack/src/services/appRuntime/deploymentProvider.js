const appsRepository = require('../appDatabase/appsRepository');
const { appsFolder } = require('../utils/appConstants');
const { getSpecBackend } = require('../utils/specLibs');
const { resolveInstantiatedSpec } = require('../utils/specCutover');
const log = require('../../lib/log');

async function toDeployment(instantiated) {
  const resolved = await resolveInstantiatedSpec(instantiated);
  if (!resolved) throw new Error(`Could not resolve spec for ${instantiated.name}`);

  // Encrypted apps resolve to a DecryptedCanonicalSpec; DeploymentSpec projects
  // from the real spec instance it wraps (its guard rejects a still-sealed spec).
  const runtimeSpec = instantiated.isEncrypted ? resolved.spec : resolved;

  const { DeploymentSpec } = await getSpecBackend();
  return DeploymentSpec.fromSpec(runtimeSpec, appsFolder);
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
