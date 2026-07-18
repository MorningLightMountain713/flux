# flux-telemetryd pairing for the test harness

FluxOS and flux-telemetryd ship together (one ISO) and speak a private
identity-socket protocol with no compatibility aliases — so the harness
tests them **as a pair**. This directory declares which daemon commit this
branch pairs with and builds it for the real-daemon e2e suite
(`runner/tests/73-flux-telemetryd-e2e.js`).

## Files

- `pin` — the full commit hash of the paired flux-telemetryd. Bumping it is
  a deliberate pairing change (the same act as bumping the flux_iso pin),
  reviewed like any other diff.
- `build.sh` — produces `dist/` (gitignored): the daemon binary plus its
  real hardened systemd unit, taken from the pinned checkout. Builds in a
  dockerized Rust toolchain with a cargo-cache volume — no host Rust
  needed. Skips when `dist/.built-ref` already matches the pin; pass
  `--force` to rebuild anyway. The clone lives outside the repo tree
  (`~/.cache/flux-e2e/flux-telemetryd`) so its `target/` never bloats the
  node-image build context.

## Workflow

```
# after cloning, or whenever the pin changes:
bash test-infra/flux-telemetryd/build.sh
```

The clone is over ssh (private repo) — run with your agent forwarded.

To pair with a new daemon commit: update `pin`, run `build.sh`, run suite
73.

## How the pairing is enforced

- `createTestEnv({ telemetrydReal: true })` bind-mounts `dist/` into the
  (systemd-mode) node containers and fails fast with the build command if
  `dist/` is missing.
- The node entrypoint installs the binary and the unit **without enabling
  it** — FluxOS itself starts and stops the daemon
  (`telemetryConfigService.ensureNode` / `remove`), which is the
  production lifecycle under test.
- Suite 73 asserts the running daemon's `--version` (its build stamps the
  source commit) against `pin`, so a stale `dist/` fails loudly instead of
  silently testing the wrong daemon.

## Overrides

- `TELEMETRYD_REPO` — clone URL (default `git@github.com:RunOnFlux/flux-telemetryd.git`)
- `TELEMETRYD_SRC` — checkout location
- `TELEMETRYD_BINARY` / `TELEMETRYD_UNIT` — point the harness at a
  non-default build (e.g. a local work-in-progress daemon); note suite
  73's version-vs-pin assertion still applies.
