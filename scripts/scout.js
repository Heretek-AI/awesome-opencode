#!/usr/bin/env node
/**
 * Discover OpenCode V2 plugins that are not in the catalog yet.
 *
 * Usage:
 *   node scripts/scout.js run [--dry-run] [--limit 20]   weekly: post a ranked candidate issue
 *   node scripts/scout.js accept --issue <n> [--sender <login>] [--dry-run]
 *                                                        open PRs for ticked candidates (sender needs write access)
 *
 * Sources: npm search (packages published since V2 shipped, depending on @opencode/*). npm gives
 * structured dependencies, download counts and repository links; GitHub code search caps at
 * 1,000 results per query and only reports approximate counts.
 * Gates: public, not archived, not a fork, has a license, V2 dependency. Ranking: weekly downloads,
 * then stars. Humans pick; the bot only does the typing.
 */

const fs = require('fs');
const path = require('path');
const { canonicalKey, loadCatalog, parseRepoUrl } = require('./utils/catalog');
const { manifestMarkers } = require('./utils/compat');
const { getNpmLatest, getNpmWeeklyDownloads, getRepos, rest } = require('./utils/github');
const { openPullRequest } = require('./utils/git-pr');
const { REPO, ensureLabels, listOpenPulls } = require('./utils/repo');
const { buildEntry } = require('./utils/submission');
const { suggestKind, suggestTopics } = require('./utils/suggest');

const V2_RELEASED = '2026-09-02';
const SEARCHES = ['keywords:opencode-plugin', '@opencode/plugin', 'keywords:opencode'];
const DECLINED_FILE = path.join(__dirname, '../discovery/declined.txt');
const DATA_RE = /<!-- scout-data (\{.*?\}) -->/s;
const ACCEPT_LIMIT = 10;

async function npmSearch(text) {
  const results = [];
  for (let from = 0; from < 1000; from += 250) {
    const res = await fetch(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=250&from=${from}`, { headers: { 'User-Agent': 'awesome-opencode-bot' } });
    if (!res.ok) break;
    const body = await res.json();
    results.push(...body.objects.map(o => o.package));
    if (body.objects.length < 250) break;
  }
  return results;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]).catch(() => null);
    }
  }));
  return out;
}

function readDeclined() {
  if (!fs.existsSync(DECLINED_FILE)) return new Set();
  return new Set(fs.readFileSync(DECLINED_FILE, 'utf8').split('\n').map(l => l.replace(/#.*/, '').trim().toLowerCase()).filter(Boolean));
}

function repoFromManifest(manifest) {
  const raw = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository && manifest.repository.url;
  const m = String(raw || '').match(/github\.com[/:]([^/]+)\/([^/#.]+?)(?:\.git)?(?:[#/]|$)/) || String(raw || '').match(/^github:([^/]+)\/(.+)$/) || String(raw || '').match(/^([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!m) return null;
  const directory = manifest.repository && manifest.repository.directory;
  return { repo: `https://github.com/${m[1]}/${m[2]}`, path: directory ? String(directory).replace(/^\.?\/+|\/+$/g, '') : undefined };
}

/** Repo URLs and npm names already targeted by open PRs. */
async function openPullTargets() {
  const targets = new Set();
  for (const pull of await listOpenPulls()) {
    const { data: files } = await rest(`/repos/${REPO}/pulls/${pull.number}/files?per_page=100`);
    for (const f of Array.isArray(files) ? files : []) {
      for (const m of String(f.patch || '').matchAll(/^\+\s*(repo|npm):\s*["']?([^\s"']+)/gm)) {
        targets.add(m[1] === 'repo' ? canonicalKey({ repo: m[2] }) : `npm:${m[2].toLowerCase()}`);
      }
    }
  }
  return targets;
}

function truncate(text, max) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
}

async function findCandidates(limit) {
  const { entries } = loadCatalog();
  const known = new Set(entries.map(e => canonicalKey(e.data)));
  entries.forEach(e => e.data.npm && known.add(`npm:${e.data.npm.toLowerCase()}`));
  const declined = readDeclined();
  const pending = await openPullTargets();

  const seen = new Map();
  for (const query of SEARCHES) {
    for (const pkg of await npmSearch(query)) {
      if (pkg.date >= V2_RELEASED && !seen.has(pkg.name)) seen.set(pkg.name, pkg);
    }
  }
  const fresh = [...seen.values()].filter(p => !known.has(`npm:${p.name}`) && !pending.has(`npm:${p.name}`) && !declined.has(p.name.toLowerCase()));
  console.log(`npm: ${seen.size} packages published since ${V2_RELEASED}, ${fresh.length} not yet listed`);

  const manifests = await mapLimit(fresh, 8, p => getNpmLatest(p.name));
  const v2 = [];
  fresh.forEach((pkg, i) => {
    const manifest = manifests[i];
    if (!manifest || manifest.deprecated) return;
    const markers = manifestMarkers(manifest);
    const source = repoFromManifest(manifest);
    if (!markers.v2.length || !source) return;
    const key = canonicalKey(source);
    const repoKey = canonicalKey({ repo: source.repo });
    if (known.has(key) || known.has(repoKey) || pending.has(repoKey) || declined.has(key) || declined.has(repoKey)) return;
    v2.push({ pkg, manifest, source, markers });
  });
  console.log(`${v2.length} depend on @opencode/* with a GitHub repo`);

  const repos = await getRepos(v2.map(c => { const p = parseRepoUrl(c.source.repo); return { owner: p.owner, name: p.name }; }));
  const gated = v2.filter(c => {
    const p = parseRepoUrl(c.source.repo);
    const info = repos.get(`${p.owner}/${p.name}`);
    c.info = info;
    if (!info || info.isArchived || info.isFork || info.isPrivate || !(info.licenseInfo || c.manifest.license)) return false;
    // npm repository links often point at a pre-transfer name; dedupe on GitHub's canonical name
    c.source.repo = `https://github.com/${info.nameWithOwner}`;
    const key = canonicalKey({ repo: c.source.repo });
    return !known.has(key) && !known.has(canonicalKey(c.source)) && !pending.has(key) && !declined.has(key);
  });
  // One candidate per repo (monorepos publish several packages; keep the most downloaded)
  await mapLimit(gated, 8, async c => { c.downloads = await getNpmWeeklyDownloads(c.pkg.name); });
  const byRepo = new Map();
  for (const c of gated) {
    const key = canonicalKey(c.source);
    if (!byRepo.has(key) || byRepo.get(key).downloads < c.downloads) byRepo.set(key, c);
  }
  const ranked = [...byRepo.values()].sort((a, b) => b.downloads - a.downloads || b.info.stargazerCount - a.info.stargazerCount);
  console.log(`${gated.length} pass the gates; ${ranked.length} distinct repos`);
  return ranked.slice(0, limit);
}

function candidateInput(c) {
  const description = truncate(c.info.description || c.manifest.description || c.pkg.description || '', 600);
  const text = [c.pkg.name, description, (c.manifest.keywords || []).join(' ')].join(' ');
  // Packages built on the plugin API are plugins; other @opencode/* consumers (SDK/client) are projects
  const isPlugin = c.markers.v2.some(m => /^@opencode(-ai)?\/plugin\b/.test(m));
  const category = isPlugin ? 'plugins' : 'projects';
  return {
    name: c.pkg.name,
    repo: c.source.repo,
    path: c.source.path,
    npm: c.pkg.name,
    category,
    kind: isPlugin ? 'plugin' : suggestKind('projects', text),
    topics: suggestTopics(text),
    tagline: truncate(c.manifest.description || description || c.pkg.name, 120),
    description: description || c.pkg.name
  };
}

async function run({ dryRun, limit }) {
  const candidates = await findCandidates(limit);
  const week = new Date().toISOString().slice(0, 10);
  const data = {};
  const lines = candidates.map((c, i) => {
    const id = `c${i + 1}`;
    data[id] = candidateInput(c);
    const label = data[id].category === 'plugins' ? 'plugin' : data[id].kind;
    return `- [ ] **${c.pkg.name}** (${label}) — ${truncate(c.manifest.description || '', 140)} · ⭐ ${c.info.stargazerCount} · ⬇ ${c.downloads}/wk · [repo](${c.source.repo}) · [npm](https://www.npmjs.com/package/${c.pkg.name}) <!-- scout:${id} -->`;
  });
  const body = [
    `OpenCode V2 packages on npm that are not in the catalog yet: published since ${V2_RELEASED}, depending on \`@opencode/*\` (plugins on \`@opencode/plugin\`, other tools on the SDK/client), public, licensed, not archived or forked. Ranked by weekly downloads, then stars.`,
    '',
    '**Tick a box to open a pull request for that candidate** (maintainers only; topics are a keyword guess, fix them in the PR). To stop suggesting a package, add it to [`discovery/declined.txt`](https://github.com/Heretek-AI/awesome-opencode/blob/main/discovery/declined.txt).',
    '',
    ...(lines.length ? lines : ['_No new candidates this week._']),
    '',
    `<!-- scout-data ${JSON.stringify(data)} -->`
  ].join('\n');

  if (dryRun) return console.log(body);

  await ensureLabels(['scout']);
  const { data: open } = await rest(`/repos/${REPO}/issues?state=open&labels=scout&per_page=20`);
  for (const old of Array.isArray(open) ? open : []) {
    if (!old.pull_request) await rest(`/repos/${REPO}/issues/${old.number}`, { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } });
  }
  const res = await rest(`/repos/${REPO}/issues`, { method: 'POST', body: { title: `Scout: V2 candidates (${week})`, body, labels: ['scout'] } });
  console.log(`Opened scout issue #${res.data.number} with ${candidates.length} candidate(s)`);
}

async function accept({ issueNumber, sender, dryRun }) {
  if (sender) {
    const { data } = await rest(`/repos/${REPO}/collaborators/${encodeURIComponent(sender)}/permission`);
    if (!data || !['admin', 'maintain', 'write'].includes(data.permission)) {
      return console.log(`${sender} does not have write access; ignoring`);
    }
  }
  const { data: issue } = await rest(`/repos/${REPO}/issues/${issueNumber}`);
  const match = DATA_RE.exec(issue.body || '');
  if (!match) return console.log('no scout data in issue');
  const data = JSON.parse(match[1]);
  let body = issue.body;
  let opened = 0;
  for (const line of body.split('\n')) {
    const ticked = line.match(/^- \[x\] .*<!-- scout:(c\d+) -->$/i);
    if (!ticked || / → #\d+/.test(line) || opened >= ACCEPT_LIMIT) continue;
    const input = data[ticked[1]];
    if (!input) continue;
    const result = await buildEntry(input);
    let note;
    if (!result.ok) {
      note = ` → not added: ${result.problems.join('; ').slice(0, 200)}`;
    } else {
      const pr = await openPullRequest({
        branch: `scout/${result.file.replace(/^data\/[a-z]+\/|\.yaml$/g, '')}`,
        files: { [result.file]: result.text },
        title: `docs: add ${input.name} to ${input.category}`,
        body: [`Found by the weekly scout in #${issueNumber}.`, '', ...result.notes.map(n => `- ${n}`), '', 'Topics are a keyword guess; adjust them before merging.'].join('\n'),
        labels: ['scout', `category: ${input.category}`],
        dryRun
      });
      note = pr ? ` → #${pr.number}` : ' → (no changes)';
      opened++;
    }
    body = body.replace(line, line.replace(/ <!-- scout:/, `${note} <!-- scout:`));
  }
  if (!dryRun && body !== issue.body) await rest(`/repos/${REPO}/issues/${issueNumber}`, { method: 'PATCH', body: { body } });
  console.log(`Processed ${opened} ticked candidate(s)`);
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  if (command === 'run') {
    const limit = argv.includes('--limit') ? Number(argv[argv.indexOf('--limit') + 1]) : 20;
    await run({ dryRun, limit });
  } else if (command === 'accept') {
    const sender = argv.includes('--sender') ? argv[argv.indexOf('--sender') + 1] : null;
    await accept({ issueNumber: Number(argv[argv.indexOf('--issue') + 1]), sender, dryRun });
  } else {
    throw new Error('usage: scout.js run|accept --issue <n> [--dry-run]');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
