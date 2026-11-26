#!/usr/bin/env python3
"""
Pulls our chains' stores out of All the Places (alltheplaces.xyz), an open-source project that
collects store lists from each chain's own store locator. Used only to CHECK our OpenStreetMap
list (missed stores, misplaced pins); nothing from it is published by this script.

Each store's street address is also looked up with the free U.S. Census Bureau geocoder, so the
build can tell which pin is right when the map and the store locator disagree.

Usage: python3 atp-extract.py OUT.geojson   (downloads the latest All the Places run, ~3 GB)
"""
import csv, io, json, os, sys, urllib.request, uuid, zipfile

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
    geocode(feats)
    json.dump({'type': 'FeatureCollection', 'run': latest.get('run_id'), 'features': feats}, open(out, 'w'))
    print(len(feats), 'stores kept')
    for k in sorted(spiders):
        print(k, sorted(s for s in spiders[k] if s))


CENSUS = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch'
BATCH = 9000  # the Census batch service takes up to 10,000 addresses per file


def geocode(feats):
    """Adds properties.census = [lat, lon] where the Census geocoder matches the street address."""
    rows = []
    for i, ft in enumerate(feats):
        p = ft['properties']
        street = p.get('addr:street_address') or str(p.get('addr:full') or '').split(',')[0]
        if street and p.get('addr:city') and p.get('addr:state'):
            rows.append([str(i), street, p['addr:city'], p['addr:state'], str(p.get('addr:postcode') or '')[:5]])
    found = 0
    for start in range(0, len(rows), BATCH):
        part = rows[start:start + BATCH]
        buf = io.StringIO()
        csv.writer(buf).writerows(part)
        boundary = uuid.uuid4().hex
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="benchmark"\r\n\r\nPublic_AR_Current\r\n'
                f'--{boundary}\r\nContent-Disposition: form-data; name="addressFile"; filename="a.csv"\r\n'
                f'Content-Type: text/csv\r\n\r\n{buf.getvalue()}\r\n--{boundary}--\r\n').encode()
        req = urllib.request.Request(CENSUS, data=body, method='POST',
                                     headers={**UA, 'Content-Type': f'multipart/form-data; boundary={boundary}'})
        try:
            text = urllib.request.urlopen(req, timeout=1200).read().decode('utf-8', 'replace')
        except Exception as e:  # the check still works without it
            print('census geocoder failed for a batch:', e)
            continue
        for r in csv.reader(io.StringIO(text)):
            if len(r) >= 6 and r[2] == 'Match' and ',' in r[5]:
                try:
                    lon, lat = (float(x) for x in r[5].split(','))
                except ValueError:
                    continue
                feats[int(r[0])]['properties']['census'] = [round(lat, 6), round(lon, 6)]
                found += 1
        print(f'census geocoder: {found} of {start + len(part)} addresses matched so far')


if __name__ == '__main__':
    main(sys.argv[1])
