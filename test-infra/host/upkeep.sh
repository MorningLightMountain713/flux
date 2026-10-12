#!/bin/sh
# flux-e2e-upkeep: removes what finished harness runs leave in Docker. Installed by setup.sh,
# run daily from cron; safe while runs are in progress.
#   - untagged images: nothing can run them by name, and one a container uses is kept. Their
#     removal is also what lets the mongo snapshot cache drop the snapshots built for them.
#   - build cache unused for 7 days.
#   - anonymous volumes no container uses.
# Tagged images are kept: a lineage's tag may be days old and still the one its next run uses.
set -eu
docker image prune -f | tail -n 1
docker builder prune -f --filter until=168h | tail -n 1
docker volume prune -f | tail -n 1
