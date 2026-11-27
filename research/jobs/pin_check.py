"""
Research job: how good is each source of a store's pin? For every store-locator store (All the
Places), geocode its street address again with the U.S. Census Bureau batch geocoder, keeping the
match type (Exact / Non_Exact) and the matched address, and find which ZIP Code Tabulation Area
(Census ZCTA) each point lies in: the locator's own pin and the geocoded one.
Input: research/pin_rows.json.gz rows [i, key, street, city, state, zip, lat, lon, from_address].
Output: pins.json.gz rows [i, match, exact, matched_address, census_lat, census_lon, zcta_of_pin, zcta_of_census].
"""
import csv, gzip, io, json, os, sys, time, urllib.request, uuid, zipfile
from shapely.geometry import shape, Point
from shapely.strtree import STRtree
import shapefile  # pyshp

out = sys.argv[1]
HERE = os.path.dirname(os.path.abspath(__file__))
UA = {'User-Agent': 'ArmedForcesPerks-research/1.0 (+https://armedforcesperks.com)'}
rows = json.load(gzip.open(os.path.join(HERE, '..', 'pin_rows.json.gz'), 'rt', encoding='utf-8'))
print(len(rows), 'stores')

CENSUS = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch'
BATCH = 9000
res = {}
todo = [r for r in rows if r[2] and r[3] and r[4]]
for start in range(0, len(todo), BATCH):
    part = todo[start:start + BATCH]
    buf = io.StringIO()
    csv.writer(buf).writerows([[str(r[0]), r[2], r[3], r[4], r[5]] for r in part])
    boundary = uuid.uuid4().hex
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="benchmark"\r\n\r\nPublic_AR_Current\r\n'
            f'--{boundary}\r\nContent-Disposition: form-data; name="addressFile"; filename="a.csv"\r\n'
            f'Content-Type: text/csv\r\n\r\n{buf.getvalue()}\r\n--{boundary}--\r\n').encode()
    for attempt in range(3):
        try:
            req = urllib.request.Request(CENSUS, data=body, method='POST', headers={**UA, 'Content-Type': f'multipart/form-data; boundary={boundary}'})
            text = urllib.request.urlopen(req, timeout=1500).read().decode('utf-8', 'replace')
            break
        except Exception as e:
            print('batch failed:', e); text = ''; time.sleep(60)
    n = 0
    for r in csv.reader(io.StringIO(text)):
        if len(r) < 3:
            continue
        rec = {'match': r[2]}
        if r[2] == 'Match' and len(r) >= 6 and ',' in r[5]:
            try:
                lon, lat = (float(x) for x in r[5].split(','))
                rec.update(exact=r[3] == 'Exact', addr=r[4], lat=round(lat, 6), lon=round(lon, 6))
                n += 1
            except ValueError:
                pass
        res[int(r[0])] = rec
    print(f'batch {start}: {n} matched of {len(part)}', flush=True)

# ZCTA polygons (Census cartographic boundary file, 2020)
URL = 'https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_zcta520_500k.zip'
tmp = 'zcta.zip'
for attempt in range(3):
    try:
        with urllib.request.urlopen(urllib.request.Request(URL, headers=UA), timeout=600) as r, open(tmp, 'wb') as f:
            while True:
                b = r.read(1 << 20)
                if not b: break
                f.write(b)
        break
    except Exception as e:
        print('zcta download failed:', e); time.sleep(30)
zf = zipfile.ZipFile(tmp)
base = [n[:-4] for n in zf.namelist() if n.endswith('.shp')][0]
sf = shapefile.Reader(shp=io.BytesIO(zf.read(base + '.shp')), dbf=io.BytesIO(zf.read(base + '.dbf')), shx=io.BytesIO(zf.read(base + '.shx')))
fields = [f[0] for f in sf.fields[1:]]
zi = fields.index('ZCTA5CE20')
geoms, codes = [], []
for sr in sf.iterShapeRecords():
    geoms.append(shape(sr.shape.__geo_interface__)); codes.append(sr.record[zi])
tree = STRtree(geoms)
print(len(geoms), 'ZCTAs')
def zcta(lat, lon):
    p = Point(lon, lat)
    for i in tree.query(p):
        if geoms[i].contains(p):
            return codes[i]
    return ''

outrows = []
for r in rows:
    c = res.get(r[0], {})
    zp = zcta(r[6], r[7])
    zc = zcta(c['lat'], c['lon']) if 'lat' in c else ''
    outrows.append([r[0], c.get('match', ''), c.get('exact'), c.get('addr', ''), c.get('lat'), c.get('lon'), zp, zc])
with gzip.open(os.path.join(out, 'pins.json.gz'), 'wt', encoding='utf-8') as fh:
    json.dump(outrows, fh)
print('done', len(outrows))
