// Tests for build.mjs. Run: node --test tools/store-locations/test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addFromLocators, applyCorrections, addressKey, buildQuery, guardAgainstDrops, isClosed, labelFor, loadBrands, locatorLabel, toStores, brandFor } from './build.mjs';

const brands = loadBrands(JSON.parse(readFileSync(new URL('./brands.json', import.meta.url), 'utf8')));
const idx = (key) => brands.findIndex((b) => b.key === key);

test('brands.json is valid; only chains waiting for their deal have no deal IDs', () => {
  assert.ok(brands.length >= 30);
  // A chain whose deal has left the sheet may keep an empty list until it comes back; none do now.
  const waiting = brands.filter((b) => !b.deals.length).map((b) => b.key);
  assert.deepEqual(waiting.sort(), []);
});

test('each chain gets its own small query, limited to U.S. areas', () => {
  for (const b of brands) {
    const q = buildQuery(b);
    assert.ok(q.includes(b.wikidata ?? b.brand), b.key);
    for (const c of ['US', 'PR', 'GU', 'VI', 'AS', 'MP']) assert.ok(q.includes(`"ISO3166-1"="${c}"`), c);
  }
  const named = buildQuery(brands.find((b) => b.key === 'texasdebrazil'));
  assert.match(named, /nwr\["name"="Texas de Brazil"\]/);
});

test('a chain that failed to download keeps last month\'s stores', () => {
  const prevStores = Array.from({ length: 5 }, (_, i) => [idx('yeti'), 30 + i / 100, -90, `old ${i}`]);
  const previous = { brands: brands.map((b) => ({ key: b.key })), stores: prevStores };
  const g = guardAgainstDrops(toStores([], brands), brands, previous, new Set(['yeti']));
  assert.equal(g.counts.yeti, 5);
  assert.ok(g.warnings.some((w) => w.includes('download failed')));
});

test('a fill-in run keeps the chains it did not download, without warnings', () => {
  const prevStores = [
    ...Array.from({ length: 5 }, (_, i) => [idx('yeti'), 30 + i / 100, -90, `yeti ${i}`]),
    ...Array.from({ length: 3 }, (_, i) => [idx('nike'), 31 + i / 100, -91, `nike ${i}`]),
  ];
  const previous = { brands: brands.map((b) => ({ key: b.key })), stores: prevStores };
  const notFetched = new Set(brands.filter((b) => b.key !== 'nike').map((b) => b.key));
  const g = guardAgainstDrops(toStores([], brands), brands, previous, new Set([...notFetched, 'nike']), notFetched);
  assert.equal(g.counts.yeti, 5);
  assert.equal(g.counts.nike, 3);
  assert.deepEqual(g.warnings, ['Nike: download failed, kept last month\'s stores.']);
});

test('closed, vacant and planned places are dropped', () => {
  assert.equal(isClosed({ shop: 'car_parts' }), false);
  assert.equal(isClosed({ 'disused:shop': 'car_parts' }), true);
  assert.equal(isClosed({ shop: 'vacant' }), true);
  assert.equal(isClosed({ shop: 'shoes', name: 'Foot Locker (closed)' }), true);
  assert.equal(isClosed({ amenity: 'cinema', opening_hours: 'closed' }), true);
});

test('brand rules: Take 5 car washes and Topgolf Swing Suites are left out', () => {
  assert.equal(brandFor({ 'brand:wikidata': 'Q112359190', amenity: 'car_wash' }, brands), null);
  assert.equal(brandFor({ 'brand:wikidata': 'Q112359190', shop: 'car_repair' }, brands)?.key, 'take5');
  assert.equal(brandFor({ 'brand:wikidata': 'Q7824379', leisure: 'sports_centre', name: 'Topgolf Swing Suite' }, brands), null);
  assert.equal(brandFor({ 'brand:wikidata': 'Q7932495', shop: 'clothes', name: 'Vineyard Vines Outlet' }, brands), null);
  // Name-only brands don't grab places that belong to another brand.
  assert.equal(brandFor({ name: 'Texas de Brazil', 'brand:wikidata': 'Q999', brand: 'Other' }, brands), null);
  assert.equal(brandFor({ name: 'Texas de Brazil', amenity: 'restaurant' }, brands)?.key, 'texasdebrazil');
});

test('labels use the street address when OSM has one', () => {
  assert.equal(labelFor({ 'addr:housenumber': '12', 'addr:street': 'Main St', 'addr:city': 'Killeen', 'addr:state': 'TX' }), '12 Main St, Killeen, TX');
  assert.equal(labelFor({ 'addr:city': 'Killeen', 'addr:state': 'TX' }), 'Killeen, TX');
  assert.equal(labelFor({}), '');
});

test('duplicates merge, positions are rounded, places outside the U.S. are dropped', () => {
  const els = [
    { type: 'node', lat: 31.1171234, lon: -97.7277891, tags: { 'brand:wikidata': 'Q4826087', shop: 'car_parts' } },
    { type: 'way', center: { lat: 31.11715, lon: -97.72781 }, tags: { 'brand:wikidata': 'Q4826087', shop: 'car_parts', 'addr:street': 'Fort Hood St', 'addr:housenumber': '1' } },
    { type: 'node', lat: 19.43, lon: -99.13, tags: { 'brand:wikidata': 'Q4826087', shop: 'car_parts' } }, // Mexico City (wrong area)
    { type: 'node', lat: 13.48, lon: 144.79, tags: { 'brand:wikidata': 'Q4826087', shop: 'car_parts' } }, // Guam
  ];
  // Mexico is excluded by the Overpass area, not by the box, so it stays here; the box only drops wild coordinates.
  const r = toStores(els, brands);
  assert.equal(r.skipped.duplicate, 1);
  const az = r.stores.filter((s) => s[0] === idx('autozone'));
  assert.equal(az.length, 3);
  assert.deepEqual(az.find((s) => s[1] === 31.11712), [idx('autozone'), 31.11712, -97.72779, '1 Fort Hood St']);
  assert.equal(toStores([{ type: 'node', lat: 51.5, lon: -0.1, tags: { 'brand:wikidata': 'Q4826087', shop: 'car_parts' } }], brands).stores.length, 0);
});

test('a brand that suddenly shrinks keeps last month\'s stores', () => {
  const prevStores = Array.from({ length: 40 }, (_, i) => [idx('kohls'), 30 + i / 100, -90, `old ${i}`]);
  const previous = { brands: brands.map((b) => ({ key: b.key })), stores: prevStores };
  const now = toStores([{ type: 'node', lat: 40, lon: -80, tags: { 'brand:wikidata': 'Q967265', shop: 'department_store' } }], brands);
  const g = guardAgainstDrops(now, brands, previous);
  assert.equal(g.counts.kohls, 40);
  assert.ok(g.warnings.some((w) => w.startsWith("Kohl's")));
});

test('a collapse of the whole list stops the update', () => {
  const previous = { brands: brands.map((b) => ({ key: b.key })), stores: Array.from({ length: 1000 }, () => [0, 30, -90, '']) };
  assert.throws(() => guardAgainstDrops({ stores: [], counts: {}, skipped: {} }, brands, previous), /Not publishing/);
});

test('chains find their current deal IDs by business name', async () => {
  const { matchDeals } = await import('./build.mjs');
  const deals = [
    { id: 'AFP-0056', name: 'Home Depot' },
    { id: 'AFP-0031', name: "Dave & Buster's" },
  ];
  const m = matchDeals(
    [
      { key: 'homedepot', name: 'The Home Depot' },
      { key: 'davebusters', name: 'Dave and Busters' },
      { key: 'gone', name: 'Gone Chain' },
    ],
    deals,
  );
  assert.deepEqual(m.get('homedepot'), ['AFP-0056']);
  assert.deepEqual(m.get('davebusters'), ['AFP-0031']);
  assert.deepEqual(m.get('gone'), []);
  const r = matchDeals([{ key: 'regal', name: 'Regal', dealNames: ['Regal Cinemas'] }], [{ id: 'AFP-0500', name: 'Regal Cinemas' }]);
  assert.deepEqual(r.get('regal'), ['AFP-0500']);
});

test('every chain in brands.json has a deal in the site deal list', async () => {
  const { matchDeals } = await import('./build.mjs');
  const brands = JSON.parse(readFileSync(new URL('./brands.json', import.meta.url), 'utf8')).brands;
  const raw = JSON.parse(readFileSync(new URL('../../data/deals.json', import.meta.url), 'utf8'));
  const m = matchDeals(brands, raw.deals ?? raw);
  // Chains waiting for their deal to come back to the sheet have no deal IDs yet.
  for (const b of brands) if (b.deals.length) assert.ok(m.get(b.key).length, b.name);
});

test('Regal: only theatres on the participating list', async () => {
  const { onList, theatreKey } = await import('./build.mjs');
  const regal = brands.find((b) => b.key === 'regal');
  assert.ok(regal.listed.length > 250);
  assert.equal(theatreKey('Regal Edwards Aliso Viejo & RPX'), 'alisoviejo');
  // Listed
  assert.ok(onList({ name: 'Regal Dimond Center 4DX', 'addr:state': 'AK' }, regal.listed));
  assert.ok(onList({ name: 'Edwards Aliso Viejo Stadium 6', 'addr:city': 'Aliso Viejo', 'addr:state': 'CA' }, regal.listed));
  assert.ok(onList({ name: 'Regal Killeen' }, regal.listed));
  assert.ok(onList({ name: 'Regal Augusta', 'addr:state': 'ME', 'addr:city': 'Augusta' }, regal.listed));
  // Not listed
  assert.ok(!onList({ name: 'Regal Union Square', 'addr:state': 'NY' }, regal.listed));
  assert.ok(!onList({ name: 'Regal Killeen', 'addr:state': 'GA' }, regal.listed), 'wrong state');
  assert.ok(!onList({ name: 'Regal' }, regal.listed), 'no branch name');
  assert.ok(!onList({}, regal.listed));
});

test('Regal places are dropped from the map unless listed', () => {
  const regal = { type: 'node', lat: 31.1, lon: -97.7, tags: { 'brand:wikidata': 'Q835638', amenity: 'cinema' } };
  const r = toStores(
    [
      { ...regal, id: 1, tags: { ...regal.tags, name: 'Regal Killeen', 'addr:state': 'TX' } },
      { ...regal, id: 2, lat: 40.7, lon: -74, tags: { ...regal.tags, name: 'Regal Union Square', 'addr:state': 'NY' } },
    ],
    brands,
  );
  assert.equal(r.counts.regal, 1);
  assert.equal(r.skipped.notListed, 1);
});

test('AMC: only theatres on the participating list', async () => {
  const { onList, theatreKey } = await import('./build.mjs');
  const amc = brands.find((b) => b.key === 'amc');
  assert.ok(amc.listed.length > 400);
  assert.equal(theatreKey('AMC DINE-IN Vestavia Hills 10'), 'vestaviahills');
  assert.equal(theatreKey('AMC CLASSIC Dothan Pavilion 12'), 'dothanpavilion');
  assert.equal(theatreKey('AMC Glendora 12 @ 210/57'), 'glendora');
  assert.ok(onList({ name: 'AMC Westgate 20', 'addr:state': 'AZ' }, amc.listed));
  assert.ok(onList({ name: 'AMC Classic Dothan Pavilion 12' }, amc.listed));
  assert.ok(onList({ name: 'AMC Orange 30', 'addr:state': 'CA' }, amc.listed));
  // "Orange" is short: without a state, "AMC Orange Park" is only matched as itself (it is listed in FL).
  assert.ok(!onList({ name: 'AMC Orange Village', 'addr:state': 'OH' }, amc.listed));
  assert.ok(!onList({ name: 'AMC Empire 25', 'addr:state': 'NJ' }, amc.listed), 'wrong state');
  assert.ok(!onList({ name: 'AMC Lincoln Square 13', 'addr:state': 'CA' }, amc.listed));
  assert.ok(!onList({ name: 'AMC Some Unlisted 12', 'addr:state': 'TX' }, amc.listed));
});

test('generic-named theatres match by state and city; aliases cover OSM spellings', async () => {
  const { onList } = await import('./build.mjs');
  const amc = brands.find((b) => b.key === 'amc').listed;
  const regal = brands.find((b) => b.key === 'regal').listed;
  assert.ok(onList({ name: 'AMC', 'addr:city': 'Porter Ranch', 'addr:state': 'CA' }, amc));
  assert.ok(onList({ name: 'AMC Dine-In', 'addr:city': 'Midlothian', 'addr:state': 'VA' }, amc));
  assert.ok(onList({ name: 'AMC 16 Galleria at Tyler' }, amc));
  assert.ok(onList({ name: 'Regal Cinemas', 'addr:city': 'Augusta', 'addr:state': 'ME' }, regal));
  assert.ok(onList({ name: 'Regal Cinemas Guam Megaplex 14' }, regal));
  // Generic name without a city or state: can't tell, so left off.
  assert.ok(!onList({ name: 'Regal Cinemas' }, regal));
  // A named theatre that isn't listed doesn't sneak in through its city.
  assert.ok(!onList({ name: 'Regal Crossgates', 'addr:city': 'Albany', 'addr:state': 'NY' }, regal));
  assert.ok(!onList({ name: 'AMC', 'addr:city': 'Kokomo', 'addr:state': 'IN' }, amc));
});

test('street addresses compare loosely: directions, abbreviations, Hawaii numbers', () => {
  assert.equal(addressKey('2801 SW 27th Avenue, Ocala'), addressKey('2801 Southwest 27th Ave'));
  assert.equal(addressKey('255 E.Basse, San Antonio'), addressKey('255 East Basse Road'));
  assert.equal(addressKey('8401C Gateway Blvd W'), addressKey('8401 Gateway Boulevard West'));
  assert.equal(addressKey('98-1005 Moanalua Rd, Space 229'), '98-1005 moa');
  assert.notEqual(addressKey('98-1005 Moanalua Rd'), addressKey('98-1061 Moanalua Rd'));
  assert.equal(addressKey('Walden Galleria'), '');
  assert.equal(locatorLabel({ 'addr:street_address': '4465 N Grape Dr', 'addr:city': 'MOSES LAKE', 'addr:state': 'WA' }), '4465 N Grape Dr, Moses Lake, WA');
});

test('stores missing from OpenStreetMap are added from the chain locator, without duplicates', () => {
  const az = idx('autozone');
  const osm = { stores: [[az, 40.4555, -109.5287, '1 Main St, Vernal, UT'], [az, 40.0, -100.0, '']], counts: {}, skipped: {} };
  const f = (lat, lon, props) => ({ geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { key: 'autozone', name: 'AutoZone', ...props } });
  const out = addFromLocators(osm, brands, [
    f(40.4556, -109.5288, { 'addr:street_address': '1 Main St' }), // same store, 15 m away
    f(40.47, -109.5287, { 'addr:street_address': '1 Main Street', 'addr:city': 'Vernal' }), // same address, 1.6 km off
    f(40.005, -100.0, { 'addr:street_address': '9 Elm St' }), // near an OSM store with no address
    f(40.2, -109.3, { 'addr:street_address': '50 W Hwy 40', 'addr:city': 'ROOSEVELT', 'addr:state': 'UT' }), // missing: added
    f(40.2, -109.3, { 'addr:street_address': '50 W Hwy 40', 'addr:city': 'ROOSEVELT', 'addr:state': 'UT' }), // the locator's own duplicate
  ]);
  assert.equal(out.counts.autozone, 3);
  assert.deepEqual(out.added, { autozone: 1 });
  assert.ok(out.stores.some((r) => r[3] === '50 W Hwy 40, Roosevelt, UT'));
});

test('a pin far from its street address is moved; locator pins far from their address use the address', () => {
  const az = idx('autozone');
  const osm = { stores: [[az, 33.0, -97.0, '125 E State Hwy 114, Roanoke, TX']], counts: {}, skipped: {} };
  const out = addFromLocators(osm, brands, [
    // Same address 5 km away; the Census geocoder agrees with the locator, so the map pin moves.
    { geometry: { type: 'Point', coordinates: [-97.0, 33.045] }, properties: { key: 'autozone', name: 'AutoZone', 'addr:street_address': '125 East State Highway 114', census: [33.0452, -97.0001] } },
    // A new store whose locator pin is 20 km from its address: placed at the address.
    { geometry: { type: 'Point', coordinates: [-96.0, 32.0] }, properties: { key: 'autozone', name: 'AutoZone', 'addr:street_address': '7 Oak St', census: [32.2, -96.0] } },
  ]);
  const rows = out.stores.filter((r) => r[0] === az).sort((a, b) => a[1] - b[1]);
  assert.deepEqual([rows[0][1], rows[0][2]], [32.2, -96]);
  assert.deepEqual([rows[1][1], rows[1][2]], [33.045, -97]);
  assert.equal(out.moved.length, 1);
});

test('a locator store with only an address (placed by the geocoder) is added but never moves a map pin', () => {
  const az = idx('autozone');
  const osm = { stores: [[az, 33.0, -97.0, '125 E State Hwy 114, Roanoke, TX']], counts: {}, skipped: {} };
  const out = addFromLocators(osm, brands, [
    { geometry: { type: 'Point', coordinates: [-97.0001, 33.0452] }, properties: { key: 'autozone', name: 'AutoZone', 'addr:street_address': '125 East State Highway 114', census: [33.0452, -97.0001], from_address: true } },
    { geometry: { type: 'Point', coordinates: [-96.0, 32.2] }, properties: { key: 'autozone', name: 'AutoZone', 'addr:street_address': '7 Oak St', census: [32.2, -96.0], from_address: true } },
  ]);
  const rows = out.stores.filter((r) => r[0] === az).sort((a, b) => a[1] - b[1]);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[1][1], rows[1][2]], [33.0, -97.0]);
  assert.equal(out.moved.length, 0);
});

test('hand-checked corrections remove closed stores and add confirmed ones', () => {
  const ob = idx('outback'), az = idx('autozone'), tb = idx('texasdebrazil');
  const res = { stores: [[ob, 21.3, -158.0, 'Kapolei'], [ob, 30.0, -90.0, 'New Orleans'], [az, 20.9, -156.7, 'Lahaina'], [az, 21.0, -157.0, 'Other']], counts: {} };
  const out = applyCorrections(res, brands, {
    closedIn: [{ brand: 'outback', box: [18.8, -160.5, 22.5, -154.5], reason: 'left Hawaii' }],
    remove: [{ brand: 'autozone', lat: 20.9001, lon: -156.7, within: 300, label: 'Lahaina', reason: 'closed' }],
    add: [{ brand: 'texasdebrazil', lat: 21.2911, lon: -157.8437, label: 'Ala Moana' }, { brand: 'autozone', lat: 21.0001, lon: -157.0, label: 'dup' }],
  });
  assert.deepEqual(out.stores.map((r) => r[3]).sort(), ['Ala Moana', 'New Orleans', 'Other']);
  assert.equal(out.counts.outback, 1);
  assert.equal(out.counts.texasdebrazil, 1);
  assert.equal(out.corrected.length, 3);
  assert.ok(out.stores.every((r, i, a) => i === 0 || a[i - 1][0] <= r[0]));
});

test('locator stores respect participating lists and excluded names', () => {
  const take5 = { geometry: { type: 'Point', coordinates: [-90, 35] }, properties: { key: 'take5', name: 'Take 5 Car Wash', 'addr:street_address': '1 A St' } };
  const regal = { geometry: { type: 'Point', coordinates: [-91, 36] }, properties: { key: 'regal', name: 'Regal Nowhere Special 99', 'addr:city': 'Nowhere', 'addr:state': 'ZZ' } };
  const out = addFromLocators({ stores: [], counts: {}, skipped: {} }, brands, [take5, regal]);
  assert.equal(out.stores.length, 0);
});
