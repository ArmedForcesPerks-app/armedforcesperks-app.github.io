#!/usr/bin/env python3
"""
Which ZIP code area a point is in, from the U.S. Census Bureau's ZIP Code Tabulation Areas (2020
cartographic boundary file, public domain, about 60 MB). atp-extract.py uses it to check store
pins: when a chain's pin and its geocoded street address disagree, a pin outside the store's own
ZIP code area (with the address inside it) is the one that's off.

Plain Python, no packages: the shapefile is read straight out of the Census zip file.
Self-test: python3 zip_areas.py --self-test
"""
import math, os, struct, sys, time, urllib.request, zipfile

URL = 'https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_zcta520_500k.zip'
UA = {'User-Agent': 'ArmedForcesPerks-store-audit/1.0 (+https://armedforcesperks.com)'}


def download(path, url=URL, tries=3):
    """Saves the ZIP code area file to path. Returns False if it can't be had (the check is skipped)."""
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=600) as r, open(path, 'wb') as f:
                while chunk := r.read(1 << 20):
                    f.write(chunk)
            return True
        except Exception as e:
            print('ZIP code areas: download failed:', e)
            if attempt + 1 < tries:
                time.sleep(30)
    return False


def dbf_column(data, prefix):
    """The values of the first dBase column whose name starts with prefix, one per record."""
    count = struct.unpack_from('<I', data, 4)[0]
    header, size = struct.unpack_from('<HH', data, 8)
    pos, offset = 32, 1  # each record starts with a one-byte deleted flag
    while pos + 32 <= header and data[pos] != 0x0D:
        name = data[pos:pos + 11].split(b'\0')[0].decode('ascii', 'replace')
        width = data[pos + 16]
        if name.startswith(prefix):
            return [data[header + i * size + offset:header + i * size + offset + width].decode('ascii', 'replace').strip()
                    for i in range(count)]
        offset += width
        pos += 32
    raise ValueError(f'no {prefix} column')


def inside(x, y, xy, parts, count):
    """Even-odd test over every ring of a shapefile polygon (holes are rings too)."""
    hit = False
    ends = list(parts[1:]) + [count]
    for start, end in zip(parts, ends):
        j = end - 1
        for i in range(start, end):
            xi, yi, xj, yj = xy[2 * i], xy[2 * i + 1], xy[2 * j], xy[2 * j + 1]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                hit = not hit
            j = i
    return hit


def lookup(points, shp, codes):
    """points: [(lat, lon), ...]. Returns each point's area code from `codes` ('' if in none)."""
    grid = {}
    for k, (lat, lon) in enumerate(points):
        grid.setdefault((math.floor(lon), math.floor(lat)), []).append(k)
    out = [''] * len(points)
    pos = 100  # after the file header
    while pos + 8 <= len(shp):
        number, words = struct.unpack_from('>ii', shp, pos)
        body, pos = pos + 8, pos + 8 + 2 * words
        if words < 22 or struct.unpack_from('<i', shp, body)[0] not in (5, 15, 25):
            continue  # not a polygon (or an empty record)
        xmin, ymin, xmax, ymax = struct.unpack_from('<4d', shp, body + 4)
        near = [k for cx in range(math.floor(xmin), math.floor(xmax) + 1)
                for cy in range(math.floor(ymin), math.floor(ymax) + 1)
                for k in grid.get((cx, cy), ())
                if not out[k] and xmin <= points[k][1] <= xmax and ymin <= points[k][0] <= ymax]
        if not near:
            continue
        nparts, npoints = struct.unpack_from('<2i', shp, body + 36)
        parts = struct.unpack_from(f'<{nparts}i', shp, body + 44)
        xy = struct.unpack_from(f'<{2 * npoints}d', shp, body + 44 + 4 * nparts)
        code = codes[number - 1] if 0 < number <= len(codes) else ''
        for k in near:
            if inside(points[k][1], points[k][0], xy, parts, npoints):
                out[k] = code
    return out


def lookup_file(points, path):
    """ZIP code area of each (lat, lon) point, from a Census ZCTA zip file."""
    with zipfile.ZipFile(path) as z:
        base = next(n[:-4] for n in z.namelist() if n.lower().endswith('.shp'))
        codes = dbf_column(z.read(base + '.dbf'), 'ZCTA5CE')
        return lookup(points, z.read(base + '.shp'), codes)


def _write_test_zip(path, polygons):
    """A tiny ZCTA-like zip file: polygons = [(code, [ring, ...]), ...], ring = [(lon, lat), ...]."""
    recs = []
    for n, (_, rings) in enumerate(polygons, 1):
        pts = [p for ring in rings for p in ring]
        parts, at = [], 0
        for ring in rings:
            parts.append(at)
            at += len(ring)
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        body = struct.pack('<i4d2i', 5, min(xs), min(ys), max(xs), max(ys), len(rings), len(pts))
        body += struct.pack(f'<{len(parts)}i', *parts) + struct.pack(f'<{2 * len(pts)}d', *[c for p in pts for c in p])
        recs.append(struct.pack('>ii', n, len(body) // 2) + body)
    shp = struct.pack('>i20xi', 9994, (100 + sum(map(len, recs))) // 2) + struct.pack('<ii4d32x', 1000, 5, 0, 0, 0, 0)
    shp += b''.join(recs)
    field = b'GEOID20'.ljust(11, b'\0') + b'C' + bytes(4) + bytes([5, 0]) + bytes(14)
    field += b'ZCTA5CE20'.ljust(11, b'\0') + b'C' + bytes(4) + bytes([5, 0]) + bytes(14)
    header = 32 + 2 * 32 + 1
    dbf = struct.pack('<B3xIHH20x', 3, len(polygons), header, 11) + field + b'\r'
    dbf += b''.join(b' ' + b'xxxxx' + code.encode().ljust(5) for code, _ in polygons) + b'\x1a'
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr('t.shp', shp)
        z.writestr('t.dbf', dbf)


def self_test():
    import tempfile
    # Outer rings clockwise, holes counterclockwise, as in a real shapefile.
    square = lambda x0, y0, x1, y1: [(x0, y0), (x0, y1), (x1, y1), (x1, y0), (x0, y0)]
    polygons = [
        ('11111', [square(-80, 30, -79, 31), square(-79.8, 30.2, -79.6, 30.4)[::-1]]),  # a square with a hole
        ('22222', [square(-79, 30, -78, 31), square(-70, 40, -69.5, 40.5)]),      # two separate pieces
        ('33333', [square(-79.79, 30.21, -79.61, 30.39)]),                         # inside the hole
    ]
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, 'z.zip')
        _write_test_zip(path, polygons)
        got = lookup_file([(30.5, -79.5), (30.3, -79.7), (30.5, -78.5), (40.2, -69.8), (35, -100), (30.25, -79.75)], path)
    want = ['11111', '33333', '22222', '22222', '', '33333']
    assert got == want, (got, want)
    print('zip_areas self-test passed')


if __name__ == '__main__':
    if sys.argv[1:] == ['--self-test']:
        self_test()
    else:
        print(__doc__)
