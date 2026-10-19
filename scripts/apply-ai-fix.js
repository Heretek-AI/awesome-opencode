#!/usr/bin/env node
/**
 * Apply the AI review's suggested entry to a PR branch in one command.
 *
 *   node scripts/apply-ai-fix.js --pr <n> --sender <login> [--comment-id <id>] [--dry-run]
 *
 * Flow: fetch the PR (must be open) -> check the sender has write/admin via the
 * collaborators permission API -> find the latest `<!-- ai-review -->` comment ->
 * require its reviewed SHA to match the PR head (fail closed on stale) -> extract the
 * first ```yaml block inside its <details> -> require exactly one changed
 * data/**.yaml file in the PR -> schema-validate the suggestion -> commit it to the
 * PR's head branch (same-repo PRs only for the MVP) and comment the result.
 *
 * Security: the trigger comment body is untrusted and only used as a signal (never
 * interpolated into shell). The YAML applied comes only from our own validated bot
 * AI-review comment (MARKER). All untrusted strings are escaped with safe() before
 * reaching a comment. Git runs via execFile with array args (no shell).
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const yaml = require('js-yaml');
const { rest } = require('./utils/github');
const { REPO, comment, listComments, pullChanges } = require('./utils/repo');
const { MARKER, checkSuggestedYaml, safe } = require('./utils/ai-verdict');
const { CATEGORIES } = require('./utils/catalog');

const execFileAsync = promisify(execFile);
const ROOT = path.join(__dirname, '..');

const APPLY_COMMAND = '/apply-ai-fix';
const SHA_RE = /<!-- sha=([0-9a-f]{7,40}) -->/;
const CATEGORY_RE = /category `([A-Za-z0-9_-]+)`/;
const DATA_FILE_RE = /^data\/[^/]+\/[^/]+\.yaml$/;
const SUCCESS_MESSAGE = 'Apply AI suggested entry (/apply-ai-fix by @%s)';

/** True when a comment body is an apply trigger (signal only; body is otherwise untrusted). */
function isTriggerComment(body) {
  return String(body || '').includes(APPLY_COMMAND);
}

/** Latest comment whose body starts with the bot AI-review marker, or null. */
function findAiComment(comments) {
  const list = Array.isArray(comments) ? comments : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const body = list[i] && list[i].body;
    if (typeof body === 'string' && body.startsWith(MARKER)) return list[i];
  }
  return null;
}

/** Reviewed SHA recorded in an AI review comment body, or null. */
function extractReviewedSha(body) {
  const match = SHA_RE.exec(String(body || ''));
  return match ? match[1] : null;
}

/**
 * First ```yaml block inside the comment's <details> element (else the first ```yaml
 * block anywhere, for robustness). Returns the raw YAML text or null.
 */
function extractSuggestedYaml(body) {
  const text = String(body || '');
  const details = /<details>([\s\S]*?)<\/details>/i.exec(text);
  const scope = details ? details[1] : text;
  const match = /```yaml\s*\n([\s\S]*?)```/.exec(scope);
  return match ? match[1].trim() : null;
}

/** Category hint rendered in the AI review comment (`category `X``), or null. */
function extractCategoryHint(body) {
  const match = CATEGORY_RE.exec(String(body || ''));
  return match && CATEGORIES.includes(match[1]) ? match[1] : null;
}

/** Category implied by a catalog path (data/<category>/...), or null. */
function categoryFromPath(filePath) {
  const match = /^data\/([^/]+)\//.exec(String(filePath || ''));
  return match && CATEGORIES.includes(match[1]) ? match[1] : null;
}

/**
 * Pick the single catalog file the suggestion applies to.
 * @param {string[]} changedPaths - changed file paths in the PR
 * @returns {{file: string|null, error: string|null}}
 */
function targetFile(changedPaths) {
  const files = (Array.isArray(changedPaths) ? changedPaths : [])
    .filter(p => typeof p === 'string' && DATA_FILE_RE.test(p));
  if (files.length === 0) return { file: null, error: 'No catalog file in this PR' };
  if (files.length > 1) return { file: null, error: 'Multiple files; apply manually' };
  return { file: files[0], error: null };
}

/** True when the reviewed SHA is still the PR head (prefix match, same as validateVerdict). */
function isFresh(reviewedSha, headSha) {
  return Boolean(reviewedSha && headSha && String(headSha).startsWith(reviewedSha));
}

function parseArgs(argv) {
  const value = (flag, fallback = null) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : fallback);
  const pr = value('--pr') ? Number(value('--pr')) : NaN;
  return {
    pr,
    sender: value('--sender'),
    commentId: value('--comment-id') ? Number(value('--comment-id')) : null,
    dryRun: argv.includes('--dry-run')
  };
}

/** Post a comment; never throws (fail-closed reporting must not crash on the report itself). */
async function say(number, body, deps) {
  try {
    await deps.postComment(number, body);
  } catch (err) {
    console.error(`comment failed: ${err.message}`);
  }
}

async function git(args, { cwd = ROOT } = {}) {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return String(stdout || '').trim();
}

/**
 * Commit the suggested entry to the PR head branch (same-repo only).
 * Uses execFile array args throughout; file content never touches a shell command line.
 */
async function commitToBranch({ file, content, headRef, sender }, deps) {
  const abs = path.join(ROOT, file);
  const resolved = path.resolve(abs);
  if (!resolved.startsWith(path.resolve(ROOT) + path.sep)) throw new Error(`refusing to write outside the repo: ${file}`);
  if (!DATA_FILE_RE.test(file)) throw new Error(`refusing to write non-catalog file: ${file}`);
  await deps.fetchHead(headRef);
  await deps.checkoutHead(headRef);
  deps.writeFile(resolved, content.endsWith('\n') ? content : `${content}\n`);
  await deps.stageAndCommit(file, `Apply AI suggested entry (/apply-ai-fix by @${sender})`);
  await deps.pushHead(headRef);
}

const defaultDeps = {
  getPull: async number => rest(`/repos/${REPO}/pulls/${number}`),
  getPermission: async sender => rest(`/repos/${REPO}/collaborators/${encodeURIComponent(sender)}/permission`),
  listComments,
  listPrFiles: async pull => pullChanges(pull),
  postComment: async (number, body) => comment(number, body),
  fetchHead: async headRef => { await git(['fetch', 'origin', headRef]); },
  checkoutHead: async headRef => { await git(['checkout', headRef]); },
  writeFile: (abs, content) => fs.writeFileSync(abs, content, 'utf8'),
  stageAndCommit: async (file, message) => {
    await git(['add', '--', file]);
    await git(['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit', '-m', message, '--', file]);
  },
  pushHead: async headRef => { await git(['push', 'origin', `HEAD:${headRef}`]); },
  runValidate: async () => { await execFileAsync('node', ['scripts/validate.js'], { cwd: ROOT, maxBuffer: 8 * 1024 * 1024 }); }
};

/**
 * Run the apply flow. Returns an exit code (0 = handled, 1 = infrastructure error).
 * User-facing rejections post an explanatory comment and return 0 so the workflow
 * stays green; only unexpected failures return 1.
 */
async function applyAiFix({ pr, sender, dryRun = false }, deps = defaultDeps) {
  if (!Number.isInteger(pr) || pr <= 0) throw new Error('apply-ai-fix needs --pr <n>');
  if (!sender || typeof sender !== 'string') throw new Error('apply-ai-fix needs --sender <login>');

  const { status: pullStatus, data: pull } = await deps.getPull(pr);
  if (pullStatus !== 200 || !pull) {
    console.error(`fetch PR #${pr} failed: HTTP ${pullStatus}`);
    return 1;
  }
  if (pull.state !== 'open') {
    console.log(`#${pr} is ${pull.state}; nothing to apply`);
    return 0;
  }

  const permRes = await deps.getPermission(sender);
  const permission = permRes && permRes.data && permRes.data.permission;
  if (permRes.status !== 200 || (permission !== 'admin' && permission !== 'write')) {
    await say(pr, `Only maintainers with write access can use \`${APPLY_COMMAND}\` (sender @${safe(sender)}).`, deps);
    console.log(`sender ${sender} has permission ${permission || permRes.status}; rejected`);
    return 0;
  }

  const comments = await deps.listComments(pr);
  const aiComment = findAiComment(comments);
  if (!aiComment) {
    await say(pr, `No AI review comment (\`${MARKER}\`) found on this PR; nothing to apply.`, deps);
    return 0;
  }

  const reviewed = extractReviewedSha(aiComment.body);
  if (!isFresh(reviewed, pull.head.sha)) {
    await say(pr, 'Suggested entry is stale (PR has new commits); waiting for fresh AI review.', deps);
    return 0;
  }

  const suggested = extractSuggestedYaml(aiComment.body);
  if (!suggested) {
    await say(pr, 'No suggested entry found in the latest AI review comment; nothing to apply.', deps);
    return 0;
  }

  const headRepo = (pull.head.repo && pull.head.repo.full_name) || REPO;
  if (headRepo !== REPO) {
    await say(pr, 'Fork PRs are not auto-updated; please apply manually.', deps);
    return 0;
  }

  const files = await deps.listPrFiles(pull);
  const paths = files.map(f => (typeof f === 'string' ? f : f.path));
  const { file, error } = targetFile(paths);
  if (!file) {
    await say(pr, `${safe(error)}; please apply manually.`, deps);
    return 0;
  }

  const category = extractCategoryHint(aiComment.body) || categoryFromPath(file);
  const check = checkSuggestedYaml(suggested, category);
  if (!check.ok) {
    await say(pr, `Suggested entry does not validate, so it was not applied:\n\n- ${safe(check.problems.join('\n- '))}`, deps);
    return 0;
  }

  let data;
  try {
    data = yaml.load(suggested);
  } catch (err) {
    await say(pr, `Suggested entry is not valid YAML, so it was not applied: ${safe(err.message)}`, deps);
    return 0;
  }
  const serialized = yaml.dump(data, { lineWidth: 1000 }).trim() + '\n';

  if (dryRun) {
    console.log(`would apply suggestion to ${file} on ${pull.head.ref} (PR #${pr})`);
    return 0;
  }

  try {
    await commitToBranch({ file, content: serialized, headRef: pull.head.ref, sender }, deps);
  } catch (err) {
    console.error(`apply failed: ${err.message}`);
    await say(pr, `Could not apply the suggested entry (${safe(err.message).slice(0, 200)}); please apply manually.`, deps);
    return 1;
  }

  try {
    await deps.runValidate();
  } catch (err) {
    console.error(`validate after apply failed: ${err.message}`);
    await say(pr, `Applied the suggested entry to \`${safe(file)}\`, but \`npm run validate\` still reports problems; please review the check output.`, deps);
    return 1;
  }

  await say(pr, `Applied the AI suggested entry to \`${safe(file)}\` (commit on \`${safe(pull.head.ref)}\`); \`validate\` re-runs on the new commit.`, deps);
  console.log(`applied suggestion to ${file} on PR #${pr}`);
  return 0;
}

async function main(argv = process.argv.slice(2), deps = defaultDeps) {
  const opts = parseArgs(argv);
  return applyAiFix(opts, deps);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  }).then(code => { process.exit(code); });
}

module.exports = {
  APPLY_COMMAND,
  applyAiFix,
  categoryFromPath,
  extractCategoryHint,
  extractReviewedSha,
  extractSuggestedYaml,
  findAiComment,
  isFresh,
  isTriggerComment,
  parseArgs,
  targetFile
};
