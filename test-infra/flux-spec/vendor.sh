#!/usr/bin/env bash
# Vendor the flux-spec this branch pairs with into <repo>/flux-spec, where
# package.json's `file:../flux-spec/packages/*` deps resolve it (the harness
# image COPYs the directory in as a sibling of /flux). The pairing is declared
# by `pin` (full commit hash) — bump it in the same commit that starts calling
# a newer spec API, like a flux_iso pin.
#
# Skips when the vendor already matches the pin; pass --force to re-vendor.
#
#   bash test-infra/flux-spec/vendor.sh [--force]
#
# The clone is over ssh (private repo) — run with your agent forwarded. It
# lives OUTSIDE the repo tree because the image build context tars the whole
# checkout and there is no .dockerignore; the vendor itself is exported with
# `git archive`, so no .git and no node_modules ever enter the context.
#
# Re-vendoring changes what the image bakes: REBUILD the node image after this
# (the guard in framework/flux-spec-vendor.js enforces it).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
repo="${FLUX_SPEC_REPO:-git@github.com:MorningLightMountain713/flux-spec.git}"
pin="$(tr -d '[:space:]' < "$here/pin")"
src="${FLUX_SPEC_SRC:-$HOME/.cache/flux-e2e/flux-spec}"
vendor="$repo_root/flux-spec"
force=0
[ "${1:-}" = "--force" ] && force=1

if [ "$force" = 0 ] && [ "$(cat "$vendor/.vendored-ref" 2>/dev/null)" = "$pin" ]; then
  echo "flux-spec vendor current at ${pin:0:12} — skipping (--force to re-vendor)"
  exit 0
fi

if [ ! -d "$src/.git" ]; then
  mkdir -p "$(dirname "$src")"
  git clone "$repo" "$src"
fi
git -C "$src" fetch origin

# git archive exports exactly the tracked tree at the pin — the vendor is
# rebuilt from scratch so a shrinking package set cannot leave orphans behind,
# and stale transitive deps (the skew class this machinery exists to kill)
# cannot survive a re-vendor.
rm -rf "$vendor"
mkdir -p "$vendor"
git -C "$src" archive "$pin" | tar -x -C "$vendor"
echo "$pin" > "$vendor/.vendored-ref"

# Workspace install: the runner imports @runonflux/* from this tree on the
# host, and the image repeats the install for the node containers.
(cd "$vendor" && npm install --omit=dev)

echo "vendored flux-spec ${pin:0:12} -> $vendor"
echo "REBUILD the node image: docker build -f test-infra/Dockerfile.fluxos -t flux-e2e-fluxos-01 ."
