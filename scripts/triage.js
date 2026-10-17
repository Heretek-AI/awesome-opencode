#!/usr/bin/env node
/**
 * Label and comment on a pull request based on the catalog checks.
 * Usage: node scripts/triage.js --pr <number> [--dry-run]
 *
 * Runs from the pull_request_target workflow with the BASE branch checked out: PR files are read
 * through the API as data and never executed, so this is safe for fork PRs and gives feedback
 * even before a maintainer approves the PR's own workflow runs.
 */

const { loadCatalog } = require('./utils/catalog');
const { analyzePullRequest, formatReport } = require('./utils/pr-checks');
const { REPO, pullChanges, setTriageLabels, addLabels, upsertComment } = require('./utils/repo');
const { rest } = require('./utils/github');

const MARKER = '<!-- awesome-opencode:triage -->';

async function main() {
  const argv = process.argv.slice(2);
  const number = Number(argv[argv.indexOf('--pr') + 1]);
  const dryRun = argv.includes('--dry-run');
  if (!number) throw new Error('usage: triage.js --pr <number>');

  const { data: pull } = await rest(`/repos/${REPO}/pulls/${number}`);
  if (!pull || !pull.head) throw new Error(`PR #${number} not found`);

  const changes = await pullChanges(pull);
  const { entries } = loadCatalog();
  const result = await analyzePullRequest({ changes, baseEntries: entries });
  const report = formatReport(result);
  const current = pull.labels.map(l => l.name);

  console.log(report);
  console.log('labels:', result.labels.join(', ') || '(none)');
  if (dryRun) return;

  await setTriageLabels(number, result.labels, current);
  await addLabels(number, result.categories.map(c => `category: ${c}`).filter(l => !current.includes(l)));
  if (result.dataChanged || result.errors.length) {
    await upsertComment(number, MARKER, report);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
