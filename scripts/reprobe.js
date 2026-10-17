#!/usr/bin/env node
/**
 * Nightly re-check of pull requests held for V2 migration (label: needs-v2).
 * Usage: node scripts/reprobe.js [--dry-run] [--pr <number>]
 *
 * - Target detected as V2 (not merely "unknown"): relabel, thank the author, fill in missing kind/topics/compat on
 *   same-repo branches, and re-run the validate check.
 * - Still V1 after HOLD_DAYS since needs-v2 was applied: close with a reopen-anytime note.
 */

const yaml = require('js-yaml');
const { loadCatalog } = require('./utils/catalog');
const { probeCompat } = require('./utils/compat');
const { dumpEntry } = require('./utils/format');
const { rest } = require('./utils/github');
const { analyzePullRequest } = require('./utils/pr-checks');
const { REPO, comment, listOpenPulls, pullChanges, revalidate, setTriageLabels } = require('./utils/repo');
const { suggestKind, suggestTopics } = require('./utils/suggest');

const HOLD_DAYS = 60;
const DAY = 24 * 60 * 60 * 1000;

async function labeledAt(number, label) {
  let last = null;
  for (let page = 1; ; page++) {
    const { data } = await rest(`/repos/${REPO}/issues/${number}/events?per_page=100&page=${page}`);
    if (!Array.isArray(data)) break;
    for (const ev of data) if (ev.event === 'labeled' && ev.label && ev.label.name === label) last = ev.created_at;
    if (data.length < 100) break;
  }
  return last ? new Date(last) : null;
}

/** Original author of an imported upstream PR, else the PR author. */
function authorOf(pull) {
  const upstream = String(pull.body || '').match(/\*\*Original Author\*\*:\s*\[@([A-Za-z0-9-]+)\]/);
  return upstream ? upstream[1] : pull.user.login;
}

async function autofix(pull, change, compat) {
  const data = yaml.load(change.content);
  const [, category] = change.path.split('/');
  const text = [data.name, data.tagline, data.description].join(' ');
  let changed = false;
  if (!data.kind) { data.kind = suggestKind(category, text); changed = true; }
  if (!data.topics || !data.topics.length) { data.topics = suggestTopics(text); changed = true; }
  if (data.compat !== compat) { data.compat = compat; changed = true; }
  if (!changed) return false;
  const { data: current } = await rest(`/repos/${REPO}/contents/${change.path}?ref=${encodeURIComponent(pull.head.ref)}`);
  const res = await rest(`/repos/${REPO}/contents/${change.path}`, {
    method: 'PUT',
    body: {
      message: `chore: fill in kind, topics and compat for ${change.path}`,
      content: Buffer.from(dumpEntry(data)).toString('base64'),
      sha: current.sha,
      branch: pull.head.ref
    }
  });
  if (res.status >= 300) throw new Error(`autofix ${change.path}: HTTP ${res.status}`);
  return true;
}

async function handle(pull, baseEntries, dryRun) {
  const changes = await pullChanges(pull);
  const plugins = changes.filter(c => /^data\/plugins\/[^/]+\.yaml$/.test(c.path) && c.status === 'added' && c.content);
  const parsed = plugins.map(c => { try { return { c, data: yaml.load(c.content) }; } catch { return null; } }).filter(x => x && x.data && x.data.repo);
  if (!parsed.length) return `#${pull.number}: no plugin entries to re-check`;

  const results = await probeCompat(parsed.map(({ c, data }) => ({ key: c.path, repo: data.repo, path: data.path, npm: data.npm, plugin: true })));
  // Only a positive V2 detection unblocks; "unknown" keeps the hold (the reviewer saw V1 code)
  const migrated = parsed.every(({ c }) => results.get(c.path).compat === 'v2');

  if (migrated) {
    const sameRepo = pull.head.repo && pull.head.repo.full_name === REPO;
    if (dryRun) return `#${pull.number}: now ${parsed.map(({ c }) => results.get(c.path).compat).join(', ')} -> would unblock`;
    let fixed = false;
    if (sameRepo) {
      for (const { c } of parsed) fixed = (await autofix(pull, c, results.get(c.path).compat)) || fixed;
    }
    const fresh = fixed ? await pullChanges((await rest(`/repos/${REPO}/pulls/${pull.number}`)).data) : changes;
    const analysis = await analyzePullRequest({ changes: fresh, baseEntries });
    await setTriageLabels(pull.number, analysis.labels, pull.labels.map(l => l.name));
    const evidence = parsed.map(({ c }) => `\`${c.path}\`: ${results.get(c.path).compat} (${results.get(c.path).evidence.join('; ')})`).join('\n- ');
    await comment(pull.number, [
      `@${authorOf(pull)} the nightly check now detects OpenCode V2 support. Thank you for migrating!`,
      '',
      `- ${evidence}`,
      fixed ? '\nThe entry was updated with `kind`, `topics` and `compat` so it matches the current schema.' : '',
      analysis.errors.length ? '\nA few metadata items still need fixing; see the checks on this PR.' : '\nAll automated checks pass; a maintainer will merge this shortly.'
    ].join('\n'));
    await revalidate((await rest(`/repos/${REPO}/pulls/${pull.number}`)).data);
    return `#${pull.number}: unblocked (${analysis.labels.join(', ')})`;
  }

  const since = await labeledAt(pull.number, 'needs-v2');
  const days = since ? Math.floor((Date.now() - since.getTime()) / DAY) : 0;
  if (days < HOLD_DAYS) return `#${pull.number}: still V1 (${days}/${HOLD_DAYS} days)`;
  if (dryRun) return `#${pull.number}: still V1 after ${days} days -> would close`;
  await comment(pull.number, [
    `@${authorOf(pull)} closing this for now: the target is still on the legacy V1 plugin API ${days} days after the V2 migration request.`,
    '',
    'Reopen this PR (or submit again through the "Add an entry" issue form) once the plugin depends on `@opencode/plugin` and exports `Plugin.define({ id, setup(ctx) })`. See [docs/policy.md](https://github.com/Heretek-AI/awesome-opencode/blob/main/docs/policy.md).'
  ].join('\n'));
  await rest(`/repos/${REPO}/pulls/${pull.number}`, { method: 'PATCH', body: { state: 'closed' } });
  return `#${pull.number}: closed after ${days} days on V1`;
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const only = argv.includes('--pr') ? Number(argv[argv.indexOf('--pr') + 1]) : null;

  const pulls = (await listOpenPulls()).filter(p => (only ? p.number === only : p.labels.some(l => l.name === 'needs-v2')));
  const { entries } = loadCatalog();
  console.log(`Re-checking ${pulls.length} PR(s) labeled needs-v2${dryRun ? ' (dry run)' : ''}`);
  let failures = 0;
  for (const pull of pulls) {
    try {
      console.log(await handle(pull, entries, dryRun));
    } catch (err) {
      failures++;
      console.error(`#${pull.number}: ${err.message}`);
    }
  }
  if (failures) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
