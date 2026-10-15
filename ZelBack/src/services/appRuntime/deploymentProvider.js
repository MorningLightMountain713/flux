'use strict';

const appRecords = require('../appDatabase/appRecords');
const dockerService = require('../dockerService');
const { appsFolder } = require('../utils/appConstants');
const { getSpecBackend } = require('../utils/specLibs');
const { resolveInstantiatedSpec } = require('../utils/specCutover');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const generalService = require('../generalService');
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

  const names = spec.assignment.replicasFor({ ip, outpoint });
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
 * The names the ledger records for the components the node has started on:
 * by component key, the folder id its data is shared under and the aliases its
 * container is created with. A deployment built with them names those
 * components as recorded and leaves the registration to name the rest.
 * @param {import('@runonflux/flux-spec-backend').InstalledLedger|null} ledger
 * @returns {Object<string, {syncFolderId: string|null, aliases: string[]}>|undefined}
 */
function recordedNames(ledger) {
  if (!ledger) return undefined;
  return Object.fromEntries(Object.entries(ledger.components).map(([key, block]) => [key, {
    syncFolderId: block.syncFolder?.id ?? null,
    aliases: [...block.aliases],
  }]));
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
 * One identity's deployment of a registered record, its components keyed as stated.
 * @param {object} registered - InstantiatedSpec
 * @param {object} opts - { replica, identity, registrationVersion, componentKeys }
 * @returns {Promise<object>} DeploymentSpec
 */
async function deploymentOf(registered, opts) {
  const resolved = await resolveInstantiatedSpec(registered);
  if (!resolved) throw new Error(`Could not resolve spec for ${registered.name}`);
  const { DeploymentSpec } = await getSpecBackend();
  const ledger = await appRecords.ledgers().byInstance(registered.name, opts.replica);
  // The identity is READ off the row, never recomputed from the name: this and
  // deploymentsOf decide every container name, volume path, network and folder
  // id on this node, so an app keeps the identity it was installed with for as
  // long as it is installed. Null (an app installed before identities were
  // stored) falls back to the name inside fromSpec.
  return DeploymentSpec.fromSpec(resolved, appsFolder, {
    replica: opts.replica,
    identity: opts.identity ?? registered.identity ?? null,
    registrationVersion: opts.registrationVersion,
    names: opts.recordedNames === false ? undefined : recordedNames(ledger),
    ...(opts.componentKeys == null ? {} : { componentKeys: opts.componentKeys }),
  });
}

/**
 * Every assigned identity's deployment of a registered record: one per replica
 * named to this node (none when named elsewhere), exactly one for loose placement.
 * @param {object} registered - InstantiatedSpec
 * @param {object} opts - { identity, registrationVersion, componentKeys }
 * @returns {Promise<object[]>} DeploymentSpec[]
 */
async function deploymentsOf(registered, opts) {
  const resolved = await resolveInstantiatedSpec(registered);
  if (!resolved) throw new Error(`Could not resolve spec for ${registered.name}`);
  const replicas = await resolveLocalReplicas(resolved);
  const deployments = [];
  for (const replica of replicas === null ? [null] : replicas) {
    // eslint-disable-next-line no-await-in-loop
    deployments.push(await deploymentOf(registered, { ...opts, replica }));
  }
  return deployments;
}

async function assertInstall(install, what) {
  const { InstalledSpec } = await getSpecBackend();
  if (!(install instanceof InstalledSpec)) {
    throw new Error(`${what} builds from an installed record, whose component keys name the containers; plan a version not installed as it is with ${what.replace('build', 'plan')}`);
  }
}

/**
 * The deployment of one identity of an app installed on this node: its
 * installed record's registered record, keyed by the component keys the node
 * derived for it.
 *
 * @param {object} install - InstalledSpec
 * @param {object} opts
 * @param {string|null} opts.replica - the identity to build: a replica name
 *   (named placement) or null (loose). REQUIRED - a caller that means every
 *   identity iterates buildDeployments; one that cannot say which identity it
 *   means must not receive an arbitrary one.
 * @param {number} [opts.registrationVersion] - the version the app was
 *   registered with, stated by a caller that provisions (it names a component
 *   the ledger does not hold yet); a reader leaves it out
 * @returns {Promise<object>} DeploymentSpec
 */
async function buildDeployment(install, opts = {}) {
  await assertInstall(install, 'buildDeployment');
  if (!('replica' in opts)) {
    throw new Error(`buildDeployment for ${install.name} requires an explicit replica (null for loose); a caller that means every identity uses buildDeployments`);
  }
  return deploymentOf(install.record, {
    replica: opts.replica, registrationVersion: opts.registrationVersion, componentKeys: install.componentKeys,
  });
}

/**
 * Every assigned identity's deployment of an app installed on this node, keyed
 * by its installed record's component keys.
 * @param {object} install - InstalledSpec
 * @param {object} [opts] - { registrationVersion }
 * @returns {Promise<object[]>} DeploymentSpec[]
 */
async function buildDeployments(install, opts = {}) {
  await assertInstall(install, 'buildDeployments');
  return deploymentsOf(install.record, { registrationVersion: opts.registrationVersion, componentKeys: install.componentKeys });
}

/**
 * The deployment of one identity of a version not installed as it is: an
 * update being planned, an install being prepared. Its component keys are
 * stated, null for components keyed by their names.
 * @param {object} registered - InstantiatedSpec
 * @param {object} opts - { replica, componentKeys, identity?, registrationVersion?, recordedNames? }
 *   recordedNames: false builds the names the spec derives, ignoring the ones
 *   the ledger recorded for the components the node has started on
 * @returns {Promise<object>} DeploymentSpec
 */
async function planDeployment(registered, opts = {}) {
  if (!('replica' in opts) || !('componentKeys' in opts)) {
    throw new Error(`planDeployment for ${registered.name} requires an explicit replica and componentKeys`);
  }
  return deploymentOf(registered, opts);
}

/**
 * Every assigned identity's deployment of a version not installed as it is.
 * @param {object} registered - InstantiatedSpec
 * @param {object} opts - { componentKeys, identity?, registrationVersion? }
 * @returns {Promise<object[]>} DeploymentSpec[]
 */
async function planDeployments(registered, opts = {}) {
  if (!('componentKeys' in opts)) {
    throw new Error(`planDeployments for ${registered.name} requires explicit componentKeys`);
  }
  return deploymentsOf(registered, opts);
}

/**
 * Every deployment view an app is ACTUALLY INSTALLED with on this node — the
 * runtime counterpart to buildDeployments' assigned view.
 *
 * A replica the spec assigns but that was never installed here has no volume
 * and no container, so anything that ACTUATES must drive this list. Driving the
 * assigned list instead makes a never-installed replica indistinguishable from
 * a vanished container: the actuator tries to start it, finds no volume, and
 * either defers forever or escalates to recreate — on an app that was never
 * provisioned here. Provisioning is the install path's job; a replica must be
 * installed before anything may start it.
 *
 * @param {object} install - InstalledSpec
 * @returns {Promise<object[]>} DeploymentSpec[]
 */
async function installedDeployments(install) {
  await assertInstall(install, 'installedDeployments');
  const installed = new Set((await appRecords.installed().keys(install.name)).map((key) => key.replica));
  const deployments = await buildDeployments(install);
  return deployments.filter((d) => installed.has(d.replica ?? null));
}

/**
 * Every installed app's deployments.
 *
 * `installs` lets a caller that has already listed the installed apps hand
 * them over instead of having them read and deserialized a second time. The
 * resource check does exactly that, and it runs on every admission decision and
 * every spawn cycle — so the read it saves is the one that happens most.
 *
 * @param {Array<object>|null} [installs] - already-listed InstalledSpecs
 * @returns {Promise<Array<object>>}
 */
async function listInstalledDeployments(installs = null) {
  const { deployments } = await listInstalledDeploymentsDetailed(installs);
  return deployments;
}

/**
 * The same, and the apps it could not build.
 *
 * AN APP THAT COULD NOT BE READ IS NOT AN APP THAT IS NOT INSTALLED. The list
 * alone cannot tell those apart: an enterprise app this node cannot decrypt
 * right now is simply absent from it, exactly as an uninstalled one is - and a
 * caller that acts on absence acts on the wrong fact. syncthingMonitor's sweep
 * deletes any folder no installed app owns, so an app that failed to decrypt
 * had its folder removed, taking the index, the peer device list and any
 * standing safety demotion with it, and it does not come back until the app is
 * readable again.
 *
 * An unreadable app is reported by its identity, which is what its folder ids
 * are built from (`component_identity[_replica]`), so a folder names its owner
 * even when that owner's components cannot be read.
 *
 * @param {Array<object>|null} [installs] - already-listed InstalledSpecs
 * @returns {Promise<{deployments: Array<object>, unreadableApps: Map<string, string>}>}
 *   `unreadableApps`: identity -> app name
 */
async function listInstalledDeploymentsDetailed(installs = null) {
  const installed = installs ?? await appRecords.installed().apps();
  const deployments = [];
  const unreadableApps = new Map();
  for (const inst of installed) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const appDeployments = await buildDeployments(inst);
      deployments.push(...appDeployments);
    } catch (err) {
      unreadableApps.set(inst.identity ?? inst.name, inst.name);
      log.error(`deploymentProvider: failed to build deployment for ${inst.name}: ${err.message}`);
    }
  }
  return { deployments, unreadableApps };
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
  const inst = await appRecords.installed().byName(name);
  if (!inst) return null;
  try {
    const deployments = await buildDeployments(inst);
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
  const inst = await appRecords.installed().byName(name);
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
 * from the other side, DeploymentSpec.identityFromIdentifier).
 *
 * @param {string} appname the request's app or component name
 * @returns {string} the app name
 */
function appNameFromRequest(appname) {
  return appname.split('_')[1] || appname;
}

/**
 * The component a REQUEST names. A v1-3 app has no compose array: it is its own
 * single component, which its spec names after the app, and every caller that
 * speaks the v1 API addresses that component as the literal 'null'. 'null' is
 * also a valid component name, so a component that carries it answers to it.
 *
 * @param {string} appname the app's name
 * @param {string} component the request's component name
 * @param {string[]} componentNames the names of the app's components
 * @returns {string} the component's name
 */
function componentNameFromRequest(appname, component, componentNames) {
  return component === 'null' && !componentNames.includes('null') ? appname : component;
}

/**
 * The container identifiers a request names on this node, and the app they
 * belong to.
 *
 * The request holds names; a container identifier is built from the app's stored
 * IDENTITY, and those differ for every app registered since identity minting. So
 * the request string is not an identifier and must never be used as one — it is
 * resolved by lookup instead: the app's installed row, its deployments, then the component
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
  // The containers are this node's, so they are named by its installed record.
  const install = await appRecords.installed().byName(appNameFromRequest(appname));
  if (!install) {
    throw new Error('Application not found');
  }
  const instantiated = install.record;
  let deployments = await buildDeployments(install);
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
  componentNameFromRequest,
  resolveRequestTargets,
  resolveRequestContainer,
  listInstalledDeployments,
  listInstalledDeploymentsDetailed,
  getInstalledDeployment,
  getInstalledDeployments,
  resolveLocalReplicas,
  resolveRuntimeSpec,
  resolveDeploymentIdentity,
  assignedIdentities,
  localIdentities,
  buildDeployment,
  buildDeployments,
  planDeployment,
  planDeployments,
  installedDeployments,
};
