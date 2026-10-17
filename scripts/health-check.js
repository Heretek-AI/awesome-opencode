#!/usr/bin/env node
/**
 * Catalog health: link rot, archived/deprecated targets, renames, staleness, V2 migrations and the V1 sunset.
 *
 * Usage: node scripts/health-check.js [options]
 *   --out <file>             write per-entry health JSON (used by the site)
 *   --issue                  create/update the rolling "Catalog health report" issue (holds grace-period state)
 *                            and the V1 sunset tracking issue (label v1-sunset)
 *   --apply-renames          rewrite repo URLs of renamed/transferred repos in the working tree
 *   --apply-compat           mark plugins now detected as V2 with compat: v2 in the working tree
 *   --apply-removals         delete entries dead for GRACE_DAYS+ (and V1 plugins after the sunset date)
 *   --open-prs               open/update bot PRs for renames (bot/health-renames), V2 migrations
 *                            (bot/health-compat) and removals (bot/health-removals)
 *   --pr-body <file>         write a markdown summary of the applied changes
 *   --dry-run                print the report instead of writing the issue
 *
 * Policy (docs/policy.md): archived, 404 or npm-deprecated targets are removed after a 30-day grace
 * period; renamed repos are updated automatically; inactivity alone never removes an entry. Plugins not
 * marked v2 are re-detected every night: a V2 detection opens a PR marking them v2, and after the sunset
 * date a V1 plugin is only removed when that night's re-check confirms it is still V1.
 */

const fs = require('fs');
const path = require('path');
const { V1_SUNSET, loadCatalog, parseRepoUrl } = require('./utils/catalog');
const { probeCompat } = require('./utils/compat');
const { dumpEntry } = require('./utils/format');
const { getNpmLatest, getRepos, rest } = require('./utils/github');
const { openPullRequest } = require('./utils/git-pr');
const { REPO, comment, ensureLabels, listComments } = require('./utils/repo');

const ROOT = path.join(__dirname, '..');
const GRACE_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
const ISSUE_TITLE = 'Catalog health report';
const STATE_RE = /<!-- health-state (\{.*?\}) -->/s;
const POLICY = 'https://github.com/Heretek-AI/awesome-opencode/blob/main/docs/policy.md';
const REMINDER_DAYS = 31;
const REMINDER_MARKER = '<!-- v1-sunset-reminder -->';

function parseArgs(argv) {
  const value = flag => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
  return {
    out: value('--out'),
    issue: argv.includes('--issue'),
    applyRenames: argv.includes('--apply-renames'),
    applyCompat: argv.includes('--apply-compat'),
    applyRemovals: argv.includes('--apply-removals'),
    openPrs: argv.includes('--open-prs'),
    prBody: value('--pr-body'),
    dryRun: argv.includes('--dry-run')
  };
}

const today = () => new Date().toISOString().slice(0, 10);
const daysSince = date => Math.floor((Date.now() - new Date(date).getTime()) / DAY);
const daysUntil = date => Math.ceil((new Date(date).getTime() - Date.now()) / DAY);

async function checkUrl(url) {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': 'awesome-opencode-bot' } });
    return res.status;
  } catch {
    return 0;
  }
}

/**
 * Collect health facts for every entry.
 * @returns {Promise<Map<string, object>>} keyed by entry file
 */
async function collect(entries) {
  const health = new Map();
  const github = entries.map(e => ({ e, p: parseRepoUrl(e.data.repo) }))
    .filter(x => x.p && x.p.host === 'github.com' && !/\/discussions\//.test(x.e.data.repo));
  const repos = await getRepos(github.map(x => ({ owner: x.p.owner, name: x.p.name })));

  for (const e of entries) {
    const h = { status: 'active' };
    const p = parseRepoUrl(e.data.repo);
    const gist = /^https:\/\/gist\.github\.com\/[^/]+\/([0-9a-f]+)/.exec(e.data.repo);
    if (gist) {
      const { status } = await rest(`/gists/${gist[1]}`);
      if (status === 404) h.status = 'missing';
    } else if (p && p.host === 'github.com' && !/\/discussions\//.test(e.data.repo)) {
      const repo = repos.get(`${p.owner}/${p.name}`);
      if (!repo) {
        h.status = 'missing';
      } else {
        h.stars = repo.stargazerCount;
        h.pushedAt = repo.pushedAt;
        h.license = repo.licenseInfo ? repo.licenseInfo.spdxId : null;
        if (repo.nameWithOwner.toLowerCase() !== `${p.owner}/${p.name}`.toLowerCase()) h.renamedTo = `https://github.com/${repo.nameWithOwner}`;
        if (repo.isArchived) h.status = 'archived';
        else if (daysSince(repo.pushedAt) >= 365) h.status = 'stale';
        else if (daysSince(repo.pushedAt) >= 180) h.status = 'quiet';
      }
    } else {
      const status = await checkUrl(e.data.repo);
      if (status === 404 || status === 410) h.status = 'missing';
    }
    health.set(e.file, h);
  }

  await Promise.all(entries.filter(e => e.data.npm).map(async e => {
    const doc = await getNpmLatest(e.data.npm).catch(() => undefined);
    const h = health.get(e.file);
    if (doc === null) h.npmMissing = true;
    else if (doc && doc.deprecated) {
      h.deprecated = String(doc.deprecated).slice(0, 200);
      if (h.status !== 'missing' && h.status !== 'archived') h.status = 'deprecated';
    }
  }));

  return health;
}

/**
 * Re-detect the compatibility of every plugin not marked v2 (V1-only and unverified), so migrations are
 * picked up and the sunset never removes a plugin that has moved to V2 since it was classified.
 * @returns {Promise<Map<string, {compat: string, evidence: string[]}>>} keyed by entry file; empty if the probe failed
 */
async function recheckCompat(entries) {
  const plugins = entries.filter(e => e.category === 'plugins' && e.data.compat !== 'v2');
  try {
    return await probeCompat(plugins.map(e => ({ key: e.file, repo: e.data.repo, path: e.data.path, npm: e.data.npm, plugin: true })));
  } catch (err) {
    console.error(`compat re-check failed: ${String(err.message).replace(/[\r\n]+/g, ' ')}`);
    return new Map();
  }
}

async function findIssue() {
  const { data } = await rest(`/repos/${REPO}/issues?state=open&labels=health&per_page=20`);
  return Array.isArray(data) ? data.find(i => i.title === ISSUE_TITLE && !i.pull_request) : null;
}

function readState(issue) {
  const match = issue && STATE_RE.exec(issue.body || '');
  try { return match ? JSON.parse(match[1]) : {}; } catch { return {}; }
}

/**
 * Track when each entry was first seen dead; drop entries that recovered.
 */
function updateState(previous, entries, health) {
  const state = {};
  for (const e of entries) {
    const h = health.get(e.file);
    if (['missing', 'archived', 'deprecated'].includes(h.status)) {
      state[e.file] = { since: (previous[e.file] && previous[e.file].since) || today(), reason: h.status };
    }
  }
  return state;
}

/**
 * Entries to delete: dead for GRACE_DAYS+, or V1-only plugins past the sunset that tonight's re-check
 * still detects as V1 (a V2 or inconclusive result keeps the entry).
 */
function removalCandidates(entries, state, compat, date = today()) {
  const out = [];
  for (const e of entries) {
    const s = state[e.file];
    const now = compat.get(e.file);
    if (s && daysSince(s.since) >= GRACE_DAYS) out.push({ entry: e, reason: `${s.reason} since ${s.since}` });
    else if (e.category === 'plugins' && e.data.compat === 'v1' && date >= V1_SUNSET && now?.compat === 'v1') {
      out.push({ entry: e, reason: `V1-only plugin past the ${V1_SUNSET} sunset (${now.evidence.join('; ')})` });
    }
  }
  return out;
}

/** Plugins not marked v2 that tonight's re-check detects as V2. */
function migratedPlugins(entries, compat) {
  return entries.filter(e => e.category === 'plugins' && e.data.compat !== 'v2' && compat.get(e.file)?.compat === 'v2');
}

function report(entries, health, state, compat) {
  const link = e => `[${e.data.name}](${e.data.repo}) \`${e.file}\``;
  const rows = (list, fmt) => list.length ? list.map(fmt).join('\n') : '_None._';
  const dead = entries.filter(e => state[e.file]);
  const renamed = entries.filter(e => health.get(e.file).renamedTo);
  const plugins = entries.filter(e => e.category === 'plugins');
  const v1 = plugins.filter(e => e.data.compat === 'v1');
  const unknown = plugins.filter(e => e.data.compat === 'unknown');
  const migrated = migratedPlugins(entries, compat);
  const unconfirmed = v1.filter(e => !['v1', 'v2'].includes(compat.get(e.file)?.compat));
  const stale = entries.filter(e => health.get(e.file).status === 'stale');
  const npmMissing = entries.filter(e => health.get(e.file).npmMissing);

  return [
    `Updated ${today()} by the nightly health check. Policy: [docs/policy.md](https://github.com/Heretek-AI/awesome-opencode/blob/main/docs/policy.md).`,
    '',
    `| Check | Count |`,
    `| :--- | ---: |`,
    `| Entries | ${entries.length} |`,
    `| Archived, missing or deprecated (removed after ${GRACE_DAYS} days) | ${dead.length} |`,
    `| Renamed or transferred (fixed by bot PR) | ${renamed.length} |`,
    `| Plugins now detected as V2 (marked by bot PR) | ${migrated.length} |`,
    `| V1-only plugins (removed after ${V1_SUNSET}) | ${v1.length} |`,
    `| V1-only plugins tonight's re-check could not confirm (never removed automatically) | ${unconfirmed.length} |`,
    `| Plugins with unverified compatibility | ${unknown.length} |`,
    `| No push for a year (badge only, not removed) | ${stale.length} |`,
    '',
    `### Archived, missing or deprecated`,
    rows(dead, e => `- [ ] ${link(e)}: ${state[e.file].reason} since ${state[e.file].since}${health.get(e.file).deprecated ? ` ("${health.get(e.file).deprecated.replace(/[\r\n]+/g, ' ')}")` : ''}, removal PR in ${Math.max(0, GRACE_DAYS - daysSince(state[e.file].since))} day(s)`),
    '',
    '### Renamed or transferred',
    rows(renamed, e => `- ${link(e)} → ${health.get(e.file).renamedTo}`),
    '',
    '### Migrated to V2',
    rows(migrated, e => `- ${link(e)}: ${e.data.compat} → v2 (${compat.get(e.file).evidence.join('; ')})`),
    '',
    '### Plugins with unverified compatibility',
    'The V2 check could not decide. Verify by hand and set `compat`, or add `npm`/`path` so the check can find the package.',
    '',
    rows(unknown, e => `- [ ] ${link(e)}`),
    '',
    `<details><summary>V1-only plugins (${v1.length}), removed after ${V1_SUNSET} unless migrated</summary>`,
    '',
    rows(v1, e => `- ${link(e)}${unconfirmed.includes(e) ? ': re-check inconclusive, verify by hand before the sunset' : ''}`),
    '',
    '</details>',
    '',
    `<details><summary>npm package not found (${npmMissing.length})</summary>`,
    '',
    rows(npmMissing, e => `- ${link(e)}: \`${e.data.npm}\``),
    '',
    '</details>',
    '',
    `<details><summary>No push for a year (${stale.length})</summary>`,
    '',
    rows(stale, e => `- ${link(e)}: last push ${String(health.get(e.file).pushedAt).slice(0, 10)}`),
    '',
    '</details>',
    '',
    `<!-- health-state ${JSON.stringify(state)} -->`
  ].join('\n');
}

function sunsetIssueBody(entries, migrated) {
  const plugins = entries.filter(e => e.category === 'plugins').sort((a, b) => a.data.name.localeCompare(b.data.name));
  const v1 = plugins.filter(e => e.data.compat === 'v1' && !migrated.includes(e));
  const unknown = plugins.filter(e => e.data.compat === 'unknown' && !migrated.includes(e));
  const pending = plugins.filter(e => migrated.includes(e));
  const row = e => `| [\`${e.data.name.replace(/[|`]/g, '')}\`](${e.data.repo}) | \`${e.file}\` |`;
  const table = (summary, list) => list.length ? [
    `<details><summary>${summary}</summary>`, '', '| Plugin | Entry |', '| :--- | :--- |', ...list.map(row), '', '</details>', ''
  ] : [];
  return [
    `The catalog only accepts new plugins built for **OpenCode V2**, and existing V1-only plugins carry a \`V1 only\` badge. **On ${V1_SUNSET}, V1-only plugins are removed** from the catalog unless they have migrated ([policy](${POLICY})).`,
    '',
    '**If you maintain one of these plugins:**',
    '1. Depend on `@opencode/plugin` (instead of `@opencode-ai/plugin` 1.x).',
    '2. Export `Plugin.define({ id: "your-plugin", async setup(ctx) { … } })`, or a plain `{ id, setup }` object. Keeping the V1 export alongside it for dual support is fine.',
    '3. Publish. The nightly health check re-detects compatibility and opens a PR marking your entry `compat: v2`; you can also open that PR yourself and the `validate` check will confirm it.',
    '',
    'Detection reads your npm package, `package.json` files and source ([`scripts/utils/compat.js`](https://github.com/Heretek-AI/awesome-opencode/blob/main/scripts/utils/compat.js)). If we got yours wrong, comment here with the file that shows V2 support and we will fix the entry.',
    '',
    `_List updated ${today()} by the nightly health check._`,
    '',
    ...table(`<b>V1-only plugins (${v1.length})</b>`, v1),
    ...table(`<b>Detected as V2, catalog update pending (${pending.length})</b>: merged with the next <code>bot/health-compat</code> PR`, pending),
    ...table(`<b>Could not be verified automatically (${unknown.length})</b>: maintainers will check these by hand`, unknown)
  ].join('\n').trimEnd();
}

/**
 * Keep the V1 sunset tracking issue's lists current, post one reminder REMINDER_DAYS before the sunset,
 * and close the issue once no V1-only plugins remain after it.
 */
async function updateSunsetIssue(entries, migrated) {
  const { data } = await rest(`/repos/${REPO}/issues?state=open&labels=v1-sunset&per_page=10`);
  const issue = Array.isArray(data) ? data.find(i => !i.pull_request) : null;
  if (!issue) return;
  const body = sunsetIssueBody(entries, migrated);
  if (body !== issue.body) await rest(`/repos/${REPO}/issues/${issue.number}`, { method: 'PATCH', body: { body } });

  const remaining = entries.filter(e => e.category === 'plugins' && e.data.compat === 'v1' && !migrated.includes(e)).length;
  const days = daysUntil(V1_SUNSET);
  if (days > 0 && days <= REMINDER_DAYS && remaining) {
    const comments = await listComments(issue.number);
    if (!comments.some(c => (c.body || '').startsWith(REMINDER_MARKER))) {
      await comment(issue.number, [
        REMINDER_MARKER,
        `Reminder: V1-only plugins are removed from the catalog on ${V1_SUNSET}, ${days} day(s) from now. ${remaining} plugin(s) in the list above still use the V1 API.`,
        '',
        'If yours has migrated, nothing else is needed: the nightly check detects it and opens a PR marking the entry `compat: v2`. If the check got it wrong, reply here with the file that shows V2 support.'
      ].join('\n'));
      console.log(`Posted the sunset reminder on #${issue.number}`);
    }
  }
  if (days <= 0 && !remaining) {
    await comment(issue.number, 'No V1-only plugins remain in the catalog. Closing.');
    await rest(`/repos/${REPO}/issues/${issue.number}`, { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } });
  }
  console.log(`Updated the V1 sunset issue #${issue.number}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { entries, errors } = loadCatalog();
  if (errors.length) throw new Error(`catalog has unparseable files: ${errors.map(e => e.file).join(', ')}`);

  const health = await collect(entries);
  const compat = await recheckCompat(entries);
  const migrated = migratedPlugins(entries, compat);
  const issue = await findIssue();
  const state = updateState(readState(issue), entries, health);

  if (opts.out) {
    const out = {
      generated: new Date().toISOString(),
      entries: Object.fromEntries(entries.map(e => [`${e.category}/${e.id}`, health.get(e.file)]))
    };
    fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
    fs.writeFileSync(opts.out, JSON.stringify(out));
    console.log(`Wrote ${opts.out}`);
  }

  const body = report(entries, health, state, compat);
  if (opts.issue && !opts.dryRun) {
    await ensureLabels(['health']);
    if (issue) await rest(`/repos/${REPO}/issues/${issue.number}`, { method: 'PATCH', body: { body } });
    else await rest(`/repos/${REPO}/issues`, { method: 'POST', body: { title: ISSUE_TITLE, body, labels: ['health'] } });
    console.log(`${issue ? 'Updated' : 'Created'} the "${ISSUE_TITLE}" issue`);
    await updateSunsetIssue(entries, migrated);
  } else if (opts.dryRun) {
    console.log(body);
  }

  // A file that is both renamed and migrated gets the same content in both PRs, so they never conflict
  const updated = e => dumpEntry({
    ...e.data,
    ...(health.get(e.file).renamedTo ? { repo: health.get(e.file).renamedTo } : {}),
    ...(migrated.includes(e) ? { compat: 'v2' } : {})
  });
  const renames = { files: {}, lines: [] };
  for (const e of entries) {
    const to = health.get(e.file).renamedTo;
    if (!to) continue;
    renames.files[e.file] = updated(e);
    renames.lines.push(`- \`${e.file}\`: ${e.data.repo} → ${to}`);
  }
  const migrations = { files: {}, lines: [] };
  for (const e of migrated) {
    migrations.files[e.file] = updated(e);
    migrations.lines.push(`- \`${e.file}\` ([${e.data.name}](${e.data.repo})): ${e.data.compat} → v2 (${compat.get(e.file).evidence.join('; ')})`);
  }
  const removals = { files: {}, lines: [] };
  for (const { entry, reason } of removalCandidates(entries, state, compat)) {
    removals.files[entry.file] = null;
    removals.lines.push(`- \`${entry.file}\` ([${entry.data.name}](${entry.data.repo})): ${reason}`);
  }

  const summary = [];
  if (opts.applyRenames) {
    for (const [file, text] of Object.entries(renames.files)) fs.writeFileSync(path.join(ROOT, file), text);
    summary.push(...renames.lines);
    console.log(`Applied ${renames.lines.length} rename(s)`);
  }
  if (opts.applyCompat) {
    for (const [file, text] of Object.entries(migrations.files)) fs.writeFileSync(path.join(ROOT, file), text);
    summary.push(...migrations.lines);
    console.log(`Applied ${migrations.lines.length} V2 migration(s)`);
  }
  if (opts.applyRemovals) {
    for (const file of Object.keys(removals.files)) fs.unlinkSync(path.join(ROOT, file));
    summary.push(...removals.lines);
    console.log(`Applied ${removals.lines.length} removal(s)`);
  }
  if (opts.prBody) fs.writeFileSync(opts.prBody, summary.join('\n') + '\n');

  if (opts.openPrs) {
    if (renames.lines.length) {
      const pr = await openPullRequest({
        branch: 'bot/health-renames',
        files: renames.files,
        title: 'chore: follow renamed or transferred repositories',
        body: ['The nightly health check found entries whose GitHub repository was renamed or transferred.', '', ...renames.lines].join('\n'),
        labels: ['health'],
        dryRun: opts.dryRun
      });
      if (pr) console.log(`Renames: #${pr.number}`);
    }
    if (migrations.lines.length) {
      const pr = await openPullRequest({
        branch: 'bot/health-compat',
        files: migrations.files,
        title: 'chore: mark plugins that migrated to OpenCode V2',
        body: ['The nightly health check now detects OpenCode V2 support in these V1-only or unverified plugins, so they no longer face the V1 sunset.', '', ...migrations.lines].join('\n'),
        labels: ['health'],
        dryRun: opts.dryRun
      });
      if (pr) console.log(`V2 migrations: #${Number(pr.number)}`);
    }
    if (removals.lines.length) {
      const pr = await openPullRequest({
        branch: 'bot/health-removals',
        files: removals.files,
        title: 'chore: remove dead or sunset catalog entries',
        body: [`These entries have been archived, missing or deprecated for ${GRACE_DAYS}+ days, or are V1-only plugins past the ${V1_SUNSET} sunset (see [docs/policy.md](https://github.com/Heretek-AI/awesome-opencode/blob/main/docs/policy.md)). Close this PR to keep them; the next run will propose them again unless the target recovers.`, '', ...removals.lines].join('\n'),
        labels: ['health'],
        dryRun: opts.dryRun
      });
      if (pr) console.log(`Removals: #${pr.number}`);
    }
  }

  const counts = {};
  for (const h of health.values()) counts[h.status] = (counts[h.status] || 0) + 1;
  console.log('status counts:', JSON.stringify(counts));
  console.log(`compat re-check: ${compat.size} plugin(s), ${migrated.length} now V2`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { migratedPlugins, removalCandidates, sunsetIssueBody };
