"""
Research job: check the website's plain-Python ZIP code area reader (tools/store-locations/zip_areas.py,
copied here) against shapely on the real Census file: every store pin and geocoded point from the
b5 pin check, whose ZIP code areas shapely already found.
Output: zip_check.json with the counts and up to 100 disagreements.
"""
import gzip, json, os, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import zip_areas

out = sys.argv[1]
rows = json.load(gzip.open(os.path.join(HERE, '..', 'pin_rows.json.gz'), 'rt'))
res = {r[0]: r for r in json.load(gzip.open(os.path.join(HERE, '..', 'out', 'b5', 'pin_check', 'pins.json.gz'), 'rt'))}
points, want = [], []
for r in rows:
    x = res.get(r[0])
    if not x: continue
    points.append((r[6], r[7])); want.append(x[6] or '')
    if x[4] is not None:
        points.append((x[4], x[5])); want.append(x[7] or '')
print(len(points), 'points')
tmp = os.path.join(os.environ.get('RUNNER_TEMP', '/tmp'), 'zcta.zip')
t0 = time.time()
ok = zip_areas.download(tmp)
print('download', ok, round(time.time() - t0), 's', os.path.getsize(tmp) >> 20 if ok else 0, 'MB')
t1 = time.time()
got = zip_areas.lookup_file(points, tmp)
print('lookup', round(time.time() - t1), 's')
# Also time the size the real build sees (a couple of thousand points).
t2 = time.time()
zip_areas.lookup_file(points[:4000], tmp)
print('lookup of 4000 points', round(time.time() - t2), 's')
diff = [{'lat': p[0], 'lon': p[1], 'shapely': w, 'plain': g} for p, w, g in zip(points, want, got) if w != g]
summary = {'points': len(points), 'agree': len(points) - len(diff), 'disagree': len(diff), 'examples': diff[:100]}
print({k: v for k, v in summary.items() if k != 'examples'})
json.dump(summary, open(os.path.join(out, 'zip_check.json'), 'w'), indent=1)
