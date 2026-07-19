#!/usr/bin/env bash
# Build the flux-shutdownd this branch pairs with, for the real-daemon e2e
# suite (shutdowndReal nodes bind-mount dist/). The pairing is declared by
# `pin` (full commit hash) — bump it deliberately, like a flux_iso pin.
#
# Skips when dist/ already matches the pin; pass --force to rebuild anyway.
# The clone lives OUTSIDE the repo tree (its target/ is ~1GB and the image
# build context tars the whole checkout); only the binaries are in-repo.
#
# Builds in a dockerized Rust toolchain (no host rust needed) with a named
# cargo-cache volume for fast incremental rebuilds. glibc (bookworm) is
# forward-compatible with the Ubuntu node containers.
#
#   bash test-infra/flux-shutdownd/build.sh [--force]
#
# The clone is over ssh (private repo) — run with your agent forwarded.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="${SHUTDOWND_REPO:-git@github.com:RunOnFlux/flux-shutdownd.git}"
pin="$(tr -d '[:space:]' < "$here/pin")"
src="${SHUTDOWND_SRC:-$HOME/.cache/flux-e2e/flux-shutdownd}"
dist="$here/dist"
force=0
[ "${1:-}" = "--force" ] && force=1

if [ "$force" = 0 ] && [ -x "$dist/flux-shutdownd" ] && [ -x "$dist/shutdownctl" ] \
   && [ "$(cat "$dist/.built-ref" 2>/dev/null)" = "$pin" ]; then
  echo "flux-shutdownd dist current at ${pin:0:12} — skipping (--force to rebuild)"
  exit 0
fi

if [ ! -d "$src/.git" ]; then
  mkdir -p "$(dirname "$src")"
  git clone "$repo" "$src"
fi
git -C "$src" fetch origin
git -C "$src" checkout -q "$pin"

# safe.directory: the builder runs as root against a host-owned clone, and
# git's dubious-ownership check makes cargo's own git operations fail.
docker run --rm -v "$src:/src" -w /src \
  -v flux-e2e-cargo-cache:/usr/local/cargo/registry \
  rust:1-bookworm sh -c 'git config --global --add safe.directory /src && cargo build --release -p flux-shutdownd -p shutdownctl'

mkdir -p "$dist"
# The daemon, the operator CLI the suite reads plans through, and the dbus
# policy that lets the daemon own its bus name (it refuses to start without
# the name).
cp "$src/target/release/flux-shutdownd" "$dist/flux-shutdownd"
cp "$src/target/release/shutdownctl" "$dist/shutdownctl"
cp "$src/packaging/dbus/io.runonflux.Shutdownd.conf" "$dist/io.runonflux.Shutdownd.conf"
echo "$pin" > "$dist/.built-ref"
echo "built flux-shutdownd ${pin:0:12} -> $dist ($(wc -c < "$dist/flux-shutdownd") bytes)"
