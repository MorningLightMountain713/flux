// Shared bootstrap for the reconciler integration suites. bootAndPeer brings a
// fleet to the peered/ticking state. Two deployment interfaces are available and
// shared by all suites:
//   - SPAWNER path: seedAndInstall / seedAndInstallMany / seedSimpleApp — seed the
//     global spec and let the spawner self-select nodes (exercises real placement).
//   - TARGETED path: installOnNodes — install on specific chosen nodes via the
//     node's installapplocally endpoint (deterministic, fast, you pick the nodes).
import { pushImage, pushTestApp } from './registry-helper.js';
import { startTicker, advanceBlock } from './daemon-control.js';
import { dbClient } from './db-client.js';
import { buildSeedableApp, buildSeedableSyncthingApp, buildSeedableTestApp } from './seed-helper.js';
import { authenticate } from '../auth.js';
import { fluxTeamKey } from './keys.js';
import {
  waitForDaemonReady, waitForNodeStatus, waitForBlockProcessed, waitForAppInstalled, waitFor,
  waitForReconcileActuated, waitForDeltaApplied,
} from './wait.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from './subnet-config.js';
import { setSynced } from './syncthing-control.js';
import { execInContainer, restartFluxos } from './container.js';
import { bootstrapPricing } from './price-helper.js';

// A folder the suite pins "synced" (setSynced reports a non-zero global index)
// must also HOLD data on disk, like any really-synced folder. Seeded apps write
// nothing themselves, and an index that claims bytes over an empty disk is the
// phantom-index state the mount-safety guard refuses to promote (and demotes) -
// the stub never rescans, so the disagreement never converges and the app never
// (re)starts. Call AFTER the sync layer's first-run reset (the dataCleared
// actuation): the reset clears local appdata at install and deletes anything
// written earlier. The reset removes the appdata DIR itself (recreated by
// ensureMountSourcesExist only at the next container start), so fabricating the
// on-disk state includes recreating the dir - without it the seed races the
// reconciler's next start actuation. seedSyncthingApp runs this ordering itself;
// only suites installing through another path need to call it directly.
export async function seedSyncScopedData(env, name, index) {
  const appDataDir = `/mnt/appdata/flux-apps/flux${name}_${name}/appdata`;
  const dataFile = `${appDataDir}/seed-data`;
  const r = await execInContainer(env.clients[index].container, `sh -c 'mkdir -p ${appDataDir} && echo seeded > ${dataFile}'`);
  if (r.exitCode !== 0) {
    throw new Error(`seedSyncScopedData: could not write ${dataFile} on node ${index}: ${r.output}`);
  }
}

// Seed a pre-built app's global spec into the given nodes' DBs (so a local install
// can resolve it). Exported for suites whose scenario needs NON-holder nodes to
// know the app too: production nodes hold every global spec via message sync, and
// anything verified against the spec (the owner-generation record) is silently
// dropped by a node the targeted-install shortcut left specless.
export async function seedGlobalSpec(env, app, indices) {
  await Promise.all(indices.map(async (i) => {
    const dc = dbClient(i + 1);
    await dc.seedGlobalAppSpec(app.spec);
    await dc.seedPermanentMessage(app.permanentMessage);
    await dc.seedAppHash(app.hash, app.permanentMessage.height, true);
  }));
}

// TARGETED deployment: install a pre-built app on exactly the given node indices
// via each node's installapplocally endpoint (real install: pull + create + start
// + syncthing config). Deterministic and fast — no spawner-placement timing. Auth
// as the flux team (adminandfluxteam) since these are seeded global specs.
// Returns the indices it installed on.
export async function installOnNodes(env, app, indices, { timeout = 120000 } = {}) {
  await seedGlobalSpec(env, app, indices);
  const teamKey = fluxTeamKey();
  await Promise.all(indices.map(async (i) => {
    const client = env.clients[i];
    const auth = await authenticate(client.url, teamKey);
    // installapplocally streams progress then a final status; surface a failure
    // in that body instead of silently waiting out the app:installed timeout.
    const body = await client.installAppLocally(app.spec.name, auth.zelidauth);
    if (/"status"\s*:\s*"error"|Application .* not found|already installed|Unauthorized|Not enough/i.test(body)) {
      throw new Error(`installapplocally failed on node ${i}: ${body.slice(-600)}`);
    }
    await waitForAppInstalled(client, app.spec.name, timeout);
  }));
  return indices;
}

// minOutbound/minInbound default to the large-fleet (reconciler) targets. A small
// arcane content fleet (~5 nodes) only ever reaches ~2 outbound / 2 inbound — once a
// peer connects inbound, FluxOS dedups and never initiates the outbound back — so those
// suites lower minOutbound to match their reduced fluxapps.minOutgoing config (the wait
// tracks the submission gate, which is outboundCount >= minOutgoing).
//
// pricing: true bootstraps default v9 on-chain pricing once the fleet is ticking
// (any suite confirming a v9 app through the real chain path needs it — a fresh
// harness chain quotes no price and registrations are fail-closed rejected). Pass
// an object to forward bootstrapPricing overrides ({ priceFields, fluxUsdPriceE4,
// timestamp }) for suites exercising specific policy values; suites needing full
// control of the message sequence leave it off and drive price-helper directly.
export async function bootAndPeer(env, { minOutbound = 4, minInbound = 2, pricing = false } = {}) {
  // stub-peer slots hold no FluxOS client (their env.clients entry is null)
  const fluxClients = env.clients.filter(Boolean);
  for (const client of fluxClients) await waitForDaemonReady(client);
  await Promise.all(fluxClients.map(
    (c) => waitForNodeStatus(c, (d) => d.confirmed === true, 30000),
  ));
  await advanceBlock();
  // Both events prove the same thing here - this node has moved past the seed
  // height - and which one a node emits depends on the network-state path it
  // is running. Under polling every node processes the block and announces
  // block:processed. Under ZMQ the same block can arrive as a node-list delta,
  // and that node announces deltaApplied and never block:processed, so waiting
  // on one specific event hangs on whichever node took the other path (a race:
  // nodes of the same fleet split across the two). Nothing weaker is accepted
  // by the polling suites, which still satisfy the first arm exactly as before,
  // and no app message exists this early for the distinction to matter.
  for (const client of fluxClients) {
    await Promise.any([
      waitForBlockProcessed(client, (d) => d.height > 2100000, 50000),
      waitForDeltaApplied(client, (d) => d.toHeight > 2100000, 50000),
    ]).catch(() => {
      throw new Error(
        `bootAndPeer: node never moved past the seed height - neither block:processed `
        + `nor deltaApplied arrived within 50000ms`,
      );
    });
  }
  await env.startDiscovery();
  // Direction-agnostic: duty pairs are reciprocal and the outbound label is
  // a dial-race outcome — the first-booted node can legitimately hold every
  // pair inbound-labelled. What "peered" means is enough distinct peers HELD.
  await fluxClients[0].waitForEvent('peers:added', (d) => d.total >= minOutbound + minInbound, 120000);
  await startTicker();
  if (pricing) {
    await bootstrapPricing(pricing === true ? {} : pricing);
  }
  // "Chain is up" is not "node is up": boot recovery is still deciding which
  // installed apps this node keeps, and an install landing while it deliberates
  // gets judged by it - the app's own location row does not exist yet, which
  // reads as "reassigned elsewhere" and removes the app underneath the suite.
  // boot:settled is the node's own end-of-boot signal (published even when
  // recovery errors), and waitForEvent replays it from the buffer, so a node
  // that settled before this line is a hit, not a hang.
  for (const client of fluxClients) {
    await client.waitForEvent('boot:settled', () => true, 120000);
  }
}

// bootAndPeer's restart twin: cycle FluxOS on every node and hold the fleet to
// the same contract a first boot ends with — settled, discovering, and peered
// back to the floor. Discovery never autostarts in-harness, so peering after a
// restart is the suite's move exactly as on first boot. settleIndexes names the
// nodes the contract can still be expected of (a delisted node reboots into a
// world that may refuse its dials); the floor is read from the first of them,
// as bootAndPeer reads it from its first client. Returns the pre-restart event
// markers, one per client, for afterId-disciplined waits on what follows.
export async function restartAndPeer(env, settleIndexes, { minOutbound = 1, minInbound = 1 } = {}) {
  const markers = env.clients.map((c) => c.getLastEventId());
  await Promise.all(env.clients.map((c) => restartFluxos(c.container)));
  await Promise.all(settleIndexes.map(
    (i) => env.clients[i].waitForEvent('boot:settled', () => true, 180000, { afterId: markers[i] }),
  ));
  await env.startDiscovery(settleIndexes);
  const [gate] = settleIndexes;
  await env.clients[gate].waitForEvent('peers:added', (d) => d.total >= minOutbound + minInbound, 120000, { afterId: markers[gate] });
  return markers;
}

// The single-node restore: after a suite cycles one node's FluxOS on its own
// terms (a referee under test, a master mid-watch), hold that node to the
// same settled-discovering-peered contract restartAndPeer holds a fleet to.
// markers are pre-restart event ids, env.clients-indexed.
export async function redialAndPeer(env, indices, markers, { minPeers = 1 } = {}) {
  await Promise.all(indices.map(
    (i) => env.clients[i].waitForEvent('boot:settled', () => true, 180000, { afterId: markers[i] }),
  ));
  await env.startDiscovery(indices);
  // Direction-agnostic, like bootAndPeer above: the outbound label is a
  // dial-race outcome, and a returned node whose pairs were all established
  // by the survivors' dials holds everything inbound-labelled while being
  // perfectly peered — its reconciler rightly never redials a held duty, so
  // an outbound-labelled wait here can never be satisfied.
  await Promise.all(indices.map((i) => env.clients[i].waitForEvent(
    'peers:added', (d) => d.total >= minPeers, 120000, { afterId: markers[i] },
  )));
}

// Seed a pre-built app (buildSeedableApp / buildSeedableSyncthingApp) into every
// node's DB and wait until it installs on some node; resolves that node index.
export async function seedAndInstall(env, app, { timeout = 120000 } = {}) {
  for (let i = 1; i <= env.nodeCount; i++) {
    const dc = dbClient(i);
    // eslint-disable-next-line no-await-in-loop
    await dc.seedGlobalAppSpec(app.spec);
    // eslint-disable-next-line no-await-in-loop
    await dc.seedPermanentMessage(app.permanentMessage);
    // eslint-disable-next-line no-await-in-loop
    await dc.seedAppHash(app.hash, app.permanentMessage.height, true);
  }
  return Promise.any(env.clients.map(async (c, i) => {
    await waitForAppInstalled(c, app.spec.name, timeout);
    return i;
  }));
}

// Seed a pre-built app into every node and wait until at least `minCount` nodes
// install it; resolves the sorted list of those node indices. Used by the
// multi-node gates (g: election needs >= 2 holders).
export async function seedAndInstallMany(env, app, minCount, { timeout = 150000 } = {}) {
  for (let i = 1; i <= env.nodeCount; i++) {
    const dc = dbClient(i);
    // eslint-disable-next-line no-await-in-loop
    await dc.seedGlobalAppSpec(app.spec);
    // eslint-disable-next-line no-await-in-loop
    await dc.seedPermanentMessage(app.permanentMessage);
    // eslint-disable-next-line no-await-in-loop
    await dc.seedAppHash(app.hash, app.permanentMessage.height, true);
  }
  const installed = [];
  await Promise.all(env.clients.map(async (c, i) => {
    try {
      await waitForAppInstalled(c, app.spec.name, timeout);
      installed.push(i);
    } catch { /* this node didn't install within the window */ }
  }));
  installed.sort((a, b) => a - b);
  if (installed.length < minCount) {
    throw new Error(`app ${app.spec.name} installed on ${installed.length} nodes (${installed.join(',')}), needed >= ${minCount}`);
  }
  return installed;
}

// SPAWNER path: seed an app's global spec into EVERY node's globalzelapps DB
// (collection zelappsinformation — the one trySpawningGlobalApplication aggregates
// over) so each node's spawner sees it as missing-instances and self-selects. No
// running/installing locations are seeded, so `actual` starts at 0 and the spawner
// drives real placement + collision-resolution. The app image must be pushed first.
export async function seedSpawnerApp(env, app) {
  const all = env.clients.map((_, i) => i);
  await seedGlobalSpec(env, app, all);
}

// Ground-truth count of where an app is actually installed across the fleet
// (queries each node's installedapps endpoint). Returns sorted node indices.
export async function installedInstanceIndices(env, appName) {
  const idx = [];
  await Promise.all(env.clients.map(async (c, i) => {
    try {
      const res = await c.getInstalledApps();
      if (res.status === 'success' && res.data.find((a) => a.name === appName)) idx.push(i);
    } catch { /* node unreachable this tick */ }
  }));
  return idx.sort((a, b) => a - b);
}

// Wait until exactly `target` nodes have the app installed, then confirm the count
// HOLDS at exactly `target` for `stableMs` (so a late overshoot is caught, not
// missed by checking once). Returns the final sorted node indices.
export async function waitForInstanceCount(env, appName, target, {
  timeout = 120000, stableMs = 12000, interval = 3000,
} = {}) {
  await waitFor(
    async () => (await installedInstanceIndices(env, appName)).length >= target,
    { timeout, interval, label: `>=${target} instances of ${appName}` },
  );
  const deadline = Date.now() + stableMs;
  let last = await installedInstanceIndices(env, appName);
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, interval); });
    // eslint-disable-next-line no-await-in-loop
    const now = await installedInstanceIndices(env, appName);
    if (now.length !== target) {
      throw new Error(`${appName} instance count = ${now.length} [${now.join(',')}], expected exactly ${target}`);
    }
    last = now;
  }
  return last;
}

// Deploy a syncthing (r:/g:/s:) app on a chosen node (targeted install) and wait
// for it to install. The syncthing folder id the deciders query is
// getAppIdentifier(`${name}_${name}`) i.e. `flux${name}_${name}` — returned as
// `folder` for driving syncthing-control.
//
// forceNonLeader: make the installed node a follower rather than the syncthing
// leader (a leader starts immediately; only a follower waits for sync). Done the
// honest way — actually run the app on a real peer node first. That peer becomes
// the leader, starts, and advertises its running location via the normal gossip
// path (checkAndNotifyPeersOfRunningApps, carrying runningSince). We wait until the
// subject node has received that location, so when it installs it sees a genuine
// running peer and takes the sync-gated follower path. No fabricated DB rows — the
// alternative (seeding a location) is reaped by nodeStatusMonitor unless it points
// at a real node, and even then misrepresents an instance that isn't running.
//
// The peer's stub must report a genuinely synced source (setSynced) so it PROMOTES
// to sendreceive and keeps running for the whole test. On stub defaults the peer
// reports an empty global (globalBytes 0) plus a phantom connected synced peer:
// once an empty global is correctly no longer treated as synced, that node sits as
// an un-synced follower with a "connected synced peer" and the stall ladder removes
// it (broadcasting fluxappremoved) ~40s in — which collapses the SUBJECT's running-
// peer list to itself and makes the subject win a spurious single-peer election and
// cold-start. Pinning the peer synced keeps it the stable running source the subject
// must defer to.
//
// Every install here waits out the sync layer's first-run reset (dataCleared) and
// then writes sync-scoped disk data, so a folder any test later pins synced already
// holds the data its index claims (see seedSyncScopedData). Whether/when to pin the
// SUBJECT synced stays the caller's choice.
export async function seedSyncthingApp(env, {
  name, syncMode = 'syncFirst', forceNonLeader = false, index = 0, hdd = 1,
}) {
  await pushImage(name, 'v1');
  const app = await buildSeedableSyncthingApp({ name, syncMode, hdd });
  const folder = `flux${name}_${name}`;
  const identifier = `${name}_${name}`;
  // The install-settled signal is mode-dependent: decider modes (activeStandby/
  // syncFirst) run the first-run clean-install reset (dataCleared) before any
  // start, while a plain-sync component has no decider and no reset - it just
  // starts, so dataCleared never fires for it.
  const settleAction = syncMode === 'sync' ? 'firstStart' : 'dataCleared';

  const peerIndex = forceNonLeader ? (index === 0 ? env.clients.length - 1 : 0) : null;
  if (forceNonLeader) {
    // run the app on a real peer first: it becomes the syncthing leader, starts, and
    // gossips its running location. Wait until the subject node receives that
    // broadcast (surfaced as network:apprunning) before installing it, so its first
    // leader-election sees a running peer and takes the sync-gated follower path.
    const afterId = env.clients[index].getLastEventId();
    const peerInstallAfter = env.clients[peerIndex].getLastEventId();
    await installOnNodes(env, app, [peerIndex]);
    await waitForReconcileActuated(env.clients[peerIndex], identifier, settleAction, 60000, { afterId: peerInstallAfter });
    await seedSyncScopedData(env, name, peerIndex);
    await setSynced({ ip: getSubnetConfig().nodeIp(peerIndex + 1), folder });
    await env.clients[index].waitForEvent(
      'network:apprunning', (d) => d.apps?.some((a) => a.name === name), 60000, { afterId },
    );
  }

  const installAfter = env.clients[index].getLastEventId();
  await installOnNodes(env, app, [index]);
  await waitForReconcileActuated(env.clients[index], identifier, settleAction, 60000, { afterId: installAfter });
  await seedSyncScopedData(env, name, index);
  return {
    app, index, peerIndex, folder, identifier,
  };
}

// Convenience for a plain single-component app (the suite-28 shape) via the
// SPAWNER path: push an image, build the spec, seed + install. Returns { app, index }.

// Seed the configurable test-app (controllable exit code / timed exit) and wait
// for it to install. Returns { app, index, identifier }. Requires the test-app
// binary to be built (bash test-infra/test-app/build.sh).
export async function seedTestApp(env, { name, exitCode = 0, exitAfterS = null } = {}) {
  await pushTestApp(name);
  const app = await buildSeedableTestApp({ name, exitCode, exitAfterS });
  const index = await seedAndInstall(env, app);
  return { app, index, identifier: `${name}_${name}` };
}

export async function seedSimpleApp(env, appName, { port = 31111 } = {}) {
  await pushImage(appName, 'v1');
  const app = await buildSeedableApp({
    name: appName,
    compose: [{
      name: appName,
      description: 'test container',
      repotag: `${REGISTRY_REPO_HOST}/${appName}:v1`,
      ports: [port],
      domains: [''],
      environmentParameters: [],
      commands: [],
      containerPorts: [80],
      containerData: '/tmp',
      cpu: 0.1,
      ram: 100,
      hdd: 1,
      repoauth: '',
    }],
  });
  const index = await seedAndInstall(env, app);
  return { app, index };
}
