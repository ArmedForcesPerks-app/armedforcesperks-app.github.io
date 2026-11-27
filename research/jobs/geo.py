"""Shared helpers: state lookup for points, distances."""
import json, math, os
from shapely.geometry import shape, Point
from shapely.strtree import STRtree
HERE = os.path.dirname(os.path.abspath(__file__))
ABBR = {'Alabama':'AL','Alaska':'AK','American Samoa':'AS','Arizona':'AZ','Arkansas':'AR','California':'CA','Colorado':'CO',
'Commonwealth of the Northern Mariana Islands':'MP','Connecticut':'CT','Delaware':'DE','District of Columbia':'DC','Florida':'FL',
'Georgia':'GA','Guam':'GU','Hawaii':'HI','Idaho':'ID','Illinois':'IL','Indiana':'IN','Iowa':'IA','Kansas':'KS','Kentucky':'KY',
'Louisiana':'LA','Maine':'ME','Maryland':'MD','Massachusetts':'MA','Michigan':'MI','Minnesota':'MN','Mississippi':'MS','Missouri':'MO',
'Montana':'MT','Nebraska':'NE','Nevada':'NV','New Hampshire':'NH','New Jersey':'NJ','New Mexico':'NM','New York':'NY',
'North Carolina':'NC','North Dakota':'ND','Ohio':'OH','Oklahoma':'OK','Oregon':'OR','Pennsylvania':'PA','Puerto Rico':'PR',
'Rhode Island':'RI','South Carolina':'SC','South Dakota':'SD','Tennessee':'TN','Texas':'TX','United States Virgin Islands':'VI',
'Utah':'UT','Vermont':'VT','Virginia':'VA','Washington':'WA','West Virginia':'WV','Wisconsin':'WI','Wyoming':'WY'}
_fc = json.load(open(os.path.join(HERE, '..', 'states.geojson')))
_geoms = [shape(f['geometry']) for f in _fc['features']]
_codes = [ABBR[f['properties']['name']] for f in _fc['features']]
_tree = STRtree(_geoms)

def state_of(lat, lon, max_deg=0.3):
    p = Point(lon, lat)
    for i in _tree.query(p):
        if _geoms[i].contains(p):
            return _codes[i]
    # coastal points just outside the simplified outline: nearest state within ~30 km
    i = _tree.nearest(p)
    if i is not None and _geoms[i].distance(p) <= max_deg:
        return _codes[i]
    return ''

def meters(a, b):
    R = 6371000.0
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))
