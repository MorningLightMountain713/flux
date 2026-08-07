// The mesh reconciler: the one place the appMesh libraries compose into a
// running overlay. Level-based like the container reconciler — every pass
// reads what exists (rows, files, interfaces, units, the peer table), writes
// only what differs, and heals whatever a crash or reboot left behind. One
// failing app never blocks the others; whatever could not converge this pass
// is retried on the next.
//
// A full pass, in order:
//   1. material  — per app: authority, host certificate, transport port,
//      candidate evaluation, trust bundle, nebula config
//   2. snapshot  — node-wide: the resolver feed (also the presented-IPv4
//      ledger), then each app's tayga map from the same assignment
//   3. runtime   — per app: namespace, transit uplink, units, reload with
//      read-back, container attachments
//   4. chains    — the FLUX-MESH iptables chains, union of every app
//   5. detector  — per app: the peer table judged against the derivation;
//      an eviction rebuilds that app's material and must prove convergence
const fsp = require('node:fs/promises');
const path = require('node:path');

const config = require('config');

const log = require('../../lib/log');
const appsRepository = require('../appDatabase/appsRepository');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const dockerService = require('../dockerService');
const daemonServiceMiscRpcs = require('../daemonService/daemonServiceMiscRpcs');
const daemonServiceBlockchainRpcs = require('../daemonService/daemonServiceBlockchainRpcs');
const generalService = require('../generalService');
const networkStateService = require('../networkStateService');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const { getSpec } = require('../utils/specLibs');
const { resolveInstantiatedSpec } = require('../utils/specCutover');

const meshDerivation = require('./meshDerivation');
const meshCertificates = require('./meshCertificates');
const meshMembership = require('./meshMembership');
const meshRefuseSet = require('./meshRefuseSet');
const meshRuntimeConfig = require('./meshRuntimeConfig');
const meshNamespace = require('./meshNamespace');
const meshTransit = require('./meshTransit');
const meshSsh = require('./meshSsh');
const meshSnapshot = require('./meshSnapshot');
const meshPortAllocator = require('./meshPortAllocator');
const meshDetector = require('./meshDetector');

const { HostCertificateAction } = meshCertificates;

// The container's resolver chain: flux-dnsd first (mesh names, forwards the
// rest to the host's resolvers), then two public fallbacks consulted only
// while flux-dnsd is down — the app loses mesh names during an outage, never
// all of DNS. Google before Cloudflare: it forwards EDNS client subnet, so
// CDN names keep geo-steering in exactly the scenario the fallbacks serve.
const MESH_DNS_SERVERS = Object.freeze([
  config.server.fluxDnsdServiceAddress ?? '169.254.43.53', '8.8.8.8', '1.1.1.1',
]);

const NEBULA_CONFIG_FILE = 'config.yml';
const TAYGA_CONFIG_FILE = 'tayga.conf';

async function readIfPresent(filePath) {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeFileIfChanged(target, content) {
  const current = await readIfPresent(target);
  if (current === content) return false;
  const tmp = `${target}.tmp`;
  await fsp.writeFile(tmp, content);
  await fsp.rename(tmp, target);
  return true;
}

/**
 * The outpoints entitled to host an app, or null when placement is
 * unrestricted (a lottery has no owner-signed host set to check against).
 * Candidate and pinned placement both carry a bounded identity set; IPs and
 * operator keys resolve to outpoints through the deterministic node list, and
 * a target that does not resolve right now simply contributes nothing this
 * pass.
 *
 * @param {object|null} placement the spec's Placement domain object
 * @returns {Promise<Set<string>|null>}
 */
async function hostingOutpointsFor(placement) {
  if (!placement || placement.mode() === 'none' || !placement.hasTargets()) return null;
  const outpoints = new Set();
  placement.targetOutpoints.forEach((outpoint) => {
    const [txhash, outidx] = outpoint.split(':');
    outpoints.add(meshDerivation.canonicalOutpoint(txhash, outidx));
  });
  // eslint-disable-next-line no-restricted-syntax
  for (const ip of placement.targetIps) {
    // eslint-disable-next-line no-await-in-loop
    const node = await networkStateService.getFluxnodeBySocketAddress(ip);
    if (node) outpoints.add(meshDerivation.canonicalOutpoint(node.txhash, node.outidx));
  }
  // eslint-disable-next-line no-restricted-syntax
  for (const pubkey of placement.targetOperators) {
    // eslint-disable-next-line no-await-in-loop
    const nodes = await networkStateService.getFluxnodesByPubkey(pubkey);
    if (nodes) {
      nodes.forEach((node) => outpoints.add(meshDerivation.canonicalOutpoint(node.txhash, node.outidx)));
    }
  }
  return outpoints;
}

/**
 * Each announced anchor hash resolved to a height from THIS node's chain —
 * the broadcast's claimed height is never consulted (the voucher covers only
 * the hash). A hash the daemon does not know, or knows only off the main
 * chain, resolves to null and fails the freshness check downstream.
 *
 * @param {Array<{meshAnchor: {hash: string}|null}>} rows
 * @returns {Promise<Map<string, number|null>>}
 */
async function anchorHeightsFor(rows) {
  const heights = new Map();
  const hashes = new Set(rows.map((row) => row.meshAnchor?.hash).filter(Boolean));
  // eslint-disable-next-line no-restricted-syntax
  for (const hash of hashes) {
    // eslint-disable-next-line no-await-in-loop
    const response = await daemonServiceBlockchainRpcs.getBlock({ hashheight: hash, verbosity: 1 });
    const block = response?.status === 'success' ? response.data : null;
    heights.set(hash, Number.isInteger(block?.height) && block.confirmations !== -1 ? block.height : null);
  }
  return heights;
}

/**
 * Every installed app whose resolved view enables mesh, with what a pass
 * needs: the registration identity and the cleartext view (placement,
 * components). Apps whose spec cannot be resolved or that predate identity
 * minting are skipped loudly — without the uuid there is no derivation.
 */
// What the last pass decided, per app — the operator surface's read. Members
// are kept without their PEM bundles (identity facts, not material).
const lastPassByApp = new Map();

const memberFacts = (member) => ({
  outpoint: member.outpoint,
  nodeId: member.nodeId,
  address: member.address,
  block: member.block,
  endpoint: member.endpoint,
  caShas: member.caShas,
});

function recordPass(appName, patch) {
  const prior = lastPassByApp.get(appName) ?? {};
  lastPassByApp.set(appName, { ...prior, at: Date.now(), ...patch });
}

/**
 * The retained outcome of the app's most recent pass, or null before one has
 * run (or for an app no gather has seen).
 *
 * @param {string} appName
 * @returns {object|null}
 */
function lastPassStatus(appName) {
  const status = lastPassByApp.get(appName);
  return status ? structuredClone(status) : null;
}

async function gatherMeshApps() {
  const installed = await appsRepository.listInstalledApps();
  const apps = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const inst of installed) {
    // eslint-disable-next-line no-await-in-loop
    const view = await resolveInstantiatedSpec(inst);
    if (view?.network?.mesh !== true) continue; // eslint-disable-line no-continue
    if (!inst.uuid || !inst.identity) {
      log.warn(`meshReconciler - ${inst.name} is mesh-enabled but carries no registration uuid; skipped`);
      continue; // eslint-disable-line no-continue
    }
    apps.push({
      name: inst.name,
      uuid: inst.uuid,
      identity: inst.identity,
      view,
    });
  }
  return apps;
}

/**
 * Per-app material: certificates, transport port, membership, trust bundle,
 * nebula config. Pure convergence against disk — no processes are touched;
 * the returned flags say what the runtime phase must reload.
 */
async function reconcileAppMaterial(app, ctx) {
  const ref = { instance: app.identity, appUuid: app.uuid, outpoint: ctx.ownOutpoint };
  await meshCertificates.ensureAuthority(ref);
  const certAction = await meshCertificates.reconcileHostCertificate(ref);
  await meshSsh.ensureHostKey(app.identity);
  const meshPort = await meshPortAllocator.ensureTransportPort(app.identity);

  const rows = await appsRepository.appLocationFromEvents({ appname: app.name });
  const { members, rejected } = await meshMembership.evaluateCandidates({
    appUuid: app.uuid,
    ownOutpoint: ctx.ownOutpoint,
    rows,
    tipHeight: ctx.tipHeight,
    anchorHeights: await anchorHeightsFor(rows),
    hostingOutpoints: await hostingOutpointsFor(app.view.placement),
    refused: await meshRefuseSet.refusedOutpoints(app.identity),
  });

  const bundleChanged = await meshCertificates.writeTrustBundle(
    app.identity,
    members.map((member) => member.meshCa),
  );
  const configText = meshRuntimeConfig.nebulaConfig({
    instance: app.identity,
    appUuid: app.uuid,
    outpoint: ctx.ownOutpoint,
    listenPort: meshPort,
    members,
    sshClientPublicKey: ctx.sshClientPublicKey,
  });
  const configPath = path.join(meshCertificates.meshAppDir(app.identity), NEBULA_CONFIG_FILE);
  const configChanged = await writeFileIfChanged(configPath, configText);

  return {
    members,
    rejected,
    meshPort,
    certAction,
    needsReload: bundleChanged || configChanged || certAction === HostCertificateAction.DEPLOYED,
  };
}

/**
 * This node's running containers for an app: per component, the container's
 * init pid (veth attachment) and its bridge address (the resolver's scoping
 * table). Components whose container is absent or stopped are simply not
 * listed this pass.
 */
async function gatherContainers(app) {
  const containers = [];
  const deployments = await deploymentProvider.getInstalledDeployments(app.name);
  // eslint-disable-next-line no-restricted-syntax
  for (const deployment of deployments) {
    // eslint-disable-next-line no-restricted-syntax
    for (const [componentName, component] of deployment.componentEntries()) {
      // eslint-disable-next-line no-await-in-loop
      const info = await dockerService.dockerContainerInspect(component.identifier);
      const pid = info?.State?.Pid;
      if (!Number.isInteger(pid) || pid <= 0) continue; // eslint-disable-line no-continue
      const networks = info?.NetworkSettings?.Networks ?? {};
      const bridge = networks[`fluxDockerNetwork_${app.name}`] ?? Object.values(networks)[0];
      containers.push({
        component: componentName,
        identifier: component.identifier,
        pid,
        sourceIp: bridge?.IPAddress || null,
      });
    }
  }
  return containers;
}

/**
 * The snapshot's per-app entry: every member of the overlay (this node's
 * components and every accepted peer's), deterministically ordered, plus the
 * scoping table of local containers.
 */
function buildSnapshotApp(app, ctx) {
  const members = [];
  const componentNames = app.view.componentNames();
  componentNames.forEach((component) => {
    members.push({ component, nodeId: ctx.ownNodeId });
    app.material.members.forEach((member) => {
      members.push({ component, nodeId: member.nodeId });
    });
  });
  members.sort((a, b) => (a.component === b.component
    ? (a.nodeId < b.nodeId ? -1 : 1)
    : (a.component < b.component ? -1 : 1)));
  const containers = app.containers
    .filter((container) => container.sourceIp)
    .map((container) => ({ component: container.component, sourceIp: container.sourceIp }))
    .sort((a, b) => (a.component < b.component ? -1 : 1));
  return { name: app.name, members, containers };
}

/**
 * The node-wide phase: deploy the resolver snapshot when the membership it
 * describes changed (its address assignment is the ledger both consumers
 * read), then each app's tayga map from that assignment.
 */
async function reconcileSnapshotAndTayga(apps, ctx) {
  const snapApps = apps.map((app) => buildSnapshotApp(app, ctx));
  const previous = await meshSnapshot.readCurrentSnapshot();
  const addresses = meshSnapshot.assignMemberAddresses(previous, snapApps);
  const withIps = snapApps.map((snapApp) => ({
    ...snapApp,
    members: snapApp.members.map((member) => ({
      ...member,
      ip: addresses.get(`${snapApp.name}|${member.nodeId}|${member.component}`),
    })),
  }));
  const unchanged = previous
    && JSON.stringify(previous.apps) === JSON.stringify(withIps.map((a) => ({
      name: a.name, members: a.members, containers: a.containers,
    })));
  if (!unchanged) {
    await meshSnapshot.writeSnapshot(ctx.ownNodeId, snapApps);
  }

  // eslint-disable-next-line no-restricted-syntax
  for (const app of apps) {
    const outpointOf = new Map(app.material.members.map((m) => [m.nodeId, m.outpoint]));
    outpointOf.set(ctx.ownNodeId, ctx.ownOutpoint);
    const mapEntries = [];
    // eslint-disable-next-line no-restricted-syntax
    for (const component of app.view.componentNames()) {
      const slot = app.slots.get(component);
      // eslint-disable-next-line no-restricted-syntax
      for (const nodeId of [ctx.ownNodeId, ...app.material.members.map((m) => m.nodeId)]) {
        const ipv4 = addresses.get(`${app.name}|${nodeId}|${component}`);
        if (!ipv4) continue; // eslint-disable-line no-continue
        mapEntries.push({
          ipv4,
          ipv6: meshDerivation.memberAddress(app.uuid, outpointOf.get(nodeId), slot),
        });
      }
    }
    const text = meshRuntimeConfig.taygaConfig({
      instance: app.identity, appUuid: app.uuid, outpoint: ctx.ownOutpoint, mapEntries,
    });
    const taygaPath = path.join(meshCertificates.meshAppDir(app.identity), TAYGA_CONFIG_FILE);
    // eslint-disable-next-line no-await-in-loop
    app.taygaChanged = await writeFileIfChanged(taygaPath, text);
    app.addresses = addresses;
  }
}

/**
 * The runtime phase for one app: namespace, transit uplink, units, reloads
 * with read-back, container attachments. Everything here is a probe-first
 * converge — a healthy runtime is left untouched.
 */
async function reconcileAppRuntime(app, ctx) {
  const instance = app.identity;
  await meshNamespace.ensureNamespace(instance);
  const transit = await meshTransit.ensureTransit(instance);
  app.transit = transit;
  const liveSlot = await meshTransit.observedSlot(instance);
  if (liveSlot !== transit.slot) {
    await meshNamespace.ensureUplink(instance, transit);
  }
  await meshNamespace.enableForwarding(instance);

  const wasActive = await meshNamespace.meshUnits.nebulaActive(instance);
  await meshNamespace.meshUnits.startAll(instance);
  if (wasActive && app.taygaChanged) {
    await meshNamespace.meshUnits.restartTayga(instance);
  }
  await meshNamespace.ensureTranslatorRoutes(instance, {
    ownBlock: meshDerivation.nodeBlock(app.uuid, ctx.ownOutpoint),
  });

  if (wasActive && app.material.needsReload) {
    await meshNamespace.meshUnits.reloadNebula(instance);
    if (app.material.certAction === HostCertificateAction.DEPLOYED) {
      // The renewal read-back: the certificate the daemon serves must be the
      // one just deployed. A mismatch means the reload silently failed.
      const onDisk = await meshCertificates.certificateDetails(
        path.join(meshCertificates.meshAppDir(instance), 'host.crt'),
      );
      const live = await meshSsh.printOwnCert(instance).catch(() => null);
      if (!onDisk || !live || live.fingerprint !== onDisk.fingerprint) {
        log.error(`meshReconciler - ${app.name}: nebula still serves the previous host certificate after reload; retrying next pass`);
      }
    }
  }

  // eslint-disable-next-line no-restricted-syntax
  for (const container of app.containers) {
    const presentedIp = app.addresses.get(`${app.name}|${ctx.ownNodeId}|${container.component}`);
    if (!presentedIp) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const attached = await meshNamespace.containerAttachment(container.pid);
    if (attached !== presentedIp) {
      const slot = app.slots.get(container.component);
      // eslint-disable-next-line no-await-in-loop
      await meshNamespace.attachContainer(instance, {
        linkId: slot.toString(16).padStart(8, '0'),
        containerPid: container.pid,
        presentedIp,
      });
    }
  }
}

/**
 * The detector phase for one app: judge the peer table; on any eviction,
 * rebuild the material without the refused outpoints, reload, and require
 * the peer table to converge — an eviction that cannot be proven to have
 * taken effect is a security event, not a log line.
 */
async function runDetector(app, ctx) {
  const active = await meshNamespace.meshUnits.nebulaActive(app.identity);
  if (!active) return null;
  const result = await meshDetector.detectImpersonation(app.identity, app.material.members);
  if (!result.checked) return { checked: false, evicted: [], foreign: 0 };

  if (result.evicted.length === 0 && result.foreign.length > 0) {
    // Tunnels under authorities outside the intended set with nothing newly
    // evicted: either an eviction still converging or a reload that silently
    // kept a stale pool. Reload again and let the next pass judge.
    log.warn(`meshReconciler - ${app.name}: ${result.foreign.length} tunnel(s) cite authorities outside the trust bundle; reloading`);
    await meshNamespace.meshUnits.reloadNebula(app.identity);
    return { checked: true, evicted: [], foreign: result.foreign.length };
  }
  if (result.evicted.length === 0) return { checked: true, evicted: [], foreign: 0 };

  app.material = await reconcileAppMaterial(app, ctx);
  await meshNamespace.meshUnits.reloadNebula(app.identity);
  const bundle = await meshCertificates.certificateBundleDetails(
    path.join(meshCertificates.meshAppDir(app.identity), meshCertificates.TRUST_BUNDLE_FILE),
  );
  const trustedShas = new Set((bundle ?? []).map((cert) => cert.fingerprint));
  const converged = await meshDetector.awaitEvictionConverged(app.identity, trustedShas);
  if (!converged) {
    log.error(`meshReconciler - ${app.name}: eviction did NOT converge — a tunnel outside the trust bundle persists; `
      + 'nebula may be serving a stale CA pool. Will re-drive next pass.');
  }
  return {
    checked: true,
    evicted: result.evicted.map((cheat) => cheat.outpoint),
    foreign: result.foreign.length,
    converged,
  };
}

let sweepRunning = false;

/**
 * One full pass over every mesh app. Single-flight; safe to call from the
 * sweep, the install path, boot, and the UPnP refresh alike.
 */
async function reconcileAllMeshApps() {
  if (sweepRunning) return;
  sweepRunning = true;
  try {
    const synced = daemonServiceMiscRpcs.isDaemonSynced();
    if (synced?.data?.synced !== true) {
      log.info('meshReconciler - daemon not synced; membership judgments deferred');
      return;
    }
    const apps = await gatherMeshApps();
    const gathered = new Set(apps.map((app) => app.name));
    [...lastPassByApp.keys()].forEach((name) => {
      if (!gathered.has(name)) lastPassByApp.delete(name);
    });
    if (apps.length === 0) return;

    const collateral = await generalService.obtainNodeCollateralInformation();
    const ownOutpoint = meshDerivation.canonicalOutpoint(collateral.txhash, collateral.txindex);
    const ctx = {
      ownOutpoint,
      ownNodeId: meshDerivation.nodeId(ownOutpoint),
      tipHeight: synced.data.height,
      sshClientPublicKey: await meshSsh.ensureClientKeypair(),
    };

    const { meshComponentSlot } = await getSpec();
    const healthy = [];
    // eslint-disable-next-line no-restricted-syntax
    for (const app of apps) {
      try {
        app.slots = new Map(app.view.componentNames()
          .map((component) => [component, meshComponentSlot(app.name, component)]));
        // eslint-disable-next-line no-await-in-loop
        app.material = await reconcileAppMaterial(app, ctx);
        // eslint-disable-next-line no-await-in-loop
        app.containers = await gatherContainers(app);
        recordPass(app.name, {
          error: null,
          meshPort: app.material.meshPort,
          certAction: app.material.certAction,
          members: app.material.members.map(memberFacts),
          rejected: app.material.rejected,
        });
        healthy.push(app);
      } catch (error) {
        recordPass(app.name, { error: error.message });
        log.error(`meshReconciler - ${app.name}: material pass failed: ${error.message}`);
      }
    }
    if (healthy.length === 0) return;

    await reconcileSnapshotAndTayga(healthy, ctx);

    const externalInterface = await fluxNetworkHelper.getDefaultRouteInterface();
    const chainRules = { pre: [], post: [], fwd: [] };
    // eslint-disable-next-line no-restricted-syntax
    for (const app of healthy) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await reconcileAppRuntime(app, ctx);
        if (externalInterface) {
          const rules = meshRuntimeConfig.firewallRules({
            externalInterface,
            meshPort: app.material.meshPort,
            transitSubnet: app.transit.subnet,
            transitNamespaceIp: app.transit.namespaceIp,
          });
          chainRules.pre.push(...rules.pre);
          chainRules.post.push(...rules.post);
          chainRules.fwd.push(...rules.fwd);
        }
      } catch (error) {
        recordPass(app.name, { error: error.message });
        log.error(`meshReconciler - ${app.name}: runtime pass failed: ${error.message}`);
      }
    }

    await meshNamespace.ensureMeshChains();
    await meshNamespace.setMeshChainRules(chainRules);

    // eslint-disable-next-line no-restricted-syntax
    for (const app of healthy) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const detector = await runDetector(app, ctx);
        recordPass(app.name, {
          detector,
          // An eviction re-ran the material; the retained view keeps up.
          members: app.material.members.map(memberFacts),
        });
      } catch (error) {
        recordPass(app.name, { error: error.message });
        log.error(`meshReconciler - ${app.name}: detector pass failed: ${error.message}`);
      }
    }
  } finally {
    sweepRunning = false;
  }
}

/**
 * What a mesh component's container must be created with: its presented
 * address (assigned before the container exists — the env value cannot change
 * after start), the FLUX_MESH_* variables, and the resolver chain. Null for
 * a component of an app that is not mesh-enabled.
 *
 * @param {string} appName
 * @param {string} componentName
 * @returns {Promise<{presentedIp: string, env: string[], dns: string[]}|null>}
 */
async function prepareComponentMesh(appName, componentName) {
  const inst = await appsRepository.getInstalledApp(appName);
  if (!inst) return null;
  const view = await resolveInstantiatedSpec(inst);
  if (view?.network?.mesh !== true) return null;
  if (!inst.uuid || !inst.identity) {
    throw new Error(`${appName} is mesh-enabled but carries no registration uuid`);
  }

  await reconcileAllMeshApps();

  const collateral = await generalService.obtainNodeCollateralInformation();
  const ownOutpoint = meshDerivation.canonicalOutpoint(collateral.txhash, collateral.txindex);
  const ownNodeId = meshDerivation.nodeId(ownOutpoint);
  const snapshot = await meshSnapshot.readCurrentSnapshot();
  const member = snapshot?.apps
    ?.find((app) => app.name === appName)?.members
    ?.find((m) => m.nodeId === ownNodeId && m.component === componentName);
  if (!member?.ip) {
    throw new Error(`No presented address is assigned yet for ${componentName} of ${appName}`);
  }
  return {
    presentedIp: member.ip,
    env: [
      `FLUX_MESH_APP=${appName}`,
      `FLUX_MESH_SELF=${meshDerivation.memberName(componentName, ownOutpoint)}`,
      `FLUX_MESH_SELF_IP=${member.ip}`,
    ],
    dns: [...MESH_DNS_SERVERS],
  };
}

/**
 * Tear down an app's mesh runtime and material on uninstall. The snapshot
 * and chains shed the app on the pass this triggers. A no-op when the app
 * left no mesh material — every uninstall may call it unconditionally.
 *
 * @param {string} instance the app's identity segment
 */
async function removeAppMesh(instance) {
  const present = await fsp.stat(meshCertificates.meshAppDir(instance)).then(() => true, () => false);
  if (!present) return;
  try {
    await meshNamespace.meshUnits.stopAll(instance);
  } catch (error) {
    log.warn(`meshReconciler - stopping mesh units for ${instance}: ${error.message}`);
  }
  await meshNamespace.destroyNamespace(instance);
  await meshPortAllocator.releaseTransportPort(instance);
  meshTransit.releaseTransit(instance);
  await meshCertificates.removeAppMaterial(instance);
  reconcileAllMeshApps().catch((error) => {
    log.error(`meshReconciler - post-removal pass failed: ${error.message}`);
  });
}

/**
 * A runtime change (a container just started) on a MESH app: converge
 * fire-and-forget. The caller gates on `DeploymentSpec.meshEnabled` — the
 * deployment view it already holds — so this is never reached for the
 * overwhelmingly common non-mesh case.
 *
 * @param {string} appName
 */
function noteAppRuntimeChange(appName) {
  reconcileAllMeshApps().catch((error) => {
    log.error(`meshReconciler - converge after ${appName} runtime change failed: ${error.message}`);
  });
}

let started = false;

/**
 * Register the periodic sweep. The cadence also carries the parked-certificate
 * promotion (ageing is judged inside the certificate sweep step).
 */
function start() {
  if (started) return;
  started = true;
  const intervalMs = config.fluxapps.meshReconcileIntervalMs ?? 30 * 60 * 1000;
  const initialMs = Math.round((5 * 60 * 1000) * (config.fluxapps.bootDelayMultiplier ?? 1));
  const run = () => reconcileAllMeshApps().catch((error) => {
    log.error(`meshReconciler - sweep failed: ${error.message}`);
  });
  setTimeout(() => {
    run();
    setInterval(run, intervalMs);
  }, initialMs);
}

module.exports = {
  MESH_DNS_SERVERS,
  hostingOutpointsFor,
  anchorHeightsFor,
  gatherMeshApps,
  buildSnapshotApp,
  reconcileAllMeshApps,
  prepareComponentMesh,
  noteAppRuntimeChange,
  lastPassStatus,
  removeAppMesh,
  start,
};
