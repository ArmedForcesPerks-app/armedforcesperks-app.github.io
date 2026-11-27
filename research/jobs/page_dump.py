#!/usr/bin/env python3
"""
Research job: reads offer pages exactly the way the monthly recheck does (tools/local-shops/recheck.py:
robots.txt, one request at a time per website, a pause) and saves what it sees, so an offer sentence the
crawl found but the recheck didn't can be traced (a changed page, text that only appears inside scripts,
a block page...), and every kept offer can be read in its full context.
For each page: HTTP status, final address, content type, size, title, the recheck's normalized text, and
up to six raw-HTML snippets around "military"/"veteran".
Input: research/LIST, a JSON list of page addresses.
Output: pages.json.gz, {url: {...}}.
Usage: page_dump.py OUTDIR LIST
"""
import concurrent.futures as cf, gzip, html, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request

OUT, LIST = sys.argv[1], sys.argv[2]
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'tools', 'local-shops'))
import recheck  # noqa: E402

urls = json.load(open(os.path.join(HERE, '..', LIST), encoding='utf-8'))
TITLE = re.compile(r'<title[^>]*>(.*?)</title>', re.I | re.S)
WORD = re.compile(r'militar|veteran', re.I)


def dump(url):
    rec = {}
    try:
        if not recheck.allowed(url):
            return {'err': 'robots.txt disallows'}
        recheck.polite(urllib.parse.urlsplit(url).hostname or '')
        req = urllib.request.Request(url, headers={'User-Agent': recheck.UA, 'Accept': 'text/html,*/*;q=0.5', 'Accept-Language': 'en-US,en;q=0.8'})
        with urllib.request.urlopen(req, timeout=recheck.TIMEOUT) as r:
            raw = r.read(recheck.MAX_BYTES + 1)
            rec.update(status=r.status, final=r.geturl(), ctype=r.headers.get('Content-Type', ''), server=r.headers.get('Server', ''),
                       bytes=len(raw), cut=len(raw) > recheck.MAX_BYTES)
            body = raw[:recheck.MAX_BYTES].decode(r.headers.get_content_charset() or 'utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return {'err': f'http {e.code}', 'server': (e.headers.get('Server', '') if e.headers else '')}
    except Exception as e:
        return {'err': f'{type(e).__name__}: {str(e)[:150]}'}
    m = TITLE.search(body)
    rec['title'] = html.unescape(re.sub(r'\s+', ' ', m.group(1))).strip()[:200] if m else ''
    p = recheck.Text()
    p.feed(body)
    rec['text'] = recheck.norm(' '.join(p.out))[:400000]
    spans = []
    for mm in WORD.finditer(body):
        if spans and mm.start() < spans[-1][1]:
            continue
        spans.append((max(0, mm.start() - 300), mm.end() + 300))
        if len(spans) >= 6:
            break
    rec['raw'] = [body[a:b] for a, b in spans]
    return rec


t0 = time.time()
with cf.ThreadPoolExecutor(16) as ex:
    res = dict(zip(urls, ex.map(dump, urls)))
print(f'{len(urls)} pages in {time.time() - t0:.0f} s; {sum("err" in r for r in res.values())} errors', flush=True)
with gzip.open(os.path.join(OUT, 'pages.json.gz'), 'wt', encoding='utf-8') as f:
    json.dump(res, f, ensure_ascii=False)
