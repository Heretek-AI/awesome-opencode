#!/usr/bin/env node
/**
 * Rewrite catalog entries in canonical format (key order, safe quoting).
 * Usage: node scripts/fmt.js [--check] [file.yaml ...]
 *
 * --check lists files that would change and exits 1 without writing.
 */

const fs = require('fs');
const path = require('path');
const { loadCatalog, formatProblems } = require('./utils/catalog');
const { dumpEntry } = require('./utils/format');

const ROOT = path.join(__dirname, '..');

function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const only = argv.filter(a => a.endsWith('.yaml')).map(f => path.relative(ROOT, path.resolve(f)));

  const { entries, errors } = loadCatalog();
  if (errors.length) {
    console.error(formatProblems(errors));
    console.error('\nFix the YAML syntax errors above first.');
    process.exit(1);
  }

  const changed = [];
  for (const entry of entries) {
    if (only.length && !only.includes(entry.file)) continue;
    const target = path.join(ROOT, entry.file);
    const formatted = dumpEntry(entry.data);
    if (fs.readFileSync(target, 'utf8') !== formatted) {
      changed.push(entry.file);
      if (!check) fs.writeFileSync(target, formatted);
    }
  }

  if (check && changed.length) {
    console.error(`${changed.length} file(s) are not in canonical format:\n${changed.map(f => `  ${f}`).join('\n')}\nRun: npm run fmt`);
    process.exit(1);
  }
  console.log(check ? '✓ All entries are formatted.' : `✓ Formatted ${changed.length} file(s).`);
}

main();
