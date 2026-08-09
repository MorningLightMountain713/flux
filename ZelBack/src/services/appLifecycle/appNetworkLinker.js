/**
 * App Network Linker
 *
 * Implements opt-in app-to-app network linking. An app owner links the app to
 * other apps via the typed `network.shareWith` spec field (a list of app
 * names). When set, before the app is installed or redeployed the node verifies
 * every named app is installed locally and owned by the same owner; otherwise
 * the install fails. Each of the app's component containers is then attached to
 * the private docker network of every linked app (`fluxDockerNetwork_<linked>`),
 * so it can reach that app's components by their docker DNS name
 * `flux<component>_<linkedApp>` — exactly as if both apps were a single app.
 *
 * Declaration is one-directional (B lists A in shareWith; A declares nothing)
 * but reachability is mutual. This is node-local behaviour; cross-node linking
 * is `network.mesh`, a separate field.
 */

const config = require('config');
const appsRepository = require('../appDatabase/appsRepository');
const { resolveInstantiatedSpec } = require('../utils/specCutover');
const dockerService = require('../dockerService');
const { withHostMutationLock } = require('../utils/hostMutationLock');
const { socketAddressesMatch } = require('../utils/socketAddressUtils');
const { NodeCondition } = require('./nodeConditions');
const log = require('../../lib/log');

/**
 * Whether every container belonging to an installed app is currently running.
 * Docker-listing based (the local DB blanks enterprise compose, so iterating the
 * spec would miss components), so it works for enterprise apps too. False when
 * the app has no containers.
 *
 * @param {string} appName
 * @returns {Promise<boolean>}
 */
async function isAppRunning(appName) {
  const containers = await dockerService.getAppContainerObjects(appName);
  if (!containers || !containers.length) {
    return false;
  }
  return containers.every((container) => container && container.State === 'running');
}

/**
 * Verifies each named link is installed locally and same-owner; when the
 * node-managed collector lifecycle is on, also that it is running. Throws on
 * the first unsatisfied link — transient conditions tagged
 * NETWORK_DEPENDENCY_NOT_READY so callers defer and retry rather than
 * hard-failing into the spawner's error cache.
 *
 * @param {string} appName - the app declaring the links (for messages)
 * @param {string} owner - its owner, for the same-owner rule
 * @param {string[]} linkedApps - declared link names
 * @returns {Promise<boolean>}
 */
async function verifyLinkedApps(appName, owner, linkedApps) {
  // eslint-disable-next-line no-restricted-syntax
  for (const linkedApp of linkedApps) {
    // eslint-disable-next-line no-await-in-loop
    const installed = await appsRepository.getInstalledApp(linkedApp);
    if (!installed) {
      // Transient ordering condition, not a misconfiguration: the dependency may
      // simply not be installed yet. Tagged so callers can defer and retry
      // instead of treating it as a hard install failure.
      const error = new Error(`App '${linkedApp}' that '${appName}' must be networked with is not installed on this node. Installation aborted.`);
      error.code = NodeCondition.NETWORK_DEPENDENCY_NOT_READY;
      throw error;
    }
    if (installed.owner !== owner) {
      throw new Error(`App '${linkedApp}' that '${appName}' must be networked with is owned by a different owner. Installation aborted.`);
    }
    // When the node-managed collector lifecycle is on, require the dependency to
    // be actually running - not merely installed - so this app's docker-network
    // attach and log routing land on a live container. Tagged transient so
    // callers defer and retry rather than hard-failing.
    if (config.fluxapps.manageCollectorLifecycle) {
      // eslint-disable-next-line no-await-in-loop
      const running = await isAppRunning(linkedApp);
      if (!running) {
        const error = new Error(`App '${linkedApp}' that '${appName}' must be networked with is installed but not running yet. Installation deferred.`);
        error.code = NodeCondition.NETWORK_DEPENDENCY_NOT_READY;
        throw error;
      }
    }
  }
  log.info(`App network links satisfied for ${appName}: ${linkedApps.join(', ')}`);
  return true;
}

/**
 * Selection-time readiness, run by the spawner over every candidate on every
 * cycle. Reads the SEALED vantage and NEVER decrypts: an app's cleartext
 * metadata exists so a node can decide whether to install without decrypting,
 * and this runs long before the node has committed to anything.
 *
 * An encrypted app's links are therefore invisible here and it is reported
 * ready. That is deliberate — this is an ordering optimisation (install a
 * dependency before its consumer), not a correctness gate. The gate is
 * `checkAppNetworkRequirements`, which runs once the node has committed and is
 * decrypting the app anyway.
 *
 * @param {object} instantiated - InstantiatedSpec instance of the candidate
 * @returns {Promise<boolean>} true when the app may be selected this cycle
 */
async function linksReadyForSelection(instantiated) {
  const linkedApps = instantiated ? instantiated.linkedAppNames() : [];
  if (!linkedApps.length) {
    return true;
  }
  return verifyLinkedApps(instantiated.name, instantiated.owner, linkedApps);
}

/**
 * The install-time gate: verifies every app this app is linked to is installed
 * locally and owned by the same owner (and, with the node-managed collector
 * lifecycle on, running). Throws otherwise, aborting or deferring the
 * install/redeploy.
 *
 * Reads the links off the app's RESOLVED view, because the sealed accessor
 * reports none for an encrypted app and the gate would pass vacuously. Every
 * caller is a path the node has already committed to and is decrypting for
 * anyway, so the resolve costs nothing extra — keep it that way: this must not
 * be called from a selection or polling loop.
 *
 * @param {object} instantiated - InstantiatedSpec instance of the parent app
 * @returns {Promise<boolean>} true when all network links are satisfied
 */
async function checkAppNetworkRequirements(instantiated) {
  if (!instantiated) return true;

  const view = await resolveInstantiatedSpec(instantiated).catch(() => null);
  if (!view) {
    // The node installing an app can normally decrypt it. Failing here means
    // the links cannot be checked at all, so defer rather than install blind:
    // tagged transient, like a dependency that has not arrived yet.
    const error = new Error(`App '${instantiated.name}' could not be decrypted on this node to check its network links. Installation deferred.`);
    error.code = NodeCondition.NETWORK_DEPENDENCY_NOT_READY;
    throw error;
  }

  const linkedApps = view.linkedAppNames();
  if (!linkedApps.length) {
    return true;
  }
  return verifyLinkedApps(view.name, view.owner, linkedApps);
}

/**
 * Whether an app is a pure follower — `activation.standalone === false`: it has
 * no independent run decision and exists on a node only while a same-owner app
 * there `shareWith`-links to it (the v9 successor to the v8 dependencyOnly
 * marker, e.g. a shared stats collector). Absent/null activation (v1-v8 specs,
 * the v9 default) is standalone.
 *
 * Takes a READABLE spec view, not an InstantiatedSpec: whether the spec had to
 * be decrypted was settled by whoever resolved the view, so this stays a plain
 * question about a spec's fields. A null view is an app whose spec could not be
 * read here — standalone, which is the fail-toward-keeping answer (never reap
 * or suppress on incomplete visibility).
 *
 * @param {object|null} view - readable spec view (FluxAppSpec* | DecryptedCanonicalSpec)
 * @returns {boolean}
 */
function isPureFollower(view) {
  const activation = view && view.activation;
  return !!activation && activation.standalone === false;
}

/**
 * Whether an orphaned follower should be reaped: a pure follower that also
 * declares `activation.stopWhenUnneeded`. A follower with stopWhenUnneeded
 * false persists even when orphaned (an explicit spec opt-in); a standalone
 * app is never reaped — it justifies its own presence.
 *
 * @param {object|null} view - readable spec view
 * @returns {boolean}
 */
function isReapableFollower(view) {
  return isPureFollower(view) && view.activation.stopWhenUnneeded === true;
}

/**
 * Resolves a set of apps to their READABLE spec views, keyed by lowercased
 * name, so the pure graph traversals below can reason over an encrypted app's
 * real links and activation (the sealed vantage reports no links and no
 * activation at all).
 *
 * Resolving the view rather than extracting one field means one decrypt per
 * app however many fields the traversals read. An app whose spec can't be read
 * on this node maps to `null` and flips `complete` false — the signal for the
 * reap/suppression callers to fail toward keeping rather than act blind.
 *
 * @param {Array<object>} apps - InstantiatedSpec instances
 * @returns {Promise<{ viewsByName: Map<string, object|null>, complete: boolean }>}
 */
async function buildViewsByName(apps) {
  const viewsByName = new Map();
  let complete = true;
  // eslint-disable-next-line no-restricted-syntax
  for (const app of apps) {
    if (!app || !app.name) {
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const view = await resolveInstantiatedSpec(app).catch(() => null);
    viewsByName.set(app.name.toLowerCase(), view || null);
    if (!view) complete = false;
  }
  return { viewsByName, complete };
}

/**
 * The links an app declares, read off its resolved view. An unreadable view
 * contributes no edges; `complete` (above) is what tells a caller that absence
 * means "unknown" rather than "none".
 *
 * @param {Map<string, object|null>} viewsByName
 * @param {string} nameLower
 * @returns {string[]}
 */
function linksOf(viewsByName, nameLower) {
  const view = viewsByName.get(nameLower);
  return view ? view.linkedAppNames() : [];
}

/**
 * Whether one app is a pure follower, resolving its spec first. For callers
 * holding an InstantiatedSpec rather than a view; an app whose spec cannot be
 * read here answers false (standalone), the fail-toward-keeping answer.
 *
 * @param {object} instantiated - InstantiatedSpec instance
 * @returns {Promise<boolean>}
 */
async function isPureFollowerApp(instantiated) {
  if (!instantiated) return false;
  const view = await resolveInstantiatedSpec(instantiated).catch(() => null);
  return isPureFollower(view);
}

/**
 * An app's spec view WITHOUT decrypting: the spec itself while it is readable,
 * null while it is still sealed. Asks `sealed` — "are your contents still
 * ciphertext?" — rather than `isEncrypted`, which stays true on a readable
 * decrypted view.
 *
 * The cheap counterpart to resolving, for callers that have not committed to
 * installing and must not pay a decrypt. A cleartext app answers fully here; an
 * encrypted one answers nothing, which is the price of not decrypting.
 *
 * @param {object} instantiated - InstantiatedSpec instance
 * @returns {object|null}
 */
function readableViewOrNull(instantiated) {
  const spec = instantiated && instantiated.spec;
  return spec && !spec.sealed ? spec : null;
}

/**
 * The names among `apps` that are pure followers, in one pass.
 *
 * `shouldResolve` decides per app whether to pay a decrypt. The spawner passes
 * "is this app pinned to this node": a pinned app will be installed here, so it
 * is decrypted moments later anyway, while the general pool is many candidates
 * for at most one install and must stay sealed. An app that is neither pinned
 * nor readable is reported standalone — the fail-toward-keeping answer.
 *
 * @param {Array<object>} apps - InstantiatedSpec instances
 * @param {(app: object) => boolean} [shouldResolve] - defaults to resolving all
 * @returns {Promise<Set<string>>} original-cased follower names
 */
async function pureFollowerNames(apps, shouldResolve = () => true) {
  const followers = new Set();
  if (!Array.isArray(apps) || !apps.length) return followers;
  // eslint-disable-next-line no-restricted-syntax
  for (const app of apps) {
    if (app && app.name) {
      // eslint-disable-next-line no-await-in-loop
      const view = shouldResolve(app)
        ? await resolveInstantiatedSpec(app).catch(() => null)
        : readableViewOrNull(app);
      if (isPureFollower(view)) followers.add(app.name);
    }
  }
  return followers;
}

/**
 * Given a set of apps and their resolved (decrypted) links, returns the set of
 * follower-app names that are *required*: the transitive `shareWith` closure
 * starting from the apps that can stand alone (activation.standalone !== false).
 * Links are only followed between apps of the same owner. Original-cased names
 * are returned; matching is case-insensitive.
 *
 * Starting the closure from standalone apps only (not every app in the set) is
 * what lets a pure follower fall out of the required set once nothing links to
 * it — otherwise a collector, being present itself, would keep itself alive.
 *
 * Pure over its inputs: every spec read comes from `viewsByName` (resolved by
 * the async caller), never fetched here.
 *
 * @param {Array<object>} apps - InstantiatedSpec instances to reason over
 * @param {Map<string, object|null>} viewsByName - lowercased-name -> readable view
 * @returns {Set<string>} required follower app names
 */
function computeRequiredDependencyNames(apps, viewsByName) {
  const required = new Set();
  if (!Array.isArray(apps) || !apps.length) {
    return required;
  }
  const byName = new Map();
  apps.forEach((app) => {
    if (app && app.name) byName.set(app.name.toLowerCase(), app);
  });

  const roots = apps.filter((app) => app && app.name
    && !isPureFollower(viewsByName.get(app.name.toLowerCase())));
  const queue = [...roots];
  const visited = new Set(roots.map((app) => app.name.toLowerCase()));

  while (queue.length) {
    const current = queue.shift();
    const links = linksOf(viewsByName, current.name.toLowerCase());
    // eslint-disable-next-line no-restricted-syntax
    for (const linkedName of links) {
      const dep = byName.get(linkedName.toLowerCase());
      if (dep && dep.owner === current.owner) {
        required.add(dep.name);
        const key = dep.name.toLowerCase();
        if (!visited.has(key)) {
          visited.add(key);
          queue.push(dep);
        }
      }
    }
  }
  return required;
}

/**
 * Whether a workload transitively `shareWith`-depends on `depNameLower`,
 * following same-owner links only. Breadth-first over the resolved link graph.
 *
 * @param {object} workload - root InstantiatedSpec
 * @param {string} depNameLower - lowercased follower name to look for
 * @param {Map<string, object>} byName - lowercased-name -> InstantiatedSpec
 * @param {Map<string, object|null>} viewsByName - lowercased-name -> readable view
 * @returns {boolean}
 */
function appTransitivelyRequires(workload, depNameLower, byName, viewsByName) {
  const visited = new Set([workload.name.toLowerCase()]);
  const queue = [workload];
  while (queue.length) {
    const current = queue.shift();
    const links = linksOf(viewsByName, current.name.toLowerCase());
    // eslint-disable-next-line no-restricted-syntax
    for (const linkedName of links) {
      const key = linkedName.toLowerCase();
      const dep = byName.get(key);
      // Only same-owner links to present apps are real dependencies (mirrors
      // computeRequiredDependencyNames); a cross-owner/dangling link is ignored.
      if (!dep || dep.owner !== workload.owner) {
        // eslint-disable-next-line no-continue
        continue;
      }
      if (key === depNameLower) {
        return true;
      }
      if (!visited.has(key)) {
        visited.add(key);
        queue.push(dep);
      }
    }
  }
  return false;
}

/**
 * Locally-installed workloads (apps that are NOT pure followers) that
 * transitively `shareWith`-require the given follower, same-owner only. The
 * inverse of `computeRequiredDependencyNames`: used to uninstall the consumers
 * before the dependency they rely on is torn down.
 *
 * @param {string} depName - follower app name
 * @returns {Promise<Array<object>>} requiring workload InstantiatedSpecs
 */
async function findInstalledWorkloadsRequiring(depName) {
  const installed = await appsRepository.listInstalledApps();
  if (!installed || !installed.length) {
    return [];
  }
  const byName = new Map();
  installed.forEach((app) => {
    if (app && app.name) byName.set(app.name.toLowerCase(), app);
  });
  const { viewsByName } = await buildViewsByName(installed);
  const target = depName.toLowerCase();
  return installed.filter((app) => app && app.name
    && !isPureFollower(viewsByName.get(app.name.toLowerCase()))
    && appTransitivelyRequires(app, target, byName, viewsByName));
}

/**
 * The follower-app names that should be present on this node, computed from
 * every global app whose placement targets this node. Used by the spawner to
 * suppress a pure follower that nothing here requires.
 *
 * @param {object} nodeIdentity - { ip, outpoint, operator } of this node
 * @returns {Promise<Set<string>>}
 * @throws when an assigned app's links can't be read here — the caller falls
 *   back to not suppressing rather than wrongly suppressing a needed follower.
 */
async function getRequiredDependencyNamesForNode(nodeIdentity) {
  const { ip, outpoint, operator } = nodeIdentity || {};
  if (!ip && !outpoint && !operator) {
    return new Set();
  }
  const globalApps = await appsRepository.listGlobalAppInfo();
  const assigned = (globalApps || []).filter((app) => app && app.placement
    && app.placement.isPinnedTo({
      ip, outpoint, operator, ipMatcher: socketAddressesMatch,
    }));
  const { viewsByName, complete } = await buildViewsByName(assigned);
  if (!complete) {
    // An assigned encrypted consumer's spec is unreadable here (its key isn't
    // held until it installs), so the required set would be understated - which
    // would wrongly suppress a follower it needs. Refuse; the spawner's callers
    // already fall back to not suppressing this cycle.
    throw new Error('required-dependency computation incomplete: an assigned app\'s spec is unreadable on this node');
  }
  return computeRequiredDependencyNames(assigned, viewsByName);
}

/**
 * Locally-installed reapable followers (activation stopWhenUnneeded) that no
 * installed workload requires any more (transitive `shareWith`). These should
 * be removed. Based on what is actually installed here now, so removing the
 * last workload orphans the collectors it linked to.
 *
 * @returns {Promise<Array<object>>} orphaned follower InstantiatedSpecs
 */
async function findUnrequiredInstalledDependencies() {
  const installed = await appsRepository.listInstalledApps();
  if (!installed || !installed.length) {
    return [];
  }
  const { viewsByName, complete } = await buildViewsByName(installed);
  if (!complete) {
    // Incomplete spec visibility (an installed encrypted app whose key isn't
    // loaded yet - a transient boot window): never reap a follower we can't prove
    // is unrequired. Skip this pass; it self-heals once decryption is available.
    log.warn('findUnrequiredInstalledDependencies: spec visibility incomplete; skipping reap this pass');
    return [];
  }
  const required = computeRequiredDependencyNames(installed, viewsByName);
  const orphans = installed.filter((app) => app && app.name
    && isReapableFollower(viewsByName.get(app.name.toLowerCase()))
    && !required.has(app.name));

  // Ordered here rather than by the caller: a consumer must be removed before
  // the app it consumes, and the link that decides the order lives in the
  // sealed body for an encrypted app. Sorting on the sealed accessor silently
  // ordered encrypted orphans by nothing at all.
  return orphans.sort((a, b) => {
    const aLinks = linksOf(viewsByName, a.name.toLowerCase());
    const bLinks = linksOf(viewsByName, b.name.toLowerCase());
    if (aLinks.some((n) => n.toLowerCase() === b.name.toLowerCase())) return -1;
    if (bLinks.some((n) => n.toLowerCase() === a.name.toLowerCase())) return 1;
    return 0;
  });
}

/**
 * Attaches a freshly created component container to the private docker network
 * of every app the parent app is linked to, so it can reach the linked apps'
 * components. Throws on a real connection failure so the install is rolled back.
 *
 * Takes the DeploymentSpec rather than the InstantiatedSpec: `linkedApps` rides
 * the resolved view precisely so this attach works for an encrypted app, whose
 * sealed accessor reports no links at all. Both call sites already hold one.
 *
 * @param {string} componentContainerName - docker container name (flux<component>_<app>)
 * @param {object} deployment - DeploymentSpec of the parent app
 * @returns {Promise<void>}
 */
async function connectComponentToLinkedApps(componentContainerName, deployment) {
  const linkedApps = deployment ? deployment.linkedApps : [];
  if (!linkedApps || !linkedApps.length) {
    return;
  }

  // eslint-disable-next-line no-restricted-syntax
  for (const linkedApp of linkedApps) {
    const networkName = `fluxDockerNetwork_${linkedApp}`;
    try {
      // The linked app's network is a CROSS-APP host resource: its removal runs in
      // the linked app's teardown worker under the node-wide hostMutationLock. Take
      // the same lock per attach so this connect either lands before that network is
      // torn down or fails cleanly (rolling back this install) - never racing a
      // half-removed network. Per-call (leaf) granularity, matching the install
      // port-open loop; the connect is a single bounded docker call.
      // eslint-disable-next-line no-await-in-loop
      await withHostMutationLock(() => dockerService.appDockerNetworkConnect(componentContainerName, networkName));
      log.info(`Connected ${componentContainerName} to linked app network ${networkName}`);
    } catch (error) {
      // A dependency can vanish between the pre-install readiness check and this
      // attach (reaped, or its own expiry/cancel completed mid-install). If the
      // network is simply gone, that is a transient ordering condition - tag it so
      // the installer DEFERS and retries rather than hard-failing the consumer into
      // the 7-day error cache. A connect that failed for any other reason (the
      // network is present) is a real failure and propagates unchanged.
      // eslint-disable-next-line no-await-in-loop
      if (!(await dockerService.fluxDockerNetworkExists(networkName))) {
        const notReady = new Error(`Linked app network ${networkName} for '${deployment.appName}' disappeared during install; deferring`);
        notReady.code = NodeCondition.NETWORK_DEPENDENCY_NOT_READY;
        throw notReady;
      }
      throw error;
    }
  }
}

/**
 * The docker networks a consumer should currently be attached to for its declared
 * links: each linked name resolved to a currently-installed app owned by the SAME
 * owner. A link whose target is gone (expired, never installed) or has changed
 * hands (the name re-registered by a different owner after the original expired)
 * is dropped — convergence then treats its network as stale and disconnects,
 * rather than maintaining a dangling or cross-tenant bridge. This carries the
 * same-owner invariant that install enforces once (checkAppNetworkRequirements)
 * onto the post-install attach surfaces, where the trust decision is acted on
 * every pass. Uses the installed app's REGISTERED casing for the network name —
 * the name docker actually created — not the declared casing.
 *
 * @param {string} ownerId - the linking (consumer) app's owner
 * @param {string[]} linkedNames - declared linked app names
 * @returns {Promise<string[]>} fluxDockerNetwork_<name> for each valid link
 */
async function resolveActiveLinkedNetworks(ownerId, linkedNames) {
  if (!Array.isArray(linkedNames) || !linkedNames.length) {
    return [];
  }
  const networks = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const name of linkedNames) {
    // eslint-disable-next-line no-await-in-loop
    const installed = await appsRepository.getInstalledApp(name);
    if (installed && installed.owner === ownerId) {
      networks.push(`fluxDockerNetwork_${installed.name}`);
    }
  }
  return networks;
}

/**
 * TRANSITIONAL — remove once no pre-label fluxDockerNetwork_* networks remain in
 * the fleet. Whether a network is eligible for the reconciler to DISCONNECT a
 * container from. The forward-looking signal is the runonflux.app-network
 * ownership label; but docker cannot retro-stamp that label onto networks an
 * older FluxOS created, and only FluxOS ever creates the fluxDockerNetwork_
 * prefix, so we also accept that prefix for the reversible disconnect decision
 * (the connect/ownership decision is owner-validated upstream, never by name). To
 * retire: delete the prefix branch and revert callers to isFluxAppNetwork.
 *
 * @param {string} networkName
 * @returns {Promise<boolean>}
 */
async function isDisconnectEligibleFluxNetwork(networkName) {
  if (await dockerService.isFluxAppNetwork(networkName)) return true; // permanent signal
  return networkName.startsWith('fluxDockerNetwork_'); // transitional fallback
}

/**
 * Converges a container's docker-network memberships on the given desired set:
 * connects missing networks and disconnects stale flux app networks (a
 * membership no longer desired, e.g. an update dropped a shareWith link, or a
 * link resolved as gone/changed-hands). Networks docker or a user created are
 * never touched, and nothing outside the desired/actual diff is. Best-effort per
 * network: each change is a leaf docker call under the node-wide host mutation
 * lock (a linked network's removal runs in its app's teardown under the same
 * lock), failures are collected for the caller to pace a retry.
 *
 * @param {string} componentIdentifier - bare component identifier
 * @param {string[]} desiredNetworks - full desired membership (own + linked)
 * @param {string[]} actualNetworks - current memberships from docker inspect
 * @returns {Promise<{connected: string[], disconnected: string[], failed: string[]}>}
 */
async function ensureContainerNetworkMembership(componentIdentifier, desiredNetworks, actualNetworks) {
  const desired = new Set(desiredNetworks);
  const actual = new Set(actualNetworks);
  const connected = [];
  const disconnected = [];
  const failed = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const networkName of desired) {
    if (actual.has(networkName)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      await withHostMutationLock(() => dockerService.appDockerNetworkConnect(componentIdentifier, networkName));
      connected.push(networkName);
      log.info(`Connected ${componentIdentifier} to ${networkName}`);
    } catch (error) {
      failed.push(networkName);
      log.error(`ensureContainerNetworkMembership: failed to connect ${componentIdentifier} to ${networkName}: ${error.message}`);
    }
  }
  // eslint-disable-next-line no-restricted-syntax
  for (const networkName of actual) {
    if (desired.has(networkName)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      if (!(await isDisconnectEligibleFluxNetwork(networkName))) {
        // eslint-disable-next-line no-continue
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await withHostMutationLock(() => dockerService.appDockerNetworkDisconnect(componentIdentifier, networkName));
      disconnected.push(networkName);
      log.info(`Disconnected ${componentIdentifier} from stale ${networkName}`);
    } catch (error) {
      failed.push(networkName);
      log.error(`ensureContainerNetworkMembership: failed to disconnect ${componentIdentifier} from ${networkName}: ${error.message}`);
    }
  }
  return { connected, disconnected, failed };
}

/**
 * After an app's private network is (re)created, reconnects every locally
 * installed SAME-OWNER app that is networked with it back onto that network.
 * Best-effort — never throws, so a redeploy is not aborted by a reconnect
 * failure.
 *
 * @param {string} appName - the app whose network was (re)created
 * @returns {Promise<void>}
 */
async function reconnectLinkedApps(appName) {
  let installedApps;
  try {
    installedApps = await appsRepository.listInstalledApps();
  } catch (error) {
    log.error(`reconnectLinkedApps: failed to read installed apps for ${appName}: ${error.message}`);
    return;
  }

  const networkName = `fluxDockerNetwork_${appName}`;
  const lowerAppName = appName.toLowerCase();
  // The owner of the just-(re)created app. Only same-owner consumers may attach:
  // if this name changed hands (re-registered by a different owner after the
  // original expired), a foreign consumer's declared link must NOT bridge it in.
  const depApp = (installedApps || []).find((a) => a && a.name === appName);
  const depOwner = depApp ? depApp.owner : null;

  // Resolved views, not the sealed accessor: an encrypted consumer declares its
  // links inside the ciphertext and would otherwise never be reattached.
  const { viewsByName } = await buildViewsByName(installedApps || []);

  // eslint-disable-next-line no-restricted-syntax
  for (const app of installedApps || []) {
    if (!app || app.name === appName) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const linkedApps = linksOf(viewsByName, app.name.toLowerCase());
    if (!linkedApps.some((linked) => linked.toLowerCase() === lowerAppName)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    if (!depOwner || app.owner !== depOwner) {
      // eslint-disable-next-line no-continue
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const containerNames = await dockerService.getAppContainerNames(app.name);
      // eslint-disable-next-line no-restricted-syntax
      for (const containerName of containerNames) {
        // Same-lock attach as connectComponentToLinkedApps: never race a
        // concurrent teardown removing this network.
        // eslint-disable-next-line no-await-in-loop
        await withHostMutationLock(() => dockerService.appDockerNetworkConnect(containerName, networkName));
        log.info(`Reconnected linked app ${containerName} to ${networkName}`);
      }
    } catch (error) {
      log.error(`reconnectLinkedApps: failed to reconnect ${app.name} to ${networkName}: ${error.message}`);
    }
  }
}

/**
 * Boot-time sweep: ensures every installed app that declares network links is
 * attached to each linked app's network. Idempotent and best-effort.
 *
 * @returns {Promise<void>}
 */
async function reconcileAllAppNetworkLinks() {
  let installedApps;
  try {
    installedApps = await appsRepository.listInstalledApps();
  } catch (error) {
    log.error(`reconcileAllAppNetworkLinks: failed to read installed apps: ${error.message}`);
    return;
  }

  // Resolved views, not the sealed accessor: an encrypted app declares its links
  // inside the ciphertext, so the boot sweep would otherwise never bridge it.
  const { viewsByName } = await buildViewsByName(installedApps || []);

  // eslint-disable-next-line no-restricted-syntax
  for (const app of installedApps || []) {
    // Only attach to links that resolve to a currently-installed same-owner app —
    // a departed or changed-hands link is not (re)bridged at boot.
    // eslint-disable-next-line no-await-in-loop
    const desiredNetworks = await resolveActiveLinkedNetworks(
      app.owner, linksOf(viewsByName, app.name.toLowerCase()),
    );
    if (!desiredNetworks.length) {
      // eslint-disable-next-line no-continue
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const containerNames = await dockerService.getAppContainerNames(app.name);
      // eslint-disable-next-line no-restricted-syntax
      for (const networkName of desiredNetworks) {
        // eslint-disable-next-line no-restricted-syntax
        for (const containerName of containerNames) {
          // Same-lock attach as connectComponentToLinkedApps: never race a
          // concurrent teardown removing this network.
          // eslint-disable-next-line no-await-in-loop
          await withHostMutationLock(() => dockerService.appDockerNetworkConnect(containerName, networkName)).catch((error) => {
            log.error(`reconcileAllAppNetworkLinks: failed to connect ${containerName} to ${networkName}: ${error.message}`);
          });
        }
      }
    } catch (error) {
      log.error(`reconcileAllAppNetworkLinks: failed for ${app.name}: ${error.message}`);
    }
  }
}

module.exports = {
  isAppRunning,
  isPureFollower,
  isPureFollowerApp,
  pureFollowerNames,
  isReapableFollower,
  checkAppNetworkRequirements,
  linksReadyForSelection,
  computeRequiredDependencyNames,
  findInstalledWorkloadsRequiring,
  getRequiredDependencyNamesForNode,
  findUnrequiredInstalledDependencies,
  connectComponentToLinkedApps,
  resolveActiveLinkedNetworks,
  isDisconnectEligibleFluxNetwork,
  ensureContainerNetworkMembership,
  reconnectLinkedApps,
  reconcileAllAppNetworkLinks,
};
