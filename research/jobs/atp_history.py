#!/usr/bin/env python3
"""
Research job: our chains' stores in older All the Places runs, so a store that was on a chain's own
list before but is gone now (closed) can be told apart from one the list never had.
Usage: atp_history.py OUTDIR [DAYS,...]   (default: runs about 90, 180, 365 and 540 days before the latest)
"""
import collections, gzip, importlib.util, json, os, sys, time
from datetime import datetime

OUT = sys.argv[1]
DAYS = [int(x) for x in (sys.argv[2] if len(sys.argv) > 2 else '90,180,365,540').split(',')]
HERE = 'tools/store-locations'
spec = importlib.util.spec_from_file_location('atp_extract', os.path.join(HERE, 'atp-extract.py'))
atp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(atp)

brands = json.load(open(os.path.join(HERE, 'brands.json')))
brands = brands['brands'] if isinstance(brands, dict) else brands
by_qid = {b['match']['wikidata']: b['key'] for b in brands if 'wikidata' in b['match']}
by_qid.update({b['locatorWikidata']: b['key'] for b in brands if b.get('locatorWikidata')})
by_name = {b['match']['brand'].lower(): b['key'] for b in brands if 'brand' in b['match']}
named = set(by_name)
by_name.update({b['name'].lower(): b['key'] for b in brands if b['name'].lower() not in by_name})

latest = json.load(atp.get(atp.RUNS + 'latest.json'))
run_id = latest.get('run_id') or ''
runs = atp.older_runs(run_id)
day = lambda s: datetime.strptime(s[:10], '%Y-%m-%d')
picked = []
for want in DAYS:
    best = min(runs, key=lambda r: abs((day(run_id) - day(r[0])).days - want))
    if best not in picked:
        picked.append(best)
print('latest run', run_id, '| older runs picked:', [r[0] for r in picked], flush=True)

for rid, url in picked:
    t = time.time()
    try:
        tmp = atp.download(url)
        feats, spiders = atp.scan(tmp, by_qid, by_name, named, None, rid, quiet=True)
        os.remove(tmp)
    except Exception as e:
        print(rid, 'failed:', e, flush=True)
        continue
    rows = []
    for f in feats:
        p, g = f['properties'], f['geometry']
        lat, lon = (g['coordinates'][1], g['coordinates'][0]) if g else (None, None)
        rows.append([p['key'], lat, lon, p.get('addr:street_address') or p.get('addr:full') or '',
                     p.get('addr:city', ''), p.get('addr:state', ''), p.get('ref', '')])
    json.dump({'run': rid, 'rows': rows, 'spiders': {k: sorted(s for s in v if s) for k, v in spiders.items()}},
              gzip.open(os.path.join(OUT, f'atp_{rid[:10]}.json.gz'), 'wt'))
    print(rid, len(rows), 'stores in', int(time.time() - t), 's', dict(sorted(collections.Counter(r[0] for r in rows).items())), flush=True)
