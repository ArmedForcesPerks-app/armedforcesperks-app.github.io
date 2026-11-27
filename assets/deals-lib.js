// GENERATED, do not edit by hand. Copied from the app repo's src/lib/deals.ts (commit dfca560)
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

                                                   

                                                                                         

                                                                    

                    
             
               
                   
                  
                  
                                              
                     
                                               
                                                    
                    
                              
                                                                                     
                        
                                                                                
                            
                    
                          
                         
                              
                          
                                                                                       
                       
                                                                                          
                     
                                                                                                                           
                      
                                                                                       
                     
                                                                            
                           
  

/**
 * How often a listing is re-checked by hand against its official page (docs/RECHECKS.md).
 * The sheet's optional recheck_tier column sets it; when that's blank it follows the listing's
 * group (defaultRecheckTier): VA and federal benefits monthly, state and local benefits every
 * 3 months, store deals every 6 months (3 for seasonal ones).
 */
                                                                        
export const RECHECK_DAYS                              = { monthly: 30, quarterly: 91, normal: 182, stable: 365 };
export const RECHECK_LABEL                              = {
  monthly: 'monthly',
  quarterly: 'every 3 months',
  normal: 'every 6 months',
  stable: 'yearly',
};

/** Words the sheet may use. "Volatile" is the older name for every 3 months. */
export function parseRecheckTier(value         )                     {
  const t = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (t === 'monthly' || t === 'month' || t === '1 month') return 'monthly';
  if (t === 'quarterly' || t === 'volatile' || t === '3 months' || t === 'every 3 months') return 'quarterly';
  if (t === 'normal' || t === '6 months' || t === 'every 6 months' || t === 'twice a year') return 'normal';
  if (t === 'stable' || t === 'yearly' || t === 'annual' || t === 'annually' || t === '12 months') return 'stable';
  return null;
}

/** Date the deal is due for its next check, YYYY-MM-DD. */
export function recheckDue(deal                                             )         {
  const [y, m, d] = deal.lastConfirmed.split('-').map(Number);
  const days = RECHECK_DAYS[deal.recheckTier] ?? RECHECK_DAYS.normal;
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Which list a listing's recheck falls under. */
                                                            
export const RECHECK_GROUP_LABEL                               = {
  federal: 'VA and federal benefits',
  state: 'State and local benefits',
  business: 'Store and business deals',
};

const STATE_NAMES = [
  'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'Florida',
  'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine',
  'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada',
  'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma',
  'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah',
  'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming', 'Washington, DC', 'Washington DC',
  'District of Columbia', 'DC', 'Puerto Rico', 'Guam', 'U.S. Virgin Islands', 'US Virgin Islands', 'Virgin Islands',
  'American Samoa', 'Northern Mariana Islands',
];
/** State benefit rows are named like "Texas: free hunting and fishing license". */
const STATE_NAME_PREFIX = new RegExp(`^(${STATE_NAMES.map((s) => s.replace(/[.]/g, '\\.')).join('|')})\\s*:`, 'i');

const STATE_LABELS = new RegExp(
  '^(al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|' +
    'or|pa|ri|sc|sd|tn|tx|ut|vt|wa|wv|wi|wy|dc|pr|vi|' +
    'alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|myflorida|georgia|hawaii|' +
    'idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|mass|massachusetts|michigan|minnesota|' +
    'mississippi|missouri|montana|nebraska|nevada|newhampshire|newjersey|newmexico|newyork|northcarolina|' +
    'northdakota|ohio|oklahoma|oregon|pennsylvania|rhodeisland|southcarolina|southdakota|tennessee|texas|utah|' +
    'vermont|virginia|washington|westvirginia|wisconsin|wyoming|wyo|guam|' +
    // State agencies with their own .gov name.
    'azdor|ksrevenue|mtrevenue|ncparks)$',
);

/**
 * True for a state, territory, county or city government site (dmv.ca.gov, revenue.state.mn.us,
 * laramiecountywy.gov). va.gov is the U.S. Department of Veterans Affairs, not Virginia.
 */
export function isStateOrLocalHost(host        )          {
  const h = host.toLowerCase().replace(/^www\./, '');
  if (/(^|\.)(state\.)?[a-z]{2}\.us$/.test(h)) return true;
  const m = /([a-z0-9-]+)\.gov$/.exec(h);
  if (!m || m[1] === 'va') return false;
  return STATE_LABELS.test(m[1]) || /(county|city|parish|borough|township)/.test(m[1]);
}

export function recheckGroup(deal                                               )               {
  if (STATE_NAME_PREFIX.test(deal.name) || isStateOrLocalHost(hostOf(deal.sourceUrl))) return 'state';
  if (isGovernmentUrl(deal.sourceUrl) || deal.category === 'Government Benefits') return 'federal';
  return 'business';
}

/** The recheck tier used when the sheet's recheck_tier column is blank. */
export function defaultRecheckTier(deal                                                            )              {
  const group = recheckGroup(deal);
  if (group === 'federal') return 'monthly';
  if (group === 'state') return 'quarterly';
  return deal.seasonal ? 'quarterly' : 'normal';
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

                         
                  
                                                      
                    
                
  

/**
 * "Show deals and perks for" choices. Veterans come first: they are by far the largest group.
 * Button labels use title case so every option reads the same way ("Guard" and "Reserve" are
 * proper names, so they are capitalized in sentences too).
 */
export const STATUS_OPTIONS                                                     = [
  { key: 'veteran', label: 'Veterans', short: 'Veterans' },
  { key: 'activeDuty', label: 'Active Duty', short: 'Active Duty' },
  { key: 'guardReserve', label: 'Guard & Reserve', short: 'Guard & Reserve' },
  { key: 'retiree', label: 'Retirees', short: 'Retirees' },
  { key: 'family', label: 'Spouses & Families', short: 'Spouses & Families' },
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

/**
 * Official military program sites that don't end in .gov or .mil: the Exchanges, commissaries
 * and MWR, the Veterans Crisis Line, and the military's own colleges and academies.
 */
const OFFICIAL_PROGRAM_HOSTS =
  /(^|\.)(aafes\.com|shopmyexchange\.com|mynavyexchange\.com|shopcgx\.com|usmc-mccs\.org|commissaries\.com|armymwr\.com|myairforcelife\.com|veteranscrisisline\.net|usncc\.edu|af\.edu|afit\.edu|usna\.edu|westpoint\.edu|nps\.edu|usuhs\.edu|uscga\.edu)$/;

/** A government or official military program source (shown with the "not a government app" notice). */
export function isGovernmentUrl(url        )          {
  const host = hostOf(url);
  return /\.(gov|mil)$/.test(host) || host === 'uscode.house.gov' || OFFICIAL_PROGRAM_HOSTS.test(host);
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
// VA claims: the app never helps with, or points people to paid help with, VA claims or ratings
// ---------------------------------------------------------------------------

/**
 * Wording that means a listing is selling help with VA claims or ratings. Only VA-accredited
 * people may help prepare, present or prosecute a claim (38 U.S.C. 5901, 38 CFR 14.629), no one
 * may charge for an initial claim (38 CFR 14.636(c)), and several states penalize paid "claim
 * consultants". The app lists none of these, paid or "free consultation", and takes no affiliate
 * money from them. Free help comes only from VA.gov and VA-accredited representatives.
 */
const CLAIM_HELP = new RegExp(
  [
    '\\bclaims?\\s+(consultants?|consulting|coach(es|ing)?|preparation\\s+services?|experts?\\s+for\\s+hire)',
    '\\b(maximi[sz]e|raise|increase|boost|upgrade)\\s+(your\\s+)?(va\\s+)?(disability\\s+)?(rating|claims?|compensation)\\b',
    '\\b(get|reach|win)\\s+(a\\s+|to\\s+)?100\\s?%\\s+(va\\s+)?(rating|disability)',
    '\\bnexus\\s+letters?',
    '\\bindependent\\s+medical\\s+opinions?',
    '\\bDBQs?\\b',
    '\\bdisability\\s+benefits\\s+questionnaires?',
    '\\bc\\s?&\\s?p\\s+exams?\\s+(prep|preparation|coaching|help|training)',
    '\\bva\\s+(disability\\s+)?(claims?|appeals?)\\s+(lawyers?|attorneys?|law\\s+firms?)',
    '\\bva\\s+claims\\s+insider\\b',
    '\\btrajector\\b',
    '\\bveterans?\\s+guardian\\b',
    '\\bveterans?\\s+benefits?\\s+guide\\b',
    '\\bree\\s+medical\\b',
  ].join('|'),
  'i',
);

/** Sites of companies that sell help with VA claims or ratings. */
const CLAIM_HELP_HOSTS =
  /(^|\.)(vaclaimsinsider\.com|trajector\.com|trajectormedical\.com|veteransguardian\.com|veteranguardian\.com|vbg\.com|reemedical\.com)$/i;

/** Why a listing looks like paid VA claim help, or null if it doesn't. */
export function claimHelpReason(deal   
                
                   
                   
                      
                        
                            
                               
 )                {
  for (const url of [deal.sourceUrl, deal.affiliateUrl]) {
    if (url && CLAIM_HELP_HOSTS.test(hostOf(url))) return `links to ${hostOf(url)}, a company that sells help with VA claims`;
  }
  const text = [deal.name, deal.summary, deal.details, deal.howToClaim, deal.notes].filter(Boolean).join(' ');
  const m = CLAIM_HELP.exec(text);
  return m ? `mentions "${m[0]}"` : null;
}

const VA_RATING_WORDS =
  /\b(VA (disability )?(rating|claims?|compensation)|disability (rating|compensation)|service[- ]connected|rated (at )?\d{1,3}\s?%|\d{1,3}\s?%\s*(or higher |or more |\+ ?)?(disabled|disability|service-connected|rating|rated)|permanent and total|P&T\b|TDIU|IU[- ]rated|unemployab)/i;

/**
 * True when a listing is a VA benefit or depends on a VA disability rating. These get the
 * "we don't help with VA claims or ratings" notice.
 */
export function isVaClaimRelated(
  deal                                                                                                     ,
)          {
  const host = hostOf(deal.sourceUrl);
  if (host === 'va.gov' || host.endsWith('.va.gov')) return true;
  return VA_RATING_WORDS.test([deal.name, deal.summary, deal.details, deal.howToClaim, deal.notes ?? ''].join(' '));
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
  const government = isGovernmentUrl(sourceUrl);
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
    // Financial brands and government programs never use affiliate links.
    affiliateUrl: financial || government ? null : safeHttpsUrl(o.affiliateUrl),
    lastConfirmed,
    status,
    seasonal: o.seasonal === true,
    expires,
    verification: str(o.verification, 60) || null,
    audience,
    notes,
    financial,
    government,
    keywords,
    recheckTier: parseRecheckTier(o.recheckTier) ?? 'normal',
  };

  // Never list paid help with VA claims or ratings, even if it arrives in remote data.
  if (claimHelpReason(deal)) return null;

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
  statuses: [],
  audiences: [],
  freeOnly: false,
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
 * For several picked statuses, the best answer wins: someone who is both a veteran and a
 * military spouse qualifies if either one does. "yes" beats "unknown" beats "no".
 */
export function eligibilityFor(deal      , statuses             )                     {
  if (!statuses.length) return null;
  let best              = 'no';
  for (const k of statuses) {
    const e = deal.eligibility[k];
    if (e === 'yes') return 'yes';
    if (e === 'unknown') best = 'unknown';
  }
  return best;
}

/** True when the deal's headline is FREE (free items, free admission, free services...). */
export function isFree(deal                       )          {
  return headlineOf(deal)?.big === 'FREE';
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
    if (filters.audiences.length && !filters.audiences.some((a) => d.audience.includes(a))) return false;
    if (filters.freeOnly && !isFree(d)) return false;
    const e = eligibilityFor(d, filters.statuses);
    if (e === 'no') return false;
    if (filters.confirmedOnly && e === 'unknown') return false;
    return true;
  });
}

/** Tags that at least one current deal has, in display order. Empty tags are hidden in the app. */
export function audiencesOf(deals        )                {
  return AUDIENCE_TAGS.filter((a) => deals.some((d) => d.audience.includes(a)));
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
