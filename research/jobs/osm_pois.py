#!/usr/bin/env python3
"""
Research job: every named shop, restaurant, gym, attraction... in the U.S. and its territories
that has a website in OpenStreetMap, from Geofabrik's free daily extracts (one download per region,
the way Geofabrik asks bulk users to work, instead of thousands of Overpass queries).
Chains (places with a brand:wikidata tag) are left out: their deals come from the deal sheet.

Writes pois.jsonl.gz: {"id", "lat", "lon", "cat", "t": {selected tags}} per place.
Usage: osm_pois.py OUTDIR      (needs osmium-tool; ~15 GB of scratch space under /mnt)
"""
import gzip, json, os, shutil, subprocess, sys, time, urllib.request

from shapely.geometry import shape

OUT = sys.argv[1]
WORK = '/mnt/osm'  # the runner's big scratch disk
try:
    subprocess.run(['sudo', 'mkdir', '-p', WORK], check=True)
    subprocess.run(['sudo', 'chown', str(os.getuid()), WORK], check=True)
except Exception as e:
    print('no /mnt scratch disk:', e)
    WORK = os.path.join(os.environ.get('RUNNER_TEMP', '/tmp'), 'osm')
    os.makedirs(WORK, exist_ok=True)
print('scratch', WORK, shutil.disk_usage(WORK).free >> 30, 'GB free')
UA = {'User-Agent': 'ArmedForcesPerks-research/1.0 (+https://armedforcesperks.com)'}
WANT = ['us', 'puerto-rico', 'us-virgin-islands', 'american-oceania']
CATS = ['shop', 'amenity', 'leisure', 'tourism', 'craft', 'healthcare']
WEB = ['website', 'contact:website', 'url']
KEEP = set(CATS + WEB + ['name', 'brand', 'operator', 'branch', 'cuisine', 'sport', 'description', 'note', 'opening_hours',
                         'phone', 'contact:phone', 'email', 'contact:facebook', 'check_date', 'military', 'access',
                         'addr:housenumber', 'addr:street', 'addr:unit', 'addr:city', 'addr:state', 'addr:postcode', 'addr:country'])


def run(cmd):
    print('$', ' '.join(cmd), flush=True)
    subprocess.run(cmd, check=True)


def get(url, timeout=900):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout)


if not shutil.which('osmium'):
    run(['sudo', 'apt-get', 'update', '-qq'])
    run(['sudo', 'apt-get', 'install', '-y', '-qq', 'osmium-tool'])

index = json.load(get('https://download.geofabrik.de/index-v1-nogeom.json'))
regions = {f['properties']['id']: f['properties'] for f in index['features']}
print('U.S. regions offered:', sorted(k for k, v in regions.items() if v.get('parent') in ('us', 'north-america', 'australia-oceania') and ('us' in k or 'america' in k or k in WANT)))
t0 = time.time()
lines = []
for rid in WANT:
    if rid not in regions:
        print('missing region', rid)
        continue
    url = regions[rid]['urls']['pbf']
    pbf = os.path.join(WORK, rid + '.osm.pbf')
    with get(url) as r, open(pbf, 'wb') as f:
        shutil.copyfileobj(r, f, 1 << 22)
    print(rid, os.path.getsize(pbf) >> 20, 'MB', int(time.time() - t0), 's', flush=True)
    step1 = os.path.join(WORK, rid + '.web.pbf')
    step2 = os.path.join(WORK, rid + '.poi.pbf')
    run(['osmium', 'tags-filter', '--overwrite', pbf] + [f'nwr/{k}' for k in WEB] + ['-o', step1])
    os.remove(pbf)
    run(['osmium', 'tags-filter', '--overwrite', step1] + [f'nwr/{k}' for k in CATS] + ['-o', step2])
    seq = os.path.join(WORK, rid + '.geojsonseq')
    run(['osmium', 'export', '--overwrite', step2, '-f', 'geojsonseq', '--geometry-types=point,polygon',
         '-a', 'type,id', '-x', 'print_record_separator=false', '-o', seq])
    n = 0
    with open(seq) as f:
        for line in f:
            try:
                ft = json.loads(line)
            except ValueError:
                continue
            p = ft.get('properties') or {}
            if not p.get('name') or p.get('brand:wikidata') or not any(p.get(k) for k in WEB):
                continue
            cat = next((f'{k}={p[k]}' for k in CATS if p.get(k)), None)
            if not cat:
                continue
            try:
                g = shape(ft['geometry'])
                pt = g if g.geom_type == 'Point' else g.representative_point()
            except Exception:
                continue
            oid = f"{(p.get('@type') or '?')[0]}{p.get('@id')}"
            lines.append(json.dumps({'id': oid, 'lat': round(pt.y, 6), 'lon': round(pt.x, 6), 'cat': cat,
                                     't': {k: str(v)[:300] for k, v in p.items() if k in KEEP}}, ensure_ascii=False))
            n += 1
    print(rid, 'places with a website:', n, int(time.time() - t0), 's', flush=True)
    for x in (step1, step2, seq):
        os.remove(x)

seen = set()
with gzip.open(os.path.join(OUT, 'pois.jsonl.gz'), 'wt') as f:
    for line in lines:
        oid = line[8:line.index('"', 8)]
        if oid in seen:
            continue
        seen.add(oid)
        f.write(line + '\n')
print('total places:', len(seen), int(time.time() - t0), 's')
