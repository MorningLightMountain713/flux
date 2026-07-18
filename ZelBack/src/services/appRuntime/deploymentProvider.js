const appsRepository = require('../appDatabase/appsRepository');
const { appsFolder } = require('../utils/appConstants');
const { getSpecBackend } = require('../utils/specLibs');
const { resolveInstantiatedSpec } = require('../utils/specCutover');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const generalService = require('../generalService');
const { socketAddressesMatch } = require('../utils/socketAddressUtils');
const log = require('../../lib/log');

/**
 * The named replicas THIS node runs for a spec. Derived on demand, never
 * stored - the spec plus this node's identity (socket address, collateral
 * outpoint) determine them, so every deployment build resolves the same
 * answer. One physical node addressed through both identity forms unions both
 * entries.
 *
 * @param {object} spec - a readable spec instance (placement is cleartext)
 * @returns {Promise<string[]|null>} null = loose placement (one unqualified
 *   instance); [] = named placement that does not target this node;
 *   [names...] = this node's assigned replicas (co-location when > 1)
 */
async function resolveLocalReplicas(spec) {
  if (spec.placement.mode() !== 'named') return null;

  const ip = await fluxNetworkHelper.getLocalSocketAddress();
  const collateral = await generalService.obtainNodeCollateralInformation();
  const outpoint = `${collateral.txhash}:${collateral.txindex}`;

  const names = spec.placement.replicasFor({ ip, outpoint, ipMatcher: socketAddressesMatch });
  if (names.length === 0) {
    log.warn(`deploymentProvider: named placement for ${spec.name} does not target this node`);
  }
  return names;
}

/**
 * Single-replica compatibility shim over resolveLocalReplicas. Callers that
 * hold no replica identity of their own resolve through this and therefore
 * still fail loud on a co-located set - the refusal lifts per call site as
 * each becomes replica-aware (passes {replica} or iterates toDeployments).
 *
 * @param {object} spec
 * @returns {Promise<string|null>}
 */
async function resolveLocalReplica(spec) {
  const names = await resolveLocalReplicas(spec);
  if (names === null || names.length === 0) return null;
  if (names.length > 1) {
    throw new Error(`${spec.name} names ${names.length} replicas for this node (${names.join(', ')}) - this caller is not replica-aware yet`);
  }
  return names[0];
}

/**
 * Build the deployment view for one identity of an app on this node.
 *
 * @param {object} instantiated - InstantiatedSpec
 * @param {object} [opts]
 * @param {string|null} [opts.replica] - the identity to build: a replica name
 *   (named placement) or null (loose). OMITTED means auto-resolve, which
 *   throws on a co-located set - a caller that cannot know which replica it
 *   means must not receive an arbitrary one.
 * @returns {Promise<object>} DeploymentSpec
 */
async function toDeployment(instantiated, opts = {}) {
  const resolved = await resolveInstantiatedSpec(instantiated);
  if (!resolved) throw new Error(`Could not resolve spec for ${instantiated.name}`);

  // Encrypted apps resolve to a DecryptedCanonicalSpec; DeploymentSpec projects
  // from the real spec instance it wraps (its guard rejects a still-sealed spec).
  const runtimeSpec = instantiated.isEncrypted ? resolved.spec : resolved;

  const replica = 'replica' in opts ? opts.replica : await resolveLocalReplica(runtimeSpec);

  const { DeploymentSpec } = await getSpecBackend();
  return DeploymentSpec.fromSpec(runtimeSpec, appsFolder, { replica });
}

/**
 * Every deployment of an app on this node: one per assigned replica for named
 * placement (empty when named elsewhere), exactly one (unqualified) for loose.
 *
 * @param {object} instantiated - InstantiatedSpec
 * @returns {Promise<object[]>} DeploymentSpec[]
 */
async function toDeployments(instantiated) {
  const resolved = await resolveInstantiatedSpec(instantiated);
  if (!resolved) throw new Error(`Could not resolve spec for ${instantiated.name}`);
  const runtimeSpec = instantiated.isEncrypted ? resolved.spec : resolved;

  const replicas = await resolveLocalReplicas(runtimeSpec);
  const identities = replicas === null ? [null] : replicas;

  const { DeploymentSpec } = await getSpecBackend();
  const deployments = [];
  for (const replica of identities) {
    deployments.push(DeploymentSpec.fromSpec(runtimeSpec, appsFolder, { replica }));
  }
  return deployments;
}

async function listInstalledDeployments() {
  const installed = await appsRepository.listInstalledApps();
  const deployments = [];
  for (const inst of installed) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const appDeployments = await toDeployments(inst);
      deployments.push(...appDeployments);
    } catch (err) {
      log.error(`deploymentProvider: failed to build deployment for ${inst.name}: ${err.message}`);
    }
  }
  return deployments;
}

/**
 * ONE deployment view of an installed app, for spec-level reads only (images,
 * links - fields the per-replica override allowlist cannot touch). Per-replica
 * fields (ports, env, identifier) must go through getInstalledDeployments.
 *
 * @param {string} name
 * @returns {Promise<object|null>}
 */
async function getInstalledDeployment(name) {
  const inst = await appsRepository.getInstalledApp(name);
  if (!inst) return null;
  try {
    const deployments = await toDeployments(inst);
    return deployments[0] || null;
  } catch (err) {
    log.error(`deploymentProvider: failed to build deployment for ${name}: ${err.message}`);
    return null;
  }
}

/**
 * Every deployment view of an installed app on this node (one per assigned
 * replica; one for loose).
 *
 * @param {string} name
 * @returns {Promise<object[]>}
 */
async function getInstalledDeployments(name) {
  const inst = await appsRepository.getInstalledApp(name);
  if (!inst) return [];
  try {
    const deployments = await toDeployments(inst);
    return deployments;
  } catch (err) {
    log.error(`deploymentProvider: failed to build deployments for ${name}: ${err.message}`);
    return [];
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
  getInstalledDeployments,
  resolveLinkedAppNames,
  resolveLocalReplica,
  resolveLocalReplicas,
  buildDeployment: toDeployment,
  buildDeployments: toDeployments,
};
