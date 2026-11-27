#!/usr/bin/env python3
"""
Re-reads each local shop's offer page (tools/local-shops/shops.json) and records whether the offer
sentence is still there, so the map stops showing an offer the business no longer advertises.
Polite: honors robots.txt, reads each page once, one request at a time per website, with a pause.

Writes data/local-shops-status.json:
  {"checked": "YYYY-MM-DD", "shops": {"<osm id>": {"seen": "YYYY-MM-DD" or null, "misses": N}}}
"misses" counts monthly checks in a row that didn't find the sentence (or couldn't read the page);
the store-list build leaves a shop off the map at 2.

A check less than 20 days after the last one is skipped (so a second run in the same month can't
count a miss twice), unless --force. If most pages can't be read at all (a network problem on our
side, not the shops'), nothing is recorded and the next run tries again.

Usage: python3 tools/local-shops/recheck.py [--force]
"""
import concurrent.futures as cf, datetime, html, json, os, re, socket, sys, threading, time, unicodedata
import urllib.parse, urllib.request, urllib.robotparser
from html.parser import HTMLParser

HERE = os.path.dirname(os.path.abspath(__file__))
SHOPS = os.path.join(HERE, 'shops.json')
STATUS = os.path.join(HERE, '..', '..', 'data', 'local-shops-status.json')
UA = 'ArmedForcesPerks-discount-check/1.0 (+https://armedforcesperks.com/contact.html)'
TIMEOUT = 20
PAUSE = 1.5
MAX_BYTES = 3_000_000
MIN_DAYS = 20
socket.setdefaulttimeout(TIMEOUT)


class Text(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.skip, self.out = 0, []

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'noscript', 'template', 'svg'):
            self.skip += 1
        elif tag == 'meta':
            a = dict(attrs)
            if (a.get('name') or a.get('property') or '').lower() in ('description', 'og:description'):
                self.out.append(' ' + (a.get('content') or '') + ' ')
        else:
            self.out.append(' ')

    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'noscript', 'template', 'svg'):
            self.skip = max(0, self.skip - 1)

    def handle_data(self, data):
        if not self.skip:
            self.out.append(data)


def norm(s):
    """Lowercase letters, digits, % and $ only, so quotes, dashes and accents don't matter."""
    s = unicodedata.normalize('NFKD', html.unescape(s))
    s = ''.join(ch for ch in s if not unicodedata.combining(ch)).lower()
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9%$]+', ' ', s)).strip()


_lock, _next = threading.Lock(), {}


def polite(host):
    with _lock:
        now = time.time()
        wait = max(0.0, _next.get(host, 0) - now)
        _next[host] = max(now, _next.get(host, 0)) + PAUSE
    if wait:
        time.sleep(wait)


def get(url):
    polite(urllib.parse.urlsplit(url).hostname or '')
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'text/html,*/*;q=0.5', 'Accept-Language': 'en-US,en;q=0.8'})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        raw = r.read(MAX_BYTES)
        return raw.decode(r.headers.get_content_charset() or 'utf-8', 'replace')


_robots = {}


def allowed(url):
    base = '{0.scheme}://{0.netloc}'.format(urllib.parse.urlsplit(url))
    with _lock:
        rp = _robots.get(base)
    if rp is None:
        rp = urllib.robotparser.RobotFileParser()
        try:
            rp.parse(get(base + '/robots.txt').splitlines())
        except Exception:
            rp.parse([])  # no robots.txt (or unreadable): allowed
        with _lock:
            _robots[base] = rp
    return rp.can_fetch(UA, url)


def page_text(url):
    """Normalized visible text of the page, or None if it can't be read."""
    try:
        if not allowed(url):
            return None
        p = Text()
        p.feed(get(url))
        return norm(' '.join(p.out))
    except Exception:
        return None


def main():
    shops = json.load(open(SHOPS, encoding='utf-8'))['shops']
    try:
        saved = json.load(open(STATUS, encoding='utf-8'))
    except (OSError, ValueError):
        saved = {}
    old = saved.get('shops', {})
    today = datetime.date.today()
    try:
        last = datetime.date.fromisoformat(saved.get('checked', ''))
    except ValueError:
        last = None
    if last and (today - last).days < MIN_DAYS and '--force' not in sys.argv[1:]:
        print(f'Local shop offers were checked on {last}; the next check is due {last + datetime.timedelta(days=MIN_DAYS)}.')
        return
    today = today.isoformat()
    urls = sorted({s['source'] for s in shops})
    with cf.ThreadPoolExecutor(12) as ex:
        texts = dict(zip(urls, ex.map(page_text, urls)))
    unreadable = sum(1 for u in urls if texts[u] is None)
    if urls and unreadable * 2 > len(urls):
        print(f'{unreadable} of {len(urls)} offer pages could not be read at all; that looks like a network problem here, '
              'so nothing was recorded. The next run will try again.')
        return
    out, gone = {}, []
    for s in shops:
        text = texts.get(s['source'])
        prev = old.get(s['osm'], {})
        if text is not None and norm(s['quote']) in text:
            out[s['osm']] = {'seen': today, 'misses': 0}
        else:
            out[s['osm']] = {'seen': prev.get('seen') or s.get('checked'), 'misses': int(prev.get('misses', 0)) + 1}
            gone.append(f"{s['name']} ({s['osm']}): {'page not readable' if text is None else 'offer sentence not found'}, {out[s['osm']]['misses']} check(s) in a row")
    os.makedirs(os.path.dirname(STATUS), exist_ok=True)
    with open(STATUS, 'w', encoding='utf-8') as f:
        json.dump({'checked': today, 'shops': dict(sorted(out.items()))}, f, indent=1, sort_keys=True)
        f.write('\n')
    print(f'{len(shops) - len(gone)} of {len(shops)} local shop offers still on their websites.')
    for g in gone:
        print(' -', g)


if __name__ == '__main__':
    main()
