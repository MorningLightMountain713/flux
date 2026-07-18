#!/usr/bin/env bash
# Compile the OTLP receiver fixture to a small static linux/amd64 binary.
# Output: test-infra/otlp-receiver/otlp-receiver (gitignored) — read by
# registry-helper.pushOtlpReceiver. Same pattern as test-app/build.sh.
#
#   bash test-infra/otlp-receiver/build.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

docker run --rm --platform linux/amd64 -v "$here:/src" -w /src alpine:3 \
  sh -c 'apk add --no-cache gcc musl-dev >/dev/null && gcc -static -Os -o otlp-receiver receiver.c && strip otlp-receiver'

echo "built $here/otlp-receiver ($(wc -c < "$here/otlp-receiver") bytes)"
