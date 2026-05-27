#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT="$SCRIPT_DIR/all-specs.json"

echo "Downloading globalappsspecifications..."
curl -sL 'https://api.runonflux.io/apps/globalappsspecifications' \
  | node -e "
    const chunks = [];
    process.stdin.on('data', c => chunks.push(c));
    process.stdin.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const specs = body.data || body;
      process.stdout.write(JSON.stringify(specs, null, 2));
    });
  " > "$OUTPUT"

COUNT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$OUTPUT','utf8')).length)")
echo "Wrote $COUNT specs to $OUTPUT"
