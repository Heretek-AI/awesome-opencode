/**
 * Catalog loading and cross-entry rules for awesome-opencode.
 *
 * Every consumer (validate, generate-readme, export-json, CI checks) loads entries through
 * loadCatalog() so a single unparseable file is reported as an error instead of silently
 * dropping a whole category.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { validateEntry } = require('./validation');
const schema = require('../../data/schema.json');

const DATA_DIR = path.join(__dirname, '../../data');

// Category processing order (README section order)
const CATEGORIES = ['plugins', 'themes', 'agents', 'projects', 'resources'];

// Plugins still on the V1 API (compat: v1) are removed from the catalog after this date
const V1_SUNSET = '2027-01-01';

const KINDS = schema.properties.kind.enum;
const TOPICS = schema.properties.topics.items.enum;

// Which kinds may live in which category directory
const CATEGORY_KINDS = {
  plugins: ['plugin'],
  themes: ['theme'],
  agents: ['agent', 'skill'],
  projects: ['client', 'tool', 'mcp-server', 'skill', 'agent', 'fork'],
  resources: ['guide', 'config', 'mcp-server', 'skill', 'tool']
};

const TOPIC_LABELS = {
  memory: 'Memory',
  context: 'Context & Tokens',
  orchestration: 'Multi-Agent & Orchestration',
  workflow: 'Workflows & Planning',
  providers: 'Providers, Auth & Routing',
  cost: 'Cost & Usage',
  notifications: 'Notifications',
  sessions: 'Sessions & History',
  'code-quality': 'Code Review & Quality',
  security: 'Security & Sandboxing',
  git: 'Git & GitHub',
  remote: 'Remote & Mobile',
  web: 'Web & Browser',
  ui: 'UI & TUI',
  voice: 'Voice',
  media: 'Media & Documents',
  docs: 'Docs & Research',
  environment: 'Environment & Setup',
  observability: 'Observability',
  integrations: 'Integrations',
  'code-intel': 'Code Intelligence',
  prompting: 'Prompting & Skills',
  domain: 'Domain-Specific'
};

const KIND_LABELS = {
  plugin: 'Plugins',
  theme: 'Themes',
  agent: 'Agents',
  skill: 'Skills',
  'mcp-server': 'MCP Servers',
  client: 'Clients & GUIs',
  tool: 'Tools & Utilities',
  config: 'Configs & Starters',
  guide: 'Guides',
  fork: 'Forks'
};

const FILENAME_RE = /^[a-z0-9]+(?:[-.][a-z0-9]+)*\.yaml$/;

// Contributor-facing wording for schema pattern failures
const PATTERN_HINTS = {
  '/repo': 'repo must be the repository root, e.g. https://github.com/owner/repo (no /tree/ or /blob/ paths, npm pages or websites; use `path` for a folder inside a monorepo)',
  '/path': 'path must be a relative folder inside the repo, e.g. packages/my-plugin',
  '/npm': 'npm must be a package name, e.g. opencode-my-plugin or @scope/opencode-my-plugin',
  '/min_version': 'min_version must be semver, e.g. "2.0.0"'
};
const MOJIBAKE_RE = /鈥|â€|Ã[\u0080-¿]/;
const PLACEHOLDER_OWNER_RE =/^(your[-_]?(user(name)?|org|name)|user(name)?|owner|example|org|me)$/i;

/**
 * Parse a repo URL into { host, owner, name } (gists return owner/id).
 * @param {string} url
 * @returns {{host: string, owner: string, name: string}|null}
 */
function parseRepoUrl(url) {
  const match = String(url || '').match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/#?]+)/);
  if (!match) return null;
  return { host: match[1].toLowerCase(), owner: match[2], name: match[3].replace(/\.git$/, '') };
}

/**
 * Canonical identity of an entry's target: lowercased host/owner/repo plus optional path.
 * @param {object} data - Entry data
 * @returns {string}
 */
function canonicalKey(data) {
  const parsed = parseRepoUrl(data.repo);
  const base = parsed
    ? `${parsed.host}/${parsed.owner}/${parsed.name}`.toLowerCase()
    : String(data.repo || '').toLowerCase().replace(/\/+$/, '');
  const sub = (data.path || '').replace(/^\/+|\/+$/g, '').toLowerCase();
  return sub ? `${base}#${sub}` : base;
}

/**
 * Load every entry in data/<category>/*.yaml.
 * @param {object} [options]
 * @param {string} [options.dataDir] - Override the data directory
 * @returns {{entries: object[], errors: {file: string, message: string}[]}}
 */
function loadCatalog({ dataDir = DATA_DIR } = {}) {
  const entries = [];
  const errors = [];

  for (const category of CATEGORIES) {
    const dir = path.join(dataDir, category);
    if (!fs.existsSync(dir)) continue;

    for (const fileName of fs.readdirSync(dir).filter(f => f.endsWith('.yaml')).sort()) {
      const file = path.join('data', category, fileName);
      try {
        const data = yaml.load(fs.readFileSync(path.join(dir, fileName), 'utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          errors.push({ file, message: 'file is empty or not a YAML mapping' });
          continue;
        }
        entries.push({ category, id: fileName.replace(/\.yaml$/, ''), file, data });
      } catch (err) {
        errors.push({ file, message: `invalid YAML: ${err.reason || err.message}` });
      }
    }
  }

  return { entries, errors };
}

/**
 * Rules for a single entry: schema, kind/category fit, filename, placeholder repos.
 * @param {object} entry - { category, id, file, data }
 * @returns {string[]} Error messages
 */
function checkEntry(entry) {
  const messages = [];
  const result = validateEntry(entry.data, entry.file);
  if (!result.valid) {
    for (const err of result.errors) {
      if (err.keyword === 'pattern' && PATTERN_HINTS[err.path]) {
        messages.push(PATTERN_HINTS[err.path]);
        continue;
      }
      const detail = err.keyword === 'additionalProperties'
        ? `unknown field "${err.params.additionalProperty}"`
        : err.keyword === 'enum'
          ? `${err.message}: ${err.params.allowedValues.join(', ')}`
          : err.message;
      messages.push(`${err.path === '/' ? '' : err.path + ': '}${detail}`);
    }
  }

  if (!FILENAME_RE.test(path.basename(entry.file))) {
    messages.push('filename must be kebab-case, e.g. my-plugin.yaml');
  }

  const allowed = CATEGORY_KINDS[entry.category];
  if (entry.data.kind && allowed && !allowed.includes(entry.data.kind)) {
    messages.push(`kind "${entry.data.kind}" does not belong in data/${entry.category}/ (allowed: ${allowed.join(', ')})`);
  }

  if (entry.category === 'plugins' && !entry.data.compat) {
    messages.push('plugins must declare compat (v2, v1 or unknown); CI verifies it');
  }

  for (const field of ['name', 'tagline', 'description']) {
    if (MOJIBAKE_RE.test(entry.data[field] || '')) {
      messages.push(`${field} contains mis-encoded characters (e.g. "鈥?" or "â€”" instead of "—"); re-save the file as UTF-8`);
    }
  }

  const parsed = parseRepoUrl(entry.data.repo);
  if (parsed && PLACEHOLDER_OWNER_RE.test(parsed.owner)) {
    messages.push(`repo owner "${parsed.owner}" looks like a placeholder`);
  }

  return messages;
}

/**
 * Validate the whole catalog: per-entry rules plus cross-entry uniqueness.
 * @param {object[]} entries
 * @returns {{file: string, message: string}[]}
 */
function checkCatalog(entries) {
  const problems = [];
  const byKey = new Map();

  for (const entry of entries) {
    for (const message of checkEntry(entry)) {
      problems.push({ file: entry.file, message });
    }
    if (!entry.data.repo) continue;
    const key = canonicalKey(entry.data);
    if (byKey.has(key)) {
      problems.push({
        file: entry.file,
        message: `duplicate of ${byKey.get(key)} (same repo${entry.data.path ? ' and path' : ''}); use \`path\` for separate packages in one monorepo`
      });
    } else {
      byKey.set(key, entry.file);
    }
  }

  return problems;
}

/**
 * Format problems for terminal output.
 * @param {{file: string, message: string}[]} problems
 * @returns {string}
 */
function formatProblems(problems) {
  const byFile = new Map();
  for (const { file, message } of problems) {
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(message);
  }
  return [...byFile].map(([file, messages]) => `✗ ${file}\n${messages.map(m => `    - ${m}`).join('\n')}`).join('\n');
}

module.exports = {
  CATEGORIES,
  CATEGORY_KINDS,
  DATA_DIR,
  KINDS,
  KIND_LABELS,
  TOPICS,
  TOPIC_LABELS,
  V1_SUNSET,
  canonicalKey,
  checkCatalog,
  checkEntry,
  formatProblems,
  loadCatalog,
  parseRepoUrl
};
