/**
 * OpenCode V1/V2 compatibility probe.
 *
 * V2 marker: any dependency on an @opencode/* package (@opencode/plugin, client, sdk, theme, core),
 * including npm aliases like "plugin-v2": "npm:@opencode/plugin@2.0.14". The V2 API also shipped as
 * pre-releases under the old name before the rename (@opencode-ai/plugin@0.0.0-beta-*, @next, @beta,
 * and @opencode-ai/client, which only exists in the V2 era); those count as V2 too. Packages that
 * depend on both generations are dual-support and count as V2.
 * V1 marker: @opencode-ai/plugin or @opencode-ai/sdk at a 1.x (or unpinned) version, with no V2 marker.
 *
 * Sources, in order: the entry's npm package (latest version), then package.json files in the repo
 * (at `path`, the root, and workspace packages under packages/ or plugins/), then source text for
 * gists. Anything else is "unknown" and needs a human look.
 */

const zlib = require('zlib');
const { getFiles, getNpmLatest, getToken, rest } = require('./github');
const { parseRepoUrl } = require('./catalog');

const SOURCE_FILE_RE = /\.(m?[jt]sx?|cjs|cts)$/;
const SKIP_DIR_RE = /(^|\/)(node_modules|\.git|vendor|fixtures?|__tests__|test|tests|examples?)\//;
const MAX_TARBALL_BYTES = 30 * 1024 * 1024;
// Legacy V1 plugin shape: an exported async function receiving { client, project, directory, $, ... }
// and returning hooks such as event, chat.params or tool.execute.before
const V1_HOOK_RE = /["']?(chat\.params|chat\.message|tool\.execute\.(before|after)|permission\.ask|shell\.env)["']?\s*:\s*async|\bevent\s*:\s*async\s*\(\s*\{\s*event\b/;
// V2 plugin contract without the helper: an object with an id and a setup(ctx) entry point
// (Plugin.define is an identity function, so dependency-free V2 plugins export this directly)
const V2_OBJECT_RE = /\{[^{}]*\bid\s*:\s*[\w"'`][^{}]*\b(async\s+)?setup\s*[:,(}]/;
const V1_EXPORT_RE = /export\s+(const|default)\s+(\w+\s*(:\s*Plugin\s*)?=\s*)?async\s*(function\s*\w*\s*)?\(\s*\{[^}]*\b(client|project|directory|worktree|\$)\b/;

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const V1_PACKAGES = ['@opencode-ai/plugin', '@opencode-ai/sdk'];
const V2_ERA_PACKAGES = ['@opencode-ai/client'];
const V2_PRERELEASE_SPEC = /^(?:[\^~]|>=?\s*)?(?:0\.0\.0-(?:beta|next|tui-v2)|beta$|next$)/;
const WORKSPACE_DIRS = ['packages', 'plugins'];
const MAX_WORKSPACE_PACKAGES = 25;

/**
 * Resolve each dependency (key or npm: alias target) to the real package name and version spec.
 * @param {object} manifest - package.json contents
 * @returns {{name: string, spec: string}[]}
 */
function dependencies(manifest) {
  const deps = [];
  for (const field of DEP_FIELDS) {
    for (const [key, raw] of Object.entries((manifest && manifest[field]) || {})) {
      const spec = typeof raw === 'string' ? raw : '';
      const alias = spec.match(/^npm:((?:@[^/@]+\/)?[^@]+)(?:@(.*))?$/);
      deps.push(alias ? { name: alias[1], spec: alias[2] || '' } : { name: key, spec });
    }
  }
  return deps;
}

/**
 * Markers found in one manifest.
 * @param {object} manifest
 * @returns {{v2: string[], v1: string[]}}
 */
function manifestMarkers(manifest) {
  const v2 = new Set();
  const v1 = new Set();
  for (const { name, spec } of dependencies(manifest)) {
    if (name.startsWith('@opencode/')) v2.add(name);
    else if (V2_ERA_PACKAGES.includes(name)) v2.add(`${name} (V2 pre-release)`);
    else if (V1_PACKAGES.includes(name) && V2_PRERELEASE_SPEC.test(spec.trim())) v2.add(`${name}@${spec} (V2 pre-release)`);
    else if (V1_PACKAGES.includes(name)) v1.add(spec ? `${name}@${spec}` : name);
  }
  return { v2: [...v2], v1: [...v1] };
}

/**
 * Markers found in source text (import/require specifiers).
 * @param {string} text
 * @returns {{v2: string[], v1: string[], define: boolean}}
 */
function sourceMarkers(text) {
  const specs = [...String(text).matchAll(/(?:from\s+|require\(\s*|import\(\s*)["'](@opencode(?:-ai)?\/[a-z0-9-]+)/g)].map(m => m[1]);
  return {
    v2: [...new Set(specs.filter(s => s.startsWith('@opencode/')))],
    v1: [...new Set(specs.filter(s => V1_PACKAGES.includes(s)))],
    define: /Plugin\.define\s*\(/.test(text),
    v2Signature: V2_OBJECT_RE.test(text),
    v1Signature: V1_HOOK_RE.test(text) || V1_EXPORT_RE.test(text)
  };
}

/**
 * Turn collected markers into a verdict.
 * @param {{source: string, v2: string[], v1: string[]}[]} findings
 * @returns {{compat: 'v2'|'v1'|'unknown', evidence: string[]}}
 */
function verdict(findings) {
  const evidence = findings
    .filter(f => f.v2.length || f.v1.length)
    .map(f => `${f.source}: ${[...f.v2, ...f.v1].join(', ')}`);
  const hasV2 = findings.some(f => f.v2.length);
  const hasV1 = findings.some(f => f.v1.length);
  if (hasV2) return { compat: 'v2', evidence: hasV1 ? [...evidence, 'dual V1/V2 support'] : evidence };
  if (hasV1) return { compat: 'v1', evidence };
  return { compat: 'unknown', evidence: findings.length ? [`no @opencode/* or @opencode-ai/* dependency in ${findings.map(f => f.source).join(', ')}`] : ['no package.json or npm package found'] };
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Iterate regular files in a tar archive buffer.
 * @param {Buffer} tar
 * @returns {Generator<{name: string, data: Buffer}>}
 */
function* tarFiles(tar) {
  let offset = 0;
  let longName = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(b => b === 0)) break;
    const field = (start, len) => header.subarray(start, start + len).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = field(345, 155);
    let name = longName || (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    const data = tar.subarray(offset + 512, offset + 512 + size);
    longName = null;
    if (type === 'L') longName = data.toString('utf8').replace(/\0.*$/s, '');
    else if (type === 'x') {
      const pathRecord = data.toString('utf8').match(/\d+ path=([^\n]+)\n/);
      if (pathRecord) longName = pathRecord[1];
    } else if (type === '0' || type === '\0') {
      name = name.replace(/^[^/]+\//, ''); // strip the "owner-repo-sha/" top folder
      yield { name, data };
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
}

/**
 * Scan a GitHub repo's source for V1/V2 markers by downloading its tarball.
 * @param {{owner: string, name: string}} repo
 * @param {string} [subPath] - restrict to a monorepo folder
 * @returns {Promise<{source: string, v2: string[], v1: string[]}|null>}
 */
async function scanSource(repo, subPath) {
  const res = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}/tarball`, {
    headers: { 'User-Agent': 'awesome-opencode-bot', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
    redirect: 'follow'
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const gz = Buffer.from(await res.arrayBuffer());
  if (gz.length > MAX_TARBALL_BYTES) return null;
  let tar;
  try { tar = zlib.gunzipSync(gz); } catch { return null; }

  const v2 = new Set();
  const v1 = new Set();
  let define = false;
  let v1Signature = false;
  let v2Signature = false;
  let scanned = 0;
  const prefix = subPath ? `${subPath.replace(/\/+$/, '')}/` : '';
  for (const file of tarFiles(tar)) {
    if (!file.name.startsWith(prefix) || !SOURCE_FILE_RE.test(file.name) || SKIP_DIR_RE.test(file.name) || file.data.length > 2 * 1024 * 1024) continue;
    scanned++;
    const markers = sourceMarkers(file.data.toString('utf8'));
    markers.v2.forEach(m => v2.add(m));
    markers.v1.forEach(m => v1.add(m));
    define = define || markers.define;
    v1Signature = v1Signature || markers.v1Signature;
    v2Signature = v2Signature || markers.v2Signature;
  }
  // Plugin.define / an { id, setup } export is the V2 entry point; a bare V1 import without it is a V1 plugin
  if (define && v2.size === 0) v2.add('Plugin.define');
  if (!define && v2Signature && v2.size === 0) v2.add('V2 plugin object (id + setup)');
  define = define || v2Signature;
  if (define && v1.size) return { source: 'source', v2: [...v2, ...[...v1].map(m => `${m} (with Plugin.define)`)], v1: [] };
  return { source: `source (${scanned} files)`, v2: [...v2], v1: [...v1], scanned, define, v1Signature };
}

/**
 * Probe many entries at once. Network calls are batched.
 * @param {{key: string, repo: string, path?: string, npm?: string, plugin?: boolean}[]} targets
 *        plugin: true lets a legacy V1 hook signature in source (without Plugin.define) count as V1
 * @param {object} [options]
 * @param {boolean} [options.deep=true] - for still-unknown GitHub repos, download the tarball and scan source
 * @returns {Promise<Map<string, {compat: string, evidence: string[]}>>}
 */
async function probeCompat(targets, { deep = true } = {}) {
  const findings = new Map(targets.map(t => [t.key, []]));

  // 1. npm packages
  await Promise.all(targets.filter(t => t.npm).map(async t => {
    try {
      const doc = await getNpmLatest(t.npm);
      if (doc) findings.get(t.key).push({ source: `npm ${t.npm}@${doc.version}`, ...manifestMarkers(doc) });
    } catch { /* registry hiccup: fall through to repo sources */ }
  }));

  // 2. package.json files in GitHub repos
  const github = targets
    .map(t => ({ t, parsed: parseRepoUrl(t.repo) }))
    .filter(({ parsed }) => parsed && parsed.host === 'github.com');

  const firstRound = [];
  for (const { t, parsed } of github) {
    const base = t.path ? `${t.path.replace(/\/+$/, '')}/` : '';
    firstRound.push({ key: t.key, owner: parsed.owner, name: parsed.name, path: `${base}package.json` });
    if (!t.path) {
      for (const dir of WORKSPACE_DIRS) firstRound.push({ key: t.key, owner: parsed.owner, name: parsed.name, path: dir, tree: true });
    }
  }
  const files = await getFiles(firstRound);

  const secondRound = [];
  for (const req of firstRound) {
    const obj = files.get(`${req.owner}/${req.name}:${req.path}`);
    if (!obj) continue;
    if (req.tree) {
      (obj.entries || []).filter(e => e.type === 'tree').slice(0, MAX_WORKSPACE_PACKAGES).forEach(e => {
        secondRound.push({ key: req.key, owner: req.owner, name: req.name, path: `${req.path}/${e.name}/package.json` });
      });
    } else if (obj.text) {
      const manifest = safeJson(obj.text);
      if (manifest) findings.get(req.key).push({ source: req.path, ...manifestMarkers(manifest) });
    }
  }
  const workspaceFiles = await getFiles(secondRound);
  for (const req of secondRound) {
    const obj = workspaceFiles.get(`${req.owner}/${req.name}:${req.path}`);
    const manifest = obj && obj.text && safeJson(obj.text);
    if (manifest) findings.get(req.key).push({ source: req.path, ...manifestMarkers(manifest) });
  }

  // 3. Gists: read the source files directly
  for (const t of targets) {
    const gist = String(t.repo).match(/^https:\/\/gist\.github\.com\/[^/]+\/([0-9a-f]+)/);
    if (!gist) continue;
    const { status, data } = await rest(`/gists/${gist[1]}`);
    if (status !== 200 || !data || !data.files) continue;
    for (const [name, file] of Object.entries(data.files)) {
      const markers = name === 'package.json' ? manifestMarkers(safeJson(file.content) || {}) : sourceMarkers(file.content || '');
      findings.get(t.key).push({ source: `gist ${name}`, v2: markers.v2, v1: markers.v1 });
    }
  }

  // 4. Deep scan of source for anything not yet confirmed V2 (a V1 types dependency can sit next to a
  //    dependency-free V2 setup export, so V1 verdicts are re-checked too)
  if (deep) {
    for (const { t, parsed } of github) {
      if (verdict(findings.get(t.key)).compat === 'v2') continue;
      const scanned = await scanSource(parsed, t.path);
      if (!scanned) continue;
      if (t.plugin && !scanned.v2.length && !scanned.v1.length && scanned.v1Signature && verdict(findings.get(t.key)).compat === 'unknown') {
        scanned.v1 = ['legacy V1 plugin function/hooks without Plugin.define'];
      }
      findings.get(t.key).push(scanned);
    }
  }

  const results = new Map();
  for (const t of targets) results.set(t.key, verdict(findings.get(t.key)));
  return results;
}

module.exports = { dependencies, manifestMarkers, probeCompat, scanSource, sourceMarkers, tarFiles, verdict };
