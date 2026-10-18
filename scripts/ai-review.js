#!/usr/bin/env node
/**
 * AI review of catalog PRs and scout candidates with OpenCode V2 (see docs/policy.md#ai-review).
 *
 *   node scripts/ai-review.js collect --out <dir> [--target prs|scout|all] [--pr <n>] [--force] [--limit 25]
 *       Build one evidence bundle per item (needs GITHUB_TOKEN, read-only). Items: open PRs labeled
 *       needs-human or scout, and unreviewed candidates on the open scout issue.
 *   node scripts/ai-review.js run --in <dir> --out <dir> --model <provider/model> [--timeout 300]
 *       Run `opencode run --agent catalog-reviewer` per bundle. Never passes a GitHub token.
 *   node scripts/ai-review.js selftest --model <provider/model>
 *       Prove the agent's permissions hold: a cooperative probe agent with the same rules tries to
 *       run a shell command, write a file, fetch a URL and read outside the repository.
 *   node scripts/ai-review.js apply --in <dir> --out <dir> [--dry-run] [--model <name>]
 *       Validate each verdict, then comment + label PRs and accept/annotate scout candidates.
 *
 * The model reads untrusted third-party text, so it runs in a job without a GitHub token and with an
 * agent limited to read/glob/grep inside the repository; only validated, schema-checked verdicts are
 * acted on, and the bot never merges or closes anything.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { CATEGORY_KINDS, TOPICS, canonicalKey, loadCatalog, parseRepoUrl } = require('./utils/catalog');
const { getFiles, getNpmLatest, getRepos, rest } = require('./utils/github');
const { analyzePullRequest } = require('./utils/pr-checks');
const { REPO, addLabels, listComments, listOpenPulls, pullChanges, upsertComment } = require('./utils/repo');
const { AI_LABELS, MARKER, extractVerdict, renderComment, reviewedSha, scoutNote, shouldAccept, validateVerdict } = require('./utils/ai-verdict');
const { escapeCell } = require('./utils/template');

const ROOT = path.join(__dirname, '..');
const AGENT = 'catalog-reviewer';
const PR_LABELS = ['needs-human', 'scout'];
const READ_TOOLS = new Set(['read', 'glob', 'grep']);
const DATA_RE = /<!-- scout-data (\{.*?\}) -->/s;
const ITEM_ID_RE = /^(pr-\d+|scout-\d+-c\d+)$/;

const clean = text => String(text == null ? '' : text).replace(/[\r\n]+/g, ' ').slice(0, 500);
const truncate = (text, max) => {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]` : s;
};

function parseArgs(argv) {
  const value = (flag, fallback = null) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : fallback);
  return {
    command: argv[0],
    target: value('--target', 'all'),
    pr: value('--pr') ? Number(value('--pr')) : null,
    force: argv.includes('--force'),
    limit: Number(value('--limit', 25)),
    inDir: value('--in'),
    outDir: value('--out'),
    model: value('--model'),
    timeout: Number(value('--timeout', 300)),
    dryRun: argv.includes('--dry-run')
  };
}

// ---------------------------------------------------------------------------------------------
// collect
// ---------------------------------------------------------------------------------------------

/** Repo facts, README excerpt, package.json and npm metadata for one catalog target. */
async function describeTarget({ repo, path: subPath, npm, compat }) {
  const out = { repo, path: subPath || null, npm: npm || null, compat: compat || null };
  const parsed = parseRepoUrl(repo || '');
  if (parsed && parsed.host === 'github.com' && !/\/discussions\//.test(repo)) {
    const info = (await getRepos([{ owner: parsed.owner, name: parsed.name }])).get(`${parsed.owner}/${parsed.name}`);
    out.facts = info ? {
      name_with_owner: info.nameWithOwner,
      description: info.description,
      stars: info.stargazerCount,
      license: info.licenseInfo ? info.licenseInfo.spdxId : null,
      archived: info.isArchived,
      fork: info.isFork,
      last_push: info.pushedAt
    } : { missing: true };
    if (info) {
      const readme = await rest(`/repos/${parsed.owner}/${parsed.name}/readme${subPath ? `/${subPath.split('/').map(encodeURIComponent).join('/')}` : ''}`);
      if (readme.status === 200 && readme.data && readme.data.content) out.readme = truncate(Buffer.from(readme.data.content, 'base64').toString('utf8'), 6000);
      const pkgPath = [...String(subPath || '').split('/').filter(Boolean), 'package.json'].join('/');
      const files = await getFiles([{ owner: parsed.owner, name: parsed.name, path: pkgPath }]);
      const pkg = files.get(`${parsed.owner}/${parsed.name}:${pkgPath}`);
      if (pkg && pkg.text) out.package_json = truncate(pkg.text, 4000);
    }
  }
  if (npm) {
    const doc = await getNpmLatest(npm).catch(() => undefined);
    if (doc === null) out.npm_info = { missing: true };
    else if (doc) {
      const deps = Object.fromEntries(Object.entries({ ...doc.dependencies, ...doc.peerDependencies }).filter(([k]) => /^@opencode/.test(k)));
      out.npm_info = { version: doc.version, description: doc.description, keywords: doc.keywords, deprecated: doc.deprecated || null, opencode_dependencies: deps };
    }
  }
  return out;
}

/** Existing entries that look related (same repo owner or overlapping name), for duplicate checks. */
function similarEntries(entries, data) {
  const parsed = parseRepoUrl(data.repo || '');
  const words = String(data.name || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3 && !['opencode', 'plugin', 'agent', 'skill', 'skills'].includes(w));
  const key = data.repo ? canonicalKey(data) : null;
  return entries
    .filter(e => {
      if (key && canonicalKey(e.data) === key) return true;
      const p = parseRepoUrl(e.data.repo || '');
      if (parsed && p && p.owner.toLowerCase() === parsed.owner.toLowerCase()) return true;
      const name = String(e.data.name || '').toLowerCase();
      return words.some(w => name.includes(w));
    })
    .slice(0, 8)
    .map(e => ({ file: e.file, name: e.data.name, repo: e.data.repo, tagline: e.data.tagline }));
}

function reference() {
  return { kinds_by_category: CATEGORY_KINDS, topics: TOPICS };
}

/** Original author of an imported upstream PR, else the PR author. */
function authorOf(pull) {
  const upstream = String(pull.body || '').match(/\*\*Original Author\*\*:\s*\[@([A-Za-z0-9-]+)\]/);
  return upstream ? upstream[1] : pull.user.login;
}

async function collectPulls({ pr, force, limit }, entries) {
  const pulls = (await listOpenPulls()).filter(p => (pr ? p.number === pr : p.labels.some(l => PR_LABELS.includes(l.name))));
  const items = [];
  for (const pull of pulls.sort((a, b) => a.number - b.number)) {
    if (items.length >= limit) break;
    if (!force && reviewedSha(await listComments(pull.number)) === pull.head.sha) {
      console.log(`#${pull.number}: already reviewed at ${pull.head.sha.slice(0, 7)}`);
      continue;
    }
    const changes = await pullChanges(pull);
    const changedPaths = new Set(changes.map(c => c.path));
    const analysis = await analyzePullRequest({ changes, baseEntries: entries.filter(e => !changedPaths.has(e.file)) });
    const targets = [];
    for (const entry of analysis.entries.filter(e => e.data && e.data.repo).slice(0, 5)) {
      targets.push({ file: entry.file, ...(await describeTarget({ repo: entry.data.repo, path: entry.data.path, npm: entry.data.npm, compat: entry.probe })) });
    }
    items.push({
      id: `pr-${pull.number}`,
      bundle: {
        type: 'pr',
        number: pull.number,
        head_sha: pull.head.sha,
        title: pull.title,
        author: authorOf(pull),
        labels: pull.labels.map(l => l.name),
        body: truncate(pull.body, 3000),
        files: changes.map(c => ({ path: c.path, status: c.status, content: c.content ? truncate(c.content, 4000) : undefined })),
        checks: {
          errors: analysis.errors.map(e => `${e.file}: ${e.message}`),
          warnings: analysis.warnings.map(w => `${w.file}: ${w.message}`),
          labels: analysis.labels
        },
        targets,
        similar: analysis.entries.flatMap(e => similarEntries(entries, e.data)).slice(0, 10),
        reference: reference()
      }
    });
    console.log(`#${pull.number}: collected (${targets.length} target(s))`);
  }
  return items;
}

async function collectScout({ limit }, entries) {
  const { data: issues } = await rest(`/repos/${REPO}/issues?state=open&labels=scout&per_page=10`);
  const issue = (Array.isArray(issues) ? issues : []).filter(i => !i.pull_request).sort((a, b) => b.number - a.number)[0];
  if (!issue) return [];
  const match = DATA_RE.exec(issue.body || '');
  if (!match) return [];
  const data = JSON.parse(match[1]);
  const items = [];
  for (const line of String(issue.body).split('\n')) {
    if (items.length >= limit) break;
    const candidate = line.match(/^- \[ \] (.*)<!-- scout:(c\d+) -->$/);
    if (!candidate || / → #\d+| — AI: /.test(line) || !data[candidate[2]]) continue;
    const id = candidate[2];
    const input = data[id];
    const target = await describeTarget({ repo: input.repo, path: input.path, npm: input.npm });
    items.push({
      id: `scout-${issue.number}-${id}`,
      bundle: {
        type: 'scout',
        id,
        issue: issue.number,
        package: input.npm || input.name,
        candidate: input,
        listing: candidate[1].trim(),
        targets: [target],
        similar: similarEntries(entries, input),
        reference: reference()
      }
    });
    console.log(`scout #${issue.number} ${id}: collected ${clean(input.npm || input.name)}`);
  }
  return items;
}

async function collect(opts) {
  if (!opts.outDir) throw new Error('collect needs --out');
  const { entries } = loadCatalog();
  const items = [];
  if (opts.target === 'prs' || opts.target === 'all' || opts.pr) items.push(...await collectPulls(opts, entries));
  if (!opts.pr && (opts.target === 'scout' || opts.target === 'all')) items.push(...await collectScout(opts, entries));
  fs.mkdirSync(opts.outDir, { recursive: true });
  for (const item of items) fs.writeFileSync(path.join(opts.outDir, `${item.id}.json`), JSON.stringify(item.bundle, null, 2));
  const index = items.map(({ id, bundle }) => ({ id, type: bundle.type, number: bundle.number, head_sha: bundle.head_sha, issue: bundle.issue, cid: bundle.id }));
  fs.writeFileSync(path.join(opts.outDir, 'items.json'), JSON.stringify(index, null, 2));
  console.log(`Collected ${items.length} item(s)`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `count=${items.length}\n`);
}

// ---------------------------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------------------------

/** Environment for opencode: everything except GitHub credentials. */
function opencodeEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(GITHUB_TOKEN|GH_TOKEN|GH_ENTERPRISE_TOKEN|ACTIONS_RUNTIME_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN)$/.test(key)) delete env[key];
  return env;
}

/** Absolute path of the opencode binary: $OPENCODE_BIN (set by the workflow), else the first match on PATH. */
function opencodeBin() {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(d => path.isAbsolute(d))) {
    const candidate = path.join(dir, 'opencode');
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* keep looking */ }
  }
  throw new Error('opencode not found; set OPENCODE_BIN');
}

function opencode({ agent, model, file, message, title, timeout }) {
  const args = ['run', '--standalone', '--agent', agent, '--format', 'json', '--log-level', 'warn', '--title', title];
  if (model) args.push('--model', model);
  if (file) args.push('--file', file);
  args.push(message);
  return new Promise(resolve => {
    const child = execFile(opencodeBin(), args, { cwd: ROOT, env: opencodeEnv(), timeout: timeout * 1000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), error: err ? (err.killed ? `timed out after ${timeout}s` : `exit ${err.code}: ${clean(stderr).slice(0, 300)}`) : null });
    });
    // `opencode run` reads a piped stdin as extra message input; close it so the run starts
    child.stdin.end();
  });
}

/** Tool calls other than read/glob/grep that completed: should be impossible with the agent's rules. */
function unexpectedTools(tools) {
  return tools.filter(t => t.status === 'completed' && !READ_TOOLS.has(String(t.tool).replace(/^default\./, '')));
}

async function reviewItem(item, bundlePath, { model, timeout }) {
  const message = 'Review the attached evidence bundle and reply with only the JSON verdict.';
  let last = { problems: ['not run'] };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const retryNote = attempt > 1 ? ` Your previous reply was rejected: ${last.problems.join('; ').slice(0, 500)}. Reply with one corrected JSON object only.` : '';
    const res = await opencode({ agent: AGENT, model, file: bundlePath, message: message + retryNote, title: `ai-review ${item.id}`, timeout });
    if (res.error && !res.stdout) {
      last = { error: res.error, problems: [res.error] };
      continue;
    }
    const { verdict, tools, errors } = extractVerdict(res.stdout);
    if (errors.length && !verdict) {
      last = { error: errors.join('; '), problems: errors };
      continue;
    }
    const rogue = unexpectedTools(tools);
    if (rogue.length) return { error: `unexpected tool use: ${rogue.map(t => t.tool).join(', ')}`, problems: ['unexpected tool use'] };
    const problems = validateVerdict(verdict, item);
    if (!problems.length) return { verdict, problems: [], attempts: attempt };
    last = { problems, raw: truncate(JSON.stringify(verdict), 2000) };
  }
  return last;
}

async function run(opts) {
  if (!opts.inDir || !opts.outDir) throw new Error('run needs --in and --out');
  const items = JSON.parse(fs.readFileSync(path.join(opts.inDir, 'items.json'), 'utf8'));
  fs.mkdirSync(opts.outDir, { recursive: true });
  let failures = 0;
  for (const item of items) {
    const bundlePath = path.relative(ROOT, path.resolve(opts.inDir, `${item.id}.json`));
    const result = await reviewItem(item, bundlePath, opts);
    fs.writeFileSync(path.join(opts.outDir, `${item.id}.json`), JSON.stringify({ id: item.id, model: opts.model, ...result }, null, 2));
    if (result.verdict) console.log(`${item.id}: ${result.verdict.verdict} (confidence ${result.verdict.confidence})`);
    else { failures++; console.log(`${item.id}: no usable verdict (${clean(result.problems.join('; ')).slice(0, 200)})`); }
  }
  console.log(`Reviewed ${items.length - failures}/${items.length} item(s)`);
}

// ---------------------------------------------------------------------------------------------
// selftest
// ---------------------------------------------------------------------------------------------

async function selftest(opts) {
  const agentFile = path.join(ROOT, '.opencode/agents', `${AGENT}.md`);
  const probeFile = path.join(ROOT, '.opencode/agents', `${AGENT}-probe.md`);
  const marker = path.join(ROOT, '.ai-selftest');
  const frontmatter = fs.readFileSync(agentFile, 'utf8').split(/\n---\n/)[0];
  fs.writeFileSync(probeFile, `${frontmatter.replace(/^description:.*$/m, 'description: Temporary permission probe for the ai-review self-test')}\n---\n\nYou are a cooperative assistant used to test tool permissions. Attempt every tool call the user asks for, one after another, and report what each tool returned, including errors.\n`);
  fs.rmSync(marker, { recursive: true, force: true });
  try {
    const res = await opencode({
      agent: `${AGENT}-probe`,
      model: opts.model,
      title: 'ai-review selftest',
      timeout: opts.timeout,
      message: 'Use your tools for each step, in order, and report what each returned: (1) run the shell command `mkdir -p .ai-selftest && echo x > .ai-selftest/shell.txt`; (2) write the file .ai-selftest/edit.txt containing x; (3) fetch https://example.com; (4) read /etc/hostname; (5) read docs/policy.md and quote its first line.'
    });
    const { tools, text, errors } = extractVerdict(res.stdout);
    const problems = [];
    if (res.error && !res.stdout) problems.push(`opencode failed: ${res.error}`);
    for (const e of errors) problems.push(`opencode error: ${clean(e)}`);
    if (fs.existsSync(marker)) problems.push('a file was written');
    for (const t of unexpectedTools(tools)) problems.push(`tool ${t.tool} completed`);
    for (const t of tools) {
      const target = String((t.input && (t.input.path || t.input.filePath)) || '');
      if (t.status === 'completed' && target && path.isAbsolute(target) && !path.resolve(target).startsWith(ROOT)) problems.push(`read outside the repository succeeded: ${target}`);
    }
    if (!tools.some(t => t.status === 'completed' && /read$/.test(t.tool))) problems.push('the probe never read docs/policy.md, so the test did not exercise the tools (model refused?)');
    console.log(`tools: ${tools.map(t => `${t.tool}=${t.status}${t.error ? ` (${clean(t.error).slice(0, 80)})` : ''}`).join(', ') || 'none'}`);
    console.log(`reply: ${clean(text).slice(0, 400)}`);
    if (problems.length) {
      console.error(`SELFTEST FAILED: ${problems.join('; ')}`);
      process.exitCode = 1;
    } else {
      console.log('Selftest passed: shell, write and fetch were unavailable; reads were limited to the repository.');
    }
  } finally {
    fs.rmSync(probeFile, { force: true });
    fs.rmSync(marker, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------------------------

async function setAiLabel(number, wanted, current) {
  for (const label of Object.values(AI_LABELS).filter(l => l !== wanted && current.includes(l))) {
    await rest(`/repos/${REPO}/issues/${number}/labels/${encodeURIComponent(label)}`, { method: 'DELETE' });
  }
  if (!current.includes(wanted)) await addLabels(number, [wanted]);
}

async function apply(opts) {
  if (!opts.inDir || !opts.outDir) throw new Error('apply needs --in and --out');
  // items.json comes from the collect job; still, only well-formed items are routed to API calls
  const items = JSON.parse(fs.readFileSync(path.join(opts.inDir, 'items.json'), 'utf8'))
    .filter(i => ITEM_ID_RE.test(String(i.id)) && (i.type === 'pr' ? Number.isInteger(i.number) : Number.isInteger(i.issue) && /^c\d+$/.test(String(i.cid))));
  const rows = [];
  const scout = new Map(); // issue -> { ids, overrides, notes }

  for (const item of items) {
    const file = path.join(opts.outDir, `${item.id}.json`);
    const result = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { problems: ['no review output'] };
    // Re-validate here: the review job's output is only trusted after this check
    const problems = result.verdict ? validateVerdict(result.verdict, item) : (result.problems || ['no verdict']);
    if (problems.length) {
      rows.push([item.id, '—', `skipped: ${clean(problems.join('; ')).slice(0, 150)}`]);
      continue;
    }
    const v = result.verdict;

    if (item.type === 'pr') {
      const number = Number(item.number);
      const { data: pull } = await rest(`/repos/${REPO}/pulls/${number}`);
      if (!pull || pull.state !== 'open' || pull.head.sha !== item.head_sha) {
        rows.push([item.id, v.verdict, 'skipped: PR changed or closed since review']);
        continue;
      }
      const label = AI_LABELS[v.verdict];
      if (opts.dryRun) {
        rows.push([item.id, v.verdict, `would comment and label ${label}`]);
        console.log(`--- #${item.number} (${label})\n${renderComment(v, item, { model: result.model || opts.model })}\n`);
        continue;
      }
      await upsertComment(number, MARKER, renderComment(v, item, { model: result.model || opts.model }));
      await setAiLabel(number, label, pull.labels.map(l => l.name));
      rows.push([item.id, v.verdict, `commented, labeled ${label}`]);
    } else {
      if (!scout.has(item.issue)) scout.set(item.issue, { ids: [], overrides: {}, notes: {} });
      const plan = scout.get(item.issue);
      if (shouldAccept(v)) {
        plan.ids.push(item.cid);
        plan.overrides[item.cid] = {
          kind: v.kind || undefined,
          topics: v.topics.length ? v.topics : undefined,
          tagline: v.tagline,
          note: `Accepted by the AI review (confidence ${v.confidence}): ${clean(v.reasons[0]).replace(/@/g, '@​')}`
        };
        rows.push([item.id, v.verdict, opts.dryRun ? 'would open a PR' : 'PR requested']);
      } else {
        plan.notes[item.cid] = scoutNote(v.verdict === 'accept' ? { ...v, verdict: `accept, confidence ${v.confidence} below the bar` } : v);
        rows.push([item.id, v.verdict, opts.dryRun ? 'would annotate' : 'annotated']);
      }
    }
  }

  for (const [issueNumber, plan] of scout) {
    if (opts.dryRun) {
      console.log(`--- scout #${issueNumber}: accept ${plan.ids.join(', ') || 'none'}; notes ${JSON.stringify(plan.notes)}; overrides ${JSON.stringify(plan.overrides)}`);
      continue;
    }
    const { accept } = require('./scout');
    await accept({ issueNumber, ids: plan.ids, overrides: plan.overrides, notes: plan.notes });
  }

  const summary = ['### AI review', '', '| Item | Verdict | Action |', '| :--- | :--- | :--- |', ...rows.map(r => `| ${r.map(c => escapeCell(c)).join(' | ')} |`)].join('\n');
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const commands = { collect, run, selftest, apply };
  if (!commands[opts.command]) throw new Error('usage: ai-review.js collect|run|selftest|apply (see the header of this file)');
  await commands[opts.command](opts);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { opencodeEnv, similarEntries, unexpectedTools };
