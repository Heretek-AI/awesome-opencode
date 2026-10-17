#!/usr/bin/env node

/**
 * Generate README.md from YAML files
 * Loads and validates the whole catalog, groups each category (plugins by primary topic, other
 * categories by kind), and writes README.md. Fails without writing anything if any entry is invalid,
 * so a single bad file can never publish a README with missing sections.
 */

const { CATEGORIES, KINDS, KIND_LABELS, TOPICS, TOPIC_LABELS, V1_SUNSET, checkCatalog, formatProblems, loadCatalog } = require('./utils/catalog');
const { addedDates } = require('./utils/history');
const { escapeHtml, readTemplate, replacePlaceholder, generateEntryHtml, writeReadme } = require('./utils/template');

const RECENT_COUNT = 15;
const README_WARN_KB = 450;

// How each category is subdivided in the README
const GROUP_BY = {
  plugins: { field: 'topic', order: TOPICS, labels: TOPIC_LABELS },
  themes: null,
  agents: { field: 'kind', order: KINDS, labels: KIND_LABELS },
  projects: { field: 'kind', order: KINDS, labels: KIND_LABELS },
  resources: { field: 'kind', order: KINDS, labels: KIND_LABELS }
};

const byName = (a, b) => a.data.name.toLowerCase().localeCompare(b.data.name.toLowerCase());

/**
 * Generate HTML for a single category
 * @param {string} category - Category directory name
 * @param {object[]} entries - Entries in this category
 * @returns {string}
 */
function generateCategorySection(category, entries) {
  const grouping = GROUP_BY[category];
  const render = list => list.sort(byName).map(e => generateEntryHtml(e.data, category)).join('\n\n');
  if (!grouping) return render(entries);

  const groups = new Map(grouping.order.map(key => [key, []]));
  for (const entry of entries) {
    const key = grouping.field === 'topic' ? entry.data.topics[0] : entry.data.kind;
    groups.get(key).push(entry);
  }
  return [...groups]
    .filter(([, list]) => list.length > 0)
    .map(([key, list]) => `<h4>${grouping.labels[key]} <sub>(${list.length})</sub></h4>\n\n${render(list)}`)
    .join('\n\n<br>\n\n');
}

/**
 * One-line catalog summary under the header.
 * @param {object[]} entries
 * @returns {string}
 */
function generateStats(entries) {
  const plugins = entries.filter(e => e.category === 'plugins');
  const count = compat => plugins.filter(e => e.data.compat === compat).length;
  return `<p><b>${entries.length}</b> entries &nbsp;•&nbsp; <b>${plugins.length}</b> plugins: ` +
    `<b>${count('v2')}</b> <code>V2</code>, <b>${count('v1')}</b> <code>V1 only</code> ` +
    `(removed after ${V1_SUNSET}), <b>${count('unknown')}</b> <code>unverified</code></p>`;
}

/**
 * Most recently added entries, from git history.
 * @param {object[]} entries
 * @returns {string}
 */
function generateRecent(entries) {
  const dates = addedDates();
  if (dates.size === 0) return '<p><i>History unavailable.</i></p>';
  const recent = entries
    .filter(e => dates.has(e.file))
    .sort((a, b) => dates.get(b.file).localeCompare(dates.get(a.file)) || byName(a, b))
    .slice(0, RECENT_COUNT);
  const rows = recent.map(e => `| **[${escapeHtml(e.data.name).replace(/\|/g, '\\|')}](${e.data.repo})** | ${e.category} | ${escapeHtml(e.data.tagline).replace(/\|/g, '\\|')} |`);
  return ['| Name | Category | Tagline |', '| :--- | :--- | :--- |', ...rows].join('\n');
}

/**
 * Main function to generate the README
 */
function main() {
  console.log('Starting README generation...\n');

  const { entries, errors } = loadCatalog();
  const problems = [...errors, ...checkCatalog(entries)];
  if (problems.length > 0) {
    console.error(formatProblems(problems));
    throw new Error(`${problems.length} validation problem(s); README.md was not written`);
  }

  let content = readTemplate();
  for (const category of CATEGORIES) {
    const list = entries.filter(e => e.category === category);
    const placeholder = category.toUpperCase();
    content = replacePlaceholder(content, placeholder, generateCategorySection(category, list));
    content = replacePlaceholder(content, `COUNT_${placeholder}`, String(list.length));
    console.log(`  - ${category}: ${list.length} entries`);
  }
  content = replacePlaceholder(content, 'STATS', generateStats(entries));
  content = replacePlaceholder(content, 'RECENT', generateRecent(entries));

  // Every entry must appear exactly once
  const rendered = (content.match(/<details>\n {2}<summary>/g) || []).length;
  if (rendered !== entries.length) {
    throw new Error(`rendered ${rendered} entries but the catalog has ${entries.length}; README.md was not written`);
  }
  if (/\{\{[A-Z_]+\}\}/.test(content)) {
    throw new Error(`unreplaced placeholder ${content.match(/\{\{[A-Z_]+\}\}/)[0]}; README.md was not written`);
  }

  writeReadme(content);
  console.log(`\n✅ Generated README.md with ${entries.length} entries across ${CATEGORIES.length} categories`);
  const kb = Math.round(Buffer.byteLength(content) / 1024);
  if (kb > README_WARN_KB) {
    console.log(`::warning title=README size::README.md is ${kb} KB; GitHub stops rendering large markdown files. Consider trimming descriptions or moving the full list to the site.`);
  }
}

try {
  main();
} catch (err) {
  console.error('\n❌ Generation failed:', err.message);
  process.exit(1);
}
