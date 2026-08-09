# flux-dnsd for the harness

The real mesh DNS resolver, delivered to systemd-mode nodes the same way
flux-telemetryd is: `pin` names the flux-dnsd commit this branch pairs with,
`build.sh` produces a gitignored `dist/` (binary + the repo's own systemd
unit + `.built-ref`), and `createTestEnv({ dnsdReal: true })` bind-mounts the
dist read-only at `/opt/dnsd-dist`. The entrypoint installs the binary and
unit and — unlike telemetryd — **enables it at boot**, matching the OS: the
resolver serves whatever membership snapshot exists, FluxOS never starts it.

The node image never bakes the daemon; a node without `dnsdReal` has no
resolver and containers ride their fallback nameservers, which is itself the
designed failure mode.

Bump `pin` deliberately, like a flux_iso pin. Overrides: `DNSD_REPO`,
`DNSD_SRC`, and at env-creation time `DNSD_BINARY` / `DNSD_UNIT` (point the
mounts at a locally-built binary; the pin check is skipped for an override).
