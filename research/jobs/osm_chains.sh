#!/usr/bin/env bash
# Research job: today's OpenStreetMap stores for every chain in brands.json (raw Overpass answers).
set -uo pipefail
out="$1"
node tools/store-locations/build.mjs --dry-run --save-raw "$out/raw.json" --budget-min 220 --report "$out/report.md"
gzip -9 "$out/raw.json" || true
ls -la "$out"
