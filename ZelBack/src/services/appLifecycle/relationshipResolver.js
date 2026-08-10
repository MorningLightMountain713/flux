'use strict';

/**
 * Relationship Resolver
 *
 * The single owner of the inter-app dependency graph on this node: exists,
 * same-owner, co-location, ref-count, cascade. Reads the normalized edge
 * accessors (`dependencyEntries()` — v9's typed `dependencies` field, or the
 * edges FluxAppSpecV8 synthesizes from its description DSL) and the
 * `activation` dials, and answers every lifecycle question the edges pose:
 *
 *  - may this app be selected/installed here yet? (install gate, root-first
 *    selection ordering)
 *  - which followers does this node's assigned set require? (pull-in /
 *    suppression)
 *  - which installed followers does nothing hold any more? (ref-count reap)
 *  - who must be uninstalled before this app may be? (onRemove cascade)
 *
 * The network-attach plumbing (docker network connect/disconnect/convergence)
 * stays in appNetworkLinker, which consumes the same edges through the
 * `linkedAppNames()` projection. This module is event/deferred-call driven,
 * never bus-subscribed (fluxEventBus is publish-only test observability).
 *
 * Runtime scope: the existence axis (§7 of APP_RELATIONSHIPS.md) — presence,
 * ref-count, cascade — plus the coarse install gate. The fine-grained
 * running-axis wiring (per-edge `after`/`condition` start gates through
 * containerEventBridge, boundTo's stop-and-return watch) is not built yet;
 * the appRelationships feature bit stays ungranted until it is.
 */

const config = require('config');
const appsRepository = require('../appDatabase/appsRepository');
const { resolveInstantiatedSpec } = require('../utils/specCutover');
const dockerService = require('../dockerService');
const { socketAddressesMatch } = require('../utils/socketAddressUtils');
const { NodeCondition } = require('./nodeConditions');
const log = require('../../lib/log');

/**
 * Whether every container belonging to an installed app is currently running.
 * Docker-listing based (the local DB blanks enterprise compose, so iterating
 * the spec would miss components), so it works for enterprise apps too. False
 * when the app has no containers.
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
 * Whether an app is a pure follower — `activation.standalone === false`: it
 * has no independent run decision and exists on a node only while a
 * same-owner app there declares an edge to it (the successor to the v8
 * dependencyOnly marker, e.g. a shared stats collector).
 *
 * Takes a READABLE spec view, not an InstantiatedSpec: whether the spec had
 * to be decrypted was settled by whoever resolved the view, so this stays a
 * plain question about a spec's fields. A null view is an app whose spec
 * could not be read here — standalone, which is the fail-toward-keeping
 * answer (never reap or suppress on incomplete visibility).
 *
 * @param {object|null} view - readable spec view (FluxAppSpec* | DecryptedCanonicalSpec)
 * @returns {boolean}
 */
function isPureFollower(view) {
  const activation = view && view.activation;
  return !!activation && activation.standalone === false;
}

/**
 * Whether an app self-cleans: `activation.stopWhenUnneeded === true`. Being
 * reap-ELIGIBLE additionally needs nothing holding it — see
 * findUnrequiredInstalledDependencies, which weighs the holds (installed
 * requirers, and for a standalone app its own placement here).
 *
 * @param {object|null} view - readable spec view
 * @returns {boolean}
 */
function isStopWhenUnneeded(view) {
  const activation = view && view.activation;
  return !!activation && activation.stopWhenUnneeded === true;
}

/**
 * Resolves a set of apps to their READABLE spec views, keyed by lowercased
 * name, so the pure graph traversals below can reason over an encrypted
 * app's real edges and activation (the sealed vantage reports neither).
 *
 * Resolving the view rather than extracting one field means one decrypt per
 * app however many fields the traversals read. An app whose spec can't be
 * read on this node maps to `null` and flips `complete` false — the signal
 * for the reap/suppression callers to fail toward keeping rather than act
 * blind.
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
 * The dependency edges an app declares, read off its resolved view. An
 * unreadable view contributes no edges; `complete` (above) is what tells a
 * caller that absence means "unknown" rather than "none".
 *
 * @param {Map<string, object|null>} viewsByName
 * @param {string} nameLower
 * @returns {Array<[string, object]>} [targetName, edge] pairs
 */
function edgesOf(viewsByName, nameLower) {
  const view = viewsByName.get(nameLower);
  return view && typeof view.dependencyEntries === 'function' ? view.dependencyEntries() : [];
}

/**
 * Whether one app is a pure follower, resolving its spec first. For callers
 * holding an InstantiatedSpec rather than a view; an app whose spec cannot
 * be read here answers false (standalone), the fail-toward-keeping answer.
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
 * An app's spec view WITHOUT decrypting: the spec itself while it is
 * readable, null while it is still sealed. Asks `sealed` — "are your
 * contents still ciphertext?" — rather than `isEncrypted`, which stays true
 * on a readable decrypted view.
 *
 * The cheap counterpart to resolving, for callers that have not committed to
 * installing and must not pay a decrypt. A cleartext app answers fully here;
 * an encrypted one answers nothing, which is the price of not decrypting.
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
 * `shouldResolve` decides per app whether to pay a decrypt. The spawner
 * passes "is this app pinned to this node": a pinned app will be installed
 * here, so it is decrypted moments later anyway, while the general pool is
 * many candidates for at most one install and must stay sealed. An app that
 * is neither pinned nor readable is reported standalone — the
 * fail-toward-keeping answer.
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
 * Given a set of apps and their resolved (decrypted) edges, returns the set
 * of follower-app names that are *required*: the transitive dependency
 * closure starting from the apps that can stand alone
 * (activation.standalone !== false), over edges of EVERY strength — a wants
 * edge holds its target on the node just as a requires edge does; strength
 * governs the running axis, not presence. Edges are only followed between
 * apps of the same owner. Original-cased names are returned; matching is
 * case-insensitive.
 *
 * Starting the closure from standalone apps only (not every app in the set)
 * is what lets a pure follower fall out of the required set once nothing
 * links to it — otherwise a collector, being present itself, would keep
 * itself alive.
 *
 * Pure over its inputs: every spec read comes from `viewsByName` (resolved
 * by the async caller), never fetched here.
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
    const edges = edgesOf(viewsByName, current.name.toLowerCase());
    // eslint-disable-next-line no-restricted-syntax
    for (const [targetName] of edges) {
      const dep = byName.get(targetName.toLowerCase());
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
 * Whether a workload transitively depends on `depNameLower`, following
 * same-owner edges of any strength. Breadth-first over the resolved graph.
 * `hopQualifies`, when given, restricts which edges count (the cascade
 * closure passes the onRemove predicate).
 *
 * @param {object} workload - root InstantiatedSpec
 * @param {string} depNameLower - lowercased target name to look for
 * @param {Map<string, object>} byName - lowercased-name -> InstantiatedSpec
 * @param {Map<string, object|null>} viewsByName - lowercased-name -> readable view
 * @param {(edge: object) => boolean} [hopQualifies] - defaults to every edge
 * @returns {boolean}
 */
function appTransitivelyRequires(workload, depNameLower, byName, viewsByName, hopQualifies = () => true) {
  const visited = new Set([workload.name.toLowerCase()]);
  const queue = [workload];
  while (queue.length) {
    const current = queue.shift();
    const edges = edgesOf(viewsByName, current.name.toLowerCase());
    // eslint-disable-next-line no-restricted-syntax
    for (const [targetName, edge] of edges) {
      const key = targetName.toLowerCase();
      const dep = byName.get(key);
      // Only same-owner edges to present apps are real dependencies (mirrors
      // computeRequiredDependencyNames); a cross-owner/dangling edge is
      // ignored, as is one the predicate rules out.
      if (!dep || dep.owner !== workload.owner || !hopQualifies(edge)) {
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
 * Locally-installed apps that must be uninstalled BEFORE `depName` may be —
 * the onRemove cascade set, consumers first. Two rules, one declared and one
 * transitional:
 *
 *  - **Declared (v9):** an app reaching `depName` through a chain whose
 *    every hop declares `onRemove: "cascade"` asked to not outlive it. A
 *    `detach` hop breaks the chain — that app keeps running and degrades,
 *    which was its author's explicit choice (OQ5: no default on the middle
 *    rung).
 *  - **Legacy (retires with v8 registrations):** when `depName` is a pure
 *    follower, every workload transitively requiring it cascades regardless
 *    of edge declarations — the v8 model welded maximal coupling toward a
 *    dependencyOnly target, and the v8 shim's synthesized edges cannot carry
 *    that target-conditional rule themselves.
 *
 * Intermediate followers are not returned — they unwind through the
 * ref-count reap once their workloads are gone (matching the existing
 * uninstaller flow).
 *
 * @param {string} depName - app name being removed
 * @returns {Promise<Array<object>>} requiring InstantiatedSpecs, cascade-bound
 */
async function findCascadeWorkloadsRequiring(depName) {
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
  const targetIsPureFollower = isPureFollower(viewsByName.get(target));

  return installed.filter((app) => {
    if (!app || !app.name || app.name.toLowerCase() === target) return false;
    const isWorkload = !isPureFollower(viewsByName.get(app.name.toLowerCase()));
    // Declared cascade chain — any app, workload or follower, that asked.
    if (appTransitivelyRequires(
      app, target, byName, viewsByName, (edge) => edge && edge.onRemove === 'cascade',
    )) {
      return true;
    }
    // Legacy pure-follower rule — workloads only, any-edge closure.
    return targetIsPureFollower && isWorkload
      && appTransitivelyRequires(app, target, byName, viewsByName);
  });
}

/**
 * The follower-app names that should be present on this node, computed from
 * every global app whose placement targets this node. Used by the spawner to
 * suppress a pure follower that nothing here requires.
 *
 * @param {object} nodeIdentity - { ip, outpoint, operator } of this node
 * @returns {Promise<Set<string>>}
 * @throws when an assigned app's edges can't be read here — the caller falls
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
    // held until it installs), so the required set would be understated —
    // which would wrongly suppress a follower it needs. Refuse; the spawner's
    // callers already fall back to not suppressing this cycle.
    throw new Error('required-dependency computation incomplete: an assigned app\'s spec is unreadable on this node');
  }
  return computeRequiredDependencyNames(assigned, viewsByName);
}

/**
 * Locally-installed self-cleaning apps (activation.stopWhenUnneeded) that
 * nothing holds any more. These should be removed. Two holds exist (§7 of
 * APP_RELATIONSHIPS.md — the presence axis is install-level, deliberately
 * coarse):
 *
 *  - an installed app transitively depending on it (any strength);
 *  - for a standalone app, its own placement targeting this node — a
 *    (standalone: true, stopWhenUnneeded: true) shared app an operator
 *    deployed here on purpose holds itself, while the same app pulled onto a
 *    node purely as a dependency does not, and is reaped when its last
 *    requirer leaves. This is the provenance question answered from the
 *    signed placement rather than persisted install-time state.
 *
 * `nodeIdentity` is what the self-hold is judged against. Without it a
 * standalone app is never reaped (fail toward keeping); a pure follower has
 * no self-hold either way.
 *
 * @param {object} [options]
 * @param {object} [options.nodeIdentity] - { ip, outpoint, operator } of this node
 * @returns {Promise<Array<object>>} orphaned follower InstantiatedSpecs, consumers first
 */
async function findUnrequiredInstalledDependencies(options = {}) {
  const { nodeIdentity } = options;
  const installed = await appsRepository.listInstalledApps();
  if (!installed || !installed.length) {
    return [];
  }
  const { viewsByName, complete } = await buildViewsByName(installed);
  if (!complete) {
    // Incomplete spec visibility (an installed encrypted app whose key isn't
    // loaded yet — a transient boot window): never reap an app we can't prove
    // is unheld. Skip this pass; it self-heals once decryption is available.
    log.warn('findUnrequiredInstalledDependencies: spec visibility incomplete; skipping reap this pass');
    return [];
  }
  const required = computeRequiredDependencyNames(installed, viewsByName);
  const { ip, outpoint, operator } = nodeIdentity || {};
  const selfHeld = (app) => {
    const view = viewsByName.get(app.name.toLowerCase());
    if (isPureFollower(view)) return false;
    // Standalone: its own placement here is a hold. Unverifiable identity —
    // no nodeIdentity given, or no placement to ask — holds too (fail toward
    // keeping, never reap on incomplete visibility).
    if ((!ip && !outpoint && !operator) || !app.placement
      || typeof app.placement.isPinnedTo !== 'function') {
      return true;
    }
    return app.placement.isPinnedTo({
      ip, outpoint, operator, ipMatcher: socketAddressesMatch,
    });
  };
  const orphans = installed.filter((app) => app && app.name
    && isStopWhenUnneeded(viewsByName.get(app.name.toLowerCase()))
    && !required.has(app.name)
    && !selfHeld(app));

  // Ordered here rather than by the caller: a consumer must be removed before
  // the app it consumes, and the edge that decides the order lives in the
  // sealed body for an encrypted app. Sorting on the sealed accessor silently
  // ordered encrypted orphans by nothing at all.
  return orphans.sort((a, b) => {
    const aEdges = edgesOf(viewsByName, a.name.toLowerCase());
    const bEdges = edgesOf(viewsByName, b.name.toLowerCase());
    if (aEdges.some(([n]) => n.toLowerCase() === b.name.toLowerCase())) return -1;
    if (bEdges.some(([n]) => n.toLowerCase() === a.name.toLowerCase())) return 1;
    return 0;
  });
}

/**
 * Verifies the gating edges of an app: each target that is not a `wants`
 * edge must be installed locally and same-owner; when the node-managed
 * collector lifecycle is on, also running. A `wants` edge never gates —
 * optional means the app starts without it (the network attach for a
 * present wants target still happens; an absent one is simply skipped by
 * the convergence plumbing). Throws on the first unsatisfied edge —
 * transient conditions tagged NETWORK_DEPENDENCY_NOT_READY so callers defer
 * and retry rather than hard-failing into the spawner's error cache.
 *
 * @param {string} appName - the app declaring the edges (for messages)
 * @param {string} owner - its owner, for the same-owner rule
 * @param {Array<[string, object]>} entries - declared [target, edge] pairs
 * @returns {Promise<boolean>}
 */
async function verifyDependencies(appName, owner, entries) {
  // eslint-disable-next-line no-restricted-syntax
  for (const [targetName, edge] of entries) {
    if (edge && edge.strength === 'wants') {
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const installed = await appsRepository.getInstalledApp(targetName);
    if (!installed) {
      // Transient ordering condition, not a misconfiguration: the dependency
      // may simply not be installed yet. Tagged so callers can defer and
      // retry instead of treating it as a hard install failure.
      const error = new Error(`App '${targetName}' that '${appName}' depends on is not installed on this node. Installation aborted.`);
      error.code = NodeCondition.NETWORK_DEPENDENCY_NOT_READY;
      throw error;
    }
    if (installed.owner !== owner) {
      throw new Error(`App '${targetName}' that '${appName}' depends on is owned by a different owner. Installation aborted.`);
    }
    // When the node-managed collector lifecycle is on, require the dependency
    // to be actually running — not merely installed — so this app's
    // docker-network attach and log routing land on a live container. Tagged
    // transient so callers defer and retry rather than hard-failing.
    if (config.fluxapps.manageCollectorLifecycle) {
      // eslint-disable-next-line no-await-in-loop
      const running = await isAppRunning(targetName);
      if (!running) {
        const error = new Error(`App '${targetName}' that '${appName}' depends on is installed but not running yet. Installation deferred.`);
        error.code = NodeCondition.NETWORK_DEPENDENCY_NOT_READY;
        throw error;
      }
    }
  }
  if (entries.length) {
    log.info(`App dependencies satisfied for ${appName}: ${entries.map(([n]) => n).join(', ')}`);
  }
  return true;
}

/**
 * Selection-time readiness, run by the spawner over every candidate on every
 * cycle. Reads the SEALED vantage and NEVER decrypts: an app's cleartext
 * metadata exists so a node can decide whether to install without
 * decrypting, and this runs long before the node has committed to anything.
 *
 * An encrypted app's edges are therefore invisible here and it is reported
 * ready. That is deliberate — this is an ordering optimisation (install a
 * dependency before its consumer), not a correctness gate. The gate is
 * `checkAppDependencyRequirements`, which runs once the node has committed
 * and is decrypting the app anyway.
 *
 * @param {object} instantiated - InstantiatedSpec instance of the candidate
 * @returns {Promise<boolean>} true when the app may be selected this cycle
 */
async function dependenciesReadyForSelection(instantiated) {
  const view = instantiated ? readableViewOrNull(instantiated) : null;
  const entries = view && typeof view.dependencyEntries === 'function' ? view.dependencyEntries() : [];
  if (!entries.length) {
    return true;
  }
  return verifyDependencies(instantiated.name, instantiated.owner, entries);
}

/**
 * The install-time gate: verifies every gating edge of this app resolves —
 * target installed locally, same owner (and, with the node-managed collector
 * lifecycle on, running). Throws otherwise, aborting or deferring the
 * install/redeploy.
 *
 * Reads the edges off the app's RESOLVED view, because the sealed accessor
 * reports none for an encrypted app and the gate would pass vacuously. Every
 * caller is a path the node has already committed to and is decrypting for
 * anyway, so the resolve costs nothing extra — keep it that way: this must
 * not be called from a selection or polling loop.
 *
 * @param {object} instantiated - InstantiatedSpec instance of the parent app
 * @returns {Promise<boolean>} true when all gating edges are satisfied
 */
async function checkAppDependencyRequirements(instantiated) {
  if (!instantiated) return true;

  const view = await resolveInstantiatedSpec(instantiated).catch(() => null);
  if (!view) {
    // The node installing an app can normally decrypt it. Failing here means
    // the edges cannot be checked at all, so defer rather than install blind:
    // tagged transient, like a dependency that has not arrived yet.
    const error = new Error(`App '${instantiated.name}' could not be decrypted on this node to check its dependencies. Installation deferred.`);
    error.code = NodeCondition.NETWORK_DEPENDENCY_NOT_READY;
    throw error;
  }

  const entries = typeof view.dependencyEntries === 'function' ? view.dependencyEntries() : [];
  if (!entries.length) {
    return true;
  }
  return verifyDependencies(view.name, view.owner, entries);
}

module.exports = {
  isAppRunning,
  isPureFollower,
  isStopWhenUnneeded,
  isPureFollowerApp,
  pureFollowerNames,
  readableViewOrNull,
  buildViewsByName,
  edgesOf,
  computeRequiredDependencyNames,
  appTransitivelyRequires,
  findCascadeWorkloadsRequiring,
  getRequiredDependencyNamesForNode,
  findUnrequiredInstalledDependencies,
  verifyDependencies,
  dependenciesReadyForSelection,
  checkAppDependencyRequirements,
};
