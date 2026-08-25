'use strict';

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
 * stored - the DECRYPTED spec plus this node's identity (socket address,
 * collateral outpoint) determine them. The replica names live in the sealed
 * Assignment, so the spec must be decrypted first (callers resolve it via
 * resolveRuntimeSpec / resolveInstantiatedSpec). One physical node addressed
 * through both identity forms unions both entries.
 *
 * @param {object} spec - a readable spec view (exposes .placement/.assignment)
 * @returns {Promise<string[]|null>} null = candidate/none placement (one
 *   unqualified instance); [] = pinned placement that does not target this
 *   node; [names...] = this node's assigned replicas (co-location when > 1)
 */
async function resolveLocalReplicas(spec) {
  if (spec.placement.mode() !== 'pinned') return null;

  const ip = await fluxNetworkHelper.getLocalSocketAddress();
  const collateral = await generalService.obtainNodeCollateralInformation();
  const outpoint = `${collateral.txhash}:${collateral.txindex}`;

  const names = spec.assignment.replicasFor({ ip, outpoint, ipMatcher: socketAddressesMatch });
  if (names.length === 0) {
    log.warn(`deploymentProvider: pinned placement for ${spec.name} does not target this node`);
  }
  return names;
}

/**
 * The READABLE spec view for an InstantiatedSpec: a cleartext spec instance as
 * itself, an encrypted one as its DecryptedCanonicalSpec. Callers that need the
 * sealed body - the assignment (replica names), components, ports - go through
 * this rather than reading the wire spec, which no longer carries the names.
 *
 * The wrapper is returned as-is rather than unwrapped to its `.spec`: it
 * read-through delegates every field a runtime caller asks for, and it is the
 * type that guarantees cleartext is never persisted. Extracting the inner
 * instance drops that guarantee for no gain.
 *
 * @param {object} instantiated - InstantiatedSpec
 * @returns {Promise<object>} readable spec view (FluxAppSpec* | DecryptedCanonicalSpec)
 */
async function resolveRuntimeSpec(instantiated) {
  const resolved = await resolveInstantiatedSpec(instantiated);
  if (!resolved) throw new Error(`Could not resolve spec for ${instantiated.name}`);
  return resolved;
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

  const { DeploymentSpec } = await getSpecBackend();
  // The identity is READ off the row, never recomputed from the name. This and
  // toDeployments are what decide every container name, volume path, network and
  // syncthing folder id on this node, so an app keeps the identity
  // it was installed with for as long as it is installed - including across a
  // spec update, an owner change, or a name someone else later re-registers.
  // Null (an app installed before identities were stored) falls back to the
  // name inside fromSpec, which is exactly the identifier it already has.
  return DeploymentSpec.fromSpec(resolved, appsFolder, {
    replica: opts.replica,
    // opts.identity is the update path's seam: a registry spec carries no
    // identity (identities are minted at install), so the caller diffing an
    // update hands in the installed row's — the app keeps the identity it was
    // installed with for as long as it is installed.
    identity: opts.identity ?? instantiated.identity ?? null,
  });
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
  const names = await resolveLocalReplicas(resolved);
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
  const replicas = await resolveLocalReplicas(resolved);
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
  const assigned = await resolveLocalReplicas(resolved);
  const assignedIdentities = assigned === null ? [null] : assigned;

  const present = await dockerService.getAppContainerObjects(instantiated.name).catch(() => []);
  const { LABEL_KEYS } = await getSpecBackend();
  const replicasPresent = present.map((c) => (c.Labels && c.Labels[LABEL_KEYS.REPLICA]) || null);

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
async function toDeployments(instantiated, opts = {}) {
  const resolved = await resolveInstantiatedSpec(instantiated);
  if (!resolved) throw new Error(`Could not resolve spec for ${instantiated.name}`);
  const replicas = await resolveLocalReplicas(resolved);
  const identities = replicas === null ? [null] : replicas;

  const { DeploymentSpec } = await getSpecBackend();
  const deployments = [];
  for (const replica of identities) {
    // Same identity read as toDeployment: every identity of one app shares the
    // app's, so building the set without it would name the same containers
    // differently from the single-identity path that created them. opts.identity
    // is the update path's seam (see toDeployment).
    deployments.push(DeploymentSpec.fromSpec(resolved, appsFolder, {
      replica,
      identity: opts.identity ?? instantiated.identity ?? null,
    }));
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
 * The app a REQUEST names. A request states names — `<app>`, or one of its
 * components as `<component>_<app>` — because a name is what an operator and the
 * UI hold. This is the inverse of that request form, and deliberately NOT of a
 * container identifier: an identifier's second segment is the app's identity,
 * which is not a name and does not resolve as one (flux-spec states the same rule
 * from the other side, DeploymentSpec.appNameFromIdentifier).
 *
 * @param {string} appname the request's app or component name
 * @returns {string} the app name
 */
function appNameFromRequest(appname) {
  return appname.split('_')[1] || appname;
}

/**
 * The container identifiers a request names on this node, and the app they
 * belong to.
 *
 * The request holds names; a container identifier is built from the app's stored
 * IDENTITY, and those differ for every app registered since identity minting. So
 * the request string is not an identifier and must never be used as one — it is
 * resolved by lookup instead: the app's row, its deployments, then the component
 * by NAME. Everything returned therefore belongs to the app that was named, which
 * is what lets a caller check ownership against that name and act on these ids
 * without the two disagreeing.
 *
 * @param {string} appname the request's app or component name
 * @param {object} [opts]
 * @param {string|null} [opts.replica] restrict to one named replica
 * @returns {Promise<{instantiated: object, deployments: object[], ids: string[]}>}
 */
async function resolveRequestTargets(appname, opts = {}) {
  const { replica = null } = opts;
  const instantiated = await appsRepository.getGlobalAppInfo(appNameFromRequest(appname));
  if (!instantiated) {
    throw new Error('Application not found');
  }
  let deployments = await toDeployments(instantiated);
  if (replica != null) {
    deployments = deployments.filter((deployment) => deployment.replica === replica);
    if (deployments.length === 0) {
      throw new Error(`Replica ${replica} of ${instantiated.name} is not deployed on this node`);
    }
  }
  const separator = appname.indexOf('_');
  if (separator === -1) {
    const ids = deployments.flatMap(
      (deployment) => deployment.componentEntries().map(([, comp]) => comp.identifier),
    );
    if (ids.length === 0) {
      throw new Error(`${instantiated.name} is not deployed on this node`);
    }
    return { instantiated, deployments, ids };
  }
  const componentName = appname.slice(0, separator);
  const ids = deployments
    .map((deployment) => deployment.getComponent(componentName))
    .filter(Boolean)
    .map((comp) => comp.identifier);
  if (ids.length === 0) {
    throw new Error(`Component ${componentName} of ${instantiated.name} is not deployed on this node`);
  }
  return { instantiated, deployments, ids };
}

/**
 * The ONE container a request names — for the endpoints that read a single
 * container (logs, inspect, stats, top, changes, exec). A request naming a whole
 * composed app, or an app co-located across replicas, names several and must say
 * which: answering for an arbitrary one would report another container's state as
 * this one's.
 *
 * @param {string} appname the request's app or component name
 * @param {object} [opts]
 * @param {string|null} [opts.replica]
 * @returns {Promise<string>} the container identifier
 */
async function resolveRequestContainer(appname, opts = {}) {
  const { instantiated, ids } = await resolveRequestTargets(appname, opts);
  if (ids.length > 1) {
    throw new Error(`${appname} names ${ids.length} containers on this node - specify a component, or a replica with ?replica=`);
  }
  if (!instantiated) {
    throw new Error('Application not found');
  }
  return ids[0];
}

module.exports = {
  appNameFromRequest,
  resolveRequestTargets,
  resolveRequestContainer,
  listInstalledDeployments,
  getInstalledDeployment,
  getInstalledDeployments,
  resolveLocalReplicas,
  resolveRuntimeSpec,
  resolveDeploymentIdentity,
  assignedIdentities,
  localIdentities,
  buildDeployment: toDeployment,
  buildDeployments: toDeployments,
  installedDeployments,
};
