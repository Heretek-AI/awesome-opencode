/**
 * Helpers for acting on this repository's issues and pull requests via the GitHub REST API.
 */

const { rest } = require('./github');

const REPO = process.env.GITHUB_REPOSITORY || 'Heretek-AI/awesome-opencode';

// Labels the bots manage: name -> [color, description]
const BOT_LABELS = {
  'needs-v2': ['d93f0b', 'Plugin targets the legacy V1 API; re-checked nightly'],
  'needs-metadata': ['fbca04', 'Entry fails schema or catalog rules'],
  'needs-human': ['c5def5', 'Automated checks could not decide; maintainer review needed'],
  ready: ['0e8a16', 'All automated checks pass'],
  submission: ['1d76db', 'Entry submitted through the issue form'],
  scout: ['5319e7', 'Weekly discovery of V2 plugin candidates'],
  health: ['b60205', 'Catalog link-rot and maintenance tracking'],
  'v1-sunset': ['e99695', 'V1-only plugin scheduled for removal at the sunset date'],
  'category: plugins': ['bfdadc', 'Touches data/plugins'],
  'category: themes': ['bfdadc', 'Touches data/themes'],
  'category: agents': ['bfdadc', 'Touches data/agents'],
  'category: projects': ['bfdadc', 'Touches data/projects'],
  'category: resources': ['bfdadc', 'Touches data/resources']
};

const TRIAGE_LABELS = ['needs-v2', 'needs-metadata', 'needs-human', 'ready'];

async function check(promise, what) {
  const res = await promise;
  if (res.status >= 300) throw new Error(`${what} failed: HTTP ${res.status} ${JSON.stringify(res.data).slice(0, 300)}`);
  return res.data;
}

/**
 * Create any missing bot labels.
 */
async function ensureLabels(names = Object.keys(BOT_LABELS)) {
  for (const name of names) {
    const [color, description] = BOT_LABELS[name] || ['ededed', ''];
    const res = await rest(`/repos/${REPO}/labels`, { method: 'POST', body: { name, color, description } });
    if (res.status !== 201 && res.status !== 422) throw new Error(`create label ${name}: HTTP ${res.status}`);
  }
}

/**
 * Make the triage labels on an issue/PR exactly `wanted` (other labels untouched).
 */
async function setTriageLabels(number, wanted, current) {
  const have = new Set(current);
  const add = wanted.filter(l => !have.has(l));
  const remove = TRIAGE_LABELS.filter(l => have.has(l) && !wanted.includes(l));
  if (add.length) await ensureLabels(add);
  if (add.length) await check(rest(`/repos/${REPO}/issues/${number}/labels`, { method: 'POST', body: { labels: add } }), 'add labels');
  for (const label of remove) {
    await rest(`/repos/${REPO}/issues/${number}/labels/${encodeURIComponent(label)}`, { method: 'DELETE' });
  }
  return { add, remove };
}

async function addLabels(number, labels) {
  if (!labels.length) return;
  await ensureLabels(labels.filter(l => BOT_LABELS[l]));
  await check(rest(`/repos/${REPO}/issues/${number}/labels`, { method: 'POST', body: { labels } }), 'add labels');
}

async function listComments(number) {
  const comments = [];
  for (let page = 1; ; page++) {
    const batch = await check(rest(`/repos/${REPO}/issues/${number}/comments?per_page=100&page=${page}`), 'list comments');
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
}

/**
 * Create or update the single bot comment identified by `marker`.
 */
async function upsertComment(number, marker, body) {
  const full = `${marker}\n${body}`;
  const existing = (await listComments(number)).find(c => c.body && c.body.startsWith(marker));
  if (existing) {
    if (existing.body === full) return existing;
    return check(rest(`/repos/${REPO}/issues/comments/${existing.id}`, { method: 'PATCH', body: { body: full } }), 'update comment');
  }
  return check(rest(`/repos/${REPO}/issues/${number}/comments`, { method: 'POST', body: { body: full } }), 'create comment');
}

async function comment(number, body) {
  return check(rest(`/repos/${REPO}/issues/${number}/comments`, { method: 'POST', body: { body } }), 'create comment');
}

/**
 * All open pull requests (with head repo/ref/sha and labels).
 */
async function listOpenPulls() {
  const pulls = [];
  for (let page = 1; ; page++) {
    const batch = await check(rest(`/repos/${REPO}/pulls?state=open&per_page=100&page=${page}`), 'list pulls');
    pulls.push(...batch);
    if (batch.length < 100) return pulls;
  }
}

/**
 * Files changed in a PR, with the new text of data files read at the PR head.
 * @returns {Promise<{path: string, status: string, content?: string, baseContent?: string}[]>}
 */
async function pullChanges(pull, { wantContent = p => p.startsWith('data/') && p.endsWith('.yaml') } = {}) {
  const files = [];
  for (let page = 1; ; page++) {
    const batch = await check(rest(`/repos/${REPO}/pulls/${pull.number}/files?per_page=100&page=${page}`), 'list PR files');
    files.push(...batch);
    if (batch.length < 100) break;
  }
  const headRepo = (pull.head.repo && pull.head.repo.full_name) || REPO;
  const changes = [];
  for (const f of files) {
    if (f.status === 'renamed') {
      changes.push({ path: f.previous_filename, status: 'removed' });
      changes.push({ path: f.filename, status: 'added' });
    } else {
      changes.push({ path: f.filename, status: f.status === 'changed' ? 'modified' : f.status });
    }
  }
  for (const change of changes) {
    if (change.status === 'removed' || !wantContent(change.path)) continue;
    change.content = await fileText(headRepo, change.path, pull.head.sha);
    if (change.status === 'modified') change.baseContent = await fileText(REPO, change.path, pull.base.sha);
  }
  return changes;
}

async function fileText(repo, filePath, ref) {
  const res = await rest(`/repos/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`);
  if (res.status !== 200 || !res.data || typeof res.data.content !== 'string') return undefined;
  return Buffer.from(res.data.content, 'base64').toString('utf8');
}

/**
 * Re-run the latest "validate" workflow run for a commit, or dispatch one on a same-repo branch.
 */
async function revalidate(pull) {
  const runs = await check(rest(`/repos/${REPO}/actions/workflows/validate-pr.yml/runs?head_sha=${pull.head.sha}&per_page=5`), 'list runs');
  const run = runs.workflow_runs && runs.workflow_runs[0];
  if (run && run.status === 'completed') {
    return rest(`/repos/${REPO}/actions/runs/${run.id}/rerun`, { method: 'POST' });
  }
  if (!run && pull.head.repo && pull.head.repo.full_name === REPO) {
    return rest(`/repos/${REPO}/actions/workflows/validate-pr.yml/dispatches`, { method: 'POST', body: { ref: pull.head.ref } });
  }
  return null;
}

module.exports = {
  BOT_LABELS, REPO, TRIAGE_LABELS,
  addLabels, comment, ensureLabels, fileText, listComments, listOpenPulls, pullChanges, revalidate, setTriageLabels, upsertComment
};
