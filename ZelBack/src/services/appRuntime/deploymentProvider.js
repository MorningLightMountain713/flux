const appsRepository = require('../appDatabase/appsRepository');
const { appsFolder } = require('../utils/appConstants');
const { getSpecBackend } = require('../utils/specLibs');
const { resolveSpec } = require('../utils/specCutover');
const log = require('../../lib/log');

async function toDeployment(instantiated) {
  const spec = instantiated.isEncrypted()
    ? await resolveSpec(instantiated.serialize())
    : instantiated.spec;

  if (!spec) throw new Error(`Could not resolve spec for ${instantiated.name}`);

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
