// Tests for check.mjs. Run: node --test tools/site-security/test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkPage, checkSecurityTxt, sitePages } from './check.mjs';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const index = read('index.html');
const deals = read('deals.html');

test('every page of the site passes', () => {
  const pages = sitePages(fileURLToPath(root));
  assert.ok(pages.includes('index.html') && pages.includes('deals.html') && pages.includes('404.html'));
  for (const page of pages) assert.deepEqual(checkPage(read(page)), [], page);
});

test('a page without the security tags fails', () => {
  const bare = index.replace(/ *<meta http-equiv="Content-Security-Policy"[^>]*>\n/, '').replace(/ *<meta name="referrer"[^>]*>\n/, '');
  const problems = checkPage(bare).join('\n');
  assert.match(problems, /No Content Security Policy/);
  assert.match(problems, /No referrer tag/);
});

test('a policy that lets in outside or inline code fails', () => {
  for (const loose of ["script-src 'self' https://cdn.example.com", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "connect-src *"]) {
    const page = deals.replace("script-src 'self'", loose.startsWith('script-src') ? loose : `script-src 'self'; ${loose}`);
    assert.match(checkPage(page).join('\n'), /Only the site's own files/, loose);
  }
  assert.match(checkPage(deals.replace("script-src 'self';", "script-src 'self'; style-src 'self' 'unsafe-inline';")).join('\n'), /style-src twice/);
  assert.match(checkPage(index.replace("default-src 'none'", "default-src 'self'")).join('\n'), /default-src 'none'/);
  assert.match(checkPage(index.replace(" base-uri 'none';", '')).join('\n'), /base-uri 'none'/);
});

test('the policy tag has to come before the stylesheet', () => {
  const csp = / *<meta http-equiv="Content-Security-Policy"[^>]*>\n/.exec(index)[0];
  const late = index.replace(csp, '').replace('</head>', `${csp}</head>`);
  assert.match(checkPage(late).join('\n'), /must come before/);
});

test('inline code, inline styles, outside files and plain HTTP links fail', () => {
  const add = (html) => index.replace('</body>', `${html}</body>`);
  assert.match(checkPage(add('<script>alert(1)</script>')).join('\n'), /Inline <script>/);
  assert.deepEqual(checkPage(add('<script type="application/ld+json">{}</script>')), []);
  assert.match(checkPage(add('<script src="https://cdn.example.com/x.js"></script>')).join('\n'), /Script from another website/);
  assert.match(checkPage(add('<script src="//cdn.example.com/x.js"></script>')).join('\n'), /Script from another website/);
  assert.deepEqual(checkPage(add('<script src="/assets/x.js" defer></script>')), []);
  assert.match(checkPage(index.replace('</head>', '<link rel="stylesheet" href="https://fonts.example.com/a.css"></head>')).join('\n'), /another website/);
  assert.match(checkPage(add('<style>p{color:red}</style>')).join('\n'), /<style> block/);
  assert.match(checkPage(add('<p style="color:red">x</p>')).join('\n'), /style="" attribute/);
  assert.match(checkPage(add('<button onclick="go()">x</button>')).join('\n'), /onclick/);
  assert.match(checkPage(add('<a href="http://example.com/">x</a>')).join('\n'), /Plain HTTP link/);
  assert.deepEqual(checkPage(add('<a href="https://example.com/">x</a><a href="mailto:a@example.com">y</a>')), []);
});

test('security.txt needs a contact and renewing at least 30 days before it expires', () => {
  const txt = read('.well-known/security.txt');
  const expires = new Date(/^Expires:\s*(\S+)/m.exec(txt)[1]);
  const daysBefore = (days) => new Date(expires.getTime() - days * 86400000);
  assert.deepEqual(checkSecurityTxt(txt, daysBefore(60)), []);
  assert.match(checkSecurityTxt(txt, daysBefore(10)).join('\n'), /expires on/);
  assert.match(checkSecurityTxt(txt.replace(/^Contact:.*$/m, ''), daysBefore(60)).join('\n'), /Contact/);
  assert.match(checkSecurityTxt(txt.replace(/^Expires:.*$/m, 'Expires: soon'), daysBefore(60)).join('\n'), /Expires/);
});
