# flux-shutdownd pairing for the test harness

The graceful-stop suites drive FluxOS's daemon client against
`test-infra/shutdownd-stub`, a Node mock that speaks the socket's JSON-RPC
dialect. That pins the FluxOS half of the contract but is structurally blind
to one class of bug: the two real ends disagreeing. This directory declares
which flux-shutdownd commit this branch pairs with and builds it, so the
co-location suite can run against the actual Rust daemon — its own plan
store, its own container grouping, its own drain.

## Files

- `pin` — the full commit hash of the paired flux-shutdownd. Bumping it is a
  deliberate pairing change, reviewed like any other diff.
- `build.sh` — produces `dist/` (gitignored): the daemon, the `shutdownctl`
  CLI the suite reads plans through, and the dbus policy the daemon needs to
  own its bus name. Builds in a dockerized Rust toolchain with a cargo-cache
  volume — no host Rust needed. Skips when `dist/.built-ref` matches the pin;
  `--force` rebuilds. The clone lives outside the repo tree
  (`~/.cache/flux-e2e/flux-shutdownd`) so its `target/` never enters the
  node-image build context.

## Workflow

```
# after cloning, or whenever the pin changes:
bash test-infra/flux-shutdownd/build.sh
```

The clone is over ssh (private repo) — run with your agent forwarded.

## How it runs in a node

`createTestEnv({ shutdowndReal: true })` bind-mounts `dist/` and the
entrypoint starts the daemon in the node container, replacing the mock.
Unlike the real flux-telemetryd — which needs systemd-mode nodes because
FluxOS starts it as a unit — this daemon runs under the default entrypoint:

- its socket, data dir and fluxos-socket paths are all environment
  configurable, and it defaults to the same
  `/run/flux-shutdownd/daemon.sock` FluxOS's client dials;
- its `sd_notify` readiness call is best-effort, so no service manager is
  required to supervise it;
- it must run where the app containers are. Each node is DinD, so a sidecar
  could not reach them — the daemon runs in the node container, exactly as
  the mock does.

It does need a system dbus: the daemon serves the `io.runonflux.Shutdownd`
interface and treats failure to acquire that name as fatal, so the
entrypoint starts `dbus-daemon --system` and installs the policy from
`dist/` before launching it.

## The pairing guarantee, and its limit

`build.sh` writes `.built-ref` only after a successful build of the pinned
checkout, and `createTestEnv` refuses to boot when it does not match `pin` —
so a stale `dist/` fails loudly at boot rather than quietly testing the
wrong daemon.

That is weaker than the telemetryd pairing, and deliberately not dressed up
as equivalent: flux-shutdownd has no `build.rs` stamping its source commit
into `--version`, so nothing can assert the *running binary's* provenance
from inside the suite the way suite 73 does. `.built-ref` attests to the
build, not to the process. If the daemon gains a version stamp, tighten this
to a runtime assertion.

## Overrides

- `SHUTDOWND_REPO` — clone URL (default `git@github.com:RunOnFlux/flux-shutdownd.git`)
- `SHUTDOWND_SRC` — checkout location
- `SHUTDOWND_BINARY` / `SHUTDOWNCTL_BINARY` — point the harness at a
  non-default build (e.g. a local work-in-progress daemon)
