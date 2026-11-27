// Deals page for armedforcesperks.com.
//
// Reads the same public deal list the app downloads (/data/deals.json, refreshed nightly from
// the master sheet) and uses the app's own rules to check, filter, search and label deals
// (deals-lib.js and search.js are copied from the app). Everything runs in the browser:
// no cookies, no storage, no trackers, nothing sent anywhere. Filter choices live only in
// the page address, so a filtered list or a single deal can be shared as a link.
//
// Every value from the deal list is put on the page as plain text (textContent), never as
// HTML, and only plain https:// links are used (checked by parseDeal in deals-lib.js).

import {
  categoriesOf,
  checkDealsFile,
  filterDeals,
  formatDate,
  formatMonth,
  headlineOf,
  hostOf,
  isExpired,
  sortDeals,
  STATUS_OPTIONS,
  todayIso,
} from './deals-lib.js';
import { buildIndex, searchDeals } from './search.js';

window.afpDealsStarted = true;

const PAGE_SIZE = 40;
const EMAIL = 'armedforcesperks@gmail.com';
const PAID_LINK_BADGE = 'Paid link';
const PAID_LINK_NOTICE = 'Paid link: we earn a commission if you buy. You pay nothing extra.';
const GOVERNMENT_NOTICE =
  'Armed Forces Perks is not a government website and does not represent any government agency. This summary is based on the official government source linked below. Check that source for the full, current rules.';
const FINANCIAL_NOTICE =
  'Financial or insurance product. Shown as a plain link to the official site for information only. We do not recommend, compare or earn money from financial products.';
const ELIG_TEXT = { yes: 'Yes', no: 'No', unknown: 'Not stated' };
const STATUS_WORDS = {
  activeDuty: 'active duty',
  guardReserve: 'Guard and Reserve',
  veteran: 'veterans',
  retiree: 'retirees',
  family: 'spouses and families',
};
const DEAL_HASH = /^#(AFP-\d{4,})$/;

const $ = (id) => document.getElementById(id);
const els = {
  filters: $('filters'),
  q: $('q'),
  status: $('status'),
  cat: $('cat'),
  confirmed: $('confirmed'),
  hideReview: $('hide-review'),
  reset: $('reset'),
  count: $('count'),
  updated: $('updated'),
  note: $('search-note'),
  list: $('deal-list'),
  more: $('more'),
  error: $('load-error'),
};

let deals = [];
let byId = new Map();
let index = null;
let results = [];
let shown = 0;
let today = todayIso();
const filters = { query: '', status: null, category: null, audience: null, confirmedOnly: false, hideNeedsReview: false };

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  // Simple outline icons (drawn here, no icon font or outside file).
  tag: 'M3 12.5V4a1 1 0 0 1 1-1h8.5L21 11.5 12.5 20 3 12.5Z M7.5 7.5h.01',
  gov: 'M3 9.5 12 4l9 5.5 M5 10v8 M9.5 10v8 M14.5 10v8 M19 10v8 M3 20.5h18',
};
function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'deal-icon');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

function plural(n, one, many) {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// Wording shared with the app
// ---------------------------------------------------------------------------

/** "Up to 15 percent off", for screen readers. */
function headlineLabel(h) {
  if (!h) return '';
  const big = h.big.replace('%+', ' percent or more').replace('%', ' percent');
  if (h.small === 'UP TO') return `Up to ${big}`;
  return [big, h.small.toLowerCase()].filter(Boolean).join(' ');
}

/** Button text, the same as the app: "Get 15% off at nike.com". */
function ctaLabel(deal, host) {
  if (deal.government) return `Open official source at ${host}`;
  const h = headlineOf(deal);
  if (!h) return `Get this deal at ${host}`;
  if (h.big === 'FREE') return `Get it free at ${host}`;
  const amount = h.small === 'UP TO' ? `up to ${h.big}` : h.big;
  const rest = h.small && h.small !== 'UP TO' ? ` ${h.small.toLowerCase()}` : '';
  return `Get ${amount}${rest} at ${host}`;
}

// The website never uses affiliate links: every deal button goes straight to the business's own
// page, even when the deal list has an affiliate link for the app. GitHub Pages isn't meant for
// sites built around commercial transactions, so affiliate links stay in the app (rule 7 in
// the app repo's docs/LEGAL-COMPLIANCE.md). Before turning this on, move the site to a host
// that allows commercial sites and update the privacy policy, terms, disclosures and footers.
const WEBSITE_AFFILIATE_LINKS = false;

function usesAffiliate(deal) {
  // Financial brands always get the plain official link (parseDeal already enforces this too).
  return WEBSITE_AFFILIATE_LINKS && !!deal.affiliateUrl && !deal.financial;
}

// ---------------------------------------------------------------------------
// Deal card
// ---------------------------------------------------------------------------

function discountBlock(deal) {
  const h = headlineOf(deal);
  const block = el('div', { class: 'deal-amt', 'aria-hidden': 'true' });
  if (!h) {
    block.append(icon(deal.government ? 'gov' : 'tag'));
    return block;
  }
  const top = h.small === 'UP TO';
  if (top) block.append(el('span', { class: 'amt-small', text: 'UP TO' }));
  block.append(el('span', { class: h.big.length > 4 ? 'amt-big amt-long' : 'amt-big', text: h.big }));
  if (h.small && !top) block.append(el('span', { class: 'amt-small', text: h.small }));
  return block;
}

function badge(tone, text) {
  return el('li', { class: `badge badge-${tone}`, text });
}

function dealCard(deal) {
  const status = filters.status ? STATUS_OPTIONS.find((o) => o.key === filters.status) : null;
  const elig = status ? deal.eligibility[status.key] : null;
  const h = headlineOf(deal);
  const headingId = `${deal.id}-name`;

  const badges = el('ul', { class: 'badges', 'aria-label': 'Deal labels' });
  if (deal.status === 'live') badges.append(badge('ok', `✓ Verified ${formatMonth(deal.lastConfirmed)}`));
  else badges.append(badge('warn', '⚠ Needs review'));
  if (status && elig === 'unknown') badges.append(badge('neutral', `${status.short}: not stated`));
  if (deal.expires && isExpired(deal, today)) badges.append(badge('warn', `Ended ${formatDate(deal.expires)}`));
  else if (deal.expires) badges.append(badge('neutral', `Ends ${formatDate(deal.expires)}`));
  if (deal.seasonal) badges.append(badge('neutral', 'Seasonal'));
  if (deal.government) badges.append(badge('info', 'Government program'));
  if (usesAffiliate(deal)) badges.append(badge('paid', PAID_LINK_BADGE));

  const details = el(
    'details',
    { class: 'deal-more' },
    el('summary', { 'aria-describedby': headingId }, 'Details and how to get it'),
  );
  details.addEventListener('toggle', () => {
    if (details.open && !details.dataset.built) {
      details.dataset.built = '1';
      details.append(dealDetails(deal));
    }
  });

  return el(
    'li',
    { class: 'deal', id: deal.id },
    discountBlock(deal),
    el(
      'div',
      { class: 'deal-body' },
      el('p', { class: 'deal-cat', text: deal.category }),
      el('h3', { class: 'deal-name', id: headingId }, deal.name),
      h ? el('p', { class: 'visually-hidden', text: headlineLabel(h) }) : null,
      el('p', { class: 'deal-sum', text: deal.summary }),
      badges,
    ),
    details,
  );
}

function dealDetails(deal) {
  const live = deal.status === 'live';
  const host = hostOf(deal.sourceUrl);
  const affiliate = usesAffiliate(deal);
  const url = affiliate ? deal.affiliateUrl : deal.sourceUrl;
  const box = el('div', { class: 'deal-detail' });

  box.append(
    el(
      'div',
      { class: live ? 'trust trust-ok' : 'trust trust-warn' },
      el('p', { class: 'trust-title', text: live ? `Verified ${formatDate(deal.lastConfirmed)}` : 'Needs review' }),
      el('p', {
        text: live
          ? `Checked against ${host}. Offers can change, so confirm before you buy.`
          : `We couldn't confirm every detail on ${host} (last checked ${formatDate(deal.lastConfirmed)}). Check with the business before you rely on it.`,
      }),
    ),
  );

  if (deal.expires && isExpired(deal, today)) {
    box.append(
      el('p', {
        class: 'notice notice-warn',
        text: `This deal ended ${formatDate(deal.expires)}, so it's hidden from the deal list. Check the business's page in case it came back.`,
      }),
    );
  }
  if (deal.details) box.append(el('p', { text: deal.details }));

  // Who qualifies
  const table = el('table', { class: 'elig' });
  table.append(el('caption', { text: 'Who qualifies' }));
  const body = el('tbody');
  for (const o of STATUS_OPTIONS) {
    const e = deal.eligibility[o.key];
    body.append(el('tr', null, el('th', { scope: 'row', text: o.label }), el('td', { class: `elig-${e}`, text: ELIG_TEXT[e] })));
  }
  table.append(body);
  box.append(
    el('h4', { text: 'Who qualifies' }),
    el('div', { class: 'table-scroll' }, table),
    el('p', { class: 'small', text: '"Not stated" means the business\'s page doesn\'t say. The business decides who qualifies.' }),
  );

  // How to get it
  box.append(el('h4', { text: 'How to get it' }));
  box.append(el('p', { text: deal.howToClaim || "See the business's page." }));
  const facts = el('ul', { class: 'facts' });
  if (deal.where) facts.append(el('li', { text: deal.where === 'Both' ? 'Online and in store' : deal.where }));
  if (deal.scope) facts.append(el('li', { text: deal.scope }));
  if (deal.verification && deal.verification !== 'Unknown') {
    facts.append(el('li', { text: deal.verification === 'None' ? 'No proof needed' : `Proof: ${deal.verification}` }));
  }
  if (deal.expires) facts.append(el('li', { text: `Ends ${formatDate(deal.expires)}` }));
  if (deal.seasonal) facts.append(el('li', { text: 'Seasonal offer' }));
  if (facts.childElementCount) box.append(facts);

  if (deal.notes) box.append(el('h4', { text: 'Good to know' }), el('p', { text: deal.notes }));

  if (deal.government) {
    box.append(el('div', { class: 'notice notice-info' }, el('strong', null, 'Government program. '), GOVERNMENT_NOTICE));
  }
  if (deal.financial) box.append(el('div', { class: 'notice' }, FINANCIAL_NOTICE));

  // The link. FTC: the paid-link disclosure sits right above the button, before the click.
  const cta = el('div', { class: 'cta' });
  if (affiliate) cta.append(el('p', { class: 'paid', text: PAID_LINK_NOTICE }));
  cta.append(
    el(
      'a',
      {
        class: 'btn btn-deal',
        href: url,
        target: '_blank',
        rel: affiliate ? 'sponsored noopener' : 'noopener',
      },
      `${ctaLabel(deal, host)} `,
      el('span', { 'aria-hidden': 'true', text: '↗' }),
      el('span', { class: 'visually-hidden', text: ' (opens in a new tab)' }),
    ),
  );
  cta.append(
    el('p', {
      class: 'small',
      text: affiliate ? `Opens ${host} in a new tab, through a tracking link.` : `Opens ${host} in a new tab.`,
    }),
  );
  box.append(cta);

  const subject = `Deal fix: ${deal.name} (${deal.id})`;
  const mailBody = `${deal.name} (deal ${deal.id}, last verified ${deal.lastConfirmed}): `;
  box.append(
    el(
      'p',
      { class: 'deal-links small' },
      el('a', { href: `mailto:${EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(mailBody)}` }, 'Deal wrong? Tell us'),
      ' · ',
      el('a', { href: `#${deal.id}` }, 'Link to this deal'),
    ),
    el('p', {
      class: 'small muted',
      text: `Business names belong to their owners and don't mean they endorse us. Deal ID ${deal.id}.`,
    }),
  );
  return box;
}

// ---------------------------------------------------------------------------
// Filtering, rendering, address bar
// ---------------------------------------------------------------------------

function compute() {
  const filtered = filterDeals(deals, filters, today);
  const q = filters.query.trim();
  if (!q) return { list: sortDeals(filtered, today), search: null };
  const search = searchDeals(index, q);
  const ok = new Map(filtered.map((d) => [d.id, d]));
  return { list: search.ids.map((id) => ok.get(id)).filter(Boolean), search };
}

function render({ keepShown = false } = {}) {
  const { list, search } = compute();
  results = list;
  const target = keepShown ? Math.max(shown, PAGE_SIZE) : PAGE_SIZE;
  shown = Math.min(target, results.length);
  els.list.replaceChildren(...results.slice(0, shown).map(dealCard));
  updateMore();
  updateCount();
  updateSearchNote(search);
}

function updateMore() {
  const left = results.length - shown;
  els.more.hidden = left <= 0;
  els.more.textContent = `Show more deals (${left.toLocaleString('en-US')} more)`;
}

function updateCount() {
  const total = results.length;
  const parts = [];
  if (filters.status) parts.push(`for ${STATUS_WORDS[filters.status]}`);
  if (filters.category) parts.push(`in ${filters.category}`);
  if (filters.query.trim()) parts.push(`matching "${filters.query.trim()}"`);
  els.count.textContent = `${plural(total, 'deal', 'deals')}${parts.length ? ' ' + parts.join(' ') : ''}`;
}

function updateSearchNote(search) {
  els.note.replaceChildren();
  els.note.hidden = true;
  if (!search) return;
  const fixes = Object.entries(search.corrected);
  if (results.length && fixes.length) {
    els.note.append(`Showing results for ${fixes.map(([, to]) => `"${to}"`).join(', ')}.`);
    els.note.hidden = false;
    return;
  }
  if (!results.length) {
    if (search.ids.length) {
      els.note.append('Your search found deals, but your filters hide them. ');
      els.note.append(el('button', { type: 'button', class: 'btn-plain', 'data-action': 'clear-filters' }, 'Clear filters'));
    } else {
      els.note.append('No deals match that search. Try a store name or a thing, like "boots" or "hotel".');
      if (search.suggestions.length) {
        els.note.append(' Or browse: ');
        search.suggestions.forEach((cat, i) => {
          if (i) els.note.append(', ');
          els.note.append(el('button', { type: 'button', class: 'btn-plain', 'data-cat': cat }, cat));
        });
      }
    }
    els.note.hidden = false;
  }
}

function readUrl() {
  const p = new URLSearchParams(location.search);
  filters.query = (p.get('q') || '').slice(0, 80);
  const s = p.get('for');
  filters.status = STATUS_OPTIONS.some((o) => o.key === s) ? s : null;
  const c = p.get('category');
  filters.category = c && deals.some((d) => d.category === c) ? c : null;
  filters.confirmedOnly = !!filters.status && p.get('confirmed') === '1';
  filters.hideNeedsReview = p.get('hidereview') === '1';
}

function writeUrl() {
  const p = new URLSearchParams();
  if (filters.query.trim()) p.set('q', filters.query.trim());
  if (filters.status) p.set('for', filters.status);
  if (filters.category) p.set('category', filters.category);
  if (filters.confirmedOnly) p.set('confirmed', '1');
  if (filters.hideNeedsReview) p.set('hidereview', '1');
  const qs = p.toString();
  history.replaceState(null, '', `${location.pathname}${qs ? '?' + qs : ''}${location.hash}`);
}

function syncControls() {
  els.q.value = filters.query;
  els.status.value = filters.status || '';
  els.cat.value = filters.category || '';
  els.confirmed.disabled = !filters.status;
  els.confirmed.checked = filters.confirmedOnly;
  els.hideReview.checked = filters.hideNeedsReview;
}

function changed() {
  filters.confirmedOnly = !!filters.status && filters.confirmedOnly;
  syncControls();
  writeUrl();
  render();
}

/** Opens a deal from a link like /deals.html#AFP-0001, clearing filters if they hide it. */
function openFromHash() {
  const m = DEAL_HASH.exec(location.hash);
  if (!m || !byId.has(m[1])) return;
  const id = m[1];
  if (!results.some((d) => d.id === id)) {
    Object.assign(filters, { query: '', status: null, category: null, confirmedOnly: false, hideNeedsReview: false });
    syncControls();
    writeUrl();
    render();
  }
  let at = results.findIndex((d) => d.id === id);
  if (at === -1) {
    // Ended deals are hidden from the list; show the one that was linked at the top.
    results = [byId.get(id), ...results];
    at = 0;
    els.list.prepend(dealCard(byId.get(id)));
    shown += 1;
  } else if (at >= shown) {
    els.list.append(...results.slice(shown, at + 1).map(dealCard));
    shown = at + 1;
    updateMore();
  }
  const card = document.getElementById(id);
  const details = card.querySelector('details');
  details.open = true;
  card.scrollIntoView({ block: 'start' });
  card.querySelector('summary').focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

function fillSelects() {
  for (const o of STATUS_OPTIONS) els.status.append(el('option', { value: o.key }, o.label));
  for (const c of categoriesOf(deals)) els.cat.append(el('option', { value: c }, c));
}

function wire() {
  let timer = 0;
  // Any change also picks up words still being typed, so a quick filter change never loses them.
  const takeQuery = () => {
    clearTimeout(timer);
    filters.query = els.q.value.slice(0, 80);
  };
  els.q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      filters.query = els.q.value.slice(0, 80);
      changed();
    }, 200);
  });
  els.q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      takeQuery();
      changed();
    }
  });
  els.status.addEventListener('change', () => {
    takeQuery();
    filters.status = els.status.value || null;
    changed();
  });
  els.cat.addEventListener('change', () => {
    takeQuery();
    filters.category = els.cat.value || null;
    changed();
  });
  els.confirmed.addEventListener('change', () => {
    takeQuery();
    filters.confirmedOnly = els.confirmed.checked;
    changed();
  });
  els.hideReview.addEventListener('change', () => {
    takeQuery();
    filters.hideNeedsReview = els.hideReview.checked;
    changed();
  });
  els.reset.addEventListener('click', () => {
    clearTimeout(timer);
    Object.assign(filters, { query: '', status: null, category: null, confirmedOnly: false, hideNeedsReview: false });
    changed();
    els.q.focus();
  });
  els.note.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    takeQuery();
    if (btn.dataset.cat) {
      filters.query = '';
      filters.category = btn.dataset.cat;
    } else if (btn.dataset.action === 'clear-filters') {
      Object.assign(filters, { status: null, category: null, confirmedOnly: false, hideNeedsReview: false });
    }
    changed();
  });
  els.more.addEventListener('click', () => {
    const first = shown;
    shown = Math.min(shown + PAGE_SIZE, results.length);
    els.list.append(...results.slice(first, shown).map(dealCard));
    updateMore();
    // Keep keyboard and screen reader users in place: move focus to the first new deal.
    const next = els.list.children[first];
    if (next) next.querySelector('summary').focus();
  });
  window.addEventListener('hashchange', openFromHash);
}

async function start() {
  try {
    const res = await fetch('/data/deals.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const file = checkDealsFile(await res.json(), '2000-01-01');
    if (!file) throw new Error('Deal list failed its checks');
    deals = file.deals;
    byId = new Map(deals.map((d) => [d.id, d]));
    index = buildIndex(deals);
    today = todayIso();
    els.updated.textContent = `List updated ${formatDate(file.generated)}`;
  } catch (err) {
    console.error('Deals page:', err);
    els.count.textContent = '';
    els.error.hidden = false;
    return;
  }
  fillSelects();
  readUrl();
  syncControls();
  wire();
  els.filters.hidden = false;
  render();
  openFromHash();
}

start();
