#!/usr/bin/env node
/**
 * Validate catalog entries.
 * Usage: node scripts/validate.js [file1.yaml] [file2.yaml] ...
 *
 * Always loads the whole catalog so cross-entry rules (duplicate repos) are enforced; when files are
 * given, only problems in those files are reported. Exits 1 on any problem, including unparseable YAML.
 */

const path = require('path');
const { checkCatalog, formatProblems, loadCatalog } = require('./utils/catalog');

const ROOT = path.join(__dirname, '..');

function main() {
  const only = process.argv.slice(2)
    .filter(f => f.endsWith('.yaml'))
    .map(f => path.relative(ROOT, path.resolve(f)));

  const { entries, errors } = loadCatalog();
  const problems = [...errors, ...checkCatalog(entries)]
    .filter(p => only.length === 0 || only.includes(p.file));

  const checked = only.length || entries.length + errors.length;
  if (problems.length > 0) {
    console.error(formatProblems(problems));
    console.error(`\n✗ ${new Set(problems.map(p => p.file)).size} of ${checked} file(s) failed validation.`);
    process.exit(1);
  }
  console.log(`✓ All ${checked} file(s) passed validation.`);
}

main();
