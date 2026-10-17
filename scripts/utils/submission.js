/**
 * Build catalog entries from structured input (issue form, scout candidates, CLI scaffolder).
 */

const fs = require('fs');
const path = require('path');
const { CATEGORIES, DATA_DIR, canonicalKey, checkCatalog, loadCatalog, parseRepoUrl } = require('./catalog');
const { probeCompat } = require('./compat');
const { dumpEntry } = require('./format');
const { slugify } = require('./yaml');

const ISSUE_FORM_FIELDS = {
  'Name': 'name',
  'Repository URL': 'repo',
  'Folder inside the repository': 'path',
  'npm package': 'npm',
  'Category': 'category',
  'Kind': 'kind',
  'Topics': 'topics',
  'Tagline': 'tagline',
  'Description': 'description',
  'Documentation URL': 'homepage',
  'Installation': 'installation'
};

const EMPTY = /^(_no response_|none|n\/a|-)?$/i;

/**
 * Parse a GitHub issue form body ("### Label\n\nvalue" sections).
 * @param {string} body
 * @returns {object} raw fields keyed by ISSUE_FORM_FIELDS values
 */
function parseIssueForm(body) {
  const fields = {};
  const sections = String(body || '').split(/^###\s+/m).slice(1);
  for (const section of sections) {
    const [label, ...rest] = section.split('\n');
    const key = ISSUE_FORM_FIELDS[label.trim()];
    if (!key) continue;
    let value = rest.join('\n').trim();
    if (EMPTY.test(value)) continue;
    if (key === 'installation') value = value.replace(/^```\w*\n?|\n?```$/g, '').trim();
    fields[key] = value;
  }
  return fields;
}

/**
 * Normalize raw input into entry data.
 * @param {object} input - { name, repo, path, npm, category, kind, topics, tagline, description, homepage, installation }
 * @returns {{category: string, data: object}}
 */
function normalizeInput(input) {
  const category = String(input.category || '').trim().toLowerCase();
  const topics = Array.isArray(input.topics)
    ? input.topics
    : String(input.topics || '').split(/[,\n]/).map(t => t.trim().toLowerCase()).filter(Boolean);
  let repo = String(input.repo || '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
  let repoPath = input.path ? String(input.path).trim().replace(/^\/+|\/+$/g, '') : undefined;
  // Accept a pasted /tree/<branch>/<folder> URL by splitting it into repo + path
  const tree = repo.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/tree\/[^/]+\/(.+)$/);
  if (tree) {
    repo = tree[1];
    repoPath = repoPath || tree[2];
  }
  const data = {
    name: input.name && String(input.name).trim(),
    repo,
    path: repoPath,
    npm: input.npm ? String(input.npm).trim().replace(/^https:\/\/www\.npmjs\.com\/package\//, '') : undefined,
    homepage: input.homepage ? String(input.homepage).trim() : undefined,
    tagline: input.tagline && String(input.tagline).trim(),
    description: input.description && String(input.description).trim(),
    kind: input.kind ? String(input.kind).trim().toLowerCase() : undefined,
    topics,
    compat: input.compat,
    installation: input.installation ? String(input.installation).trim() : undefined
  };
  return { category, data };
}

/**
 * Pick a free filename: <repo-name>.yaml (or the monorepo folder name), then <owner>-<repo>.yaml.
 * @returns {string} path relative to the repository root
 */
function chooseFile(category, data, taken = new Set()) {
  const parsed = parseRepoUrl(data.repo) || { owner: 'entry', name: slugify(data.name || 'entry') };
  const base = slugify(data.path ? path.basename(data.path) : parsed.name) || slugify(data.name || 'entry');
  const candidates = [base, slugify(`${parsed.owner}-${base}`), slugify(`${base}-${data.name || ''}`)];
  for (const candidate of candidates) {
    const file = path.join('data', category, `${candidate}.yaml`);
    if (!taken.has(file) && !fs.existsSync(path.join(DATA_DIR, '..', file))) return file;
  }
  for (let i = 2; ; i++) {
    const file = path.join('data', category, `${base}-${i}.yaml`);
    if (!taken.has(file) && !fs.existsSync(path.join(DATA_DIR, '..', file))) return file;
  }
}

/**
 * Build, verify and serialize an entry.
 * @param {object} input - raw fields
 * @param {object} [options] - { probe: boolean }
 * @returns {Promise<{ok: boolean, problems: string[], notes: string[], category: string, file?: string, text?: string, data: object}>}
 */
async function buildEntry(input, { probe = true } = {}) {
  const { category, data } = normalizeInput(input);
  const problems = [];
  const notes = [];

  if (!CATEGORIES.includes(category)) {
    problems.push(`category must be one of: ${CATEGORIES.join(', ')}`);
    return { ok: false, problems, notes, category, data };
  }
  if (category === 'plugins') data.kind = data.kind || 'plugin';
  if (category === 'themes') data.kind = data.kind || 'theme';

  if (probe && data.repo && (category === 'plugins' || data.npm)) {
    const result = (await probeCompat([{ key: 'entry', repo: data.repo, path: data.path, npm: data.npm, plugin: category === 'plugins' }])).get('entry');
    data.compat = result.compat === 'unknown' && category !== 'plugins' ? 'n/a' : result.compat;
    notes.push(`V2 check: ${result.compat}${result.evidence.length ? ` (${result.evidence.join('; ')})` : ''}`);
    if (category === 'plugins' && result.compat === 'v1') {
      problems.push('this plugin targets the legacy V1 plugin API. New plugins must depend on @opencode/plugin and export Plugin.define({ id, setup(ctx) }). Edit this issue after migrating and the check runs again.');
    }
  } else if (category !== 'plugins') {
    data.compat = data.compat || 'n/a';
  }

  const { entries } = loadCatalog();
  const file = chooseFile(category, data);
  const entry = { category, id: path.basename(file, '.yaml'), file, data };
  const duplicate = entries.find(e => e.data.repo && canonicalKey(e.data) === canonicalKey(data));
  if (duplicate) problems.push(`already in the catalog as ${duplicate.file}`);
  for (const problem of checkCatalog([entry])) problems.push(problem.message);

  return { ok: problems.length === 0, problems, notes, category, file, text: dumpEntry(data), data };
}

module.exports = { ISSUE_FORM_FIELDS, buildEntry, chooseFile, normalizeInput, parseIssueForm };
