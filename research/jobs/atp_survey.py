#!/usr/bin/env python3
"""
All the Places survey (research only). Downloads the latest All the Places run (each chain's own
store locator, CC0) and writes:
  spiders_us.json         every spider with U.S./territory stores: brand, Wikidata ID, store counts by state
  territory.jsonl.gz      every store (any chain) in Hawaii, Puerto Rico, Guam, the Marianas, American Samoa, USVI
  candidates.jsonl.gz     every U.S. store of a business in data/deals.json or tools/store-locations/brands.json
Usage: atp_survey.py OUTDIR
"""
import collections, gzip, json, os, re, sys, time, urllib.request, zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from geo import state_of  # noqa: E402

OUT = sys.argv[1]
UA = {'User-Agent': 'ArmedForcesPerks-research/1.0 (+https://armedforcesperks.com)'}
US_CODES = {'US', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM', 'USA'}
ISLANDS = {'HI', 'PR', 'GU', 'MP', 'AS', 'VI'}
STATE_NAMES = {
    'alabama': 'AL', 'alaska': 'AK', 'american samoa': 'AS', 'arizona': 'AZ', 'arkansas': 'AR', 'california': 'CA',
    'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE', 'district of columbia': 'DC', 'florida': 'FL', 'georgia': 'GA',
    'guam': 'GU', 'hawaii': 'HI', 'idaho': 'ID', 'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
    'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD', 'massachusetts': 'MA', 'michigan': 'MI',
    'minnesota': 'MN', 'mississippi': 'MS', 'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
    'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC',
    'north dakota': 'ND', 'northern mariana islands': 'MP', 'ohio': 'OH', 'oklahoma': 'OK', 'oregon': 'OR',
    'pennsylvania': 'PA', 'puerto rico': 'PR', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
    'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT', 'vermont': 'VT', 'virginia': 'VA', 'virgin islands': 'VI',
    'u.s. virgin islands': 'VI', 'united states virgin islands': 'VI', 'washington': 'WA', 'west virginia': 'WV',
    'wisconsin': 'WI', 'wyoming': 'WY', 'washington dc': 'DC', 'd.c.': 'DC',
}
VALID = set(STATE_NAMES.values())
CAT_KEYS = ('shop', 'amenity', 'leisure', 'tourism', 'office', 'craft', 'healthcare')
# Deal categories that are never on the map (hotels, rentals, flights, phone plans).
SKIP_CATS = {'Travel', 'Phone and Internet'}
SKIP_NAMES = {'audi', 'bmw', 'ford', 'generalmotors', 'honda', 'hyundai', 'lexus', 'nissan', 'subaru', 'toyota',
              'volkswagen', 'volvo', 'tesla', 'harleydavidson', 'stellantisjeep', 'apple', 'samsung', 'microsoft'}


def bkey(n):
    n = str(n or '').lower().replace('&', 'and')
    n = re.sub(r'^the\s+', '', n)
    return re.sub(r'[^a-z0-9]', '', n)


def name_keys(name):
    keys = {bkey(name), bkey(re.sub(r'\(.*?\)', '', name))}
    m = re.search(r'\((.*?)\)', name)
    if m:
        for part in re.split(r',|\band\b', m.group(1)):
            part = part.replace('more', '').strip()
            if len(bkey(part)) >= 5:
                keys.add(bkey(part))
    if name == 'Office Depot OfficeMax':
        keys |= {'officedepot', 'officemax'}
    return {k for k in keys if len(k) >= 3}


def state_code(p, lat, lon):
    s = str(p.get('addr:state') or '').strip()
    if re.fullmatch(r'[A-Za-z]{2}', s) and s.upper() in VALID:
        return s.upper()
    if s.lower() in STATE_NAMES:
        return STATE_NAMES[s.lower()]
    if lat is not None:
        return state_of(lat, lon)
    return ''


def in_us_box(lat, lon):
    if lat is None:
        return False
    if -15 < lat < 72 and -180 < lon < -64:
        return True
    return 13 < lat < 21 and 144 < lon < 146.5  # Guam and the Northern Marianas


def get(url, timeout=900):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout)


def main():
    deals = json.load(open('data/deals.json'))['deals']
    brands = json.load(open('tools/store-locations/brands.json'))['brands']
    wanted = {}  # name key -> deal/brand name
    for d in deals:
        if d.get('category') in SKIP_CATS:
            continue
        for k in name_keys(d['name']):
            if k not in SKIP_NAMES:
                wanted.setdefault(k, d['name'])
    for b in brands:
        for n in [b['name'], *(b.get('dealNames') or []), b['match'].get('brand') or '']:
            if n:
                wanted.setdefault(bkey(n), b['name'])
    qids = {b['match']['wikidata'] for b in brands if 'wikidata' in b['match']} | {b['locatorWikidata'] for b in brands if b.get('locatorWikidata')}
    print('matching', len(wanted), 'name keys and', len(qids), 'Wikidata IDs')
    by_prefix = collections.defaultdict(list)  # first 3 letters -> longer name keys, for "starts with" matches
    for k in wanted:
        if len(k) >= 5:
            by_prefix[k[:3]].append(k)

    def starts(key):
        return any(key.startswith(k) for k in by_prefix.get(key[:3], ()))

    t0 = time.time()
    if os.environ.get('ATP_ZIP'):  # local test
        latest, tmp = {'run_id': 'test'}, os.environ['ATP_ZIP']
    else:
        latest = json.load(get('https://data.alltheplaces.xyz/runs/latest.json'))
        print('run', latest.get('run_id'), latest.get('end_time'))
        tmp = os.path.join(os.environ.get('RUNNER_TEMP', '/tmp'), 'atp.zip')
        with get(latest['output_url']) as r, open(tmp, 'wb') as f:
            while chunk := r.read(1 << 22):
                f.write(chunk)
        print('downloaded', os.path.getsize(tmp) >> 20, 'MB in', int(time.time() - t0), 's')

    spiders = {}
    terr = gzip.open(os.path.join(OUT, 'territory.jsonl.gz'), 'wt')
    cand = gzip.open(os.path.join(OUT, 'candidates.jsonl.gz'), 'wt')
    n_terr = n_cand = 0
    with zipfile.ZipFile(tmp) as z:
        names = [n for n in z.namelist() if n.endswith('.geojson')]
        for i, name in enumerate(names):
            if i % 500 == 0:
                print(i, 'of', len(names), 'files', int(time.time() - t0), 's', flush=True)
            try:
                raw = z.read(name)
                if b'"US"' not in raw and b'"PR"' not in raw and b'"GU"' not in raw and b'"VI"' not in raw and b'United States' not in raw:
                    # No country codes at all: still check coordinates below (some spiders leave addr:country out).
                    if b'addr:country' in raw:
                        continue
                data = json.loads(raw)
            except Exception as e:
                print('skip', name, str(e)[:80])
                continue
            spider = name.rsplit('/', 1)[-1][:-8]
            info = None
            for ft in data.get('features') or []:
                p = ft.get('properties') or {}
                g = ft.get('geometry') or {}
                lat = lon = None
                if g.get('type') == 'Point' and isinstance(g.get('coordinates'), list) and len(g['coordinates']) >= 2:
                    lon, lat = g['coordinates'][0], g['coordinates'][1]
                    if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
                        lat = lon = None
                country = str(p.get('addr:country') or '').upper()
                if country:
                    if country not in US_CODES:
                        continue
                elif not in_us_box(lat, lon):
                    continue
                st = state_code(p, lat, lon)
                if not st and country in ('PR', 'GU', 'VI', 'AS', 'MP'):
                    st = country
                if not st:
                    continue
                if info is None:
                    info = spiders.setdefault(spider, {'n': 0, 'states': collections.Counter(), 'brand': collections.Counter(),
                                                       'wikidata': collections.Counter(), 'name': collections.Counter(),
                                                       'cat': collections.Counter(), 'website': ''})
                info['n'] += 1
                info['states'][st] += 1
                info['brand'][str(p.get('brand') or '')] += 1
                info['wikidata'][str(p.get('brand:wikidata') or '')] += 1
                info['name'][str(p.get('name') or '')] += 1
                cat = next((f'{k}={p[k]}' for k in CAT_KEYS if p.get(k)), '')
                info['cat'][cat] += 1
                if not info['website'] and p.get('website'):
                    info['website'] = str(p['website'])[:200]
                rec = None
                bk, nk = bkey(p.get('brand')), bkey(p.get('name'))
                is_cand = p.get('brand:wikidata') in qids or bk in wanted or nk in wanted or starts(bk) or starts(nk)
                if st in ISLANDS or is_cand:
                    rec = {'s': spider, 'lat': lat, 'lon': lon, 'st': st, 'n': p.get('name'), 'b': p.get('brand'),
                           'q': p.get('brand:wikidata'), 'br': p.get('branch'),
                           'a': p.get('addr:street_address') or p.get('addr:full'), 'c': p.get('addr:city'),
                           'z': p.get('addr:postcode'), 'w': p.get('website'), 'r': p.get('ref'), 'cat': cat,
                           'li': p.get('located_in'), 'oh': p.get('opening_hours')}
                if st in ISLANDS:
                    terr.write(json.dumps(rec) + '\n')
                    n_terr += 1
                if is_cand:
                    cand.write(json.dumps(rec) + '\n')
                    n_cand += 1
    terr.close()
    cand.close()
    if not os.environ.get('ATP_ZIP'):
        os.remove(tmp)
    summary = {}
    for s, info in sorted(spiders.items()):
        summary[s] = {'n': info['n'], 'brand': info['brand'].most_common(3), 'wikidata': info['wikidata'].most_common(2),
                      'name': info['name'].most_common(3), 'cat': info['cat'].most_common(2), 'website': info['website'],
                      'states': dict(sorted(info['states'].items()))}
    json.dump({'run': latest.get('run_id'), 'spiders': summary}, open(os.path.join(OUT, 'spiders_us.json'), 'w'))
    print('spiders with U.S. stores:', len(summary), '| island stores:', n_terr, '| candidate stores:', n_cand)


if __name__ == '__main__':
    main()
