// Official sources page for armedforcesperks.com.
//
// Lists every government and military program in the public deal list (/data/deals.json, the
// same file the app downloads) with a link to its official source. Uses the app's own rules
// (deals-lib.js): a listing counts as a government program when its source is a .gov or .mil
// site or an official military program site (isGovernmentUrl). Everything runs in the browser
// and every value goes on the page as plain text. No cookies, storage or trackers.

import { checkDealsFile, formatDate, hostOf, recheckGroup } from './deals-lib.js';

const GROUPS = [
  { key: 'federal', title: 'VA and federal programs' },
  { key: 'state', title: 'State and local programs' },
];

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

async function start() {
  const status = document.getElementById('sources-status');
  const out = document.getElementById('sources-list');
  let file;
  try {
    const res = await fetch('/data/deals.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    file = checkDealsFile(await res.json(), '2000-01-01');
    if (!file) throw new Error('Deal list failed its checks');
  } catch (err) {
    console.error('Sources page:', err);
    status.textContent = 'The list could not be loaded. Please try again later, or browse the programs on the Deals page.';
    return;
  }
  const programs = file.deals
    .filter((d) => d.government)
    .sort((a, b) => a.name.localeCompare(b.name, 'en-US'));
  status.textContent = `${programs.length.toLocaleString('en-US')} programs. List updated ${formatDate(file.generated)}.`;
  for (const g of GROUPS) {
    const items = programs.filter((d) => recheckGroup(d) === g.key);
    if (!items.length) continue;
    const list = el('ul', { class: 'sources-list' });
    for (const d of items) {
      list.append(
        el(
          'li',
          {},
          el('strong', { text: d.name }),
          ': ',
          el('a', { class: 'src', href: d.sourceUrl, rel: 'noopener' }, hostOf(d.sourceUrl)),
          el('span', { class: 'muted', text: ` (checked ${formatDate(d.lastConfirmed)}) ` }),
          el('a', { href: `/deals.html#${d.id}`, 'aria-label': `${d.name} on the Deals page` }, 'Details'),
        ),
      );
    }
    out.append(el('h3', { text: `${g.title} (${items.length})` }), list);
  }
}

start();
