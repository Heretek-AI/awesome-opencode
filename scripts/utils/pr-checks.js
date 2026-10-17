/**
 * Pull request analysis shared by:
 *   - scripts/check-pr.js  (the required "validate" check; runs the PR's own code)
 *   - scripts/triage.js    (pull_request_target; trusted base code, PR files read via the API)
 *   - scripts/reprobe.js   (nightly re-check of PRs held for V2 migration)
 */

const path = require('path');
const yaml = require('js-yaml');
const { CATEGORIES, canonicalKey, checkCatalog, parseRepoUrl } = require('./catalog');
const { probeCompat } = require('./compat');
const { getRepos } = require('./github');
const { escapeCell } = require('./template');

// Generated files a PR must never edit by hand
const GENERATED_FILES = ['README.md', 'dist/registry.json'];
const DATA_FILE_RE = new RegExp(`^data/(${CATEGORIES.join('|')})/[^/]+\\.yaml$`);

const LABELS = {
  needsV2: 'needs-v2',
  needsMetadata: 'needs-metadata',
  needsHuman: 'needs-human',
  ready: 'ready'
};

/**
 * Analyze a PR's changes.
 * @param {object} input
 * @param {{path: string, status: string, content?: string, baseContent?: string}[]} input.changes
 *        status is one of added | modified | removed | renamed; content is the new file text for data files
 * @param {object[]} input.baseEntries - catalog entries on the base branch (from loadCatalog)
 * @param {boolean} [input.probe=true] - run the network V2 probe for plugin entries
 * @returns {Promise<{errors: object[], warnings: object[], entries: object[], labels: string[], categories: string[], dataChanged: boolean}>}
 */
async function analyzePullRequest({ changes, baseEntries, probe = true }) {
  const errors = [];
  const warnings = [];

  for (const change of changes) {
    if (GENERATED_FILES.includes(change.path) && change.status !== 'removed') {
      errors.push({
        file: change.path,
        kind: 'metadata',
        message: `${change.path} is generated from data/ and must not be edited by hand. Add or edit data/<category>/<name>.yaml instead (see contributing.md, or use the "Add an entry" issue form).`
      });
    }
  }

  // Overlay the PR's data changes onto the base catalog
  const head = new Map(baseEntries.map(e => [e.file, e]));
  const changed = [];
  const retargeted = [];
  for (const change of changes.filter(c => DATA_FILE_RE.test(c.path))) {
    head.delete(change.path);
    if (change.status === 'removed') continue;
    const [, category, fileName] = change.path.split('/');
    let data;
    try {
      data = yaml.load(change.content || '');
    } catch (err) {
      errors.push({ file: change.path, kind: 'metadata', message: `invalid YAML: ${err.reason || err.message}. Quote values that contain ": " (e.g. tagline: "A: B").` });
      continue;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      errors.push({ file: change.path, kind: 'metadata', message: 'file is empty or not a YAML mapping' });
      continue;
    }
    const entry = { category, id: fileName.replace(/\.yaml$/, ''), file: change.path, data, status: change.status };
    head.set(change.path, entry);
    changed.push(entry);

    if (change.status === 'modified' && change.baseContent) {
      try {
        const before = yaml.load(change.baseContent);
        // Adding or changing `path` within the same repo is not a new target
        if (before && before.repo && data.repo && canonicalKey({ repo: before.repo }) !== canonicalKey({ repo: data.repo })) {
          retargeted.push({ file: change.path, from: before.repo, to: data.repo });
        }
      } catch { /* base file was already broken */ }
    }
  }

  // A changed repo URL is fine when GitHub redirects the old name to the new one (rename/transfer)
  if (retargeted.length) {
    const olds = retargeted.map(r => parseRepoUrl(r.from)).filter(p => p && p.host === 'github.com');
    const resolved = probe ? await getRepos(olds.map(p => ({ owner: p.owner, name: p.name }))).catch(() => new Map()) : new Map();
    for (const r of retargeted) {
      const old = parseRepoUrl(r.from);
      const info = old && resolved.get(`${old.owner}/${old.name}`);
      if (info && canonicalKey({ repo: `https://github.com/${info.nameWithOwner}` }) === canonicalKey({ repo: r.to })) continue;
      warnings.push({ file: r.file, kind: 'human', message: `changes this entry's target from ${r.from} to ${r.to}. If this is a different project, add a new file instead of reusing an existing filename.` });
    }
  }

  // YAML files outside data/<category>/
  for (const change of changes) {
    if (change.path.startsWith('data/') && change.path.endsWith('.yaml') && !DATA_FILE_RE.test(change.path) && !change.path.startsWith('data/examples/') && change.status !== 'removed') {
      errors.push({ file: change.path, kind: 'metadata', message: `entries must live in data/<category>/<name>.yaml where category is one of: ${CATEGORIES.join(', ')}` });
    }
    if (change.path.startsWith('data/') && !change.path.endsWith('.yaml') && !change.path.endsWith('.json') && !change.path.endsWith('.md') && change.status !== 'removed') {
      errors.push({ file: change.path, kind: 'metadata', message: 'entry files must use the .yaml extension' });
    }
  }

  // Schema and cross-entry rules, reported for the files this PR touches
  const touched = new Set(changed.map(e => e.file));
  for (const problem of checkCatalog([...head.values()])) {
    if (touched.has(problem.file) || [...touched].some(f => problem.message.includes(f))) {
      errors.push({ ...problem, kind: 'metadata' });
    }
  }

  // V2 compatibility for plugin entries
  const plugins = changed.filter(e => e.category === 'plugins' && e.data.repo);
  if (probe && plugins.length) {
    const results = await probeCompat(plugins.map(e => ({ key: e.file, repo: e.data.repo, path: e.data.path, npm: e.data.npm, plugin: true })));
    for (const entry of plugins) {
      const { compat, evidence } = results.get(entry.file);
      entry.probe = { compat, evidence };
      const detail = evidence.length ? ` (${evidence.join('; ')})` : '';
      if (compat === 'v1' && entry.status === 'added') {
        errors.push({ file: entry.file, kind: 'v2', message: `targets the legacy V1 plugin API${detail}. New plugins must be built on OpenCode V2: depend on @opencode/plugin and export Plugin.define({ id, setup(ctx) }). This PR is re-checked nightly and unblocks itself once the repo is migrated.` });
      } else if (compat !== 'unknown' && entry.data.compat && entry.data.compat !== compat) {
        errors.push({ file: entry.file, kind: compat === 'v1' ? 'v2' : 'metadata', message: `declares compat: ${entry.data.compat} but the package was detected as ${compat}${detail}. Set compat: ${compat}.` });
      } else if (compat === 'unknown') {
        warnings.push({ file: entry.file, kind: 'human', message: `could not verify V2 compatibility automatically${detail}. Set \`npm\` (package name) or \`path\` (monorepo folder) so the check can find package.json; otherwise a maintainer will verify by hand.` });
      }
    }
  }

  const categories = [...new Set(changes.filter(c => DATA_FILE_RE.test(c.path)).map(c => c.path.split('/')[1]))];
  const labels = [];
  if (errors.some(e => e.kind === 'v2')) labels.push(LABELS.needsV2);
  if (errors.some(e => e.kind === 'metadata')) labels.push(LABELS.needsMetadata);
  if (warnings.length) labels.push(LABELS.needsHuman);
  if (!errors.length && !warnings.length && changed.length) labels.push(LABELS.ready);

  return { errors, warnings, entries: changed, labels, categories, dataChanged: categories.length > 0 };
}

/**
 * Markdown report for a job summary or PR comment.
 * @param {object} result - analyzePullRequest() result
 * @returns {string}
 */
function formatReport(result) {
  const lines = [];
  if (!result.dataChanged && !result.errors.length) {
    return '✅ No catalog entries changed.';
  }
  lines.push(result.errors.length ? '### ❌ Catalog checks failed' : result.warnings.length ? '### ⚠️ Catalog checks passed with notes' : '### ✅ Catalog checks passed');
  const section = (title, items) => {
    if (!items.length) return;
    lines.push('', `**${title}**`, '');
    for (const item of items) lines.push(`- \`${item.file}\`: ${item.message}`);
  };
  section('Must fix', result.errors);
  section('Needs a maintainer', result.warnings);
  const verified = result.entries.filter(e => e.probe);
  if (verified.length) {
    lines.push('', '**V2 compatibility**', '', '| Entry | Detected | Evidence |', '| :--- | :--- | :--- |');
    for (const e of verified) lines.push(`| \`${path.basename(e.file)}\` | ${e.probe.compat} | ${escapeCell(e.probe.evidence.join('; ')) || '—'} |`);
  }
  lines.push('', '<sub>Entry format: [contributing.md](https://github.com/Heretek-AI/awesome-opencode/blob/main/contributing.md) · Catalog policy: [docs/policy.md](https://github.com/Heretek-AI/awesome-opencode/blob/main/docs/policy.md)</sub>');
  return lines.join('\n');
}

module.exports = { DATA_FILE_RE, GENERATED_FILES, LABELS, analyzePullRequest, formatReport };
