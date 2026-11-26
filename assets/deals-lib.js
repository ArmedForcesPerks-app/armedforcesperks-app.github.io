// GENERATED, do not edit by hand. Copied from the app repo's src/lib/deals.ts (commit aa8b735)
// with only the TypeScript types removed, so the website uses exactly the same rules as the app.
/**
 * Deal data model, validation, compliance text filters and search/filter logic.
 *
 * This file is shared by the app AND by the Node import script
 * (scripts/import-deals.mjs) and tests, so it must:
 *   - have no imports, and
 *   - use only "erasable" TypeScript (no enums, namespaces or parameter properties),
 *     so Node can run it directly with type stripping.
 */

                                                   

                                                                                         

                                                                    

                    
             
               
                   
                  
                  
                                              
                     
                                               
                                                    
                    
                              
                                                                                     
                        
                                                                                
                            
                    
                          
                         
                              
                          
                                                                                       
                       
                                                                                          
                     
                                                                    
                      
                                                                                       
                     
                                                                            
                           
  

/** Stable: yearly. Normal: every 6 months. Volatile (seasonal, promos, prices): every 90 days. */
                                                           
export const RECHECK_DAYS                              = { stable: 365, normal: 182, volatile: 90 };

/** Date the deal is due for its next check, YYYY-MM-DD. */
export function recheckDue(deal                                             )         {
  const [y, m, d] = deal.lastConfirmed.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + RECHECK_DAYS[deal.recheckTier])).toISOString().slice(0, 10);
}

/** Highest deals-file format this version of the app understands. */
export const DEALS_SCHEMA = 1;
/** A downloaded list smaller than this is treated as a mistake (e.g. a half-finished upload). */
export const MIN_REMOTE_DEALS = 25;

/**
 * Checks a downloaded (or cached) deals file. Returns null if it shouldn't replace the list
 * the phone already has: unknown newer format, bad date, older than `notOlderThan`, or too small.
 */
export function checkDealsFile(raw         , notOlderThan        )                                              {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw                           ;
  const schema = o.schema ?? 1;
  if (typeof schema !== 'number' || schema > DEALS_SCHEMA) return null;
  if (typeof o.generated !== 'string' || !ISO_DATE.test(o.generated)) return null;
  if (o.generated < notOlderThan) return null;
  if (!Array.isArray(o.deals)) return null;
  const deals = parseDeals(o.deals);
  if (deals.length < MIN_REMOTE_DEALS) return null;
  return { deals, generated: o.generated };
}

                         
                  
                                                      
                    
                
  

export const STATUS_OPTIONS                                                     = [
  { key: 'activeDuty', label: 'Active duty', short: 'Active duty' },
  { key: 'guardReserve', label: 'Guard & Reserve', short: 'Guard/Reserve' },
  { key: 'veteran', label: 'Veteran', short: 'Veterans' },
  { key: 'retiree', label: 'Retiree', short: 'Retirees' },
  { key: 'family', label: 'Spouse & family', short: 'Spouses/family' },
];

export const AUDIENCE_TAGS                = ['Deployed', 'Kids', 'Spouse', 'Family'];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEAL_ID = /^AFP-\d{4,}$/;

function str(value         , max = 2000)         {
  if (typeof value !== 'string') return '';
  // Strip control characters (keeps normal whitespace) and trim.
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}

/**
 * Only allow plain https links to a real host. Blocks javascript:, intent:, file:,
 * http:, data:, credentials in the URL and anything malformed.
 */
export function safeHttpsUrl(value         )                {
  const s = str(value, 2048);
  if (!/^https:\/\/[^\s/?#@]+\.[^\s/?#@]+([/?#][^\s]*)?$/i.test(s)) return null;
  return s;
}

export function hostOf(url        )         {
  const m = /^https:\/\/([^/?#:]+)/i.exec(url);
  return m ? m[1].toLowerCase().replace(/^www\./, '') : url;
}

export function isGovernmentUrl(url        )          {
  const host = hostOf(url);
  return /\.(gov|mil)$/.test(host) || host === 'uscode.house.gov';
}

// ---------------------------------------------------------------------------
// Store-compliance text filters (applied at import AND re-checked by tests)
// ---------------------------------------------------------------------------

/**
 * Google Play does not allow apps that facilitate the sale of firearms or ammunition.
 * Some retailers' military discounts mention firearms; we remove that wording from
 * what the app shows (the master sheet is never changed).
 */
export const RESTRICTED_WORDS = /\b(fire ?arms?|ammo|ammunition|guns?|handguns?|rifles?|pistols?|shotguns?)\b/i;

/** Brand names that contain a restricted word but are not about weapons. */
const RESTRICTED_NAME_ALLOWLIST = /\bBlack Rifle Coffee\b/gi;

export function containsRestricted(text                           )          {
  if (!text) return false;
  return RESTRICTED_WORDS.test(text.replace(RESTRICTED_NAME_ALLOWLIST, ''));
}

function splitSentences(text        )           {
  return text.split(/(?<=[.!?])\s+/).filter(Boolean);
}

export function stripRestricted(text        )         {
  if (!containsRestricted(text)) return text;
  // "10% off most items, 5% off firearms and ammo" -> "10% off most items"
  let out = text.replace(
    /[,;]?\s*(and\s+)?(up to\s+)?\d+%\s+off\s+(on\s+)?(fire ?arms?|guns?|ammo|ammunition)(\s+(and|&)\s+(ammo|ammunition|fire ?arms?))?/gi,
    '',
  );
  // Drop any remaining sentence that still mentions restricted items.
  out = splitSentences(out)
    .filter((s) => !containsRestricted(s))
    .join(' ');
  return out.trim();
}

/** Sentences in the sheet's notes column that are internal research notes, not for users. */
const INTERNAL_NOTE = new RegExp(
  [
    'FLAG FOR',
    'Master already',
    'master sheet',
    'plain link',
    "Don't describe",
    'Do not describe',
    '\\bSource (is|page|URL|used)\\b',
    'before publishing',
    'Checked in (the )?browser',
    'Rechecked',
    "didn't load",
    "wouldn't load",
    "didn't show",
    'did not load',
    'Linked from',
    'Confirm details',
    'decide whether',
  ].join('|'),
  'i',
);

export function publicNotes(raw        )                                             {
  const removed           = [];
  const kept           = [];
  for (const sentence of splitSentences(raw)) {
    if (!INTERNAL_NOTE.test(sentence)) {
      kept.push(sentence);
      continue;
    }
    // Keep the useful half of "Useful fact; internal remark." style sentences.
    const clauses = sentence.replace(/[.!?]$/, '').split(/;\s+/);
    const good = clauses.filter((c) => !INTERNAL_NOTE.test(c));
    removed.push(...clauses.filter((c) => INTERNAL_NOTE.test(c)));
    if (good.length) {
      const joined = good.join('; ');
      kept.push(joined[0].toUpperCase() + joined.slice(1) + '.');
    }
  }
  const text = kept.join(' ').trim();
  return { kept: text.length ? text : null, removed };
}

const FINANCIAL_NAME =
  /\b(USAA|Navy Federal|PenFed|Pentagon Federal|American Express|Amex|Chase|Capital One|Citi(bank)?|Wells Fargo|Bank of America|Discover|Synchrony|Credit Union|Bank|Insurance|GEICO|Progressive|Allstate|State Farm|Liberty Mutual|Armed Forces Bank|Andrews Federal|Service Credit Union)\b/i;

export function looksFinancial(name        , category        , rawNotes        )          {
  return (
    FINANCIAL_NAME.test(name) ||
    /^(Financial|Banking|Insurance)/i.test(category) ||
    /plain link|financial (brand|product)|insurance:/i.test(rawNotes)
  );
}

// ---------------------------------------------------------------------------
// Validation: used for the bundled file in tests and for any remote data at runtime
// ---------------------------------------------------------------------------

function elig(v         )                     {
  return v === 'yes' || v === 'no' || v === 'unknown' ? v : null;
}

/** Returns a clean Deal, or null if anything is missing or unsafe. Never throws. */
export function parseDeal(input         )              {
  if (!input || typeof input !== 'object') return null;
  const o = input                           ;
  const e = (o.eligibility ?? {})                           ;

  const id = str(o.id, 20);
  const name = str(o.name, 120);
  const category = str(o.category, 60);
  const summary = str(o.summary, 300);
  const sourceUrl = safeHttpsUrl(o.sourceUrl);
  const lastConfirmed = str(o.lastConfirmed, 10);
  const status = o.status === 'live' || o.status === 'review' ? o.status : null;

  const eligibility = {
    activeDuty: elig(e.activeDuty),
    guardReserve: elig(e.guardReserve),
    veteran: elig(e.veteran),
    retiree: elig(e.retiree),
    family: elig(e.family),
  };

  if (
    !DEAL_ID.test(id) ||
    !name ||
    !category ||
    !summary ||
    !sourceUrl ||
    !ISO_DATE.test(lastConfirmed) ||
    !status ||
    Object.values(eligibility).some((v) => v === null)
  ) {
    return null;
  }

  const where = o.where === 'Online' || o.where === 'In store' || o.where === 'Both' ? o.where : null;
  const scope = o.scope === 'Nationwide' || o.scope === 'Regional' || o.scope === 'Local' ? o.scope : null;
  const expires = typeof o.expires === 'string' && ISO_DATE.test(o.expires) ? o.expires : null;
  const audience = Array.isArray(o.audience)
    ? (o.audience.filter((a) => (AUDIENCE_TAGS             ).includes(a))                 )
    : [];
  const financial = o.financial === true;
  const notes = str(o.notes, 1000) || null;
  const keywords = Array.isArray(o.keywords)
    ? [
        ...new Set(
          o.keywords
            .filter((k)              => typeof k === 'string')
            .map((k) => k.trim().toLowerCase().slice(0, 40))
            .filter((k) => k && !containsRestricted(k)),
        ),
      ].slice(0, 40)
    : [];

  const deal       = {
    id,
    name,
    category,
    summary,
    details: str(o.details, 2000),
    eligibility: eligibility                                  ,
    howToClaim: str(o.howToClaim, 1000),
    where,
    scope,
    sourceUrl,
    // Financial brands never use affiliate links.
    affiliateUrl: financial ? null : safeHttpsUrl(o.affiliateUrl),
    lastConfirmed,
    status,
    seasonal: o.seasonal === true,
    expires,
    verification: str(o.verification, 60) || null,
    audience,
    notes,
    financial,
    government: isGovernmentUrl(sourceUrl),
    keywords,
    recheckTier: o.recheckTier === 'stable' || o.recheckTier === 'volatile' ? o.recheckTier : 'normal',
  };

  // Defense in depth: never show restricted (weapons) wording, even from remote data.
  for (const field of ['name', 'summary', 'details', 'howToClaim', 'notes']         ) {
    const value = deal[field];
    if (typeof value === 'string' && containsRestricted(value)) {
      const cleaned = stripRestricted(value);
      if (field === 'name' || field === 'summary') {
        if (!cleaned) return null;
      }
      (deal                           )[field] = field === 'notes' ? cleaned || null : cleaned;
    }
  }
  return deal;
}

export function parseDeals(list         )         {
  if (!Array.isArray(list)) return [];
  const seen = new Set        ();
  const out         = [];
  for (const item of list) {
    const d = parseDeal(item);
    if (d && !seen.has(d.id)) {
      seen.add(d.id);
      out.push(d);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Search and filters
// ---------------------------------------------------------------------------

                           
                
                          
                           
                               
                                                                                       
                         
                                           
                           
  

export const EMPTY_FILTERS              = {
  query: '',
  category: null,
  status: null,
  audience: null,
  confirmedOnly: false,
  hideNeedsReview: false,
};

export function isExpired(deal      , today        )          {
  return deal.expires !== null && deal.expires < today;
}

export function todayIso(now = new Date())         {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Applies the filter choices. Deals whose end date has passed are hidden automatically
 * (they still show in Saved, marked "Ended"). Search words are handled by lib/search.ts.
 */
export function filterDeals(deals        , filters             , today        )         {
  return deals.filter((d) => {
    if (isExpired(d, today)) return false;
    if (filters.hideNeedsReview && d.status !== 'live') return false;
    if (filters.category && d.category !== filters.category) return false;
    if (filters.audience && !d.audience.includes(filters.audience)) return false;
    if (filters.status) {
      const e = d.eligibility[filters.status];
      if (e === 'no') return false;
      if (filters.confirmedOnly && e !== 'yes') return false;
    }
    return true;
  });
}

/** Alphabetical, with confirmed ("live") deals before "Needs review" when a query isn't typed. */
export function sortDeals(deals        , today        )         {
  return [...deals].sort((a, b) => {
    const ea = isExpired(a, today) ? 1 : 0;
    const eb = isExpired(b, today) ? 1 : 0;
    if (ea !== eb) return ea - eb;
    return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  });
}

export function categoriesOf(deals        )           {
  return [...new Set(deals.map((d) => d.category))].sort((a, b) => a.localeCompare(b));
}

export function formatDate(iso        )         {
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (!y || !m || !d) return iso;
  return `${months[m - 1]} ${d}, ${y}`;
}

/** "Nov 2026" */
export function formatMonth(iso        )         {
  const [y, m] = iso.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (!y || !m) return iso;
  return `${months[m - 1]} ${y}`;
}

// ---------------------------------------------------------------------------
// Headline: the short "30% OFF" / "FREE" / "$500 CASH BACK" shown first on each deal
// ---------------------------------------------------------------------------

                                                      

const LEGAL = /\b(law|interest|cap|lease|hiring|relief act)\b/i;

/**
 * Pulls the most important number out of a deal summary. Returns null when there isn't
 * a clear one (the app then shows an icon instead), so we never show a misleading number.
 */
/** "$5,000", or "$10K" from ten thousand up so it fits the deal card. */
function dollars(n        )         {
  return n >= 10000 ? `$${Math.round(n / 1000)}K` : `$${n.toLocaleString('en-US')}`;
}

export function headlineOf(deal                       )                  {
  const s = deal.summary;
  if (/^free\b/i.test(s)) return { big: 'FREE', small: '' };
  if (LEGAL.test(s) && !/\boff\b/i.test(s)) return null;

  const pct = /\b(up to |at least |extra )?(\d{1,2})%(\s+to\s+(\d{1,2})%)?(\s+(or more\s+)?off)?/i.exec(s);
  const usd = /(up to |from |for |as low as )?\$(\d[\d,]*)(\.\d{2})?(\s+to\s+\$(\d[\d,]*))?(\s*\/|\s+(off|cash back|cash|onboard credit|credit|rebate|bonus|gift card|annual fee|fee|movie tickets|tickets|matinees))?/i.exec(s);
  const usePct = !!pct && (!usd || pct.index <= usd.index);

  if (usePct && pct) {
    const q = (pct[1] ?? '').trim().toLowerCase();
    // "10% to 15% off" -> "UP TO 15%"
    if (pct[4]) return { big: `${pct[4]}%`, small: 'UP TO' };
    if (q === 'up to') return { big: `${pct[2]}%`, small: 'UP TO' };
    if (q === 'at least' || /or more/i.test(pct[5] ?? '')) return { big: `${pct[2]}%+`, small: 'OFF' };
    return { big: `${pct[2]}%`, small: pct[5] || /\boff\b/i.test(s) ? 'OFF' : '' };
  }
  if (usd) {
    const q = (usd[1] ?? '').trim().toLowerCase();
    const tail = (usd[6] ?? '').trim().toLowerCase();
    const word = (usd[7] ?? '').toLowerCase();
    // A price or a fee ("for $25", "$7.99/month", "$325 annual fee", "$8.50 movie tickets")
    // is not a saving, so don't headline it.
    // Also a price: "$28 a month", "$278 season pass", "Ikon Pass ($899)". Not "Up to $4,500 a year",
    // which is money you get.
    const after = s.slice(usd.index + usd[0].length);
    const isPrice =
      q !== 'up to' &&
      (/^\s*(a|per|each)\s+(month|year|night|day|week)\b/i.test(after) ||
        /^\s*((season|annual|day)\s+)?pass(es)?\b/i.test(after) ||
        s[usd.index - 1] === '(');
    if (
      q === 'for' ||
      q === 'from' ||
      q === 'as low as' ||
      tail === '/' ||
      usd[3] ||
      /fee|tickets|matinees/.test(word) ||
      isPrice
    ) {
      return /\bfree\b|\bno cost\b/i.test(s) ? { big: 'FREE', small: '' } : null;
    }
    // "$500 to $5,000" -> "UP TO $5,000"
    if (usd[5]) {
      return { big: dollars(Number(usd[5].replace(/,/g, ''))), small: 'UP TO' };
    }
    let small = '';
    if (word === 'off') small = 'OFF';
    else if (word.startsWith('cash')) small = 'CASH BACK';
    else if (word.includes('credit')) small = 'CREDIT';
    else if (word === 'rebate') small = 'REBATE';
    else if (word === 'bonus') small = 'BONUS';
    else if (word === 'gift card') small = 'GIFT CARD';
    if (q === 'up to') small = 'UP TO';
    const n = Number(usd[2].replace(/,/g, ''));
    if (!Number.isFinite(n) || n <= 0) return null;
    return { big: dollars(n), small };
  }
  if (/\bfree\b|\bno cost\b/i.test(s)) return { big: 'FREE', small: '' };
  return null;
}
