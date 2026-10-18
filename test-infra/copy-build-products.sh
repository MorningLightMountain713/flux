#!/bin/bash
# Copies what the harness built and git ignores under test-infra - vendored
# libraries, pinned daemons, fixture binaries - from a clone into another tree of
# the same repo, so images built there carry the same bytes.
#
#   test-infra/copy-build-products.sh <clone> <tree>
#
# node_modules and the runner's own products are left out: neither is in an
# image's build context.
set -euo pipefail

CLONE=${1:?usage: $0 <clone> <tree>}
TREE=${2:?usage: $0 <clone> <tree>}

git -C "$CLONE" ls-files --others --ignored --exclude-standard -- test-infra \
  | grep -v -e '/node_modules/' -e '^test-infra/runner/' \
  | while read -r f; do mkdir -p "$TREE/$(dirname "$f")"; cp -p "$CLONE/$f" "$TREE/$f"; done
