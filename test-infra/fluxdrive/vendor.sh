#!/usr/bin/env bash
# Vendor the FluxDrive API this branch pairs with into test-infra/fluxdrive/src,
# the build context of the real-FluxDrive image (`createTestEnv({ fluxDrive:
# 'real' })`). The pairing is declared by `pin` (full commit hash).
#
# Skips when the vendor already matches the pin; pass --force to re-vendor.
#
#   bash test-infra/fluxdrive/vendor.sh [--force]
#
# The clone is over ssh (private repo) unless FLUXDRIVE_SRC names an existing
# clone holding the pin. It lives outside the repo tree; the vendor is exported
# with `git archive`, so no .git and no node_modules enter the build context.
# image-digest.sh refuses to digest this image while the vendor's stamp differs
# from the pin, so a stale vendor fails verify-images.sh by name.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="${FLUXDRIVE_REPO:-git@github.com:RunOnFlux/FluxDrive.git}"
pin="$(tr -d '[:space:]' < "$here/pin")"
src="${FLUXDRIVE_SRC:-$HOME/.cache/flux-e2e/FluxDrive}"
vendor="$here/src"
force=0
[ "${1:-}" = "--force" ] && force=1

if [ "$force" = 0 ] && [ "$(cat "$vendor/.vendored-ref" 2>/dev/null)" = "$pin" ]; then
  echo "FluxDrive vendor current at ${pin:0:12} — skipping (--force to re-vendor)"
  exit 0
fi

if [ ! -d "$src/.git" ]; then
  mkdir -p "$(dirname "$src")"
  git clone "$repo" "$src"
fi
if ! git -C "$src" rev-parse -q --verify "$pin^{commit}" >/dev/null 2>&1; then
  git -C "$src" fetch origin
fi
if ! git -C "$src" rev-parse -q --verify "$pin^{commit}" >/dev/null 2>&1; then
  echo "FluxDrive: pin ${pin:0:12} is not in $src." >&2
  echo "  The existing vendor at $(cat "$vendor/.vendored-ref" 2>/dev/null || echo 'none') is untouched." >&2
  exit 1
fi

# Staged beside the vendor and swapped in only once the export succeeds, so a
# failure mid-extract cannot leave a half-tree wearing a complete stamp.
staged="$vendor.staging.$$"
trap 'rm -rf "$staged"' EXIT
rm -rf "$staged"
mkdir -p "$staged"
git -C "$src" archive "$pin" fluxdrive-api | tar -x -C "$staged" --strip-components=1
rm -rf "$staged/tests"
echo "$pin" > "$staged/.vendored-ref"
rm -rf "$vendor"
mv "$staged" "$vendor"

echo "vendored FluxDrive ${pin:0:12} -> $vendor"
echo "REBUILD the image: FLUX_E2E_TAG=<tag> ./test-infra/build-images.sh fluxdrive"
