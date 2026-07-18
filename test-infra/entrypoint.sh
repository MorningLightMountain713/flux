#!/bin/bash
set -e

ip addr add 169.254.43.43/32 dev lo 2>/dev/null || true

# App installs mount each app's FLUXFSVOL via `mount -o loop`. Loop devices are a
# shared host-kernel resource (not namespaced); the kernel default pool (max_loop,
# typically 8) is small and on-demand creation races under concurrent installs, so a
# fleet installing at once (e.g. instances == nodeCount) exhausts it and installs
# fail with "failed to setup loop device". Pre-create a generous pool so each
# concurrent mount finds a free device. /dev is shared across the privileged nodes,
# so this is idempotent fleet-wide (existing devices are skipped).
for i in $(seq 0 63); do
  [ -e "/dev/loop$i" ] || mknod -m660 "/dev/loop$i" b 7 "$i" 2>/dev/null || true
done

mkdir -p /dat/var/lib/fluxd \
         /dat/usr/lib/syncthing \
         /dat/usr/lib/fluxbenchd \
         /dat/usr/lib/fluxwatchdog \
         /mnt/appdata/flux-apps

cp /flux/test-infra/fixtures/syncthing-config.xml /dat/usr/lib/syncthing/config.xml 2>/dev/null || true

# Overlay test config into ZelBack/config/ so app.js loads it naturally.
# app.js hardcodes NODE_CONFIG_DIR to ZelBack/config/ (cannot be overridden
# from env — fluxbenchd hashes that directory for tamper detection).
if [ -n "$NODE_CONFIG_DIR" ] && [ -d "$NODE_CONFIG_DIR" ]; then
  cp "$NODE_CONFIG_DIR"/default.js /flux/ZelBack/config/local.js
  cp "$(dirname "$NODE_CONFIG_DIR")/shared.js" /flux/ZelBack/ 2>/dev/null || true
fi

if [ "$FLUX_DISCOVERY_AUTOSTART" = "true" ]; then
  sed -i 's/discoveryAutostart: false/discoveryAutostart: true/' /flux/ZelBack/shared.js
fi

# Syncthing listens on apiport+2 in production. The availability checker
# tests this port. Forward it to the syncthing stub's API port. In systemd
# mode the forward runs as a unit instead (syncthing-forward.service), so
# systemd supervises it like everything else.
SYNCTHING_LISTEN_PORT=$((${FLUX_API_PORT:-16127} + 2))
if [ -n "$FLUX_SYNCTHING_HOST" ] && [ "$FLUX_SYSTEMD_MODE" != "true" ]; then
  socat TCP-LISTEN:${SYNCTHING_LISTEN_PORT},fork,reuseaddr TCP:${FLUX_SYNCTHING_HOST}:${FLUX_SYNCTHING_PORT:-8384} &
fi

# Trust test registry CA for dockerd (Node.js uses NODE_EXTRA_CA_CERTS directly).
# The registry is reached by a stable network alias (fluxregistry.test), not an IP, so
# this path is base-independent — dockerd pulls fluxregistry.test:5000/... under any subnet.
if [ -f /usr/local/share/ca-certificates/test-registry.crt ]; then
  mkdir -p "/etc/docker/certs.d/fluxregistry.test:5000"
  cp /usr/local/share/ca-certificates/test-registry.crt "/etc/docker/certs.d/fluxregistry.test:5000/ca.crt"
fi

# Write boot_id for test harness control.
# FLUX_BOOT_ID is set per-container by the test harness.
# The harness seeds a heartbeat with matching or different value to
# control machineRebooted detection in readBootContext().
if [ -n "$FLUX_BOOT_ID" ]; then
  echo "$FLUX_BOOT_ID" > /tmp/flux-boot-id
fi

# ── systemd mode (opt-in; the journald-logging suite) ─────────────────────
# The node runs a real systemd as PID 1: dockerd and fluxos become units,
# fluxos's stdout is journal-connected (systemd sets JOURNAL_STREAM, the
# structural trigger lib/log.js keys on), and journalctl serves the admin
# log endpoints — the Arcane sink mode, which the default watchdog path
# cannot produce. Everything below this block is the legacy path and is
# unreachable in this mode; the fault-injection levers that live there
# (/tmp/dockerd-paused, /tmp/fluxos.pid — pauseDockerd/restartFluxos) do
# not exist under systemd.
if [ "$FLUX_SYSTEMD_MODE" = "true" ]; then
  # Container env does not cross into systemd services (the manager
  # environment arrives empty — validated on cindy), so dump it for the
  # units' EnvironmentFile. node writes C-style-quoted values, which keeps
  # NODE_CONFIG's embedded JSON quoting intact.
  node -e '
    const fs = require("fs");
    const skip = new Set(["PATH", "HOSTNAME", "HOME", "PWD", "OLDPWD", "SHLVL", "TERM", "SHELL", "_", "DEBIAN_FRONTEND", "LS_COLORS"]);
    const lines = Object.entries(process.env)
      .filter(([k]) => !skip.has(k))
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
    fs.writeFileSync("/etc/fluxos-harness.env", lines.join("\n") + "\n");
  '

  cp /flux/test-infra/systemd/*.service /flux/test-infra/systemd/*.slice /etc/systemd/system/
  mkdir -p /etc/systemd/system/multi-user.target.wants
  ln -sf /etc/systemd/system/dockerd.service /etc/systemd/system/multi-user.target.wants/dockerd.service
  ln -sf /etc/systemd/system/fluxos.service /etc/systemd/system/multi-user.target.wants/fluxos.service
  if [ -n "$FLUX_SYNCTHING_HOST" ]; then
    ln -sf /etc/systemd/system/syncthing-forward.service /etc/systemd/system/multi-user.target.wants/syncthing-forward.service
  fi

  # Container hygiene: kernel modules cannot be loaded here (the one unit
  # the smoke run showed failing), and a tmpfs over /tmp would shadow the
  # harness's /tmp/flux-boot-config bind mount.
  ln -sf /dev/null /etc/systemd/system/systemd-modules-load.service
  ln -sf /dev/null /etc/systemd/system/tmp.mount

  # ── Arcane host shape ────────────────────────────────────────────────
  # systemd mode IS the Arcane-shaped node: the same docker layout the ISO
  # provisions, so FluxOS's managed-storage capability probe (a real-state
  # check: xfs/prjquota docker root + host-swap fence + flux-apps.slice +
  # swap pool dir) passes and app containers land where production puts
  # them — /sys/fs/cgroup/flux.slice/flux-apps.slice, the path
  # flux-telemetryd's cgroup sampler reads.

  # docker-ce's packaged containerd.service would boot under systemd and
  # dockerd then prefers it — with its snapshotter on the overlayfs root
  # (EINVAL on overlay-on-overlay). Masked, dockerd spawns its own
  # containerd under the data-root, exactly like the default mode.
  ln -sf /dev/null /etc/systemd/system/containerd.service

  # The Arcane docker data-root on a real xfs+prjquota filesystem: docker's
  # overlay2 cannot back onto the container's own overlayfs, so the fs is a
  # loop-mounted image on the node volume.
  if [ ! -f /mnt/appdata/docker-xfs.img ]; then
    truncate -s 24G /mnt/appdata/docker-xfs.img
    mkfs.xfs -q /mnt/appdata/docker-xfs.img
  fi
  mkdir -p /dat/var/lib/docker
  mount -o loop,prjquota /mnt/appdata/docker-xfs.img /dat/var/lib/docker

  # daemon.json mirrors the ISO's docker_daemon.json + the systemd cgroup
  # driver (CgroupParent=flux-apps.slice needs it; probe-validated in the
  # nested node). The dockerd unit carries no flags — this file owns it.
  mkdir -p /etc/docker
  cat > /etc/docker/daemon.json <<EOF
{
  "data-root": "/dat/var/lib/docker",
  "exec-opts": ["native.cgroupdriver=systemd"]
}
EOF

  # Host-swap fence (finite MemorySwapMax on system.slice) + app swap pool
  # dir — the remaining capability-probe surfaces.
  mkdir -p /etc/systemd/system/system.slice.d /dat/app-swap
  cat > /etc/systemd/system/system.slice.d/fence.conf <<EOF
[Slice]
MemorySwapMax=1G
EOF

  # ── Real flux-telemetryd (opt-in; the telemetryd e2e suite) ──────────
  # The daemon binary and its REAL hardened unit are bind-mounted from the
  # runner host (cindy's vendored cargo build). Installed but NOT enabled:
  # FluxOS itself starts the unit when a telemetry app installs
  # (telemetryConfigService.ensureNode) — the production flow under test.
  if [ "$FLUX_TELEMETRYD_REAL" = "true" ]; then
    groupadd -f -r flux-telemetry
    id -u flux-telemetry >/dev/null 2>&1 || useradd -r -g flux-telemetry -s /usr/sbin/nologin flux-telemetry
    # /run is a fresh tmpfs once systemd boots — the runtime dir must come
    # from tmpfiles.d, not a pre-exec mkdir (which the mount would shadow).
    echo 'd /run/flux/telemetry 0750 root flux-telemetry -' > /etc/tmpfiles.d/flux-telemetry.conf
    install -m 0755 /opt/telemetryd-dist/flux-telemetryd /usr/local/bin/flux-telemetryd
    cp /opt/telemetryd-dist/flux-telemetryd.service /etc/systemd/system/
  fi

  exec /lib/systemd/systemd
fi

# cgroup v2: move existing processes to an init sub-cgroup so dockerd
# can enable subtree controllers (same approach as official docker:dind).
# Legacy mode only — under systemd the manager owns the cgroup tree and
# dockerd runs with Delegate=yes.
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  mkdir -p /sys/fs/cgroup/init
  xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || :
  sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers \
      > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || :
fi

# Start dockerd under a tiny watchdog so it is respawned if it exits. Production
# nodes run dockerd under systemd (which restarts it); this mirrors that and lets
# tests bounce dockerd (kill it) to exercise the reconciler's reconnect/orphan
# recovery without bricking the node. node app.js stays PID 1 (via exec below).
rm -f /var/run/docker.pid
(
  set +e
  while true; do
    # Fault-injection lever: a test can hold dockerd DOWN (a real docker outage) by
    # creating /tmp/dockerd-paused (and killing dockerd); the watchdog then refuses to
    # respawn it until the file is removed. Unlike a plain bounce (restartDockerd), this
    # keeps docker unreachable for an arbitrary window, so a suite can exercise teardown /
    # reconcile convergence across a genuine outage without bricking the node.
    while [ -f /tmp/dockerd-paused ]; do sleep 0.3; done
    rm -f /var/run/docker.pid
    dockerd --data-root /mnt/appdata/docker
    echo "dockerd exited (rc=$?), respawning in 1s" >&2
    sleep 1
  done
) &

TIMEOUT=30
ELAPSED=0
until docker info > /dev/null 2>&1; do
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    echo "ERROR: dockerd failed to start within ${TIMEOUT}s" >&2
    exit 1
  fi
  sleep 1
  ELAPSED=$((ELAPSED + 1))
done
echo "dockerd is ready (took ${ELAPSED}s)"

# Optional mock flux-shutdownd for the graceful-stop suites: a second in-container
# process that binds the daemon socket and drives the inner dockerd (each node is
# DinD, so a sidecar could not reach these app containers). Started after dockerd
# since begin_app_stop docker-stops the app's containers. Gated so only those suites
# pay for it. The mock uses Node built-ins only, so it needs no extra install.
if [ "$FLUX_SHUTDOWND_MOCK" = "true" ]; then
  mkdir -p /run/flux-shutdownd
  node /flux/test-infra/shutdownd-stub/index.js &
  echo "started mock flux-shutdownd (control port ${SHUTDOWND_MOCK_CONTROL_PORT:-16199})"
fi

# Optional mock flux-telemetryd for the telemetry suites. The real daemon is a
# host-side client of FluxOS's identity socket; the mock plays that client role
# in-container. The runtime dir must exist BEFORE fluxos boots — FluxOS's
# write-probe on /run/flux/telemetry is its Arcane gate for the identity server
# (on a real Arcane node the daemon's package ships the dir). The mock itself
# retries until the socket appears. Node built-ins only.
if [ "$FLUX_TELEMETRYD_MOCK" = "true" ]; then
  mkdir -p /run/flux/telemetry
  node /flux/test-infra/telemetryd-stub/index.js &
  echo "started mock flux-telemetryd (control port ${TELEMETRYD_MOCK_CONTROL_PORT:-16198})"
fi

# Run FluxOS (CMD ["node","app.js"]) under a respawn watchdog instead of exec'ing it
# as PID 1. This mirrors the dockerd watchdog above and production's systemd: the
# entrypoint shell stays PID 1 and node runs as a child, so a test can kill+respawn
# the FluxOS process (restartFluxos) WITHOUT restarting the container or the inner
# dockerd - the app containers keep running, exactly like `systemctl restart fluxos`.
# The child PID is written to /tmp/fluxos.pid so a test kills only the node process,
# never PID 1. A SIGTERM/SIGINT (docker stop at teardown) stops the child and exits.
set +e
STOPPING=0
trap 'STOPPING=1; kill -TERM "$(cat /tmp/fluxos.pid 2>/dev/null)" 2>/dev/null' TERM INT
while [ "$STOPPING" = "0" ]; do
  "$@" &
  FLUXOS_PID=$!
  echo "$FLUXOS_PID" > /tmp/fluxos.pid
  wait "$FLUXOS_PID"
  [ "$STOPPING" = "1" ] && break
  echo "fluxos (node app.js) exited, respawning in 1s" >&2
  sleep 1
done
