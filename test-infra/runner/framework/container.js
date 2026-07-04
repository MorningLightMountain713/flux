export async function execInContainer(container, command) {
  const args = Array.isArray(command) ? command : ['sh', '-c', command];
  const result = await container.exec(args);
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, output: result.output };
}

export async function listAppContainers(container, { all = false } = {}) {
  const flag = all ? ' -a' : '';
  const { stdout } = await execInContainer(container,
    `docker ps${flag} --format "{{.Names}}\t{{.Status}}\t{{.Image}}" 2>/dev/null || echo ""`,
  );
  return stdout.trim().split('\n')
    .filter((line) => line && !line.includes('NAMES'))
    .map((line) => {
      const [name, status, image] = line.split('\t');
      return { name, status, image };
    })
    .filter((c) => c.name);
}

export async function isAppContainerRunning(container, appName) {
  const containers = await listAppContainers(container);
  return containers.some((c) => c.name.includes(appName) && c.status?.startsWith('Up'));
}

export async function killAppContainer(container, appName, componentName) {
  const name = `flux${componentName ?? appName}_${appName}`;
  return execInContainer(container, `docker rm -f ${name}`);
}

export async function getAppContainerStatus(container, appName, { all = false } = {}) {
  const containers = await listAppContainers(container, { all });
  return containers.find((c) => c.name.includes(appName)) ?? null;
}

function appContainerName(appName, componentName) {
  return `flux${componentName ?? appName}_${appName}`;
}

// graceful stop -> the container exits 0 and stays present (not removed). Use to
// exercise restart-on-clean-exit, as opposed to killAppContainer (docker rm -f,
// which removes it -> the missing-container/recreate path).
export async function stopAppContainer(container, appName, componentName) {
  return execInContainer(container, `docker stop ${appContainerName(appName, componentName)}`);
}

// SIGKILL -> the container exits non-zero (137) and stays present. Use to
// exercise crash recovery / restart-on-failure.
export async function crashAppContainer(container, appName, componentName) {
  return execInContainer(container, `docker kill ${appContainerName(appName, componentName)}`);
}

// the actual exit code the reconciler reads from Docker (null if container absent)
export async function getAppContainerExitCode(container, appName, componentName) {
  const { stdout } = await execInContainer(container,
    `docker inspect --format '{{.State.ExitCode}}' ${appContainerName(appName, componentName)} 2>/dev/null || echo ""`,
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

// The per-app docker network FluxOS creates and (only after all components detach) removes.
export function fluxAppNetworkName(appName) {
  return `fluxDockerNetwork_${appName}`;
}

// The app's docker network if it still exists on this node, else null.
export async function getAppNetwork(container, appName) {
  const { stdout } = await execInContainer(container,
    "docker network ls --format '{{.Name}}' 2>/dev/null || echo \"\"");
  const names = stdout.trim().split('\n').map((s) => s.trim()).filter(Boolean);
  return names.find((n) => n === fluxAppNetworkName(appName)) ?? null;
}

// The node's flux appdata root (harness FLUX_APPS_FOLDER). Per-component appdata lives at
// <root>/flux<component>_<app>, loop-mounted then umount+rm -rf'd by the teardown.
const APPDATA_ROOT = '/mnt/appdata/flux-apps';

// Still-present appdata artifacts for an app: live loop mounts and/or leftover directories
// under the appdata root carrying the app name. Both empty => the volume is fully torn
// down (unmounted AND removed).
export async function getAppVolumeArtifacts(container, appName) {
  const { stdout: mounts } = await execInContainer(container,
    `mount 2>/dev/null | grep -F '${APPDATA_ROOT}/' | grep -F '${appName}' || true`);
  const { stdout: dirs } = await execInContainer(container,
    `ls -1 ${APPDATA_ROOT} 2>/dev/null | grep -F '${appName}' || true`);
  const lines = (s) => s.trim().split('\n').map((x) => x.trim()).filter(Boolean);
  return { mounts: lines(mounts), dirs: lines(dirs) };
}

// True when NOTHING of the app remains on this node: no container, no docker network,
// no appdata mount or directory. The single "fully torn down" predicate.
export async function isAppFullyGone(container, appName) {
  if (await getAppContainerStatus(container, appName, { all: true })) return false;
  if (await getAppNetwork(container, appName)) return false;
  const { mounts, dirs } = await getAppVolumeArtifacts(container, appName);
  return mounts.length === 0 && dirs.length === 0;
}

// ── Content bind-mount inspectors ──────────────────────────────────────
// Read/stat a path INSIDE an app container (the node is the DinD host, so this is
// `docker exec <appContainer> ...`). Inspected components run the static-busybox
// fixture (registry-helper.pushBusybox) — the harness's other fixtures (/bin/pause,
// /bin/test-app) are freestanding with no coreutils — so commands go via /bin/busybox.

export { appContainerName };

export async function readFileInContainer(container, appName, componentName, path) {
  const name = appContainerName(appName, componentName);
  const { stdout, exitCode } = await execInContainer(container, `docker exec ${name} /bin/busybox cat ${path}`);
  return { content: stdout, exitCode };
}

// Owner/perms of an injected file as the node wrote them. Injected content defaults
// to root:root 0444; data/appdata/component dirs stay 777.
export async function statFileInContainer(container, appName, componentName, path) {
  const name = appContainerName(appName, componentName);
  const { stdout, exitCode } = await execInContainer(container, `docker exec ${name} /bin/busybox stat -c '%u %g %a' ${path}`);
  const [uid, gid, mode] = stdout.trim().split(/\s+/);
  return { uid, gid, mode, exitCode };
}

// The inode of a path inside the container — for the atomic-swap check (a managed
// atomic delivery changes the inode under /io.runonflux/; an in-place single-file
// bind keeps the same inode). Returns null when absent.
export async function inodeInContainer(container, appName, componentName, path) {
  const name = appContainerName(appName, componentName);
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
  const containerName = `flux${componentName}_${appName}`;
  const { stdout } = await execInContainer(container,
    `docker image inspect $(docker inspect --format '{{.Image}}' ${containerName}) --format '{{index .RepoDigests 0}}'`,
  );
  const match = stdout.trim().match(/@(sha256:[a-f0-9]+)$/);
  return match ? match[1] : null;
}
