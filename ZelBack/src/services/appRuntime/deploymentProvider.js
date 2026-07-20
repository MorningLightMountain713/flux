const appsRepository = require('../appDatabase/appsRepository');
const dockerService = require('../dockerService');
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
 * Build the deployment view for one identity of an app on this node.
 *
 * @param {object} instantiated - InstantiatedSpec
 * @param {object} opts
 * @param {string|null} opts.replica - the identity to build: a replica name
 *   (named placement) or null (loose). REQUIRED - a caller that means every
 *   identity iterates buildDeployments; one that cannot say which identity it
 *   means must not receive an arbitrary one.
 * @returns {Promise<object>} DeploymentSpec
 */
async function toDeployment(instantiated, opts = {}) {
  if (!('replica' in opts)) {
    throw new Error(`buildDeployment for ${instantiated.name} requires an explicit replica (null for loose); a caller that means every identity uses buildDeployments`);
  }
  const resolved = await resolveInstantiatedSpec(instantiated);
  if (!resolved) throw new Error(`Could not resolve spec for ${instantiated.name}`);

  // Encrypted apps resolve to a DecryptedCanonicalSpec; DeploymentSpec projects
  // from the real spec instance it wraps (its guard rejects a still-sealed spec).
  const runtimeSpec = instantiated.isEncrypted ? resolved.spec : resolved;

  const { DeploymentSpec } = await getSpecBackend();
  return DeploymentSpec.fromSpec(runtimeSpec, appsFolder, { replica: opts.replica });
}

/**
 * The definite identity for a single-identity operation on this node: null for
 * loose placement, the assigned replica for named-single, and a loud throw for
 * a co-located set (the caller must say which replica it means). Callers
 * normalize their options into this ONCE at entry, so downstream code passes a
 * definite `{ replica }` everywhere instead of threading a tri-state.
 *
 * @param {object} instantiated - InstantiatedSpec
 * @returns {Promise<string|null>}
 */
async function resolveDeploymentIdentity(instantiated) {
  const resolved = await resolveInstantiatedSpec(instantiated);
  if (!resolved) throw new Error(`Could not resolve spec for ${instantiated.name}`);
  const runtimeSpec = instantiated.isEncrypted ? resolved.spec : resolved;
  const names = await resolveLocalReplicas(runtimeSpec);
  if (names === null || names.length === 0) return null;
  if (names.length > 1) {
    throw new Error(`${instantiated.name} names ${names.length} replicas for this node (${names.join(', ')}) - a single-identity operation must say which replica it means`);
  }
  return names[0];
}

/**
 * Every identity this node is ASSIGNED by the spec: the named replicas
 * targeting it ([] when named elsewhere), or [null] for loose placement.
 * The install-side counterpart of localIdentities, which is teardown-side
 * (it also sees what is merely present).
 *
 * @param {object} instantiated - InstantiatedSpec
 * @returns {Promise<Array<string|null>>}
 */
async function assignedIdentities(instantiated) {
  const resolved = await resolveInstantiatedSpec(instantiated);
  if (!resolved) throw new Error(`Could not resolve spec for ${instantiated.name}`);
  const runtimeSpec = instantiated.isEncrypted ? resolved.spec : resolved;
  const replicas = await resolveLocalReplicas(runtimeSpec);
  return replicas === null ? [null] : replicas;
}

/**
 * Every identity this node OWES management for: the ones the spec assigns it
 * (the named replicas targeting it, or loose placement's single unqualified
 * identity) UNION the ones actually present on its labeled containers. A
 * teardown must match what exists, not only what the spec now says — the
 * identities the two disagree about are exactly the ones that would otherwise
 * be orphaned: a replica the maps stopped naming, and a qualified container
 * left behind when the app switched back to loose. Falls back to [null] when
 * neither has anything to say, so a caller always gets one descriptor.
 *
 * @param {object} instantiated - InstantiatedSpec
 * @returns {Promise<Array<string|null>>}
 */
async function localIdentities(instantiated) {
  const resolved = await resolveInstantiatedSpec(instantiated);
  if (!resolved) throw new Error(`Could not resolve spec for ${instantiated.name}`);
  const runtimeSpec = instantiated.isEncrypted ? resolved.spec : resolved;

  const assigned = await resolveLocalReplicas(runtimeSpec);
  const assignedIdentities = assigned === null ? [null] : assigned;

  const present = await dockerService.getAppContainerObjects(instantiated.name).catch(() => []);
  const replicasPresent = present.map((c) => (c.Labels && c.Labels['runonflux.replica']) || null);

  const owed = [...new Set([...assignedIdentities, ...replicasPresent])];
  return owed.length > 0 ? owed : [null];
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

/**
 * Every deployment view an app is ACTUALLY INSTALLED with on this node — the
 * runtime counterpart to toDeployments' assigned view.
 *
 * A replica the spec assigns but that was never installed here has no volume
 * and no container, so anything that ACTUATES must drive this list. Driving the
 * assigned list instead makes a never-installed replica indistinguishable from
 * a vanished container: the actuator tries to start it, finds no volume, and
 * either defers forever or escalates to recreate — on an app that was never
 * provisioned here. Provisioning is the install path's job; a replica must be
 * installed before anything may start it.
 *
 * @param {object} instantiated - InstantiatedSpec
 * @returns {Promise<object[]>} DeploymentSpec[]
 */
async function installedDeployments(instantiated) {
  const installed = new Set(await appsRepository.listInstalledIdentities(instantiated.name));
  const deployments = await toDeployments(instantiated);
  return deployments.filter((d) => installed.has(d.replica ?? null));
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
 * Every deployment view of an installed app on this node — one per INSTALLED
 * identity, so a replica the spec assigns but that was never provisioned here
 * is absent rather than presented as runnable.
 *
 * @param {string} name
 * @returns {Promise<object[]>}
 */
async function getInstalledDeployments(name) {
  const inst = await appsRepository.getInstalledApp(name);
  if (!inst) return [];
  try {
    const deployments = await installedDeployments(inst);
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
  resolveLocalReplicas,
  resolveDeploymentIdentity,
  assignedIdentities,
  localIdentities,
  buildDeployment: toDeployment,
  buildDeployments: toDeployments,
  installedDeployments,
};
