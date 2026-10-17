/**
 * Open or update a bot pull request from file changes (used by submissions, scout, health).
 *
 * Commits made with GITHUB_TOKEN do not trigger workflows, so after pushing, the "validate" workflow
 * is dispatched on the branch; its check run attaches to the head commit and satisfies the required
 * status check on the PR.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { rest } = require('./github');
const { REPO, addLabels } = require('./repo');

const ROOT = path.join(__dirname, '../..');
const BOT = ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com'];

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/**
 * @param {object} options
 * @param {string} options.branch - e.g. "submission/123"
 * @param {Object<string, string|null>} options.files - repo-relative path -> new content (null deletes)
 * @param {string} options.title
 * @param {string} options.body
 * @param {string[]} [options.labels]
 * @param {string} [options.base="main"]
 * @param {boolean} [options.dryRun]
 * @returns {Promise<{number: number, url: string, created: boolean}|null>} null when there is nothing to change
 */
async function openPullRequest({ branch, files, title, body, labels = [], base = 'main', dryRun = false }) {
  if (!/^[a-z0-9][a-z0-9/_.-]*$/i.test(branch)) throw new Error(`unsafe branch name: ${branch}`);
  const original = git('rev-parse', '--abbrev-ref', 'HEAD');
  git('fetch', '--quiet', 'origin', base);
  git('checkout', '--quiet', '-B', branch, `origin/${base}`);
  try {
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(ROOT, file);
      if (!target.startsWith(path.join(ROOT, 'data') + path.sep)) throw new Error(`refusing to write outside data/: ${file}`);
      if (content === null) {
        if (fs.existsSync(target)) git('rm', '--quiet', '--', file);
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
        git('add', '--', file);
      }
    }
    if (!git('diff', '--cached', '--name-only')) return null;
    if (dryRun) {
      console.log(`[dry run] would push ${branch}: ${git('diff', '--cached', '--stat')}`);
      return null;
    }
    git(...BOT, 'commit', '--quiet', '-m', title);
    git('push', '--quiet', '--force', 'origin', `HEAD:refs/heads/${branch}`);
  } finally {
    git('checkout', '--quiet', '--force', original === 'HEAD' ? `origin/${base}` : original);
  }

  const owner = REPO.split('/')[0];
  const { data: existing } = await rest(`/repos/${REPO}/pulls?state=open&head=${owner}:${encodeURIComponent(branch)}`);
  let pr;
  let created = false;
  if (Array.isArray(existing) && existing.length) {
    ({ data: pr } = await rest(`/repos/${REPO}/pulls/${existing[0].number}`, { method: 'PATCH', body: { title, body } }));
  } else {
    const res = await rest(`/repos/${REPO}/pulls`, { method: 'POST', body: { title, body, head: branch, base } });
    if (res.status >= 300) throw new Error(`create PR for ${branch}: HTTP ${res.status} ${JSON.stringify(res.data).slice(0, 300)}`);
    pr = res.data;
    created = true;
  }
  if (labels.length) await addLabels(pr.number, labels);
  await rest(`/repos/${REPO}/actions/workflows/validate-pr.yml/dispatches`, { method: 'POST', body: { ref: branch } });
  return { number: pr.number, url: pr.html_url, created };
}

module.exports = { openPullRequest };
