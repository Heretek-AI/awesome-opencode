#!/usr/bin/env node
/**
 * The required "validate" check for pull requests.
 * Usage: node scripts/check-pr.js --base <git-ref> [--no-probe] [--allow-generated]
 *
 * --allow-generated is passed only for the README bot's own staged commits (see generate-readme.yml).
 *
 * Compares HEAD against the merge base with <git-ref>, analyzes the changed files, writes a report to
 * $GITHUB_STEP_SUMMARY (when set) and exits 1 on any blocking problem.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadCatalog } = require('./utils/catalog');
const { DATA_FILE_RE, GENERATED_FILES, analyzePullRequest, formatReport } = require('./utils/pr-checks');

const ROOT = path.join(__dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function parseArgs(argv) {
  const baseIndex = argv.indexOf('--base');
  return {
    base: baseIndex !== -1 ? argv[baseIndex + 1] : 'origin/main',
    probe: !argv.includes('--no-probe'),
    allowGenerated: argv.includes('--allow-generated')
  };
}

const STATUS = { A: 'added', M: 'modified', D: 'removed', R: 'renamed', C: 'added', T: 'modified' };

function changedFiles(mergeBase) {
  const changes = [];
  for (const line of git('diff', '--name-status', '-M', `${mergeBase}...HEAD`).split('\n').filter(Boolean)) {
    const [code, first, second] = line.split('\t');
    const status = STATUS[code[0]] || 'modified';
    if (status === 'renamed') {
      changes.push({ path: first, status: 'removed' });
      changes.push({ path: second, status: 'added' });
    } else {
      changes.push({ path: first, status });
    }
  }
  return changes;
}

async function main() {
  const { base, probe, allowGenerated } = parseArgs(process.argv.slice(2));
  const mergeBase = git('merge-base', base, 'HEAD').trim();
  const changes = changedFiles(mergeBase);

  for (const change of changes) {
    if (!DATA_FILE_RE.test(change.path) || change.status === 'removed') continue;
    change.content = fs.readFileSync(path.join(ROOT, change.path), 'utf8');
    if (change.status === 'modified') {
      try { change.baseContent = git('show', `${mergeBase}:${change.path}`); } catch { /* new in base range */ }
    }
  }

  // Base catalog = current checkout minus/plus this PR's data changes is what analyzePullRequest rebuilds,
  // so start from the full head catalog with the changed files removed.
  const changedPaths = new Set(changes.map(c => c.path));
  const { entries, errors: loadErrors } = loadCatalog();
  const baseEntries = entries.filter(e => !changedPaths.has(e.file));

  const result = await analyzePullRequest({ changes, baseEntries, probe });
  if (allowGenerated) result.errors = result.errors.filter(e => !GENERATED_FILES.includes(e.file));
  // Unparseable files anywhere in the catalog break README generation, so they always block
  for (const err of loadErrors) {
    if (!result.errors.some(e => e.file === err.file)) result.errors.push({ ...err, kind: 'metadata' });
  }

  const report = formatReport(result);
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');
  for (const e of result.errors) console.log(`::error file=${e.file}::${e.message.replace(/\n/g, ' ')}`);
  for (const w of result.warnings) console.log(`::warning file=${w.file}::${w.message.replace(/\n/g, ' ')}`);

  process.exit(result.errors.length ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
