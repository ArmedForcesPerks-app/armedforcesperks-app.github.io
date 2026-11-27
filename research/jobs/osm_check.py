#!/usr/bin/env python3
"""
Research job: looks up OpenStreetMap entries by ID (current tags, version, last edit and edit
history from the OSM API), searches the map near each for places with the same name (a business
that moved), and reads pages with the monthly recheck's polite reader, keeping the text around
address and location words.
Input: research/LIST, a JSON object {"ids": ["w123", ...], "near": [{"name": "...", "lat": .., "lon": .., "km": ..}],
"pages": ["https://...", ...]}.
Output: osm_check.json.
Usage: osm_check.py OUTDIR LIST
"""
import json, os, re, sys, time, urllib.parse, urllib.request

OUT, LIST = sys.argv[1], sys.argv[2]
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
sys.path.insert(0, os.path.join(ROOT, 'tools', 'local-shops'))
import recheck  # noqa: E402

UA = {'User-Agent': 'ArmedForcesPerks-research/1.0 (+https://armedforcesperks.com)'}
spec = json.load(open(os.path.join(HERE, '..', LIST), encoding='utf-8'))
res = {'ids': {}, 'near': [], 'pages': {}}
TYPES = {'n': 'node', 'w': 'way', 'r': 'relation'}


def fetch(url, data=None, tries=4):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers=UA)
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read().decode('utf-8', 'replace')
        except Exception as e:
            err = f'{type(e).__name__}: {e}'
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(err)


for oid in spec.get('ids', []):
    t, n = TYPES[oid[0]], oid[1:]
    r = {}
    try:
        cur = json.loads(fetch(f'https://api.openstreetmap.org/api/0.6/{t}/{n}.json'))['elements'][0]
        r['current'] = {k: cur.get(k) for k in ('version', 'timestamp', 'user', 'changeset', 'visible', 'tags')}
    except Exception as e:
        r['current_error'] = str(e)
    try:
        hist = json.loads(fetch(f'https://api.openstreetmap.org/api/0.6/{t}/{n}/history.json'))['elements']
        r['history'] = [{k: h.get(k) for k in ('version', 'timestamp', 'user', 'changeset', 'visible', 'tags')} for h in hist]
        for h in hist[-3:]:
            try:
                cs = fetch(f"https://api.openstreetmap.org/api/0.6/changeset/{h['changeset']}.json")
                tags = json.loads(cs)['elements'][0].get('tags', {})
                h_out = next(x for x in r['history'] if x['version'] == h['version'])
                h_out['changeset_tags'] = {k: v for k, v in tags.items() if k in ('comment', 'source', 'created_by', 'imagery_used')}
            except Exception as e:
                pass
    except Exception as e:
        r['history_error'] = str(e)
    res['ids'][oid] = r
    print(oid, json.dumps(r.get('current', r), ensure_ascii=False)[:600], flush=True)
    time.sleep(1)

for q in spec.get('near', []):
    words = [w for w in re.findall(r'[A-Za-z]{4,}', q['name'])][:2]
    rx = '.*'.join(re.escape(w) for w in words)
    query = (f'[out:json][timeout:90];nwr(around:{int(q.get("km", 30) * 1000)},{q["lat"]},{q["lon"]})["name"~"{rx}",i];'
             'out center tags meta;')
    for host in ('https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'):
        try:
            els = json.loads(fetch(host, urllib.parse.urlencode({'data': query}).encode()))['elements']
            found = [{'id': e['type'][0] + str(e['id']), 'version': e.get('version'), 'timestamp': e.get('timestamp'),
                      'lat': e.get('lat') or e.get('center', {}).get('lat'), 'lon': e.get('lon') or e.get('center', {}).get('lon'),
                      'tags': e.get('tags')} for e in els]
            res['near'].append({'query': q, 'host': host, 'found': found})
            print('near', q['name'], len(found), 'found', flush=True)
            break
        except Exception as e:
            res['near'].append({'query': q, 'host': host, 'error': str(e)})

WORDS = re.compile(r'address|location|located|moved|moving|new home|new studio|closed|closing|mall|suite|space|street|st\b|blvd|boulevard|avenue|road|dell range|frontier|cheyenne|wy\s+8\d{4}', re.I)
for url in spec.get('pages', []):
    try:
        if not recheck.allowed(url):
            res['pages'][url] = {'error': 'robots.txt disallows'}
            continue
        p = recheck.Text()
        html = recheck.get(url)
        p.feed(html)
        text = re.sub(r'\s+', ' ', ' '.join(p.out))
        bits = []
        for m in WORDS.finditer(text):
            s = text[max(0, m.start() - 160):m.end() + 160]
            if not bits or s[:60] not in bits[-1]:
                bits.append(s)
        res['pages'][url] = {'title': (re.search(r'<title[^>]*>(.*?)</title>', html, re.I | re.S) or [None, None])[1],
                             'chars': len(text), 'around': bits[:40]}
        print(url, len(text), 'chars', len(bits), 'snippets', flush=True)
    except Exception as e:
        res['pages'][url] = {'error': f'{type(e).__name__}: {e}'}

with open(os.path.join(OUT, 'osm_check.json'), 'w', encoding='utf-8') as f:
    json.dump(res, f, indent=1, ensure_ascii=False)
