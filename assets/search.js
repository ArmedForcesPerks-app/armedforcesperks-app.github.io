// GENERATED, do not edit by hand. Copied from the app repo's src/lib/search.ts (commit aa8b735)
// with only the TypeScript types removed, so the website uses exactly the same rules as the app.
/**
 * On-device deal search. Runs entirely on the phone with no network and nothing logged.
 *
 * - Matches business names, keywords (products and needs, e.g. "coolers" -> YETI),
 *   categories and deal text, ranked in that order.
 * - Understands a few everyday synonyms ("cell" = "phone", "daycare" = "child care").
 * - Tolerates small typos ("addidas", "verison") by checking words that are one or two
 *   letters off from words that really appear in the deals.
 * - Never invents a match: every result contains every searched word (or a close spelling
 *   of it). When nothing matches, it can suggest categories to browse instead.
 *
 * No imports, so Node can run it directly in tests.
 */

                              
             
               
                   
                  
                  
                     
                       
                     
                     
  

                                    // deal id -> weight
                           
                                                  
                                                   
                                                                                                      

                       
  

                            
                                       
                
                                                                   
                                    
                                                                         
                      
                                                            
                        
  

const W = { name: 10, keyword: 7, category: 5, summary: 3, body: 1 }         ;

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'the', 'for', 'of', 'at', 'on', 'in', 'to', 'my', 'me', 'i', 'with', 'or', 'is',
  'deal', 'deals', 'discount', 'discounts', 'military', 'off', 'offer', 'offers', 'perk', 'perks', 'sale',
  'near', 'best', 'get', 'any', 'some', 'cheap',
]);

/** Words that mean the same thing to a shopper. Kept small and literal on purpose. */
const SYNONYM_GROUPS             = [
  ['phone', 'cell', 'cellphone', 'mobile', 'wireless', 'smartphone', 'carrier'],
  ['tv', 'television'],
  ['movie', 'movies', 'cinema', 'theater', 'theatre', 'film'],
  ['car', 'auto', 'vehicle', 'automobile'],
  ['hotel', 'motel', 'lodging'],
  ['flight', 'flights', 'airline', 'airfare', 'plane'],
  ['shoe', 'shoes', 'sneaker', 'sneakers', 'footwear'],
  ['clothes', 'clothing', 'apparel'],
  ['restaurant', 'restaurants', 'dining', 'food', 'eat'],
  ['kid', 'kids', 'child', 'children'],
  ['baby', 'infant', 'newborn'],
  ['glasses', 'eyeglasses', 'eyewear', 'spectacles'],
  ['laptop', 'computer', 'pc', 'notebook'],
  ['mattress', 'bed'],
  ['gym', 'fitness', 'workout', 'exercise'],
  ['school', 'college', 'education', 'tuition'],
  ['job', 'jobs', 'career', 'careers', 'employment', 'hiring'],
  ['pet', 'pets', 'dog', 'dogs', 'cat', 'cats'],
  ['daycare', 'childcare'],
  ['internet', 'wifi', 'broadband'],
  ['taxes', 'tax'],
  ['counseling', 'therapy', 'counselor', 'therapist'],
  ['jewelry', 'jewellery'],
  ['moving', 'move', 'pcs', 'relocation'],
];

/** Only used to suggest categories when nothing matches. Never used to pick results. */
const CATEGORY_HINTS                           = {
  Home: ['furniture', 'couch', 'sofa', 'decor', 'kitchen', 'appliance', 'appliances', 'tools', 'garden', 'bedding', 'storage', 'grill', 'lamp', 'rug'],
  Retail: ['clothes', 'clothing', 'shirt', 'dress', 'jacket', 'hat', 'jewelry', 'watch', 'gift', 'toys', 'shoes', 'boots', 'groceries', 'makeup'],
  Electronics: ['tv', 'laptop', 'tablet', 'camera', 'headphones', 'speaker', 'console', 'gaming', 'printer', 'phone', 'computer', 'drone'],
  'Outdoors and Fitness': ['camping', 'fishing', 'hiking', 'bike', 'bicycle', 'golf', 'gym', 'yoga', 'running', 'kayak', 'tent', 'ski', 'surf'],
  Travel: ['flight', 'hotel', 'cruise', 'vacation', 'rental', 'trip', 'luggage', 'airport', 'resort', 'train'],
  Entertainment: ['movie', 'concert', 'tickets', 'theme', 'park', 'museum', 'zoo', 'streaming', 'music', 'games', 'bowling'],
  Restaurants: ['food', 'pizza', 'burger', 'coffee', 'lunch', 'dinner', 'breakfast', 'restaurant', 'tacos', 'wings'],
  Auto: ['car', 'truck', 'tires', 'oil', 'repair', 'motorcycle', 'parts', 'battery', 'wash', 'brakes'],
  Health: ['glasses', 'contacts', 'dental', 'dentist', 'vitamins', 'skincare', 'doctor', 'pharmacy', 'therapy', 'vision'],
  'Phone and Internet': ['phone', 'cell', 'internet', 'wifi', 'cable', 'plan', 'carrier'],
  Services: ['insurance', 'bank', 'loan', 'tax', 'legal', 'childcare', 'daycare', 'scholarship', 'job', 'moving', 'storage'],
};

export function normalize(s        )         {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Very light plural folding: coolers -> cooler, glasses stays, batteries -> battery. */
export function stem(w        )         {
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (/(ss|us|is)$/.test(w)) return w;
  if (/(ches|shes|xes|sses)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s')) return w.slice(0, -1);
  return w;
}

/** Forms to store or look up: "movies" -> movy and movie, so either spelling meets. */
function forms(w        )           {
  const s = stem(w);
  return w.endsWith('ies') && w.length > 4 ? [s, w.slice(0, -1)] : [s];
}

function words(s        )           {
  return normalize(s).split(' ').filter(Boolean);
}

const SYNONYMS = new Map                  ();
for (const group of SYNONYM_GROUPS) {
  const stems = [...new Set(group.map(stem))];
  for (const s of stems) SYNONYMS.set(s, stems);
}

export function buildIndex(deals                  )              {
  const postings = new Map                 ();
  const surface = new Map                ();
  const add = (word        , id        , weight        ) => {
    for (const key of forms(word)) {
      if (!surface.has(key) || weight >= W.keyword) surface.set(key, word);
      let p = postings.get(key);
      if (!p) postings.set(key, (p = new Map()));
      if ((p.get(id) ?? 0) < weight) p.set(id, weight);
    }
  };
  const addText = (text        , id        , weight        ) => {
    const ws = words(text);
    for (const w of ws) add(w, id, weight);
    // Joined names so "bootbarn" or "tmobile" find "Boot Barn" and "T-Mobile".
    if (weight === W.name && ws.length > 1) add(ws.join(''), id, weight);
  };
  const categories = new Set        ();
  for (const d of deals) {
    categories.add(d.category);
    addText(d.name, d.id, W.name);
    // Also "bj" for "BJ's", in case someone types the name without the s.
    if (/[’']/.test(d.name)) addText(d.name.replace(/[’']/g, ' '), d.id, W.name);
    for (const k of d.keywords) addText(k, d.id, W.keyword);
    addText(d.category, d.id, W.category);
    addText(d.summary, d.id, W.summary);
    addText([d.details, d.howToClaim, d.notes ?? '', d.audience.join(' ')].join(' '), d.id, W.body);
  }
  return { postings, vocab: [...postings.keys()], surface, categories: [...categories] };
}

/** Damerau-Levenshtein distance, stopping early once it passes `max`. */
export function editDistance(a        , b        , max        )         {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows             = [];
  for (let i = 0; i <= a.length; i++) {
    rows.push(new Array(b.length + 1).fill(0));
    rows[i][0] = i;
  }
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, rows[i - 2][j - 2] + 1);
      rows[i][j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
  }
  return rows[a.length][b.length];
}

/** How many typos we forgive for a word of this length. */
function typoBudget(len        )         {
  if (len < 4) return 0;
  if (len < 7) return 1;
  return 2;
}

/** Scores for one searched word: deal id -> best weight. */
function matchWord(index             , raw        , isLast         )                                                  {
  const scores = new Map                ();
  const bump = (p                     , factor        ) => {
    if (!p) return;
    for (const [id, w] of p) {
      const v = w * factor;
      if ((scores.get(id) ?? 0) < v) scores.set(id, v);
    }
  };

  const base = stem(raw);
  const own = forms(raw);
  const all = new Set(own.flatMap((f) => SYNONYMS.get(f) ?? [f]));
  for (const f of all) bump(index.postings.get(f), own.includes(f) ? 1 : 0.85);

  // While typing, "cool" should already find "cooler". Only for the last word, 3+ letters.
  if (isLast && raw.length >= 3) {
    for (const v of index.vocab) if (v !== base && v.startsWith(raw)) bump(index.postings.get(v), 0.8);
  }
  if (scores.size) return { scores };

  // Nothing exact: look for a close spelling among words that really appear in the deals.
  const budget = typoBudget(raw.length);
  if (!budget) return { scores };
  let best = budget + 1;
  let fixes           = [];
  for (const v of index.vocab) {
    // Only correct toward business names and product keywords, never toward a random
    // word in a deal's fine print (so "couch" doesn't turn into Amtrak's "coach" fares).
    if (v.length < 3 || maxWeight(index, v) < W.keyword) continue;
    const d = Math.min(editDistance(raw, v, budget), editDistance(base, v, budget));
    if (d < best) {
      best = d;
      fixes = [v];
    } else if (d === best) fixes.push(v);
  }
  if (best > budget) return { scores };
  for (const v of fixes) {
    for (const f of SYNONYMS.get(v) ?? [v]) bump(index.postings.get(f), 0.7);
  }
  // Prefer the fix that is a business name or keyword for the "Did you mean" note.
  const shown = fixes.sort((a, b) => maxWeight(index, b) - maxWeight(index, a))[0];
  return { scores, fixed: index.surface.get(shown) ?? shown };
}

function maxWeight(index             , word        )         {
  let m = 0;
  for (const w of index.postings.get(word)?.values() ?? []) m = Math.max(m, w);
  return m;
}

export function searchDeals(index             , query        )               {
  const all = words(query);
  // Single letters (the "s" in "kohl s") and filler words don't narrow anything.
  const terms = all.filter((w) => !STOP_WORDS.has(w) && (w.length > 1 || /\d/.test(w)));
  const used = terms.length ? terms : all;
  const result               = { ids: [], corrected: {}, unmatched: [], suggestions: [] };
  if (!used.length) return result;

  let total                             = null;
  used.forEach((t, i) => {
    const { scores, fixed } = matchWord(index, t, i === used.length - 1);
    if (fixed && fixed !== t) result.corrected[t] = fixed;
    if (!scores.size) result.unmatched.push(t);
    if (total === null) {
      total = scores;
      return;
    }
    const next = new Map                ();
    for (const [id, s] of total                       ) {
      const add = scores.get(id);
      if (add !== undefined) next.set(id, s + add);
    }
    total = next;
  });

  const ranked = [...(total ?? new Map                ()).entries()].sort((a, b) => b[1] - a[1]);
  // Drop weak matches when strong ones exist: a word that only shows up in a deal's fine
  // print (often an exclusion like "excludes furniture") shouldn't put it in the results.
  const top = ranked[0]?.[1] ?? 0;
  result.ids = ranked.filter(([, s]) => s >= top * 0.3).map(([id]) => id);
  if (!result.ids.length) result.suggestions = suggestCategories(index, used);
  return result;
}

/** Categories to browse when a search finds nothing. Hints only, never results. */
export function suggestCategories(index             , terms          )           {
  const found           = [];
  for (const [cat, hints] of Object.entries(CATEGORY_HINTS)) {
    if (!index.categories.includes(cat)) continue;
    const stems = hints.map(stem);
    if (terms.some((t) => stems.includes(stem(t)) || stems.some((h) => editDistance(stem(t), h, 1) <= 1 && h.length >= 4))) {
      found.push(cat);
    }
  }
  return found;
}
