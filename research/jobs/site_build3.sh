#!/usr/bin/env bash
# Research job (rerun of site_build2, which built fine but could not commit its results because the
# build had changed data/): the store-list build as the pull request will run it (new pin rules, ZIP code
# check, local shops' offers rechecked), keeping the OpenStreetMap download so the build can be
# re-run offline. Publishes nothing (only research/out is committed).
set -uo pipefail
out="$1"
node --test tools/store-locations/test.mjs > "$out/tests.txt" 2>&1; echo "tests exit $?" >> "$out/tests.txt"; tail -3 "$out/tests.txt"
python3 tools/store-locations/atp-extract.py atp-stores.geojson > "$out/atp-extract.log" 2>&1 || echo "atp-extract exit $?"
tail -8 "$out/atp-extract.log"
python3 tools/local-shops/recheck.py --force > "$out/recheck.log" 2>&1 || echo "recheck exit $?"
tail -8 "$out/recheck.log"
node tools/store-locations/build.mjs --atp atp-stores.geojson --budget-min 200 --save-raw raw.json --report "$out/report.md" || echo "build exit $?"
cp data/locations.json data/locations-status.json data/local-shops-status.json "$out/" 2>/dev/null || true
[ -f atp-stores.geojson ] && gzip -c atp-stores.geojson > "$out/atp-stores.geojson.gz"
[ -f raw.json ] && gzip -c raw.json > "$out/raw.json.gz"
ls -la "$out"
# Put the site's own files back as they were (only research/out is committed), so the results commit can rebase.
git checkout -- data 2>/dev/null || true
rm -f atp-stores.geojson raw.json
git status --short | grep -v '^?? out/' | head -20
