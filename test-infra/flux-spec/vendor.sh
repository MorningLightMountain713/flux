#!/usr/bin/env bash
# Vendor the flux-spec this branch pairs with into test-infra/flux-spec/dist —
# the same place every other pinned build artifact lands (flux-telemetryd,
# flux-shutdownd, flux-dnsd). The harness image COPYs it in as a sibling of
# /flux, which is where package.json's `file:../flux-spec/packages/*` deps
# resolve it INSIDE the image. The pairing is declared by `pin` (full commit
# hash) — bump it in the same commit that starts calling a newer spec API,
# like a flux_iso pin.
#
# It is deliberately NOT vendored at the repo root: a whole foreign package
# sitting beside ZelBack reads as this repo's source, and every tool that walks
# the tree (eslint first) has to be taught otherwise, one special case at a time.
#
# Skips when the vendor already matches the pin; pass --force to re-vendor.
#
#   bash test-infra/flux-spec/vendor.sh [--force]
#
# The clone is over ssh (private repo) — run with your agent forwarded. It
# lives OUTSIDE the repo tree because the image build context tars the whole
# checkout and there is no .dockerignore; the vendor itself is exported with
# `git archive`, so no .git and no node_modules ever enter the context. The
# vendor has to stay INSIDE the context (docker cannot COPY from outside it),
# which is why it is a gitignored build product rather than an external path.
#
# Re-vendoring changes what the image bakes: REBUILD the node image after this
# (the guard in framework/flux-spec-vendor.js enforces it).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
repo="${FLUX_SPEC_REPO:-git@github.com:MorningLightMountain713/flux-spec.git}"
pin="$(tr -d '[:space:]' < "$here/pin")"
src="${FLUX_SPEC_SRC:-$HOME/.cache/flux-e2e/flux-spec}"
vendor="$here/dist"
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

# Resolve the pin BEFORE touching what is already vendored. A pin that has not
# been pushed is the likely reason this fails, and the old order deleted a
# working vendor and only then discovered it had nothing to replace it with —
# leaving the checkout unable to build a fleet at all, which is a worse state
# than the stale one it started in.
if ! git -C "$src" rev-parse -q --verify "$pin^{commit}" >/dev/null 2>&1; then
  echo "flux-spec: pin ${pin:0:12} is not in $repo." >&2
  echo "  It is almost certainly unpushed — push the commit the pin names, then re-run." >&2
  echo "  The existing vendor at $(cat "$vendor/.vendored-ref" 2>/dev/null || echo 'none') is untouched." >&2
  exit 1
fi

# git archive exports exactly the tracked tree at the pin — the vendor is
# rebuilt from scratch so a shrinking package set cannot leave orphans behind,
# and stale transitive deps (the skew class this machinery exists to kill)
# cannot survive a re-vendor. It is staged beside the vendor and swapped in only
# once the export succeeds, so a failure mid-extract cannot leave a half-tree
# wearing a stamp that says it is complete.
staged="$vendor.staging.$$"
trap 'rm -rf "$staged"' EXIT
rm -rf "$staged"
mkdir -p "$staged"
git -C "$src" archive "$pin" | tar -x -C "$staged"
echo "$pin" > "$staged/.vendored-ref"
rm -rf "$vendor"
mv "$staged" "$vendor"

# Workspace install: the runner imports @runonflux/* from this tree on the
# host, and the image repeats the install for the node containers.
(cd "$vendor" && npm install --omit=dev)

echo "vendored flux-spec ${pin:0:12} -> $vendor"
echo "REBUILD the node image: docker build -f test-infra/Dockerfile.fluxos -t flux-e2e-fluxos-01 ."
