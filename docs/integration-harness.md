# Integration test harness

The integration harness (`test-infra/`) boots a fleet of real FluxOS nodes in
Docker — each node a privileged container running the production code with its
own inner dockerd — alongside a mocked chain daemon, syncthing, FDM and peer
stubs, MongoDB, and a private image registry. Suites under
`test-infra/runner/tests/` drive the fleet over the real HTTP API and SSE
event stream and assert on cluster-level behavior (boot, peering, app
install/removal, spawning, the container reconciler, syncthing deciders,
masterSlave election, crash and dockerd-restart recovery).

Everything below runs from a checkout of this repository on the test host.

## Host prerequisites

- Linux x86_64. The harness manages its own containers; do not run it on a
  host whose Docker state you cannot afford to disturb, and never from a
  production FluxOS install directory.
- Docker Engine with the compose plugin, able to run **privileged**
  containers (each node runs an inner dockerd and provisions its own loop
  device pool).
- Node.js 20+ on the host (the runner itself is mocha on the host; the node
  image bakes its own Node 20).
- Memory: a 10-node fleet uses roughly 3–5 GB. The parallel runner gates
  admission on free RAM (`MIN_FREE_MB`, default 15000) — hosts under ~16 GB
  must lower it or the gate deadlocks (see the CI workflow, which derives
  total/4 capped at 15000).
- CPU is the real parallelism bottleneck: fleets admitted onto a saturated
  host boot slowly enough to blow event-wait budgets while perfectly healthy.
  The launch gate refuses new suites at `MAX_LOAD` (default 3/4 of cores).
- Fast storage for Docker's data root; a full run builds and destroys
  hundreds of containers.

## Build

From the repository root:

```bash
# Runner dependencies (mocha, testcontainers, ...)
(cd test-infra/runner && npm ci)

# The node image + the five stubs (compose project name fixes the image tags)
docker compose -f test-infra/docker-compose.yml -p flux-e2e build \
  fluxos-01 daemon-stub syncthing-stub fdm-stub peer-stub external-http-stub

# Supporting images
docker pull mongo:8
docker pull registry:2

# The configurable test app (static binary the suites push to the harness
# registry; env-driven EXIT_CODE / EXIT_AFTER_S for exit-code scenarios)
bash test-infra/test-app/build.sh
```

Rebuild the node image only when `ZelBack/` (or anything else
`test-infra/Dockerfile.fluxos` COPYs) changes. Changes under
`test-infra/runner/**` are host-side — no rebuild needed. Rebuild the test
app only when `test-app.c` changes.

## Running

### A single suite

```bash
cd test-infra/runner
npx mocha tests/28-reconciler-dockerd-restart.js --timeout 300000
```

The suite boots its own fleet (10 nodes by default), runs, and tears down.
Solo runs keep testcontainers' ryuk reaper for crash safety; the multi-suite
runners disable it (see below).

### All suites, sequential — `run-all.sh`

```bash
test-infra/runner/run-all.sh
```

Every suite in `tests/*.js`, each in its own mocha process (per-suite
process isolation prevents teardown bleed across suites). Expect ~2 hours
for the full set. Output is TAP plus `###`-prefixed markers
(`###SUITE-START`, `###SUITE-END`, `###RUN-DONE suites_pass=N
suites_fail=N failed:[...]`); per-suite TAP is saved under the log dir.

Knobs (env vars):

| Variable | Default | Meaning |
|---|---|---|
| `SUITE_GLOB` | `tests/*.js` | subset, e.g. `'tests/3*.js'` |
| `SUITE_TIMEOUT_MS` | `300000` | per-test mocha timeout |
| `E2E_LOG_DIR` | `/tmp/e2e-logs` | log root |
| `TEST_SUBNET_BASE` | auto-claimed | `/24` base, e.g. `198.18.0` |
| `E2E_RUN_LABEL` | `run-$$-<epoch>` | unique run label (see Isolation) |

### All suites, parallel — `run-parallel.sh`

```bash
test-infra/runner/run-parallel.sh                    # all suites, heavy-first
SUITES='28 37 35' test-infra/runner/run-parallel.sh  # subset by number
MAXN=2 MIN_FREE_MB=20000 test-infra/runner/run-parallel.sh
```

Launches one single-suite `run-all.sh` per suite, admitting a new one only
while fewer than `MAXN` (default 3) are in flight AND at least `MIN_FREE_MB`
RAM is free AND the load average is under `MAX_LOAD`. Self-throttles and
never OOMs (an OOM-killed node is indistinguishable from a real failure).
Expect ~40 minutes for the full set at `MAXN=3` on a large host. Exit
status is non-zero if any suite failed; the aggregate tally is the
`RESULT suites_pass=... FAILED:[...]` line in `driver.log`.

Logs under `$E2E_LOG_DIR`:

| File | Content |
|---|---|
| `<n>.out` | full stdout of suite n's run-all |
| `<n>/<name>.tap` | per-test TAP for suite n |
| `driver.log` | LAUNCH/DONE/RESULT progress |
| `cap-events.log` | `docker events` (die/kill/oom, exit codes; **epoch-seconds** timestamps) |
| `cap-mem.log` | host free RAM / load / container count, 5s cadence |
| `cap-dmesg.log` | kernel OOM kills |

### CI

`.github/workflows/integration-harness.yml` is a manual-dispatch workflow
(inputs: `suites`, `maxn`) that builds the images, derives `MIN_FREE_MB`
from host RAM, runs `run-parallel.sh`, posts a summary, and uploads the log
directory as an artifact. The pre/post cleanup is scoped to harness objects
only — safe on a shared runner.

## How isolation works (what you need to know to not fight it)

- **Per-suite `/24`.** Each suite carves a private `/24` from
  `198.18.0.0/15` (RFC 2544 — FluxOS accepts it as "public", and it never
  routes). Fixed in-subnet layout: `.2` mongo, `.3` daemon-stub, `.4`
  syncthing-stub, `.5` registry (alias `fluxregistry:5000`), `.6`
  external-http-stub, `.7` fdm-stub, nodes from `.10`. Bases are claimed
  atomically (mkdir + flock under `/tmp/e2e-base-locks`), so concurrent runs
  never collide.
- **Run labels, not ryuk.** Every container/network/volume a run creates is
  stamped with its `E2E_RUN_LABEL`; cleanup is scoped to that label.
  testcontainers' ryuk reaper is **disabled** under the runners
  (`TESTCONTAINERS_RYUK_DISABLED=true`): ryuk shares one session across
  concurrent processes and, at zero connections, force-removes every
  labelled object — including a sibling suite's live fleet.
- **Boot semaphore.** Fleet boots are serialised host-wide
  (`/tmp/e2e-boot-lock`), held until every node emits `daemon:polled`.
  Concurrent fleet boots are the contended phase; everything after
  parallelises fine.
- **In-container watchdogs.** The node entrypoint pre-creates 64 loop
  devices (concurrent volume mounts exhaust the kernel default of ~8), runs
  the inner dockerd under a respawn loop (tests can kill dockerd to exercise
  reconnect/orphan recovery), and runs FluxOS itself under a respawn loop as
  a child process (tests can kill and observe a process restart without
  losing the container).
- **Test config overlay.** `test-infra/config/shared.js` compresses the
  production decider cadences (syncthing monitor interval, stall sample
  count, masterSlave election interval) so suites finish in minutes; the
  entrypoint overlays it into the node's config search path.

## Hygiene

After an aborted run (Ctrl+C, SSH drop), stale networks and locks make every
new suite fail instantly on subnet collision. Deep-clean (scoped to harness
objects):

```bash
docker ps -aq --filter label=org.testcontainers=true | xargs -r docker rm -f
docker network ls --format '{{.Name}}' | grep -vE '^(bridge|host|none)$' | xargs -r docker network rm
rm -rf /tmp/e2e-base-locks /tmp/e2e-boot-lock
```

(The network sweep assumes a dedicated test host; on a shared host, filter
to `flux-test-*` names instead.)

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| suite instant-fails ~1s after launch | stale `flux-test-*` networks / locks from an aborted run | deep-clean above |
| `waitForEvent(...)` times out, no error anywhere | the event name is not subscribed in `runner/framework/node-client.js` — EventSource silently drops unsubscribed named events | add the `addEventListener` entry for every new `fluxEventBus.publish` name |
| hook timeout at ~120s despite `SUITE_TIMEOUT_MS=300000` | mocha hook timeouts are per-suite (`this.timeout(...)` in before/after), not the runner knob | raise the suite's hook timeout |
| fleets boot but tests time out under parallelism | host CPU-saturated; boots paced too slow | lower `MAXN`, check `cap-mem.log` load column |
| container build fails with "parent snapshot does not exist" | transient containerd image-store glitch | `docker image rm -f` the tag, `docker builder prune -af`, rebuild `--no-cache` |
| `cap-events.log` timestamps look wrong | `docker events` prints epoch seconds, not ISO | convert; also remember harness logs are UTC |
| a wait on a log line right after an SSE event flakes | event delivery (<1ms) races docker's log pipeline (tens of ms) | await the event, then poll for the log line — never assert it instantly |
