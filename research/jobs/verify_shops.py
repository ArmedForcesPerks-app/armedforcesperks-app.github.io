#!/usr/bin/env python3
"""
Research job: checks draft local-shop entries before any of them goes on the map.
 1. Reads each offer page exactly the way the monthly recheck does (tools/local-shops/recheck.py:
    robots.txt, one request at a time per website, a pause) and says whether the offer sentence is
    on it, with the text around it so the terms can be read by hand.
 2. Asks the Census Bureau which state, county and city or town each pin is in.
 3. Geocodes each OpenStreetMap street address with the Census batch geocoder and finds the ZIP
    code area of the pin and of the address, so a pin far from its own address can be looked at.
Input: research/LIST, a JSON list of {osm, source, quote, lat, lon, street, city, state, zip}.
Output: verify.json.gz, {osm: {...}}.
Usage: verify_shops.py OUTDIR LIST
"""
import concurrent.futures as cf, csv, gzip, io, json, math, os, sys, time, urllib.parse, urllib.request, uuid

OUT, LIST = sys.argv[1], sys.argv[2]
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
sys.path.insert(0, os.path.join(ROOT, 'tools', 'local-shops'))
sys.path.insert(0, os.path.join(ROOT, 'tools', 'store-locations'))
import recheck  # noqa: E402
import zip_areas  # noqa: E402

UA = {'User-Agent': 'ArmedForcesPerks-research/1.0 (+https://armedforcesperks.com)'}
items = json.load(open(os.path.join(HERE, '..', LIST), encoding='utf-8'))
print(len(items), 'draft shops', flush=True)
res = {it['osm']: {} for it in items}

# 1. offer pages
urls = sorted({it['source'] for it in items})
t0 = time.time()
with cf.ThreadPoolExecutor(16) as ex:
    texts = dict(zip(urls, ex.map(recheck.page_text, urls)))
print(f'{len(urls)} pages read in {time.time() - t0:.0f} s; {sum(t is None for t in texts.values())} unreadable', flush=True)
for it in items:
    text = texts.get(it['source'])
    q = recheck.norm(it['quote'])
    r = res[it['osm']]
    if text is None:
        r['page'] = 'unreadable'
    elif q and q in text:
        i = text.find(q)
        r['page'] = 'ok'
        r['around'] = text[max(0, i - 500):i + len(q) + 500]
    else:
        r['page'] = 'sentence not found'
        # the nearest military words on the page, to see what it says now
        for w in ('military', 'veteran', 'active duty'):
            i = text.find(w)
            if i >= 0:
                r['around'] = text[max(0, i - 400):i + 400]
                break


# 2. where each pin is (state, county, city or town)
def where(it):
    q = urllib.parse.urlencode({'x': it['lon'], 'y': it['lat'], 'benchmark': 'Public_AR_Current', 'vintage': 'Current_Current',
                                'layers': 'States,Counties,Incorporated Places,Census Designated Places', 'format': 'json'})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request('https://geocoding.geo.census.gov/geocoder/geographies/coordinates?' + q, headers=UA), timeout=60) as r:
                g = json.load(r)['result']['geographies']
            pick = lambda k, f='NAME': [x.get(f) for x in g.get(k) or []]
            return {'state': pick('States', 'STUSAB'), 'county': pick('Counties'), 'place': pick('Incorporated Places'), 'cdp': pick('Census Designated Places')}
        except Exception as e:
            err = f'{type(e).__name__}: {str(e)[:100]}'
            time.sleep(5 * (attempt + 1))
    return {'err': err}


t0 = time.time()
with cf.ThreadPoolExecutor(4) as ex:
    for it, w in zip(items, ex.map(where, items)):
        res[it['osm']]['census_where'] = w
print(f'pins placed in states and towns in {time.time() - t0:.0f} s', flush=True)

# 3. street addresses
todo = [it for it in items if it.get('street') and it.get('city') and it.get('state')]
ids = {str(n): it['osm'] for n, it in enumerate(todo)}
buf = io.StringIO()
csv.writer(buf).writerows([[str(n), it['street'], it['city'], it['state'], it.get('zip') or ''] for n, it in enumerate(todo)])
boundary = uuid.uuid4().hex
body = (f'--{boundary}\r\nContent-Disposition: form-data; name="benchmark"\r\n\r\nPublic_AR_Current\r\n'
        f'--{boundary}\r\nContent-Disposition: form-data; name="addressFile"; filename="a.csv"\r\n'
        f'Content-Type: text/csv\r\n\r\n{buf.getvalue()}\r\n--{boundary}--\r\n').encode()
text = ''
for attempt in range(3):
    try:
        req = urllib.request.Request('https://geocoding.geo.census.gov/geocoder/locations/addressbatch', data=body, method='POST',
                                     headers={**UA, 'Content-Type': f'multipart/form-data; boundary={boundary}'})
        text = urllib.request.urlopen(req, timeout=1500).read().decode('utf-8', 'replace')
        break
    except Exception as e:
        print('geocoder batch failed:', e, flush=True)
        time.sleep(60)


def meters(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371000 * math.asin(min(1, math.sqrt(h)))


by_osm = {it['osm']: it for it in items}
matched = 0
for row in csv.reader(io.StringIO(text)):
    if len(row) < 3 or row[0] not in ids:
        continue
    r = res[ids[row[0]]]
    r['census_match'] = row[2]
    if row[2] == 'Match' and len(row) >= 6 and ',' in row[5]:
        try:
            lon, lat = (float(x) for x in row[5].split(','))
        except ValueError:
            continue
        it = by_osm[ids[row[0]]]
        r.update(census_exact=row[3] == 'Exact', census_addr=row[4], census=[round(lat, 6), round(lon, 6)],
                 meters=round(meters((it['lat'], it['lon']), (lat, lon))))
        matched += 1
print(f'{len(todo)} street addresses, {matched} found by the geocoder', flush=True)

# ZIP code areas of the pins (and of the geocoded addresses)
zpath = os.path.join(OUT, 'zcta.zip')
if zip_areas.download(zpath):
    pts = [(it['lat'], it['lon']) for it in items]
    extra = [(osm, r['census']) for osm, r in res.items() if r.get('census')]
    got = zip_areas.lookup_file(pts + [c for _, c in extra], zpath)
    for it, z in zip(items, got[:len(items)]):
        res[it['osm']]['pin_zip_area'] = z
    for (osm, _), z in zip(extra, got[len(items):]):
        res[osm]['census_zip_area'] = z
    os.remove(zpath)
with gzip.open(os.path.join(OUT, 'verify.json.gz'), 'wt', encoding='utf-8') as f:
    json.dump(res, f, ensure_ascii=False)
c = {}
for r in res.values():
    c[r.get('page')] = c.get(r.get('page'), 0) + 1
print('offer pages:', c)
