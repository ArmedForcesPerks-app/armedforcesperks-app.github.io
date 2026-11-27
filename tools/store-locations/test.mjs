// Tests for build.mjs. Run: node --test tools/store-locations/test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { addFromLocators, addressGuessed, applyCorrections, addressKey, buildQuery, choosePoint, guardAgainstDrops, isClosed, labelFor, loadBrands, loadLocalShops, localQuery, localRows, locatorLabel, toStores, brandFor } from './build.mjs';

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
  // A yoga studio that took over an empty mall unit (OpenStreetMap way 1085921022): "disused:shop=no" isn't closed.
  assert.equal(isClosed({ leisure: 'fitness_centre', 'disused:shop': 'no', name: 'Lady Kels Yoga' }), false);
  assert.equal(isClosed({ 'disused:shop': 'no' }), true); // still nothing open there
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
  // The same store drawn twice a few hundred meters apart, its address written two ways: one pin.
  const az2 = (lat, lon, street) => ({ type: 'node', lat, lon, tags: { 'brand:wikidata': 'Q4826087', shop: 'car_parts', 'addr:housenumber': '16798', 'addr:street': street } });
  const twice = toStores([az2(33.3438, -86.6033, 'Highway 280'), az2(33.3465, -86.6050, 'US 280')], brands);
  assert.equal(twice.stores.length, 1);
  // Two real stores on the same road with different numbers both stay.
  const two = toStores([az2(33.3438, -86.6033, 'Highway 280'), { ...az2(33.3465, -86.6050, 'Highway 280'), tags: { ...az2(0, 0, 'Highway 280').tags, 'addr:housenumber': '17020' } }], brands);
  assert.equal(two.stores.length, 2);
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
  // Numbered roads match by number however they're written.
  assert.equal(addressKey('320 State Route 211 East, Middletown, NY'), addressKey('320 Route 211 E'));
  assert.equal(addressKey('1404 NY-300'), addressKey('1404 Route 300'));
  assert.equal(addressKey('148 East Interstate 20 Frontage Road'), addressKey('148 I-20'));
  assert.equal(addressKey('8313 Northeast Highway 99'), addressKey('8313 N. E. Hwy. 99'));
  assert.equal(addressKey('100 U.S. Highway 1'), addressKey('100 US-1'));
  assert.equal(addressKey('100 Farm to Market 1960'), addressKey('100 FM-1960 Rd'));
  assert.notEqual(addressKey('620 Route 9W'), addressKey('620 Route 9'));
  // ...but a street that only starts like one is still a street.
  assert.equal(addressKey('5950 South State Street'), addressKey('5950 S. State St.'));
  assert.equal(addressKey('100 County Line Road'), '100 cou');
  assert.equal(addressKey('4485 La Jolla Village Dr'), '4485 la');
  // Number words, and a unit written before the street.
  assert.equal(addressKey('21 Ten Mile Drive'), addressKey('21 10 Mile Dr'));
  assert.equal(addressKey('93 First Street'), addressKey('93 1st St'));
  assert.equal(addressKey('3321 #200-300 North Interstate 35'), addressKey('3321 N Interstate 35 Ste 200-300'));
  assert.equal(addressKey('26125 United States Route 11'), addressKey('26125 US Route 11'));
  assert.equal(addressKey('4230 St Michael Dr'), addressKey('4230 Saint Michael Drive'));
  assert.equal(addressKey('10401-015 Us Highway 441 South'), addressKey('10401 US-441'));
  assert.equal(addressKey('107-24 71st Avenue'), '107-24 71s');
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

test('a map pin far from its street address is moved when the chain\'s pin and the address agree', () => {
  const az = idx('autozone');
  const osm = { stores: [[az, 33.0, -97.0, '125 E State Hwy 114, Roanoke, TX']], counts: {}, skipped: {} };
  const out = addFromLocators(osm, brands, [
    // Same address 5 km away; the Census geocoder agrees with the locator, so the map pin moves.
    { geometry: { type: 'Point', coordinates: [-97.0, 33.045] }, properties: { key: 'autozone', name: 'AutoZone', 'addr:street_address': '125 East State Highway 114', census: [33.0452, -97.0001] } },
  ]);
  assert.deepEqual(out.stores.filter((r) => r[0] === az).map((r) => [r[1], r[2]]), [[33.045, -97]]);
  assert.equal(out.moved.length, 1);
});

test('a new store whose pin and geocoded address disagree goes where the evidence points', () => {
  const p = { 'addr:postcode': '76401' };
  const pin = [32.0, -96.0];
  const address = [32.2, -96.0];
  // They agree (under 1 km), or there is no geocode: the chain's pin.
  assert.deepEqual(choosePoint(pin, [32.005, -96.0], p), pin);
  assert.deepEqual(choosePoint(pin, null, p), pin);
  // They disagree: the chain's pin by default (it was right about three times in four).
  assert.deepEqual(choosePoint(pin, address, p), pin);
  // ...the address when another store of the chain has the same pin (a copied pin)...
  assert.deepEqual(choosePoint(pin, address, p, { shared: true }), address);
  // ...or when, for this chain, the address has been right far more often than the pin.
  assert.deepEqual(choosePoint(pin, address, p, { trust: { pin: 1, address: 11 } }), address);
  assert.deepEqual(choosePoint(pin, address, p, { trust: { pin: 2, address: 3 } }), pin);
  // Never a geocoder guess: not an exact match, or found in another ZIP code.
  assert.deepEqual(choosePoint(pin, address, { ...p, census_exact: false }, { shared: true }), pin);
  assert.deepEqual(choosePoint(pin, address, { ...p, census_exact: true, census_zip: '76402' }, { shared: true }), pin);
  assert.deepEqual(choosePoint(pin, address, { ...p, census_exact: true, census_zip: '76401' }, { shared: true }), address);
  // The pin is outside the store's own ZIP code area and the address inside it: the address.
  assert.deepEqual(choosePoint(pin, address, { ...p, pin_zip_area: '76433', census_zip_area: '76401' }), address);
  assert.deepEqual(choosePoint(pin, address, { ...p, pin_zip_area: '', census_zip_area: '76401' }), address);
  // ...but not when the address is outside it too, or the pin is inside it.
  assert.deepEqual(choosePoint(pin, address, { ...p, pin_zip_area: '76433', census_zip_area: '76433' }), pin);
  assert.deepEqual(choosePoint(pin, address, { ...p, pin_zip_area: '76401', census_zip_area: '76401' }), pin);
  assert.deepEqual(choosePoint(pin, address, { ...p, pin_zip_area: '76433' }), pin);
  // A geocoder guess and a pin outside the ZIP code: neither can be trusted, so no spot at all.
  assert.equal(choosePoint(pin, address, { ...p, census_exact: false, pin_zip_area: '76433', census_zip_area: '76401' }), null);
  assert.deepEqual(choosePoint(pin, address, { ...p, census_exact: false, pin_zip_area: '76401', census_zip_area: '76401' }), pin);
  // Puerto Rico and the territories: always the chain's pin.
  assert.deepEqual(choosePoint([18.4882, -66.8007], [18.46047, -66.77791], p, { shared: true }), [18.4882, -66.8007]);
  assert.deepEqual(choosePoint([18.4882, -66.8007], [18.46047, -66.77791], { ...p, pin_zip_area: '', census_zip_area: '76401' }), [18.4882, -66.8007]);
});

test('a geocoder guess is told apart from a match of the street address', () => {
  assert.equal(addressGuessed({ 'addr:postcode': '76401', census_exact: true, census_zip: '76401' }), false);
  assert.equal(addressGuessed({ 'addr:postcode': '76401-2219', census_exact: true, census_zip: '76401' }), false);
  assert.equal(addressGuessed({ 'addr:postcode': '76401', census_exact: false, census_zip: '76401' }), true);
  assert.equal(addressGuessed({ 'addr:postcode': '76401', census_exact: true, census_zip: '76402' }), true);
  // Older store-locator files without the flags: not a guess.
  assert.equal(addressGuessed({ 'addr:postcode': '76401' }), false);
  assert.equal(addressGuessed({ census_exact: true, census_zip: '76402' }), false);
});

test('which of pin and address to trust is learned from the stores OpenStreetMap has too', () => {
  const rg = idx('regal');
  const theatre = (lat, lon, street, census) => ({ geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { key: 'regal', name: 'Regal Test', 'addr:street_address': street, 'addr:city': 'Town', 'addr:state': 'TX', census } });
  // Three theatres on the map where the chain's pin is about 2 km off and the address is right.
  const mapped = [[30.0, -97.0, '1 Alpha Rd'], [31.0, -97.0, '2 Beta Rd'], [32.0, -97.0, '3 Gamma Rd']];
  const osm = { stores: mapped.map(([la, lo, st]) => [rg, la, lo, `${st}, Town, TX`]), counts: {}, skipped: {} };
  const feats = mapped.map(([la, lo, st]) => theatre(la + 0.018, lo, st, [la, lo]));
  // A theatre the map doesn't have, pin 2 km from its address: placed at the address.
  feats.push(theatre(33.018, -97.0, '4 Delta Rd', [33.0, -97.0]));
  const brandsRegal = brands.map((b) => (b.key === 'regal' ? { ...b, listed: null } : b));
  const out = addFromLocators(osm, brandsRegal, feats);
  assert.deepEqual(out.pinChecks.regal, { pin: 0, address: 3 });
  assert.ok(out.stores.some((r) => r[0] === rg && r[1] === 33.0 && r[2] === -97.0));
  assert.equal(out.stores.filter((r) => r[0] === rg).length, 4);
});

test('two stores the chain gives the same pin: the one whose address is elsewhere goes to its address', () => {
  const az = idx('autozone');
  const loc = (lat, lon, street, census) => ({ geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { key: 'autozone', name: 'AutoZone', 'addr:street_address': street, 'addr:city': 'Chicago', 'addr:state': 'IL', census } });
  const out = addFromLocators({ stores: [], counts: {}, skipped: {} }, brands, [
    loc(41.7971, -87.6643, '6120 S Ashland Ave', [41.7972, -87.6640]),
    loc(41.7971, -87.6643, '7347 S Ashland Ave', [41.7600, -87.6630]), // copied pin; its address is 4 km south
  ]);
  const rows = out.stores.filter((r) => r[0] === az).map((r) => [r[1], r[2], r[3]]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(rows.map((r) => r[0]), [41.76, 41.7971]);
});

test('the same store with its street named two ways is one store', () => {
  const hd = idx('homedepot');
  const osm = { stores: [
    [hd, 60.56167, -151.23896, '10480 Kenai Spur Highway, Kenai, AK'],
    [hd, 40.0231, -74.9577, '4004 Burlington Pike, Delran, NJ'],
  ], counts: {}, skipped: {} };
  const loc = (lon, lat, street, city, state) => ({ geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { key: 'homedepot', name: 'The Home Depot', 'addr:street_address': street, 'addr:city': city, 'addr:state': state } });
  const out = addFromLocators(osm, brands, [
    loc(-151.3078, 60.5804, '10480 Spur Hwy', 'Kenai', 'AK'), // 4.3 km off, a street word in common
    loc(-74.9545, 40.0251, '4004 Route 130, Suite 14', 'Delran', 'NJ'), // 350 m off, same number
    loc(-74.9300, 40.0400, '4004 Oak Avenue', 'Delran', 'NJ'), // same number, another street, 3 km off: another store
  ]);
  assert.equal(out.stores.filter((r) => r[0] === hd).length, 3);
  assert.deepEqual(out.added, { homedepot: 1 });
  assert.ok(out.stores.some((r) => r[0] === hd && r[1] === 60.56167), 'the OSM pin on the building stays');
});

test('a highway address the geocoder puts miles off neither adds a second pin nor moves the map pin', () => {
  // Kohl's Weatherford, TX: the map pin and the locator's own pin are 1 km apart; the Census
  // geocoder puts "148 I-20" 11 km away.
  const k = idx('kohls');
  const osm = { stores: [[k, 32.72893, -97.78243, '148 East Interstate 20 Frontage Road, Weatherford, TX']], counts: {}, skipped: {} };
  const feature = { geometry: { type: 'Point', coordinates: [-97.7931663, 32.729356] }, properties: { key: 'kohls', name: "Kohl's", 'addr:street_address': '148 I-20', 'addr:city': 'Weatherford', 'addr:state': 'TX', census: [32.743368, -97.664188] } };
  const out = addFromLocators(osm, brands, [feature]);
  assert.deepEqual(out.stores.filter((r) => r[0] === k).map((r) => [r[1], r[2]]), [[32.72893, -97.78243]]);
  assert.equal(out.moved.length, 0);
  assert.deepEqual(out.added, {});
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

test('an address-only store is left off when the geocoder only guessed where it is', () => {
  const lw = idx('lowes');
  const store = (lat, street, extra) => ({ geometry: { type: 'Point', coordinates: [-96.0, lat] }, properties: { key: 'lowes', name: "Lowe's", 'addr:street_address': street, 'addr:city': 'Town', 'addr:state': 'TX', 'addr:postcode': '75001', census: [lat, -96.0], from_address: true, census_exact: true, census_zip: '75001', ...extra } });
  const out = addFromLocators({ stores: [], counts: {}, skipped: {} }, brands, [
    store(32.0, '1 Alpha Rd', { census_zip_area: '75001' }), // a sure match inside its ZIP code: added
    store(32.2, '2 Beta Rd', { census_exact: false }), // not an exact match
    store(32.4, '3 Gamma Rd', { census_zip: '75002' }), // found in another ZIP code
    store(32.6, '4 Delta Rd', { census_zip_area: '75009' }), // put outside its own ZIP code
    store(32.8, '5 Echo Rd', {}), // ZIP code areas not checked this run: added
  ]);
  assert.deepEqual(out.stores.filter((r) => r[0] === lw).map((r) => r[1]), [32.0, 32.8]);
  assert.deepEqual(out.placed.lowes, { pin: 0, address: 0, skipped: 3 });
  assert.equal(out.unplaced.length, 3);
  assert.match(out.unplaced[0], /^Lowe's, 2 Beta Rd.*: the chain gives only an address/);
});

test('a new store is left off when its pin is outside its ZIP code and the address is only a guess', () => {
  const hd = idx('homedepot');
  const store = (lat, street, extra) => ({ geometry: { type: 'Point', coordinates: [-96.0, lat] }, properties: { key: 'homedepot', name: 'The Home Depot', 'addr:street_address': street, 'addr:city': 'Town', 'addr:state': 'TX', 'addr:postcode': '75001', census: [lat + 0.05, -96.0], census_zip: '75001', ...extra } });
  const out = addFromLocators({ stores: [], counts: {}, skipped: {} }, brands, [
    store(32.0, '1 Alpha Rd', { census_exact: false, pin_zip_area: '75009', census_zip_area: '75001' }), // left off
    store(32.4, '2 Beta Rd', { census_exact: true, pin_zip_area: '75009', census_zip_area: '75001' }), // at the address
    store(32.8, '3 Gamma Rd', { census_exact: false, pin_zip_area: '75001', census_zip_area: '75001' }), // at the pin
  ]);
  assert.deepEqual(out.stores.filter((r) => r[0] === hd).map((r) => r[1]), [32.45, 32.8]);
  assert.deepEqual(out.placed.homedepot, { pin: 1, address: 1, skipped: 1 });
  assert.match(out.unplaced[0], /^The Home Depot, 1 Alpha Rd.*: the chain's pin is outside/);
});

test('ZIP code areas: the Census file reader finds the right area (holes and multi-part areas too)', () => {
  const r = spawnSync('python3', [new URL('./zip_areas.py', import.meta.url).pathname, '--self-test'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
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

test('a trial run with only a few chains leaves out the other chains\' corrections', () => {
  // As the pull request trial does (--only homedepot,regal,amc).
  const few = brands.filter((b) => ['homedepot', 'regal', 'amc'].includes(b.key));
  const hd = few.findIndex((b) => b.key === 'homedepot');
  const res = { stores: [[hd, 33.0, -117.0, '1 Main St'], [hd, 34.0, -118.0, '2 Main St']], counts: {} };
  const out = applyCorrections(res, few, {
    ...JSON.parse(readFileSync(new URL('./corrections.json', import.meta.url), 'utf8')),
    remove: [{ brand: 'homedepot', lat: 34.0001, lon: -118.0, within: 300, label: '2 Main St', reason: 'closed' }, { brand: 'footlocker', lat: 33.0, lon: -117.0, within: 300, label: 'x', reason: 'closed' }],
  });
  assert.deepEqual(out.stores.map((r) => r[3]), ['1 Main St']);
  assert.ok(out.stores.every((r) => few[r[0]]));
  assert.deepEqual(out.counts, { homedepot: 1, regal: 0, amc: 0 });
  assert.deepEqual(out.corrected, ['The Home Depot, 2 Main St: removed, closed']);
});

test('corrections.json: every fix names a chain in brands.json and has what it needs', () => {
  const corrections = JSON.parse(readFileSync(new URL('./corrections.json', import.meta.url), 'utf8'));
  const keys = new Set(brands.map((b) => b.key));
  const lat = (x) => typeof x === 'number' && x >= -15 && x <= 72;
  const lon = (x) => typeof x === 'number' && ((x >= -180 && x <= -64) || (x >= 144 && x <= 146));
  const kinds = { closedIn: ['box', 'reason'], remove: ['lat', 'lon', 'label', 'reason'], add: ['lat', 'lon', 'label'], move: ['lat', 'lon', 'to', 'label', 'reason'] };
  for (const k of Object.keys(corrections)) assert.ok(k === '_about' || kinds[k], `corrections.json: unknown section ${k}`);
  for (const [kind, needs] of Object.entries(kinds)) {
    for (const c of corrections[kind] ?? []) {
      const where = `corrections.json ${kind} ${c.brand} ${c.label ?? c.reason}`;
      assert.ok(keys.has(c.brand), `${where}: no such chain in brands.json`);
      for (const f of [...needs, 'source', 'checked']) assert.ok(c[f] !== undefined && c[f] !== '', `${where}: needs ${f}`);
      assert.match(c.source, /^https:\/\//, `${where}: source`);
      assert.match(c.checked, /^\d{4}-\d{2}-\d{2}$/, `${where}: checked`);
      if (kind === 'closedIn') {
        const [s, w, n, e] = c.box;
        assert.ok(lat(s) && lat(n) && lon(w) && lon(e) && s < n && w < e, `${where}: box`);
      } else {
        assert.ok(lat(c.lat) && lon(c.lon), `${where}: position`);
      }
      if (kind === 'move') assert.ok(lat(c.to[0]) && lon(c.to[1]), `${where}: to`);
    }
  }
});

test('a hand-checked move puts a misplaced store where it is', () => {
  const db = idx('davebusters');
  const res = { stores: [[db, 39.94378, -75.14191, '325 Christopher Columbus Boulevard, Philadelphia, NJ'], [db, 40.09179, -74.961, 'Franklin Mills']], counts: {} };
  const move = [{ brand: 'davebusters', lat: 39.94378, lon: -75.14191, within: 200, to: [39.95618, -75.13838], label: '325 N Christopher Columbus Blvd, Philadelphia, PA', reason: 'pin was at 325 S' }];
  const out = applyCorrections(res, brands, { move });
  assert.deepEqual(out.stores.map((r) => [r[1], r[2], r[3]]), [[39.95618, -75.13838, '325 N Christopher Columbus Blvd, Philadelphia, PA'], [40.09179, -74.961, 'Franklin Mills']]);
  assert.match(out.corrected[0], /: moved, pin was at 325 S/);
  // Already on the map at the right spot (say, from the chain's locator): the misplaced pin just goes.
  const twice = applyCorrections({ stores: [...res.stores, [db, 39.9562, -75.1384, '325 N Christopher Columbus Blvd']], counts: {} }, brands, { move });
  assert.equal(twice.stores.filter((r) => r[0] === db).length, 2);
  assert.match(twice.corrected[0], /misplaced duplicate removed/);
  // Nothing at the wrong spot (fixed at the source): nothing happens.
  assert.equal(applyCorrections({ stores: [res.stores[1]], counts: {} }, brands, { move }).corrected.length, 0);
});

test('a store taken off because its chain dropped it comes back once the chain lists it again', () => {
  const b5 = idx('big5');
  const res = { stores: [[b5, 39.712, -105.07591, '7111 West Alameda Avenue, Lakewood, CO'], [b5, 39.69061, -104.93993, '1430 South Colorado Boulevard, Denver, CO']], counts: {} };
  const corrections = { remove: [
    { brand: 'big5', lat: 39.712, lon: -105.07591, within: 300, label: '7111 West Alameda Avenue, Lakewood, CO', reason: 'dropped', unlessListed: true },
    { brand: 'big5', lat: 39.69061, lon: -104.93993, within: 300, label: '1430 South Colorado Boulevard, Denver, CO', reason: 'closed', unlessListed: true },
  ] };
  // The chain's list has the Lakewood store again (its pin 400 m off, same address).
  const features = [{ geometry: { type: 'Point', coordinates: [-105.0712, 39.7139] }, properties: { key: 'big5', name: 'Big 5 Sporting Goods', 'addr:street_address': '7111 W. Alameda Ave.', 'addr:city': 'Lakewood', 'addr:state': 'CO' } }];
  const out = applyCorrections(res, brands, corrections, features);
  assert.deepEqual(out.stores.map((r) => r[3]), ['7111 West Alameda Avenue, Lakewood, CO']);
  assert.match(out.corrected.find((m) => m.includes('Lakewood')), /NOT removed/);
  // Without this run's locator data, both come off.
  assert.equal(applyCorrections(res, brands, corrections).stores.length, 0);
});

test('locator stores respect participating lists and excluded names', () => {
  const take5 = { geometry: { type: 'Point', coordinates: [-90, 35] }, properties: { key: 'take5', name: 'Take 5 Car Wash', 'addr:street_address': '1 A St' } };
  const regal = { geometry: { type: 'Point', coordinates: [-91, 36] }, properties: { key: 'regal', name: 'Regal Nowhere Special 99', 'addr:city': 'Nowhere', 'addr:state': 'ZZ' } };
  const out = addFromLocators({ stores: [], counts: {}, skipped: {} }, brands, [take5, regal]);
  assert.equal(out.stores.length, 0);
});

test('a chain whose own store list is complete loses mapped stores the list no longer has', () => {
  const bs = loadBrands({
    brands: [
      { key: 'gamestop', name: 'GameStop', deals: ['AFP-0001'], match: { wikidata: 'Q202210' }, locatorComplete: { minStores: 2, evidence: 'test', source: 'https://example.com/' } },
      { key: 'nike', name: 'Nike', deals: ['AFP-0002'], match: { wikidata: 'Q483915' } },
    ],
  });
  const osm = () => ({
    stores: [
      [0, 30.0, -90.0, '100 Main Street, Town, LA'], // on the list
      [0, 30.2, -90.2, '200 Oak Street, Town, LA'], // not on the list, which has stores nearby: closed
      [0, 30.3, -90.0, '5 Bay Road, Town, LA'], // same address as a listed store 2 km away: the same store
      [0, 18.4, -66.1, '1 Calle Sol, San Juan, PR'], // the list has nothing within 150 km: can't tell, kept
      [1, 30.2, -90.2, '200 Oak Street, Town, LA'], // a chain without a complete list: kept
    ],
    counts: {},
    skipped: {},
  });
  const f = (lat, lon, street) => ({ geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { key: 'gamestop', name: 'GameStop', 'addr:street_address': street, 'addr:city': 'Town', 'addr:state': 'LA' } });
  const list = [f(30.0, -90.0, '100 Main Street'), f(30.5, -90.5, '300 Pine Street'), f(30.318, -90.0, '5 Bay Rd')];
  const out = addFromLocators(osm(), bs, list);
  assert.equal(out.counts.gamestop, 4); // 3 kept + 1 added
  assert.deepEqual(out.removed, { gamestop: 1 });
  assert.deepEqual(out.unlisted, ['GameStop, 200 Oak Street, Town, LA']);
  assert.equal(out.counts.nike, 1);
  // A list far shorter than expected is taken to be broken: nothing is taken off.
  const short = addFromLocators(osm(), bs, list.slice(0, 1));
  assert.equal(short.counts.gamestop, 4);
  assert.deepEqual(short.removed, {});
  assert.match(short.locatorNotes[0], /only 1 stores/);
  // No list at all this time: nothing is taken off either, quietly.
  const none = addFromLocators(osm(), bs, []);
  assert.equal(none.counts.gamestop, 4);
  assert.deepEqual(none.locatorNotes, []);
  assert.throws(() => loadBrands({ brands: [{ key: 'x', name: 'X', deals: [], match: { wikidata: 'Q1' }, locatorComplete: { minStores: 5 } }] }), /locatorComplete/);
});

test('in Puerto Rico a locator pin is trusted over a far-off geocoded address', () => {
  const hd = idx('homedepot');
  // Home Depot Hatillo: the store is mapped (no address); the locator pin is 1 km away, but its
  // "Km 84.3 - Rd. Pr 2" address geocodes 4 km off. Same store: nothing added.
  const osm = { stores: [[hd, 18.48939, -66.79108, '']], counts: {}, skipped: {} };
  const out = addFromLocators(osm, brands, [
    { geometry: { type: 'Point', coordinates: [-66.8007, 18.4882] }, properties: { key: 'homedepot', name: 'The Home Depot', 'addr:street_address': 'Km 84.3 - Rd. Pr 2', 'addr:city': 'Hatillo', 'addr:state': 'PR', census: [18.46047, -66.77791] } },
  ]);
  assert.equal(out.counts.homedepot, 1);
  assert.deepEqual(out.added, {});
  assert.deepEqual([out.stores[0][1], out.stores[0][2]], [18.48939, -66.79108]);
});

test('local shops: the hand-checked list is valid and each entry is checked', () => {
  const shops = loadLocalShops(JSON.parse(readFileSync(new URL('../local-shops/shops.json', import.meta.url), 'utf8')));
  assert.ok(shops.length >= 20);
  for (const s of shops) assert.ok(s.source.startsWith('https://') && s.checked.length === 10, s.name);
  const good = { osm: 'n1', name: 'Joe\'s Diner', category: 'Food and Restaurants', offer: '10% off with military ID', source: 'https://joesdiner.example.com/military', quote: '10% off for military', checked: '2026-11-27', lat: 39.8, lon: -89.6, label: '1 Main Street, Springfield, IL' };
  assert.equal(loadLocalShops({ shops: [good] }).length, 1);
  assert.throws(() => loadLocalShops({ shops: [good, good] }), /listed twice/);
  assert.throws(() => loadLocalShops({ shops: [{ ...good, osm: '123' }] }), /bad osm id/);
  assert.throws(() => loadLocalShops({ shops: [{ ...good, category: 'Food' }] }), /unknown category/);
  assert.throws(() => loadLocalShops({ shops: [{ ...good, category: 'Restaurants' }] }), /unknown category/);
  assert.throws(() => loadLocalShops({ shops: [{ ...good, name: "Joe's Guns" }] }), /firearms/);
  assert.throws(() => loadLocalShops({ shops: [{ ...good, quote: '10% off ammo for military' }] }), /firearms/);
  assert.equal(loadLocalShops({ shops: [{ ...good, offer: '10% off Black Rifle Coffee drinks' }] }).length, 1);
  assert.throws(() => loadLocalShops({ shops: [{ ...good, source: 'http://joesdiner.example.com' }] }), /https/);
  assert.throws(() => loadLocalShops({ shops: [{ ...good, quote: '' }] }), /required/);
  assert.throws(() => loadLocalShops({ shops: [{ ...good, lat: 51.5, lon: -0.1 }] }), /outside/);
  const q = localQuery([good, { ...good, osm: 'w22' }, { ...good, osm: 'n3' }]);
  assert.match(q, /node\(id:1,3\);/);
  assert.match(q, /way\(id:22\);/);
  assert.doesNotMatch(q, /relation/);
});

test('local shops leave the map when closed, renamed, gone from OpenStreetMap or the offer page stops showing it', () => {
  const shop = (osm, name) => ({ osm, name, category: 'Food and Restaurants', offer: '10% off', source: 'https://x.example.com', quote: 'q', checked: '2026-11-27', lat: 21.3, lon: -157.8, label: 'Honolulu, HI' });
  const shops = [shop('n1', 'Big City Diner'), shop('w2', 'Kualoa Ranch'), shop('n3', 'Ocean Grill'), shop('n4', 'Surf Shack'), shop('n5', 'Lava Tattoo'), shop('n6', 'Moved Away'), shop('n7', 'Island Outfitters')];
  const elements = [
    { type: 'node', id: 1, lat: 21.4, lon: -157.74, tags: { amenity: 'restaurant', name: 'Big City Diner' } },
    { type: 'way', id: 2, center: { lat: 21.52, lon: -157.84 }, tags: { tourism: 'attraction', name: 'Kualoa Ranch Hawaii' } },
    { type: 'node', id: 3, lat: 21.3, lon: -157.8, tags: { 'disused:amenity': 'restaurant', name: 'Ocean Grill' } },
    { type: 'node', id: 4, lat: 21.3, lon: -157.8, tags: { amenity: 'restaurant', name: 'Poke Bar' } },
    { type: 'node', id: 5, lat: 21.3, lon: -157.8, tags: { shop: 'tattoo', name: 'Lava Tattoo' } },
    { type: 'node', id: 7, lat: 21.3, lon: -157.8, tags: { shop: 'weapons', name: 'Island Outfitters' } },
  ];
  const status = { checked: '2026-12-27', shops: { n5: { seen: '2026-10-27', misses: 2 }, n1: { seen: '2026-11-27', misses: 1 } } };
  const { rows, dropped } = localRows(shops, elements, status);
  assert.deepEqual(rows.map((r) => r[2]), ['Big City Diner', 'Kualoa Ranch']);
  // Positions come from OpenStreetMap (a way's center), not the saved ones.
  assert.deepEqual(rows[0].slice(0, 2), [21.4, -157.74]);
  assert.deepEqual(rows[1].slice(0, 2), [21.52, -157.84]);
  assert.equal(rows[0].length, 8);
  // The date shown is the last time the offer was seen on the shop's page, if that's later.
  const shop2 = { ...shop('n1', 'Big City Diner'), checked: '2026-11-01' };
  assert.equal(localRows([shop2], null, { shops: { n1: { seen: '2026-12-02', misses: 0 } } }).rows[0][7], '2026-12-02');
  assert.equal(localRows([shop2], null, { shops: { n1: { seen: '2026-10-02', misses: 0 } } }).rows[0][7], '2026-11-01');
  assert.equal(localRows([shop2], null, { shops: { n1: { seen: 'soon', misses: 0 } } }).rows[0][7], '2026-11-01');
  assert.equal(dropped.length, 5);
  assert.match(dropped.find((d) => d.startsWith('Island Outfitters')), /gun shop/);
  assert.match(dropped.find((d) => d.startsWith('Ocean Grill')), /marked closed/);
  assert.match(dropped.find((d) => d.startsWith('Surf Shack')), /Poke Bar/);
  assert.match(dropped.find((d) => d.startsWith('Lava Tattoo')), /no longer on its website/);
  assert.match(dropped.find((d) => d.startsWith('Moved Away')), /no longer on OpenStreetMap/);
  // If the OpenStreetMap download failed, the saved positions are used and only the offer check applies.
  const offline = localRows(shops, null, status);
  assert.equal(offline.rows.length, 6);
  assert.deepEqual(offline.rows.find((r) => r[2] === 'Big City Diner').slice(0, 2), [21.3, -157.8]);
});
