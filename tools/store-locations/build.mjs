#!/usr/bin/env node
/**
 * Builds data/locations.json: store locations for the app's "Near me" map.
 *
 * Where the data comes from: OpenStreetMap (OSM), through the free Overpass API. We ask for
 * places tagged with each chain's brand (brands.json), in the 50 states, DC, Puerto Rico,
 * Guam, the U.S. Virgin Islands, American Samoa and the Northern Mariana Islands.
 *
 * License: OSM data is © OpenStreetMap contributors under the Open Database License (ODbL 1.0).
 * The output file is a "derivative database", so it is published under the ODbL too and
 * carries that notice inside it. The app shows "© OpenStreetMap contributors" on the map.
 *
 * Privacy: this runs on GitHub's servers once a month. Phones download the finished file
 * as one nationwide list, so no phone ever tells anyone where it is to get its stores.
 *
 * Usage:
 *   node tools/store-locations/build.mjs                 # download from Overpass, write data/locations.json
 *   node tools/store-locations/build.mjs --input raw.json  # use a saved Overpass response instead
 *   node tools/store-locations/build.mjs --save-raw raw.json  # also keep the raw response
 *   node tools/store-locations/build.mjs --dry-run       # print the summary, don't write
 *   node tools/store-locations/build.mjs --fill          # only download chains the last run missed
 *
 * No npm packages needed (Node 22+).
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(ROOT, 'data', 'locations.json');
const BRANDS_FILE = join(HERE, 'brands.json');
/** Which chains the last run couldn't download (or got from an out-of-date server); filled in daily. */
const STATUS = join(ROOT, 'data', 'locations-status.json');
/** A server whose map data is older than this is a stale copy; its answers are not used. */
const MAX_DATA_AGE_DAYS = 14;

/** Public Overpass servers, tried in order. Both are free and need no key. */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
/** If more than this share of chains can't be downloaded, give up and publish nothing. */
const MAX_FAILED_SHARE = 0.25;

/** The public servers were too busy this time. With --soft-fail-days, this isn't an error (see main). */
class RetryLater extends Error {}

/** Chains still missing from the published list, from the status file. */
function missingChains() {
  try {
    const m = JSON.parse(readFileSync(STATUS, 'utf8')).missing;
    return Array.isArray(m) ? m.filter((k) => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

/** Days since the published file was made, or Infinity if there isn't one. */
function fileAgeDays() {
  if (!existsSync(OUT)) return Infinity;
  try {
    const generated = JSON.parse(readFileSync(OUT, 'utf8')).generated;
    const ms = Date.parse(`${generated}T00:00:00Z`);
    return Number.isFinite(ms) ? (Date.now() - ms) / 86_400_000 : Infinity;
  } catch {
    return Infinity;
  }
}
const USER_AGENT = 'ArmedForcesPerks-store-locations/1.0 (+https://armedforcesperks.com; monthly job)';

/** Two places of the same chain closer than this are the same store mapped twice. */
const DUPLICATE_METERS = 80;
/** A brand that shrinks by more than half since last month is more likely an OSM edit mistake than real closures. */
const BRAND_DROP_LIMIT = 0.5;
/** If the whole list shrinks this much, something went wrong: stop and publish nothing. */
const TOTAL_DROP_LIMIT = 0.6;
const MAX_LABEL = 90;

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const DRY_RUN = args.includes('--dry-run');

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------

export function loadBrands(raw) {
  const list = raw?.brands;
  if (!Array.isArray(list) || list.length === 0) throw new Error('brands.json has no brands');
  const keys = new Set();
  return list.map((b, i) => {
    const where = `brands[${i}] (${b?.key})`;
    if (!b || typeof b.key !== 'string' || !/^[a-z0-9]+$/.test(b.key)) throw new Error(`${where}: bad key`);
    if (keys.has(b.key)) throw new Error(`${where}: duplicate key`);
    keys.add(b.key);
    if (typeof b.name !== 'string' || !b.name.trim()) throw new Error(`${where}: missing name`);
    // Deals may be empty: the build looks deals up by name each run (a chain with no current
    // deal is still downloaded, so it appears as soon as its deal is back in the sheet).
    if (!Array.isArray(b.deals) || !b.deals.every((d) => /^AFP-\d{4,}$/.test(d))) {
      throw new Error(`${where}: deals must be AFP-#### IDs`);
    }
    const m = b.match ?? {};
    const hasWd = typeof m.wikidata === 'string';
    const hasBrand = typeof m.brand === 'string';
    if (hasWd === hasBrand) throw new Error(`${where}: match needs exactly one of wikidata or brand`);
    if (hasWd && !/^Q\d+$/.test(m.wikidata)) throw new Error(`${where}: bad Wikidata ID`);
    if (hasBrand && /["\\]/.test(m.brand)) throw new Error(`${where}: brand text can't contain quotes`);
    const exclude = b.excludeName ? new RegExp(b.excludeName, 'i') : null;
    // Extra names to leave out of the chain's own store-locator data (e.g. Take 5 Car Wash).
    const locatorExclude = b.locatorExcludeName ? new RegExp(b.locatorExcludeName, 'i') : null;
    const req = b.requireTag && typeof b.requireTag === 'object' ? Object.entries(b.requireTag) : [];
    let listed = null;
    if (b.onlyListed !== undefined) {
      if (typeof b.onlyListed !== 'string' || !/^participating\/[a-z0-9-]+\.json$/.test(b.onlyListed)) throw new Error(`${where}: bad onlyListed`);
      listed = loadListed(JSON.parse(readFileSync(join(HERE, b.onlyListed), 'utf8')), where);
    }
    return {
      key: b.key,
      name: b.name.trim(),
      deals: b.deals,
      participating: b.participating === true,
      wikidata: hasWd ? m.wikidata : null,
      brand: hasBrand ? m.brand : null,
      exclude,
      locatorExclude,
      requireTag: req,
      listed,
      /** Other names the deal sheet may use for this business, e.g. "Regal Cinemas". */
      dealNames: Array.isArray(b.dealNames) ? b.dealNames.filter((n) => typeof n === 'string') : [],
    };
  });
}

/** U.S. states and DC, plus Puerto Rico, Guam, the Virgin Islands, American Samoa, Northern Marianas. */
const AREAS = ['US', 'PR', 'GU', 'VI', 'AS', 'MP'];

/**
 * One small query per chain. (A single query for every chain at once is too heavy for the
 * public servers: it timed out with 504 errors.)
 */
export function buildQuery(brand) {
  const lines = brand.wikidata
    ? [`  nwr["brand:wikidata"="${brand.wikidata}"](area.us);`]
    : [`  nwr["brand"="${brand.brand}"](area.us);`, `  nwr["name"="${brand.brand}"](area.us);`];
  return [
    '[out:json][timeout:180];',
    '(',
    ...AREAS.map((c) => `  area["ISO3166-1"="${c}"]["boundary"="administrative"];`),
    ')->.us;',
    '(',
    ...lines,
    ');',
    'out center tags;',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Turning OSM elements into store rows
// ---------------------------------------------------------------------------

const FEATURE_KEYS = ['shop', 'amenity', 'leisure', 'office', 'tourism', 'craft', 'healthcare'];
const LIFECYCLE = /^(disused|abandoned|demolished|removed|razed|destroyed|construction|proposed|planned):/;

/** True if OSM says this place is closed, empty or not built yet. */
export function isClosed(tags) {
  if (!FEATURE_KEYS.some((k) => typeof tags[k] === 'string' && tags[k] !== 'vacant')) return true;
  if (Object.keys(tags).some((k) => LIFECYCLE.test(k) && FEATURE_KEYS.includes(k.split(':')[1]))) return true;
  if (/^(closed|off)$/i.test(tags.opening_hours ?? '')) return true;
  if (/\b(permanently )?closed\b/i.test(tags.name ?? '')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Participating-locations lists (e.g. Regal's military pricing is only at listed theatres)
// ---------------------------------------------------------------------------

const STATES = {
  alabama: 'AL', alaska: 'AK', 'american samoa': 'AS', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA', guam: 'GU', hawaii: 'HI',
  idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME',
  maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', 'northern mariana islands': 'MP', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'puerto rico': 'PR', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', 'virgin islands': 'VI', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};

function stateCode(v) {
  const t = String(v ?? '').trim();
  if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase();
  return STATES[t.toLowerCase()] ?? '';
}

/** Lowercase letters/digits only, with "Fort"/"Ft", "Mount"/"Mt" and "Saint"/"St" made the same. */
function placeKey(v) {
  return String(v ?? '')
    .toLowerCase()
    .replace(/\bft\b\.?/g, 'fort')
    .replace(/\bmt\b\.?/g, 'mount')
    .replace(/\bst\b\.?/g, 'saint')
    .replace(/[^a-z0-9]/g, '');
}

/** The part of a theatre name that tells it apart: "Regal Edwards Aliso Viejo & RPX" -> "alisoviejo". */
export function theatreKey(name) {
  const key = baseTheatreKey(name, true);
  // "Regal Cinema 99": nothing left once the generic words go, so keep the number.
  return key || baseTheatreKey(name, false).replace(/cinemas?/g, '');
}

function baseTheatreKey(name, dropNumbers) {
  const s = String(name ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\ban amc theatre\b/g, ' ')
    .replace(/\bdine-?\s?in\b/g, ' ')
    .replace(/@.*$/, ' ')
    .replace(/\b(amc|classic|regal|cinemas?|edwards|ua|united artists|cinebarre|rpx|imax|4dx|screenx|stadium|luxury|theatres?|theaters?|movies?)\b/g, ' ')
    .replace(/\band\b/g, ' ');
  return (dropNumbers ? s.replace(/\b\d+\b/g, ' ') : s).replace(/[^a-z0-9]/g, '');
}

function loadListed(raw, where) {
  if (!raw || !Array.isArray(raw.theatres) || raw.theatres.length === 0) throw new Error(`${where}: participating list is empty`);
  return raw.theatres.map(([state, city, name, aliases], i) => {
    // Other names OSM uses for the same theatre, e.g. "Galleria at Tyler" for "Tyler Galleria".
    const keys = [name, ...(Array.isArray(aliases) ? aliases : [])].map(theatreKey).filter(Boolean);
    // City may be blank when the business lists theatres by state only (AMC).
    if (!/^[A-Z]{2}$/.test(state) || typeof city !== 'string' || !keys.length) throw new Error(`${where}: participating entry ${i} is incomplete`);
    return { state, city: placeKey(city), keys, name };
  });
}

/**
 * True if an OSM place is one of the listed locations.
 *  1. By name: the OSM name matches a listed theatre name (or alias). Where OSM gives a state,
 *     it must match. Short names ("orange") must match exactly unless the state is known, and
 *     must also be in the listed city when OSM gives one.
 *  2. By place, for OSM theatres with only a generic name ("AMC", "Regal Cinemas"): OSM must
 *     give the state and city, and a listed theatre in that state must be in that city or be
 *     named after it ("AMC Porter Ranch 9" in Porter Ranch).
 */
export function onList(tags, list) {
  const names = [tags.name, tags.official_name, tags.alt_name, tags.old_name, tags.branch].filter(Boolean).map(theatreKey).filter((k) => k.length >= 2);
  const state = stateCode(tags['addr:state']);
  const city = placeKey(tags['addr:city']);
  const byName = list.some((e) => {
    if (state && state !== e.state) return false;
    return e.keys.some((key) => {
      const partialOk = Boolean(state) || key.length >= 8;
      const hit = names.some((n) => n === key || (partialOk && (n.includes(key) || (key.includes(n) && n.length >= 5))));
      if (!hit) return false;
      // A short name in another city (e.g. "Regal Augusta" in Maine vs Georgia) needs the city to match.
      if (key.length >= 8 || !e.city || !city) return true;
      return city === e.city || city.includes(e.city) || e.city.includes(city);
    });
  });
  if (byName) return true;
  if (!state || city.length < 4) return false;
  // Only for generic names: a theatre with its own name that didn't match is not on the list.
  if (names.some((n) => n.length >= 4)) return false;
  return list.some((e) => e.state === state && (e.city === city || e.keys.some((k) => k === city || (city.length >= 5 && k.startsWith(city)))));
}

export function brandFor(tags, brands) {
  for (const b of brands) {
    if (b.wikidata) {
      if (tags['brand:wikidata'] !== b.wikidata) continue;
    } else if (tags['brand:wikidata'] && tags.brand !== b.brand) {
      // A place tagged as a different brand that only happens to share the name.
      continue;
    } else if (tags.brand !== b.brand && tags.name !== b.brand) {
      continue;
    }
    if (b.requireTag.some(([k, v]) => tags[k] !== v)) continue;
    if (b.exclude && (b.exclude.test(tags.name ?? '') || b.exclude.test(tags.branch ?? ''))) continue;
    if (b.listed && !onList(tags, b.listed)) return { notListed: true };
    return b;
  }
  return null;
}

function clean(s) {
  return typeof s === 'string' ? s.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

/** "1234 Main St, Springfield, IL", or the branch name, or "". */
export function labelFor(tags) {
  const street = [clean(tags['addr:housenumber']), clean(tags['addr:street'])].filter(Boolean).join(' ');
  const city = clean(tags['addr:city']);
  const state = clean(tags['addr:state']);
  const parts = [street, city, state].filter(Boolean);
  let label = parts.length >= 2 || street ? parts.join(', ') : '';
  if (!label) label = clean(tags.branch) || (city ? [city, state].filter(Boolean).join(', ') : '');
  return label.length > MAX_LABEL ? label.slice(0, MAX_LABEL - 1).trimEnd() + '…' : label;
}

function coordsOf(el) {
  const lat = el.type === 'node' ? el.lat : el.center?.lat;
  const lon = el.type === 'node' ? el.lon : el.center?.lon;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  // Rough box around the U.S. and its territories (Guam and the Marianas are east of 140°E).
  const inRange = lat > -15 && lat < 72 && ((lon > -180 && lon < -64) || (lon > 140 && lon <= 180));
  return inRange ? [Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5] : null;
}

function meters(a, b) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toRad;
  const dLon = (b[1] - a[1]) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Returns { stores: [[brandIndex, lat, lon, label]], counts: {key: n}, skipped: {...} }. */
export function toStores(elements, brands) {
  const byBrand = new Map(brands.map((b) => [b.key, []]));
  const skipped = { closed: 0, noBrand: 0, noCoords: 0, duplicate: 0, notListed: 0 };
  const notListedNames = [];
  for (const el of elements) {
    const tags = el.tags ?? {};
    const brand = brandFor(tags, brands);
    if (!brand) {
      skipped.noBrand++;
      continue;
    }
    if (brand.notListed) {
      skipped.notListed++;
      if (notListedNames.length < 200) notListedNames.push([tags.name, tags['addr:city'], tags['addr:state']].filter(Boolean).join(', ') || '(no name)');
      continue;
    }
    if (isClosed(tags)) {
      skipped.closed++;
      continue;
    }
    const at = coordsOf(el);
    if (!at) {
      skipped.noCoords++;
      continue;
    }
    const list = byBrand.get(brand.key);
    const label = labelFor(tags);
    const dup = list.find((s) => meters(s.at, at) < DUPLICATE_METERS);
    if (dup) {
      skipped.duplicate++;
      // Keep whichever copy has the better address.
      if (!dup.label && label) dup.label = label;
      continue;
    }
    list.push({ at, label });
  }
  const stores = [];
  const counts = {};
  brands.forEach((b, i) => {
    const list = byBrand.get(b.key).sort((x, y) => x.at[0] - y.at[0] || x.at[1] - y.at[1]);
    counts[b.key] = list.length;
    for (const s of list) stores.push([i, s.at[0], s.at[1], s.label]);
  });
  return { stores, counts, skipped, notListedNames };
}

// ---------------------------------------------------------------------------
// Safety checks against last month's file
// ---------------------------------------------------------------------------

/**
 * If a brand shrank by more than half (usually someone's OSM mistake, or Overpass returning
 * partial data), keep last month's stores for that brand instead. Returns the merged rows.
 */
// ---------------------------------------------------------------------------
// Filling gaps from each chain's own store locator (All the Places)
// ---------------------------------------------------------------------------

/** Same store if the locator's pin is this close to an OpenStreetMap one. */
const SAME_STORE_METERS = 300;
/** ...or within this distance AND the same street number and street (one pin is off). */
const SAME_ADDRESS_METERS = 10000;
/** A pin this far from where its street address geocodes is treated as misplaced. */
const PIN_CHECK_METERS = 1000;
/** ...or within this distance when the OSM store has no street address to compare. */
const NO_ADDRESS_METERS = 1500;

const DIRECTIONS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest']);

/**
 * "1601 Walden Avenue, ..." -> "1601 wal": house number + the first 3 letters of the street
 * name, so "SW 27th Ave" = "Southwest 27th Avenue" and "E.Basse" = "East Basse Road".
 * Hawaii-style numbers ("98-1005") are kept whole. '' when there's no street number.
 */
export function addressKey(label) {
  const words = String(label ?? '').split(',')[0].toLowerCase().replace(/[.#]/g, ' ').split(/\s+/).filter(Boolean);
  const num = /^(\d+(?:-\d+)?)[a-z]?$/.exec(words[0] ?? '');
  if (!num) return '';
  let i = 1;
  while (i < words.length - 1 && (DIRECTIONS.has(words[i]) || (words[i] === 'north' && words[i + 1] === 'west'))) i++;
  const street = (words[i] ?? '').replace(/[^a-z0-9]/g, '');
  return street ? `${num[1]} ${street.slice(0, 3)}` : '';
}

/** "MOSES LAKE" -> "Moses Lake", "3930 N STOCKTON HILL RD, Suite 5" -> "3930 N Stockton Hill Rd, Suite 5". */
function tidyCase(s) {
  if (!s) return s;
  return s
    .replace(/\b[A-Z][A-Z']{2,}\b|\b(?:RD|ST|DR|LN|CT|AV|PL|SQ)\b/g, (w) => w[0] + w.slice(1).toLowerCase())
    .replace(/\bO'([a-z])/g, (_, c) => `O'${c.toUpperCase()}`);
}

/** Store label from a locator entry: "4180 Union Rd, Cheektowaga, NY". */
export function locatorLabel(p) {
  const street = clean(p['addr:street_address']) || clean(String(p['addr:full'] ?? '').split(',')[0]);
  const parts = [tidyCase(street), tidyCase(clean(p['addr:city'])), clean(p['addr:state']).toUpperCase().slice(0, 2)].filter(Boolean);
  const label = parts.join(', ');
  return label.length > MAX_LABEL ? label.slice(0, MAX_LABEL - 1).trimEnd() + '…' : label;
}

/**
 * Adds stores that OpenStreetMap is missing, from each chain's own store locator as collected
 * by All the Places (alltheplaces.xyz, CC0). A locator store counts as already on the map if an
 * OSM store of the same chain is within 300 m, or within 3 km at the same street address; then
 * the OSM pin is kept (it's usually drawn on the building itself). Chains with no locator data
 * this month are left as they are.
 */
export function addFromLocators(built, brands, features) {
  const byKey = new Map();
  for (const f of features ?? []) {
    const p = f?.properties ?? {};
    const c = f?.geometry?.coordinates;
    if (!Array.isArray(c) || typeof c[0] !== 'number' || typeof c[1] !== 'number') continue;
    const at = coordsOf({ type: 'node', lat: c[1], lon: c[0] });
    if (!at) continue;
    // Where the U.S. Census Bureau geocoder puts the street address (see atp-extract.py).
    const cz = Array.isArray(p.census) ? coordsOf({ type: 'node', lat: p.census[0], lon: p.census[1] }) : null;
    if (!byKey.has(p.key)) byKey.set(p.key, []);
    byKey.get(p.key).push({ at, p, census: cz });
  }
  const rows = new Map(brands.map((b) => [b.key, []]));
  for (const r of built.stores) rows.get(brands[r[0]].key).push(r);
  const added = {};
  const moved = [];
  const skippedNotListed = [];
  brands.forEach((b, i) => {
    const list = rows.get(b.key);
    const osm = list.map((r) => ({ at: [r[1], r[2]], addr: addressKey(r[3]), row: r }));
    let n = 0;
    for (const { at: locatorAt, p, census } of byKey.get(b.key) ?? []) {
      // A locator pin far from where its own street address is: trust the address.
      const at = census && meters(locatorAt, census) > PIN_CHECK_METERS ? census : locatorAt;
      const name = clean(p.name);
      if (b.exclude && (b.exclude.test(name) || b.exclude.test(clean(p.branch)))) continue;
      if (b.locatorExclude && b.locatorExclude.test(name)) continue;
      if (b.listed && !onList({ name, branch: p.branch, 'addr:city': p['addr:city'], 'addr:state': p['addr:state'] }, b.listed)) {
        if (skippedNotListed.length < 200) skippedNotListed.push(`${name}, ${p['addr:city'] ?? ''}`);
        continue;
      }
      const label = locatorLabel(p);
      const addr = addressKey(label);
      const known = osm.find((o) => {
        const d = meters(o.at, at);
        if (d <= SAME_STORE_METERS) return true;
        // Same street address: the same store, with one of the two pins a bit off.
        if (d <= SAME_ADDRESS_METERS && addr && o.addr === addr) return true;
        // An OSM store with no address can't be compared that way; nearby counts as the same.
        return d <= NO_ADDRESS_METERS && !o.addr;
      });
      if (known) {
        // The OSM store has no address: show the locator's.
        if (known.row && !known.row[3] && label) {
          known.row[3] = label;
          known.addr = addr;
        }
        // Same store, pins far apart: if the address agrees with the locator, the OSM pin is the
        // one that's off, so move it.
        if (known.row && census && meters(known.at, census) > PIN_CHECK_METERS && meters(at, census) <= SAME_STORE_METERS) {
          moved.push(`${b.name}, ${known.row[3] || label}: moved ${(meters(known.at, at) / 1609.34).toFixed(1)} mi`);
          known.row[1] = at[0];
          known.row[2] = at[1];
          known.at = at;
        }
        continue;
      }
      osm.push({ at, addr }); // also stops the locator's own duplicates
      list.push([i, at[0], at[1], label]);
      n++;
    }
    if (n) added[b.key] = n;
  });
  const stores = [];
  const counts = {};
  brands.forEach((b) => {
    const list = rows.get(b.key).sort((x, y) => x[1] - y[1] || x[2] - y[2]);
    counts[b.key] = list.length;
    stores.push(...list);
  });
  return { ...built, stores, counts, added, moved, locatorNotListed: skippedNotListed };
}

export function guardAgainstDrops(result, brands, previous, failed = new Set(), quiet = new Set()) {
  const warnings = [...[...failed].filter((k) => !quiet.has(k)).map((k) => `${brands.find((b) => b.key === k)?.name ?? k}: download failed, kept last month's stores.`)];
  if (!previous || !Array.isArray(previous.brands) || !Array.isArray(previous.stores)) return { ...result, warnings };
  const prevIndex = new Map(previous.brands.map((b, i) => [i, b.key]));
  const prevByKey = new Map();
  for (const row of previous.stores) {
    const key = prevIndex.get(row[0]);
    if (!key) continue;
    if (!prevByKey.has(key)) prevByKey.set(key, []);
    prevByKey.get(key).push(row);
  }
  const prevTotal = previous.stores.length;
  const newTotal = result.stores.length;
  if (!failed.size && prevTotal >= 500 && newTotal < prevTotal * TOTAL_DROP_LIMIT) {
    throw new Error(`Store count fell from ${prevTotal} to ${newTotal}. Not publishing; check Overpass and OSM.`);
  }
  const keep = new Set();
  for (const b of brands) {
    const before = prevByKey.get(b.key)?.length ?? 0;
    const now = result.counts[b.key] ?? 0;
    if (failed.has(b.key)) {
      keep.add(b.key);
    } else if (before >= 20 && now < before * BRAND_DROP_LIMIT) {
      keep.add(b.key);
      warnings.push(`${b.name}: ${before} → ${now} stores. Kept last month's ${before} instead; check OSM.`);
    } else if (before > 0 && now === 0) {
      warnings.push(`${b.name}: no stores found this time (had ${before}).`);
    } else if (now === 0) {
      warnings.push(`${b.name}: no stores found in OSM.`);
    }
  }
  if (!keep.size) return { ...result, warnings };
  const stores = [];
  const counts = { ...result.counts };
  brands.forEach((b, i) => {
    if (keep.has(b.key)) {
      const rows = prevByKey.get(b.key) ?? [];
      for (const r of rows) stores.push([i, r[1], r[2], r[3]]);
      counts[b.key] = rows.length;
    } else {
      for (const r of result.stores) if (r[0] === i) stores.push(r);
    }
  });
  return { stores, counts, skipped: result.skipped, warnings };
}

/** Business name reduced for comparing ("The Home Depot" = "Home Depot", "&" = "and"). Same rule as the app. */
export function businessKey(name) {
  return String(name).toLowerCase().replace(/&/g, 'and').replace(/^the\s+/, '').replace(/[^a-z0-9]/g, '');
}

/** Maps chain key -> current deal IDs, found by business name in data/deals.json. */
export function matchDeals(brands, deals) {
  const out = new Map();
  for (const b of brands) {
    const names = new Set([b.name, ...(b.dealNames ?? [])].map(businessKey));
    out.set(b.key, deals.filter((d) => names.has(businessKey(d.name))).map((d) => d.id));
  }
  return out;
}

function currentDealIds(brands, warnings) {
  const path = join(ROOT, 'data', 'deals.json');
  if (!existsSync(path)) return new Map();
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const map = matchDeals(brands, Array.isArray(raw) ? raw : raw.deals ?? []);
  for (const b of brands) {
    if (!map.get(b.key).length) warnings.push(`${b.name}: no deal with this name in data/deals.json, so the app won't show these stores.`);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Progress lines, also kept for the run report. */
const progress = [];
function log(line) {
  console.log(line);
  progress.push(line);
  // Keep the report file current, so a run that's stopped part way still shows how far it got.
  const reportFile = argValue('--report');
  if (reportFile) writeFileSync(reportFile, ['## Store locations: still downloading (or stopped)', '', '```', ...progress, '```', ''].join('\n'));
}

/** Tries each server once. Failed chains get one more round at the end (see main). */
/** The server that answered last is asked first next time, so one slow server doesn't cost every chain minutes. */
let preferred = 0;
/** Servers found serving out-of-date map data this run; skipped from then on. */
const staleHosts = new Set();
/** Oldest map-data date of the answers used (so the file never claims fresher data than it has). */
let oldestOsmBase = null;
async function overpass(query) {
  const errors = [];
  const order = [...ENDPOINTS.slice(preferred), ...ENDPOINTS.slice(0, preferred)];
  for (const url of order) {
    const host = new URL(url).host;
    if (staleHosts.has(host)) continue;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(200_000),
      });
      if (!res.ok) throw new Error(`answered ${res.status}`);
      const json = await res.json();
      if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) throw new Error(json.remark.slice(0, 120));
      if (!Array.isArray(json.elements)) throw new Error('no elements in answer');
      const base = json.osm3s?.timestamp_osm_base;
      const baseMs = typeof base === 'string' ? Date.parse(base) : NaN;
      if (Number.isFinite(baseMs) && Date.now() - baseMs > MAX_DATA_AGE_DAYS * 86_400_000) {
        staleHosts.add(host);
        throw new Error(`its map data is from ${base.slice(0, 10)} (out of date; not using this server again this run)`);
      }
      if (typeof base === 'string' && (!oldestOsmBase || base < oldestOsmBase)) oldestOsmBase = base;
      preferred = ENDPOINTS.indexOf(url);
      return { json, host };
    } catch (e) {
      errors.push(`${host}: ${e.message}`);
      console.warn(`  ${host} failed: ${e.message}`);
      // Be polite: wait before asking the next server (longer if we were told to slow down).
      await sleep(/429/.test(e.message) ? 60_000 : 15_000);
    }
  }
  throw new Error(errors.join('; '));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // --if-older-than N: the daily schedule only does a real run once the list is N days old.
  // Until then, it only fills in chains the last run couldn't get (from data/locations-status.json).
  // --fill does that on demand.
  const minAge = Number(argValue('--if-older-than') ?? 0);
  let fill = args.includes('--fill') && existsSync(OUT);
  if (minAge > 0 && fileAgeDays() < minAge) {
    if (!missingChains().length || !existsSync(OUT)) {
      console.log(`The store list is under ${minAge} days old and complete. Nothing to do today.`);
      return;
    }
    fill = true;
  }
  // --should-run: only say whether today's run has anything to do (for the workflow).
  if (args.includes('--should-run')) {
    const run = !(minAge > 0 && fileAgeDays() < minAge && (!missingChains().length || !existsSync(OUT)));
    console.log(`run=${run}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
    return;
  }
  const allBrands = loadBrands(JSON.parse(readFileSync(BRANDS_FILE, 'utf8')));
  // --only a,b,c: a quick trial with a few chains (pull requests use this). Never publishes.
  const only = argValue('--only')?.split(',').filter(Boolean);
  if (only && !DRY_RUN) throw new Error('--only is for trial runs; add --dry-run.');
  const brands = only ? allBrands.filter((b) => only.includes(b.key)) : allBrands;
  // Fill-in run: download only the missing chains and keep everything else as published.
  const toFetch = fill ? brands.filter((b) => missingChains().includes(b.key)) : brands;
  if (fill) log(`Filling in ${toFetch.length} chain(s) missing from the last run: ${toFetch.map((b) => b.name).join(', ') || 'none'}.`);
  if (only && brands.length !== only.length) throw new Error(`Unknown chain in --only: ${only.join(', ')}`);
  const input = argValue('--input');
  let raw;
  const failed = new Set();
  if (input) {
    raw = JSON.parse(readFileSync(input, 'utf8'));
  } else {
    const seen = new Set();
    raw = { elements: [], osm3s: null };
    let streak = 0;
    let pauses = 0;
    // Stop starting new chains after this many minutes (the job has a hard limit). Chains not
    // reached count as failed, so they keep last month's stores.
    const budgetMin = Number(argValue('--budget-min') ?? 0);
    const deadline = budgetMin > 0 ? Date.now() + budgetMin * 60_000 : Infinity;
    const outOfTime = (b, label) => {
      if (Date.now() < deadline) return false;
      failed.add(b.key);
      log(`${label} ${b.name}: SKIPPED (out of time)`);
      return true;
    };
    const fetchChain = async (b, label) => {
      const started = Date.now();
      try {
        const { json, host } = await overpass(buildQuery(b));
        let n = 0;
        for (const el of json.elements) {
          const id = `${el.type}/${el.id}`;
          if (seen.has(id)) continue;
          seen.add(id);
          raw.elements.push(el);
          n++;
        }
        raw.osm3s ??= json.osm3s;
        failed.delete(b.key);
        streak = 0;
        pauses = 0;
        log(`${label} ${b.name}: ${n} places (${host}, ${Math.round((Date.now() - started) / 1000)}s)`);
      } catch (e) {
        failed.add(b.key);
        streak++;
        log(`${label} ${b.name}: FAILED after ${Math.round((Date.now() - started) / 1000)}s (${e.message})`);
        // Three chains in a row failing on every server means the servers are down: stop instead of waiting for hours.
        // Three chains in a row failing on every server: the servers are overloaded. Give them a
        // few minutes; after three such pauses with nothing working, give up for today.
        if (streak >= 3) {
          if (++pauses >= 3) throw new RetryLater('Overpass servers are not answering. Not publishing; the next run will try again.');
          log(`Servers look overloaded. Waiting 5 minutes (pause ${pauses} of 2)…`);
          streak = 0;
          await sleep(5 * 60_000);
        }
      }
      await sleep(3000); // one request at a time, with a pause, per Overpass's usage policy
    };
    for (const [i, b] of toFetch.entries()) if (!outOfTime(b, `${i + 1}/${toFetch.length}`)) await fetchChain(b, `${i + 1}/${toFetch.length}`);
    // One more try for chains that failed (servers are often only briefly busy).
    if (failed.size && Date.now() + 60_000 < deadline) {
      streak = 0;
      await sleep(60_000);
      for (const b of toFetch.filter((x) => failed.has(x.key))) if (!outOfTime(b, 'retry')) await fetchChain(b, 'retry');
    }
    if (!fill && failed.size > brands.length * MAX_FAILED_SHARE) {
      throw new RetryLater(`${failed.size} of ${brands.length} chains failed to download. Not publishing; the next run will try again.`);
    }
    const saveRaw = argValue('--save-raw');
    if (saveRaw) writeFileSync(saveRaw, JSON.stringify(raw));
  }
  const base = oldestOsmBase ?? raw.osm3s?.timestamp_osm_base;
  let osmDate = typeof base === 'string' ? base.slice(0, 10) : null;

  const previous = !only && existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
  // --atp file: stores from each chain's own locator (All the Places), to fill OSM's gaps.
  const atpFile = argValue('--atp');
  let atp = null;
  if (atpFile && existsSync(atpFile)) {
    try {
      atp = JSON.parse(readFileSync(atpFile, 'utf8'));
    } catch (e) {
      log(`Couldn't read the store-locator data (${e.message}); using OpenStreetMap only.`);
    }
  } else if (atpFile) {
    log('No store-locator data this time; using OpenStreetMap only.');
  }
  const osmOnly = toStores(raw.elements, brands);
  const built = atp ? addFromLocators(osmOnly, brands, atp.features) : osmOnly;
  const notListed = built.notListedNames ?? [];
  // In a fill-in run, chains not downloaded this time keep their published stores, quietly.
  const notFetched = new Set(fill ? brands.filter((b) => !toFetch.includes(b)).map((b) => b.key) : []);
  let result = guardAgainstDrops(built, brands, previous, new Set([...failed, ...notFetched]), notFetched);
  // A chain whose OSM download failed keeps last month's stores; still add any store its
  // locator has that last month's list didn't (stores already there are matched, not doubled).
  if (atp && failed.size) {
    for (const k of failed) delete built.added[k]; // those were replaced by last month's list
    const again = addFromLocators(result, brands, atp.features);
    for (const [k, n] of Object.entries(again.added)) built.added[k] = (built.added[k] ?? 0) + n;
    result = { ...result, stores: again.stores, counts: again.counts };
  }
  // (A previous date far older than that list itself came from a stale server copy, whose chains
  // are being filled in now, so it's not carried over.)
  const prevDateOk =
    previous?.osmDate && previous?.generated && Date.parse(previous.generated) - Date.parse(previous.osmDate) <= MAX_DATA_AGE_DAYS * 86_400_000;
  if (fill && prevDateOk && (!osmDate || previous.osmDate < osmDate)) osmDate = previous.osmDate;
  if (fill && !osmDate) osmDate = previous?.generated ?? null;

  // Deal IDs follow the deal sheet and can be renumbered, so look each chain's deal up by name
  // in the site's current deal list (data/deals.json) instead of trusting brands.json.
  const dealIds = currentDealIds(brands, result.warnings);

  const file = {
    schema: 1,
    // A fill-in run doesn't make the whole list new, so it keeps the date of the last full run.
    generated: fill && previous?.generated ? previous.generated : new Date().toISOString().slice(0, 10),
    osmDate,
    license: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors',
    notice:
      'Store locations from OpenStreetMap (openstreetmap.org/copyright), available under the Open Database License (opendatacommons.org/licenses/odbl/1-0/), with stores missing from OpenStreetMap added from the chains\' own store locators as collected by All the Places (alltheplaces.xyz, CC0). Locations can be missing, closed or out of date.',
    brands: brands.map((b) => ({ key: b.key, name: b.name, deals: dealIds.get(b.key) ?? b.deals, participating: b.participating })),
    stores: result.stores,
  };

  const lines = [
    `## Store locations`,
    ``,
    `${fill ? 'Fill-in run. ' : ''}OSM data as of ${osmDate ?? 'unknown'}. ${result.stores.length} stores from ${brands.length} chains.${failed.size ? ` Still missing (tried again daily): ${brands.filter((b) => failed.has(b.key)).map((b) => b.name).join(', ')}.` : ''}`,
    `Skipped: ${result.skipped.closed} closed, ${result.skipped.duplicate} duplicates, ${result.skipped.noCoords} without a usable position, ${result.skipped.noBrand} other matches, ${result.skipped.notListed ?? 0} not on a participating-locations list.`,
    ``,
    `| Chain | Stores | Added from the chain's store locator |`,
    `| --- | ---: | ---: |`,
    ...brands.map((b) => `| ${b.name} | ${result.counts[b.key] ?? 0} | ${built.added?.[b.key] ?? (atp ? 0 : '–')} |`),
  ];
  if (result.warnings.length) lines.push('', '### Check these', '', ...result.warnings.map((w) => `- ${w}`));
  if (built.moved?.length) lines.push('', `### Pins moved to the store's street address (${built.moved.length})`, '', ...built.moved.map((m) => `- ${m}`));
  if (raw.elements.length && notListed.length) {
    lines.push('', '### Left off: not on a participating-locations list', '', ...notListed.sort().map((n) => `- ${n}`));
  }
  if (progress.length) lines.push('', '### Download log', '', '```', ...progress, '```');
  const summary = lines.join('\n');
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  const reportFile = argValue('--report');
  if (reportFile) writeFileSync(reportFile, summary + '\n');

  if (DRY_RUN) return;
  // Chains still missing get another try on the next daily run.
  writeFileSync(STATUS, JSON.stringify({ missing: [...failed].sort() }, null, 2) + '\n');
  // Only rewrite the file when the stores actually changed, so unchanged months don't make commits.
  const same =
    previous &&
    JSON.stringify({ ...previous, generated: '', osmDate: '' }) === JSON.stringify({ ...file, generated: '', osmDate: '' });
  // (Still rewritten once it's 20 days old, so its date shows the list was checked recently.)
  if (same && (fill || fileAgeDays() < 20)) {
    console.log('No store changes. File left as is.');
    return;
  }
  // One store per line keeps git diffs readable; still small once gzipped by GitHub Pages.
  const json =
    JSON.stringify({ ...file, stores: undefined }, null, 0).replace(/}$/, ',"stores":[\n') +
    file.stores.map((s) => JSON.stringify(s)).join(',\n') +
    '\n]}\n';
  JSON.parse(json); // sanity check
  writeFileSync(OUT, json);
  console.log(`Wrote ${OUT} (${(json.length / 1024).toFixed(0)} KB).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e.message);
    // --soft-fail-days N: busy servers aren't an error (no failure email) as long as the published
    // list is under N days old, or there isn't one yet. The daily schedule simply tries again.
    const softDays = Number(argValue('--soft-fail-days') ?? 0);
    const age = fileAgeDays();
    const soft = e instanceof RetryLater && softDays > 0 && (age === Infinity || age < softDays);
    const reportFile = argValue('--report');
    const title = soft ? '## Store locations: servers busy, will try again tomorrow' : '## Store locations: run failed';
    if (reportFile) writeFileSync(reportFile, [title, '', e.message, '', '```', ...progress, '```', ''].join('\n'));
    process.exit(soft ? 0 : 1);
  });
}
