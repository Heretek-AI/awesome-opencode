/**
 * Minimal GitHub and npm API helpers (Node 20+ global fetch, no extra dependencies).
 *
 * Auth: GITHUB_TOKEN or GH_TOKEN, falling back to `gh auth token` for local runs.
 */

const { execFileSync } = require('child_process');

let cachedToken;

function getToken() {
  if (cachedToken !== undefined) return cachedToken;
  cachedToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  if (!cachedToken) {
    try {
      cachedToken = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      cachedToken = '';
    }
  }
  return cachedToken;
}

function headers(extra = {}) {
  const token = getToken();
  return {
    'User-Agent': 'awesome-opencode-bot',
    Accept: 'application/vnd.github+json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra
  };
}

async function fetchWithRetry(url, options = {}, attempts = 5) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, options);
      if ([429, 502, 503, 504].includes(res.status) && attempt < attempts) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await new Promise(r => setTimeout(r, (retryAfter > 0 ? retryAfter : 2 ** attempt) * 1000));
        continue;
      }
      return res;
    } catch (err) {
      if (attempt >= attempts) throw err;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

/**
 * Run a GraphQL query. Partial data is returned even when some aliases error (e.g. repo not found).
 * @param {string} query
 * @param {object} [variables]
 * @returns {Promise<object>} data
 */
async function graphql(query, variables = {}) {
  const res = await fetchWithRetry('https://api.github.com/graphql', {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ query, variables })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok && !body.data) {
    throw new Error(`GitHub GraphQL ${res.status}: ${body.message || JSON.stringify(body.errors || body)}`);
  }
  const fatal = (body.errors || []).filter(e => e.type !== 'NOT_FOUND' && e.type !== 'FORBIDDEN');
  if (!body.data && fatal.length) {
    throw new Error(`GitHub GraphQL error: ${fatal.map(e => e.message).join('; ')}`);
  }
  return body.data || {};
}

/**
 * GitHub REST request.
 * @param {string} route - e.g. "/repos/o/r" or a full URL
 * @param {object} [options] - { method, body }
 * @returns {Promise<{status: number, data: any}>}
 */
async function rest(route, { method = 'GET', body } = {}) {
  const url = route.startsWith('http') ? route : `https://api.github.com${route}`;
  if (!url.startsWith('https://api.github.com/') || /\/\.{1,2}(\/|\?|$)/.test(url.split('?')[0])) {
    throw new Error(`refusing to call ${url}`);
  }
  const res = await fetchWithRetry(url, {
    method,
    headers: headers(body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  return { status: res.status, data };
}

const gqlString = s => JSON.stringify(String(s));

/**
 * Fetch repository metadata for many repos in batched GraphQL queries.
 * @param {{owner: string, name: string}[]} repos
 * @returns {Promise<Map<string, object|null>>} keyed by "owner/name" (as given); null when not found
 */
async function getRepos(repos, { batchSize = 60 } = {}) {
  const result = new Map();
  const unique = [...new Map(repos.map(r => [`${r.owner}/${r.name}`, r])).values()];
  for (let i = 0; i < unique.length; i += batchSize) {
    const chunk = unique.slice(i, i + batchSize);
    const fields = chunk.map((r, j) => `r${j}: repository(owner: ${gqlString(r.owner)}, name: ${gqlString(r.name)}) {
      nameWithOwner url isArchived isFork isPrivate pushedAt stargazerCount description
      licenseInfo { spdxId } defaultBranchRef { name }
    }`).join('\n');
    const data = await graphql(`query { ${fields} }`);
    chunk.forEach((r, j) => result.set(`${r.owner}/${r.name}`, data[`r${j}`] || null));
  }
  return result;
}

/**
 * Read text files from repos at HEAD in batched GraphQL queries.
 * @param {{owner: string, name: string, path: string}[]} requests
 * @returns {Promise<Map<string, {text?: string, entries?: {name: string, type: string}[]}|null>>}
 *          keyed by "owner/name:path"; tree paths return entries
 */
async function getFiles(requests, { batchSize = 60 } = {}) {
  const result = new Map();
  for (let i = 0; i < requests.length; i += batchSize) {
    const chunk = requests.slice(i, i + batchSize);
    const fields = chunk.map((r, j) => `f${j}: repository(owner: ${gqlString(r.owner)}, name: ${gqlString(r.name)}) {
      object(expression: ${gqlString(`HEAD:${r.path}`)}) {
        ... on Blob { text isTruncated }
        ... on Tree { entries { name type } }
      }
    }`).join('\n');
    const data = await graphql(`query { ${fields} }`);
    chunk.forEach((r, j) => {
      const obj = data[`f${j}`] && data[`f${j}`].object;
      result.set(`${r.owner}/${r.name}:${r.path}`, obj || null);
    });
  }
  return result;
}

/**
 * Fetch the latest published version document of an npm package.
 * @param {string} pkg
 * @returns {Promise<object|null>} null when the package does not exist
 */
const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

async function getNpmLatest(pkg) {
  if (!NPM_NAME_RE.test(pkg)) return null;
  const res = await fetchWithRetry(`https://registry.npmjs.org/${pkg.replace(/\//g, '%2F')}/latest`, {
    headers: { 'User-Agent': 'awesome-opencode-bot', Accept: 'application/json' }
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`npm registry ${res.status} for ${pkg}`);
  return res.json();
}

/**
 * Weekly downloads for an npm package (0 when unknown).
 * @param {string} pkg
 * @returns {Promise<number>}
 */
async function getNpmWeeklyDownloads(pkg) {
  if (!NPM_NAME_RE.test(pkg)) return 0;
  const res = await fetchWithRetry(`https://api.npmjs.org/downloads/point/last-week/${pkg}`, {
    headers: { 'User-Agent': 'awesome-opencode-bot' }
  });
  if (!res.ok) return 0;
  const body = await res.json().catch(() => ({}));
  return body.downloads || 0;
}

module.exports = { getFiles, getNpmLatest, getNpmWeeklyDownloads, getRepos, getToken, graphql, rest };
