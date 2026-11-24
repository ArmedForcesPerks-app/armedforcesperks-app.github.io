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
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
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
    if (!Array.isArray(b.deals) || !b.deals.length || !b.deals.every((d) => /^AFP-\d{4,}$/.test(d))) {
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
    return {
      key: b.key,
      name: b.name.trim(),
      deals: b.deals,
      participating: b.participating === true,
      wikidata: hasWd ? m.wikidata : null,
      brand: hasBrand ? m.brand : null,
      exclude,
      requireTag: req,
    };
  });
}

export function buildQuery(brands) {
  const lines = [];
  for (const b of brands) {
    if (b.wikidata) lines.push(`  nwr["brand:wikidata"="${b.wikidata}"](area.us);`);
    else {
      lines.push(`  nwr["brand"="${b.brand}"](area.us);`);
      lines.push(`  nwr["name"="${b.brand}"](area.us);`);
    }
  }
  return [
    '[out:json][timeout:900][maxsize:2000000000];',
    'area["ISO3166-1"~"^(US|PR|GU|VI|AS|MP)$"]["boundary"="administrative"]->.us;',
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
  const skipped = { closed: 0, noBrand: 0, noCoords: 0, duplicate: 0 };
  for (const el of elements) {
    const tags = el.tags ?? {};
    const brand = brandFor(tags, brands);
    if (!brand) {
      skipped.noBrand++;
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
  return { stores, counts, skipped };
}

// ---------------------------------------------------------------------------
// Safety checks against last month's file
// ---------------------------------------------------------------------------

/**
 * If a brand shrank by more than half (usually someone's OSM mistake, or Overpass returning
 * partial data), keep last month's stores for that brand instead. Returns the merged rows.
 */
export function guardAgainstDrops(result, brands, previous) {
  const warnings = [];
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
  if (prevTotal >= 500 && newTotal < prevTotal * TOTAL_DROP_LIMIT) {
    throw new Error(`Store count fell from ${prevTotal} to ${newTotal}. Not publishing; check Overpass and OSM.`);
  }
  const keep = new Set();
  for (const b of brands) {
    const before = prevByKey.get(b.key)?.length ?? 0;
    const now = result.counts[b.key] ?? 0;
    if (before >= 20 && now < before * BRAND_DROP_LIMIT) {
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

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

async function overpass(query) {
  let lastError;
  for (const url of ENDPOINTS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
          body: 'data=' + encodeURIComponent(query),
          signal: AbortSignal.timeout(20 * 60 * 1000),
        });
        if (!res.ok) throw new Error(`${url} answered ${res.status}`);
        const json = await res.json();
        if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) throw new Error(`${url}: ${json.remark}`);
        if (!Array.isArray(json.elements)) throw new Error(`${url}: no elements in answer`);
        return json;
      } catch (e) {
        lastError = e;
        console.warn(`Overpass attempt ${attempt} at ${url} failed: ${e.message}`);
        // Be polite: wait before trying again (1, 2, then 4 minutes).
        if (attempt < 3) await new Promise((r) => setTimeout(r, 60_000 * 2 ** (attempt - 1)));
      }
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const brands = loadBrands(JSON.parse(readFileSync(BRANDS_FILE, 'utf8')));
  const input = argValue('--input');
  let raw;
  if (input) {
    raw = JSON.parse(readFileSync(input, 'utf8'));
  } else {
    console.log(`Asking Overpass for ${brands.length} chains…`);
    raw = await overpass(buildQuery(brands));
    const saveRaw = argValue('--save-raw');
    if (saveRaw) writeFileSync(saveRaw, JSON.stringify(raw));
  }
  const osmDate = typeof raw.osm3s?.timestamp_osm_base === 'string' ? raw.osm3s.timestamp_osm_base.slice(0, 10) : null;

  const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
  const result = guardAgainstDrops(toStores(raw.elements, brands), brands, previous);

  const file = {
    schema: 1,
    generated: new Date().toISOString().slice(0, 10),
    osmDate,
    license: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors',
    notice:
      'Store locations from OpenStreetMap (openstreetmap.org/copyright), available under the Open Database License (opendatacommons.org/licenses/odbl/1-0/). Locations can be missing, closed or out of date.',
    brands: brands.map((b) => ({ key: b.key, name: b.name, deals: b.deals, participating: b.participating })),
    stores: result.stores,
  };

  const lines = [
    `## Store locations`,
    ``,
    `OSM data as of ${osmDate ?? 'unknown'}. ${result.stores.length} stores from ${brands.length} chains.`,
    `Skipped: ${result.skipped.closed} closed, ${result.skipped.duplicate} duplicates, ${result.skipped.noCoords} without a usable position, ${result.skipped.noBrand} other matches.`,
    ``,
    `| Chain | Stores |`,
    `| --- | ---: |`,
    ...brands.map((b) => `| ${b.name} | ${result.counts[b.key] ?? 0} |`),
  ];
  if (result.warnings.length) lines.push('', '### Check these', '', ...result.warnings.map((w) => `- ${w}`));
  const summary = lines.join('\n');
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');

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
    process.exit(1);
  });
}
