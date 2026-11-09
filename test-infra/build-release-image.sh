#!/bin/bash
# Builds a node image whose FluxOS is another ref's product code inside this tree's
# harness - the stubs, entrypoint and runner a fleet of this tree boots with - so a
# suite can boot a node on a released FluxOS and upgrade it in place to this tree's.
#
#   ./test-infra/build-release-image.sh                     # the release test-infra/base-release names
#   FLUX_E2E_TAG=<tag> ./test-infra/build-release-image.sh <git ref>
#
# With no ref it builds the release test-infra/base-release names, under the tag
# release-<release>, which is the base image the runner boots by default. The image
# is labelled flux.e2e.release with the ref it holds; the gate refuses a base image
# whose label is not the pinned release.
#
# The ref must be in this clone. Builds fluxos-01 only, stamped like any other
# (build-images.sh), from a temporary worktree of HEAD with the product paths
# taken from the ref and the per-node configs generated from the ref's own config.
# The gitignored build products the image needs are copied from this clone.
set -euo pipefail

CLONE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ $# -eq 0 ]; then
  REF=$(tr -d '[:space:]' < "$CLONE/test-infra/base-release")
  FLUX_E2E_TAG=${FLUX_E2E_TAG:-release-$REF}
  git -C "$CLONE" rev-parse --verify --quiet "refs/tags/$REF" >/dev/null \
    || git -C "$CLONE" fetch --no-tags --quiet https://github.com/RunOnFlux/flux.git "refs/tags/$REF:refs/tags/$REF"
else
  REF=$1
fi
: "${FLUX_E2E_TAG:?FLUX_E2E_TAG names the tag to build under}"
export FLUX_E2E_TAG
PRODUCT=(ZelBack helpers lib app.js apiServer.js init.js package.json)

git -C "$CLONE" rev-parse --verify --quiet "$REF^{commit}" >/dev/null || { echo "build-release-image: $REF is not in this clone" >&2; exit 2; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/flux-release-image.XXXXXX")
cleanup() {
  git -C "$CLONE" worktree remove --force "$WORK/tree" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

git -C "$CLONE" worktree add --quiet --detach "$WORK/tree" HEAD
cd "$WORK/tree"

for p in "${PRODUCT[@]}"; do
  rm -rf "$p"
  git archive "$REF" -- "$p" | tar -x
done

"$CLONE/test-infra/copy-build-products.sh" "$CLONE" "$WORK/tree"

# The per-node configs a node of the ref's code reads, from the ref's production config.
mkdir -p config
cp test-infra/fixtures/userconfig-template.js config/userconfig.js
node test-infra/config/generate-configs.js
rm -f config/userconfig.js

./test-infra/build-images.sh fluxos-01
echo "FROM flux-e2e-fluxos-01:$FLUX_E2E_TAG" | docker build --quiet --label "flux.e2e.release=$REF" -t "flux-e2e-fluxos-01:$FLUX_E2E_TAG" - >/dev/null
echo "build-release-image: flux-e2e-fluxos-01:$FLUX_E2E_TAG holds $REF ($(git -C "$CLONE" rev-parse --short "$REF^{commit}"))"
