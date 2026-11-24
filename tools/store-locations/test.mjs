// Tests for build.mjs. Run: node --test tools/store-locations/test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildQuery, guardAgainstDrops, isClosed, labelFor, loadBrands, toStores, brandFor } from './build.mjs';

const brands = loadBrands(JSON.parse(readFileSync(new URL('./brands.json', import.meta.url), 'utf8')));
const idx = (key) => brands.findIndex((b) => b.key === key);

test('brands.json is valid and every brand points at deals', () => {
  assert.ok(brands.length >= 30);
  for (const b of brands) assert.ok(b.deals.length > 0);
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
