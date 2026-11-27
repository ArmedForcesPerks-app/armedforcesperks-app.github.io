#!/usr/bin/env bash
# Research job: the website's own store-list build (tools/store-locations) with this branch's
# chain list, so new chains can be checked before they go into a pull request. Publishes nothing.
set -uo pipefail
out="$1"
python3 tools/store-locations/atp-extract.py atp-stores.geojson > "$out/atp-extract.log" 2>&1 || echo "atp-extract exit $?"
tail -5 "$out/atp-extract.log"
node tools/store-locations/build.mjs --atp atp-stores.geojson --budget-min 240 --report "$out/report.md" || echo "build exit $?"
cp data/locations.json data/locations-status.json "$out/" 2>/dev/null || true
[ -f atp-stores.geojson ] && gzip -c atp-stores.geojson > "$out/atp-stores.geojson.gz"
ls -la "$out"
