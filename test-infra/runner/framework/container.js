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

// ── Content bind-mount inspectors ──────────────────────────────────────
// Read/stat a path INSIDE an app container (the node is the DinD host, so this is
// `docker exec <appContainer> ...`). The inspected component needs coreutils
// (cat/stat) — e.g. nginx/busybox, not the freestanding signal fixture.

export { appContainerName };

export async function readFileInContainer(container, appName, componentName, path) {
  const name = appContainerName(appName, componentName);
  const { stdout, exitCode } = await execInContainer(container, `docker exec ${name} cat ${path}`);
  return { content: stdout, exitCode };
}

// Owner/perms of an injected file as the node wrote them. Injected content defaults
// to root:root 0444; data/appdata/component dirs stay 777.
export async function statFileInContainer(container, appName, componentName, path) {
  const name = appContainerName(appName, componentName);
  const { stdout, exitCode } = await execInContainer(container, `docker exec ${name} stat -c '%u %g %a' ${path}`);
  const [uid, gid, mode] = stdout.trim().split(/\s+/);
  return { uid, gid, mode, exitCode };
}

// The inode of a path inside the container — for the atomic-swap check (a managed
// atomic delivery changes the inode under /io.runonflux/; an in-place single-file
// bind keeps the same inode). Returns null when absent.
export async function inodeInContainer(container, appName, componentName, path) {
  const name = appContainerName(appName, componentName);
  const { stdout, exitCode } = await execInContainer(container, `docker exec ${name} stat -c '%i' ${path} 2>/dev/null || echo ""`);
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
