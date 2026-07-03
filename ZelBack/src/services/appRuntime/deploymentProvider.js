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

/**
 * The DECRYPTED link view of an app — the bridge from the sealed vantage
 * (InstantiatedSpec.linkedAppNames() reports [] for an encrypted spec) to the
 * real links, so the network graph (reap/cascade/suppression) sees an encrypted
 * consumer's edges the convergence already acts on. Plaintext short-circuits to
 * the sealed accessor (no decryption needed). Encrypted crosses through the
 * decrypt provider and reads the SAME accessor on the cleartext spec — never the
 * heavy DeploymentSpec projection, since links are a spec-level fact.
 *
 * Returns null when an encrypted spec cannot be decrypted on this node (key not
 * loaded / not our app): callers MUST treat null as "links unknown" and fail
 * toward keeping (never reap/suppress on incomplete visibility).
 *
 * @param {object} instantiated - InstantiatedSpec
 * @returns {Promise<string[]|null>}
 */
async function resolveLinkedAppNames(instantiated) {
  if (!instantiated) return [];
  if (!instantiated.isEncrypted) return instantiated.linkedAppNames();
  try {
    const resolved = await resolveInstantiatedSpec(instantiated);
    if (!resolved || !resolved.spec) return null;
    return resolved.spec.linkedAppNames();
  } catch (err) {
    log.warn(`deploymentProvider.resolveLinkedAppNames: cannot read links for encrypted ${instantiated.name}: ${err.message}`);
    return null;
  }
}

module.exports = {
  listInstalledDeployments,
  getInstalledDeployment,
  resolveLinkedAppNames,
  buildDeployment: toDeployment,
};
