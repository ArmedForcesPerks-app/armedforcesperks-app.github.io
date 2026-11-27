#!/usr/bin/env python3
"""
Research job: every U.S. military installation from free public sources.
  - DoD MIRTA (Military Installations, Ranges and Training Areas), from the DISDI download page
  - Census TIGER/Line "Military Installation" layer (public domain)
  - Wikidata (cross-check; coordinates and names)
Writes the raw downloads plus tiger_mil.geojson / mirta_*.geojson (WGS84) and wikidata_*.json.
Usage: installations.py OUTDIR
"""
import html, io, json, os, re, sys, urllib.parse, urllib.request, zipfile

import shapefile  # pyshp

OUT = sys.argv[1]
UA = {'User-Agent': 'ArmedForcesPerks-research/1.0 (+https://armedforcesperks.com)'}


def get(url, timeout=600):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read()


def shp_to_geojson(zbytes, out_name):
    """Every shapefile inside a zip -> GeoJSON (assumes the layer is in lon/lat, as TIGER and MIRTA are)."""
    z = zipfile.ZipFile(io.BytesIO(zbytes))
    written = []
    for n in z.namelist():
        if not n.lower().endswith('.shp'):
            continue
        base = n[:-4]
        try:
            prj = z.read(base + '.prj').decode('utf-8', 'replace') if base + '.prj' in z.namelist() else ''
            r = shapefile.Reader(shp=io.BytesIO(z.read(n)), dbf=io.BytesIO(z.read(base + '.dbf')),
                                 shx=io.BytesIO(z.read(base + '.shx')) if base + '.shx' in z.namelist() else None)
            fields = [f[0] for f in r.fields[1:]]
            feats = []
            for sr in r.iterShapeRecords():
                props = {k: (v.isoformat() if hasattr(v, 'isoformat') else v) for k, v in zip(fields, sr.record)}
                feats.append({'type': 'Feature', 'properties': props, 'geometry': sr.shape.__geo_interface__})
            name = f"{out_name}_{os.path.basename(base)}.geojson"
            json.dump({'type': 'FeatureCollection', 'prj': prj[:300], 'features': feats}, open(os.path.join(OUT, name), 'w'))
            written.append((name, len(feats), fields))
        except Exception as e:
            print('could not read', n, e)
    return written


# 1. Census TIGER/Line military installations
for year in (2025, 2024):
    url = f'https://www2.census.gov/geo/tiger/TIGER{year}/MIL/tl_{year}_us_mil.zip'
    try:
        data = get(url)
        open(os.path.join(OUT, f'tl_{year}_us_mil.zip'), 'wb').write(data)
        print('TIGER', year, len(data) >> 10, 'KB', shp_to_geojson(data, f'tiger{year}'))
        break
    except Exception as e:
        print('TIGER', year, 'failed:', e)

# 2. DoD MIRTA, from the DISDI page's own download links
page_urls = ['https://www.acq.osd.mil/eie/imr/rpid/disdi/index.html',
             'https://www.acq.osd.mil/eie/imr/rpid/disdi/Downloads.html']
links = set()
for page in page_urls:
    try:
        text = get(page, 120).decode('utf-8', 'replace')
        open(os.path.join(OUT, 'disdi_' + os.path.basename(page)), 'w').write(text)
        for href in re.findall(r'href=["\']([^"\']+)["\']', text, re.I):
            links.add(urllib.parse.urljoin(page, html.unescape(href)))
    except Exception as e:
        print('page failed', page, e)
json.dump(sorted(links), open(os.path.join(OUT, 'disdi_links.json'), 'w'), indent=1)
for link in sorted(links):
    low = link.lower()
    if low.endswith(('.zip', '.kmz', '.geojson', '.json', '.csv', '.xlsx')) and any(w in low for w in ('mirta', 'install', 'range', 'site')):
        try:
            data = get(link)
            fn = re.sub(r'[^A-Za-z0-9._-]', '_', os.path.basename(urllib.parse.urlparse(link).path))
            open(os.path.join(OUT, fn), 'wb').write(data)
            print('MIRTA download', link, len(data) >> 10, 'KB')
            if low.endswith('.zip'):
                print('  ', shp_to_geojson(data, 'mirta_' + fn[:-4]))
        except Exception as e:
            print('download failed', link, e)

# 3. Wikidata cross-check
CLASSES = {'military_base': 'Q245016', 'air_base': 'Q695850', 'military_facility': 'Q18691599', 'naval_base': 'Q1324633',
           'army_post': 'Q1785071', 'coast_guard_station': 'Q2981880'}
for name, qid in CLASSES.items():
    q = f'''SELECT DISTINCT ?item ?itemLabel ?coord ?dissolved ?opLabel ?typeLabel WHERE {{
  ?item wdt:P31/wdt:P279* wd:{qid} ; wdt:P625 ?coord .
  ?item wdt:P17 wd:Q30 .
  OPTIONAL {{ ?item wdt:P576 ?dissolved }}
  OPTIONAL {{ ?item wdt:P137 ?op }}
  OPTIONAL {{ ?item wdt:P31 ?type }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}}'''
    try:
        url = 'https://query.wikidata.org/sparql?format=json&query=' + urllib.parse.quote(q)
        data = json.loads(get(url, 300))
        rows = data['results']['bindings']
        json.dump(rows, open(os.path.join(OUT, f'wikidata_{name}.json'), 'w'))
        print('Wikidata', name, len(rows))
    except Exception as e:
        print('Wikidata', name, 'failed:', e)
