#!/usr/bin/env python3
"""
Pulls our chains' stores out of All the Places (alltheplaces.xyz), an open-source project that
collects store lists from each chain's own store locator. Used only to CHECK our OpenStreetMap
list (missed stores, misplaced pins); nothing from it is published by this script.

Each store's street address is also looked up with the free U.S. Census Bureau geocoder, so the
build can tell which pin is right when the map and the store locator disagree.

Usage: python3 atp-extract.py OUT.geojson   (downloads the latest All the Places run, ~3 GB)
"""
import csv, io, json, os, sys, time, urllib.request, uuid, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
UA = {'User-Agent': 'ArmedForcesPerks-store-audit/1.0 (+https://armedforcesperks.com)'}
COUNTRIES = {'US', 'PR', 'GU', 'VI', 'AS', 'MP'}


def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=600)


KEEP = ('name', 'branch', 'addr:street_address', 'addr:full', 'addr:city', 'addr:state',
        'addr:postcode', 'addr:country', 'ref', 'website', 'opening_hours')
RUNS = 'https://data.alltheplaces.xyz/runs/'
OLDER_RUNS = 6        # a chain missing from the latest run is looked for in up to this many older runs
OLDER_MAX_DAYS = 75   # ...as long as that run is no older than this
OLDER_BUDGET_MIN = 45  # and stops starting older runs after this long, so the whole step stays well under its time limit


def download(url):
    tmp = os.path.join(os.environ.get('RUNNER_TEMP', '/tmp'), 'atp.zip')
    with get(url) as r, open(tmp, 'wb') as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    print('downloaded', os.path.getsize(tmp) // (1 << 20), 'MB')
    return tmp


def scan(path, by_qid, by_name, named, wanted, run_id, quiet=False):
    """Our chains' US stores in one All the Places run. wanted=None keeps every chain; otherwise only those keys.
    Returns (features, {key: set(spiders)})."""
    feats, spiders = [], {}
    needles = None
    if wanted is not None:  # cheap text check so an older run's ~5,000 files needn't all be parsed
        needles = [q.encode() for q, k in by_qid.items() if k in wanted]
        needles += [n.encode() for n, k in by_name.items() if k in wanted]
    with zipfile.ZipFile(path) as z:
        for name in z.namelist():
            if not name.endswith('.geojson'):
                continue
            try:
                raw = z.read(name)
                if needles is not None and not any(n in low for low in (raw, raw.lower()) for n in needles):
                    continue
                data = json.loads(raw)
            except Exception as e:  # a broken spider file shouldn't stop the rest
                if not quiet:
                    print('skip', name, e)
                continue
            for ft in data.get('features') or []:
                p = ft.get('properties') or {}
                qid = p.get('brand:wikidata')
                key = by_qid.get(qid) if qid else by_name.get(str(p.get('brand', '')).strip().lower())
                if qid and not key and str(p.get('brand', '')).strip().lower() in named:
                    key = by_name[str(p['brand']).strip().lower()]
                if not key or (wanted is not None and key not in wanted):
                    continue
                country = str(p.get('addr:country') or '').upper()
                if country and country not in COUNTRIES:
                    continue
                g = ft.get('geometry') or {}
                if g.get('type') != 'Point':
                    # Some locators give only the address (Lowe's): the Census geocoder places those.
                    if not (p.get('addr:street_address') or p.get('addr:full')):
                        continue
                    g = None
                keep = {k: p[k] for k in KEEP if k in p}
                keep['key'] = key
                keep['spider'] = p.get('@spider')
                if wanted is not None:
                    keep['atp_run'] = run_id  # from an older run: the chain's spider failed in the latest one
                feats.append({'type': 'Feature', 'geometry': g, 'properties': keep})
                spiders.setdefault(key, set()).add(p.get('@spider'))
    return feats, spiders


def older_runs(latest_id):
    """Earlier All the Places runs, newest first: [(run_id, zip url)]."""
    try:
        hist = json.load(get(RUNS + 'history.json'))
    except Exception as e:
        print('could not list older runs:', e)
        return []
    if isinstance(hist, dict):
        hist = hist.get('runs') or list(hist.values())
    out = []
    for r in hist:
        if not isinstance(r, dict) or not r.get('run_id') or r['run_id'] >= latest_id:
            continue
        url = r.get('output_url') or f"https://alltheplaces-data.openaddresses.io/runs/{r['run_id']}/output.zip"
        out.append((r['run_id'], url))
    return sorted(out, reverse=True)


def run_age_days(a, b):
    from datetime import datetime
    f = lambda s: datetime.strptime(s[:10], '%Y-%m-%d')
    return (f(a) - f(b)).days


def expected_counts(brands):
    """How many stores each chain has on the published map now, to spot a locator run that broke part-way."""
    try:
        data = json.load(open(os.path.join(HERE, '..', '..', 'data', 'locations.json')))
        keys = [b['key'] for b in data['brands']]
        out = {}
        for r in data['stores']:
            out[keys[r[0]]] = out.get(keys[r[0]], 0) + 1
        return out
    except Exception as e:
        print('no published list to compare with:', e)
        return {}


def too_few(n, expected):
    return expected >= 20 and n < expected // 4


def main(out):
    brands = json.load(open(os.path.join(HERE, 'brands.json')))
    brands = brands['brands'] if isinstance(brands, dict) else brands
    by_qid = {b['match']['wikidata']: b['key'] for b in brands if 'wikidata' in b['match']}
    # Where All the Places uses a different Wikidata item than OpenStreetMap does.
    by_qid.update({b['locatorWikidata']: b['key'] for b in brands if b.get('locatorWikidata')})
    by_name = {b['match']['brand'].lower(): b['key'] for b in brands if 'brand' in b['match']}
    named = set(by_name)  # chains matched by brand name in OSM too (no Wikidata ID): match by name whatever the ID
    # Some spiders leave out the Wikidata ID: then an exact brand-name match counts too.
    by_name.update({b['name'].lower(): b['key'] for b in brands if b['name'].lower() not in by_name})
    latest = json.load(get(RUNS + 'latest.json'))
    print('run:', {k: v for k, v in latest.items() if not isinstance(v, (dict, list))})
    run_id = latest.get('run_id') or ''
    tmp = download(latest.get('output_url') or latest.get('output', {}).get('url'))
    feats, spiders = scan(tmp, by_qid, by_name, named, None, run_id)
    os.remove(tmp)
    expected = expected_counts(brands)
    count = lambda fs, k: sum(1 for f in fs if f['properties']['key'] == k)
    partial = {k for k in spiders if too_few(count(feats, k), expected.get(k, 0))}
    if partial:
        print('only part of the list in the latest run:', {k: count(feats, k) for k in sorted(partial)})
    missing = ({b['key'] for b in brands} - set(spiders)) | partial
    print('not (fully) in the latest run:', sorted(missing))
    tried, began = 0, time.time()
    for old_id, url in older_runs(run_id):
        if not missing or tried >= OLDER_RUNS or run_age_days(run_id, old_id) > OLDER_MAX_DAYS:
            break
        if time.time() - began > OLDER_BUDGET_MIN * 60:
            print('out of time for older runs')
            break
        tried += 1
        print('looking in older run', old_id, 'for', sorted(missing))
        try:
            tmp = download(url)
            more, found = scan(tmp, by_qid, by_name, named, missing, old_id, quiet=True)
            os.remove(tmp)
        except Exception as e:
            print('older run failed:', e)
            continue
        for k in sorted(found):
            n = count(more, k)
            if too_few(n, expected.get(k, 0)) or n <= count(feats, k):
                print(f'  {k}: only {n} stores in {old_id}, still looking')
                continue
            print(f'  {k}: {n} stores from {old_id}')
            feats = [f for f in feats if f['properties']['key'] != k] + [f for f in more if f['properties']['key'] == k]
            spiders[k] = found[k]
            missing.discard(k)
    print('no locator data found for:', sorted(missing))
    geocode(feats)
    placed = []
    for f in feats:
        if f['geometry'] is None:
            if 'census' not in f['properties']:
                continue
            lat, lon = f['properties']['census']
            f['geometry'] = {'type': 'Point', 'coordinates': [lon, lat]}
            f['properties']['from_address'] = True  # no pin of its own: never used to move an OSM pin
        placed.append(f)
    print(len(feats) - len(placed), 'address-only stores the geocoder could not place')
    feats = placed
    json.dump({'type': 'FeatureCollection', 'run': run_id, 'features': feats}, open(out, 'w'))
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
