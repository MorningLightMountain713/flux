import { execFile } from 'node:child_process';
import { NotPresentError } from './errors.js';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Pause/unpause a HOST-level testcontainer (registry, stubs) via the host docker
// CLI - testcontainers has no pause API. A paused container models a real
// service outage faithfully: its DNS alias stays registered and TCP connects
// black-hole, unlike stop(), which deregisters the alias and turns the failure
// into a DNS miss that FluxOS's resolver then negative-caches past the outage.
export async function pauseHostContainer(startedContainer) {
  await execFileAsync('docker', ['pause', startedContainer.getId()]);
}

export async function unpauseHostContainer(startedContainer) {
  await execFileAsync('docker', ['unpause', startedContainer.getId()]);
}

export async function execInContainer(container, command) {
  const args = Array.isArray(command) ? command : ['sh', '-c', command];
  const result = await container.exec(args);
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, output: result.output };
}

// FluxOS stamps every container it manages with the app it belongs to, the component
// it is, and (for a named placement) its replica. Those labels are the identity of
// record — the same ones the shutdown daemon groups by — and they are the ONLY way a
// suite can find a container from an app name: container names are built from the
// app's minted identity (sha256(name‖txid) truncated), which carries no trace of the
// name and cannot be derived from anything a suite holds.
const LABEL_APP = 'io.runonflux.app';
const LABEL_COMPONENT = 'io.runonflux.component';
const LABEL_REPLICA = 'io.runonflux.replica';
const LABEL_IDENTIFIER = 'io.runonflux.identifier';

export async function listAppContainers(container, { all = false } = {}) {
  const flag = all ? ' -a' : '';
  const fields = ['{{.Names}}', '{{.Status}}', '{{.Image}}',
    `{{.Label "${LABEL_APP}"}}`, `{{.Label "${LABEL_COMPONENT}"}}`,
    `{{.Label "${LABEL_REPLICA}"}}`, `{{.Label "${LABEL_IDENTIFIER}"}}`].join('\t');
  const { stdout } = await execInContainer(container,
    `docker ps${flag} --format '${fields}' 2>/dev/null || echo ""`,
  );
  return stdout.trim().split('\n')
    .filter((line) => line && !line.includes('NAMES'))
    .map((line) => {
      const [name, status, image, app, component, replica, identifier] = line.split('\t');
      return {
        name, status, image, app: app || null, component: component || null,
        replica: replica || null, identifier: identifier || null,
      };
    })
    .filter((c) => c.name);
}

// A bare app name matches every identity of that app; naming a replica narrows to
// exactly one, which is what co-located siblings need — they share the app label and
// differ only in the replica one.
function isAppContainer(c, appName, replica) {
  if (c.app !== appName) return false;
  return replica == null || c.replica === replica;
}

export async function isAppContainerRunning(container, appName, { replica = null } = {}) {
  const containers = await listAppContainers(container);
  return containers.some((c) => isAppContainer(c, appName, replica) && c.status?.startsWith('Up'));
}

// Every container belonging to the app on this node, across identities — the
// co-located count, which a single-container lookup cannot express.
export async function appContainersFor(container, appName, { all = false } = {}) {
  const containers = await listAppContainers(container, { all });
  return containers.filter((c) => isAppContainer(c, appName, null));
}

export async function killAppContainer(container, appName, componentName, replica = null) {
  const name = await requireAppContainerName(container, appName, componentName, replica);
  return execInContainer(container, `docker rm -f ${name}`);
}

// Remove an image from the node's LOCAL docker store. With the registry also
// down, a rebuild then has genuinely nothing to run - the state the keep-path
// (recreate-failure) tests need now that a local copy satisfies a recreate.
// -f clears the tag even while stopped containers still reference layers.
export async function removeAppImage(container, imageRef) {
  return execInContainer(container, `docker rmi -f ${imageRef}`);
}

export async function getAppContainerStatus(container, appName, { all = false, replica = null, component = null } = {}) {
  const containers = await listAppContainers(container, { all });
  return containers.find((c) => isAppContainer(c, appName, replica)
    && (component == null || c.component === component)) ?? null;
}

// The REAL docker name of one component's container, resolved through the labels.
// Container names are built from the app's minted identity, which nothing a suite holds
// can derive, so this is a lookup. Returns null when no such container exists.
async function appContainerName(container, appName, componentName, replica = null) {
  const containers = await listAppContainers(container, { all: true });
  const match = containers.find((c) => isAppContainer(c, appName, replica)
    && (componentName == null || c.component === componentName));
  return match ? match.name : null;
}

// Same, for the helpers that ACT on a container (kill, stop, exec into). Acting on an
// app that is not there is a broken assertion, not a no-op to swallow: say so.
export async function requireAppContainerName(container, appName, componentName, replica = null) {
  const name = await appContainerName(container, appName, componentName, replica);
  if (!name) {
    throw new NotPresentError(`no container on this node for app ${appName}`
      + `${componentName ? ` component ${componentName}` : ''}${replica ? ` replica ${replica}` : ''}`);
  }
  return name;
}

// The identifiers this app's containers are named from, read off the containers
// themselves. Physical artifacts — the appdata directory and its loop mount — are named
// `flux<identifier>`, which since minting contains no trace of the app's name. A
// teardown assertion therefore has to capture these WHILE the app is alive and check
// they are gone afterwards; nothing on a torn-down node can still say what to look for.
/**
 * The identifier ONE component's artifacts are named from —
 * `<component>_<identity>[_<replica>]` — read off the container's own label.
 *
 * Everything physical on the node is built from it: the container name is `flux` +
 * this, and so are the appdata directory and the syncthing folder id. None of it can
 * be spelled from the app's name, because the identity is minted at registration.
 */
export async function appComponentIdentifier(container, appName, componentName, replica = null) {
  const containers = await listAppContainers(container, { all: true });
  const match = containers.find((c) => isAppContainer(c, appName, replica)
    && (componentName == null || c.component === componentName));
  return match?.identifier ?? null;
}

/** The syncthing folder id for one component: `flux<identifier>`. */
export async function appSyncthingFolderId(container, appName, componentName, replica = null) {
  const identifier = await appComponentIdentifier(container, appName, componentName, replica);
  return identifier ? `flux${identifier}` : null;
}

export async function appComponentIdentifiers(container, appName) {
  const containers = await listAppContainers(container, { all: true });
  return containers.filter((c) => isAppContainer(c, appName, null))
    .map((c) => c.identifier).filter(Boolean);
}

// graceful stop -> the container exits 0 and stays present (not removed). Use to
// exercise restart-on-clean-exit, as opposed to killAppContainer (docker rm -f,
// which removes it -> the missing-container/recreate path).
export async function stopAppContainer(container, appName, componentName) {
  const name = await requireAppContainerName(container, appName, componentName);
  return execInContainer(container, `docker stop ${name}`);
}

// SIGKILL -> the container exits non-zero (137) and stays present. Use to
// exercise crash recovery / restart-on-failure.
export async function crashAppContainer(container, appName, componentName) {
  const name = await requireAppContainerName(container, appName, componentName);
  return execInContainer(container, `docker kill ${name}`);
}

// the actual exit code the reconciler reads from Docker (null if container absent)
export async function getAppContainerExitCode(container, appName, componentName) {
  const name = await appContainerName(container, appName, componentName);
  if (!name) return null;
  const { stdout } = await execInContainer(container,
    `docker inspect --format '{{.State.ExitCode}}' ${name} 2>/dev/null || echo ""`,
  );
  const v = stdout.trim();
  return v === '' ? null : Number(v);
}

/**
 * Bounce the inner dockerd under a running FluxOS (the dockerd-restart orphan
 * case). Kills dockerd; the in-image watchdog respawns it. Without --live-restore
 * this stops dockerd's containers, leaving them 'exited' for the reconnect sweep
 * to recover. Confirms dockerd actually went DOWN and came back UP, so the caller
 * can't observe a false "already ready".
 */
export async function restartDockerd(container, { readyTimeoutMs = 40000, interval = 500 } = {}) {
  await execInContainer(container, 'kill $(pidof dockerd) 2>/dev/null || true');
  const start = Date.now();
  let sawDown = false;
  while (Date.now() - start < readyTimeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const r = await execInContainer(container, 'docker info > /dev/null 2>&1');
    const up = r.exitCode === 0;
    if (!up) sawDown = true;
    if (sawDown && up) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, interval));
  }
  throw new Error(`restartDockerd: dockerd did not cycle down and back up within ${readyTimeoutMs}ms`);
}

/**
 * Fault injection: hold the inner dockerd DOWN (a real docker outage) until resumeDockerd.
 * Unlike restartDockerd (which only bounces it - the watchdog respawns within ~1s), this
 * writes the /tmp/dockerd-paused sentinel the entrypoint watchdog honors, then kills
 * dockerd, so it stays down. Used to force a teardown to leave a survivor (its remove and
 * presence-check fail under the outage) and prove the reconciler re-drives the owed
 * teardown to fully gone once docker returns. Resolves once docker is actually unreachable.
 */
export async function pauseDockerd(container, { downTimeoutMs = 15000, interval = 200 } = {}) {
  await execInContainer(container, 'touch /tmp/dockerd-paused; kill $(pidof dockerd) 2>/dev/null || true');
  const start = Date.now();
  while (Date.now() - start < downTimeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const r = await execInContainer(container, 'docker info > /dev/null 2>&1');
    if (r.exitCode !== 0) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, interval));
  }
  throw new Error(`pauseDockerd: dockerd did not go down within ${downTimeoutMs}ms`);
}

/**
 * Release a pauseDockerd outage: remove the sentinel so the watchdog respawns dockerd,
 * and resolve once docker is reachable again.
 */
export async function resumeDockerd(container, { readyTimeoutMs = 40000, interval = 500 } = {}) {
  await execInContainer(container, 'rm -f /tmp/dockerd-paused');
  const start = Date.now();
  while (Date.now() - start < readyTimeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const r = await execInContainer(container, 'docker info > /dev/null 2>&1');
    if (r.exitCode === 0) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, interval));
  }
  throw new Error(`resumeDockerd: dockerd did not come back within ${readyTimeoutMs}ms`);
}

/**
 * Restart the FluxOS process only - the `systemctl restart fluxos` case. Kills just
 * the node app.js child (its PID is in /tmp/fluxos.pid, written by the entrypoint
 * watchdog, so PID 1 is never touched); the watchdog respawns it. The inner dockerd
 * and the running app containers are NOT affected - they keep running while FluxOS's
 * in-memory state (e.g. controllerDesired) is wiped. This is distinct from
 * restartNode (whole container -> dockerd + containers restart) and restartDockerd
 * (dockerd only). Confirms FluxOS went DOWN and came back UP so the caller can't
 * observe a false "already ready".
 */
export async function restartFluxos(container, { apiPort = 16127, readyTimeoutMs = 120000, interval = 500 } = {}) {
  // hard-kill only the node child (state wiped instantly); never PID 1
  await execInContainer(container, 'kill -9 "$(cat /tmp/fluxos.pid 2>/dev/null)" 2>/dev/null || true');
  const probe = `curl -sf -o /dev/null http://127.0.0.1:${apiPort}/flux/version`;
  const start = Date.now();
  let sawDown = false;
  while (Date.now() - start < readyTimeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const r = await execInContainer(container, probe);
    const up = r.exitCode === 0;
    if (!up) sawDown = true;
    if (sawDown && up) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, interval));
  }
  throw new Error(`restartFluxos: FluxOS did not cycle down and back up within ${readyTimeoutMs}ms`);
}

// ── "Fully gone" state inspectors ──────────────────────────────────────
// The container being absent is NOT proof an app was fully torn down: the teardown
// also removes the app's cross-app docker network and umount+rm's its loop-mounted
// appdata. These inspect the real in-node state so a suite can prove FULL removal.

// The per-app docker network FluxOS creates and (only after all components detach)
// removes. Its NAME is built from the app's minted identity, which a suite cannot
// derive — so it is found by the label FluxOS stamps on it, and returns null when the
// app has no network on this node.
export async function fluxAppNetworkName(container, appName) {
  const { stdout } = await execInContainer(container,
    `docker network ls --filter label=io.runonflux.app-network=${appName} --format '{{.Name}}' 2>/dev/null || echo ""`);
  const [name] = stdout.trim().split('\n').map((s2) => s2.trim()).filter(Boolean);
  return name ?? null;
}

// Whether a docker network of this exact name exists on the node. Takes the raw
// name, so a suite can assert about networks that deliberately do NOT follow the
// per-app convention (an unattributable one the janitor must leave alone).
export async function networkExists(container, networkName) {
  const { stdout } = await execInContainer(container,
    "docker network ls --format '{{.Name}}' 2>/dev/null || echo \"\"");
  const names = stdout.trim().split('\n').map((s) => s.trim()).filter(Boolean);
  return names.includes(networkName);
}

// The app's docker network if it still exists on this node, else null.
export async function getAppNetwork(container, appName) {
  return fluxAppNetworkName(container, appName);
}

// ── Network-detach synthesis (the network-heal suite) ─────────────────
// A live `docker network disconnect` leaves the container RUNNING with
// NetworkMode still naming its network but no endpoint on it - the stale-
// endpoint state the reconciler's network-detach heal exists for.

export async function disconnectAppNetwork(container, appName, componentName) {
  const name = await requireAppContainerName(container, appName, componentName);
  const network = await fluxAppNetworkName(container, appName);
  return execInContainer(container, `docker network disconnect ${network} ${name}`);
}

export async function connectAppNetwork(container, appName, componentName) {
  const name = await requireAppContainerName(container, appName, componentName);
  const network = await fluxAppNetworkName(container, appName);
  return execInContainer(container, `docker network connect ${network} ${name}`);
}

// The subnet of the app's docker network - capture BEFORE pruning it, so a
// restore recreates the network the recreated container's static IP fits into.
export async function getAppNetworkSubnet(container, appName) {
  const network = await fluxAppNetworkName(container, appName);
  if (!network) return null;
  const { stdout } = await execInContainer(container,
    `docker network inspect --format '{{(index .IPAM.Config 0).Subnet}}' ${network} 2>/dev/null || echo ""`);
  return stdout.trim() || null;
}

/**
 * Stop an app container and prune its network in ONE exec, and say whether that took.
 *
 * The "stopped container with no network" state is one the product actively repairs:
 * a component whose controllerDesired is `running` is restarted as soon as the
 * reconciler sees it stop, and the crash-backoff ladder starts at 0ms. Stopping from
 * the runner and then removing the network in a second call leaves a full round trip
 * for a pass to land in, and when it does, `docker network rm` fails with
 * `has active endpoints` — which does NOT mean a slow endpoint teardown. It means the
 * container is UP again. Measured: at the moment of a failing rm the container read
 * `Up 8 seconds`, and docker (24.0.7 and 29.3.1 alike) empties EndpointID the instant
 * a container stops, so there is no teardown lag to wait out.
 *
 * Both halves therefore go to the node in a single command, leaving no round trip
 * between them. The caller still has to check: this is a transient state being
 * sampled, not a stable one being set, so a lost race is reported rather than hidden.
 *
 * @returns {Promise<{ok: boolean, output: string}>} ok when the network is gone.
 */
export async function stopAndPruneAppNetwork(container, appName, componentName) {
  const name = await requireAppContainerName(container, appName, componentName);
  const network = await fluxAppNetworkName(container, appName);
  if (!network) return { ok: true, output: 'no network present' };
  const res = await execInContainer(container,
    `docker stop ${name} >/dev/null 2>&1; docker network rm ${network}`);
  return { ok: res.exitCode === 0, output: (res.output ?? '').trim() };
}

export async function removeAppNetworkRaw(container, appName) {
  const network = await fluxAppNetworkName(container, appName);
  return execInContainer(container, `docker network rm ${network}`);
}

// Create a network under an exact name - for the networks a suite needs docker to
// hold that FluxOS would never mint itself.
export async function createNetworkNamed(container, networkName, subnet) {
  const subnetFlag = subnet ? ` --subnet ${subnet}` : '';
  return execInContainer(container, `docker network create${subnetFlag} ${networkName}`);
}

// Recreates the network a suite just destroyed, under the SAME name it had — the
// caller captured it while the app was alive, because the name is built from the
// app's identity and nothing on the node can restate it once the network is gone.
export async function createAppNetworkRaw(container, networkName, subnet) {
  return createNetworkNamed(container, networkName, subnet);
}

// Docker's container ID: survives nothing - a recreate mints a new one - so ID
// equality across a window proves the container was never touched.
export async function getAppContainerId(container, appName, componentName) {
  const name = await appContainerName(container, appName, componentName);
  if (!name) return null;
  const { stdout } = await execInContainer(container,
    `docker inspect --format '{{.Id}}' ${name} 2>/dev/null || echo ""`);
  return stdout.trim() || null;
}

// Whether the container holds an endpoint (with an IP) on its OWN app network -
// the same fact dockerService.classifyContainerNetworkAttachment reads.
export async function getAppContainerAttachment(container, appName, componentName) {
  const net = await fluxAppNetworkName(container, appName);
  if (!net) return { attached: false, ip: null };
  const name = await appContainerName(container, appName, componentName);
  if (!name) return { attached: false, ip: null };
  const { stdout } = await execInContainer(container,
    `docker inspect --format '{{with index .NetworkSettings.Networks "${net}"}}{{.IPAddress}}{{end}}' ${name} 2>/dev/null || echo ""`);
  const ip = stdout.trim();
  return { attached: !!ip, ip: ip || null };
}

// The node's flux appdata root (harness FLUX_APPS_FOLDER). Per-component appdata lives at
// <root>/flux<identifier>, loop-mounted then umount+rm -rf'd by the teardown.
const APPDATA_ROOT = '/mnt/appdata/flux-apps';

// Still-present appdata artifacts for an app: live loop mounts and/or leftover
// directories under the appdata root. Both empty => the volume is fully torn down
// (unmounted AND removed).
//
// Keyed on the app's component IDENTIFIERS, which the caller captures while the app is
// alive (appComponentIdentifiers). The directories are named `flux<identifier>`, built
// from the app's minted identity, so only an identifier finds them; the app's name
// appears nowhere in the path.
export async function getAppVolumeArtifacts(container, appName, { identifiers } = {}) {
  if (!Array.isArray(identifiers)) {
    throw new Error(`getAppVolumeArtifacts(${appName}) needs the app's component identifiers, `
      + 'captured with appComponentIdentifiers() while the app was still installed: appdata '
      + 'directories are named from the app identity and never from its name');
  }
  const lines = (out) => out.trim().split('\n').map((x) => x.trim()).filter(Boolean);
  const mounts = [];
  const dirs = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const identifier of identifiers) {
    // eslint-disable-next-line no-await-in-loop
    const { stdout: m } = await execInContainer(container,
      `mount 2>/dev/null | grep -F '${APPDATA_ROOT}/' | grep -F 'flux${identifier}' || true`);
    // eslint-disable-next-line no-await-in-loop
    const { stdout: d } = await execInContainer(container,
      `ls -1 ${APPDATA_ROOT} 2>/dev/null | grep -F 'flux${identifier}' || true`);
    mounts.push(...lines(m));
    dirs.push(...lines(d));
  }
  return { mounts, dirs };
}

// True when NOTHING of the app remains on this node: no container, no docker network,
// no appdata mount or directory. The single "fully torn down" predicate.
//
// The identifiers are what make the volume half real, so they are required — see
// getAppVolumeArtifacts. Capture them before the teardown that is under test.
export async function isAppFullyGone(container, appName, { identifiers } = {}) {
  if (await getAppContainerStatus(container, appName, { all: true })) return false;
  if (await getAppNetwork(container, appName)) return false;
  const { mounts, dirs } = await getAppVolumeArtifacts(container, appName, { identifiers });
  return mounts.length === 0 && dirs.length === 0;
}

// ── Content bind-mount inspectors ──────────────────────────────────────
// Read/stat a path INSIDE an app container (the node is the DinD host, so this is
// `docker exec <appContainer> ...`). Inspected components run the static-busybox
// fixture (registry-helper.pushBusybox) — the harness's other fixtures (/bin/pause,
// /bin/test-app) are freestanding with no coreutils — so commands go via /bin/busybox.

export { appContainerName };

export async function readFileInContainer(container, appName, componentName, path) {
  const name = await appContainerName(container, appName, componentName);
  // An absent container reads as a failed exec, so a suite asserting on exitCode gets a
  // failure rather than an exception.
  if (!name) return { content: '', exitCode: 1 };
  const { stdout, exitCode } = await execInContainer(container, `docker exec ${name} /bin/busybox cat ${path}`);
  return { content: stdout, exitCode };
}

// Owner/perms of an injected file as the node wrote them. Injected content defaults
// to root:root 0444; data/appdata/component dirs stay 777.
export async function statFileInContainer(container, appName, componentName, path) {
  const name = await requireAppContainerName(container, appName, componentName);
  const { stdout, exitCode } = await execInContainer(container, `docker exec ${name} /bin/busybox stat -c '%u %g %a' ${path}`);
  const [uid, gid, mode] = stdout.trim().split(/\s+/);
  return { uid, gid, mode, exitCode };
}

// The inode of a path inside the container — for the atomic-swap check (a managed
// atomic delivery changes the inode under /io.runonflux/; an in-place single-file
// bind keeps the same inode). Returns null when absent.
export async function inodeInContainer(container, appName, componentName, path) {
  const name = await appContainerName(container, appName, componentName);
  if (!name) return null;
  const { stdout, exitCode } = await execInContainer(container, `docker exec ${name} /bin/busybox stat -c '%i' ${path} 2>/dev/null || echo ""`);
  const v = stdout.trim();
  return exitCode === 0 && v !== '' ? Number(v) : null;
}

// ROOT gate: confirm the FluxOS process runs as uid 0 and root file ops (the
// chown root:root + chmod 0444 every injected content write does) succeed on the
// appdata volume. Run in the first content suite's boot before any content assertion;
// if the node isn't root in the DinD container, every injected write fails silently.
export async function assertNodeRunsAsRoot(container) {
  const uidRes = await execInContainer(container, "awk '/^Uid:/{print $2}' /proc/\"$(cat /tmp/fluxos.pid)\"/status 2>/dev/null || echo unknown");
  const probe = await execInContainer(container, 'f=/mnt/appdata/.e2e-roottest; touch "$f" && chown root:root "$f" && chmod 0444 "$f" && stat -c \'%u %g %a\' "$f"; rc=$?; rm -f "$f"; exit $rc');
  return { fluxosUid: uidRes.stdout.trim(), rootOpsOk: probe.exitCode === 0, statLine: probe.stdout.trim() };
}

export async function getContainerImageDigest(container, appName, componentName) {
  const containerName = await appContainerName(container, appName, componentName);
  if (!containerName) return null;
  const { stdout } = await execInContainer(container,
    `docker image inspect $(docker inspect --format '{{.Image}}' ${containerName}) --format '{{index .RepoDigests 0}}'`,
  );
  const match = stdout.trim().match(/@(sha256:[a-f0-9]+)$/);
  return match ? match[1] : null;
}
