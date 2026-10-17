#!/usr/bin/env node
/**
 * Export registry data as a flat JSON list.
 * Usage:
 *   node scripts/export-json.js --pretty --output dist/registry.json
 *   node scripts/export-json.js --pretty > dist/registry.json
 *
 * Fails without writing anything if any entry is invalid.
 */

const fs = require('fs');
const path = require('path');
const { checkCatalog, formatProblems, loadCatalog } = require('./utils/catalog');

function parseArgs(args) {
  const outputFlagIndex = args.findIndex((arg) => arg === '--output');
  const outputPath = outputFlagIndex !== -1 && args[outputFlagIndex + 1]
    ? args[outputFlagIndex + 1]
    : null;
  const pretty = args.includes('--pretty');
  return { outputPath, pretty };
}

function sanitizeArray(value, fallback) {
  if (Array.isArray(value) && value.length > 0) {
    return value;
  }
  return fallback;
}

// type, productId and the original fields keep their names for downstream consumers (opencode.cafe);
// newer fields are additive.
function mapEntry({ category, id, data }) {
  return {
    productId: id,
    type: category,
    displayName: data.name,
    repoUrl: data.repo,
    repoPath: data.path,
    npmPackage: data.npm,
    tagline: data.tagline,
    description: data.description,
    kind: data.kind,
    also: sanitizeArray(data.also, undefined),
    topics: sanitizeArray(data.topics, []),
    compat: data.compat || (category === 'plugins' ? 'unknown' : 'n/a'),
    scope: sanitizeArray(data.scope, ['global']),
    tags: sanitizeArray(data.tags, []),
    homepageUrl: data.homepage,
    installation: data.installation,
    minVersion: data.min_version
  };
}

function stripUndefined(data) {
  const cleaned = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

function main() {
  const { outputPath, pretty } = parseArgs(process.argv.slice(2));
  const log = (...args) => (outputPath ? console.log(...args) : console.error(...args));

  const { entries, errors } = loadCatalog();
  const problems = [...errors, ...checkCatalog(entries)];
  if (problems.length > 0) {
    log(formatProblems(problems));
    throw new Error(`${problems.length} validation problem(s); nothing was exported`);
  }

  const results = entries.map(e => stripUndefined(mapEntry(e)));
  results.sort((a, b) => a.type.localeCompare(b.type) || a.productId.localeCompare(b.productId));

  const json = JSON.stringify(results, null, pretty ? 2 : 0);
  if (outputPath) {
    const outputDir = path.dirname(outputPath);
    if (outputDir && outputDir !== '.') {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(outputPath, json + '\n');
    log(`Saved ${results.length} entries to ${outputPath}`);
  } else {
    process.stdout.write(json);
  }
}

try {
  main();
} catch (err) {
  console.error('Export failed:', err.message);
  process.exit(1);
}
