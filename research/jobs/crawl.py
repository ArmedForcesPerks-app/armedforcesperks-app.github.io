#!/usr/bin/env python3
"""
Research job: looks for a military discount on local businesses' OWN websites.
For each website: honors robots.txt, reads the home page plus a few likely pages (military,
discounts, specials, FAQ...), one request at a time per site with a pause, and keeps short text
snippets around any mention of a military/veteran discount. Nothing is published from here; the
snippets are reviewed by hand before a shop goes on the map.

Usage: crawl.py OUTDIR K/N    (input: research/crawl_input.json.gz = [{"site": url, "osm": [...], "name": ...}])
"""
import concurrent.futures as cf, gzip, html, http.client, json, os, re, socket, ssl, sys, threading, time
import urllib.error, urllib.parse, urllib.request, urllib.robotparser
from html.parser import HTMLParser

OUT = sys.argv[1]
K, N = (int(x) for x in (sys.argv[2] if len(sys.argv) > 2 else '0/1').split('/'))
UA = 'ArmedForcesPerks-discount-check/1.0 (+https://armedforcesperks.com/contact.html)'
MAX_BYTES = 2_500_000
TIMEOUT = 20
PER_HOST_PAUSE = 1.2
MAX_PAGES = 7
WORKERS = 24
socket.setdefaulttimeout(TIMEOUT)

POS = [
    ('military_discount', re.compile(r"\bmilitary\s+(?:(?:and|&|/|,)\s*(?:[a-z\-]+\s+){0,3})?(?:discounts?|pricing|rates?|specials?|savings|deals?)\b", re.I)),
    ('discount_for_military', re.compile(r"\b(?:discounts?|savings|\d{1,2}\s?%\s*off)\s+(?:for|to|on\s+\w+\s+for)\s+(?:all\s+|our\s+|current\s+|active(?:[- ]duty)?\s+|retired\s+|former\s+|u\.?s\.?\s+|and\s+|,\s*|/\s*|\w+\s+){0,6}?(?:military|service\s*(?:wo)?m[ae]n|service\s*members?|veterans?|armed\s+forces|troops|active[- ]duty)\b", re.I)),
    ('percent_military', re.compile(r"\b\d{1,2}\s?%\s*(?:off|discount)\b[^.!?|]{0,60}?\b(?:military|veterans?|active[- ]duty|service\s*members?)\b", re.I)),
    ('military_percent', re.compile(r"\b(?:military|veterans?|active[- ]duty|service\s*members?)\b[^.!?|]{0,60}?\b\d{1,2}\s?%\s*(?:off|discount)\b", re.I)),
    ('veteran_discount', re.compile(r"\b(?:veterans?|vets|heroes?|hero's|first\s+responders?\s+(?:and|&)\s+military)\s+(?:discounts?|pricing|specials?)\b", re.I)),
]
NEG = re.compile(r"\b(?:no|not|don'?t|doesn'?t|do\s+not|does\s+not|cannot|can'?t|unable\s+to|no\s+longer)\b[^.!?]{0,50}\b(?:military|veteran)", re.I)
SEASON = re.compile(r"veterans'?\s+day|memorial\s+day|4th\s+of\s+july|fourth\s+of\s+july|independence\s+day|nov(?:ember)?\.?\s+11|military\s+appreciation\s+(?:day|week|month)|\bon\s+11/11\b", re.I)
PARKED = re.compile(r"domain\s+(?:name\s+)?(?:is\s+)?for\s+sale|buy\s+this\s+domain|parked\s+(?:free|domain)|this\s+domain\s+has\s+expired|account\s+suspended", re.I)
LINK_WORDS = [
    (0, re.compile(r'militar|veteran|hero|discount|savings', re.I)),
    (1, re.compile(r'special|offer|deal|promo|coupon|rebate', re.I)),
    (2, re.compile(r'faq|question|about|pricing|prices|rates|services|membership|menu|policies|policy', re.I)),
]
SKIP_HOSTS = re.compile(r'(^|\.)(facebook|fb|instagram|twitter|x|tiktok|yelp|google|goo\.gl|linktr|linkedin|youtube|tripadvisor|nextdoor|square\.site|wixsite)\.', re.I)


class TextParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.skip = 0
        self.text = []
        self.links = []
        self._a = None
        self.title = ''
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'noscript', 'template', 'svg'):
            self.skip += 1
        elif tag == 'a':
            href = dict(attrs).get('href')
            self._a = [href, []] if href else None
        elif tag == 'title':
            self._in_title = True
        elif tag in ('br', 'p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'td', 'tr', 'section'):
            self.text.append(' . ' if tag in ('p', 'li', 'h1', 'h2', 'h3', 'h4', 'tr') else ' ')
        elif tag == 'meta':
            a = dict(attrs)
            if (a.get('name') or a.get('property') or '').lower() in ('description', 'og:description'):
                self.text.append(' ' + (a.get('content') or '') + ' . ')

    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'noscript', 'template', 'svg'):
            self.skip = max(0, self.skip - 1)
        elif tag == 'a' and self._a:
            self.links.append((self._a[0], ' '.join(self._a[1])))
            self._a = None
        elif tag == 'title':
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        if self.skip:
            return
        self.text.append(data)
        if self._a is not None:
            self._a[1].append(data)


_host_lock = threading.Lock()
_host_next = {}


def polite(host):
    with _host_lock:
        now = time.time()
        wait = max(0.0, _host_next.get(host, 0) - now)
        _host_next[host] = max(now, _host_next.get(host, 0)) + PER_HOST_PAUSE
    if wait:
        time.sleep(wait)


def fetch(url):
    host = urllib.parse.urlsplit(url).hostname or ''
    polite(host)
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'Accept-Language': 'en-US,en;q=0.8'})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        ctype = r.headers.get('Content-Type', '')
        if 'html' not in ctype and 'text' not in ctype:
            return r.status, r.geturl(), ''
        raw = r.read(MAX_BYTES)
        cs = r.headers.get_content_charset() or 'utf-8'
        return r.status, r.geturl(), raw.decode(cs, 'replace')


def robots_ok(base):
    rp = urllib.robotparser.RobotFileParser()
    try:
        status, _, text = fetch(urllib.parse.urljoin(base, '/robots.txt'))
        rp.parse(text.splitlines())
    except urllib.error.HTTPError as e:
        if e.code >= 500:
            return False, f'robots {e.code}'
        return True, ''
    except Exception:
        return True, ''
    return rp.can_fetch(UA, base), ''


def snippets(text):
    text = re.sub(r'\b[Uu]\.\s?[Ss]\.(?:\s?[Aa]\.)?', 'US', text)  # "U.S." would end a sentence for the patterns
    hits = []
    for name, rx in POS:
        for m in rx.finditer(text):
            a, b = max(0, m.start() - 220), min(len(text), m.end() + 220)
            s = text[a:b]
            flags = []
            if NEG.search(text[max(0, m.start() - 80):m.end() + 40]):
                flags.append('negative')
            if SEASON.search(s):
                flags.append('seasonal')
            hits.append({'p': name, 'm': m.group(0)[:120], 's': s, 'f': flags})
            if len(hits) >= 12:
                return hits
    return hits


def norm_site(u):
    u = (u or '').strip().split(';')[0].strip()
    if not u:
        return None
    if not re.match(r'^https?://', u, re.I):
        u = 'https://' + u.lstrip('/')
    try:
        p = urllib.parse.urlsplit(u)
    except ValueError:
        return None
    if not p.hostname or SKIP_HOSTS.search(p.hostname):
        return None
    return u


def same_site(a, b):
    ha = (urllib.parse.urlsplit(a).hostname or '').lower().removeprefix('www.')
    hb = (urllib.parse.urlsplit(b).hostname or '').lower().removeprefix('www.')
    return ha == hb or ha.endswith('.' + hb) or hb.endswith('.' + ha)


def crawl(item):
    site = item['site']
    rec = {'site': site, 'osm': item.get('osm'), 'name': item.get('name'), 'hits': [], 'pages': 0}
    try:
        ok, why = robots_ok(site)
        if not ok:
            rec['err'] = 'robots: ' + (why or 'disallowed')
            return rec
        try:
            status, final, body = fetch(site)
        except (ssl.SSLError, urllib.error.URLError) as e:
            if site.startswith('https://') and ('SSL' in str(e) or 'CERTIFICATE' in str(e).upper()):
                status, final, body = fetch('http://' + site[8:])
                rec['https'] = False
            else:
                raise
        rec.update(status=status, final=final, pages=1)
        p = TextParser()
        p.feed(body)
        text = html.unescape(re.sub(r'\s+', ' ', ' '.join(p.text)))
        rec['title'] = p.title.strip()[:150]
        rec['chars'] = len(text)
        if PARKED.search(text[:5000]):
            rec['parked'] = True
        for h in snippets(text):
            h['u'] = final
            rec['hits'].append(h)
        # Likely pages, best first, same site only.
        seen, cand = {final.split('#')[0]}, []
        for href, label in p.links:
            try:
                u = urllib.parse.urljoin(final, href).split('#')[0]
            except ValueError:
                continue
            if not u.startswith('http') or u in seen or not same_site(u, final):
                continue
            if re.search(r'\.(pdf|jpe?g|png|gif|zip|docx?|mp4|mov)(\?|$)', u, re.I):
                continue
            seen.add(u)
            hay = f'{label} {urllib.parse.urlsplit(u).path}'
            for rank, rx in LINK_WORDS:
                if rx.search(hay):
                    cand.append((rank, u))
                    break
        cand.sort(key=lambda x: x[0])
        for _, u in cand[:MAX_PAGES - 1]:
            try:
                st, fu, b = fetch(u)
            except Exception:
                continue
            rec['pages'] += 1
            pp = TextParser()
            pp.feed(b)
            t = html.unescape(re.sub(r'\s+', ' ', ' '.join(pp.text)))
            for h in snippets(t):
                h['u'] = fu
                rec['hits'].append(h)
    except urllib.error.HTTPError as e:
        rec['err'] = f'http {e.code}'
    except Exception as e:
        rec['err'] = f'{type(e).__name__}: {str(e)[:120]}'
    return rec


def main():
    items = json.load(gzip.open(os.path.join(os.path.dirname(__file__), '..', 'crawl_input.json.gz'), 'rt'))
    mine = [x for i, x in enumerate(items) if i % N == K]
    print('sites:', len(mine), 'of', len(items))
    path = os.path.join(OUT, f'crawl_{K}_of_{N}.jsonl.gz')
    t0, done, found = time.time(), 0, 0
    with gzip.open(path, 'wt') as f, cf.ThreadPoolExecutor(WORKERS) as ex:
        for rec in ex.map(crawl, mine):
            f.write(json.dumps(rec) + '\n')
            done += 1
            found += bool(rec['hits'])
            if done % 500 == 0:
                print(done, 'sites,', found, 'with mentions,', int(time.time() - t0), 's', flush=True)
    print('done', done, 'sites,', found, 'with mentions,', int(time.time() - t0), 's')


if __name__ == '__main__':
    main()
