#!/usr/bin/env bash
# Build the flux-dnsd this branch pairs with, for the mesh DNS e2e suite
# (dnsdReal nodes bind-mount dist/). The pairing is declared by `pin` (full
# commit hash) — bump it deliberately, like a flux_iso pin.
#
# Skips when dist/ already matches the pin; pass --force to rebuild anyway.
# The clone lives OUTSIDE the repo tree (its target/ is large and the image
# build context tars the whole checkout); only the small dist/ is in-repo.
#
# Builds in a dockerized Rust toolchain (no host rust needed) with a named
# cargo-cache volume for fast incremental rebuilds. glibc (bookworm) is
# forward-compatible with the Ubuntu node containers. Building from a real
# clone also makes the daemon's build.rs stamp the true commit into
# --version, which the suite asserts against the pin.
#
#   bash test-infra/flux-dnsd/build.sh [--force]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="${DNSD_REPO:-https://github.com/RunOnFlux/flux-dnsd.git}"
pin="$(tr -d '[:space:]' < "$here/pin")"
src="${DNSD_SRC:-$HOME/.cache/flux-e2e/flux-dnsd}"
dist="$here/dist"
force=0
[ "${1:-}" = "--force" ] && force=1

if [ "$force" = 0 ] && [ -x "$dist/flux-dnsd" ] \
   && [ "$(cat "$dist/.built-ref" 2>/dev/null)" = "$pin" ]; then
  echo "flux-dnsd dist current at ${pin:0:12} — skipping (--force to rebuild)"
  exit 0
fi

if [ ! -d "$src/.git" ]; then
  mkdir -p "$(dirname "$src")"
  git clone "$repo" "$src"
fi
git -C "$src" fetch origin
git -C "$src" checkout -q "$pin"

# safe.directory: the builder runs as root against a host-owned clone, and
# git's dubious-ownership check would otherwise fail build.rs's rev-parse
# silently — stamping "git unknown" into --version (which the suite pins).
docker run --rm -v "$src:/src" -w /src \
  -v flux-e2e-cargo-cache:/usr/local/cargo/registry \
  rust:1-bookworm sh -c 'git config --global --add safe.directory /src && cargo build --release'

mkdir -p "$dist"
cp "$src/target/release/flux-dnsd" "$dist/flux-dnsd"
cp "$src/packaging/systemd/flux-dnsd.service" "$dist/flux-dnsd.service"
echo "$pin" > "$dist/.built-ref"
echo "built flux-dnsd ${pin:0:12} -> $dist ($(wc -c < "$dist/flux-dnsd") bytes)"
