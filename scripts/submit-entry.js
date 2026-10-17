#!/usr/bin/env node
/**
 * Turn an "Add an entry" issue into a catalog pull request.
 * Usage: node scripts/submit-entry.js --issue <number> [--dry-run]
 *
 * Reads the issue form as data (never executes it), validates and probes the entry, comments the
 * result on the issue, and on success opens or updates the PR from branch submission/<issue>.
 */

const { rest } = require('./utils/github');
const { openPullRequest } = require('./utils/git-pr');
const { REPO, addLabels, setTriageLabels, upsertComment } = require('./utils/repo');
const { buildEntry, parseIssueForm } = require('./utils/submission');

const MARKER = '<!-- awesome-opencode:submission -->';

async function main() {
  const argv = process.argv.slice(2);
  const number = Number(argv[argv.indexOf('--issue') + 1]);
  const dryRun = argv.includes('--dry-run');
  if (!number) throw new Error('usage: submit-entry.js --issue <number>');

  const { data: issue } = await rest(`/repos/${REPO}/issues/${number}`);
  if (!issue || issue.pull_request) throw new Error(`#${number} is not an issue`);
  if (issue.state !== 'open') return console.log(`#${number} is closed; nothing to do`);

  const result = await buildEntry(parseIssueForm(issue.body));
  const current = issue.labels.map(l => l.name);

  let pr = null;
  if (result.ok) {
    pr = await openPullRequest({
      branch: `submission/${number}`,
      files: { [result.file]: result.text },
      title: `docs: add ${result.data.name.replace(/[\r\n]+/g, ' ').slice(0, 80)} to ${result.category}`,
      body: [
        `Submitted by @${issue.user.login} in #${number}.`,
        '',
        ...result.notes.map(n => `- ${n}`),
        '',
        `Closes #${number}`
      ].join('\n'),
      labels: ['submission', `category: ${result.category}`],
      dryRun
    });
  }

  const body = result.ok
    ? [
      '### ✅ Entry looks good',
      '',
      pr ? `Opened ${pr.created ? '' : 'and updated '}#${pr.number} with \`${result.file}\`. Edit this issue to change the entry; the PR updates automatically.` : `\`${result.file}\` is ready${dryRun ? ' (dry run)' : '; it already matches the open PR'}.`,
      '',
      ...result.notes.map(n => `- ${n}`),
      '',
      '<details><summary>Generated YAML</summary>',
      '',
      '```yaml',
      result.text.trim(),
      '```',
      '</details>'
    ].join('\n')
    : [
      '### ❌ This entry needs changes',
      '',
      ...result.problems.map(p => `- ${p}`),
      ...(result.notes.length ? ['', ...result.notes.map(n => `- ${n}`)] : []),
      '',
      'Edit this issue to fix the fields above; the checks run again automatically.'
    ].join('\n');

  console.log(body);
  if (dryRun) return;

  const triage = result.ok ? ['ready'] : result.problems.some(p => p.includes('V1 plugin API')) ? ['needs-v2'] : ['needs-metadata'];
  await setTriageLabels(number, triage, current);
  if (result.category && !current.includes(`category: ${result.category}`)) await addLabels(number, [`category: ${result.category}`]);
  await upsertComment(number, MARKER, body);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
