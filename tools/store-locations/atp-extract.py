#!/usr/bin/env python3
"""
Pulls our chains' stores out of All the Places (alltheplaces.xyz), an open-source project that
collects store lists from each chain's own store locator. Used only to CHECK our OpenStreetMap
list (missed stores, misplaced pins); nothing from it is published by this script.

Usage: python3 atp-extract.py OUT.geojson   (downloads the latest All the Places run, ~1-2 GB)
"""
import io, json, os, sys, urllib.request, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
UA = {'User-Agent': 'ArmedForcesPerks-store-audit/1.0 (+https://armedforcesperks.com)'}
COUNTRIES = {'US', 'PR', 'GU', 'VI', 'AS', 'MP'}


def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=600)


def main(out):
    brands = json.load(open(os.path.join(HERE, 'brands.json')))
    brands = brands['brands'] if isinstance(brands, dict) else brands
    by_qid = {b['match']['wikidata']: b['key'] for b in brands if 'wikidata' in b['match']}
    by_name = {b['match']['brand'].lower(): b['key'] for b in brands if 'brand' in b['match']}
    latest = json.load(get('https://data.alltheplaces.xyz/runs/latest.json'))
    print('run:', {k: v for k, v in latest.items() if not isinstance(v, (dict, list))})
    url = latest.get('output_url') or latest.get('output', {}).get('url')
    tmp = os.path.join(os.environ.get('RUNNER_TEMP', '/tmp'), 'atp.zip')
    with get(url) as r, open(tmp, 'wb') as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    print('downloaded', os.path.getsize(tmp) // (1 << 20), 'MB')
    feats, spiders = [], {}
    with zipfile.ZipFile(tmp) as z:
        for name in z.namelist():
            if not name.endswith('.geojson'):
                continue
            try:
                data = json.load(io.TextIOWrapper(z.open(name), encoding='utf-8'))
            except Exception as e:  # a broken spider file shouldn't stop the rest
                print('skip', name, e)
                continue
            for ft in data.get('features') or []:
                p = ft.get('properties') or {}
                key = by_qid.get(p.get('brand:wikidata')) or by_name.get(str(p.get('brand', '')).lower())
                if not key:
                    continue
                country = str(p.get('addr:country') or '').upper()
                if country and country not in COUNTRIES:
                    continue
                g = ft.get('geometry') or {}
                if g.get('type') != 'Point':
                    continue
                keep = {k: p[k] for k in ('name', 'branch', 'addr:street_address', 'addr:full', 'addr:city', 'addr:state',
                                          'addr:postcode', 'addr:country', 'ref', 'website', 'opening_hours') if k in p}
                keep['key'] = key
                keep['spider'] = p.get('@spider')
                feats.append({'type': 'Feature', 'geometry': g, 'properties': keep})
                spiders.setdefault(key, set()).add(p.get('@spider'))
    json.dump({'type': 'FeatureCollection', 'run': latest.get('run_id'), 'features': feats}, open(out, 'w'))
    print(len(feats), 'stores kept')
    for k in sorted(spiders):
        print(k, sorted(s for s in spiders[k] if s))


if __name__ == '__main__':
    main(sys.argv[1])
