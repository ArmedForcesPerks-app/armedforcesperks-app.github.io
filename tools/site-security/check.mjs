#!/usr/bin/env node
/**
 * Security check for the website's pages. The "Site security check" workflow runs it on every
 * pull request, every change to main, and every Monday.
 *
 * Every .html page must:
 *  - start its <head> with the Content Security Policy tag, before any stylesheet or script, and
 *    the policy may only allow the site's own files ('self'): no outside scripts, styles, fonts,
 *    images or trackers, no inline code, no eval, no plain HTTP;
 *  - say default-src 'none', base-uri 'none' and form-action 'none';
 *  - send only the site's address, not the page, to other websites (referrer tag);
 *  - have no inline <script> or <style> blocks, no style="" attributes and no onclick-style
 *    attributes (the policy blocks them, so they would silently stop working);
 *  - load scripts and stylesheets only from this site, and use no http:// links.
 *
 * /.well-known/security.txt must exist, name a contact, and not expire within 30 days.
 *
 * GitHub Pages can't send security headers, so these tags are how the site gets them.
 * Usage: node tools/site-security/check.mjs   (from the repo root)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Referrer settings that never send the full page address to other websites. */
const SAFE_REFERRER = new Set(['no-referrer', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin']);

/** Days before security.txt expires that the check starts failing, so there's time to renew it. */
export const RENEW_DAYS = 30;

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1].toLowerCase()] = m[2] ?? m[3];
  return out;
}

/** Browsers use the first copy of a directive and ignore later ones, so this does too. */
function parsePolicy(text) {
  const policy = new Map();
  const repeated = [];
  for (const part of text.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (!name) continue;
    if (policy.has(name.toLowerCase())) repeated.push(name.toLowerCase());
    else policy.set(name.toLowerCase(), sources);
  }
  return { policy, repeated };
}

/** Same site only: "/x", "x" or "./x", never "//host", "https:" or another scheme. */
function isOwnFile(url) {
  return !/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(url.trim());
}

/**
 * Returns the problems with one page (empty when it's fine).
 * @param {string} html the page
 */
export function checkPage(html) {
  const problems = [];
  const tags = [...html.matchAll(/<(meta|link|script|style)\b[^>]*>/gi)];
  const cspIndex = tags.findIndex((t) => /http-equiv\s*=\s*["']Content-Security-Policy["']/i.test(t[0]));

  if (cspIndex === -1) {
    problems.push('No Content Security Policy tag. Copy the two security tags from the top of index.html.');
  } else {
    const firstResource = tags.findIndex((t) => /^<(link|script|style)/i.test(t[0]));
    if (firstResource !== -1 && firstResource < cspIndex) {
      problems.push('The Content Security Policy tag must come before every stylesheet and script.');
    }
    const { policy, repeated } = parsePolicy(attrs(tags[cspIndex][0]).content ?? '');
    for (const name of repeated) problems.push(`The policy lists ${name} twice. Browsers use only the first one.`);
    for (const [name, wanted] of [['default-src', "'none'"], ['base-uri', "'none'"], ['form-action', "'none'"]]) {
      if (policy.get(name)?.join(' ') !== wanted) problems.push(`The policy needs ${name} ${wanted}.`);
    }
    for (const [name, sources] of policy) {
      for (const source of sources) {
        if (source !== "'self'" && source !== "'none'") {
          problems.push(`The policy allows ${source} for ${name}. Only the site's own files ('self') are allowed.`);
        }
      }
    }
  }

  const referrer = tags.find((t) => /name\s*=\s*["']referrer["']/i.test(t[0]));
  if (!referrer || !SAFE_REFERRER.has((attrs(referrer[0]).content ?? '').toLowerCase())) {
    problems.push('No referrer tag (<meta name="referrer" content="strict-origin-when-cross-origin">).');
  }

  for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
    const a = attrs(m[0]);
    if (a.src === undefined) {
      if ((a.type ?? '').toLowerCase() !== 'application/ld+json') problems.push('Inline <script> code. Move it into a file under /assets/.');
    } else if (!isOwnFile(a.src)) {
      problems.push(`Script from another website: ${a.src}`);
    }
  }
  if (/<style\b/i.test(html)) problems.push('A <style> block. Move the styles into /assets/style.css.');
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if (a.href !== undefined && /\b(stylesheet|icon|preload|modulepreload|manifest)\b/i.test(a.rel ?? '') && !isOwnFile(a.href)) {
      problems.push(`File from another website: ${a.href}`);
    }
  }
  for (const m of html.matchAll(/<[a-z][^>]*>/gi)) {
    const tag = m[0];
    if (/\sstyle\s*=/i.test(tag)) problems.push(`A style="" attribute (${tag.slice(0, 60)}). Use a class in /assets/style.css.`);
    const handler = /\s(on[a-z]+)\s*=/i.exec(tag);
    if (handler) problems.push(`An ${handler[1]}="" attribute. Add the behavior in a script file instead.`);
    for (const url of tag.matchAll(/\s(?:href|src|action|formaction|srcset|poster|data)\s*=\s*["']\s*(http:[^"']*)/gi)) {
      problems.push(`Plain HTTP link: ${url[1]}`);
    }
  }
  return problems;
}

/**
 * Returns the problems with security.txt (empty when it's fine).
 * @param {string} text the file
 * @param {Date} now
 */
export function checkSecurityTxt(text, now = new Date()) {
  const problems = [];
  const field = (name) => new RegExp(`^${name}:\\s*(\\S.*)$`, 'im').exec(text)?.[1].trim();
  if (!/^mailto:\S+@\S+$|^https:\/\/\S+$/i.test(field('Contact') ?? '')) problems.push('security.txt needs a Contact: line (mailto: or https:).');
  const expires = Date.parse(field('Expires') ?? '');
  if (Number.isNaN(expires)) {
    problems.push('security.txt needs an Expires: date like 2027-11-01T00:00:00.000Z.');
  } else if (expires - now.getTime() < RENEW_DAYS * 86400000) {
    problems.push(`security.txt expires on ${new Date(expires).toISOString().slice(0, 10)}. Move its Expires: date forward by up to a year.`);
  }
  if (field('Canonical') !== 'https://armedforcesperks.com/.well-known/security.txt') {
    problems.push('security.txt needs Canonical: https://armedforcesperks.com/.well-known/security.txt');
  }
  return problems;
}

/** Every .html page of the site, apart from the tools and data folders. */
export function sitePages(root) {
  const pages = [];
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    const path = join(entry.parentPath ?? entry.path, entry.name);
    const rel = relative(root, path).split('\\').join('/');
    if (entry.isFile() && rel.endsWith('.html') && !/^(\.git|tools|data|node_modules)\//.test(rel)) pages.push(rel);
  }
  return pages.sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd();
  const problems = [];
  const pages = sitePages(root);
  for (const page of pages) {
    for (const p of checkPage(readFileSync(join(root, page), 'utf8'))) problems.push(`${page}: ${p}`);
  }
  let securityTxt = '';
  try {
    securityTxt = readFileSync(join(root, '.well-known/security.txt'), 'utf8');
  } catch {
    problems.push('.well-known/security.txt is missing.');
  }
  if (securityTxt) for (const p of checkSecurityTxt(securityTxt)) problems.push(`.well-known/security.txt: ${p}`);

  if (problems.length) {
    for (const p of problems) console.error(`::error::${p}`);
    process.exit(1);
  }
  console.log(`Site security check passed: ${pages.length} pages have the security tags and load only the site's own files, and security.txt is current.`);
}
