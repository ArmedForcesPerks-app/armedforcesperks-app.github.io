#!/usr/bin/env python3
"""
Research job: the full visible text of a short list of pages, to read an offer's exact terms by hand.
Same polite rules as crawl.py (robots.txt, one request at a time per site, a pause between requests).
Also reads up to 4 same-site pages each page links to about military, veteran or discount offers,
specials, or locations.
Usage: pages.py OUTDIR LIST   (LIST in research/: a JSON list of URLs)
"""
import gzip, html, json, os, re, sys, urllib.parse

OUT, LIST = sys.argv[1], sys.argv[2]
sys.argv = [sys.argv[0], OUT, '0/1']
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import crawl  # noqa: E402

FOLLOW = re.compile(r'militar|veteran|discount|special|offer|deal|promo|location|visit|faq|hours', re.I)
urls = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', LIST)))
rules, done = {}, set()


def read(u):
    rec = {'url': u}
    try:
        base = re.match(r'^https?://[^/]+', u).group(0)
        if base not in rules:
            rules[base] = crawl.robots(base)[0]
        if not rules[base](u):
            rec['err'] = 'robots: disallowed'
            return rec, []
        st, final, body = crawl.fetch(u)
        p = crawl.TextParser()
        p.feed(body)
        rec.update(status=st, final=final, title=p.title.strip()[:200],
                   text=html.unescape(re.sub(r'\s+', ' ', ' '.join(p.text)))[:80000])
        links = []
        for href, label in p.links:
            try:
                v = urllib.parse.urljoin(final, href).split('#')[0]
            except ValueError:
                continue
            if v.startswith('http') and crawl.same_site(v, final) and FOLLOW.search(f'{label} {urllib.parse.urlsplit(v).path}'):
                links.append(v)
        rec['links'] = sorted(set(links))[:60]
        return rec, rec['links']
    except Exception as e:
        rec['err'] = f'{type(e).__name__}: {str(e)[:150]}'
        return rec, []


with gzip.open(os.path.join(OUT, 'pages.jsonl.gz'), 'wt') as f:
    for u in urls:
        rec, links = read(u)
        done.add(u)
        f.write(json.dumps(rec, ensure_ascii=False) + '\n')
        print(u, rec.get('status') or rec.get('err'), len(rec.get('text', '')), flush=True)
        extra = [v for v in links if v not in done and re.search(r'militar|veteran|discount|special|offer|location', v, re.I)][:4]
        for v in extra:
            r2, _ = read(v)
            r2['from'] = u
            done.add(v)
            f.write(json.dumps(r2, ensure_ascii=False) + '\n')
            print('  ', v, r2.get('status') or r2.get('err'), len(r2.get('text', '')), flush=True)
