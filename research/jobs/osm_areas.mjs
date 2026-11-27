// Research job: OpenStreetMap places in the islands, places tagged with discounts, and military sites.
// Usage: node osm_areas.mjs OUTDIR
import { join } from 'node:path';
import { overpass, save, slim, US_AREAS } from './overpass.mjs';

const out = process.argv[2];
const POI = ['shop', 'amenity', 'leisure', 'tourism', 'craft', 'office', 'healthcare'];
const named = (set) => POI.map((k) => `  nwr["name"]["${k}"](area.${set});`).join('\n');

const jobs = {
  // Every named place in the four small territories.
  small_territories: `[out:json][timeout:600];
(
  area["ISO3166-1"="GU"]["boundary"="administrative"];
  area["ISO3166-1"="MP"]["boundary"="administrative"];
  area["ISO3166-1"="AS"]["boundary"="administrative"];
  area["ISO3166-1"="VI"]["boundary"="administrative"];
)->.t;
(
${named('t')}
);
out center tags;`,
  hawaii: `[out:json][timeout:900];
area["ISO3166-2"="US-HI"]["boundary"="administrative"]->.t;
(
${named('t')}
);
out center tags;`,
  puerto_rico: `[out:json][timeout:900];
area["ISO3166-1"="PR"]["boundary"="administrative"]->.t;
(
${named('t')}
);
out center tags;`,
  // Places whose tags mention a discount or the military (descriptions, notes, discount:* keys).
  discount_tags: `[out:json][timeout:900];
${US_AREAS}
(
  nwr[~"discount"~"."](area.us);
  nwr["description"~"military|veteran",i](area.us);
  nwr["note"~"military|veteran",i](area.us);
);
out center tags;`,
  // Military sites as mapped in OpenStreetMap (a cross-check for the DoD and Census lists).
  military: `[out:json][timeout:900];
${US_AREAS}
(
  nwr["landuse"="military"]["name"](area.us);
  nwr["military"~"^(base|airfield|naval_base|barracks|training_area|range|office|checkpoint)$"](area.us);
  nwr["operator"~"Coast Guard",i](area.us);
);
out center tags;`,
};

const only = process.argv[3]?.split(',');
for (const [name, q] of Object.entries(jobs)) {
  if (only && !only.includes(name)) continue;
  const t = Date.now();
  try {
    const r = await overpass(q);
    save(join(out, `${name}.json.gz`), { osmBase: r.osmBase, elements: r.elements.map(slim) });
    console.log(`${name}: ${r.elements.length} elements from ${r.host} in ${Math.round((Date.now() - t) / 1000)}s`);
  } catch (e) {
    console.log(`${name}: FAILED ${e.message}`);
  }
}

// What OpenStreetMap mappers use for discounts (key statistics).
for (const query of ['discount', 'military', 'veteran']) {
  try {
    const res = await fetch(`https://taginfo.openstreetmap.org/api/4/keys/all?query=${query}&page=1&rp=200&sortname=count_all&sortorder=desc`, {
      headers: { 'User-Agent': 'ArmedForcesPerks-research/1.0 (+https://armedforcesperks.com)' },
    });
    save(join(out, `taginfo_${query}.json`), await res.json());
    console.log(`taginfo ${query}: ok`);
  } catch (e) {
    console.log(`taginfo ${query}: FAILED ${e.message}`);
  }
}
