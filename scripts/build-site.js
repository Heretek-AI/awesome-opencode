#!/usr/bin/env node
/**
 * Build the static search site into _site/.
 * Usage: node scripts/build-site.js [--health <health.json>]
 *
 * Copies site/ and writes _site/registry.json from the catalog. health.json comes from
 * `node scripts/health-check.js --out _site/health.json` (the site works without it).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '_site');

fs.mkdirSync(OUT, { recursive: true });
for (const file of fs.readdirSync(path.join(ROOT, 'site'))) {
  fs.copyFileSync(path.join(ROOT, 'site', file), path.join(OUT, file));
}
execFileSync(process.execPath, [path.join(__dirname, 'export-json.js'), '--output', path.join(OUT, 'registry.json')], { stdio: 'inherit' });

const argv = process.argv.slice(2);
if (argv.includes('--health')) {
  fs.copyFileSync(path.resolve(argv[argv.indexOf('--health') + 1]), path.join(OUT, 'health.json'));
}
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
console.log(`Built site in ${path.relative(ROOT, OUT)}/`);
