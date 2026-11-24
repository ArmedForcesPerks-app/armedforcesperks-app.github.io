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

/** Public Overpass servers, tried in order. Both are free and need no key. */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
/** If more than this share of chains can't be downloaded, give up and publish nothing. */
const MAX_FAILED_SHARE = 0.25;
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
  return raw.theatres.map(([state, city, name], i) => {
    const key = theatreKey(name);
    // City may be blank when the business lists theatres by state only (AMC).
    if (!/^[A-Z]{2}$/.test(state) || typeof city !== 'string' || !key) throw new Error(`${where}: participating entry ${i} is incomplete`);
    return { state, city: placeKey(city), key, name };
  });
}

/**
 * True if an OSM place is one of the listed locations: its name must match a listed theatre
 * name, and where OSM has a state or city, those must match that entry too.
 */
export function onList(tags, list) {
  const names = [tags.name, tags.official_name, tags.alt_name, tags.old_name, tags.branch].filter(Boolean).map(theatreKey).filter((k) => k.length >= 2);
  if (!names.length) return false;
  const state = stateCode(tags['addr:state']);
  const city = placeKey(tags['addr:city']);
  return list.some((e) => {
    if (state && state !== e.state) return false;
    // A partial name match ("dimondcenter" in "dimondcenterimax") needs a long name or a known state,
    // so short names like "orange" don't match "Orange Park" in another state.
    const partialOk = Boolean(state) || e.key.length >= 8;
    if (!names.some((n) => n === e.key || (partialOk && (n.includes(e.key) || (e.key.includes(n) && n.length >= 5))))) return false;
    // Same name in another city (e.g. "Regal Augusta" in Maine vs Georgia): only trust it if the city matches,
    // or OSM doesn't say the city.
    if (!e.city || !city) return true;
    return city === e.city || city.includes(e.city) || e.city.includes(city) || n2(e, names);
  });
}

/** A name that matches exactly is enough even if OSM's city is a suburb name. */
function n2(e, names) {
  return names.includes(e.key) && e.key.length >= 6;
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
export function guardAgainstDrops(result, brands, previous, failed = new Set()) {
  const warnings = [...[...failed].map((k) => `${brands.find((b) => b.key === k)?.name ?? k}: download failed, kept last month's stores.`)];
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
}

/** Tries each server once. Failed chains get one more round at the end (see main). */
async function overpass(query) {
  const errors = [];
  for (const url of ENDPOINTS) {
    const host = new URL(url).host;
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
  const allBrands = loadBrands(JSON.parse(readFileSync(BRANDS_FILE, 'utf8')));
  // --only a,b,c: a quick trial with a few chains (pull requests use this). Never publishes.
  const only = argValue('--only')?.split(',').filter(Boolean);
  if (only && !DRY_RUN) throw new Error('--only is for trial runs; add --dry-run.');
  const brands = only ? allBrands.filter((b) => only.includes(b.key)) : allBrands;
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
        log(`${label} ${b.name}: ${n} places (${host}, ${Math.round((Date.now() - started) / 1000)}s)`);
      } catch (e) {
        failed.add(b.key);
        streak++;
        log(`${label} ${b.name}: FAILED after ${Math.round((Date.now() - started) / 1000)}s (${e.message})`);
        // Three chains in a row failing on every server means the servers are down: stop instead of waiting for hours.
        if (streak >= 3) throw new Error('Overpass servers are not answering. Not publishing; the next run will try again.');
      }
      await sleep(3000); // one request at a time, with a pause, per Overpass's usage policy
    };
    for (const [i, b] of brands.entries()) await fetchChain(b, `${i + 1}/${brands.length}`);
    // One more try for chains that failed (servers are often only briefly busy).
    if (failed.size) {
      streak = 0;
      await sleep(60_000);
      for (const b of brands.filter((x) => failed.has(x.key))) await fetchChain(b, 'retry');
    }
    if (failed.size > brands.length * MAX_FAILED_SHARE) {
      throw new Error(`${failed.size} of ${brands.length} chains failed to download. Not publishing; try again later.`);
    }
    const saveRaw = argValue('--save-raw');
    if (saveRaw) writeFileSync(saveRaw, JSON.stringify(raw));
  }
  const osmDate = typeof raw.osm3s?.timestamp_osm_base === 'string' ? raw.osm3s.timestamp_osm_base.slice(0, 10) : null;

  const previous = !only && existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
  const built = toStores(raw.elements, brands);
  const notListed = built.notListedNames ?? [];
  const result = guardAgainstDrops(built, brands, previous, failed);

  // Deal IDs follow the deal sheet and can be renumbered, so look each chain's deal up by name
  // in the site's current deal list (data/deals.json) instead of trusting brands.json.
  const dealIds = currentDealIds(brands, result.warnings);

  const file = {
    schema: 1,
    generated: new Date().toISOString().slice(0, 10),
    osmDate,
    license: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors',
    notice:
      'Store locations from OpenStreetMap (openstreetmap.org/copyright), available under the Open Database License (opendatacommons.org/licenses/odbl/1-0/). Locations can be missing, closed or out of date.',
    brands: brands.map((b) => ({ key: b.key, name: b.name, deals: dealIds.get(b.key) ?? b.deals, participating: b.participating })),
    stores: result.stores,
  };

  const lines = [
    `## Store locations`,
    ``,
    `OSM data as of ${osmDate ?? 'unknown'}. ${result.stores.length} stores from ${brands.length} chains.`,
    `Skipped: ${result.skipped.closed} closed, ${result.skipped.duplicate} duplicates, ${result.skipped.noCoords} without a usable position, ${result.skipped.noBrand} other matches, ${result.skipped.notListed ?? 0} not on a participating-locations list.`,
    ``,
    `| Chain | Stores |`,
    `| --- | ---: |`,
    ...brands.map((b) => `| ${b.name} | ${result.counts[b.key] ?? 0} |`),
  ];
  if (result.warnings.length) lines.push('', '### Check these', '', ...result.warnings.map((w) => `- ${w}`));
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
  // Only rewrite the file when the stores actually changed, so unchanged months don't make commits.
  const same =
    previous &&
    JSON.stringify({ ...previous, generated: '', osmDate: '' }) === JSON.stringify({ ...file, generated: '', osmDate: '' });
  if (same) {
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
    const reportFile = argValue('--report');
    if (reportFile) writeFileSync(reportFile, ['## Store locations: run failed', '', e.message, '', '```', ...progress, '```', ''].join('\n'));
    process.exit(1);
  });
}
