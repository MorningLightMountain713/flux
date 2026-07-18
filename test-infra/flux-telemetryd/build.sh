#!/usr/bin/env bash
# Build the flux-telemetryd this branch pairs with, for the real-daemon e2e
# suite (telemetrydReal nodes bind-mount dist/). The pairing is declared by
# `pin` (full commit hash) — bump it deliberately, like a flux_iso pin.
#
# Skips when dist/ already matches the pin; pass --force to rebuild anyway.
# The clone lives OUTSIDE the repo tree (its target/ is ~1GB and the image
# build context tars the whole checkout); only the ~7MB dist/ is in-repo.
#
# Builds in a dockerized Rust toolchain (no host rust needed) with a named
# cargo-cache volume for fast incremental rebuilds. glibc (bookworm) is
# forward-compatible with the Ubuntu node containers. Building from a real
# clone also makes the daemon's build.rs stamp the true commit into
# --version, which the suite asserts against the pin.
#
#   bash test-infra/flux-telemetryd/build.sh [--force]
#
# The clone is over ssh (private repo) — run with your agent forwarded.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="${TELEMETRYD_REPO:-git@github.com:RunOnFlux/flux-telemetryd.git}"
pin="$(tr -d '[:space:]' < "$here/pin")"
src="${TELEMETRYD_SRC:-$HOME/.cache/flux-e2e/flux-telemetryd}"
dist="$here/dist"
force=0
[ "${1:-}" = "--force" ] && force=1

if [ "$force" = 0 ] && [ -x "$dist/flux-telemetryd" ] \
   && [ "$(cat "$dist/.built-ref" 2>/dev/null)" = "$pin" ]; then
  echo "flux-telemetryd dist current at ${pin:0:12} — skipping (--force to rebuild)"
  exit 0
fi

if [ ! -d "$src/.git" ]; then
  mkdir -p "$(dirname "$src")"
  git clone "$repo" "$src"
fi
git -C "$src" fetch origin
git -C "$src" checkout -q "$pin"

docker run --rm -v "$src:/src" -w /src \
  -v flux-e2e-cargo-cache:/usr/local/cargo/registry \
  rust:1-bookworm cargo build --release

mkdir -p "$dist"
cp "$src/target/release/flux-telemetryd" "$dist/flux-telemetryd"
cp "$src/packaging/systemd/flux-telemetryd.service" "$dist/flux-telemetryd.service"
echo "$pin" > "$dist/.built-ref"
echo "built flux-telemetryd ${pin:0:12} -> $dist ($(wc -c < "$dist/flux-telemetryd") bytes)"
