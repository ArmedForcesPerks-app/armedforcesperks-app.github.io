// Research job: independent (non-chain) businesses with a website within each scan area
// (20 miles around military installations), from OpenStreetMap.
// Usage: node local_pois.mjs OUTDIR K/N     (does every Nth area, starting at K; 0-based)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { overpass, save, slim } from './overpass.mjs';

const [out, shard = '0/1'] = process.argv.slice(2);
const [k, n] = shard.split('/').map(Number);
const areas = JSON.parse(readFileSync(new URL('../scan_areas.json', import.meta.url), 'utf8')).areas;
const mine = areas.filter((_, i) => i % n === k);
const KEYS = ['shop', 'amenity', 'leisure', 'tourism', 'craft', 'healthcare'];
const WEB = ['website', 'contact:website', 'url'];

function query(a) {
  const around = `around:${a.radius_m},${a.points.map(([lat, lon]) => `${lat},${lon}`).join(',')}`;
  const lines = [];
  for (const key of KEYS) for (const w of WEB) lines.push(`  nwr["name"]["${key}"]["${w}"][!"brand:wikidata"](${around});`);
  return `[out:json][timeout:900];\n(\n${lines.join('\n')}\n);\nout center tags;`;
}

const all = new Map();
const log = [];
for (const [i, a] of mine.entries()) {
  const t = Date.now();
  try {
    const r = await overpass(query(a), { tries: 2 });
    let added = 0;
    for (const el of r.elements) {
      const s = slim(el);
      const prev = all.get(s.id);
      if (prev) {
        if (!prev.areas.includes(a.id)) prev.areas.push(a.id);
        continue;
      }
      all.set(s.id, { ...s, areas: [a.id] });
      added++;
    }
    log.push([a.id, r.elements.length, added]);
    console.log(`${i + 1}/${mine.length} ${a.id} ${a.name}: ${r.elements.length} places (${added} new) ${Math.round((Date.now() - t) / 1000)}s ${r.host}`);
  } catch (e) {
    log.push([a.id, -1, 0]);
    console.log(`${i + 1}/${mine.length} ${a.id} ${a.name}: FAILED ${e.message.slice(0, 200)}`);
  }
}
save(join(out, `local_pois_${k}_of_${n}.json.gz`), { shard, log, places: [...all.values()] });
console.log('places:', all.size);
