#!/usr/bin/env bash
# Compile the tls-echo fixture to a static linux/amd64 binary.
# Output: test-infra/tls-echo/tls-echo (gitignored) — read by
# registry-helper.pushTlsEcho. Same pattern as test-app/build.sh and
# otlp-receiver/build.sh, plus a statically linked OpenSSL: the app image is a
# single-layer binary with no libc or shared objects to resolve, so the TLS
# implementation has to come along inside the binary.
#
#   bash test-infra/tls-echo/build.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

docker run --rm --platform linux/amd64 -v "$here:/src" -w /src alpine:3 \
  sh -c 'apk add --no-cache gcc musl-dev openssl-dev openssl-libs-static >/dev/null &&
         gcc -static -Os -o tls-echo tls-echo.c -lssl -lcrypto &&
         strip tls-echo'

echo "built $here/tls-echo ($(wc -c < "$here/tls-echo") bytes)"
