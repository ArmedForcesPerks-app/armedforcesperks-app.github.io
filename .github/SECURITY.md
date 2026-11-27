# Security policy

This covers armedforcesperks.com and the Armed Forces Perks app, run by Armed Forces Perks LLC.

## Reporting a security problem

Please email **armedforcesperks@gmail.com** with what you found, where, and how to see it. Please
don't open a public issue for a security problem, and don't access anyone else's data or disrupt
the site while testing. We'll reply within a few business days and keep you posted until it's fixed.

The same contact is in [/.well-known/security.txt](https://armedforcesperks.com/.well-known/security.txt).

## How the site stays safe (for anyone changing it)

- The site has no accounts, forms, ads, trackers or outside scripts. Every page uses only the site's
  own files.
- GitHub Pages can't send security headers, so every page starts its `<head>` with a Content
  Security Policy tag and a referrer tag. Copy both from `index.html` for a new page (pages with a
  script also need `script-src 'self'`, like `deals.html`). Inline scripts, `<style>` blocks,
  `style=""` and `onclick=""` are blocked by the policy, so use files in `/assets/`.
- `assets/deals-lib.js` is generated from the app's deal rules. Don't edit it by hand.
- The "Site security check" workflow (`tools/site-security/check.mjs`) checks all of this on every
  pull request, plus the workflows (zizmor). CodeQL also scans the code.
- `/.well-known/security.txt` has to be renewed every year: the check fails 30 days before its
  `Expires:` date. Move the date forward by up to a year.
- Workflows: pin every action to a full commit hash with a `# v4`-style comment, give each job only
  the `permissions:` it needs, and use `persist-credentials: false` on checkout unless the job pushes.
