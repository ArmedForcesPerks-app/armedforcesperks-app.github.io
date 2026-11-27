// Small Overpass client for research jobs: one request at a time, polite pauses, server fallback.
import { gzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const UA = 'ArmedForcesPerks-research/1.0 (+https://armedforcesperks.com)';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const US_AREAS = `(
  area["ISO3166-1"="US"]["boundary"="administrative"];
  area["ISO3166-1"="PR"]["boundary"="administrative"];
  area["ISO3166-1"="GU"]["boundary"="administrative"];
  area["ISO3166-1"="VI"]["boundary"="administrative"];
  area["ISO3166-1"="AS"]["boundary"="administrative"];
  area["ISO3166-1"="MP"]["boundary"="administrative"];
)->.us;`;

export async function overpass(query, { tries = 2, timeoutMs = 900_000 } = {}) {
  const errors = [];
  for (let round = 0; round < tries; round++) {
    for (const url of ENDPOINTS) {
      const host = new URL(url).host;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
          body: 'data=' + encodeURIComponent(query),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`answered ${res.status}`);
        const json = await res.json();
        if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) throw new Error(json.remark.slice(0, 160));
        if (!Array.isArray(json.elements)) throw new Error('no elements');
        const base = json.osm3s?.timestamp_osm_base;
        if (base && Date.now() - Date.parse(base) > 14 * 86_400_000) throw new Error(`stale data ${base}`);
        await sleep(2000);
        return { elements: json.elements, osmBase: base, host };
      } catch (e) {
        errors.push(`${host}: ${e.message}`);
        console.warn(`  ${host} failed: ${e.message}`);
        await sleep(/429/.test(e.message) ? 60_000 : 10_000);
      }
    }
  }
  throw new Error(errors.join('; '));
}

/** Writes JSON, gzipped when the name ends in .gz. */
export function save(path, value) {
  const text = JSON.stringify(value);
  writeFileSync(path, path.endsWith('.gz') ? gzipSync(text) : text);
}

/** Keeps only what the research needs from an OSM element. */
export function slim(el) {
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  return { id: `${el.type[0]}${el.id}`, lat, lon, tags: el.tags ?? {} };
}
